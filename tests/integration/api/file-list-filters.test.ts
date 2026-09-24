import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GET as listFiles } from '@/app/api/projects/[id]/files/route';
import { applyOperation } from '@/lib/sync/operation-log';
import { generateApiKey } from '@/lib/auth/api-key';
import { API_KEY_HEADER } from '@/lib/auth/api-key-middleware';
import { resetDatabase, testPrisma } from '../db';

let storageRoot: string;
let originalStoragePath: string | undefined;

beforeAll(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), 'osync-list-'));
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

async function seedOwnerWithKey() {
  const user = await testPrisma.user.create({
    data: { email: `l-${Date.now()}-${Math.random()}@x.test`, passwordHash: 'h', name: 'O' },
  });
  const gen = await generateApiKey();
  await testPrisma.apiKey.create({
    data: { userId: user.id, name: 'cli', keyHash: gen.hash, keyPrefix: gen.prefix },
  });
  const project = await testPrisma.project.create({
    data: {
      slug: `s-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: 'P',
      ownerId: user.id,
      members: { create: { userId: user.id, role: 'ADMIN', addedById: user.id } },
    },
  });
  return { user, projectId: project.id, plain: gen.plain };
}

let clock = 0;
async function seedFile(projectId: string, userId: string, path: string): Promise<string> {
  clock += 1;
  const res = await applyOperation(
    { projectId, authorId: userId, clientId: 'A', vectorClock: { A: clock } },
    {
      opType: 'CREATE',
      filePath: path,
      payload: { fileType: 'TEXT', mimeType: 'text/markdown', contentHash: `h${clock}`, size: 4 },
      data: Buffer.from('текст'),
    },
  );
  if (res.outcome.kind !== 'created') throw new Error(`ожидали created для ${path}`);
  return res.outcome.fileId;
}

async function list(plain: string, projectId: string, query = ''): Promise<string[]> {
  const res = await listFiles(
    new Request(`http://localhost/api/projects/x/files${query}`, {
      headers: { [API_KEY_HEADER]: plain },
    }),
    { params: Promise.resolve({ id: projectId }) },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { files: { path: string }[] };
  return body.files.map((f) => f.path);
}

describe('GET /api/projects/[id]/files — фильтры path и prefix', () => {
  it('без фильтров отдаёт весь проект (обратная совместимость)', async () => {
    const { projectId, user, plain } = await seedOwnerWithKey();
    await seedFile(projectId, user.id, 'a.md');
    await seedFile(projectId, user.id, 'персонажи/минин.md');

    expect((await list(plain, projectId)).sort()).toEqual(['a.md', 'персонажи/минин.md']);
  });

  it('path отдаёт ровно одну запись', async () => {
    const { projectId, user, plain } = await seedOwnerWithKey();
    await seedFile(projectId, user.id, 'персонажи/минин.md');
    await seedFile(projectId, user.id, 'персонажи/пожарский.md');

    expect(await list(plain, projectId, '?path=персонажи/минин.md')).toEqual([
      'персонажи/минин.md',
    ]);
  });

  it('несуществующий path — пустой массив, а не 404', async () => {
    const { projectId, user, plain } = await seedOwnerWithKey();
    await seedFile(projectId, user.id, 'есть.md');

    // На это опирается write_note в MCP: отсутствие пути проверяется перед
    // созданием, и 404 здесь сломал бы создание новых заметок.
    expect(await list(plain, projectId, '?path=нет-такого.md')).toEqual([]);
  });

  it('path находит файл в любом написании, которое POST сохранил бы так же', async () => {
    const { projectId, user, plain } = await seedOwnerWithKey();
    await seedFile(projectId, user.id, 'персонажи/минин.md');

    // write_note в MCP резолвит путь этим запросом перед созданием: без
    // нормализации он не находил существующую заметку и получал 409.
    for (const spelling of ['персонажи//минин.md', 'персонажи\\минин.md', './персонажи/минин.md']) {
      expect(
        await list(plain, projectId, `?path=${encodeURIComponent(spelling)}`),
        spelling,
      ).toEqual(['персонажи/минин.md']);
    }
  });

  it('path, который гейт путей отвергает, — пустой массив, а не ошибка', async () => {
    const { projectId, user, plain } = await seedOwnerWithKey();
    await seedFile(projectId, user.id, 'a.md');

    expect(await list(plain, projectId, `?path=${encodeURIComponent('../a.md')}`)).toEqual([]);
    expect(await list(plain, projectId, `?path=${encodeURIComponent('/a.md')}`)).toEqual([]);
  });

  it('prefix отдаёт поддерево', async () => {
    const { projectId, user, plain } = await seedOwnerWithKey();
    await seedFile(projectId, user.id, 'персонажи/минин.md');
    await seedFile(projectId, user.id, 'персонажи/вложенная/аника.md');
    await seedFile(projectId, user.id, 'локации/волга.md');

    expect((await list(plain, projectId, '?prefix=персонажи/')).sort()).toEqual([
      'персонажи/вложенная/аника.md',
      'персонажи/минин.md',
    ]);
  });

  it('path не показывает удалённые, но с includeDeleted — показывает', async () => {
    const { projectId, user, plain } = await seedOwnerWithKey();
    const id = await seedFile(projectId, user.id, 'удалённая.md');
    await testPrisma.vaultFile.update({ where: { id }, data: { deletedAt: new Date() } });

    expect(await list(plain, projectId, '?path=удалённая.md')).toEqual([]);
    expect(await list(plain, projectId, '?path=удалённая.md&includeDeleted=true')).toEqual([
      'удалённая.md',
    ]);
  });
});
