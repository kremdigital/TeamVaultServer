import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server as HttpServer } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Server as IOServer, type ServerOptions } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { createIoServer } from '@/socket/server';
import { relay } from '@/socket/rest-bridge';
import {
  applyOperation,
  CATCHUP_OPERATIONS_LIMIT,
  FULL_CATCHUP_VERSION,
  type ApplyResult,
} from '@/lib/sync/operation-log';
import { applyRestOperation } from '@/lib/sync/rest-write';
import { generateApiKey } from '@/lib/auth/api-key';
import { signAccessToken } from '@/lib/auth/jwt';
import { TEXT_KEY } from '@/lib/crdt/persistence';
import { readProjectFile, readStagedBlob, writeStagedBlob } from '@/lib/files/storage';
import { sha256OfBuffer } from '@/lib/files/hash';
import { resetDatabase, testPrisma } from '../db';

let httpServer: HttpServer;
let io: IOServer;
let port: number;
let storageRoot: string;
let originalStoragePath: string | undefined;

beforeAll(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), 'osync-socket-'));
  originalStoragePath = process.env.STORAGE_PATH;
  process.env.STORAGE_PATH = storageRoot;

  httpServer = createServer();
  ({ io } = createIoServer({ httpServer, corsOrigin: '*' } as {
    httpServer: HttpServer;
  } & Partial<ServerOptions>));
  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = httpServer.address();
  if (!addr || typeof addr === 'string') throw new Error('failed to bind');
  port = addr.port;
});

afterAll(async () => {
  io.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  if (originalStoragePath !== undefined) process.env.STORAGE_PATH = originalStoragePath;
  else delete process.env.STORAGE_PATH;
  await rm(storageRoot, { recursive: true, force: true });
  await testPrisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase();
});

const openClients: ClientSocket[] = [];
afterEach(() => {
  for (const c of openClients) c.disconnect();
  openClients.length = 0;
});

async function bootstrapUserAndKey(name: string) {
  const user = await testPrisma.user.create({
    data: {
      email: `${name}-${Date.now()}-${Math.random()}@x.test`,
      passwordHash: 'h',
      name,
    },
  });
  const k = await generateApiKey();
  await testPrisma.apiKey.create({
    data: { userId: user.id, name: 'cli', keyHash: k.hash, keyPrefix: k.prefix },
  });
  return { userId: user.id, plainKey: k.plain };
}

async function createProject(ownerId: string) {
  return testPrisma.project.create({
    data: {
      slug: `s-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: 'P',
      ownerId,
      members: { create: { userId: ownerId, role: 'ADMIN', addedById: ownerId } },
    },
  });
}

function connect(apiKey: string): ClientSocket {
  const c = ioClient(`http://127.0.0.1:${port}`, {
    auth: { apiKey },
    transports: ['websocket'],
    reconnection: false,
  });
  openClients.push(c);
  return c;
}

/** Connect as a browser would: a session JWT via the handshake `auth.token`. */
function connectWithToken(token: string): ClientSocket {
  const c = ioClient(`http://127.0.0.1:${port}`, {
    auth: { token },
    transports: ['websocket'],
    reconnection: false,
  });
  openClients.push(c);
  return c;
}

/** Create a project member with the given role and a browser session token. */
async function bootstrapMember(
  name: string,
  projectId: string,
  role: 'ADMIN' | 'EDITOR' | 'VIEWER',
  addedById: string,
) {
  const user = await testPrisma.user.create({
    data: { email: `${name}-${Date.now()}-${Math.random()}@x.test`, passwordHash: 'h', name },
  });
  await testPrisma.projectMember.create({
    data: { projectId, userId: user.id, role, addedById },
  });
  const token = await signAccessToken(user.id, 'USER');
  return { userId: user.id, token };
}

function emitWithAck<T>(socket: ClientSocket, event: string, payload: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`ack timeout for ${event}`)), 5000);
    socket.emit(event, payload, (ack: T) => {
      clearTimeout(timer);
      resolve(ack);
    });
  });
}

describe('socket auth', () => {
  it('rejects connection without an api key', async () => {
    const c = connect('');
    await expect(
      new Promise<never>((resolve, reject) => {
        c.on('connect_error', (err) => reject(err));
        c.on('connect', () => resolve(null as never));
      }),
    ).rejects.toThrow();
  });

  it('rejects malformed key', async () => {
    const c = connect('not-an-osync-key');
    await expect(
      new Promise<never>((_resolve, reject) => {
        c.on('connect_error', (err) => reject(err));
      }),
    ).rejects.toThrow();
  });

  it('accepts a valid key', async () => {
    const { plainKey } = await bootstrapUserAndKey('auth-ok');
    const c = connect(plainKey);
    await new Promise<void>((resolve, reject) => {
      c.on('connect', () => resolve());
      c.on('connect_error', (err) => reject(err));
    });
    expect(c.connected).toBe(true);
  });
});

