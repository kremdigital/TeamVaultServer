/**
 * Catch-up журнала операций (`listOperationsSince`, ack `project:join`) на
 * длинных журналах.
 *
 * Раньше сервер брал 500 САМЫХ СТАРЫХ строк проекта и только потом отбрасывал
 * виденные клиентом. В проекте длиннее 500 операций (S1Test2 — 609) новые
 * операции в catch-up не попадали вообще: клиент не узнавал ни о новых
 * вложениях, ни об удалениях и переименованиях, сделанных, пока он был офлайн.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import {
  applyOperation,
  CATCHUP_OPERATIONS_LIMIT,
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
