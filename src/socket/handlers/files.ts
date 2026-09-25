import type { Server, Socket } from 'socket.io';
import { prisma } from '@/lib/db/client';
import { canEditFiles, loadProjectAccess } from '@/lib/auth/permissions';
import {
  applyOperation,
  isRevivedCreate,
  isTextUpdate,
  type OperationInput,
} from '@/lib/sync/operation-log';
import { increment, type VectorClock, parseClock } from '@/lib/sync/vector-clock';
import { child } from '@/lib/logger';
import { deleteStagedBlob, PathIsDirectoryError, readStagedBlob } from '@/lib/files/storage';
import { InvalidPathError } from '@/lib/files/paths';
import { sha256OfBuffer } from '@/lib/files/hash';
import { recordFileVersion } from '@/lib/files/versioning';
import { getSocketUser, projectRoom } from '../auth';

interface BaseEnvelope {
  projectId: string;
  clientId: string;
  vectorClock?: VectorClock;
}

type FileCreateMsg = BaseEnvelope & {
  filePath: string;
  fileType: 'TEXT' | 'BINARY';
  mimeType?: string | null;
  contentHash: string;
  size: number;
  // Inline bytes — sent by TEXT files (small) and legacy clients. Newer clients
  // omit this for BINARY files: the bytes are uploaded out-of-band over REST
  // (`PUT /blobs/:hash`) and read from the staging area by `contentHash`, which
  // keeps multi-megabyte payloads off the Socket.IO channel.
  data?: number[];
};
type FileUpdateBinaryMsg = BaseEnvelope & {
  fileId: string;
  contentHash: string;
  size: number;
  data?: number[];
};
type FileDeleteMsg = BaseEnvelope & { fileId: string; filePath: string };
type FileMoveMsg = BaseEnvelope & { fileId: string; filePath: string; newPath: string };

type Ack = (response: { ok: true; outcome: unknown } | { ok: false; error: string }) => void;

async function withEditAccess(
  socket: Socket,
  projectId: string,
  ack: Ack,
): Promise<{ ok: true; userId: string; role: 'USER' | 'SUPERADMIN' } | { ok: false }> {
  const userId = getSocketUser(socket).userId;
  const access = await loadProjectAccess({ id: userId, role: 'USER' }, projectId);
  if (!access) {
    ack({ ok: false, error: 'project_not_found' });
    return { ok: false };
  }
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (!user) {
    ack({ ok: false, error: 'user_not_found' });
    return { ok: false };
  }
  if (!canEditFiles({ id: userId, role: user.role }, access)) {
    ack({ ok: false, error: 'forbidden' });
    return { ok: false };
  }
  return { ok: true, userId, role: user.role };
}

/**
 * Every `file:*` broadcast goes to the whole room, the sender included, and
 * carries the author's `clientId` (the one the operation came with). That is how
 * a client recognises its own operation coming back — e.g. the intermediate
 * steps of its own offline rename chain — and doesn't apply it over a newer
 * local state. REST writes carry the pseudo client `rest:<userId>` (see
 * `rest-bridge.ts`). The value is what the client declared, not verified, so it
 * is a hint for skipping an echo, never a reason to drop someone's change.
 */
