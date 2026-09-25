/**
 * Форма payload, который мост рассылает клиентам.
 *
 * Тест существует из-за конкретной ошибки: первая версия моста слала
 * `{ log, filePath, newPath }`. События доходили до плагина, но он их молча
 * игнорировал — он достаёт `fileId` из своих полей и без них выходит, — и
 * файлы не появлялись в вальте. Здесь зафиксированы **точные** поля, которые
 * читает `obsidian-plugin/src/client/socket.ts` и `handleServerFileEvent`.
 * Меняешь форму события на сервере — правь и здесь, и в плагине.
 */
import { describe, expect, it } from 'vitest';
import { buildEventPayload, type SerializedLog } from './rest-bridge';
import type { OperationNotification } from '@/lib/realtime/bridge';

const log: SerializedLog = { id: 'log-1', vectorClock: { 'rest:u': 1 }, createdAt: 'T' };

const note = (over: Partial<OperationNotification>): OperationNotification => ({
  projectId: 'p',
  logId: 'log-1',
  event: 'file:created',
  clientId: 'rest:u',
  fileId: 'f-1',
  path: 'папка/заметка.md',
  ...over,
});

describe('buildEventPayload', () => {
  it('file:created — плагин читает result.outcome.{fileId,path}', () => {
    const p = buildEventPayload(note({ event: 'file:created' }), log);
    const outcome = (p as { result: { outcome: { fileId: string; path: string } } }).result.outcome;
    expect(outcome.fileId).toBe('f-1');
    expect(outcome.path).toBe('папка/заметка.md');
    expect(p.log).toBe(log);
  });

  it('file:deleted — плагин читает fileId', () => {
    const p = buildEventPayload(note({ event: 'file:deleted' }), log);
    expect(p.fileId).toBe('f-1');
    expect(p.log).toBe(log);
  });

  it('file:updated-binary — плагин читает fileId и contentHash', () => {
    const p = buildEventPayload(note({ event: 'file:updated-binary', contentHash: 'abc123' }), log);
    expect(p.fileId).toBe('f-1');
    expect(p.contentHash).toBe('abc123');
  });

  it('file:moved — плагин читает fileId и newPath', () => {
    const p = buildEventPayload(
      note({ event: 'file:moved', path: 'было.md', newPath: 'стало.md' }),
      log,
    );
    expect(p.fileId).toBe('f-1');
    expect(p.newPath).toBe('стало.md');
  });

  it('file:renamed ведёт себя как file:moved', () => {
    const p = buildEventPayload(
      note({ event: 'file:renamed', path: 'было.md', newPath: 'стало.md' }),
      log,
    );
    expect(p.newPath).toBe('стало.md');
  });

  it('move без newPath не теряет путь — подставляется текущий', () => {
    const p = buildEventPayload(note({ event: 'file:moved', path: 'путь.md' }), log);
    expect(p.newPath).toBe('путь.md');
  });

  it('каждое событие несёт автора — псевдоклиента rest:<userId>', () => {
    // По clientId клиент узнаёт эхо своей операции и не применяет его поверх
    // более нового локального состояния. Форма обязана совпадать с сокетными
    // событиями, где это clientId автора операции.
    const events: OperationNotification['event'][] = [
      'file:created',
      'file:updated-binary',
      'file:deleted',
      'file:renamed',
      'file:moved',
    ];
    for (const event of events) {
      const p = buildEventPayload(note({ event, newPath: 'стало.md' }), log);
      expect(p.clientId, `событие ${event} без clientId`).toBe('rest:u');
    }
  });

  it('file:created несёт revived: true/false, как сокетное событие', () => {
    // POST на месте удалённой заметки (MCP write_note) оживляет тот же id с
    // продолженной историей. Маркер из журнала мост раньше терял: в `result`
    // у него только `outcome`, и клиент принимал такое оживление за сервер,
    // который историю заменял.
    const revived = buildEventPayload(note({ event: 'file:created' }), log, { revived: true });
    expect(revived.revived).toBe(true);
    const fresh = buildEventPayload(note({ event: 'file:created' }), log);
    expect(fresh.revived).toBe(false);
  });

  it('file:renamed/moved — requestedPath совпадает с newPath: REST не уводит в conflict-копию', () => {
    for (const event of ['file:renamed', 'file:moved'] as const) {
      const p = buildEventPayload(note({ event, path: 'было.md', newPath: 'стало.md' }), log);
      expect(p.newPath).toBe('стало.md');
      expect(p.requestedPath).toBe('стало.md');
    }
  });

  it('ни одно событие не остаётся без fileId', () => {
    const events: OperationNotification['event'][] = [
      'file:created',
      'file:updated-binary',
      'file:deleted',
      'file:renamed',
      'file:moved',
    ];
    for (const event of events) {
      const p = buildEventPayload(note({ event }), log);
      const hasId =
        p.fileId === 'f-1' ||
        (p as { result?: { outcome?: { fileId?: string } } }).result?.outcome?.fileId === 'f-1';
      expect(hasId, `событие ${event} без fileId — плагин его проигнорирует`).toBe(true);
    }
  });
});