describe('project:join', () => {
  it('returns operations after sinceVectorClock and yjs docs', async () => {
    const { userId, plainKey } = await bootstrapUserAndKey('joiner');
    const project = await createProject(userId);

    // Seed an operation directly in the log for catch-up.
    await testPrisma.operationLog.create({
      data: {
        projectId: project.id,
        opType: 'CREATE',
        filePath: 'note.md',
        authorId: userId,
        vectorClock: { 'client-A': 1 },
        payload: { fileType: 'TEXT', contentHash: 'abc', size: 1 },
      },
    });

    const c = connect(plainKey);
    await new Promise<void>((resolve) => c.on('connect', () => resolve()));

    const ack = await emitWithAck<{
      ok: true;
      operations: { filePath: string }[];
      yjsDocs: unknown[];
    }>(c, 'project:join', { projectId: project.id, sinceVectorClock: {} });

    expect(ack.ok).toBe(true);
    expect(ack.operations).toHaveLength(1);
    expect(ack.operations[0]?.filePath).toBe('note.md');
    expect(ack.yjsDocs).toEqual([]);
  });

  it('streams the catch-up via yjs:catchup when the client sets streamYjs', async () => {
    const Y = await import('yjs');
    const { userId, plainKey } = await bootstrapUserAndKey('streamer');
    const project = await createProject(userId);

    // A TEXT file with a real Yjs doc to stream.
    const file = await testPrisma.vaultFile.create({
      data: {
        projectId: project.id,
        path: 'note.md',
        fileType: 'TEXT',
        contentHash: 'h',
        size: BigInt(5),
        mimeType: 'text/markdown',
      },
    });
    const ydoc = new Y.Doc();
    ydoc.getText('content').insert(0, 'hello');
    await testPrisma.yjsDocument.create({
      data: {
        fileId: file.id,
        state: Buffer.from(Y.encodeStateAsUpdate(ydoc)),
        stateVector: Buffer.from(Y.encodeStateVector(ydoc)),
      },
    });
    ydoc.destroy();

    const c = connect(plainKey);
    await new Promise<void>((resolve) => c.on('connect', () => resolve()));

    const batches: Array<{ docs: Array<{ fileId: string }>; done: boolean }> = [];
    const streamed = new Promise<void>((resolve) => {
      c.on('yjs:catchup', (b: { docs: Array<{ fileId: string }>; done: boolean }) => {
        batches.push(b);
        if (b.done) resolve();
      });
    });

    const ack = await emitWithAck<{
      ok: true;
      yjsStream?: boolean;
      yjsCount?: number;
      yjsDocs?: unknown[];
    }>(c, 'project:join', { projectId: project.id, sinceVectorClock: {}, streamYjs: true });

    // Light ack — docs do NOT come inline.
    expect(ack.ok).toBe(true);
    expect(ack.yjsStream).toBe(true);
    expect(ack.yjsCount).toBe(1);
    expect(ack.yjsDocs).toBeUndefined();

    await streamed;
    const allDocs = batches.flatMap((b) => b.docs);
    expect(allDocs.map((d) => d.fileId)).toContain(file.id);
    expect(batches[batches.length - 1]?.done).toBe(true);
  });

  describe('on a journal longer than 500 operations', () => {
    /** `count` operations of client `A`, counters 1..count, oldest first. */
    async function seedJournal(projectId: string, count: number): Promise<void> {
      const base = Date.UTC(2026, 8, 1);
      for (let from = 0; from < count; from += 1000) {
        const n = Math.min(1000, count - from);
        await testPrisma.operationLog.createMany({
          data: Array.from({ length: n }, (_, i) => ({
            projectId,
            opType: 'CREATE' as const,
            filePath: `A-${from + i + 1}.bin`,
            vectorClock: { A: from + i + 1 },
            payload: { fileType: 'BINARY', contentHash: 'h', size: 1 },
            createdAt: new Date(base + (from + i) * 10),
          })),
        });
      }
    }

    type OpsAck = {
      ok: true;
      operations: { filePath: string; vectorClock: Record<string, number> }[];
      operationsTruncated?: boolean;
      operationsCatchup?: number;
    };

    /** Every shape of the join a client sends. */
    const JOIN_SHAPES = [{}, { streamYjs: true }, { skipYjsCatchup: true }];

    it('with operationsCatchup: 2, returns the unseen operations, new ones at the end', async () => {
      const { userId, plainKey } = await bootstrapUserAndKey('long-journal');
      const project = await createProject(userId);
      await seedJournal(project.id, 603);

      const c = connect(plainKey);
      await new Promise<void>((resolve) => c.on('connect', () => resolve()));
      for (const extra of JOIN_SHAPES) {
        const ack = await emitWithAck<OpsAck>(c, 'project:join', {
          projectId: project.id,
          sinceVectorClock: { A: 600 },
          operationsCatchup: FULL_CATCHUP_VERSION,
          ...extra,
        });

        expect(ack.ok).toBe(true);
        expect(ack.operations.map((o) => o.filePath)).toEqual([
          'A-601.bin',
          'A-602.bin',
          'A-603.bin',
        ]);
        expect(ack.operations[2]?.vectorClock).toEqual({ A: 603 });
        expect(ack.operationsCatchup).toBe(2);
        expect('operationsTruncated' in ack).toBe(false);
      }
    });

    it('a catch-up version above 2 gets version 2, and the echo says so', async () => {
      const { userId, plainKey } = await bootstrapUserAndKey('newer-client');
      const project = await createProject(userId);
      await seedJournal(project.id, 603);

      const c = connect(plainKey);
      await new Promise<void>((resolve) => c.on('connect', () => resolve()));
      const ack = await emitWithAck<OpsAck>(c, 'project:join', {
        projectId: project.id,
        sinceVectorClock: { A: 602 },
        operationsCatchup: 3,
      });

      expect(ack.operations.map((o) => o.filePath)).toEqual(['A-603.bin']);
      expect(ack.operationsCatchup).toBe(2);
    });

    it('without operationsCatchup (plugin 0.3.7), gets the 500 oldest rows and no echo', async () => {
      const { userId, plainKey } = await bootstrapUserAndKey('old-plugin');
      const project = await createProject(userId);
      await seedJournal(project.id, 603);

      const c = connect(plainKey);
      await new Promise<void>((resolve) => c.on('connect', () => resolve()));
      // Plugin 0.3.7 sends none; a version below 2 or not a number is none.
      for (const flag of [{}, { operationsCatchup: 1 }, { operationsCatchup: '2' }]) {
        for (const extra of JOIN_SHAPES) {
          // The unseen rows inside the window come back, and nothing past it:
          // a 0.3.7 device of this project has the window's clock.
          const inWindow = await emitWithAck<OpsAck>(c, 'project:join', {
            projectId: project.id,
            sinceVectorClock: { A: 498 },
            ...flag,
            ...extra,
          });
          expect(inWindow.operations.map((o) => o.filePath)).toEqual(['A-499.bin', 'A-500.bin']);
          expect('operationsCatchup' in inWindow).toBe(false);
          expect('operationsTruncated' in inWindow).toBe(false);

          const past = await emitWithAck<OpsAck>(c, 'project:join', {
            projectId: project.id,
            sinceVectorClock: { A: 500 },
            ...flag,
            ...extra,
          });
          expect(past.operations).toEqual([]);
          expect('operationsCatchup' in past).toBe(false);
        }
      }
    });

    it('past the limit, sends the newest operations and operationsTruncated', async () => {
      const { userId, plainKey } = await bootstrapUserAndKey('huge-journal');
      const project = await createProject(userId);
      await seedJournal(project.id, CATCHUP_OPERATIONS_LIMIT + 1);

      const c = connect(plainKey);
      await new Promise<void>((resolve) => c.on('connect', () => resolve()));
      // Every shape of the join: the flag is on each.
      for (const extra of JOIN_SHAPES) {
        const ack = await emitWithAck<OpsAck>(c, 'project:join', {
          projectId: project.id,
          sinceVectorClock: {},
          operationsCatchup: FULL_CATCHUP_VERSION,
          ...extra,
        });
        expect(ack.operationsCatchup).toBe(2);
        expect(ack.operationsTruncated).toBe(true);
        expect(ack.operations).toHaveLength(CATCHUP_OPERATIONS_LIMIT);
        expect(ack.operations[0]?.filePath).toBe('A-2.bin');
        expect(ack.operations.at(-1)?.filePath).toBe(`A-${CATCHUP_OPERATIONS_LIMIT + 1}.bin`);
      }
    });

    it('skipOperations (the web editor) gets no operations, and still the room', async () => {
      const { userId, plainKey } = await bootstrapUserAndKey('web-editor');
      const project = await createProject(userId);
      await seedJournal(project.id, 600);

      const editor = connect(plainKey);
      await new Promise<void>((resolve) => editor.on('connect', () => resolve()));
      const ack = await emitWithAck<OpsAck & { yjsSkipped?: boolean }>(editor, 'project:join', {
        projectId: project.id,
        skipYjsCatchup: true,
        skipOperations: true,
        operationsCatchup: FULL_CATCHUP_VERSION,
      });

      expect(ack.ok).toBe(true);
      expect(ack.operations).toEqual([]);
      expect(ack.yjsSkipped).toBe(true);
      expect('operationsTruncated' in ack).toBe(false);
      expect('operationsCatchup' in ack).toBe(false);

      // Joined all the same: a teammate's operation reaches it live.
      type Created = { clientId?: string; result: { outcome: { path?: string } } };
      const created = new Promise<Created>((resolve) =>
        editor.on('file:created', (e: Created) => resolve(e)),
      );
      const peer = connect(plainKey);
      await new Promise<void>((resolve) => peer.on('connect', () => resolve()));
      await emitWithAck(peer, 'project:join', { projectId: project.id, skipOperations: true });
      await emitWithAck(peer, 'file:create', {
        projectId: project.id,
        clientId: 'peer',
        filePath: 'live.md',
        fileType: 'TEXT',
        contentHash: 'h',
        size: 1,
        data: Array.from(Buffer.from('x')),
      });
      const event = await created;
      expect(event.clientId).toBe('peer');
      expect(event.result.outcome.path).toBe('live.md');
    });
  });

  it('a note written through REST or MCP comes back as Yjs, never as an UPDATE', async () => {
    const { userId, plainKey } = await bootstrapUserAndKey('mcp-writer');
    const project = await createProject(userId);
    const projectId = project.id;
    // A plugin creates a note and an attachment.
    const byPlugin = (n: number) => ({
      projectId,
      authorId: userId,
      clientId: 'A',
      vectorClock: { A: n },
    });
    const note = await applyOperation(byPlugin(1), {
      opType: 'CREATE',
      filePath: 'a.md',
      payload: { fileType: 'TEXT', contentHash: 'h-old', size: 4 },
      data: Buffer.from('old\n'),
    });
    const img = await applyOperation(byPlugin(2), {
      opType: 'CREATE',
      filePath: 'img.png',
      payload: { fileType: 'BINARY', contentHash: 'h-png1', size: 4 },
      data: Buffer.from('PNG1'),
    });
    if (note.outcome.kind !== 'created' || img.outcome.kind !== 'created') {
      throw new Error('expected created');
    }
    const noteId = note.outcome.fileId;
    const imgId = img.outcome.fileId;
    // MCP `write_note` (REST PUT) rewrites the note, the web UI replaces the
    // attachment.
    await applyRestOperation({
      projectId,
      userId,
      op: {
        opType: 'UPDATE',
        filePath: 'a.md',
        payload: { fileId: noteId, contentHash: 'h-new', size: 8 },
        data: Buffer.from('old\nmcp\n'),
      },
    });
    await applyRestOperation({
      projectId,
      userId,
      op: {
        opType: 'UPDATE',
        filePath: 'img.png',
        payload: { fileId: imgId, contentHash: 'h-png2', size: 4 },
        data: Buffer.from('PNG2'),
      },
    });

    const c = connect(plainKey);
    await new Promise<void>((resolve) => c.on('connect', () => resolve()));
    // A device that saw both creations, legacy catch-up and whole-journal alike.
    for (const flag of [{}, { operationsCatchup: FULL_CATCHUP_VERSION }]) {
      const ack = await emitWithAck<{
        ok: true;
        operations: { opType: string; filePath: string }[];
        yjsDocs: { fileId: string; sync1: number[] }[];
      }>(c, 'project:join', { projectId, sinceVectorClock: { A: 2 }, ...flag });

      expect(ack.operations.map((o) => `${o.opType} ${o.filePath}`)).toEqual(['UPDATE img.png']);
      // The note's new text is in its Yjs state, the way every client takes it.
      const state = ack.yjsDocs.find((d) => d.fileId === noteId);
      const replica = new Y.Doc();
      Y.applyUpdate(replica, Uint8Array.from(state?.sync1 ?? []));
      expect(replica.getText(TEXT_KEY).toString()).toBe('old\nmcp\n');
    }
  });

  it('refuses join for a non-member project', async () => {
    const { plainKey } = await bootstrapUserAndKey('outsider');
    const otherOwner = await testPrisma.user.create({
      data: { email: `o-${Date.now()}@x.test`, passwordHash: 'h', name: 'O' },
    });
    const project = await createProject(otherOwner.id);

    const c = connect(plainKey);
    await new Promise<void>((resolve) => c.on('connect', () => resolve()));
    const ack = await emitWithAck<{ ok: false; error: string } | { ok: true }>(c, 'project:join', {
      projectId: project.id,
    });
    expect(ack.ok).toBe(false);
    if (ack.ok === false) expect(ack.error).toBe('forbidden');
  });
});