export function attachFileHandlers(io: Server, socket: Socket): void {
  const log = child({ socket: socket.id, userId: getSocketUser(socket).userId });

  socket.on('file:create', async (raw: FileCreateMsg, ack: Ack) => {
    const auth = await withEditAccess(socket, raw.projectId, ack);
    if (!auth.ok) return;

    const bytes = await resolveOpBytes(raw.projectId, raw.contentHash, raw.data);
    if (!bytes) {
      ack({ ok: false, error: 'blob_not_staged' });
      return;
    }

    const op: OperationInput = {
      opType: 'CREATE',
      filePath: raw.filePath,
      payload: {
        fileType: raw.fileType,
        mimeType: raw.mimeType ?? null,
        contentHash: raw.contentHash,
        size: raw.size,
      },
      data: bytes.data,
    };

    try {
      const result = await applyOperation(
        {
          projectId: raw.projectId,
          authorId: auth.userId,
          clientId: raw.clientId,
          vectorClock: increment(parseClock(raw.vectorClock), raw.clientId),
        },
        op,
      );
      if (bytes.staged) {
        await deleteStagedBlob(raw.projectId, raw.contentHash).catch(() => undefined);
      }
      io.to(projectRoom(raw.projectId)).emit('file:created', {
        result,
        clientId: raw.clientId,
        // An old id back from a tombstone, its Y.Doc history extended. Always
        // present (true/false), so a client can tell this server from one that
        // replaced the history and never sent the field. The REST bridge sends
        // the same field.
        revived: isRevivedCreate(result.log.payload),
        log: serializeLog(result.log),
      });

      // For TEXT files, push the seeded Yjs state to the room right away so
      // other vaults can materialise the content on disk without waiting
      // for their next `project:join`. Without this, a new `.md` file
      // shows up in the receiver's file index but the doc stays empty
      // until reconnect. Broadcasting to *everyone in the room* (including
      // the sender) keeps the sender's local Y.Doc in lockstep with the
      // server's seed — preventing future client edits from re-emitting
      // the full content (which the server would then merge as a
      // duplicate alongside the seed).
      if (raw.fileType === 'TEXT') {
        const fileId = extractFileId(result.outcome);
        if (fileId) await broadcastYjsState(io, raw.projectId, fileId);
      }

      ack({ ok: true, outcome: result.outcome });
    } catch (err) {
      log.error({ err }, 'file:create failed');
      ack({ ok: false, error: errorMessage(err) });
    }
  });

  socket.on('file:update-binary', async (raw: FileUpdateBinaryMsg, ack: Ack) => {
    const auth = await withEditAccess(socket, raw.projectId, ack);
    if (!auth.ok) return;

    const bytes = await resolveOpBytes(raw.projectId, raw.contentHash, raw.data);
    if (!bytes) {
      ack({ ok: false, error: 'blob_not_staged' });
      return;
    }

    const op: OperationInput = {
      opType: 'UPDATE',
      filePath: '', // resolved by fileId in applyOperation
      payload: { fileId: raw.fileId, contentHash: raw.contentHash, size: raw.size },
      data: bytes.data,
    };

    try {
      const result = await applyOperation(
        {
          projectId: raw.projectId,
          authorId: auth.userId,
          clientId: raw.clientId,
          vectorClock: increment(parseClock(raw.vectorClock), raw.clientId),
        },
        op,
      );
      if (bytes.staged) {
        await deleteStagedBlob(raw.projectId, raw.contentHash).catch(() => undefined);
      }
      if (isTextUpdate(result.log)) {
        // A note (plugin 0.3.x "Keep local" in the content-conflict modal):
        // `applyOperation` wrote the text into its Y.Doc, the history
        // extended, like REST PUT. It goes out the way REST PUT's does through
        // the bridge: the whole doc state as `yjs:update`, to the sender too,
        // so its doc takes the deletion of the old text before its next fold.
        // Never `file:updated-binary`: a plugin downloads the bytes of such an
        // update and settles them by hashes over the CRDT merge, i.e. the
        // content-conflict modal again, on every device. A no-op (the note is
        // a tombstone) changed nothing and sends nothing.
        if (result.outcome.kind === 'updated') {
          // Like REST PUT: the version history has this text, which a plugin
          // may look up as the base of its three-way merge (by the hash of
          // these very bytes). Best effort — the update itself is done, and a
          // failed ack would only make a 0.3.x queue send it again.
          await recordFileVersion({
            projectId: raw.projectId,
            fileId: result.outcome.fileId,
            data: bytes.data,
            contentHash: sha256OfBuffer(bytes.data),
            authorId: auth.userId,
          }).catch((err: unknown) => log.warn({ err }, 'file:update-binary: version not recorded'));
          await broadcastYjsState(io, raw.projectId, result.outcome.fileId);
        }
      } else {
        io.to(projectRoom(raw.projectId)).emit('file:updated-binary', {
          fileId: raw.fileId,
          contentHash: raw.contentHash,
          clientId: raw.clientId,
          log: serializeLog(result.log),
        });
      }
      ack({ ok: true, outcome: result.outcome });
    } catch (err) {
      log.error({ err }, 'file:update-binary failed');
      ack({ ok: false, error: errorMessage(err) });
    }
  });

  socket.on('file:delete', async (raw: FileDeleteMsg, ack: Ack) => {
    const auth = await withEditAccess(socket, raw.projectId, ack);
    if (!auth.ok) return;

    try {
      const result = await applyOperation(
        {
          projectId: raw.projectId,
          authorId: auth.userId,
          clientId: raw.clientId,
          vectorClock: increment(parseClock(raw.vectorClock), raw.clientId),
        },
        { opType: 'DELETE', filePath: raw.filePath, payload: { fileId: raw.fileId } },
      );
      io.to(projectRoom(raw.projectId)).emit('file:deleted', {
        fileId: raw.fileId,
        clientId: raw.clientId,
        log: serializeLog(result.log),
      });
      ack({ ok: true, outcome: result.outcome });
    } catch (err) {
      log.error({ err }, 'file:delete failed');
      ack({ ok: false, error: errorMessage(err) });
    }
  });

  socket.on('file:rename', (raw: FileMoveMsg, ack: Ack) =>
    handleMove(io, socket, raw, ack, 'RENAME'),
  );
  socket.on('file:move', (raw: FileMoveMsg, ack: Ack) => handleMove(io, socket, raw, ack, 'MOVE'));
}

