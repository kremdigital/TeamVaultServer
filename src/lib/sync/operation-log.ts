import { Prisma, type FileType, type OpType, type OperationLog } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { deleteProjectFile, moveProjectFile, writeProjectFile } from '@/lib/files/storage';
import { InvalidPathError, normalizeVaultPath } from '@/lib/files/paths';
import { writeYjsText } from '@/lib/crdt/persistence';
import { merge, type VectorClock } from './vector-clock';

// ---------------------------------------------------------------------------
// Payload types
// ---------------------------------------------------------------------------

export interface CreatePayload {
  fileType: FileType;
  mimeType?: string | null;
  contentHash: string;
  size: number;
}
export interface UpdatePayload {
  fileId: string;
  contentHash: string;
  size: number;
}
export interface DeletePayload {
  fileId: string;
}
export interface RenamePayload {
  fileId: string;
}
export interface MovePayload {
  fileId: string;
}

export type OperationInput =
  | { opType: 'CREATE'; filePath: string; payload: CreatePayload; data: Buffer }
  | { opType: 'UPDATE'; filePath: string; payload: UpdatePayload; data: Buffer }
  | { opType: 'DELETE'; filePath: string; payload: DeletePayload }
  | { opType: 'RENAME'; filePath: string; newPath: string; payload: RenamePayload }
  | { opType: 'MOVE'; filePath: string; newPath: string; payload: MovePayload };

// ---------------------------------------------------------------------------
// Application result
// ---------------------------------------------------------------------------

export type ApplyOutcome =
  | { kind: 'created'; fileId: string; path: string }
  | { kind: 'updated'; fileId: string }
  | { kind: 'deleted'; fileId: string }
  | { kind: 'renamed'; fileId: string; from: string; to: string }
  | { kind: 'conflict_create_renamed'; fileId: string; originalPath: string; finalPath: string }
  | { kind: 'no_op'; reason: string };

