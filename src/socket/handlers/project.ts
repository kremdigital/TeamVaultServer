import * as Y from 'yjs';
import type { Server, Socket } from 'socket.io';
import { prisma } from '@/lib/db/client';
import { canViewProject, loadProjectAccess } from '@/lib/auth/permissions';
import { listOperationsSince } from '@/lib/sync/operation-log';
import { type VectorClock, parseClock } from '@/lib/sync/vector-clock';
import { buildInitialState } from '@/lib/crdt/persistence';
import { readProjectFile } from '@/lib/files/storage';
import type { Logger } from 'pino';
import { child } from '@/lib/logger';
import { getSocketUser, projectRoom } from '../auth';

/**
 * How many text-doc snapshots to load + ship per `yjs:catchup` batch. Keeps
 * the server's working set (Y.Docs in memory) and each socket message small,
 * so a large vault never loads hundreds of docs at once or blocks the client.
 */
const YJS_CATCHUP_BATCH = 20;

export interface JoinPayload {
  projectId: string;
  sinceVectorClock?: VectorClock | null;
  /**
   * New clients set this to receive the Yjs catch-up as batched `yjs:catchup`
   * events instead of one inline `yjsDocs` array. Omitted by older clients,
   * who get the (potentially huge) inline array — see {@link JoinAckPayload}.
   */
  streamYjs?: boolean;
  /**
   * Join the project room (for op-log catch-up + live broadcasts) WITHOUT any
   * Yjs doc catch-up. Used by the web editor, which pulls only the single doc
   * it edits via `yjs:fetch` instead of the whole vault.
   */
  skipYjsCatchup?: boolean;
}

export interface YjsDocSnapshot {
  fileId: string;
  /** `Y.encodeStateAsUpdate(doc)` — the server's full state for this doc. */
  sync1: number[];
  /** `Y.encodeStateVector(doc)` — lets the client compute the inverse delta
   *  (ops the server is missing, e.g. offline edits) and push them back. */
  stateVector: number[];
}

export interface JoinAckPayload {
  ok: true;
  operations: Array<{
    id: string;
    opType: string;
    filePath: string;
    newPath: string | null;
    authorId: string | null;
    vectorClock: VectorClock;
    payload: unknown;
    createdAt: Date;
  }>;
  /**
   * Present (always `true`) when the client had more unseen operations than
   * one catch-up returns: `operations` holds the newest of them, the older ones
   * are left out. Older clients ignore it.
   */
  operationsTruncated?: true;
  /**
   * Legacy inline catch-up: full Y.Doc state of every text file. Present ONLY
   * for clients that did not request streaming. Building this loads every doc
   * into memory and the client applies them synchronously — both scale badly,
   * so new clients set `streamYjs` and receive the docs via `yjs:catchup`.
   */
  yjsDocs?: YjsDocSnapshot[];
  /** True when the docs are streaming via `yjs:catchup` (client opted in). */
  yjsStream?: boolean;
  /** Count of text docs that will stream — lets the client show progress. */
  yjsCount?: number;
  /** True when Yjs catch-up was skipped at the client's request (web editor). */
  yjsSkipped?: boolean;
}

export type JoinAck = JoinAckPayload | { ok: false; error: string };

/** Streamed Yjs catch-up batch (server → client), one per `yjs:catchup`. */
export interface YjsCatchupBatch {
  projectId: string;
  docs: YjsDocSnapshot[];
  /** True on the final batch so the client knows catch-up is complete. */
  done: boolean;
}

type TextFile = { id: string; path: string };

