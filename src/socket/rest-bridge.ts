/**
 * Приём операций, выполненных через REST в веб-процессе, и рассылка их
 * подключённым клиентам.
 *
 * Веб-процесс (:3000) публикует в канал Postgres только идентификаторы —
 * см. `src/lib/realtime/bridge.ts`, где объяснено, почему не весь payload.
 * Здесь строка `OperationLog` подгружается из БД и превращается в то же
 * событие, что рассылают сокетные обработчики, чтобы клиенту было безразлично,
 * каким путём пришла правка.
 */
import type { Server as IOServer } from 'socket.io';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logger';
import { projectRoom } from './auth';
import { subscribeToOperations, type OperationNotification } from '@/lib/realtime/bridge';
import { isRevivedCreate } from '@/lib/sync/operation-log';

export interface SerializedLog {
  id: string;
  vectorClock: unknown;
  createdAt: string;
}

/**
 * Собрать payload события в той форме, которую ждёт плагин.
 *
 * **Форма обязана совпадать с сокетными обработчиками.** Плагин разбирает
 * каждое событие по своим полям и при их отсутствии молча выходит
 * (`if (!data.fileId) return`, `if (!outcome?.fileId) break`) — см.
 * `obsidian-plugin/src/client/socket.ts` и `engine.handleServerFileEvent`.
 * Первая версия моста слала `{ log, filePath }`: события доходили, а клиент
 * не мог их применить — файлы не появлялись в вальте. Отсюда и отдельная
 * функция с тестом на точную форму.
 */
export function buildEventPayload(
  note: OperationNotification,
  log: SerializedLog,
  meta: { revived?: boolean } = {},
): Record<string, unknown> {
  // `clientId` — автор операции, как у сокетных событий: у REST это псевдоклиент
  // `rest:<userId>`. По нему клиент узнаёт своё эхо; здесь своих у плагина нет,
  // но поле обязано быть в каждом `file:*`, чтобы формы не расходились.
  const clientId = note.clientId;
  switch (note.event) {
    case 'file:created':
      // Плагин достаёт fileId и path из `result.outcome`. `revived` — как у
      // сокетного события: POST на месте удалённой заметки (MCP `write_note`)
      // оживляет тот же id с продолженной историей. Полного журнала в
      // `result` здесь нет, поэтому без явного поля клиент принял бы такое
      // оживление за сервер, который историю заменял.
      return {
        result: { outcome: { kind: 'created', fileId: note.fileId, path: note.path } },
        clientId,
        revived: meta.revived === true,
        log,
      };
    case 'file:updated-binary':
      return { fileId: note.fileId, contentHash: note.contentHash ?? '', clientId, log };
    case 'file:deleted':
      return { fileId: note.fileId, clientId, log };
    case 'file:renamed':
    case 'file:moved': {
      // REST не уводит файл в conflict-копию (занятый путь — это 409), поэтому
      // сохранённый путь и запрошенный совпадают.
      const target = note.newPath ?? note.path;
      return {
        fileId: note.fileId,
        newPath: target,
        requestedPath: target,
        clientId,
        outcome: { kind: 'moved', fileId: note.fileId, path: target },
        log,
      };
    }
  }
}

/**
 * Разослать в комнату одну операцию из канала. Экспортируется для
 * интеграционного теста: канал `LISTEN/NOTIFY` проверяется отдельно
 * (`tests/integration/realtime-bridge.test.ts`).
 */
export async function relay(io: IOServer, note: OperationNotification): Promise<void> {
  const row = await prisma.operationLog.findUnique({
    where: { id: note.logId },
    select: { id: true, vectorClock: true, createdAt: true, payload: true },
  });
  if (!row) {
    logger.warn({ note }, 'операция из канала не найдена в журнале');
    return;
  }
  const log = { id: row.id, vectorClock: row.vectorClock, createdAt: row.createdAt.toISOString() };
  const room = projectRoom(note.projectId);

  const file = await prisma.vaultFile.findUnique({
    where: { id: note.fileId },
    select: { fileType: true },
  });
  const isText = file?.fileType === 'TEXT';

  // Содержимое ТЕКСТОВЫХ файлов в этом протоколе живёт только в Yjs: получив
  // `file:created`, плагин заводит Y.Doc и ждёт состояние, а сам файл на диск
  // не пишет (`applyServerCreate` → `wireYjsForTextFile`). Без `yjs:update`
  // заметка появляется в индексе клиента, но остаётся пустой до переподключения
  // — ровно это и наблюдалось в первом прогоне живого теста.
  //
  // По той же причине для текста НЕ шлём `file:updated-binary`: в сокетном
  // протоколе такого события для текста не бывает, плагин на него полез бы
  // качать байты по REST и разбирать конфликт поверх Yjs.
  const sendYjs = async (): Promise<void> => {
    const doc = await prisma.yjsDocument.findUnique({
      where: { fileId: note.fileId },
      select: { state: true },
    });
    if (doc?.state && doc.state.length > 0) {
      io.to(room).emit('yjs:update', {
        fileId: note.fileId,
        update: Array.from(new Uint8Array(doc.state)),
      });
    }
  };

  if (note.event === 'file:updated-binary' && isText) {
    await sendYjs();
    logger.info({ path: note.path, fileId: note.fileId }, 'REST-правка текста разослана как yjs');
    return;
  }

  const payload = buildEventPayload(note, log, { revived: isRevivedCreate(row.payload) });
  io.to(room).emit(note.event, { ...payload, viaRest: true });
  if (note.event === 'file:created' && isText) await sendYjs();

  logger.info(
    { event: note.event, path: note.newPath ?? note.path, fileId: note.fileId, isText },
    'REST-операция разослана в комнату',
  );
}

/**
 * Подписаться на канал и рассылать приходящие операции. Возвращает функцию
 * остановки — её вызывает graceful shutdown сокет-сервера.
 */
export function attachRestBridge(io: IOServer): { close: () => Promise<void> } {
  return subscribeToOperations((note) => {
    void relay(io, note).catch((err) =>
      logger.warn({ err, note }, 'не удалось разослать REST-операцию'),
    );
  });
}
