/**
 * Catch-up журнала операций (ack `project:join`) на длинных журналах.
 *
 * Раньше сервер брал 500 САМЫХ СТАРЫХ строк проекта и только потом отбрасывал
 * виденные клиентом. В проекте длиннее 500 операций (S1Test2 — 609) новые
 * операции в catch-up не попадали вообще: клиент не узнавал ни о новых
 * вложениях, ни об удалениях и переименованиях, сделанных, пока он был офлайн.
 * Весь журнал (`listOperationsSince`) теперь получает клиент, который просит о
 * нём (`operationsCatchup: 2`). Остальные, в том числе плагин 0.3.7, получают
 * прежнее окно (`listLegacyOperationsSince`): 0.3.7 воспроизводит хвост истории,
 * который уже применил живьём, с дубликатами файлов у всей команды.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import {
  applyOperation,
  CATCHUP_OPERATIONS_LIMIT,
  LEGACY_CATCHUP_WINDOW,
  listLegacyOperationsSince,
  listOperationsSince,
} from '@/lib/sync/operation-log';
import { applyRestOperation, restClientId } from '@/lib/sync/rest-write';
import type { VectorClock } from '@/lib/sync/vector-clock';
import { resetDatabase, testPrisma } from '../db';

let storageRoot: string;
let originalStoragePath: string | undefined;

beforeAll(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), 'osync-catchup-'));
  originalStoragePath = process.env.STORAGE_PATH;
  process.env.STORAGE_PATH = storageRoot;
});

afterAll(async () => {
  if (originalStoragePath !== undefined) process.env.STORAGE_PATH = originalStoragePath;
  else delete process.env.STORAGE_PATH;
  await rm(storageRoot, { recursive: true, force: true });
  await testPrisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase();
});

async function seedOwnedProject(): Promise<{ projectId: string; ownerId: string }> {
  const owner = await testPrisma.user.create({
    data: { email: `c-${Date.now()}-${Math.random()}@x.test`, passwordHash: 'h', name: 'C' },
  });
  const project = await testPrisma.project.create({
    data: {
      slug: `s-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: 'P',
      ownerId: owner.id,
      members: { create: { userId: owner.id, role: 'ADMIN', addedById: owner.id } },
    },
  });
  return { projectId: project.id, ownerId: owner.id };
}

async function seedProject(): Promise<string> {
  return (await seedOwnedProject()).projectId;
}

const BASE = Date.UTC(2026, 8, 1);

interface Row {
  path: string;
  clock: Prisma.InputJsonValue;
  /** Milliseconds after {@link BASE}: the row's `createdAt`. */
  at: number;
}

/** Journal rows written straight to the table, `createdAt` set explicitly. */
async function writeRows(projectId: string, rows: Row[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 1000) {
    await testPrisma.operationLog.createMany({
      data: rows.slice(i, i + 1000).map((r) => ({
        projectId,
        opType: 'CREATE' as const,
        filePath: r.path,
        vectorClock: r.clock,
        payload: { fileType: 'BINARY', contentHash: 'h', size: 1, fileId: `f-${r.path}` },
        createdAt: new Date(BASE + r.at),
      })),
    });
  }
}

/** `count` operations of one client, counters 1..count, 10 ms apart. */
function journalOf(client: string, count: number): Row[] {
  return Array.from({ length: count }, (_, i) => ({
    path: `${client}-${i + 1}.bin`,
    clock: { [client]: i + 1 },
    at: i * 10,
  }));
}

const paths = (ops: { filePath: string }[]) => ops.map((o) => o.filePath);

/** `OPTYPE path[ -> newPath]` of each row. */
const steps = (ops: { opType: string; filePath: string; newPath: string | null }[]) =>
  ops.map((o) => `${o.opType} ${o.filePath}${o.newPath ? ` -> ${o.newPath}` : ''}`);

/** The clock a client has after replaying `ops`: the merge of their clocks. */
function clockOf(ops: { vectorClock: unknown }[]): VectorClock {
  const clock: VectorClock = {};
  for (const op of ops) {
    for (const [client, counter] of Object.entries(op.vectorClock as VectorClock)) {
      clock[client] = Math.max(clock[client] ?? 0, counter);
    }
  }
  return clock;
}

/**
 * The catch-up of every server up to 8a6d925, word for word: the 500 oldest
 * rows of the project, then those with a counter above `since`.
 */
