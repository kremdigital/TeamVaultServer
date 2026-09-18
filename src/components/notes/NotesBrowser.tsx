'use client';
/* eslint-disable react-hooks/set-state-in-effect */

import {
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  BookTextIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  LoaderCircleIcon,
  PencilIcon,
  SearchIcon,
  EyeIcon,
  XIcon,
} from 'lucide-react';
import { ApiError, apiDelete, apiGetText, apiPatch, apiUpload } from '@/lib/api/client';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { PromptDialog } from '@/components/common/PromptDialog';
import { slugifyHeading } from '@/lib/notes/slug';
import { ancestorFolderPaths } from '@/lib/notes/tree';
import { baseName, dirName, joinPath, keepExtension, noteFileName } from '@/lib/notes/paths';
import type { NoteFile } from '@/lib/notes/types';
import { AuthedImage } from './AuthedImage';
import { FileTree, type FileTreeActions, type MenuTarget } from './FileTree';
import { MarkdownView } from './MarkdownView';
import { NoteEditor } from './NoteEditor';

const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 560;
const SIDEBAR_DEFAULT = 288;
const SIDEBAR_WIDTH_KEY = 'tv-notes-sidebar-width';

interface NotesBrowserProps {
  projectId: string;
  files: NoteFile[];
  /** Whether the current user may edit notes (ADMIN/EDITOR/owner). Server enforces too. */
  canEdit?: boolean;
  /** Current user's display name — shown to collaborators in the editor. */
  userName?: string | undefined;
}

function isMarkdown(file: NoteFile): boolean {
  return file.fileType === 'TEXT' || /\.md$/i.test(file.path);
}

function isImage(file: NoteFile): boolean {
  return (
    Boolean(file.mimeType?.startsWith('image/')) ||
    /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(file.path)
  );
}

/** Открытый диалог контекстного меню. */
type MenuDialog =
  | { kind: 'create'; folder: string }
  | { kind: 'rename'; target: MenuTarget }
  | { kind: 'delete'; target: MenuTarget }
  | null;

/** One stop in the in-pane navigation history. */
interface NavEntry {
  file: NoteFile;
  heading: string | null;
}

/**
 * Two-pane note browser. Left: collapsible file tree with a filter box.
 * Right: the rendered markdown (or an image / binary notice), with an
 * optional collaborative editor. Internal links and embeds drive in-pane
 * navigation, expanding the tree and scrolling to `#headings` as needed.
 * A back/forward history (with toolbar arrows) tracks link navigation, and
 * the current note is mirrored into the URL (`?note=<path>`) so it can be
 * shared, refreshed, or opened in a new tab.
 */
