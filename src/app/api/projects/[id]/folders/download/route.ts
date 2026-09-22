import { Readable } from 'node:stream';
import { ZipArchive } from 'archiver';
import { prisma } from '@/lib/db/client';
import { errors } from '@/lib/http/errors';
import { authenticateRequest } from '@/lib/auth/authenticate';
import { canViewProject, loadProjectAccess } from '@/lib/auth/permissions';
import { getProjectFileStat, readProjectFileStream } from '@/lib/files/storage';
import { InvalidPathError, normalizeVaultPath } from '@/lib/files/paths';
import { child } from '@/lib/logger';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Stream a folder's files as a `.zip`. Used by the web notes browser's
 * "download folder" context-menu action. Auth via the session cookie (or
 * API key); read access required. Entry names are relative to the folder's
 * parent so the archive unpacks into a directory named after the folder.
 */
export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const user = await authenticateRequest(request);
  if (!user) return errors.unauthorized();

  const { id } = await context.params;
  const access = await loadProjectAccess(user, id);
  if (!access) return errors.notFound('Проект не найден');
  if (!canViewProject(user, access)) return errors.forbidden();

  const raw = new URL(request.url).searchParams.get('path');
  if (!raw) return errors.invalid('missing_path', 'Не указана папка');
  let folder: string;
  try {
    folder = normalizeVaultPath(raw, { allowClientDirs: true });
  } catch (err) {
    if (err instanceof InvalidPathError) return errors.invalid('invalid_path', err.message);
    throw err;
  }

  const files = await prisma.vaultFile.findMany({
    where: { projectId: id, deletedAt: null, path: { startsWith: `${folder}/` } },
    select: { path: true },
    orderBy: { path: 'asc' },
  });
  if (files.length === 0) return errors.notFound('Папка пуста или не найдена');

  const log = child({ route: 'folder-download', projectId: id });
  const parent = folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '';

  // level 1: vault folders are mostly already-compressed images — favour
  // throughput over ratio while still shrinking markdown.
  const archive = new ZipArchive({ zlib: { level: 1 } });
  archive.on('error', (err: Error) => log.error({ err }, 'folder zip stream error'));

  // Файлы, которых нет на диске, пропускаем, а не отдаём в архив.
  //
  // `createReadStream` на отсутствующем файле не бросает синхронно — ошибка
  // прилетает событием уже в середине потока, обрывая **весь** архив. Один
  // потерянный файл делал нескачиваемой всю папку. Расхождение БД и диска —
  // аномалия, поэтому каждый пропуск пишется в лог как `error`.
  const missing: string[] = [];
  await Promise.all(
    files.map(async (f) => {
      if (!(await getProjectFileStat(id, f.path))) missing.push(f.path);
    }),
  );
  if (missing.length > 0) {
    log.error({ missing, count: missing.length }, 'файлы есть в БД, но отсутствуют на диске');
  }

  const present = files.filter((f) => !missing.includes(f.path));
  if (present.length === 0) {
    return errors.notFound('Файлы папки отсутствуют в хранилище', 'files_missing_on_disk');
  }

  for (const f of present) {
    const name = parent ? f.path.slice(parent.length + 1) : f.path;
    archive.append(readProjectFileStream(id, f.path), { name });
  }
  void archive.finalize();

  const webStream = Readable.toWeb(archive) as unknown as ReadableStream<Uint8Array>;
  const zipName = `${folder.slice(folder.lastIndexOf('/') + 1)}.zip`;
  return new Response(webStream, {
    status: 200,
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="folder.zip"; filename*=UTF-8''${encodeURIComponent(zipName)}`,
    },
  });
}