async function catchUpOf8a6d925(projectId: string, since: VectorClock) {
  const rows = await testPrisma.operationLog.findMany({
    where: { projectId },
    orderBy: { createdAt: 'asc' },
    take: 500,
  });
  return rows.filter((row) => {
    const opClock = row.vectorClock as Record<string, number>;
    for (const [client, counter] of Object.entries(opClock)) {
      if ((since[client] ?? 0) < counter) return true;
    }
    return false;
  });
}

describe('listOperationsSince on a journal longer than 500 operations', () => {
  it('returns the new operations at the end of the journal', async () => {
    const projectId = await seedProject();
    // 600 operations the client has seen, then three new ones.
    await writeRows(projectId, journalOf('A', 603));
    const since: VectorClock = { A: 600 };

    const { operations, truncated } = await listOperationsSince({ projectId, since });

    expect(paths(operations)).toEqual(['A-601.bin', 'A-602.bin', 'A-603.bin']);
    expect(truncated).toBe(false);
  });

  it('leaves out every operation the client clock covers, wherever it is', async () => {
    const projectId = await seedProject();
    const rows = journalOf('A', 700);
    // A teammate's operation early in the journal, which the client has not
    // seen, and one of theirs that it has.
    rows.push({ path: 'B-early.bin', clock: { B: 2 }, at: 95 });
    rows.push({ path: 'B-seen.bin', clock: { B: 1 }, at: 185 });
    // Covered in every coordinate: seen, even with a coordinate of its own.
    rows.push({ path: 'A-B-covered.bin', clock: { A: 650, B: 1 }, at: 8000 });
    // A counter above `since` in one coordinate is enough to be unseen.
    rows.push({ path: 'A-B-new.bin', clock: { A: 650, B: 3 }, at: 8010 });
    await writeRows(projectId, rows);

    const { operations } = await listOperationsSince({ projectId, since: { A: 699, B: 1 } });

    expect(paths(operations)).toEqual(['B-early.bin', 'A-700.bin', 'A-B-new.bin']);
  });

  it('does not return the operations of another project', async () => {
    const projectId = await seedProject();
    const other = await seedProject();
    await writeRows(projectId, journalOf('A', 2));
    await writeRows(other, journalOf('A', 3));

    const { operations } = await listOperationsSince({ projectId, since: {} });

    expect(paths(operations)).toEqual(['A-1.bin', 'A-2.bin']);
  });

  it('returns rows shaped like OperationLog, oldest first, id breaking ties', async () => {
    const projectId = await seedProject();
    await writeRows(projectId, [
      { path: 'late.bin', clock: { A: 3 }, at: 5 },
      { path: 'tie-1.bin', clock: { A: 1 }, at: 1 },
      { path: 'tie-2.bin', clock: { A: 2 }, at: 1 },
    ]);
    const stored = await testPrisma.operationLog.findMany({
      where: { projectId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    const { operations } = await listOperationsSince({ projectId, since: {} });

    expect(operations).toEqual(stored);
    expect(operations[0]?.createdAt).toBeInstanceOf(Date);
    expect(operations[0]?.vectorClock).toEqual(expect.any(Object));
    expect(operations[0]?.opType).toBe('CREATE');
    expect(paths(operations).at(-1)).toBe('late.bin');
  });

  it('skips a clock the server never writes instead of failing the query', async () => {
    const projectId = await seedProject();
    await writeRows(projectId, [
      { path: 'text-counter.bin', clock: { A: '7' }, at: 0 },
      { path: 'array-clock.bin', clock: [1, 2], at: 1 },
      { path: 'number.bin', clock: { A: 1 }, at: 2 },
    ]);

    const { operations } = await listOperationsSince({ projectId, since: {} });

    expect(paths(operations)).toEqual(['number.bin']);
  });

  it('refuses a limit that is not a positive integer', async () => {
    const projectId = await seedProject();
    await expect(listOperationsSince({ projectId, since: {}, limit: 0 })).rejects.toThrow(
      'invalid_limit',
    );
    await expect(listOperationsSince({ projectId, since: {}, limit: 1.5 })).rejects.toThrow(
      'invalid_limit',
    );
  });
});

describe('listOperationsSince: the limit', () => {
  it('keeps the NEWEST unseen operations, oldest first, and says so', async () => {
    const projectId = await seedProject();
    await writeRows(projectId, journalOf('A', 10));

    const { operations, truncated } = await listOperationsSince({
      projectId,
      since: { A: 4 },
      limit: 3,
    });

    expect(paths(operations)).toEqual(['A-8.bin', 'A-9.bin', 'A-10.bin']);
    expect(truncated).toBe(true);
  });

  it('is not truncated with exactly the limit unseen', async () => {
    const projectId = await seedProject();
    await writeRows(projectId, journalOf('A', 10));

    const { operations, truncated } = await listOperationsSince({
      projectId,
      since: { A: 7 },
      limit: 3,
    });

    expect(paths(operations)).toEqual(['A-8.bin', 'A-9.bin', 'A-10.bin']);
    expect(truncated).toBe(false);
  });

  it(`defaults to ${CATCHUP_OPERATIONS_LIMIT} operations`, async () => {
    const projectId = await seedProject();
    await writeRows(projectId, journalOf('A', CATCHUP_OPERATIONS_LIMIT + 2));

    const fresh = await listOperationsSince({ projectId, since: {} });

    expect(fresh.truncated).toBe(true);
    expect(fresh.operations).toHaveLength(CATCHUP_OPERATIONS_LIMIT);
    expect(fresh.operations[0]?.filePath).toBe('A-3.bin');
    expect(fresh.operations.at(-1)?.filePath).toBe(`A-${CATCHUP_OPERATIONS_LIMIT + 2}.bin`);

    const behind = await listOperationsSince({ projectId, since: { A: 2 } });
    expect(behind.truncated).toBe(false);
    expect(behind.operations).toHaveLength(CATCHUP_OPERATIONS_LIMIT);
  });
});

describe('REST writes in the catch-up', () => {
  /** A text file written the way `POST /files` (and MCP `write_note`) does. */
  function restCreate(projectId: string, userId: string, path: string) {
    return applyRestOperation({
      projectId,
      userId,
      op: {
        opType: 'CREATE',
        filePath: path,
        payload: { fileType: 'TEXT', contentHash: `h-${path}`, size: 1 },
        data: Buffer.from(path),
      },
    });
  }

  it('a REST write never reuses a counter, so a client that saw the old one still gets it', async () => {
    const { projectId, ownerId } = await seedOwnedProject();
    const rest = restClientId(ownerId);

    // MCP writes a note: `rest:<user>` 1.
    await restCreate(projectId, ownerId, 'mcp-1.md');
    // A plugin that received it live (live events don't move its clock)
    // creates an attachment: its clock has no `rest:<user>`.
    await applyOperation(
      { projectId, authorId: ownerId, clientId: 'A', vectorClock: { A: 1 } },
      {
        opType: 'CREATE',
        filePath: 'a.bin',
        payload: { fileType: 'BINARY', contentHash: 'h-a', size: 1 },
        data: Buffer.from('a'),
      },
    );
    // Another device catches up on both and stops there.
    const seen = await listOperationsSince({ projectId, since: {} });
    const since: VectorClock = {};
    for (const op of seen.operations) {
      for (const [client, counter] of Object.entries(op.vectorClock as VectorClock)) {
        since[client] = Math.max(since[client] ?? 0, counter);
      }
    }
    expect(since).toEqual({ [rest]: 1, A: 1 });

    // MCP writes again. Built on the plugin's clock, this one got
    // `rest:<user>` 1 again, and the device took it for seen.
    const second = await restCreate(projectId, ownerId, 'mcp-2.md');

    expect((second.log.vectorClock as VectorClock)[rest]).toBe(2);
    const { operations } = await listOperationsSince({ projectId, since });
    expect(paths(operations)).toEqual(['mcp-2.md']);
  });
});

describe('the legacy catch-up: a client that does not ask for the whole journal', () => {
  it('is what every server gave before: the 500 oldest rows, less those the client saw', async () => {
    const projectId = await seedProject();
    const rows = journalOf('A', 530);
    // A teammate's operations among them, and past the window.
    for (const at of [1005, 2995, 4995, 5105, 5205]) {
      rows.push({ path: `B-${at}.bin`, clock: { B: at }, at });
    }
    await writeRows(projectId, rows);

    for (const since of [{}, { A: 300 }, { A: 499, B: 2995 }, { A: 530, B: 5205 }]) {
      const legacy = await listLegacyOperationsSince({ projectId, since });
      expect(legacy).toEqual(await catchUpOf8a6d925(projectId, since));
    }
    const fresh = await listLegacyOperationsSince({ projectId, since: {} });
    expect(fresh).toHaveLength(LEGACY_CATCHUP_WINDOW);
    expect(paths(fresh).at(-1)).toBe('A-498.bin');
  });

  it('hands a 0.3.7 device of a long project none of the history it applied live', async () => {
    const { projectId, ownerId } = await seedOwnedProject();
    // 520 older operations. A 0.3.7 device got the oldest 500 of them, and
    // its clock stops there: live broadcasts don't move it.
    await writeRows(projectId, journalOf('F', 520));
    const since: VectorClock = {
      ...clockOf(await listLegacyOperationsSince({ projectId, since: {} })),
      D: 3,
    };
    expect(since).toEqual({ F: 500, D: 3 });

    // A teammate works while the device is online and applies each step live.
    let counter = 0;
    const byTeammate = () => ({
      projectId,
      authorId: ownerId,
      clientId: 'B',
      vectorClock: { F: 520, B: ++counter },
    });
    const create = async (path: string, fileType: 'TEXT' | 'BINARY') => {
      const r = await applyOperation(byTeammate(), {
        opType: 'CREATE',
        filePath: path,
        payload: { fileType, contentHash: `h-${path}`, size: 1 },
        data: Buffer.from('x'),
      });
      if (r.outcome.kind !== 'created') throw new Error('expected created');
      return r.outcome.fileId;
    };
    const rename = (fileId: string, from: string, to: string) =>
      applyOperation(byTeammate(), {
        opType: 'RENAME',
        filePath: from,
        newPath: to,
        payload: { fileId },
      });
    // A pasted image, renamed and moved (0.3.7 downloaded it again under its
    // first name and uploaded that as a new file).
    const img = await create('Pasted image 20260925.png', 'BINARY');
    await rename(img, 'Pasted image 20260925.png', 'diagram.png');
    await applyOperation(byTeammate(), {
      opType: 'MOVE',
      filePath: 'diagram.png',
      newPath: 'assets/diagram.png',
      payload: { fileId: img },
    });
    // A note renamed twice, its middle name then given to another note (0.3.7
    // set that note aside as `b.conflict-<ts>.md` and uploaded it).
    const f1 = await create('a.md', 'TEXT');
    await rename(f1, 'a.md', 'b.md');
    await rename(f1, 'b.md', 'c.md');
    const f2 = await create('d.md', 'TEXT');
    await rename(f2, 'd.md', 'b.md');

    expect(await listLegacyOperationsSince({ projectId, since })).toEqual([]);
    expect(await catchUpOf8a6d925(projectId, since)).toEqual([]);

    // Only a client that asks for the whole journal gets that history.
    const whole = await listOperationsSince({ projectId, since });
    expect(steps(whole.operations.filter((o) => !o.filePath.startsWith('F-')))).toEqual([
      'CREATE Pasted image 20260925.png',
      'RENAME Pasted image 20260925.png -> diagram.png',
      'MOVE diagram.png -> assets/diagram.png',
      'CREATE a.md',
      'RENAME a.md -> b.md',
      'RENAME b.md -> c.md',
      'CREATE d.md',
      'RENAME d.md -> b.md',
    ]);
  });
});

describe('UPDATEs of text never go out in a catch-up', () => {
  /** A plugin (client `A`) creates a note and an attachment: `A` 1 and 2. */
  async function noteAndImage(projectId: string, ownerId: string) {
    const created: string[] = [];
    for (const [n, path, fileType] of [
      [1, 'a.md', 'TEXT'],
      [2, 'img.png', 'BINARY'],
    ] as const) {
      const r = await applyOperation(
        { projectId, authorId: ownerId, clientId: 'A', vectorClock: { A: n } },
        {
          opType: 'CREATE',
          filePath: path,
          payload: { fileType, contentHash: `h-${path}`, size: 4 },
          data: Buffer.from('old\n'),
        },
      );
      if (r.outcome.kind !== 'created') throw new Error('expected created');
      created.push(r.outcome.fileId);
    }
    const [noteId = '', imgId = ''] = created;
    return { noteId, imgId };
  }

  /** Both catch-ups for a device that saw both creations. */
  async function catchUps(projectId: string) {
    const since = { A: 2 };
    return [
      (await listOperationsSince({ projectId, since })).operations,
      await listLegacyOperationsSince({ projectId, since }),
    ];
  }

  it('a REST or MCP write of a note, and a binary-style update of it, are left out', async () => {
    const { projectId, ownerId } = await seedOwnedProject();
    const { noteId, imgId } = await noteAndImage(projectId, ownerId);
    // MCP `write_note` (REST PUT) rewrites the note.
    await applyRestOperation({
      projectId,
      userId: ownerId,
      fileType: 'TEXT',
      textContent: 'old\nmcp\n',
      op: {
        opType: 'UPDATE',
        filePath: 'a.md',
        payload: { fileId: noteId, contentHash: 'h-mcp', size: 8 },
        data: Buffer.from('old\nmcp\n'),
      },
    });
    // A plugin sends the note's bytes as `file:update-binary` ("Keep local").
    await applyOperation(
      { projectId, authorId: ownerId, clientId: 'A', vectorClock: { A: 3 } },
      {
        opType: 'UPDATE',
        filePath: 'a.md',
        payload: { fileId: noteId, contentHash: 'h-local', size: 6 },
        data: Buffer.from('local\n'),
      },
    );
    // The web UI replaces the attachment: that one goes out.
    await applyRestOperation({
      projectId,
      userId: ownerId,
      fileType: 'BINARY',
      op: {
        opType: 'UPDATE',
        filePath: 'img.png',
        payload: { fileId: imgId, contentHash: 'h-png2', size: 4 },
        data: Buffer.from('PNG2'),
      },
    });

    for (const ops of await catchUps(projectId)) {
      expect(steps(ops)).toEqual(['UPDATE img.png']);
    }
  });

  it('a row from before this version, without fileType, is told by its file type now', async () => {
    const { projectId, ownerId } = await seedOwnedProject();
    const { noteId, imgId } = await noteAndImage(projectId, ownerId);
    // UPDATE rows as the servers up to 8a6d925 wrote them (REST PUT of a note
    // among them): no `fileType` in the payload.
    for (const [n, fileId, path] of [
      [3, noteId, 'a.md'],
      [4, imgId, 'img.png'],
    ] as const) {
      await testPrisma.operationLog.create({
        data: {
          projectId,
          opType: 'UPDATE',
          filePath: path,
          vectorClock: { A: n },
          payload: { fileId, contentHash: `h-${n}`, size: 1 },
        },
      });
    }

    for (const ops of await catchUps(projectId)) {
      expect(steps(ops)).toEqual(['UPDATE img.png']);
    }
  });

  it('the row records the file type, which keeps a text UPDATE out once the file row is gone', async () => {
    const { projectId, ownerId } = await seedOwnedProject();
    const { noteId, imgId } = await noteAndImage(projectId, ownerId);
    let n = 2;
    const update = (fileId: string, path: string) =>
      applyOperation(
        { projectId, authorId: ownerId, clientId: 'A', vectorClock: { A: ++n } },
        {
          opType: 'UPDATE',
          filePath: path,
          payload: { fileId, contentHash: `h-${n}`, size: 1 },
          data: Buffer.from('x'),
        },
      );
    const text = await update(noteId, 'a.md');
    const binary = await update(imgId, 'img.png');
    expect(text.log.payload).toEqual({
      fileId: noteId,
      contentHash: 'h-3',
      size: 1,
      fileType: 'TEXT',
    });
    expect(binary.log.payload).toMatchObject({ fileType: 'BINARY' });

    // The file rows are gone (purged); the journal keeps its rows.
    await testPrisma.vaultFile.deleteMany({ where: { projectId } });
    // A row from before this version: no `fileType`, and no file row to ask.
    await testPrisma.operationLog.create({
      data: {
        projectId,
        opType: 'UPDATE',
        filePath: 'old.bin',
        vectorClock: { A: 9 },
        payload: { fileId: 'gone', contentHash: 'h-old', size: 1 },
      },
    });

    for (const ops of await catchUps(projectId)) {
      expect(steps(ops)).toEqual(['UPDATE img.png', 'UPDATE old.bin']);
    }
  });
});
