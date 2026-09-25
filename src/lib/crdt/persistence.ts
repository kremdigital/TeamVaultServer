import * as Y from 'yjs';
import { prisma } from '@/lib/db/client';
import { sha256OfBuffer } from '@/lib/files/hash';
import { readProjectFile, writeProjectFile } from '@/lib/files/storage';
import { recordFileVersion } from '@/lib/files/versioning';

/**
 * Conventional Y.Doc shape: a single Y.Text named "content".
 * Plugins MUST agree on this key when sending updates to the server.
 */
export const TEXT_KEY = 'content';

export interface ApplyUpdateOpts {
  fileId: string;
  update: Uint8Array;
  authorId: string | null;
}

export interface ApplyUpdateResult {
  /** New Y.encodeStateAsUpdate output for the document. */
  state: Uint8Array;
  /** New Y.encodeStateVector output. */
  stateVector: Uint8Array;
  /** Plain-text content extracted from `Y.Text['content']`. */
  text: string;
  /** Whether the update modified the document at all (vs being a no-op replay). */
  changed: boolean;
}

/**
 * Load a Y.Doc from DB state. Returns a fresh empty doc if no row exists yet.
 */
export async function loadYjsDoc(fileId: string): Promise<Y.Doc> {
  const doc = new Y.Doc();
  const stored = await prisma.yjsDocument.findUnique({
    where: { fileId },
    select: { state: true },
  });
  if (stored?.state && stored.state.length > 0) {
    Y.applyUpdate(doc, new Uint8Array(stored.state));
  }
  return doc;
}

/**
 * Apply a client update to the persistent Y.Doc and store the new state.
 * Pure server-side merge — call this from the Socket.IO handler.
 */
export async function applyYjsUpdate(opts: ApplyUpdateOpts): Promise<ApplyUpdateResult> {
  const doc = await loadYjsDoc(opts.fileId);
  const beforeVector = Y.encodeStateVector(doc);
  const beforeText = doc.getText(TEXT_KEY).toString();

  Y.applyUpdate(doc, opts.update);

  const afterVector = Y.encodeStateVector(doc);
  const text = doc.getText(TEXT_KEY).toString();

  // ⚠️ Одного сравнения векторов состояния НЕДОСТАТОЧНО. Вектор в Yjs
  // отражает только ВСТАВКИ (счётчик операций на клиента); удаления живут в
  // отдельном delete-set и счётчик не двигают. Поэтому правка, состоящая
  // только из удаления текста, давала `changed === false` — и обработчик
  // `yjs:update` НЕ планировал снапшот на диск и НЕ рассылал её остальным
  // клиентам. В CRDT удаление было, а файл на диске (и всё, что читает его:
  // REST-скачивание, размер в веб-UI, catch-up новых клиентов) оставался со
  // старым текстом.
  //
  // Обнаружено 2026-08-06: пользователь убрал один символ из заметки при
  // работающем плагине — на сервере файл не изменился. Вставки при этом
  // синхронизировались нормально, что и маскировало проблему.
  const changed = !uint8Equal(beforeVector, afterVector) || text !== beforeText;

  const newState = Y.encodeStateAsUpdate(doc);
  const newVector = afterVector;

  await prisma.yjsDocument.upsert({
    where: { fileId: opts.fileId },
    create: {
      fileId: opts.fileId,
      state: Buffer.from(newState),
      stateVector: Buffer.from(newVector),
    },
    update: {
      state: Buffer.from(newState),
      stateVector: Buffer.from(newVector),
    },
  });

  doc.destroy();

  return { state: newState, stateVector: newVector, text, changed };
}

export interface SnapshotResult {
  contentHash: string;
  size: number;
  versionNumber: number | null;
}

/**
 * Persist the current text content of a Yjs document to the project filesystem
 * and create a new `FileVersion` row (deduplicating by content hash).
 *
 * Should be called via {@link scheduleSnapshot} (debounced) or from a background job —
 * NOT inline on every keystroke.
 */