describe('file:create', () => {
  it('broadcasts the new file to other room members', async () => {
    const { userId: aId, plainKey: aKey } = await bootstrapUserAndKey('A');
    const project = await createProject(aId);

    const memberB = await testPrisma.user.create({
      data: { email: `b-${Date.now()}@x.test`, passwordHash: 'h', name: 'B' },
    });
    await testPrisma.projectMember.create({
      data: { projectId: project.id, userId: memberB.id, role: 'EDITOR', addedById: aId },
    });
    const k = await generateApiKey();
    await testPrisma.apiKey.create({
      data: { userId: memberB.id, name: 'cli', keyHash: k.hash, keyPrefix: k.prefix },
    });
    const bKey = k.plain;

    const a = connect(aKey);
    const b = connect(bKey);
    await Promise.all([
      new Promise<void>((r) => a.on('connect', () => r())),
      new Promise<void>((r) => b.on('connect', () => r())),
    ]);

    await emitWithAck(a, 'project:join', { projectId: project.id });
    await emitWithAck(b, 'project:join', { projectId: project.id });

    const broadcastReceived = new Promise<{ result: { outcome: { kind: string } } }>((resolve) => {
      b.once('file:created', (data) => resolve(data as never));
    });

    await emitWithAck(a, 'file:create', {
      projectId: project.id,
      clientId: 'client-A',
      filePath: 'shared.md',
      fileType: 'TEXT',
      contentHash: 'abc',
      size: 5,
      data: Array.from(Buffer.from('hello')),
    });

    const broadcast = await broadcastReceived;
    expect(broadcast.result.outcome.kind).toBe('created');

    const file = await testPrisma.vaultFile.findFirst({
      where: { projectId: project.id, path: 'shared.md' },
    });
    expect(file).not.toBeNull();
  });

  it('folds a staged blob into the vault for a metadata-only binary create', async () => {
    // Binary bytes ride REST into the staging area; the socket op is
    // metadata-only (no `data`). The handler reads the staged blob by hash,
    // applies it, then removes the staged copy.
    const { userId: aId, plainKey: aKey } = await bootstrapUserAndKey('A');
    const project = await createProject(aId);

    const content = Buffer.from('a binary storyboard payload');
    const contentHash = sha256OfBuffer(content);
    await writeStagedBlob(project.id, contentHash, content);

    const a = connect(aKey);
    await new Promise<void>((r) => a.on('connect', () => r()));
    await emitWithAck(a, 'project:join', { projectId: project.id });

    const ack = await emitWithAck<{ ok: boolean; outcome?: { kind: string } }>(a, 'file:create', {
      projectId: project.id,
      clientId: 'client-A',
      filePath: 'storyboard.png',
      fileType: 'BINARY',
      contentHash,
      size: content.byteLength,
      // no `data` — bytes come from the staging area
    });
    expect(ack.ok).toBe(true);

    const file = await testPrisma.vaultFile.findFirst({
      where: { projectId: project.id, path: 'storyboard.png' },
    });
    expect(file).not.toBeNull();
    expect(file?.contentHash).toBe(contentHash);

    // The staged blob is consumed once folded in.
    expect(await readStagedBlob(project.id, contentHash)).toBeNull();
  });

  it('rejects a metadata-only create when the staged blob is missing', async () => {
    const { userId: aId, plainKey: aKey } = await bootstrapUserAndKey('A');
    const project = await createProject(aId);

    const a = connect(aKey);
    await new Promise<void>((r) => a.on('connect', () => r()));
    await emitWithAck(a, 'project:join', { projectId: project.id });

    const ack = await emitWithAck<{ ok: boolean; error?: string }>(a, 'file:create', {
      projectId: project.id,
      clientId: 'client-A',
      filePath: 'missing.png',
      fileType: 'BINARY',
      contentHash: 'b'.repeat(64),
      size: 3,
      // no `data` and nothing staged → must NACK so the client retries.
    });
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('blob_not_staged');
  });

  it('broadcasts the seeded Yjs state alongside file:created for TEXT', async () => {
    // Without this, a new .md file created by one client (e.g. via shell
    // + chokidar) appears in the receiver's file index but the doc stays
    // empty until they reconnect. The server seeds Yjs on CREATE; this
    // test verifies the seed reaches the room as a `yjs:update` so peers
    // materialise the content immediately.
    const { userId: aId, plainKey: aKey } = await bootstrapUserAndKey('seedA');
    const project = await createProject(aId);
    const memberB = await testPrisma.user.create({
      data: { email: `b-${Date.now()}@x.test`, passwordHash: 'h', name: 'B' },
    });
    await testPrisma.projectMember.create({
      data: { projectId: project.id, userId: memberB.id, role: 'EDITOR', addedById: aId },
    });
    const k = await generateApiKey();
    await testPrisma.apiKey.create({
      data: { userId: memberB.id, name: 'cli', keyHash: k.hash, keyPrefix: k.prefix },
    });
    const bKey = k.plain;

    const a = connect(aKey);
    const b = connect(bKey);
    await Promise.all([
      new Promise<void>((r) => a.on('connect', () => r())),
      new Promise<void>((r) => b.on('connect', () => r())),
    ]);
    await emitWithAck(a, 'project:join', { projectId: project.id });
    await emitWithAck(b, 'project:join', { projectId: project.id });

    const yjsBroadcast = new Promise<{ fileId: string; update: number[] }>((resolve) => {
      b.once('yjs:update', (data) => resolve(data as never));
    });

    await emitWithAck(a, 'file:create', {
      projectId: project.id,
      clientId: 'client-A',
      filePath: 'fresh.md',
      fileType: 'TEXT',
      contentHash: 'h',
      size: 11,
      data: Array.from(Buffer.from('born in cli')),
    });

    const msg = await yjsBroadcast;
    expect(msg.fileId).toBeTruthy();
    expect(msg.update.length).toBeGreaterThan(2);

    // Decoding the broadcast on a fresh doc should reproduce the file's
    // initial text — that's what a real plugin client would do.
    const replica = new Y.Doc();
    Y.applyUpdate(replica, Uint8Array.from(msg.update));
    expect(replica.getText(TEXT_KEY).toString()).toBe('born in cli');
    replica.destroy();
  });
});