export function attachProjectHandlers(_io: Server, socket: Socket): void {
  const log = child({ socket: socket.id, userId: getSocketUser(socket).userId });

  socket.on('project:join', async (raw: unknown, cb: (ack: JoinAck) => void) => {
    const payload = parseJoinPayload(raw);
    if (!payload) {
      cb({ ok: false, error: 'invalid_payload' });
      return;
    }

    const access = await loadProjectAccess(
      { id: getSocketUser(socket).userId, role: 'USER' },
      payload.projectId,
    );
    if (!access) {
      cb({ ok: false, error: 'project_not_found' });
      return;
    }

    // Need the user's role from DB for permission decisions.
    const user = await prisma.user.findUnique({
      where: { id: getSocketUser(socket).userId },
      select: { role: true },
    });
    if (!user) {
      cb({ ok: false, error: 'user_not_found' });
      return;
    }
    const actor = { id: getSocketUser(socket).userId, role: user.role };
    if (!canViewProject(actor, access)) {
      cb({ ok: false, error: 'forbidden' });
      return;
    }

    await socket.join(projectRoom(payload.projectId));

    // 1) Operation log catch-up.
    const { operations: ops, truncated } = await listOperationsSince({
      projectId: payload.projectId,
      since: payload.sinceVectorClock ?? {},
    });
    if (truncated) {
      log.warn(
        { projectId: payload.projectId, ops: ops.length },
        'project:join: catch-up truncated to the newest operations',
      );
    }
    // Additive: set only when older unseen operations were left out.
    const truncation = truncated ? { operationsTruncated: true as const } : {};
    const operations = ops.map((o) => ({
      id: o.id,
      opType: o.opType,
      filePath: o.filePath,
      newPath: o.newPath,
      authorId: o.authorId,
      vectorClock: o.vectorClock as VectorClock,
      payload: o.payload,
      createdAt: o.createdAt,
    }));

    // Web editor: skip Yjs catch-up entirely (it fetches the single doc it
    // edits via `yjs:fetch`). Still joined the room above for live broadcasts.
    if (payload.skipYjsCatchup) {
      log.info({ projectId: payload.projectId, ops: ops.length, yjsSkipped: true }, 'project:join');
      cb({ ok: true, operations, ...truncation, yjsSkipped: true });
      return;
    }

    // 2) Yjs catch-up — every text doc's state. Streamed in batches for new
    //    clients (bounded memory + non-blocking), inline for legacy clients.
    const textFiles = await prisma.vaultFile.findMany({
      where: { projectId: payload.projectId, deletedAt: null, fileType: 'TEXT' },
      select: { id: true, path: true },
    });

    if (payload.streamYjs) {
      log.info(
        { projectId: payload.projectId, ops: ops.length, docs: textFiles.length, stream: true },
        'project:join',
      );
      cb({ ok: true, operations, ...truncation, yjsStream: true, yjsCount: textFiles.length });
      await streamYjsCatchup(socket, payload.projectId, textFiles, log);
      return;
    }

    // Legacy: build the whole array up front and return it inline.
    const yjsDocs = await encodeDocs(payload.projectId, textFiles, log);
    log.info(
      { projectId: payload.projectId, ops: ops.length, docs: yjsDocs.length },
      'project:join',
    );
    cb({ ok: true, operations, ...truncation, yjsDocs });
  });

  socket.on('project:leave', async (raw: unknown, cb?: (ack: { ok: true }) => void) => {
    const projectId =
      typeof raw === 'object' && raw !== null && 'projectId' in raw
        ? String((raw as { projectId: unknown }).projectId)
        : null;
    if (projectId) {
      await socket.leave(projectRoom(projectId));
    }
    cb?.({ ok: true });
  });
}

/**
 * Streams every text doc's snapshot to the joining socket in fixed-size
 * batches via `yjs:catchup`. Only one batch worth of Y.Docs is ever in memory,
 * and a `setImmediate` yield between batches keeps the server event loop
 * responsive (heartbeats, other sockets) during a large vault's catch-up.
 */
async function streamYjsCatchup(
  socket: Socket,
  projectId: string,
  textFiles: TextFile[],
  log: Logger,
): Promise<void> {
  if (textFiles.length === 0) {
    socket.emit('yjs:catchup', { projectId, docs: [], done: true } satisfies YjsCatchupBatch);
    return;
  }
  for (let i = 0; i < textFiles.length; i += YJS_CATCHUP_BATCH) {
    const slice = textFiles.slice(i, i + YJS_CATCHUP_BATCH);
    const docs = await encodeDocs(projectId, slice, log);
    const done = i + YJS_CATCHUP_BATCH >= textFiles.length;
    socket.emit('yjs:catchup', { projectId, docs, done } satisfies YjsCatchupBatch);
    if (!done) await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Loads + encodes the Y.Doc snapshot for each file (one bulk DB read for the
 * whole group). A text file with bytes on disk but no Yjs doc yet is
 * lazy-seeded — covers files created before the seed-on-create patch and any
 * future drift. A file whose seed fails is skipped (logged), not fatal.
 */
async function encodeDocs(
  projectId: string,
  files: TextFile[],
  log: Logger,
): Promise<YjsDocSnapshot[]> {
  if (files.length === 0) return [];
  const rows = await prisma.yjsDocument.findMany({
    where: { fileId: { in: files.map((f) => f.id) } },
    select: { fileId: true, state: true },
  });
  const stateByFileId = new Map<string, Uint8Array>(
    rows.map((r) => [r.fileId, new Uint8Array(r.state)]),
  );

  const out: YjsDocSnapshot[] = [];
  for (const file of files) {
    let state = stateByFileId.get(file.id);
    if (!state) {
      try {
        const buf = await readProjectFile(projectId, file.path);
        const initial = buildInitialState(buf.toString('utf8'));
        await prisma.yjsDocument.upsert({
          where: { fileId: file.id },
          create: {
            fileId: file.id,
            state: Buffer.from(initial.state),
            stateVector: Buffer.from(initial.stateVector),
          },
          update: {
            state: Buffer.from(initial.state),
            stateVector: Buffer.from(initial.stateVector),
          },
        });
        state = initial.state;
      } catch (err) {
        log.warn({ err, fileId: file.id, path: file.path }, 'yjs seed failed');
        continue;
      }
    }
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    const sync1 = Y.encodeStateAsUpdate(doc);
    const stateVector = Y.encodeStateVector(doc);
    doc.destroy();
    out.push({ fileId: file.id, sync1: Array.from(sync1), stateVector: Array.from(stateVector) });
  }
  return out;
}

function parseJoinPayload(raw: unknown): JoinPayload | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const data = raw as Record<string, unknown>;
  if (typeof data['projectId'] !== 'string') return null;
  return {
    projectId: data['projectId'],
    sinceVectorClock: parseClock(data['sinceVectorClock']),
    streamYjs: data['streamYjs'] === true,
    skipYjsCatchup: data['skipYjsCatchup'] === true,
  };
}
