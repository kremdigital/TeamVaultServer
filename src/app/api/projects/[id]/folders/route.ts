import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { errors, parseJsonBody } from '@/lib/http/errors';
import { authenticateRequest } from '@/lib/auth/authenticate';
import { canEditFiles, loadProjectAccess } from '@/lib/auth/permissions';
import { InvalidPathError, normalizeVaultPath } from '@/lib/files/paths';
import { findBatchPathBlocker, moveVaultFile } from '@/lib/files/move-file';
import { applyRestOperation } from '@/lib/sync/rest-write';
import { child } from '@/lib/logger';

interface RouteContext {
  params: Promise<{ id: string }>;
}

/**
 * Папки в вальте — виртуальные: отдельной сущности нет, есть только префикс в
 * пути файла. Поэтому операция над папкой разворачивается в операции над
 * каждым её файлом, включая вложенные.
 *
 * Делать это на клиенте (у него есть весь список) было бы проще, но на папке
 * вроде `раскадровки/серия-1` это сотни запросов и частичный результат при
 * первом же сбое. Здесь — один запрос и общая проверка до первого изменения.
 */
const renameSchema = z.object({
  path: z.string().min(1),
  newPath: z.string().min(1),
});

/** Файлы папки: сам префикс плюс всё вложенное, только живые. */
async function childrenOf(projectId: string, folder: string) {
  return prisma.vaultFile.findMany({
    where: { projectId, deletedAt: null, path: { startsWith: `${folder}/` } },
    select: { id: true, path: true },
    orderBy: { path: 'asc' },
  });
}

function normalizeFolder(raw: string, opts: { existing?: boolean } = {}): string | null {
  try {
    // `normalizeVaultPath` рассчитан на файлы, но проверки те же: без ведущего
    // слэша, без `..`, без выхода за корень. Хвостовой слэш срезаем сами.
    // `existing` — папка уже лежит в проекте (источник переименования,
    // удаление): для неё клиентские зарезервированные имена разрешены, иначе
    // унаследованную `.trash/` нельзя было бы ни переименовать, ни удалить.
    return normalizeVaultPath(raw.replace(/\/+$/, ''), {
      ...(opts.existing === true ? { allowClientDirs: true } : {}),
    });
  } catch (err) {
    if (err instanceof InvalidPathError) return null;
    throw err;
  }
}

export async function PATCH(request: Request, context: RouteContext): Promise<NextResponse> {
  const user = await authenticateRequest(request);
  if (!user) return errors.unauthorized();

  const { id } = await context.params;
  const access = await loadProjectAccess(user, id);
  if (!access) return errors.notFound('Проект не найден');
  if (!canEditFiles(user, access)) return errors.forbidden();

  const parsed = await parseJsonBody(request, renameSchema);
  if (!parsed.ok) return parsed.response;

  const from = normalizeFolder(parsed.data.path, { existing: true });
  const to = normalizeFolder(parsed.data.newPath);
  if (!from || !to) return errors.invalid('invalid_path', 'Недопустимый путь папки');
  if (from === to) return NextResponse.json({ path: to, moved: 0 });

  // Папка внутрь себя — путь вида `a` → `a/b`. Перенос затёр бы сам себя на
  // полпути, поэтому отказываем сразу.
  if (to.startsWith(`${from}/`)) {
    return errors.invalid('invalid_path', 'Нельзя переместить папку внутрь себя');
  }

  const files = await childrenOf(id, from);
  if (files.length === 0) return errors.notFound('Папка пуста или не найдена');

  // Все целевые пути проверяем ДО первого переноса: частично переименованная
  // папка хуже честного отказа.
  const targets = files.map((f) => ({ ...f, to: `${to}/${f.path.slice(from.length + 1)}` }));
  const occupied = await prisma.vaultFile.findMany({
    where: { projectId: id, deletedAt: null, path: { in: targets.map((t) => t.to) } },
    select: { path: true },
  });
  if (occupied.length > 0) {
    return errors.conflict(
      'path_exists',
      `Путь уже занят: ${occupied.map((o) => o.path).join(', ')}`,
    );
  }

  // Занятость самого пути — не единственное препятствие. Папки виртуальные, и
  // файл с именем будущего каталога (скажем, файл `в` при назначении `в/б.md`)
  // проверку выше проходит, а на диске ломает `mkdir`. Раньше это вылезало
  // исключением из середины цикла: половина папки уже переехала, клиент получал
  // пустой 500. Проверяем весь набор назначений одним запросом до первого
  // переноса.
  const blocked = await findBatchPathBlocker({
    projectId: id,
    targets: targets.map((t) => t.to),
    ignoreFileIds: files.map((f) => f.id),
  });
  if (blocked) {
    return errors.conflict(
      'path_blocked',
      `Путь «${blocked.target}» занят файлом «${blocked.blockedBy}»`,
    );
  }

  const failed: string[] = [];
  for (const t of targets) {
    let res;
    try {
      res = await moveVaultFile({
        projectId: id,
        userId: user.id,
        fileId: t.id,
        toPath: t.to,
      });
    } catch (err) {
      // Проверки выше делают это маловероятным, но не невозможным (гонка,
      // отказ диска). Останавливаемся и честно сообщаем, сколько успело
      // переехать: молчаливый 500 оставлял пользователя гадать о состоянии
      // папки.
      child({ route: 'folders.rename' }).error(
        { err, projectId: id, from, to, path: t.path },
        'перенос файла папки сорвался',
      );
      const moved = targets.indexOf(t);
      return NextResponse.json(
        {
          error: {
            code: 'partial_move',
            message: `Папка перенесена частично: ${moved} из ${targets.length}. Остановились на «${t.path}».`,
          },
        },
        { status: 500 },
      );
    }
    if (!res.ok) failed.push(t.path);
  }

  return NextResponse.json({ path: to, moved: targets.length - failed.length, failed });
}

export async function DELETE(request: Request, context: RouteContext): Promise<NextResponse> {
  const user = await authenticateRequest(request);
  if (!user) return errors.unauthorized();

  const { id } = await context.params;
  const access = await loadProjectAccess(user, id);
  if (!access) return errors.notFound('Проект не найден');
  if (!canEditFiles(user, access)) return errors.forbidden();

  const raw = new URL(request.url).searchParams.get('path');
  const folder = raw ? normalizeFolder(raw, { existing: true }) : null;
  if (!folder) return errors.invalid('invalid_path', 'Недопустимый путь папки');

  const files = await childrenOf(id, folder);
  if (files.length === 0) return errors.notFound('Папка пуста или не найдена');

  // Через общий механизм: мягкое удаление, снятие файла с диска, журнал и
  // рассылка клиентам — как у одиночного удаления.
  let deleted = 0;
  for (const f of files) {
    try {
      await applyRestOperation({
        projectId: id,
        userId: user.id,
        op: { opType: 'DELETE', filePath: f.path, payload: { fileId: f.id } },
      });
    } catch (err) {
      // Как и у переименования: сорвавшись на середине, отвечаем разборчиво, а
      // не пустым 500 — пользователю важно знать, что папка удалена частично.
      child({ route: 'folders.delete' }).error(
        { err, projectId: id, folder, path: f.path },
        'удаление файла папки сорвалось',
      );
      return NextResponse.json(
        {
          error: {
            code: 'partial_delete',
            message: `Папка удалена частично: ${deleted} из ${files.length}. Остановились на «${f.path}».`,
          },
        },
        { status: 500 },
      );
    }
    deleted += 1;
  }

  return NextResponse.json({ path: folder, deleted });
}
