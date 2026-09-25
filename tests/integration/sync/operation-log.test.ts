import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
  it('numbers the next candidates after the sanitized id, even a long one', () => {
    expect(appendConflictSuffix('note.md', 'A1', 1)).toBe('note.conflict-A1.md');
    expect(appendConflictSuffix('note.md', 'A1', 2)).toBe('note.conflict-A1-2.md');
    expect(appendConflictSuffix('readme', 'A1', 3)).toBe('readme.conflict-A1-3');
    const long = 'x'.repeat(40);
    expect(appendConflictSuffix('n.md', long, 2)).toBe(`n.conflict-${'x'.repeat(32)}-2.md`);
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

  it('a second conflict CREATE with other content gets its own copy, the first is kept', async () => {
    // The same client sends another CREATE for a path still held by another
    // file. The live row at `<path>.conflict-<clientId>` is only this
    // operation's copy if it holds the same content (a retry after a lost ack);
    // with other content it is another note, and peers hold its history.
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

    // Same content again: the same copy, its stored history left exactly as it was.
    const firstState = Buffer.from(await storedState(copyId));
    const same = await conflictCreate('mine v1\n', 'h2', 2);
    expect(same.outcome).toMatchObject({ kind: 'conflict_create_renamed', fileId: copyId });
    expect(Buffer.from(await storedState(copyId)).equals(firstState)).toBe(true);

    // Other content: a copy of its own at the next free name. The first copy
    // and the peer holding its history keep "mine v1".
    const other = await conflictCreate('mine v2\n', 'h3', 3);
    if (other.outcome.kind !== 'conflict_create_renamed') throw new Error('expected conflict');
    expect(other.outcome.finalPath).toBe('collide.conflict-client-B-2.md');
    expect(other.outcome.fileId).not.toBe(copyId);
    expect(other.log.payload).not.toHaveProperty('revived');
    expect(textOf(await storedState(other.outcome.fileId))).toBe('mine v2\n');
    Y.applyUpdate(peer, await storedState(copyId));
    expect(peer.getText(TEXT_KEY).toString()).toBe('mine v1\n');

    // Its retry lands on its own copy, not on the first one.
    const otherAgain = await conflictCreate('mine v2\n', 'h3', 4);
    expect(otherAgain.outcome).toMatchObject({ fileId: other.outcome.fileId });
    const paths = await testPrisma.vaultFile.findMany({
      where: { projectId },
      orderBy: { path: 'asc' },
      select: { path: true },
    });
    expect(paths.map((f) => f.path)).toEqual([
      'collide.conflict-client-B-2.md',
      'collide.conflict-client-B.md',
      'collide.md',
    ]);
  });

  it("a conflict CREATE does not write over this client's rename-conflict copy of another note", async () => {
    // Review of 0.3.8 (server, #1). B renames note X onto a taken name, the
    // server parks X at `collide.conflict-B.md`. Later B creates a new note
    // under the same, still taken, name. The CREATE took X's row as "its"
    // conflict copy and, since the history is extended, deleted X's text on
    // the server and on every device holding X.
    const { projectId, ownerId } = await seedProject();
    const create = (path: string, text: string, clientId: string, n: number) =>
      applyOperation(
        { projectId, authorId: ownerId, clientId, vectorClock: { [clientId]: n } },
        {
          opType: 'CREATE',
          filePath: path,
          payload: { fileType: 'TEXT', contentHash: `h-${text}`, size: text.length },
          data: Buffer.from(text),
        },
      );
    await create('collide.md', 'winner\n', 'A', 1);
    const x = await create('x.md', 'X precious\n', 'B', 1);
    if (x.outcome.kind !== 'created') throw new Error('expected created');
    const xId = x.outcome.fileId;
    const parked = await applyOperation(
      { projectId, authorId: ownerId, clientId: 'B', vectorClock: { B: 2 } },
      { opType: 'RENAME', filePath: 'x.md', newPath: 'collide.md', payload: { fileId: xId } },
    );
    expect(parked.outcome).toMatchObject({ finalPath: 'collide.conflict-B.md' });
    const holder = new Y.Doc();
    Y.applyUpdate(holder, await storedState(xId));

    const fresh = await create('collide.md', 'unrelated new note\n', 'B', 3);
    if (fresh.outcome.kind !== 'conflict_create_renamed') throw new Error('expected conflict');
    expect(fresh.outcome.fileId).not.toBe(xId);
    expect(fresh.outcome.finalPath).toBe('collide.conflict-B-2.md');
    expect(textOf(await storedState(fresh.outcome.fileId))).toBe('unrelated new note\n');

    const xState = await storedState(xId);
    expect(textOf(xState)).toBe('X precious\n');
    Y.applyUpdate(holder, xState);
    expect(holder.getText(TEXT_KEY).toString()).toBe('X precious\n');
    const xRow = await testPrisma.vaultFile.findUniqueOrThrow({ where: { id: xId } });
    expect(xRow).toMatchObject({ path: 'collide.conflict-B.md', contentHash: 'h-X precious\n' });
    expect(await readFile(join(storageRoot, projectId, 'collide.conflict-B.md'), 'utf8')).toBe(
      'X precious\n',
    );
  });

  it('a conflict CREATE revives a deleted conflict copy of this client at that name', async () => {
    const { projectId, ownerId } = await seedProject();
    const create = (text: string, clientId: string, n: number) =>
      applyOperation(
        { projectId, authorId: ownerId, clientId, vectorClock: { [clientId]: n } },
        {
          opType: 'CREATE',
          filePath: 'collide.md',
          payload: { fileType: 'TEXT', contentHash: `h-${text}`, size: text.length },
          data: Buffer.from(text),
        },
      );
    await create('winner\n', 'A', 1);
    const first = await create('first copy\n', 'B', 1);
    if (first.outcome.kind !== 'conflict_create_renamed') throw new Error('expected conflict');
    await applyOperation(
      { projectId, authorId: ownerId, clientId: 'B', vectorClock: { B: 2 } },
      {
        opType: 'DELETE',
        filePath: first.outcome.finalPath,
        payload: { fileId: first.outcome.fileId },
      },
    );

    const again = await create('second copy\n', 'B', 3);
    expect(again.outcome).toMatchObject({
      kind: 'conflict_create_renamed',
      fileId: first.outcome.fileId,
      finalPath: 'collide.conflict-B.md',
    });
    expect(again.log.payload).toMatchObject({ revived: true });
    expect(textOf(await storedState(first.outcome.fileId))).toBe('second copy\n');
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

  describe('when the conflict name is already taken', () => {
    const binary = (projectId: string, ownerId: string, path: string, bytes: string, n: number) =>
      applyOperation(
        { projectId, authorId: ownerId, clientId: 'B', vectorClock: { B: n } },
        {
          opType: 'CREATE',
          filePath: path,
          payload: { fileType: 'BINARY', contentHash: `h-${bytes}`, size: bytes.length },
          data: Buffer.from(bytes),
        },
      );
    const renameOntoTaken = (projectId: string, ownerId: string, fileId: string, n: number) =>
      applyOperation(
        { projectId, authorId: ownerId, clientId: 'B', vectorClock: { B: n } },
        { opType: 'RENAME', filePath: 'other.png', newPath: 'pic.png', payload: { fileId } },
      );
    const disk = (projectId: string, path: string) =>
      readFile(join(storageRoot, projectId, path), 'utf8').catch(() => null);

    async function takenName() {
      const { projectId, ownerId } = await seedProject();
      await applyOperation(
        { projectId, authorId: ownerId, clientId: 'A', vectorClock: { A: 1 } },
        {
          opType: 'CREATE',
          filePath: 'pic.png',
          payload: { fileType: 'BINARY', contentHash: 'h-winner', size: 6 },
          data: Buffer.from('winner'),
        },
      );
      // B's own conflict CREATE on that name takes `pic.conflict-B.png`.
      const copy = await binary(projectId, ownerId, 'pic.png', 'mine', 1);
      if (copy.outcome.kind !== 'conflict_create_renamed') throw new Error('expected conflict');
      expect(copy.outcome.finalPath).toBe('pic.conflict-B.png');
      const other = await binary(projectId, ownerId, 'other.png', 'other bytes', 2);
      if (other.outcome.kind !== 'created') throw new Error('expected created');
      return { projectId, ownerId, copy: copy.outcome, otherId: other.outcome.fileId };
    }

    it('a conflict RENAME does not move over the conflict copy of another file', async () => {
      // The move overwrote the copy's bytes on disk — for a binary its only
      // copy — and then failed on the unique index; the client kept retrying.
      const { projectId, ownerId, copy, otherId } = await takenName();

      const renamed = await renameOntoTaken(projectId, ownerId, otherId, 3);
      expect(renamed.outcome).toMatchObject({
        kind: 'conflict_create_renamed',
        fileId: otherId,
        finalPath: 'pic.conflict-B-2.png',
      });
      expect(await disk(projectId, 'pic.conflict-B.png')).toBe('mine');
      expect(await disk(projectId, 'pic.conflict-B-2.png')).toBe('other bytes');
      const rows = await testPrisma.vaultFile.findMany({
        where: { projectId },
        orderBy: { path: 'asc' },
        select: { id: true, path: true },
      });
      expect(rows).toEqual([
        { id: otherId, path: 'pic.conflict-B-2.png' },
        { id: copy.fileId, path: 'pic.conflict-B.png' },
        expect.objectContaining({ path: 'pic.png' }),
      ]);

      // The same rename retried leaves the file where it is.
      const retry = await renameOntoTaken(projectId, ownerId, otherId, 4);
      expect(retry.outcome).toMatchObject({ finalPath: 'pic.conflict-B-2.png' });
      expect(await disk(projectId, 'pic.conflict-B-2.png')).toBe('other bytes');
    });

    it('a conflict RENAME clears a tombstone at the conflict name, as at a plain target', async () => {
      const { projectId, ownerId, copy, otherId } = await takenName();
      await applyOperation(
        { projectId, authorId: ownerId, clientId: 'B', vectorClock: { B: 3 } },
        { opType: 'DELETE', filePath: copy.finalPath, payload: { fileId: copy.fileId } },
      );

      const renamed = await renameOntoTaken(projectId, ownerId, otherId, 4);
      expect(renamed.outcome).toMatchObject({ finalPath: 'pic.conflict-B.png' });
      expect(await disk(projectId, 'pic.conflict-B.png')).toBe('other bytes');
      const row = await testPrisma.vaultFile.findUniqueOrThrow({ where: { id: otherId } });
      expect(row.path).toBe('pic.conflict-B.png');
      expect(await testPrisma.vaultFile.findUnique({ where: { id: copy.fileId } })).toBeNull();
    });
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
    const { operations: ops } = await listOperationsSince({ projectId, since: { A: 1 } });
    expect(ops.map((o) => o.filePath)).toEqual(['b.md']);

    // From a fresh perspective, they should pick up everything.
    const { operations: all } = await listOperationsSince({ projectId, since: {} });
    expect(all.map((o) => o.filePath)).toEqual(['a.md', 'b.md']);
  });
});
