import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { applyYjsUpdate, TEXT_KEY } from '@/lib/crdt/persistence';
import {
  appendConflictSuffix,
  applyOperation,
  listOperationsSince,
} from '@/lib/sync/operation-log';
import { increment } from '@/lib/sync/vector-clock';
import { resetDatabase, testPrisma } from '../db';

let storageRoot: string;
let originalStoragePath: string | undefined;

beforeAll(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), 'osync-oplog-'));
  originalStoragePath = process.env.STORAGE_PATH;
  process.env.STORAGE_PATH = storageRoot;
});

afterAll(async () => {
  if (originalStoragePath !== undefined) {
    process.env.STORAGE_PATH = originalStoragePath;
  } else {
    delete process.env.STORAGE_PATH;
  }
  await rm(storageRoot, { recursive: true, force: true });
  await testPrisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase();
});

async function seedProject() {
  const owner = await testPrisma.user.create({
    data: {
      email: `o-${Date.now()}-${Math.random()}@x.test`,
      passwordHash: 'h',
      name: 'O',
    },
  });
  const project = await testPrisma.project.create({
    data: {
      slug: `s-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: 'P',
      ownerId: owner.id,
      members: { create: { userId: owner.id, role: 'ADMIN', addedById: owner.id } },
    },
  });
  return { ownerId: owner.id, projectId: project.id };
}

describe('appendConflictSuffix', () => {
  it('inserts the suffix before the last dot', () => {
    expect(appendConflictSuffix('note.md', 'A1')).toBe('note.conflict-A1.md');
    expect(appendConflictSuffix('a/b/note.md', 'A1')).toBe('a/b/note.conflict-A1.md');
  });
  it('appends if no extension', () => {
    expect(appendConflictSuffix('readme', 'A1')).toBe('readme.conflict-A1');
  });
  it('sanitizes weird clientIds', () => {
    expect(appendConflictSuffix('note.md', 'a/b c<>')).toBe('note.conflict-a_b_c__.md');
  });
});

describe('applyOperation: CREATE', () => {
  it('creates a file and writes content', async () => {
    const { projectId, ownerId } = await seedProject();
    const result = await applyOperation(
      {
        projectId,
        authorId: ownerId,
        clientId: 'client-A',
        vectorClock: { 'client-A': 1 },
      },
      {
        opType: 'CREATE',
        filePath: 'note.md',
        payload: { fileType: 'TEXT', contentHash: 'h1', size: 5 },
        data: Buffer.from('hello'),
      },
    );
    expect(result.outcome.kind).toBe('created');
    const file = await testPrisma.vaultFile.findFirst({ where: { projectId } });
    expect(file?.path).toBe('note.md');
  });

  it('revives a soft-deleted row at the same path instead of hitting the unique constraint', async () => {
    const { projectId, ownerId } = await seedProject();
    // First CREATE — file is created at note.md.
    const first = await applyOperation(
      { projectId, authorId: ownerId, clientId: 'A', vectorClock: { A: 1 } },
      {
        opType: 'CREATE',
        filePath: 'note.md',
        payload: { fileType: 'TEXT', contentHash: 'h1', size: 5 },
        data: Buffer.from('hello'),
      },
    );
    if (first.outcome.kind !== 'created') throw new Error('expected created');
    const originalId = first.outcome.fileId;

    // Delete it — leaves a tombstone at note.md.
    await applyOperation(
      { projectId, authorId: ownerId, clientId: 'A', vectorClock: { A: 2 } },
      { opType: 'DELETE', filePath: 'note.md', payload: { fileId: originalId } },
    );

    // CREATE again — without the tombstone-revive fix this throws the
    // `@@unique([projectId, path])` violation and leaves the client
    // stuck queueing the op on every retry.
    const second = await applyOperation(
      { projectId, authorId: ownerId, clientId: 'A', vectorClock: { A: 3 } },
      {
        opType: 'CREATE',
        filePath: 'note.md',
        payload: { fileType: 'TEXT', contentHash: 'h2', size: 6 },
        data: Buffer.from('reborn'),
      },
    );
    expect(second.outcome.kind).toBe('created');

    // Exactly one live row at this path, content matches the new CREATE.
    const live = await testPrisma.vaultFile.findMany({
      where: { projectId, path: 'note.md', deletedAt: null },
    });
    expect(live).toHaveLength(1);
    expect(live[0]?.contentHash).toBe('h2');
    expect(live[0]?.size).toBe(6n);
  });

  it('renames into .conflict-<clientId>.<ext> when path is taken', async () => {
    const { projectId, ownerId } = await seedProject();
    await applyOperation(
      {
        projectId,
        authorId: ownerId,
        clientId: 'client-A',
        vectorClock: { 'client-A': 1 },
      },
      {
        opType: 'CREATE',
        filePath: 'collide.md',
        payload: { fileType: 'TEXT', contentHash: 'h1', size: 1 },
        data: Buffer.from('a'),
      },
    );

    const result = await applyOperation(
      {
        projectId,
        authorId: ownerId,
        clientId: 'client-B',
        vectorClock: { 'client-B': 1 },
      },
      {
        opType: 'CREATE',
        filePath: 'collide.md',
        payload: { fileType: 'TEXT', contentHash: 'h2', size: 1 },
        data: Buffer.from('b'),
      },
    );

    expect(result.outcome.kind).toBe('conflict_create_renamed');
    if (result.outcome.kind === 'conflict_create_renamed') {
      expect(result.outcome.finalPath).toBe('collide.conflict-client-B.md');
    }
    const files = await testPrisma.vaultFile.findMany({
      where: { projectId },
      orderBy: { path: 'asc' },
    });
    expect(files.map((f) => f.path)).toEqual(['collide.conflict-client-B.md', 'collide.md']);
  });

  it('idempotently re-applies a conflict CREATE retried by the same client', async () => {
    // The same client retrying a CREATE for a still-diverged path (e.g. a
    // queued op replayed on reconnect) must NOT collide on the unique
    // constraint at the already-materialised `.conflict-<clientId>` path —
    // that left the client stuck retrying forever (and orphaning REST-staged
    // blobs). The retry idempotently refreshes the existing conflict copy.
    const { projectId, ownerId } = await seedProject();
    await applyOperation(
      { projectId, authorId: ownerId, clientId: 'client-A', vectorClock: { 'client-A': 1 } },
      {
        opType: 'CREATE',
        filePath: 'collide.md',
        payload: { fileType: 'TEXT', contentHash: 'h1', size: 1 },
        data: Buffer.from('a'),
      },
    );
    const makeConflict = () =>
      applyOperation(
        { projectId, authorId: ownerId, clientId: 'client-B', vectorClock: { 'client-B': 1 } },
        {
          opType: 'CREATE',
          filePath: 'collide.md',
          payload: { fileType: 'TEXT', contentHash: 'h2', size: 1 },
          data: Buffer.from('b'),
        },
      );

    const first = await makeConflict();
    expect(first.outcome.kind).toBe('conflict_create_renamed');

    // The retry must not throw (was: Unique constraint failed on (projectId, path)).
    const retry = await makeConflict();
    expect(retry.outcome.kind).toBe('conflict_create_renamed');
    if (retry.outcome.kind === 'conflict_create_renamed') {
      expect(retry.outcome.finalPath).toBe('collide.conflict-client-B.md');
    }

    // Still exactly two files — no duplicate conflict copy, no crash.
    const files = await testPrisma.vaultFile.findMany({
      where: { projectId },
      orderBy: { path: 'asc' },
    });
    expect(files.map((f) => f.path)).toEqual(['collide.conflict-client-B.md', 'collide.md']);
  });
});

/**
 * CREATE on a path that holds a tombstone brings back the SAME fileId. Its Y.Doc
 * history must be extended (old text deleted, new text inserted on top), not
 * replaced by an independent `buildInitialState` doc: a device that was away
 * while the note was deleted and re-created ("Untitled", a template, restore
 * from trash) still holds the old history under that id, and merging two
 * independent histories of one note sends the duplicated text to the whole team
 * (review 0.3.8, lens "upgrade" #1 / "engine" #4).
 */
describe('applyOperation: CREATE on a tombstone extends the Y.Doc history', () => {
  const OLD = 'Old line one\nOld line two\n';
  const NEW = 'Brand new note\n';

  async function storedState(fileId: string): Promise<Uint8Array> {
    const row = await testPrisma.yjsDocument.findUniqueOrThrow({ where: { fileId } });
    return new Uint8Array(row.state);
  }

  function textOf(state: Uint8Array): string {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    const text = doc.getText(TEXT_KEY).toString();
    doc.destroy();
    return text;
  }

  /**
   * A synced note `a.md` and a device holding its history, including an edit the
   * device made and the server merged — the doc y-indexeddb keeps on the device.
   */
  async function noteWithDeviceHistory(projectId: string, ownerId: string) {
    const created = await applyOperation(
      { projectId, authorId: ownerId, clientId: 'A', vectorClock: { A: 1 } },
      {
        opType: 'CREATE',
        filePath: 'a.md',
        payload: { fileType: 'TEXT', contentHash: 'h-old', size: OLD.length },
        data: Buffer.from(OLD),
      },
    );
    if (created.outcome.kind !== 'created') throw new Error('expected created');
    const fileId = created.outcome.fileId;

    const device = new Y.Doc();
    Y.applyUpdate(device, await storedState(fileId));
    const before = Y.encodeStateVector(device);
    device.getText(TEXT_KEY).insert(OLD.length, 'edit\n');
    await applyYjsUpdate({
      fileId,
      update: Y.encodeStateAsUpdate(device, before),
      authorId: ownerId,
    });
    expect(textOf(await storedState(fileId))).toBe(`${OLD}edit\n`);
    return { fileId, device };
  }

  it('a device holding the pre-delete history converges to exactly the new text', async () => {
    const { projectId, ownerId } = await seedProject();
    const { fileId, device } = await noteWithDeviceHistory(projectId, ownerId);

    // The device is closed. A teammate deletes a.md, then creates a new a.md.
    await applyOperation(
      { projectId, authorId: ownerId, clientId: 'B', vectorClock: { B: 1 } },
      { opType: 'DELETE', filePath: 'a.md', payload: { fileId } },
    );
    const revived = await applyOperation(
      { projectId, authorId: ownerId, clientId: 'B', vectorClock: { B: 2 } },
      {
        opType: 'CREATE',
        filePath: 'a.md',
        payload: { fileType: 'TEXT', contentHash: 'h-new', size: NEW.length },
        data: Buffer.from(NEW),
      },
    );
    expect(revived.outcome).toEqual({ kind: 'created', fileId, path: 'a.md' });
    expect(revived.log.payload).toMatchObject({ fileId, revived: true });

    // The device comes back: catch-up applies the server's state to its doc,
    // then the device pushes what the server lacks by its state vector.
    const serverState = await storedState(fileId);
    expect(textOf(serverState)).toBe(NEW);
    Y.applyUpdate(device, serverState);
    expect(device.getText(TEXT_KEY).toString()).toBe(NEW);

    const serverVector = new Uint8Array(
      (await testPrisma.yjsDocument.findUniqueOrThrow({ where: { fileId } })).stateVector,
    );
    await applyYjsUpdate({
      fileId,
      update: Y.encodeStateAsUpdate(device, serverVector),
      authorId: ownerId,
    });
    // Was "Brand new note\nOld line one\nOld line two\nedit\n" (or the reverse)
    // for the whole team with the history replaced by buildInitialState.
    expect(textOf(await storedState(fileId))).toBe(NEW);
  });

  it('restoring the same text (from the trash) does not double it', async () => {
    const { projectId, ownerId } = await seedProject();
    const { fileId, device } = await noteWithDeviceHistory(projectId, ownerId);
    const same = `${OLD}edit\n`;

    await applyOperation(
      { projectId, authorId: ownerId, clientId: 'B', vectorClock: { B: 1 } },
      { opType: 'DELETE', filePath: 'a.md', payload: { fileId } },
    );
    await applyOperation(
      { projectId, authorId: ownerId, clientId: 'B', vectorClock: { B: 2 } },
      {
        opType: 'CREATE',
        filePath: 'a.md',
        payload: { fileType: 'TEXT', contentHash: 'h-same', size: same.length },
        data: Buffer.from(same),
      },
    );

    Y.applyUpdate(device, await storedState(fileId));
    expect(device.getText(TEXT_KEY).toString()).toBe(same);
    expect(textOf(await storedState(fileId))).toBe(same);
  });

  it('a tombstone without a stored Y.Doc gets a fresh one with the new text', async () => {
    const { projectId, ownerId } = await seedProject();
    const created = await applyOperation(
      { projectId, authorId: ownerId, clientId: 'A', vectorClock: { A: 1 } },
      {
        opType: 'CREATE',
        filePath: 'a.md',
        payload: { fileType: 'TEXT', contentHash: 'h-old', size: OLD.length },
        data: Buffer.from(OLD),
      },
    );
    if (created.outcome.kind !== 'created') throw new Error('expected created');
    const fileId = created.outcome.fileId;
    await applyOperation(
      { projectId, authorId: ownerId, clientId: 'A', vectorClock: { A: 2 } },
      { opType: 'DELETE', filePath: 'a.md', payload: { fileId } },
    );
    await testPrisma.yjsDocument.delete({ where: { fileId } });

    await applyOperation(
      { projectId, authorId: ownerId, clientId: 'A', vectorClock: { A: 3 } },
      {
        opType: 'CREATE',
        filePath: 'a.md',
        payload: { fileType: 'TEXT', contentHash: 'h-new', size: NEW.length },
        data: Buffer.from(NEW),
      },
    );
    expect(textOf(await storedState(fileId))).toBe(NEW);
  });

  it('a retried conflict CREATE with new content extends the conflict copy history', async () => {
    // The same client re-sends a CREATE for a path still held by another file:
    // the row at `<path>.conflict-<clientId>` is live and keeps its id, and
    // clients already hold its first history (the server broadcast it).
    const { projectId, ownerId } = await seedProject();
    await applyOperation(
      { projectId, authorId: ownerId, clientId: 'client-A', vectorClock: { 'client-A': 1 } },
      {
        opType: 'CREATE',
        filePath: 'collide.md',
        payload: { fileType: 'TEXT', contentHash: 'h1', size: 1 },
        data: Buffer.from('a'),
      },
    );
    const conflictCreate = (text: string, hash: string, n: number) =>
      applyOperation(
        { projectId, authorId: ownerId, clientId: 'client-B', vectorClock: { 'client-B': n } },
        {
          opType: 'CREATE',
          filePath: 'collide.md',
          payload: { fileType: 'TEXT', contentHash: hash, size: text.length },
          data: Buffer.from(text),
        },
      );

    const first = await conflictCreate('mine v1\n', 'h2', 1);
    if (first.outcome.kind !== 'conflict_create_renamed') throw new Error('expected conflict');
    const copyId = first.outcome.fileId;
    const peer = new Y.Doc();
    Y.applyUpdate(peer, await storedState(copyId));
    expect(peer.getText(TEXT_KEY).toString()).toBe('mine v1\n');

    // Same content again: the stored history is left exactly as it was.
    const firstState = Buffer.from(await storedState(copyId));
    await conflictCreate('mine v1\n', 'h2', 2);
    expect(Buffer.from(await storedState(copyId)).equals(firstState)).toBe(true);

    // New content: the peer holding the first history ends up with it alone.
    const retry = await conflictCreate('mine v2\n', 'h3', 3);
    expect(retry.outcome).toMatchObject({ kind: 'conflict_create_renamed', fileId: copyId });
    expect(retry.log.payload).not.toHaveProperty('revived');
    Y.applyUpdate(peer, await storedState(copyId));
    expect(peer.getText(TEXT_KEY).toString()).toBe('mine v2\n');
  });

  it('a first CREATE is not marked revived', async () => {
    const { projectId, ownerId } = await seedProject();
    const created = await applyOperation(
      { projectId, authorId: ownerId, clientId: 'A', vectorClock: { A: 1 } },
      {
        opType: 'CREATE',
        filePath: 'fresh.md',
        payload: { fileType: 'TEXT', contentHash: 'h', size: NEW.length },
        data: Buffer.from(NEW),
      },
    );
    expect(created.log.payload).not.toHaveProperty('revived');
    if (created.outcome.kind !== 'created') throw new Error('expected created');
    expect(textOf(await storedState(created.outcome.fileId))).toBe(NEW);
  });
});

describe('applyOperation: DELETE > UPDATE', () => {
  it('UPDATE on a tombstoned file becomes a no_op', async () => {
    const { projectId, ownerId } = await seedProject();
    const create = await applyOperation(
      { projectId, authorId: ownerId, clientId: 'A', vectorClock: { A: 1 } },
      {
        opType: 'CREATE',
        filePath: 'doomed.md',
        payload: { fileType: 'TEXT', contentHash: 'h1', size: 1 },
        data: Buffer.from('a'),
      },
    );
    if (create.outcome.kind !== 'created') throw new Error('expected created');
    const fileId = create.outcome.fileId;

    // Concurrent: client A deletes, client B updates.
    await applyOperation(
      { projectId, authorId: ownerId, clientId: 'A', vectorClock: { A: 2 } },
      { opType: 'DELETE', filePath: 'doomed.md', payload: { fileId } },
    );
    const update = await applyOperation(
      { projectId, authorId: ownerId, clientId: 'B', vectorClock: { B: 1 } },
      {
        opType: 'UPDATE',
        filePath: 'doomed.md',
        payload: { fileId, contentHash: 'h2', size: 2 },
        data: Buffer.from('bb'),
      },
    );

    expect(update.outcome.kind).toBe('no_op');
    const reloaded = await testPrisma.vaultFile.findUnique({ where: { id: fileId } });
    expect(reloaded?.deletedAt).not.toBeNull();
    // Hash should NOT have advanced past h1.
    expect(reloaded?.contentHash).toBe('h1');
  });
});

describe('applyOperation: unknown file errors', () => {
  // The plugin's `ackToOutcome` treats `error.endsWith('_not_found')` as a
  // non-retryable failure. Returning a verbose `"<op> for unknown file: <id>"`
  // (the old message) classified as retryable and halted the whole offline
  // queue on a single dead-letter op — so this contract is load-bearing.
  it('UPDATE for a non-existent fileId throws file_not_found', async () => {
    const { projectId, ownerId } = await seedProject();
    await expect(
      applyOperation(
        { projectId, authorId: ownerId, clientId: 'A', vectorClock: { A: 1 } },
        {
          opType: 'UPDATE',
          filePath: 'gone.md',
          payload: { fileId: 'does-not-exist', contentHash: 'h', size: 1 },
          data: Buffer.from('x'),
        },
      ),
    ).rejects.toThrow('file_not_found');
  });

  it('DELETE for a non-existent fileId throws file_not_found', async () => {
    const { projectId, ownerId } = await seedProject();
    await expect(
      applyOperation(
        { projectId, authorId: ownerId, clientId: 'A', vectorClock: { A: 1 } },
        { opType: 'DELETE', filePath: 'gone.md', payload: { fileId: 'does-not-exist' } },
      ),
    ).rejects.toThrow('file_not_found');
  });

  it('RENAME for a non-existent fileId throws file_not_found', async () => {
    const { projectId, ownerId } = await seedProject();
    await expect(
      applyOperation(
        { projectId, authorId: ownerId, clientId: 'A', vectorClock: { A: 1 } },
        {
          opType: 'RENAME',
          filePath: 'old.md',
          newPath: 'new.md',
          payload: { fileId: 'does-not-exist' },
        },
      ),
    ).rejects.toThrow('file_not_found');
  });
});

describe('applyOperation: concurrent RENAME', () => {
  it('second RENAME to an occupied target is rerouted to a conflict path', async () => {
    const { projectId, ownerId } = await seedProject();

    const a = await applyOperation(
      { projectId, authorId: ownerId, clientId: 'A', vectorClock: { A: 1 } },
      {
        opType: 'CREATE',
        filePath: 'a.md',
        payload: { fileType: 'TEXT', contentHash: 'h', size: 1 },
        data: Buffer.from('a'),
      },
    );
    const b = await applyOperation(
      { projectId, authorId: ownerId, clientId: 'A', vectorClock: { A: 2 } },
      {
        opType: 'CREATE',
        filePath: 'b.md',
        payload: { fileType: 'TEXT', contentHash: 'h', size: 1 },
        data: Buffer.from('b'),
      },
    );
    const aId = (a.outcome as { fileId: string }).fileId;
    const bId = (b.outcome as { fileId: string }).fileId;

    // First rename: a.md → target.md  (succeeds normally)
    await applyOperation(
      { projectId, authorId: ownerId, clientId: 'A', vectorClock: { A: 3 } },
      { opType: 'RENAME', filePath: 'a.md', newPath: 'target.md', payload: { fileId: aId } },
    );

    // Concurrent: b.md → target.md (already taken) → reroute to conflict path.
    const second = await applyOperation(
      { projectId, authorId: ownerId, clientId: 'B', vectorClock: { B: 1 } },
      { opType: 'RENAME', filePath: 'b.md', newPath: 'target.md', payload: { fileId: bId } },
    );
    expect(second.outcome.kind).toBe('conflict_create_renamed');
    if (second.outcome.kind === 'conflict_create_renamed') {
      expect(second.outcome.finalPath).toBe('target.conflict-B.md');
    }
  });

  it('renames over a soft-deleted tombstone at the target path', async () => {
    const { projectId, ownerId } = await seedProject();

    const a = await applyOperation(
      { projectId, authorId: ownerId, clientId: 'A', vectorClock: { A: 1 } },
      {
        opType: 'CREATE',
        filePath: 'a.md',
        payload: { fileType: 'TEXT', contentHash: 'ha', size: 1 },
        data: Buffer.from('a'),
      },
    );
    const b = await applyOperation(
      { projectId, authorId: ownerId, clientId: 'A', vectorClock: { A: 2 } },
      {
        opType: 'CREATE',
        filePath: 'b.md',
        payload: { fileType: 'TEXT', contentHash: 'hb', size: 1 },
        data: Buffer.from('b'),
      },
    );
    const aId = (a.outcome as { fileId: string }).fileId;
    const bId = (b.outcome as { fileId: string }).fileId;

    // Soft-delete b.md → leaves a tombstone at b.md.
    await applyOperation(
      { projectId, authorId: ownerId, clientId: 'A', vectorClock: { A: 3 } },
      { opType: 'DELETE', filePath: 'b.md', payload: { fileId: bId } },
    );

    // Rename a.md → b.md. Without the tombstone-clearing fix this hits
    // the unique constraint (the tombstone's `[projectId, path]` row is
    // invisible to `findFirst({deletedAt:null})` but visible to the DB).
    const renamed = await applyOperation(
      { projectId, authorId: ownerId, clientId: 'A', vectorClock: { A: 4 } },
      { opType: 'RENAME', filePath: 'a.md', newPath: 'b.md', payload: { fileId: aId } },
    );
    expect(renamed.outcome.kind).toBe('renamed');

    const live = await testPrisma.vaultFile.findMany({
      where: { projectId, deletedAt: null },
      orderBy: { path: 'asc' },
    });
    expect(live.map((f) => f.path)).toEqual(['b.md']);
    expect(live[0]?.id).toBe(aId);
  });
});

describe('listOperationsSince', () => {
  it('returns only ops whose clock advances past the supplied vector', async () => {
    const { projectId, ownerId } = await seedProject();

    let clock = increment({}, 'A');
    await applyOperation(
      { projectId, authorId: ownerId, clientId: 'A', vectorClock: clock },
      {
        opType: 'CREATE',
        filePath: 'a.md',
        payload: { fileType: 'TEXT', contentHash: 'h', size: 1 },
        data: Buffer.from('a'),
      },
    );

    clock = increment(clock, 'A');
    await applyOperation(
      { projectId, authorId: ownerId, clientId: 'A', vectorClock: clock },
      {
        opType: 'CREATE',
        filePath: 'b.md',
        payload: { fileType: 'TEXT', contentHash: 'h', size: 1 },
        data: Buffer.from('b'),
      },
    );

    // From the perspective of a client that has already seen A:1 — they should still
    // pick up the second op (A:2).
    const ops = await listOperationsSince({ projectId, since: { A: 1 } });
    expect(ops.map((o) => o.filePath)).toEqual(['b.md']);

    // From a fresh perspective, they should pick up everything.
    const all = await listOperationsSince({ projectId, since: {} });
    expect(all.map((o) => o.filePath)).toEqual(['a.md', 'b.md']);
  });
});
