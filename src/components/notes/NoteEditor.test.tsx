/**
 * Редактор отдаёт текст заметки, когда закрывается. Режим просмотра загружает
 * заметку один раз, а сервер пишет правки на диск только через несколько
 * секунд, поэтому без этого правка из веб-редактора пропадала при возврате в
 * просмотр (2026-09-18).
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import * as Y from 'yjs';
import { NoteEditor } from './NoteEditor';

const { fakeSocket, emitAck, handlers } = vi.hoisted(() => {
  const handlers = new Map<string, (payload: unknown) => void>();
  return {
    handlers,
    emitAck: vi.fn(),
    fakeSocket: {
      connected: true,
      id: 'sock-1',
      connect: vi.fn(),
      on: vi.fn((event: string, cb: (payload: unknown) => void) => {
        handlers.set(event, cb);
      }),
      off: vi.fn((event: string) => {
        handlers.delete(event);
      }),
    },
  };
});

vi.mock('@/lib/realtime/socket', () => ({
  getSocket: () => fakeSocket,
  emitAck: (...args: unknown[]) => emitAck(...args),
}));
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));

function serveDoc(server: Y.Doc): void {
  emitAck.mockImplementation(async (_socket: unknown, event: string) => {
    if (event === 'project:join') return { ok: true };
    if (event === 'yjs:fetch') {
      return {
        ok: true,
        sync1: Array.from(Y.encodeStateAsUpdate(server)),
        stateVector: Array.from(Y.encodeStateVector(server)),
      };
    }
    return { ok: true, changed: true };
  });
}

describe('NoteEditor — text handed back on close', () => {
  it('passes the current text, edits made while open included', async () => {
    const server = new Y.Doc();
    server.getText('content').insert(0, 'первая строка\n');
    serveDoc(server);
    const onExit = vi.fn();

    const view = render(<NoteEditor projectId="P1" fileId="F1" onExit={onExit} />);
    await screen.findByText('editorLive');

    // Someone else edits while the note is open; the server relays the delta.
    const before = Y.encodeStateVector(server);
    const text = server.getText('content');
    text.insert(text.length, 'из веба\n');
    handlers.get('yjs:update')?.({
      fileId: 'F1',
      update: Array.from(Y.encodeStateAsUpdate(server, before)),
    });

    view.unmount();
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledWith('первая строка\nиз веба\n');
  });

  it('passes nothing when the note never loaded', async () => {
    emitAck.mockImplementation(async (_socket: unknown, event: string) =>
      event === 'project:join' ? { ok: true } : { ok: false, error: 'file_not_found' },
    );
    const onExit = vi.fn();

    const view = render(<NoteEditor projectId="P1" fileId="F1" onExit={onExit} />);
    await screen.findByText('editorError');

    view.unmount();
    // An empty text would wipe the read view's copy of the note.
    expect(onExit).not.toHaveBeenCalled();
  });
});
