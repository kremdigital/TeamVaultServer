/**
 * Проведение REST-записей через общий механизм синхронизации.
 *
 * Раньше REST-эндпоинты файлов писали напрямую в `VaultFile` и на диск, минуя
 * `applyOperation`. Из-за этого правка через REST (MCP, внешний клиент,
 * загрузка из веб-UI):
 *
 * - не попадала в `OperationLog` → не подтягивалась клиентом даже при
 *   переподключении (`project:join` отдаёт `listOperationsSince`);
 * - не обновляла `YjsDocument` → у клиента оставался старый текст, а при
 *   следующей правке возвращалось расхождение (см. инцидент задвоения
 *   2026-08-03: источник истины при синхронизации — CRDT, а не диск);
 * - не рассылалась подключённым клиентам.
 *
 * Здесь всё это собрано в одном месте: `applyOperation` (журнал + диск + Yjs
 * для CREATE) и публикация в канал сокет-процесса.
 */
import { Prisma, type FileType } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { writeYjsText } from '@/lib/crdt/persistence';
import { applyOperation, type ApplyResult, type OperationInput } from './operation-log';
import { increment, parseClock, type VectorClock } from './vector-clock';
import { publishOperation, type OperationNotification } from '@/lib/realtime/bridge';

/**
 * Идентификатор псевдоклиента для REST-записей.
 *
 * Vector clock устроен как `Record<clientId, number>`, а у REST-вызова своего
 * `clientId` нет. Ключуем по пользователю: правки одного человека через API
 * получают монотонный счётчик, а плагин видит их как операции ещё одного
 * участника — обрабатывать их он умеет, ничего специального не требуется.
 */
export function restClientId(userId: string): string {
  return `rest:${userId}`;
}

/**
 * Следующий vector clock для псевдоклиента: берём последний известный по
 * проекту и инкрементируем свою координату.
 *
 * Точность здесь не критична — счётчик нужен, чтобы операция не выглядела
 * «уже виденной» относительно `sinceVectorClock` клиента. Гонка двух
 * параллельных REST-запросов может выдать одинаковый счётчик; это лишь
 * означает, что клиент получит обе операции (журнал упорядочен по `createdAt`),
 * а не потеряет их.
 */
export async function nextVectorClock(projectId: string, clientId: string): Promise<VectorClock> {
  const last = await prisma.operationLog.findFirst({
    where: { projectId },
    orderBy: { createdAt: 'desc' },
    select: { vectorClock: true },
  });
  return increment(parseClock(last?.vectorClock), clientId);
}

/** Какое Socket.IO-событие соответствует операции. */
function eventFor(op: OperationInput): OperationNotification['event'] {
  switch (op.opType) {
    case 'CREATE':
      return 'file:created';
    case 'UPDATE':
      return 'file:updated-binary';
    case 'DELETE':
      return 'file:deleted';
    case 'RENAME':
      return 'file:renamed';
    case 'MOVE':
      return 'file:moved';
  }
}

export interface RestWriteOpts {
  projectId: string;
  userId: string;
  op: OperationInput;
  /**
   * Текст файла — только для TEXT при `UPDATE`. `applyOperation` засевает
   * `YjsDocument` при CREATE, но не при UPDATE: в сокет-протоколе текст идёт
   * через `yjs:update`, а `file:update-binary` рассчитан на бинарники. У REST
   * такого разделения нет, поэтому CRDT для текста пересобираем здесь — иначе
   * диск и Yjs разойдутся.
   */
  textContent?: string;
  fileType?: FileType;
}

/**
 * Записать в журнал уже выполненное перемещение и оповестить клиентов.
 *
 * Отдельно от {@link applyRestOperation}, потому что сокетный `applyMove` при
 * коллизии уводит файл в `<path>.conflict-<clientId>` — для явного вызова API
 * это неверно (там нужен отказ, см. `docs/sync-protocol.md`). Роут выполняет
 * перемещение сам, в транзакции, а сюда приходит уже свершившийся факт.
 */
export async function recordRestMove(opts: {
  projectId: string;
  userId: string;
  fileId: string;
  fromPath: string;
  toPath: string;
}): Promise<void> {
  const clientId = restClientId(opts.userId);
  const vectorClock = await nextVectorClock(opts.projectId, clientId);

  const log = await prisma.operationLog.create({
    data: {
      projectId: opts.projectId,
      opType: 'MOVE',
      filePath: opts.fromPath,
      newPath: opts.toPath,
      authorId: opts.userId,
      vectorClock: vectorClock as Prisma.InputJsonValue,
      payload: { fileId: opts.fileId } as Prisma.InputJsonValue,
    },
    select: { id: true },
  });

  await publishOperation({
    projectId: opts.projectId,
    logId: log.id,
    event: 'file:moved',
    clientId,
    fileId: opts.fileId,
    path: opts.fromPath,
    newPath: opts.toPath,
  });
}

/**
 * Применить операцию как это делает сокет, и оповестить подключённых клиентов.
 */
export async function applyRestOperation(opts: RestWriteOpts): Promise<ApplyResult> {
  const clientId = restClientId(opts.userId);
  const vectorClock = await nextVectorClock(opts.projectId, clientId);

  const result = await applyOperation(
    { projectId: opts.projectId, authorId: opts.userId, clientId, vectorClock },
    opts.op,
  );

  // Обновление CRDT для текстового UPDATE.
  //
  // ⚠️ Документ здесь МУТИРУЕТСЯ, а не подменяется свежим. Замена на
  // `buildInitialState(newText)` кажется проще, но порождает задвоение: у
  // такого документа своя история, клиент видит независимую вставку и Yjs
  // сливает её с уже имеющимся текстом — на диске оказывается старое плюс
  // новое. Это в точности механизм инцидента 2026-08-03 (см.
  // `Tasks/done/2026-08-03-INCIDENT-рецидив-задвоения-ополченец.md`), и он
  // воспроизвёлся при живом тесте MCP.
  //
  // При мутации в состояние попадает и УДАЛЕНИЕ прежнего текста, поэтому
  // клиент, применив новое состояние, сходится к нужному содержимому. Тем же
  // `writeYjsText` пользуется CREATE на существующей строке (оживление
  // тумбстоуна, повтор конфликтной копии) — см. `applyCreate`.
  if (opts.op.opType === 'UPDATE' && opts.fileType === 'TEXT' && opts.textContent !== undefined) {
    await writeYjsText(opts.op.payload.fileId, opts.textContent);
  }

  // fileId берём из outcome: при CREATE он выдаётся сервером, при остальных
  // операциях приходит в payload. Без него плагин игнорирует событие.
  const fileId =
    'fileId' in result.outcome
      ? result.outcome.fileId
      : 'fileId' in opts.op.payload
        ? (opts.op.payload as { fileId: string }).fileId
        : null;
  const path = 'path' in result.outcome ? result.outcome.path : opts.op.filePath;

  if (fileId) {
    await publishOperation({
      projectId: opts.projectId,
      logId: result.log.id,
      event: eventFor(opts.op),
      clientId,
      fileId,
      path,
      ...(opts.op.opType === 'UPDATE' ? { contentHash: opts.op.payload.contentHash } : {}),
    });
  }

  return result;
}