describe('yjs:update', () => {
  it('persists update and broadcasts to room', async () => {
    const { userId, plainKey } = await bootstrapUserAndKey('Y');
    const project = await createProject(userId);
    const file = await testPrisma.vaultFile.create({
      data: {
        projectId: project.id,
        path: 'live.md',
        fileType: 'TEXT',
        contentHash: 'init',
        size: BigInt(0),
      },
    });

    const peerA = connect(plainKey);
    const peerB = connect(plainKey);
    await Promise.all([
      new Promise<void>((r) => peerA.on('connect', () => r())),
      new Promise<void>((r) => peerB.on('connect', () => r())),
    ]);
    await emitWithAck(peerA, 'project:join', { projectId: project.id });
    await emitWithAck(peerB, 'project:join', { projectId: project.id });

    // Build a Yjs update that inserts text.
    const doc = new Y.Doc();
    doc.getText(TEXT_KEY).insert(0, 'Hello CRDT');
    const update = Y.encodeStateAsUpdate(doc);
    doc.destroy();

    const broadcast = new Promise<{ fileId: string; update: number[] }>((resolve) => {
      peerB.once('yjs:update', (data) => resolve(data as never));
    });

    const ack = await emitWithAck<{ ok: true; changed: boolean }>(peerA, 'yjs:update', {
      projectId: project.id,
      fileId: file.id,
      update: Array.from(update),
    });
    expect(ack.ok).toBe(true);
    expect(ack.changed).toBe(true);

    const broadcastMsg = await broadcast;
    expect(broadcastMsg.fileId).toBe(file.id);
    expect(broadcastMsg.update.length).toBe(update.length);

    // Server-persisted Y.Doc must match.
    const stored = await testPrisma.yjsDocument.findUnique({ where: { fileId: file.id } });
    expect(stored).not.toBeNull();
    const reload = new Y.Doc();
    Y.applyUpdate(reload, new Uint8Array(stored!.state));
    expect(reload.getText(TEXT_KEY).toString()).toBe('Hello CRDT');
    reload.destroy();
  });
});