export async function persistTextSnapshot(opts: {
  projectId: string;
  fileId: string;
  text: string;
  authorId: string | null;
}): Promise<SnapshotResult> {
  const file = await prisma.vaultFile.findUnique({
    where: { id: opts.fileId },
    select: { path: true },
  });
  if (!file) throw new Error(`File not found: ${opts.fileId}`);

  const buffer = Buffer.from(opts.text, 'utf8');
  const written = await writeProjectFile(opts.projectId, file.path, buffer);

  await prisma.vaultFile.update({
    where: { id: opts.fileId },
    data: {
      contentHash: written.contentHash,
      size: BigInt(written.size),
      ...(opts.authorId ? { lastModifiedById: opts.authorId } : {}),
    },
  });

  const recorded = await recordFileVersion({
    projectId: opts.projectId,
    fileId: opts.fileId,
    data: buffer,
    contentHash: written.contentHash,
    authorId: opts.authorId,
  });

  return {
    contentHash: written.contentHash,
    size: written.size,
    versionNumber: recorded?.versionNumber ?? null,
  };
}

/**
 * Debounced snapshot scheduler. Flushes after `delayMs` of inactivity per fileId.
 * Single in-memory map — fine for a single Node process; for a multi-process
 * deployment this would move into a shared scheduler.
 */
const SCHEDULER = new Map<string, NodeJS.Timeout>();
const SNAPSHOT_DEBOUNCE_MS = Number(process.env.YJS_SNAPSHOT_DEBOUNCE_MS ?? 5000);

