import { NextResponse } from 'next/server';
import { lookup as lookupMime } from 'mime-types';
import { Prisma, type FileType } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { errors } from '@/lib/http/errors';
import { authenticateRequest, getMaxFileSize } from '@/lib/auth/authenticate';
import { canEditFiles, canViewProject, loadProjectAccess } from '@/lib/auth/permissions';
import { InvalidPathError, normalizeVaultPath } from '@/lib/files/paths';
import { sha256OfBuffer } from '@/lib/files/hash';
import { PathIsDirectoryError } from '@/lib/files/storage';
import { recordFileVersion } from '@/lib/files/versioning';

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const user = await authenticateRequest(request);
  if (!user) return errors.unauthorized();

  const { id } = await context.params;
  const access = await loadProjectAccess(user, id);
  if (!access) return errors.notFound('Проект не найден');
  if (!canViewProject(user, access)) return errors.forbidden();

  const url = new URL(request.url);
  const includeDeleted = url.searchParams.get('includeDeleted') === 'true';

  // Фильтры для клиентов, которым нужен один файл или поддерево, а не весь
  // проект. Без них резолв «путь → fileId» вынуждает выгружать список целиком:
  // на вальте в ~1000 заметок это ~100 КБ JSON и `findMany` по всему проекту на
  // КАЖДУЮ операцию (см. TeamVaultMCP `findByPath`).
  //
  // `path` идёт по индексу `@@unique([projectId, path])`. Ответ сохраняет форму
  // `{ files: [...] }` и на несуществующем пути отдаёт пустой массив, а не 404:
  // вызывающему проще отличить «нет файла» от «нет проекта», а клиенты,
  // проверяющие отсутствие пути перед созданием, не ломаются.
  const rawPath = url.searchParams.get('path');
  const prefixFilter = url.searchParams.get('prefix');

  // Тот же путь, что сохранили бы POST и PATCH: они пропускают его через
  // normalizeVaultPath (`dir//x.md`, `dir\x.md`, `./x.md` → `dir/x.md`, `x.md`).
  // Без этого клиент, передавший путь в другом написании, не находил
  // существующий файл: write_note в MCP получал 409 path_exists вместо
  // обновления, read_note — «Note not found». allowClientDirs — как у всех
  // чтений: строка могла быть сохранена до запрета клиентских папок. Путь,
  // который гейт отвергает, в БД храниться не может — это пустой ответ, как
  // для несуществующего файла.
  let pathFilter: string | null = null;
  if (rawPath) {
    try {
      pathFilter = normalizeVaultPath(rawPath, { allowClientDirs: true });
    } catch (err) {
      if (err instanceof InvalidPathError) return NextResponse.json({ files: [] });
      throw err;
    }
  }

  const files = await prisma.vaultFile.findMany({
    where: {
      projectId: id,
      ...(includeDeleted ? {} : { deletedAt: null }),
      ...(pathFilter ? { path: pathFilter } : {}),
      ...(prefixFilter ? { path: { startsWith: prefixFilter } } : {}),
    },
    select: {
      id: true,
      path: true,
      fileType: true,
      contentHash: true,
      size: true,
      mimeType: true,
      deletedAt: true,
      createdAt: true,
      updatedAt: true,
      lastModifiedById: true,
    },
    orderBy: { path: 'asc' },
  });

  return NextResponse.json({
    files: files.map((f) => ({ ...f, size: f.size.toString() })),
  });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const user = await authenticateRequest(request);
  if (!user) return errors.unauthorized();

  const { id } = await context.params;
  const access = await loadProjectAccess(user, id);
  if (!access) return errors.notFound('Проект не найден');
  if (!canEditFiles(user, access)) return errors.forbidden();

  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    return errors.invalid('expected_multipart', 'Ожидается multipart/form-data');
  }

  const form = await request.formData();
  const rawPath = form.get('path');
  const rawFile = form.get('file');

  if (typeof rawPath !== 'string' || !rawPath) {
    return errors.invalid('path_required', 'Параметр path обязателен');
  }
  if (!(rawFile instanceof Blob)) {
    return errors.invalid('file_required', 'Файл обязателен');
  }

  let normalizedPath: string;
  try {
    normalizedPath = normalizeVaultPath(rawPath);
  } catch (err) {
    if (err instanceof InvalidPathError) {
      return errors.invalid('invalid_path', err.message);
    }
    throw err;
  }

  const max = getMaxFileSize();
  if (max !== null && rawFile.size > max) {
    return errors.invalid('file_too_large', `Файл больше ${max} байт`);
  }

  const buffer = Buffer.from(await rawFile.arrayBuffer());

  const detectedMime =
    typeof rawFile.type === 'string' && rawFile.type.length > 0
      ? rawFile.type
      : lookupMime(normalizedPath) || 'application/octet-stream';

  const fileType: FileType = isTextLike(normalizedPath, detectedMime) ? 'TEXT' : 'BINARY';

  // Живой файл на этом пути — конфликт. Проверяем явно, до применения операции:
  // `applyOperation` в этом случае увёл бы файл в `<path>.conflict-<clientId>`,
  // что уместно для офлайн-клиента, но не для явного вызова API (см.
  // docs/sync-protocol.md). Тумбстоун конфликтом НЕ считается — `applyCreate`
  // оживит строку, как это делает сокетный путь.
  const live = await prisma.vaultFile.findFirst({
    where: { projectId: id, path: normalizedPath, deletedAt: null },
    select: { id: true },
  });
  if (live) {
    return errors.conflict('path_exists', 'Файл с таким путём уже существует');
  }

  // Занятость самого пути — не единственная помеха. Папки в вальте виртуальны,
  // и на диске файл с именем существующего каталога не создать: `rename` в
  // атомарной записи получал `EISDIR`, а наружу уходил ПУСТОЙ 500 без кода
  // ошибки. Перенос такую коллизию давно различает — создание не различало.
  const { describeBlocker, findPathBlocker } = await import('@/lib/files/move-file');
  const blocker = await findPathBlocker(id, normalizedPath);
  if (blocker) {
    return errors.conflict('path_blocked', describeBlocker(blocker));
  }

  // Через общий механизм: журнал операций, засев Yjs для текста, оживление
  // тумбстоуна и рассылка подключённым клиентам. Раньше здесь была прямая
  // запись в БД — из-за неё правки через REST не доходили до плагина.
  const { applyRestOperation } = await import('@/lib/sync/rest-write');
  const contentHash = sha256OfBuffer(buffer);
  let result;
  try {
    result = await applyRestOperation({
      projectId: id,
      userId: user.id,
      op: {
        opType: 'CREATE',
        filePath: normalizedPath,
        payload: {
          fileType,
          mimeType: detectedMime,
          contentHash,
          size: buffer.byteLength,
        },
        data: buffer,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return errors.conflict('path_exists', 'Файл с таким путём уже существует');
    }
    // Каталог мог возникнуть после проверки — либо это скелет, оставшийся от
    // старых операций и не убранный `clearEmptyDirectoryAt` из-за содержимого
    // вне БД. Отвечаем внятно, а не пустым 500.
    if (err instanceof PathIsDirectoryError) {
      return errors.conflict('path_blocked', err.message);
    }
    throw err;
  }

  const fileId = 'fileId' in result.outcome ? result.outcome.fileId : null;
  if (!fileId) {
    return errors.conflict('path_exists', 'Файл с таким путём уже существует');
  }

  const file = await prisma.vaultFile.findUniqueOrThrow({
    where: { id: fileId },
    select: {
      id: true,
      path: true,
      fileType: true,
      contentHash: true,
      size: true,
      mimeType: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  await recordFileVersion({
    projectId: id,
    fileId: file.id,
    data: buffer,
    contentHash,
    authorId: user.id,
  });

  return NextResponse.json({ file: { ...file, size: file.size.toString() } }, { status: 201 });
}

function isTextLike(path: string, mime: string): boolean {
  if (mime.startsWith('text/')) return true;
  if (
    path.endsWith('.md') ||
    path.endsWith('.txt') ||
    path.endsWith('.json') ||
    path.endsWith('.yml') ||
    path.endsWith('.yaml') ||
    path.endsWith('.csv')
  )
    return true;
  return false;
}