describe('web client (session JWT) auth', () => {
  it('accepts a connection with a valid session token', async () => {
    const { userId } = await bootstrapUserAndKey('web-ok');
    const token = await signAccessToken(userId, 'USER');
    const c = connectWithToken(token);
    await new Promise<void>((resolve, reject) => {
      c.on('connect', () => resolve());
      c.on('connect_error', (err) => reject(err));
    });
    expect(c.connected).toBe(true);
  });

  it('rejects a connection with a bogus token', async () => {
    const c = connectWithToken('not.a.jwt');
    await expect(
      new Promise<never>((_resolve, reject) => {
        c.on('connect_error', (err) => reject(err));
      }),
    ).rejects.toThrow();
  });
});

describe('yjs:fetch (single-doc, web editor)', () => {
  it('returns the doc state a member can apply', async () => {
    const { userId } = await bootstrapUserAndKey('fetch-owner');
    const project = await createProject(userId);
    const file = await testPrisma.vaultFile.create({
      data: {
        projectId: project.id,
        path: 'fetch.md',
        fileType: 'TEXT',
        contentHash: 'h',
        size: BigInt(5),
      },
    });
    const ydoc = new Y.Doc();
    ydoc.getText(TEXT_KEY).insert(0, 'fetched');
    await testPrisma.yjsDocument.create({
      data: {
        fileId: file.id,
        state: Buffer.from(Y.encodeStateAsUpdate(ydoc)),
        stateVector: Buffer.from(Y.encodeStateVector(ydoc)),
      },
    });
    ydoc.destroy();

    const token = await signAccessToken(userId, 'USER');
    const c = connectWithToken(token);
    await new Promise<void>((resolve) => c.on('connect', () => resolve()));

    const ack = await emitWithAck<{ ok: true; sync1: number[] } | { ok: false; error: string }>(
      c,
      'yjs:fetch',
      { projectId: project.id, fileId: file.id },
    );
    expect(ack.ok).toBe(true);
    if (ack.ok) {
      const replica = new Y.Doc();
      Y.applyUpdate(replica, Uint8Array.from(ack.sync1));
      expect(replica.getText(TEXT_KEY).toString()).toBe('fetched');
      replica.destroy();
    }
  });
});

describe('VIEWER permissions over the socket', () => {
  it('can join + fetch but is refused yjs:update', async () => {
    const { userId: ownerId } = await bootstrapUserAndKey('view-owner');
    const project = await createProject(ownerId);
    const file = await testPrisma.vaultFile.create({
      data: {
        projectId: project.id,
        path: 'ro.md',
        fileType: 'TEXT',
        contentHash: 'h',
        size: BigInt(0),
      },
    });
    const seed = new Y.Doc();
    seed.getText(TEXT_KEY).insert(0, 'read only');
    await testPrisma.yjsDocument.create({
      data: {
        fileId: file.id,
        state: Buffer.from(Y.encodeStateAsUpdate(seed)),
        stateVector: Buffer.from(Y.encodeStateVector(seed)),
      },
    });
    seed.destroy();

    const viewer = await bootstrapMember('viewer', project.id, 'VIEWER', ownerId);
    const c = connectWithToken(viewer.token);
    await new Promise<void>((resolve) => c.on('connect', () => resolve()));

    // Join (read) is allowed, with Yjs catch-up skipped.
    const join = await emitWithAck<{ ok: true; yjsSkipped?: boolean } | { ok: false }>(
      c,
      'project:join',
      { projectId: project.id, skipYjsCatchup: true },
    );
    expect(join.ok).toBe(true);
    if (join.ok) expect(join.yjsSkipped).toBe(true);

    // Read of a single doc is allowed.
    const fetched = await emitWithAck<{ ok: boolean }>(c, 'yjs:fetch', {
      projectId: project.id,
      fileId: file.id,
    });
    expect(fetched.ok).toBe(true);

    // Writing is refused.
    const doc = new Y.Doc();
    doc.getText(TEXT_KEY).insert(0, 'nope');
    const update = Y.encodeStateAsUpdate(doc);
    doc.destroy();
    const ack = await emitWithAck<{ ok: false; error: string } | { ok: true }>(c, 'yjs:update', {
      projectId: project.id,
      fileId: file.id,
      update: Array.from(update),
    });
    expect(ack.ok).toBe(false);
    if (ack.ok === false) expect(ack.error).toBe('forbidden');
  });
});

describe('web ↔ plugin instant sync', () => {
  it('propagates a web (JWT, EDITOR) edit to a plugin (API key) peer', async () => {
    const { userId: ownerId, plainKey: ownerKey } = await bootstrapUserAndKey('sync-owner');
    const project = await createProject(ownerId);
    const file = await testPrisma.vaultFile.create({
      data: {
        projectId: project.id,
        path: 'shared-live.md',
        fileType: 'TEXT',
        contentHash: 'init',
        size: BigInt(0),
      },
    });

    // Plugin peer (API key) joins the room and listens.
    const plugin = connect(ownerKey);
    // Web peer (session JWT, EDITOR) joins with catch-up skipped.
    const web = await bootstrapMember('web-editor', project.id, 'EDITOR', ownerId);
    const browser = connectWithToken(web.token);
    await Promise.all([
      new Promise<void>((r) => plugin.on('connect', () => r())),
      new Promise<void>((r) => browser.on('connect', () => r())),
    ]);
    await emitWithAck(plugin, 'project:join', { projectId: project.id });
    await emitWithAck(browser, 'project:join', { projectId: project.id, skipYjsCatchup: true });

    const received = new Promise<{ fileId: string; update: number[] }>((resolve) => {
      plugin.once('yjs:update', (data) => resolve(data as never));
    });

    // Browser edits via the same CRDT channel.
    const doc = new Y.Doc();
    doc.getText(TEXT_KEY).insert(0, 'typed in the browser');
    const update = Y.encodeStateAsUpdate(doc);
    doc.destroy();

    const ack = await emitWithAck<{ ok: true; changed: boolean }>(browser, 'yjs:update', {
      projectId: project.id,
      fileId: file.id,
      update: Array.from(update),
    });
    expect(ack.ok).toBe(true);

    const msg = await received;
    expect(msg.fileId).toBe(file.id);
    const replica = new Y.Doc();
    Y.applyUpdate(replica, Uint8Array.from(msg.update));
    expect(replica.getText(TEXT_KEY).toString()).toBe('typed in the browser');
    replica.destroy();
  });
});