async function handleMove(
  io: Server,
  socket: Socket,
  raw: FileMoveMsg,
  ack: Ack,
  opType: 'RENAME' | 'MOVE',
): Promise<void> {
  const auth = await withEditAccess(socket, raw.projectId, ack);
  if (!auth.ok) return;

  try {
    const result = await applyOperation(
      {
        projectId: raw.projectId,
        authorId: auth.userId,
        clientId: raw.clientId,
        vectorClock: increment(parseClock(raw.vectorClock), raw.clientId),
      },
      { opType, filePath: raw.filePath, newPath: raw.newPath, payload: { fileId: raw.fileId } },
    );
    // `newPath` is where the server actually put the file, not what the client
    // asked for: a target taken by another file sends it to
    // `<path>.conflict-<clientId>`, and the path is normalized. Broadcasting the
    // requested path made every client move its copy to a name the server
    // doesn't have (onto the file that won the name, if it had one), so the
    // vaults diverged from the server. The request stays readable as
    // `requestedPath`.
    io.to(projectRoom(raw.projectId)).emit(opType === 'RENAME' ? 'file:renamed' : 'file:moved', {
      fileId: raw.fileId,
      newPath: result.log.newPath ?? raw.newPath,
      requestedPath: raw.newPath,
      clientId: raw.clientId,
      outcome: result.outcome,
      log: serializeLog(result.log),
    });
    ack({ ok: true, outcome: result.outcome });
  } catch (err) {
    child({ socket: socket.id }).error({ err }, `${opType.toLowerCase()} failed`);
    ack({ ok: false, error: errorMessage(err) });
  }
}

/**
 * Send a note's whole stored Y.Doc state to the project room as `yjs:update`,
 * the sender included (the REST bridge does the same for REST writes). A client
 * holding any part of the doc's history merges it and converges to the stored
 * text, plus its own edits the server hasn't got yet; a peer that hasn't loaded
 * the doc materialises the note from it.
 */
async function broadcastYjsState(io: Server, projectId: string, fileId: string): Promise<void> {
  const doc = await prisma.yjsDocument.findUnique({
    where: { fileId },
    select: { state: true },
  });
  if (doc?.state && doc.state.length > 0) {
    io.to(projectRoom(projectId)).emit('yjs:update', {
      fileId,
      update: Array.from(new Uint8Array(doc.state)),
    });
  }
}

/**
 * Resolve the bytes for a CREATE / UPDATE op. Newer clients omit `data` for
 * binary files and stage the bytes over REST (`PUT /blobs/:hash`); we read them
 * from the shared storage volume by `contentHash`. Legacy / TEXT clients send
 * `data` inline. Returns the bytes plus whether they came from the staging area
 * (so the caller removes the staged blob once the op is applied). Returns `null`
 * when a staged blob was expected but is missing — the client retries.
 */
async function resolveOpBytes(
  projectId: string,
  contentHash: string,
  inline: number[] | undefined,
): Promise<{ data: Buffer; staged: boolean } | null> {
  if (inline !== undefined) return { data: Buffer.from(inline), staged: false };
  const blob = await readStagedBlob(projectId, contentHash);
  return blob ? { data: blob, staged: true } : null;
}

function serializeLog(log: { id: string; vectorClock: unknown; createdAt: Date }) {
  return {
    id: log.id,
    vectorClock: log.vectorClock,
    createdAt: log.createdAt.toISOString(),
  };
}

/**
 * Ack error text. Stable machine codes where the client has to branch on
 * them: it classifies an ack as retryable by string, and a human-readable
 * message like "Reserved folder name: .trash" was treated as a temporary
 * failure — the queued operation then blocked the whole offline queue on
 * every reconnect, silently (TASK-0027). A rejected path can never succeed on
 * a retry, so it gets its own code.
 */
function errorMessage(err: unknown): string {
  if (err instanceof InvalidPathError) return 'invalid_path';
  if (err instanceof PathIsDirectoryError) return 'path_is_directory';
  return err instanceof Error ? err.message : 'unknown_error';
}

function extractFileId(outcome: unknown): string | null {
  if (outcome && typeof outcome === 'object' && 'fileId' in outcome) {
    const fileId = (outcome as { fileId?: unknown }).fileId;
    return typeof fileId === 'string' ? fileId : null;
  }
  return null;
}