export interface ApplyResult {
  outcome: ApplyOutcome;
  /** The OperationLog row written to record the operation. */
  log: OperationLog;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export interface ApplyContext {
  projectId: string;
  authorId: string | null;
  /**
   * Stable identifier of the originating client (e.g. plugin install). Used as a tiebreaker
   * for concurrent renames and as the suffix for `.conflict-<clientId>` files.
   */
  clientId: string;
  vectorClock: VectorClock;
}

/**
 * Apply an operation to the project storage and record it in OperationLog.
 * The whole apply is wrapped in a Prisma transaction.
 */
export async function applyOperation(ctx: ApplyContext, op: OperationInput): Promise<ApplyResult> {
  switch (op.opType) {
    case 'CREATE':
      return applyCreate(ctx, op);
    case 'UPDATE':
      return applyUpdate(ctx, op);
    case 'DELETE':
      return applyDelete(ctx, op);
    case 'RENAME':
    case 'MOVE':
      return applyMove(ctx, op);
  }
}

/**
 * List operations for a project that happened *after* `sinceVectorClock`,
 * i.e. whose own clock is not happens-before-or-equal `sinceVectorClock`.
 *
 * Note: the strictly-correct filter would compare each clock pairwise, but a cheap
 * upper bound is to compare per-client counters: an operation must include changes
 * from at least one client whose counter exceeds the value in `since`. We do the
 * filtering on the application side after fetching by `createdAt`.
 */
export async function listOperationsSince(opts: {
  projectId: string;
  since: VectorClock;
  limit?: number;
}): Promise<OperationLog[]> {
  const rows = await prisma.operationLog.findMany({
    where: { projectId: opts.projectId },
    orderBy: { createdAt: 'asc' },
    take: opts.limit ?? 500,
  });

  return rows.filter((row) => {
    const opClock = row.vectorClock as Record<string, number>;
    for (const [client, counter] of Object.entries(opClock)) {
      if ((opts.since[client] ?? 0) < counter) return true;
    }
    return false;
  });
}

// ---------------------------------------------------------------------------
// CREATE
// ---------------------------------------------------------------------------

async function applyCreate(
  ctx: ApplyContext,
  op: Extract<OperationInput, { opType: 'CREATE' }>,
): Promise<ApplyResult> {
  let normalizedPath: string;
  try {
    normalizedPath = normalizeVaultPath(op.filePath);
  } catch (err) {
    if (err instanceof InvalidPathError) throw err;
    throw err;
  }

  // Resolve potential CREATE-vs-CREATE collision: same path already exists.
  const existing = await prisma.vaultFile.findFirst({
    where: { projectId: ctx.projectId, path: normalizedPath, deletedAt: null },
    select: { id: true, contentHash: true },
  });

  // Idempotent replay: if the file already exists with the same content
  // hash, it's the same client retrying (e.g. after a socket reconnect or
  // server restart). Return success without creating a `*.conflict-...`
  // duplicate. Genuine concurrent CREATE'es with different content from
  // two devices still trip the conflict-rename path below.
  if (existing && existing.contentHash === op.payload.contentHash) {
    const log = await writeLog(ctx, {
      opType: 'CREATE',
      filePath: normalizedPath,
      payload: {
        ...op.payload,
        fileId: existing.id,
        originalPath: normalizedPath,
      } as Prisma.InputJsonValue,
    });
    return {
      outcome: { kind: 'created', fileId: existing.id, path: normalizedPath },
      log,
    };
  }

  let pathToUse = normalizedPath;
  let conflictRenamed = false;

  if (existing) {
    // The copy goes to the first free `<path>.conflict-<clientId>[-n]`. A row
    // already there is taken over only when it is a tombstone (revived below)
    // or holds this very content — the same CREATE retried after a lost ack. A
    // live row with other content is a DIFFERENT note: this client's earlier
    // rename-conflict copy, or its earlier conflict CREATE of other text.
    // Writing the new text over it erased that note for the whole team, since
    // the history is extended and every device applied the deletion.
    pathToUse = await pickConflictPath(
      ctx,
      normalizedPath,
      (row) => row.deletedAt !== null || row.contentHash === op.payload.contentHash,
    );
    conflictRenamed = true;
  }

  await writeProjectFile(ctx.projectId, pathToUse, op.data);

  // `@@unique([projectId, path])` spans tombstones AND live rows, so a fresh
  // `create` at `pathToUse` blows up on the unique constraint whenever a row
  // already sits there — leaving the client stuck retrying the CREATE (and,
  // with REST-staged binaries, orphaning the staged blob). Two ways that
  // happens: (1) a soft-deleted row at the path — re-creating a deleted path;
  // (2) a *live* conflict copy with this same content from this same client's
  // earlier conflict CREATE being retried. Both are handled by updating the
  // existing row in place instead of colliding on a duplicate create: revive
  // it if it was a tombstone, or idempotently re-apply the same content if it
  // was already live.
  const atPath = await prisma.vaultFile.findUnique({
    where: { projectId_path: { projectId: ctx.projectId, path: pathToUse } },
    select: { id: true, deletedAt: true },
  });
  const revived = atPath !== null && atPath.deletedAt !== null;

  // For TEXT files the Y.Doc carries the content. Without it, project:join's
  // `yjsDocs` payload on a fresh client is empty, and the engine has no way to
  // materialize the file on disk — the operation log knows the file exists
  // but never sees the bytes.
  //
  // A row that already exists (tombstone or live conflict copy) keeps its id,
  // so its Y.Doc keeps its HISTORY: the new text goes on top of the stored one
  // (delete all + insert), exactly like a REST UPDATE. Replacing it with
  // `buildInitialState` gave the same fileId an independent history, and every
  // device still holding the old one (offline while the note was deleted and
  // re-created — "Untitled", a template, restore from trash) merged both texts
  // and pushed the duplicate to the whole team. Written before the row is
  // revived, so a `yjs:update` for the fileId can't be accepted against the
  // old state in between.
  const text = op.payload.fileType === 'TEXT' ? op.data.toString('utf8') : null;
  if (atPath && text !== null) await writeYjsText(atPath.id, text);

  const file = atPath
    ? await prisma.vaultFile.update({
        where: { id: atPath.id },
        data: {
          deletedAt: null,
          fileType: op.payload.fileType,
          contentHash: op.payload.contentHash,
          size: BigInt(op.payload.size),
          ...(op.payload.mimeType ? { mimeType: op.payload.mimeType } : {}),
          ...(ctx.authorId ? { lastModifiedById: ctx.authorId } : {}),
        },
        select: { id: true, path: true },
      })
    : await prisma.vaultFile.create({
        data: {
          projectId: ctx.projectId,
          path: pathToUse,
          fileType: op.payload.fileType,
          contentHash: op.payload.contentHash,
          size: BigInt(op.payload.size),
          ...(op.payload.mimeType ? { mimeType: op.payload.mimeType } : {}),
          ...(ctx.authorId ? { lastModifiedById: ctx.authorId } : {}),
        },
        select: { id: true, path: true },
      });

  // A brand-new row has no stored doc: this seeds a fresh one.
  if (!atPath && text !== null) await writeYjsText(file.id, text);

  const log = await writeLog(ctx, {
    opType: 'CREATE',
    filePath: pathToUse,
    payload: {
      ...op.payload,
      fileId: file.id,
      originalPath: normalizedPath,
      // The id is an old one brought back from a tombstone, with its Y.Doc
      // history extended (see docs/sync-protocol.md). Servers that replaced the
      // history never wrote this marker.
      ...(revived ? { revived: true } : {}),
    } as Prisma.InputJsonValue,
  });

  if (conflictRenamed) {
    return {
      outcome: {
        kind: 'conflict_create_renamed',
        fileId: file.id,
        originalPath: normalizedPath,
        finalPath: pathToUse,
      },
      log,
    };
  }
  return { outcome: { kind: 'created', fileId: file.id, path: file.path }, log };
}

// ---------------------------------------------------------------------------
// UPDATE
// ---------------------------------------------------------------------------

async function applyUpdate(
  ctx: ApplyContext,
  op: Extract<OperationInput, { opType: 'UPDATE' }>,
): Promise<ApplyResult> {
  const file = await prisma.vaultFile.findFirst({
    where: { id: op.payload.fileId, projectId: ctx.projectId },
    select: { id: true, path: true, deletedAt: true },
  });
  if (!file) {
    // Message intentionally ends with `_not_found` — the plugin's
    // `ackToOutcome` treats that suffix as non-retryable so the queued op
    // gets dropped instead of halting the whole drain on a dead-letter.
    throw new Error('file_not_found');
  }

  // DELETE > UPDATE conflict resolution: if the file is currently a tombstone, no-op.
  if (file.deletedAt) {
    const log = await writeLog(ctx, {
      opType: 'UPDATE',
      filePath: file.path,
      payload: { ...op.payload, suppressed: 'tombstone' } as Prisma.InputJsonValue,
    });
    return { outcome: { kind: 'no_op', reason: 'tombstone' }, log };
  }

  await writeProjectFile(ctx.projectId, file.path, op.data);

  await prisma.vaultFile.update({
    where: { id: file.id },
    data: {
      contentHash: op.payload.contentHash,
      size: BigInt(op.payload.size),
      ...(ctx.authorId ? { lastModifiedById: ctx.authorId } : {}),
    },
  });

  const log = await writeLog(ctx, {
    opType: 'UPDATE',
    filePath: file.path,
    payload: op.payload as unknown as Prisma.InputJsonValue,
  });
  return { outcome: { kind: 'updated', fileId: file.id }, log };
}

// ---------------------------------------------------------------------------
// DELETE  (soft delete, also wins over concurrent UPDATE)
// ---------------------------------------------------------------------------

async function applyDelete(
  ctx: ApplyContext,
  op: Extract<OperationInput, { opType: 'DELETE' }>,
): Promise<ApplyResult> {
  const file = await prisma.vaultFile.findFirst({
    where: { id: op.payload.fileId, projectId: ctx.projectId },
    select: { id: true, path: true, deletedAt: true },
  });
  if (!file) throw new Error('file_not_found');

  if (!file.deletedAt) {
    await prisma.vaultFile.update({
      where: { id: file.id },
      data: {
        deletedAt: new Date(),
        ...(ctx.authorId ? { lastModifiedById: ctx.authorId } : {}),
      },
    });
    await deleteProjectFile(ctx.projectId, file.path).catch(() => undefined);
  }

  const log = await writeLog(ctx, {
    opType: 'DELETE',
    filePath: file.path,
    payload: op.payload as unknown as Prisma.InputJsonValue,
  });
  return { outcome: { kind: 'deleted', fileId: file.id }, log };
}

// ---------------------------------------------------------------------------
// RENAME / MOVE  (semantically identical here — both update path)
// ---------------------------------------------------------------------------

async function applyMove(
  ctx: ApplyContext,
  op: Extract<OperationInput, { opType: 'RENAME' | 'MOVE' }>,
): Promise<ApplyResult> {
  const file = await prisma.vaultFile.findFirst({
    where: { id: op.payload.fileId, projectId: ctx.projectId, deletedAt: null },
    select: { id: true, path: true },
  });
  if (!file) throw new Error('file_not_found');

  let normalizedNew: string;
  try {
    normalizedNew = normalizeVaultPath(op.newPath);
  } catch (err) {
    if (err instanceof InvalidPathError) throw err;
    throw err;
  }

  if (file.path === normalizedNew) {
    const log = await writeLog(ctx, {
      opType: op.opType,
      filePath: file.path,
      newPath: normalizedNew,
      payload: op.payload as unknown as Prisma.InputJsonValue,
    });
    return { outcome: { kind: 'no_op', reason: 'same_path' }, log };
  }

  // Concurrent RENAME tiebreak: if another file already lives at the target path,
  // compare clientIds lexicographically — operation with the larger clientId wins
  // by being applied; the loser would be retried by the originating client.
  const collision = await prisma.vaultFile.findFirst({
    where: { projectId: ctx.projectId, path: normalizedNew, deletedAt: null },
    select: { id: true },
  });
  if (collision && collision.id !== file.id) {
    // Re-route to the first free `<path>.conflict-<clientId>[-n]`. The first
    // name can already be taken — by this client's conflict copy of another
    // file, or by a tombstone. The move then overwrote that file's bytes on
    // disk (a binary's only copy) before the row update hit the unique index,
    // and the failed operation stayed in the client's queue for good. The
    // file itself already sitting there is this same rename retried.
    const conflictPath = await pickConflictPath(
      ctx,
      normalizedNew,
      (row) => row.deletedAt !== null || row.id === file.id,
    );
    await dropTombstoneAt(ctx.projectId, conflictPath);
    await moveProjectFile(ctx.projectId, file.path, conflictPath);
    await prisma.vaultFile.update({
      where: { id: file.id },
      data: {
        path: conflictPath,
        ...(ctx.authorId ? { lastModifiedById: ctx.authorId } : {}),
      },
    });
    const log = await writeLog(ctx, {
      opType: op.opType,
      filePath: file.path,
      newPath: conflictPath,
      payload: {
        ...op.payload,
        originalNewPath: normalizedNew,
        conflict: true,
      } as Prisma.InputJsonValue,
    });
    return {
      outcome: {
        kind: 'conflict_create_renamed',
        fileId: file.id,
        originalPath: normalizedNew,
        finalPath: conflictPath,
      },
      log,
    };
  }

  // The collision check above only sees live rows, but
  // `@@unique([projectId, path])` doesn't filter tombstones — so a rename
  // onto a previously-deleted path would blow up on the unique constraint.
  // The tombstone was already user-deleted intent; clearing it lets the
  // rename proceed (`onDelete: Cascade` takes care of its Yjs doc + version
  // history).
  await dropTombstoneAt(ctx.projectId, normalizedNew);

  await moveProjectFile(ctx.projectId, file.path, normalizedNew);
  await prisma.vaultFile.update({
    where: { id: file.id },
    data: {
      path: normalizedNew,
      ...(ctx.authorId ? { lastModifiedById: ctx.authorId } : {}),
    },
  });

  const log = await writeLog(ctx, {
    opType: op.opType,
    filePath: file.path,
    newPath: normalizedNew,
    payload: op.payload as unknown as Prisma.InputJsonValue,
  });

  return {
    outcome: { kind: 'renamed', fileId: file.id, from: file.path, to: normalizedNew },
    log,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function writeLog(
  ctx: ApplyContext,
  data: {
    opType: OpType;
    filePath: string;
    newPath?: string;
    payload: Prisma.InputJsonValue;
  },
): Promise<OperationLog> {
  // Persist the merged clock so consumers can resume from it.
  const mergedClock = merge(ctx.vectorClock, {});
  return prisma.operationLog.create({
    data: {
      projectId: ctx.projectId,
      opType: data.opType,
      filePath: data.filePath,
      ...(data.newPath ? { newPath: data.newPath } : {}),
      ...(ctx.authorId ? { authorId: ctx.authorId } : {}),
      vectorClock: mergedClock as Prisma.InputJsonValue,
      payload: data.payload,
    },
  });
}

/**
 * `<path>.conflict-<clientId>` — or, for `attempt` ≥ 2, `…conflict-<clientId>-<attempt>`,
 * the next name tried when the first one is taken (see {@link pickConflictPath}).
 * The counter goes after the sanitized id, so a long clientId cut to 32 chars
 * doesn't cut the counter off with it.
 */
export function appendConflictSuffix(path: string, clientId: string, attempt = 1): string {
  const sanitized = clientId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32) || 'unknown';
  const tag = attempt > 1 ? `${sanitized}-${attempt}` : sanitized;
  const lastDot = path.lastIndexOf('.');
  const lastSlash = path.lastIndexOf('/');
  if (lastDot > lastSlash) {
    return `${path.slice(0, lastDot)}.conflict-${tag}${path.slice(lastDot)}`;
  }
  return `${path}.conflict-${tag}`;
}

/**
 * Clear a tombstone sitting at `path` so a live file can move there (the unique
 * index spans tombstones). `onDelete: Cascade` takes its Yjs doc and versions.
 */
async function dropTombstoneAt(projectId: string, path: string): Promise<void> {
  const row = await prisma.vaultFile.findUnique({
    where: { projectId_path: { projectId, path } },
    select: { id: true, deletedAt: true },
  });
  if (row && row.deletedAt !== null) {
    await prisma.vaultFile.delete({ where: { id: row.id } });
  }
}

/** How many `<path>.conflict-<clientId>[-n]` names {@link pickConflictPath} tries. */
const MAX_CONFLICT_ATTEMPTS = 100;

/**
 * The first `<path>.conflict-<clientId>[-n]` this operation may use: no row
 * there, or a row `usable` accepts (a tombstone, a retry of this very
 * operation). Any other live row is another file and is skipped — writing or
 * moving onto it destroyed that file's content.
 */
async function pickConflictPath(
  ctx: ApplyContext,
  path: string,
  usable: (row: { id: string; deletedAt: Date | null; contentHash: string }) => boolean,
): Promise<string> {
  for (let attempt = 1; attempt <= MAX_CONFLICT_ATTEMPTS; attempt++) {
    const candidate = appendConflictSuffix(path, ctx.clientId, attempt);
    const row = await prisma.vaultFile.findUnique({
      where: { projectId_path: { projectId: ctx.projectId, path: candidate } },
      select: { id: true, deletedAt: true, contentHash: true },
    });
    if (!row || usable(row)) return candidate;
  }
  throw new Error('conflict_path_exhausted');
}
