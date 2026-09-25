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
 * для текста, общий с сокетом) и публикация в канал сокет-процесса.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { applyOperation, type ApplyResult, type OperationInput } from './operation-log';
import { getCount, increment, parseClock, type VectorClock } from './vector-clock';
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
 * Следующий vector clock для псевдоклиента: последний clock журнала проекта,
 * а своя координата — на единицу больше самого большого своего счётчика в
 * журнале.
 *
 * Счётчик нужен, чтобы операция не выглядела «уже виденной» относительно
 * `sinceVectorClock` клиента, поэтому он обязан расти. Раньше своя координата
 * бралась из последней операции журнала. Если это была операция плагина, чей
 * clock не видел прежних REST-записей (живые трансляции его clock не двигают),
 * счётчик начинался заново и повторял уже выданный. Устройство, которое
 * догнало прежнюю запись с тем же счётчиком, считало новую виденной и не
 * получало её в catch-up.
 *
 * Гонка двух параллельных REST-запросов одного пользователя по-прежнему может
 * выдать одинаковый счётчик: оба запроса читают журнал до записи.
 */
export async function nextVectorClock(projectId: string, clientId: string): Promise<VectorClock> {
  const [last, [own]] = await Promise.all([
    prisma.operationLog.findFirst({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
      select: { vectorClock: true },
    }),
    // Весь журнал проекта, а не только записи этого пользователя: копия
    // счётчика в чужом clock переживает удаление самой записи (purge-tombstones).
    prisma.$queryRaw<Array<{ counter: number | null }>>(Prisma.sql`
      SELECT max(
        CASE WHEN jsonb_typeof(o."vectorClock" -> ${clientId}) = 'number'
             THEN (o."vectorClock" -> ${clientId})::float8 END
      ) AS "counter"
      FROM "OperationLog" o
      WHERE o."projectId" = ${projectId}
    `),
  ]);
  const clock = parseClock(last?.vectorClock);
  const highest = Math.max(getCount(clock, clientId), own?.counter ?? 0);
  return increment({ ...clock, [clientId]: highest }, clientId);
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

  // Текст заметки при `UPDATE` пишет в её `YjsDocument` сам `applyOperation`
  // (`applyUpdate`), продолжая историю, — так же, как для сокетного
  // `file:update-binary`. Раньше это делалось только здесь, после записи байтов:
  // сокетный путь расходил диск и Y.Doc, а `UPDATE`, ставший no_op на
  // тумбстоуне (удаление между проверкой роута и записью), всё равно менял
  // документ удалённой заметки.

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