export function scheduleSnapshot(opts: {
  projectId: string;
  fileId: string;
  authorId: string | null;
  delayMs?: number;
  onError?: (err: unknown) => void;
}): void {
  const existing = SCHEDULER.get(opts.fileId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(async () => {
    SCHEDULER.delete(opts.fileId);
    try {
      const doc = await loadYjsDoc(opts.fileId);
      const text = doc.getText(TEXT_KEY).toString();
      doc.destroy();
      await persistTextSnapshot({
        projectId: opts.projectId,
        fileId: opts.fileId,
        text,
        authorId: opts.authorId,
      });
    } catch (err) {
      opts.onError?.(err);
    }
  }, opts.delayMs ?? SNAPSHOT_DEBOUNCE_MS);

  // Don't keep the Node process alive just for pending snapshots.
  if (typeof timer.unref === 'function') timer.unref();
  SCHEDULER.set(opts.fileId, timer);
}

export function cancelScheduledSnapshot(fileId: string): void {
  const t = SCHEDULER.get(fileId);
  if (t) {
    clearTimeout(t);
    SCHEDULER.delete(fileId);
  }
}

export async function flushPendingSnapshotsForTest(): Promise<void> {
  // Test helper — runs all pending timers immediately.
  const timers = Array.from(SCHEDULER.values());
  for (const t of timers) clearTimeout(t);
  SCHEDULER.clear();
}

function uint8Equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Build a Y.Doc seeded from an external source (e.g. existing .md file content)
 * and return its initial encoded state. Useful when a binary file is converted
 * to a CRDT-managed text file for the first time.
 *
 * Only for a file that has NO stored doc yet. Never write the result over an
 * existing `YjsDocument`: that swaps the history for an independent one, and a
 * client still holding the old history merges both texts (duplication). Use
 * {@link writeYjsText} there.
 */
export function buildInitialState(text: string): {
  state: Uint8Array;
  stateVector: Uint8Array;
} {
  const doc = new Y.Doc();
  doc.getText(TEXT_KEY).insert(0, text);
  const state = Y.encodeStateAsUpdate(doc);
  const stateVector = Y.encodeStateVector(doc);
  doc.destroy();
  return { state, stateVector };
}

/**
 * Привести сохранённое состояние Y.Doc к тексту `text`, **продолжая** его
 * историю: удалить весь прежний текст и вставить новый поверх, в одной
 * транзакции. Если текст уже совпадает, история не трогается (`changed: false`).
 * Без сохранённого состояния (`stored` пуст) получается свежий документ — то же,
 * что {@link buildInitialState}.
 *
 * ⚠️ Существующий документ нельзя подменять свежим (`buildInitialState`). У
 * свежего документа своя, независимая история: клиент, который хранит прежнюю
 * (в y-indexeddb, в открытом редакторе), при слиянии получает ОБА текста —
 * старый и новый подряд, и отправляет задвоение всей команде. Это механизм
 * инцидентов задвоения 2026-08-03 и оживления тумбстоуна (ревью 0.3.8). Удаление
 * прежнего текста, записанное в историю, клиент со старой историей применяет и
 * сходится ровно к `text` (его неотправленные правки, если есть, остаются рядом).
 */
export function extendYjsState(
  stored: Uint8Array | null | undefined,
  text: string,
): { state: Uint8Array; stateVector: Uint8Array; changed: boolean } {
  const doc = new Y.Doc();
  try {
    if (stored && stored.length > 0) Y.applyUpdate(doc, stored);
    const ytext = doc.getText(TEXT_KEY);
    const changed = ytext.toString() !== text;
    if (changed) {
      doc.transact(() => {
        ytext.delete(0, ytext.length);
        ytext.insert(0, text);
      });
    }
    return {
      state: Y.encodeStateAsUpdate(doc),
      stateVector: Y.encodeStateVector(doc),
      changed,
    };
  } finally {
    doc.destroy();
  }
}

/**
 * Записать текст в `YjsDocument` файла через {@link extendYjsState}: существующая
 * история продолжается, а не заменяется. Строка создаётся, если её не было;
 * если текст уже совпадает, строка не переписывается.
 */
export async function writeYjsText(fileId: string, text: string): Promise<{ changed: boolean }> {
  const stored = await prisma.yjsDocument.findUnique({
    where: { fileId },
    select: { state: true },
  });
  const previous = stored?.state && stored.state.length > 0 ? new Uint8Array(stored.state) : null;
  const next = extendYjsState(previous, text);
  if (previous && !next.changed) return { changed: false };
  const state = Buffer.from(next.state);
  const stateVector = Buffer.from(next.stateVector);
  await prisma.yjsDocument.upsert({
    where: { fileId },
    create: { fileId, state, stateVector },
    update: { state, stateVector },
  });
  return { changed: next.changed };
}

export function hashText(text: string): string {
  return sha256OfBuffer(Buffer.from(text, 'utf8'));
}

export interface YjsSnapshot {
  /** `Y.encodeStateAsUpdate(doc)` — full state for the client to apply. */
  state: Uint8Array;
  /** `Y.encodeStateVector(doc)` — lets the client compute its inverse delta. */
  stateVector: Uint8Array;
}

/**
 * Load a single file's Y.Doc snapshot, lazily seeding it from the on-disk `.md`
 * content when no Yjs row exists yet (covers files created before seed-on-create
 * and any drift). Used by the single-doc `yjs:fetch` socket handler so a web
 * client can edit one note without pulling the whole vault's catch-up.
 */
export async function loadOrSeedYjsSnapshot(
  projectId: string,
  fileId: string,
  path: string,
): Promise<YjsSnapshot> {
  const stored = await prisma.yjsDocument.findUnique({
    where: { fileId },
    select: { state: true },
  });
  if (stored?.state && stored.state.length > 0) {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(stored.state));
    const state = Y.encodeStateAsUpdate(doc);
    const stateVector = Y.encodeStateVector(doc);
    doc.destroy();
    return { state, stateVector };
  }

  const buf = await readProjectFile(projectId, path);
  const initial = buildInitialState(buf.toString('utf8'));
  await prisma.yjsDocument.upsert({
    where: { fileId },
    create: {
      fileId,
      state: Buffer.from(initial.state),
      stateVector: Buffer.from(initial.stateVector),
    },
    update: {
      state: Buffer.from(initial.state),
      stateVector: Buffer.from(initial.stateVector),
    },
  });
  return initial;
}
