'use client';
/* eslint-disable react-hooks/set-state-in-effect */

import { type ReactElement, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useTheme } from 'next-themes';
import { LoaderCircleIcon, WifiIcon, WifiOffIcon } from 'lucide-react';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { yCollab } from 'y-codemirror.next';
import { emitAck, getSocket } from '@/lib/realtime/socket';

interface NoteEditorProps {
  projectId: string;
  fileId: string;
  /** Display name of the current user — shown to peers via awareness. */
  userName?: string | undefined;
  /**
   * Receives the note's current text when the editor closes (back to the read
   * view, or another note opened). The read view loads a note once, and the
   * server writes edits to disk only after they settle — so without this the
   * view went on showing the text from before the edit. Not called if the
   * note never loaded: an empty text must not replace the view's copy.
   */
  onExit?: ((text: string) => void) | undefined;
}

type JoinAck = { ok: true } | { ok: false; error: string };
type FetchAck = { ok: true; sync1: number[]; stateVector: number[] } | { ok: false; error: string };
type UpdateAck = { ok: true; changed: boolean } | { ok: false; error: string };

type Status = 'connecting' | 'ready' | 'forbidden' | 'error';

/** Origin tag for updates applied from the server, so we don't echo them back. */
const REMOTE_ORIGIN = 'remote';

/** A stable-ish color from a string, for this user's awareness cursor. */
function colorFor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(hash) % 360}, 70%, 55%)`;
}

/**
 * Collaborative markdown editor for a single note. Binds a CodeMirror 6 editor
 * to a Yjs document over Socket.IO — the exact same CRDT channel the Obsidian
 * plugin uses, so edits made here propagate to every connected client (web and
 * Obsidian) instantly. Write permission is enforced server-side on every
 * `yjs:update`; a VIEWER lands in the `forbidden` state.
 */
export function NoteEditor({ projectId, fileId, userName, onExit }: NoteEditorProps): ReactElement {
  const t = useTranslations('notes');
  const { resolvedTheme } = useTheme();
  const hostRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>('connecting');
  const [connected, setConnected] = useState(false);
  // Kept in a ref so a new callback identity doesn't tear down the editor.
  const onExitRef = useRef(onExit);
  useEffect(() => {
    onExitRef.current = onExit;
  });

  useEffect(() => {
    let destroyed = false;
    let seeded = false;
    const socket = getSocket();
    const doc = new Y.Doc();
    const ytext = doc.getText('content');
    const awareness = new Awareness(doc);
    let view: EditorView | null = null;

    const onConnect = (): void => setConnected(true);
    const onDisconnect = (): void => setConnected(false);
    setConnected(socket.connected);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);

    // Local edits → server. Skip updates we applied from the server ourselves.
    const onLocalUpdate = (update: Uint8Array, origin: unknown): void => {
      if (origin === REMOTE_ORIGIN) return;
      void emitAck<UpdateAck>(socket, 'yjs:update', {
        projectId,
        fileId,
        update: Array.from(update),
      })
        .then((ack) => {
          if (!ack.ok && ack.error === 'forbidden' && !destroyed) setStatus('forbidden');
        })
        .catch(() => {
          /* transient; the next edit retries, reconnect re-syncs */
        });
    };

    // Server broadcasts → local doc. Tagged REMOTE so onLocalUpdate ignores it.
    const onRemoteUpdate = (msg: { fileId: string; update: number[] }): void => {
      if (msg.fileId !== fileId) return;
      Y.applyUpdate(doc, Uint8Array.from(msg.update), REMOTE_ORIGIN);
    };

    async function start(): Promise<void> {
      if (!socket.connected) socket.connect();
      try {
        const join = await emitAck<JoinAck>(socket, 'project:join', {
          projectId,
          skipYjsCatchup: true,
        });
        if (!join.ok) {
          if (!destroyed) setStatus(join.error === 'forbidden' ? 'forbidden' : 'error');
          return;
        }
        const fetched = await emitAck<FetchAck>(socket, 'yjs:fetch', { projectId, fileId });
        if (!fetched.ok) {
          if (!destroyed) setStatus(fetched.error === 'forbidden' ? 'forbidden' : 'error');
          return;
        }
        const host = hostRef.current;
        if (destroyed || !host) return;

        // Seed the local doc with the server's authoritative state.
        Y.applyUpdate(doc, Uint8Array.from(fetched.sync1), REMOTE_ORIGIN);
        seeded = true;

        awareness.setLocalStateField('user', {
          name: userName ?? 'Web',
          color: colorFor(userName ?? socket.id ?? 'web'),
        });

        doc.on('update', onLocalUpdate);
        socket.on('yjs:update', onRemoteUpdate);

        const undoManager = new Y.UndoManager(ytext);
        const state = EditorState.create({
          doc: ytext.toString(),
          extensions: [
            basicSetup,
            markdown(),
            EditorView.lineWrapping,
            editorTheme(resolvedTheme === 'dark'),
            yCollab(ytext, awareness, { undoManager }),
          ],
        });
        view = new EditorView({ state, parent: host });
        setStatus('ready');
      } catch {
        if (!destroyed) setStatus('error');
      }
    }

    void start();

    return () => {
      destroyed = true;
      if (seeded) onExitRef.current?.(ytext.toString());
      doc.off('update', onLocalUpdate);
      socket.off('yjs:update', onRemoteUpdate);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      view?.destroy();
      awareness.destroy();
      doc.destroy();
    };
  }, [projectId, fileId, userName, resolvedTheme]);

  return (
    <div className="flex h-full flex-col">
      <div className="text-muted-foreground mb-2 flex items-center gap-2 text-xs">
        {status === 'connecting' && (
          <>
            <LoaderCircleIcon className="size-3.5 animate-spin" />
            {t('editorConnecting')}
          </>
        )}
        {status === 'ready' &&
          (connected ? (
            <>
              <WifiIcon className="size-3.5 text-emerald-500" />
              {t('editorLive')}
            </>
          ) : (
            <>
              <WifiOffIcon className="size-3.5 text-amber-500" />
              {t('editorOffline')}
            </>
          ))}
        {status === 'forbidden' && <span className="text-destructive">{t('editorForbidden')}</span>}
        {status === 'error' && <span className="text-destructive">{t('editorError')}</span>}
      </div>
      <div
        ref={hostRef}
        className="bg-background min-h-0 flex-1 overflow-auto rounded-md border text-sm"
      />
    </div>
  );
}

/** Minimal theme that inherits the app's CSS variables (light + dark). */
function editorTheme(_dark: boolean) {
  return EditorView.theme({
    '&': { backgroundColor: 'transparent', color: 'var(--foreground)', height: '100%' },
    '.cm-content': { fontFamily: 'var(--font-mono, ui-monospace, monospace)', padding: '0.75rem' },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      color: 'var(--muted-foreground)',
      border: 'none',
    },
    '.cm-activeLine': { backgroundColor: 'color-mix(in oklab, var(--muted) 40%, transparent)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent' },
    '&.cm-focused': { outline: 'none' },
    '.cm-cursor': { borderLeftColor: 'var(--foreground)' },
  });
}