export function NotesBrowser({
  projectId,
  files,
  canEdit = false,
  userName,
}: NotesBrowserProps): ReactElement {
  const t = useTranslations('notes');
  const router = useRouter();

  // Файлы, удалённые в этой сессии, скрываем сразу: `files` приходит пропом от
  // серверного компонента и обновится только после `router.refresh()`. Без
  // этого удалённая заметка ещё мгновение висит в дереве, а если она была
  // открыта — тут же переоткрывается и отдаёт 404.
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const liveFiles = useMemo(
    () => (removed.size === 0 ? files : files.filter((f) => !removed.has(f.id))),
    [files, removed],
  );

  const [menuDialog, setMenuDialog] = useState<MenuDialog>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingOpen, setPendingOpen] = useState<string | null>(null);

  const markdownFiles = useMemo(() => liveFiles.filter(isMarkdown), [liveFiles]);
  const [history, setHistory] = useState<NavEntry[]>([]);
  const [cursor, setCursor] = useState(-1);
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_DEFAULT);
  const pendingHeading = useRef<string | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const selected = cursor >= 0 ? (history[cursor]?.file ?? null) : null;
  const canBack = cursor > 0;
  const canForward = cursor >= 0 && cursor < history.length - 1;

  // Side effects shared by every selection (push, back, forward): reveal the
  // file in the tree, queue heading scroll, and mirror the note into the URL.
  const applyEntry = useCallback((entry: NavEntry) => {
    pendingHeading.current = entry.heading;
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const p of ancestorFolderPaths(entry.file.path)) next.add(p);
      return next;
    });
    const hash = entry.heading ? `#${slugifyHeading(entry.heading)}` : '';
    const url = `${window.location.pathname}?note=${encodeURIComponent(entry.file.path)}${hash}`;
    window.history.replaceState(null, '', url);
  }, []);

  // Navigate to a note (tree click / internal link): push a new history entry,
  // dropping any forward entries beyond the current cursor. Re-selecting the
  // current note (same file + heading) just re-reveals it without polluting
  // the stack.
  const openFile = useCallback(
    (file: NoteFile, heading: string | null) => {
      const current = cursor >= 0 ? history[cursor] : undefined;
      if (current && current.file.id === file.id && current.heading === heading) {
        applyEntry({ file, heading });
        return;
      }
      setHistory((prev) => [...prev.slice(0, cursor + 1), { file, heading }]);
      setCursor((c) => c + 1);
      applyEntry({ file, heading });
    },
    [cursor, history, applyEntry],
  );

  const goBack = useCallback(() => {
    if (cursor <= 0) return;
    const entry = history[cursor - 1]!;
    setCursor(cursor - 1);
    applyEntry(entry);
  }, [cursor, history, applyEntry]);

  const goForward = useCallback(() => {
    if (cursor >= history.length - 1) return;
    const entry = history[cursor + 1]!;
    setCursor(cursor + 1);
    applyEntry(entry);
  }, [cursor, history, applyEntry]);

  // First load: select the note from `?note=<path>` (deep link / new tab) if it
  // resolves, else a sensible default (README/Welcome, else first).
  useEffect(() => {
    if (selected || markdownFiles.length === 0) return;
    const params = new URLSearchParams(window.location.search);
    const wanted = params.get('note');
    const fromUrl = wanted ? liveFiles.find((f) => f.path === wanted && isMarkdown(f)) : undefined;
    const heading =
      fromUrl && window.location.hash ? decodeURIComponent(window.location.hash.slice(1)) : null;
    const preferred =
      fromUrl ??
      markdownFiles.find((f) => /(^|\/)(readme|welcome|index|home)\.md$/i.test(f.path)) ??
      markdownFiles[0]!;
    openFile(preferred, heading);
  }, [markdownFiles, selected, openFile, liveFiles]);

  // Fetch content whenever the selected file changes (markdown only).
  useEffect(() => {
    if (!selected || !isMarkdown(selected)) {
      setContent('');
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    apiGetText(`/api/projects/${projectId}/files/${selected.id}`, { signal: controller.signal })
      .then((text) => {
        setContent(text);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof ApiError ? err.body.error.message : t('loadError'));
        setLoading(false);
      });
    return () => controller.abort();
  }, [selected, projectId, t]);

  // After content paints, scroll to a pending heading anchor.
  useEffect(() => {
    if (loading || !pendingHeading.current) return;
    const slug = slugifyHeading(pendingHeading.current);
    pendingHeading.current = null;
    if (!slug) return;
    const el = contentRef.current?.querySelector(`#${CSS.escape(slug)}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [content, loading]);

  const onToggleFolder = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // Filter the tree by the query (matches anywhere in the path).
  const visibleFiles = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return liveFiles;
    return liveFiles.filter((f) => f.path.toLowerCase().includes(q));
  }, [liveFiles, query]);

  // When searching, expand every folder so matches are visible.
  const effectiveExpanded = useMemo(() => {
    if (!query.trim()) return expanded;
    const all = new Set<string>();
    for (const f of visibleFiles) for (const p of ancestorFolderPaths(f.path)) all.add(p);
    return all;
  }, [query, expanded, visibleFiles]);

  // Restore the persisted file-panel width.
  useEffect(() => {
    const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    if (Number.isFinite(saved) && saved >= SIDEBAR_MIN && saved <= SIDEBAR_MAX)
      setSidebarWidth(saved);
  }, []);

  // Drag the divider to resize the file panel; persist the width on release.
  const startResize = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = sidebarWidth;
      const onMove = (ev: MouseEvent): void => {
        setSidebarWidth(
          Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startW + (ev.clientX - startX))),
        );
      };
      const onUp = (): void => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        setSidebarWidth((w) => {
          try {
            localStorage.setItem(SIDEBAR_WIDTH_KEY, String(w));
          } catch {
            /* storage may be unavailable; the width still applies for the session */
          }
          return w;
        });
      };
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [sidebarWidth],
  );

  // Download a folder as a .zip (the GET carries the session cookie).
  const downloadFolder = useCallback(
    (folderPath: string) => {
      const a = document.createElement('a');
      a.href = `/api/projects/${projectId}/folders/download?path=${encodeURIComponent(folderPath)}`;
      a.download = '';
      document.body.appendChild(a);
      a.click();
      a.remove();
    },
    [projectId],
  );

  // Как только сервер прислал список без удалённых, локальный фильтр не нужен.
  useEffect(() => {
    if (removed.size === 0) return;
    if (files.some((f) => removed.has(f.id))) return;
    setRemoved(new Set());
  }, [files, removed]);

  // Созданную заметку открываем, когда она доедет со списком с сервера:
  // `router.refresh()` асинхронный, и сразу после `POST` файла в пропе ещё нет.
  useEffect(() => {
    if (!pendingOpen) return;
    const created = liveFiles.find((f) => f.path === pendingOpen);
    if (!created) return;
    setPendingOpen(null);
    openFile(created, null);
  }, [pendingOpen, liveFiles, openFile]);

  const createNote = useCallback(
    async (folder: string, rawName: string) => {
      const name = noteFileName(rawName);
      const path = joinPath(folder, name);
      const form = new FormData();
      form.append('path', path);
      form.append('file', new Blob([''], { type: 'text/markdown' }), name);
      await apiUpload(`/api/projects/${projectId}/files`, form);
      setPendingOpen(path);
      router.refresh();
    },
    [projectId, router],
  );

  const renameTarget = useCallback(
    async (target: MenuTarget, rawName: string) => {
      if (target.kind === 'file') {
        const { id, path } = target.file;
        const newPath = joinPath(dirName(path), keepExtension(baseName(path), rawName));
        if (newPath === path) return;
        await apiPatch(`/api/projects/${projectId}/files/${id}`, { newPath });
        // История хранит копии файлов, а не ссылки на список: без правки
        // строка пути над заметкой осталась бы старой до перезагрузки.
        setHistory((prev) =>
          prev.map((e) => (e.file.id === id ? { ...e, file: { ...e.file, path: newPath } } : e)),
        );
      } else {
        const newPath = joinPath(dirName(target.path), rawName);
        if (newPath === target.path) return;
        await apiPatch(`/api/projects/${projectId}/folders`, { path: target.path, newPath });
        const prefix = `${target.path}/`;
        setHistory((prev) =>
          prev.map((e) =>
            e.file.path.startsWith(prefix)
              ? {
                  ...e,
                  file: { ...e.file, path: `${newPath}/${e.file.path.slice(prefix.length)}` },
                }
              : e,
          ),
        );
      }
      router.refresh();
    },
    [projectId, router],
  );

  const deleteTarget = useCallback(
    async (target: MenuTarget) => {
      const gone = new Set<string>();
      try {
        if (target.kind === 'file') {
          await apiDelete(`/api/projects/${projectId}/files/${target.file.id}`);
          gone.add(target.file.id);
        } else {
          await apiDelete(
            `/api/projects/${projectId}/folders?path=${encodeURIComponent(target.path)}`,
          );
          const prefix = `${target.path}/`;
          for (const f of files) if (f.path.startsWith(prefix)) gone.add(f.id);
        }
      } catch (err) {
        // `ConfirmDialog` ошибку не показывает — выносим её на панель, иначе
        // отказ сервера выглядел бы как молча закрывшийся диалог.
        setActionError(err instanceof ApiError ? err.body.error.message : t('actionFailed'));
        return;
      }
      setRemoved((prev) => new Set([...prev, ...gone]));
      // Удалённое выкидываем из истории и встаём на последнюю уцелевшую
      // заметку; если не уцелело ничего, выбор сделает эффект первой загрузки.
      const next = history.filter((e) => !gone.has(e.file.id));
      setHistory(next);
      setCursor(next.length - 1);
      const last = next[next.length - 1];
      if (last) applyEntry(last);
      router.refresh();
    },
    [projectId, files, history, applyEntry, router, t],
  );

  // Папку создаём не именем, а путём — «/» в имени превратил бы одну заметку
  // в две вложенные, чего пользователь не просил.
  const validateName = useCallback(
    (name: string): string | null => (name.includes('/') ? t('nameInvalid') : null),
    [t],
  );

  const openDialog = useCallback((next: MenuDialog) => {
    setActionError(null);
    setMenuDialog(next);
  }, []);

  // Читателю (VIEWER) остаётся только скачивание: правку сервер всё равно
  // отклонит, а пункты меню, которые всегда падают, — обман.
  const treeActions = useMemo<FileTreeActions>(
    () => ({
      ...(canEdit
        ? {
            onCreateNote: (folder: string) => openDialog({ kind: 'create', folder }),
            onRename: (target: MenuTarget) => openDialog({ kind: 'rename', target }),
            onDelete: (target: MenuTarget) => openDialog({ kind: 'delete', target }),
          }
        : {}),
      onDownloadFolder: downloadFolder,
    }),
    [canEdit, downloadFolder, openDialog],
  );

  const treeLabels = useMemo(
    () => ({
      createNote: t('menuCreateNote'),
      rename: t('menuRename'),
      delete: t('menuDelete'),
      downloadFolder: t('downloadFolder'),
    }),
    [t],
  );

  const target = menuDialog && menuDialog.kind !== 'create' ? menuDialog.target : null;
  const targetName =
    target === null
      ? ''
      : target.kind === 'file'
        ? baseName(target.file.path)
        : baseName(target.path);
  const renameTitle = target?.kind === 'folder' ? t('renameFolderTitle') : t('renameFileTitle');
  // В дереве заметка подписана без `.md`, и в поле ввода она должна выглядеть
  // так же — расширение вернётся при сохранении.
  const renameInitial = target?.kind === 'file' ? targetName.replace(/\.md$/i, '') : targetName;
  const deleteTitle =
    target?.kind === 'folder'
      ? t('deleteFolderTitle', { name: targetName })
      : t('deleteFileTitle', { name: targetName });
  const folderFileCount =
    target?.kind === 'folder'
      ? liveFiles.filter((f) => f.path.startsWith(`${target.path}/`)).length
      : 0;
  const deleteDescription =
    target?.kind === 'folder'
      ? t('deleteFolderDescription', { count: folderFileCount })
      : t('deleteFileDescription');

  return (
    <div className="bg-card flex h-full overflow-hidden rounded-lg border">
      {/* Sidebar */}
      <aside className="flex shrink-0 flex-col" style={{ width: sidebarWidth }}>
        <div className="border-b p-2">
          <div className="relative">
            <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('searchPlaceholder')}
              className="border-input bg-background focus-visible:ring-ring h-8 w-full rounded-md border pr-7 pl-8 text-sm focus-visible:ring-1 focus-visible:outline-none"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2"
                aria-label={t('clearSearch')}
              >
                <XIcon className="size-4" />
              </button>
            )}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-1.5">
          <FileTree
            files={visibleFiles}
            selectedId={selected?.id ?? null}
            expanded={effectiveExpanded}
            onToggleFolder={onToggleFolder}
            onSelectFile={(f) => openFile(f, null)}
            actions={treeActions}
            labels={treeLabels}
          />
        </div>
        {actionError && (
          <p className="text-destructive border-t px-2 py-1.5 text-xs">{actionError}</p>
        )}
      </aside>

      {/* Draggable divider — resize the file panel */}
      <div
        role="separator"
        aria-orientation="vertical"
        onMouseDown={startResize}
        className="group relative w-1.5 shrink-0 cursor-col-resize"
        title={t('resizeHandle')}
      >
        <div className="bg-border mx-auto h-full w-px transition-colors group-hover:bg-sky-500/60" />
      </div>

      {/* Content */}
      <main ref={contentRef} className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {!selected ? (
          <EmptyState text={t('empty')} />
        ) : (
          <>
            {/* Nav arrows + path + edit/view toggle */}
            <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
              <div className="flex min-w-0 items-center gap-1">
                <button
                  type="button"
                  onClick={goBack}
                  disabled={!canBack}
                  aria-label={t('navBack')}
                  title={t('navBack')}
                  className="text-muted-foreground hover:text-foreground hover:bg-accent rounded-md p-1 disabled:pointer-events-none disabled:opacity-30"
                >
                  <ChevronLeftIcon className="size-4" />
                </button>
                <button
                  type="button"
                  onClick={goForward}
                  disabled={!canForward}
                  aria-label={t('navForward')}
                  title={t('navForward')}
                  className="text-muted-foreground hover:text-foreground hover:bg-accent rounded-md p-1 disabled:pointer-events-none disabled:opacity-30"
                >
                  <ChevronRightIcon className="size-4" />
                </button>
                <span className="text-muted-foreground ml-1 truncate font-mono text-xs">
                  {selected.path}
                </span>
              </div>
              {canEdit && isMarkdown(selected) && (
                <button
                  type="button"
                  onClick={() => setEditing((v) => !v)}
                  className="text-muted-foreground hover:text-foreground hover:bg-accent inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs"
                >
                  {editing ? (
                    <>
                      <EyeIcon className="size-3.5" />
                      {t('viewButton')}
                    </>
                  ) : (
                    <>
                      <PencilIcon className="size-3.5" />
                      {t('editButton')}
                    </>
                  )}
                </button>
              )}
            </div>

            {editing && canEdit && isMarkdown(selected) ? (
              <div className="min-h-0 flex-1 px-6 py-3">
                <NoteEditor
                  key={selected.id}
                  projectId={projectId}
                  fileId={selected.id}
                  userName={userName}
                  // The read view shows `content`, fetched once per note —
                  // hand it the editor's text, edits included, on the way out.
                  onExit={setContent}
                />
              </div>
            ) : loading ? (
              <div className="text-muted-foreground flex flex-1 items-center justify-center gap-2 text-sm">
                <LoaderCircleIcon className="size-4 animate-spin" />
                {t('loading')}
              </div>
            ) : error ? (
              <p className="text-destructive p-6 text-sm">{error}</p>
            ) : (
              <div className="flex-1 overflow-y-auto">
                <div className="mx-auto max-w-3xl px-6 py-5">
                  {isMarkdown(selected) ? (
                    <MarkdownView
                      content={content}
                      files={liveFiles}
                      currentFile={selected}
                      projectId={projectId}
                      onNavigate={openFile}
                      labels={{
                        dangling: t('dangling'),
                        loading: t('embedLoading'),
                        error: t('embedError'),
                        circular: t('circularEmbed'),
                        tooDeep: t('embedTooDeep'),
                      }}
                    />
                  ) : isImage(selected) ? (
                    <AuthedImage
                      src={`/api/projects/${projectId}/files/${selected.id}`}
                      alt={selected.path}
                      className="mx-auto max-w-full rounded-md border"
                    />
                  ) : (
                    <BinaryNotice
                      href={`/api/projects/${projectId}/files/${selected.id}`}
                      label={t('binaryDownload')}
                      notice={t('binaryNotice')}
                    />
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </main>

      {/* Диалоги контекстного меню — по одному открытому за раз. */}
      <PromptDialog
        open={menuDialog?.kind === 'create'}
        onOpenChange={(open) => !open && setMenuDialog(null)}
        title={t('createNoteTitle')}
        description={
          menuDialog?.kind === 'create' && menuDialog.folder
            ? t('createNoteIn', { folder: menuDialog.folder })
            : t('createNoteInRoot')
        }
        placeholder={t('namePlaceholder')}
        confirmLabel={t('createConfirm')}
        cancelLabel={t('cancel')}
        validate={validateName}
        onSubmit={(name) =>
          menuDialog?.kind === 'create'
            ? createNote(menuDialog.folder, name)
            : Promise.resolve(undefined)
        }
      />

      <PromptDialog
        open={menuDialog?.kind === 'rename'}
        onOpenChange={(open) => !open && setMenuDialog(null)}
        title={renameTitle}
        initialValue={renameInitial}
        placeholder={t('namePlaceholder')}
        confirmLabel={t('renameConfirm')}
        cancelLabel={t('cancel')}
        validate={validateName}
        onSubmit={(name) =>
          menuDialog?.kind === 'rename'
            ? renameTarget(menuDialog.target, name)
            : Promise.resolve(undefined)
        }
      />

      <ConfirmDialog
        open={menuDialog?.kind === 'delete'}
        onOpenChange={(open) => !open && setMenuDialog(null)}
        title={deleteTitle}
        description={deleteDescription}
        confirmLabel={t('deleteConfirm')}
        cancelLabel={t('cancel')}
        destructive
        onConfirm={() =>
          menuDialog?.kind === 'delete' ? deleteTarget(menuDialog.target) : undefined
        }
      />
    </div>
  );
}

function EmptyState({ text }: { text: string }): ReactElement {
  return (
    <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 text-sm">
      <BookTextIcon className="size-8 opacity-40" />
      {text}
    </div>
  );
}

function BinaryNotice({
  href,
  label,
  notice,
}: {
  href: string;
  label: string;
  notice: string;
}): ReactElement {
  return (
    <div className="text-muted-foreground flex flex-col items-start gap-2 text-sm">
      <p>{notice}</p>
      <a href={href} download className="text-sky-400 hover:underline">
        {label}
      </a>
    </div>
  );
}