/** Wait for the next `event` on `socket`, or the next one `pick` accepts. */
function nextEvent<T>(
  socket: ClientSocket,
  event: string,
  pick?: (data: T) => boolean,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`no ${event} broadcast`));
    }, 5000);
    function onEvent(data: T) {
      if (pick && !pick(data)) return;
      clearTimeout(timer);
      socket.off(event, onEvent);
      resolve(data);
    }
    socket.on(event, onEvent);
  });
}

/** Owner A and editor B of one project, both connected and in the room. */
async function twoMembersInRoom() {
  const { userId: aId, plainKey: aKey } = await bootstrapUserAndKey('A');
  const project = await createProject(aId);
  const { userId: bId, plainKey: bKey } = await bootstrapUserAndKey('B');
  await testPrisma.projectMember.create({
    data: { projectId: project.id, userId: bId, role: 'EDITOR', addedById: aId },
  });
  const a = connect(aKey);
  const b = connect(bKey);
  await Promise.all([
    new Promise<void>((r) => a.on('connect', () => r())),
    new Promise<void>((r) => b.on('connect', () => r())),
  ]);
  await emitWithAck(a, 'project:join', { projectId: project.id });
  await emitWithAck(b, 'project:join', { projectId: project.id });
  return { projectId: project.id, a, b };
}

type FileEventPayload = {
  clientId?: string;
  fileId?: string;
  newPath?: string;
  requestedPath?: string;
  revived?: boolean;
  viaRest?: boolean;
  result?: { outcome?: { fileId?: string } };
};

