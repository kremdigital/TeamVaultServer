/**
 * REST-записи должны быть видны клиентам синхронизации: попадать в
 * `OperationLog` (иначе не подтянутся даже при `project:join`) и держать
 * `YjsDocument` в соответствии с содержимым (иначе клиент получит старый текст
 * — ровно та порча, что разбиралась в инциденте задвоения 2026-08-03).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Y from 'yjs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { POST as createFile } from '@/app/api/projects/[id]/files/route';
import {
  PUT as updateFile,
  PATCH as moveFile,
  DELETE as deleteFile,
} from '@/app/api/projects/[id]/files/[fileId]/route';
import { generateApiKey } from '@/lib/auth/api-key';
import { API_KEY_HEADER } from '@/lib/auth/api-key-middleware';
import { TEXT_KEY } from '@/lib/crdt/persistence';
import { resetDatabase, testPrisma } from '../db';

let storageRoot: string;
let originalStoragePath: string | undefined;

beforeAll(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), 'osync-rest-sync-'));
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
    data: { email: `r-${Date.now()}-${Math.random()}@x.test`, passwordHash: 'h', name: 'O' },
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

async function post(plain: string, projectId: string, path: string, content: string) {
  const form = new FormData();
  form.set('path', path);
  form.set('file', new Blob([content], { type: 'text/markdown' }), path.split('/').pop());
  const res = await createFile(
    new Request('http://localhost/api/projects/x/files', {
      method: 'POST',
      headers: { [API_KEY_HEADER]: plain },
      body: form,
    }),
    { params: Promise.resolve({ id: projectId }) },
  );
  return res;
}

const opTypes = (projectId: string) =>
  testPrisma.operationLog
    .findMany({ where: { projectId }, orderBy: { createdAt: 'asc' }, select: { opType: true } })
    .then((rows) => rows.map((r) => r.opType));

async function yjsText(fileId: string): Promise<string> {
  const row = await testPrisma.yjsDocument.findUnique({ where: { fileId } });
  if (!row) return '';
  const doc = new Y.Doc();
  Y.applyUpdate(doc, new Uint8Array(row.state));
  return doc.getText(TEXT_KEY).toString();
}

describe('REST-записи видны клиентам синхронизации', () => {
  it('создание попадает в журнал операций и засевает Yjs', async () => {
    const { projectId, plain } = await seedOwnerWithKey();

    const res = await post(plain, projectId, 'заметка.md', '# Заголовок\n\nтекст\n');
    expect(res.status).toBe(201);
    const { file } = (await res.json()) as { file: { id: string } };

    expect(await opTypes(projectId)).toEqual(['CREATE']);
    expect(await yjsText(file.id)).toBe('# Заголовок\n\nтекст\n');
  });

  it('обновление пишет UPDATE и пересобирает Yjs под новый текст', async () => {
    const { projectId, plain } = await seedOwnerWithKey();
    const created = await post(plain, projectId, 'з.md', 'первая версия\n');
    const { file } = (await created.json()) as { file: { id: string } };

    const res = await updateFile(
      new Request('http://localhost/api/projects/x/files/y', {
        method: 'PUT',
        headers: { [API_KEY_HEADER]: plain },
        body: 'вторая версия\n',
      }),
      { params: Promise.resolve({ id: projectId, fileId: file.id }) },
    );
    expect(res.status).toBe(200);

    expect(await opTypes(projectId)).toEqual(['CREATE', 'UPDATE']);
    // Ключевое: без пересборки CRDT клиент получил бы «первая версия».
    expect(await yjsText(file.id)).toBe('вторая версия\n');
  });

  it('обновление НЕ задваивает текст у клиента, который уже имеет документ', async () => {
    const { projectId, plain } = await seedOwnerWithKey();
    const created = await post(plain, projectId, 'з.md', 'первая версия\n');
    const { file } = (await created.json()) as { file: { id: string } };

    // Клиент, получивший исходное состояние (как плагин после file:created).
    const clientDoc = new Y.Doc();
    const seeded = await testPrisma.yjsDocument.findUniqueOrThrow({ where: { fileId: file.id } });
    Y.applyUpdate(clientDoc, new Uint8Array(seeded.state));
    expect(clientDoc.getText(TEXT_KEY).toString()).toBe('первая версия\n');

    await updateFile(
      new Request('http://localhost/api/projects/x/files/y', {
        method: 'PUT',
        headers: { [API_KEY_HEADER]: plain },
        body: 'вторая версия\n',
      }),
      { params: Promise.resolve({ id: projectId, fileId: file.id }) },
    );

    // Клиент применяет новое состояние поверх своего — как через yjs:update.
    const after = await testPrisma.yjsDocument.findUniqueOrThrow({ where: { fileId: file.id } });
    Y.applyUpdate(clientDoc, new Uint8Array(after.state));

    // Регрессия: подмена документа свежим (buildInitialState) давала здесь
    // «первая версия\nвторая версия\n» — тот же механизм, что в инциденте
    // задвоения 2026-08-03. Мутация существующего документа несёт удаление
    // прежнего текста, поэтому клиент сходится к новому.
    expect(clientDoc.getText(TEXT_KEY).toString()).toBe('вторая версия\n');
  });

  it('перемещение пишет MOVE с обоими путями', async () => {
    const { projectId, plain } = await seedOwnerWithKey();
    const created = await post(plain, projectId, 'старая.md', 'текст\n');
    const { file } = (await created.json()) as { file: { id: string } };

    const res = await moveFile(
      new Request('http://localhost/api/projects/x/files/y', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', [API_KEY_HEADER]: plain },
        body: JSON.stringify({ newPath: 'папка/новая.md' }),
      }),
      { params: Promise.resolve({ id: projectId, fileId: file.id }) },
    );
    expect(res.status).toBe(200);

    const move = await testPrisma.operationLog.findFirst({
      where: { projectId, opType: 'MOVE' },
      select: { filePath: true, newPath: true },
    });
    expect(move).toEqual({ filePath: 'старая.md', newPath: 'папка/новая.md' });
  });

  it('удаление пишет DELETE', async () => {
    const { projectId, plain } = await seedOwnerWithKey();
    const created = await post(plain, projectId, 'уйдёт.md', 'текст\n');
    const { file } = (await created.json()) as { file: { id: string } };

    const res = await deleteFile(
      new Request('http://localhost/api/projects/x/files/y', {
        method: 'DELETE',
        headers: { [API_KEY_HEADER]: plain },
      }),
      { params: Promise.resolve({ id: projectId, fileId: file.id }) },
    );
    expect(res.status).toBe(200);

    expect(await opTypes(projectId)).toEqual(['CREATE', 'DELETE']);
    const row = await testPrisma.vaultFile.findUnique({ where: { id: file.id } });
    expect(row?.deletedAt).not.toBeNull();
  });

  it('создание на пути удалённой заметки оживляет её, а не отдаёт 409', async () => {
    const { projectId, plain } = await seedOwnerWithKey();
    const created = await post(plain, projectId, 'вернётся.md', 'первое\n');
    const { file } = (await created.json()) as { file: { id: string } };
    await deleteFile(
      new Request('http://localhost/api/projects/x/files/y', {
        method: 'DELETE',
        headers: { [API_KEY_HEADER]: plain },
      }),
      { params: Promise.resolve({ id: projectId, fileId: file.id }) },
    );

    // Раньше здесь был 409 навсегда: тумбстоун занимает @@unique([projectId, path]),
    // и пересоздать удалённую заметку через REST было невозможно — при том, что
    // сокетный applyCreate такой путь оживляет.
    const again = await post(plain, projectId, 'вернётся.md', 'второе\n');
    expect(again.status).toBe(201);

    const row = await testPrisma.vaultFile.findFirst({
      where: { projectId, path: 'вернётся.md' },
    });
    expect(row?.deletedAt).toBeNull();
    expect(await yjsText(row!.id)).toBe('второе\n');
  });

  it('оживление через REST продолжает историю: клиент со старой историей получает ровно новый текст', async () => {
    // MCP write_note или веб создаёт заметку на месте удалённой: сервер оживляет
    // тот же fileId. Устройство, которое было офлайн, держит старую историю этой
    // заметки. Подмена документа свежим (buildInitialState) давала ему «старое
    // плюс новое», и задвоение уходило всей команде.
    const { projectId, plain } = await seedOwnerWithKey();
    const created = await post(plain, projectId, 'Untitled.md', 'старый текст\n');
    const { file } = (await created.json()) as { file: { id: string } };

    const device = new Y.Doc();
    const seeded = await testPrisma.yjsDocument.findUniqueOrThrow({ where: { fileId: file.id } });
    Y.applyUpdate(device, new Uint8Array(seeded.state));

    await deleteFile(
      new Request('http://localhost/api/projects/x/files/y', {
        method: 'DELETE',
        headers: { [API_KEY_HEADER]: plain },
      }),
      { params: Promise.resolve({ id: projectId, fileId: file.id }) },
    );
    const again = await post(plain, projectId, 'Untitled.md', 'новая заметка\n');
    expect(again.status).toBe(201);
    expect(((await again.json()) as { file: { id: string } }).file.id).toBe(file.id);

    const after = await testPrisma.yjsDocument.findUniqueOrThrow({ where: { fileId: file.id } });
    Y.applyUpdate(device, new Uint8Array(after.state));
    expect(device.getText(TEXT_KEY).toString()).toBe('новая заметка\n');
  });

  it('живой файл на пути по-прежнему даёт 409', async () => {
    const { projectId, plain } = await seedOwnerWithKey();
    await post(plain, projectId, 'занято.md', 'первое\n');

    const again = await post(plain, projectId, 'занято.md', 'второе\n');
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe('path_exists');
  });

  it('операции помечены псевдоклиентом rest:<userId> в vector clock', async () => {
    const { projectId, plain, user } = await seedOwnerWithKey();
    await post(plain, projectId, 'клок.md', 'текст\n');

    const log = await testPrisma.operationLog.findFirstOrThrow({
      where: { projectId },
      select: { vectorClock: true, authorId: true },
    });
    expect(log.authorId).toBe(user.id);
    expect(Object.keys(log.vectorClock as Record<string, number>)).toEqual([`rest:${user.id}`]);
  });
});
