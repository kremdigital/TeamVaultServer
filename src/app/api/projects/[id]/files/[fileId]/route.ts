import { NextResponse } from 'next/server';
import { z } from 'zod';
import { Readable } from 'node:stream';
import { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { prisma } from '@/lib/db/client';
import { errors, parseJsonBody } from '@/lib/http/errors';
import { authenticateRequest, getMaxFileSize } from '@/lib/auth/authenticate';
import { canEditFiles, canViewProject, loadProjectAccess } from '@/lib/auth/permissions';
import { getProjectFileStat, readProjectFileStream } from '@/lib/files/storage';
import { sha256OfBuffer } from '@/lib/files/hash';
import { child } from '@/lib/logger';
import { recordFileVersion } from '@/lib/files/versioning';
import { corsPreflight, withCors } from '@/lib/http/cors';

interface RouteContext {
  params: Promise<{ id: string; fileId: string }>;
}

export async function OPTIONS(request: Request): Promise<Response> {
  return corsPreflight(request);
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const user = await authenticateRequest(request);
  if (!user) return withCors(errors.unauthorized(), request);

  const { id, fileId } = await context.params;
  const access = await loadProjectAccess(user, id);
  if (!access) return withCors(errors.notFound('Проект не найден'), request);
  if (!canViewProject(user, access)) return withCors(errors.forbidden(), request);

  const file = await prisma.vaultFile.findFirst({
    where: { id: fileId, projectId: id, deletedAt: null },
    select: { path: true, mimeType: true, size: true },
  });
  if (!file) return withCors(errors.notFound('Файл не найден'), request);

  // Наличие на диске проверяем ДО формирования ответа.
  //
  // `createReadStream` на отсутствующем файле не бросает синхронно — ошибка
  // приходит событием, когда ответ 200 уже отдан. Соединение обрывалось, и
  // пользователь получал `HTTP 502` от Caddy вместо внятного кода, а в списке
  // файлов заметка при этом выглядела живой.
  //
  // Расхождение БД и диска — аномалия (ручные правки, сбой ФС, оборванная
  // операция), поэтому пишем `error`, а не просто отдаём 404.
  const onDisk = await getProjectFileStat(id, file.path);
  if (!onDisk) {
    child({ route: 'files.get' }).error(
      { projectId: id, fileId, path: file.path },
      'файл есть в БД, но отсутствует на диске',
    );
    return withCors(
      errors.notFound('Файл отсутствует в хранилище', 'file_missing_on_disk'),
      request,
    );
  }

  const stream = readProjectFileStream(id, file.path);
  // Файл может исчезнуть между проверкой и чтением. Без обработчика такая
  // ошибка роняет процесс: поток уже отдан как тело ответа.
  stream.on('error', (err) => {
    child({ route: 'files.get' }).error(
      { err, projectId: id, fileId, path: file.path },
      'чтение файла оборвалось',
    );
  });
  const webStream = Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>;
  return withCors(
    new Response(webStream, {
      status: 200,
      headers: {
        'content-type': file.mimeType ?? 'application/octet-stream',
        // Длина берётся с диска, а не из БД: при расхождении заголовок обязан
        // соответствовать реально отправленным байтам, иначе клиент повиснет
        // в ожидании недостающих данных.
        'content-length': onDisk.size.toString(),
      },
    }),
    request,
  );
}

export async function PUT(request: Request, context: RouteContext): Promise<NextResponse> {
  const user = await authenticateRequest(request);
  if (!user) return errors.unauthorized();

  const { id, fileId } = await context.params;
  const access = await loadProjectAccess(user, id);
  if (!access) return errors.notFound('Проект не найден');
  if (!canEditFiles(user, access)) return errors.forbidden();

  const file = await prisma.vaultFile.findFirst({
    where: { id: fileId, projectId: id },
    select: { path: true, deletedAt: true },
  });
  if (!file || file.deletedAt) return errors.notFound('Файл не найден');

  const buffer = Buffer.from(await request.arrayBuffer());
  const max = getMaxFileSize();
  if (max !== null && buffer.byteLength > max) {
    return errors.invalid('file_too_large', `Файл больше ${max} байт`);
  }

  // Через общий механизм: запись на диск, журнал операций, текст — в Yjs
  // (история продолжается, `applyUpdate`) и рассылка клиентам. Прямая запись
  // мимо него оставляла CRDT со старым текстом — клиент получал устаревшее
  // содержимое и возвращал его назад.
  const { applyRestOperation } = await import('@/lib/sync/rest-write');
  const contentHash = sha256OfBuffer(buffer);
  await applyRestOperation({
    projectId: id,
    userId: user.id,
    op: {
      opType: 'UPDATE',
      filePath: file.path,
      payload: { fileId, contentHash, size: buffer.byteLength },
      data: buffer,
    },
  });

  const updated = await prisma.vaultFile.findUniqueOrThrow({
    where: { id: fileId },
    select: {
      id: true,
      path: true,
      fileType: true,
      contentHash: true,
      size: true,
      mimeType: true,
      updatedAt: true,
    },
  });

  await recordFileVersion({
    projectId: id,
    fileId,
    data: buffer,
    contentHash,
    authorId: user.id,
  });

  return NextResponse.json({ file: { ...updated, size: updated.size.toString() } });
}

const moveSchema = z.object({
  newPath: z.string().min(1),
});

export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  const user = await authenticateRequest(request);
  if (!user) return errors.unauthorized();

  const { id, fileId } = await context.params;
  const access = await loadProjectAccess(user, id);
  if (!access) return errors.notFound('Проект не найден');
  if (!canEditFiles(user, access)) return errors.forbidden();

  const parsed = await parseJsonBody(request, moveSchema);
  if (!parsed.ok) return parsed.response;

  const { InvalidPathError, normalizeVaultPath } = await import('@/lib/files/paths');
  let normalizedNew: string;
  try {
    normalizedNew = normalizeVaultPath(parsed.data.newPath);
  } catch (err) {
    if (err instanceof InvalidPathError) {
      return errors.invalid('invalid_path', err.message);
    }
    throw err;
  }

  // Вся механика переноса — в общем модуле: её же использует переименование
  // папки, а логика неочевидная (тумбстоуны, транзакция, порядок диск/БД).
  const { moveVaultFile } = await import('@/lib/files/move-file');
  const result = await moveVaultFile({
    projectId: id,
    userId: user.id,
    fileId,
    toPath: normalizedNew,
  });
  if (!result.ok) {
    switch (result.reason) {
      case 'not_found':
        return errors.notFound('Файл не найден');
      case 'path_blocked':
        // Не «путь занят»: мешает либо файл на месте каталога, либо уже
        // существующая папка. Формулировку готовит `describeBlocker`.
        return errors.conflict('path_blocked', result.blockedBy);
      default:
        return errors.conflict('path_exists', 'Файл с таким путём уже существует');
    }
  }

  return NextResponse.json({ file: { id: result.fileId, path: result.path } });
}

export async function DELETE(_request: Request, context: RouteContext): Promise<NextResponse> {
  const user = await authenticateRequest(_request);
  if (!user) return errors.unauthorized();

  const { id, fileId } = await context.params;
  const access = await loadProjectAccess(user, id);
  if (!access) return errors.notFound('Проект не найден');
  if (!canEditFiles(user, access)) return errors.forbidden();

  const file = await prisma.vaultFile.findFirst({
    where: { id: fileId, projectId: id },
    select: { path: true, deletedAt: true },
  });
  if (!file) return errors.notFound('Файл не найден');

  if (!file.deletedAt) {
    // Через общий механизм: мягкое удаление, снятие файла с диска, запись в
    // журнал и рассылка клиентам. Раньше удаление правило БД напрямую и до
    // подключённых клиентов не доходило.
    const { applyRestOperation } = await import('@/lib/sync/rest-write');
    await applyRestOperation({
      projectId: id,
      userId: user.id,
      op: { opType: 'DELETE', filePath: file.path, payload: { fileId } },
    });
  }

  return NextResponse.json({ success: true });
}

// Suppress the unused import warning for ReadableStream from web stream types.
void NodeReadableStream;