describe('file:* broadcasts (contract with the plugin)', () => {
  it('carry the author clientId on every event, to the sender as well', async () => {
    // A client recognises its own operation coming back by `clientId` (e.g. the
    // intermediate steps of its offline rename chain) and must not apply it over
    // a newer local state. Without the field it can't tell.
    const { projectId, a, b } = await twoMembersInRoom();
    const envelope = { projectId, clientId: 'client-A' };

    const created = Promise.all([
      nextEvent<FileEventPayload>(b, 'file:created'),
      nextEvent<FileEventPayload>(a, 'file:created'),
    ]);
    const ack = await emitWithAck<{ ok: true; outcome: { fileId: string } }>(a, 'file:create', {
      ...envelope,
      filePath: 'pic.png',
      fileType: 'BINARY',
      contentHash: 'h1',
      size: 3,
      data: [1, 2, 3],
    });
    const fileId = ack.outcome.fileId;
    for (const e of await created) {
      expect(e.clientId).toBe('client-A');
      expect(e.result?.outcome?.fileId).toBe(fileId);
      expect(e.revived).toBe(false);
    }

    const updated = nextEvent<FileEventPayload>(b, 'file:updated-binary');
    await emitWithAck(a, 'file:update-binary', {
      ...envelope,
      fileId,
      contentHash: 'h2',
      size: 2,
      data: [4, 5],
    });
    expect((await updated).clientId).toBe('client-A');

    const renamed = nextEvent<FileEventPayload>(b, 'file:renamed');
    await emitWithAck(a, 'file:rename', {
      ...envelope,
      fileId,
      filePath: 'pic.png',
      newPath: 'pic-2.png',
    });
    expect(await renamed).toMatchObject({ clientId: 'client-A', newPath: 'pic-2.png' });

    const moved = nextEvent<FileEventPayload>(b, 'file:moved');
    await emitWithAck(a, 'file:move', {
      ...envelope,
      fileId,
      filePath: 'pic-2.png',
      newPath: 'img/pic-2.png',
    });
    expect(await moved).toMatchObject({ clientId: 'client-A', newPath: 'img/pic-2.png' });

    const deleted = nextEvent<FileEventPayload>(b, 'file:deleted');
    await emitWithAck(a, 'file:delete', { ...envelope, fileId, filePath: 'img/pic-2.png' });
    expect(await deleted).toMatchObject({ clientId: 'client-A', fileId });
  });

  it('file:update-binary of a note ("Keep local", plugin 0.3.x) goes into its Y.Doc and out as Yjs', async () => {
    // A 0.3.x plugin answers "Keep local" in the content-conflict modal of a note
    // by uploading its bytes as a binary update. The server wrote the bytes and
    // the hash only: the Y.Doc kept the old text, every client (and the next
    // snapshot) put it back, and `file:updated-binary` sent every device to
    // download the note and ask again. Now it is REST PUT's path: the text goes
    // into the doc, the history extended, and out as `yjs:update`.
    const { projectId, a, b } = await twoMembersInRoom();
    const seeded = nextEvent<{ fileId: string; update: number[] }>(b, 'yjs:update');
    const created = await emitWithAck<{ ok: true; outcome: { fileId: string } }>(a, 'file:create', {
      projectId,
      clientId: 'client-A',
      filePath: 'a.md',
      fileType: 'TEXT',
      contentHash: sha256OfBuffer(Buffer.from('old\n')),
      size: 4,
      data: Array.from(Buffer.from('old\n')),
    });
    const fileId = created.outcome.fileId;
    // B holds the note's history and edits it; the server merges the edit.
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Uint8Array.from((await seeded).update));
    const sv = Y.encodeStateVector(peer);
    peer.getText(TEXT_KEY).insert(4, 'mine\n');
    const editReachedA = nextEvent(a, 'yjs:update');
    await emitWithAck(b, 'yjs:update', {
      projectId,
      fileId,
      update: Array.from(Y.encodeStateAsUpdate(peer, sv)),
    });
    await editReachedA;

    const binaryEvents: string[] = [];
    for (const [name, socket] of [
      ['A', a],
      ['B', b],
    ] as const) {
      socket.on('file:updated-binary', () => binaryEvents.push(name));
    }
    const toB = nextEvent<{ fileId: string; update: number[] }>(
      b,
      'yjs:update',
      (m) => m.fileId === fileId,
    );
    const toSender = nextEvent<{ fileId: string; update: number[] }>(
      a,
      'yjs:update',
      (m) => m.fileId === fileId,
    );
    // What the sender sees, and in which order: the ack is recorded in its
    // callback, as the packet arrives, not after an `await`.
    const atSender: string[] = [];
    a.on('yjs:update', (m: { fileId: string }) => {
      if (m.fileId === fileId) atSender.push('yjs:update');
    });

    // "Keep local": the plugin stages the bytes and sends the metadata only.
    const local = Buffer.from('old\nlocal\n');
    const contentHash = sha256OfBuffer(local);
    await writeStagedBlob(projectId, contentHash, local);
    const ack = await new Promise<{ ok: boolean; outcome?: unknown }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ack timeout')), 5000);
      a.emit(
        'file:update-binary',
        {
          projectId,
          clientId: 'client-A',
          vectorClock: { 'client-A': 2 },
          fileId,
          contentHash,
          size: local.byteLength,
        },
        (res: { ok: boolean; outcome?: unknown }) => {
          clearTimeout(timer);
          atSender.push('ack');
          resolve(res);
        },
      );
    });
    // A plain success: a 0.3.x queue drops the entry instead of sending it again.
    expect(ack).toEqual({ ok: true, outcome: { kind: 'updated', fileId } });
    // The doc state reaches the sender before the ack: its doc holds the kept
    // text before the plugin, done with the conflict, folds the disk into it.
    // The ack first, and a fold in between would edit a doc that still has the
    // old text (see docs/sync-protocol.md, "UPDATE текстового файла").
    expect(atSender).toEqual(['yjs:update', 'ack']);

    // Bytes, hash, Y.Doc and the version history agree on the kept text.
    const row = await testPrisma.vaultFile.findUniqueOrThrow({ where: { id: fileId } });
    expect(row.contentHash).toBe(contentHash);
    expect((await readProjectFile(projectId, 'a.md')).toString('utf8')).toBe('old\nlocal\n');
    const stored = await testPrisma.yjsDocument.findUniqueOrThrow({ where: { fileId } });
    const server = new Y.Doc();
    Y.applyUpdate(server, new Uint8Array(stored.state));
    expect(server.getText(TEXT_KEY).toString()).toBe('old\nlocal\n');
    const version = await testPrisma.fileVersion.findFirstOrThrow({
      where: { fileId },
      orderBy: { versionNumber: 'desc' },
    });
    expect(version.contentHash).toBe(contentHash);

    // The peer, holding the old history, takes the text through Yjs and
    // converges to exactly it: the old text's deletion is in the history.
    Y.applyUpdate(peer, Uint8Array.from((await toB).update));
    expect(peer.getText(TEXT_KEY).toString()).toBe('old\nlocal\n');
    // The sender gets it too, so its doc drops the old text before it folds.
    const senderDoc = new Y.Doc();
    Y.applyUpdate(senderDoc, Uint8Array.from((await toSender).update));
    expect(senderDoc.getText(TEXT_KEY).toString()).toBe('old\nlocal\n');

    // The peer pushes whatever the server lacks: the note stays the kept text.
    await emitWithAck(b, 'yjs:update', {
      projectId,
      fileId,
      update: Array.from(Y.encodeStateAsUpdate(peer, new Uint8Array(stored.stateVector))),
    });
    const after = await testPrisma.yjsDocument.findUniqueOrThrow({ where: { fileId } });
    const merged = new Y.Doc();
    Y.applyUpdate(merged, new Uint8Array(after.state));
    expect(merged.getText(TEXT_KEY).toString()).toBe('old\nlocal\n');

    // No `file:updated-binary` for a note, to anyone: each broadcast went out
    // before the ack, and B's round trip above came after it.
    expect(binaryEvents).toEqual([]);

    // A device that was away gets the kept text from the Yjs catch-up; the
    // journal row of the update is not in the operations catch-up.
    for (const flag of [{}, { operationsCatchup: FULL_CATCHUP_VERSION }]) {
      const joined = await emitWithAck<{
        operations: { opType: string }[];
        yjsDocs: { fileId: string; sync1: number[] }[];
      }>(b, 'project:join', { projectId, sinceVectorClock: {}, ...flag });
      expect(joined.operations.map((o) => o.opType)).toEqual(['CREATE']);
      const fresh = new Y.Doc();
      const snapshot = joined.yjsDocs.find((d) => d.fileId === fileId);
      Y.applyUpdate(fresh, Uint8Array.from(snapshot?.sync1 ?? []));
      expect(fresh.getText(TEXT_KEY).toString()).toBe('old\nlocal\n');
    }
  });

  it('file:update-binary of a deleted note: a plain no_op ack, nothing sent, the doc as it was', async () => {
    // A 0.3.x queue can still hold a "Keep local" of a note deleted since. The
    // ack must be a success, or the queue sends it again on every reconnect.
    const { projectId, a, b } = await twoMembersInRoom();
    const created = await emitWithAck<{ ok: true; outcome: { fileId: string } }>(a, 'file:create', {
      projectId,
      clientId: 'client-A',
      filePath: 'gone.md',
      fileType: 'TEXT',
      contentHash: 'h-old',
      size: 4,
      data: Array.from(Buffer.from('old\n')),
    });
    const fileId = created.outcome.fileId;
    await emitWithAck(a, 'file:delete', {
      projectId,
      clientId: 'client-A',
      fileId,
      filePath: 'gone.md',
    });

    const sent: string[] = [];
    b.on('file:updated-binary', () => sent.push('file:updated-binary'));
    b.on('yjs:update', (m: { fileId: string }) => {
      if (m.fileId === fileId) sent.push('yjs:update');
    });
    const ack = await emitWithAck<{ ok: boolean; outcome?: unknown }>(a, 'file:update-binary', {
      projectId,
      clientId: 'client-A',
      fileId,
      contentHash: 'h-local',
      size: 6,
      data: Array.from(Buffer.from('local\n')),
    });
    expect(ack).toEqual({ ok: true, outcome: { kind: 'no_op', reason: 'tombstone' } });

    const stored = await testPrisma.yjsDocument.findUniqueOrThrow({ where: { fileId } });
    const doc = new Y.Doc();
    Y.applyUpdate(doc, new Uint8Array(stored.state));
    expect(doc.getText(TEXT_KEY).toString()).toBe('old\n');
    // B's round trip comes after anything sent before A's ack.
    await emitWithAck(b, 'yjs:fetch', { projectId, fileId });
    expect(sent).toEqual([]);
  });

  it('file:renamed after a conflict rename carries the stored path, the request as requestedPath', async () => {
    // The server sends a rename onto a taken name to `<path>.conflict-<clientId>`.
    // Broadcasting the requested name moved every client's copy onto the file
    // that won the name, and the vaults diverged from the server.
    const { projectId, a, b } = await twoMembersInRoom();
    const create = (filePath: string, text: string) =>
      emitWithAck<{ ok: true; outcome: { fileId: string } }>(a, 'file:create', {
        projectId,
        clientId: 'client-A',
        filePath,
        fileType: 'TEXT',
        contentHash: `h-${filePath}`,
        size: text.length,
        data: Array.from(Buffer.from(text)),
      });
    const moving = await create('a.md', 'a\n');
    await create('target.md', 'target\n');

    const toB = nextEvent<FileEventPayload>(b, 'file:renamed');
    const toSender = nextEvent<FileEventPayload>(a, 'file:renamed');
    const ack = await emitWithAck<{ ok: true; outcome: { kind: string; finalPath: string } }>(
      a,
      'file:rename',
      {
        projectId,
        clientId: 'client-A',
        fileId: moving.outcome.fileId,
        filePath: 'a.md',
        newPath: 'target.md',
      },
    );
    expect(ack.outcome).toMatchObject({
      kind: 'conflict_create_renamed',
      finalPath: 'target.conflict-client-A.md',
    });

    const row = await testPrisma.vaultFile.findUniqueOrThrow({
      where: { id: moving.outcome.fileId },
    });
    expect(row.path).toBe('target.conflict-client-A.md');
    for (const e of [await toB, await toSender]) {
      expect(e).toMatchObject({
        fileId: moving.outcome.fileId,
        newPath: 'target.conflict-client-A.md',
        requestedPath: 'target.md',
        clientId: 'client-A',
      });
    }
  });

  it('file:moved carries the normalized path the server stored', async () => {
    const { projectId, a, b } = await twoMembersInRoom();
    const created = await emitWithAck<{ ok: true; outcome: { fileId: string } }>(a, 'file:create', {
      projectId,
      clientId: 'client-A',
      filePath: 'n.md',
      fileType: 'TEXT',
      contentHash: 'h',
      size: 2,
      data: Array.from(Buffer.from('n\n')),
    });
    const moved = nextEvent<FileEventPayload>(b, 'file:moved');
    await emitWithAck(a, 'file:move', {
      projectId,
      clientId: 'client-A',
      fileId: created.outcome.fileId,
      filePath: 'n.md',
      newPath: 'dir//n.md',
    });
    expect(await moved).toMatchObject({ newPath: 'dir/n.md', requestedPath: 'dir//n.md' });
  });

  it('CREATE on a tombstone: a peer holding the old history converges to exactly the new text', async () => {
    // The note is deleted and created again under the same name ("Untitled").
    // The server revives the same fileId; a peer that still holds the note's old
    // history (online 0.3.7, or an offline device on its catch-up) merges the
    // state the server broadcasts. With the history replaced by buildInitialState
    // the peer got "old text + new text" and sent it back to everyone.
    const { projectId, a, b } = await twoMembersInRoom();
    const OLD = 'old text\n';
    const NEW = 'new note\n';
    const createUntitled = (text: string, hash: string) =>
      emitWithAck<{ ok: true; outcome: { fileId: string } }>(a, 'file:create', {
        projectId,
        clientId: 'client-A',
        filePath: 'Untitled.md',
        fileType: 'TEXT',
        contentHash: hash,
        size: text.length,
        data: Array.from(Buffer.from(text)),
      });

    const seeded = nextEvent<{ fileId: string; update: number[] }>(b, 'yjs:update');
    const first = await createUntitled(OLD, 'h-old');
    const fileId = first.outcome.fileId;
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Uint8Array.from((await seeded).update));

    // B edits the note; the server merges the edit into the history.
    const sv = Y.encodeStateVector(peer);
    peer.getText(TEXT_KEY).insert(OLD.length, 'edit\n');
    await emitWithAck(b, 'yjs:update', {
      projectId,
      fileId,
      update: Array.from(Y.encodeStateAsUpdate(peer, sv)),
    });

    const deleted = nextEvent<FileEventPayload>(b, 'file:deleted');
    await emitWithAck(a, 'file:delete', {
      projectId,
      clientId: 'client-A',
      fileId,
      filePath: 'Untitled.md',
    });
    await deleted;

    const revivedState = nextEvent<{ fileId: string; update: number[] }>(
      b,
      'yjs:update',
      (m) => m.fileId === fileId,
    );
    const revivedEvent = nextEvent<FileEventPayload>(b, 'file:created');
    const again = await createUntitled(NEW, 'h-new');
    expect(again.outcome.fileId).toBe(fileId);
    expect(await revivedEvent).toMatchObject({ revived: true, clientId: 'client-A' });

    Y.applyUpdate(peer, Uint8Array.from((await revivedState).update));
    expect(peer.getText(TEXT_KEY).toString()).toBe(NEW);

    // The peer pushes whatever the server lacks; the note stays the new text.
    const row = await testPrisma.yjsDocument.findUniqueOrThrow({ where: { fileId } });
    await emitWithAck(b, 'yjs:update', {
      projectId,
      fileId,
      update: Array.from(Y.encodeStateAsUpdate(peer, new Uint8Array(row.stateVector))),
    });
    const stored = await testPrisma.yjsDocument.findUniqueOrThrow({ where: { fileId } });
    const server = new Y.Doc();
    Y.applyUpdate(server, new Uint8Array(stored.state));
    expect(server.getText(TEXT_KEY).toString()).toBe(NEW);
  });

  it('file:created from the REST bridge carries revived, like the socket event', async () => {
    // MCP write_note on the path of a deleted note: the server revives the id
    // with its history extended and logs `revived: true`. The bridge sent a
    // `result` without the log, so the live event lost the marker, and a client
    // deciding by it took the new server for one that replaced the history.
    const { projectId, a } = await twoMembersInRoom();
    const { ownerId } = await testPrisma.project.findUniqueOrThrow({ where: { id: projectId } });
    const restCreate = (text: string) =>
      applyRestOperation({
        projectId,
        userId: ownerId,
        op: {
          opType: 'CREATE',
          filePath: 'Untitled.md',
          payload: {
            fileType: 'TEXT',
            contentHash: sha256OfBuffer(Buffer.from(text)),
            size: Buffer.byteLength(text),
          },
          data: Buffer.from(text),
        },
      });
    // What the socket process does with the channel notification the web
    // process published for this write.
    const relayed = async (result: ApplyResult) => {
      const outcome = result.outcome as { fileId: string; path: string };
      const event = nextEvent<FileEventPayload>(a, 'file:created');
      await relay(io, {
        projectId,
        logId: result.log.id,
        event: 'file:created',
        clientId: `rest:${ownerId}`,
        fileId: outcome.fileId,
        path: outcome.path,
      });
      return event;
    };

    const first = await restCreate('old text\n');
    const fileId = (first.outcome as { fileId: string }).fileId;
    expect(await relayed(first)).toMatchObject({ revived: false, viaRest: true });

    await applyRestOperation({
      projectId,
      userId: ownerId,
      op: { opType: 'DELETE', filePath: 'Untitled.md', payload: { fileId } },
    });
    const again = await restCreate('new note\n');
    expect(again.outcome).toMatchObject({ kind: 'created', fileId });
    expect(again.log.payload).toMatchObject({ revived: true });
    expect(await relayed(again)).toMatchObject({
      revived: true,
      viaRest: true,
      clientId: `rest:${ownerId}`,
      result: { outcome: { fileId } },
    });
  });
});
