'use client';

import {
  type ComponentPropsWithoutRef,
  type ReactElement,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from 'react';
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
  type ExtraProps,
} from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import remarkBreaks from 'remark-breaks';
import { ExternalLinkIcon, FileTextIcon, LoaderCircleIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { apiGetText } from '@/lib/api/client';
import { AuthedImage } from './AuthedImage';
import { remarkWikilink } from '@/lib/notes/remark-wikilink';
import {
  resolveWikiTarget,
  resolveRelativeLink,
  isExternalUrl,
  parseWikiTarget,
} from '@/lib/notes/resolve';
import { slugifyHeading } from '@/lib/notes/slug';
import { extractHeadingSection } from '@/lib/notes/section';
import { parseFrontmatter, type NoteProperty } from '@/lib/notes/frontmatter';
import type { NoteFile } from '@/lib/notes/types';

/** Labels for the embed sub-states (kept out of the lib for i18n). */
export interface EmbedLabels {
  dangling: string;
  loading: string;
  error: string;
  circular: string;
  tooDeep: string;
}

/** How deep `![[note]]` transclusion may nest before we stop expanding. */
const MAX_EMBED_DEPTH = 4;

interface MarkdownViewProps {
  content: string;
  files: NoteFile[];
  currentFile: NoteFile;
  projectId: string;
  /** Called for internal links; `heading` is the optional `#anchor`. */
  onNavigate: (file: NoteFile, heading: string | null) => void;
  labels: EmbedLabels;
  /** File ids already being rendered up-chain — guards against embed cycles. */
  ancestors?: Set<string>;
  /** Suppress the frontmatter Properties panel (used inside embeds). */
  hideProperties?: boolean;
}

function fileContentUrl(projectId: string, fileId: string): string {
  return `/api/projects/${projectId}/files/${fileId}`;
}

/**
 * Real, shareable URL for an internal note link: the project page with the
 * target note pre-selected via `?note=<path>` (+ optional `#heading` slug).
 * Used as the anchor `href` so "open in new tab" / cmd-click resolve to the
 * actual document instead of the project root.
 */
function noteHref(projectId: string, path: string, headingSlug?: string): string {
  const base = `/projects/${projectId}?note=${encodeURIComponent(path)}`;
  return headingSlug ? `${base}#${headingSlug}` : base;
}

// Promise-cache for embedded note bodies so the same note fetched from
// several embeds (or re-renders) only hits the network once.
const noteContentCache = new Map<string, Promise<string>>();

function fetchNoteContent(projectId: string, fileId: string): Promise<string> {
  const key = `${projectId}:${fileId}`;
  let pending = noteContentCache.get(key);
  if (!pending) {
    pending = apiGetText(fileContentUrl(projectId, fileId)).catch((err: unknown) => {
      noteContentCache.delete(key); // let a later mount retry after failure
      throw err;
    });
    noteContentCache.set(key, pending);
  }
  return pending;
}

/** Allow our custom protocols through; sanitize everything else as usual. */
function transformUrl(url: string): string {
  if (url.startsWith('wikilink:') || url.startsWith('wikiembed:')) return url;
  return defaultUrlTransform(url);
}

/** Flattens a hast element's text content (used to slug headings). */
function hastText(node: unknown): string {
  const n = node as { type?: string; value?: string; children?: unknown[] };
  if (!n) return '';
  if (n.type === 'text') return n.value ?? '';
  if (Array.isArray(n.children)) return n.children.map(hastText).join('');
  return '';
}

/** Heading renderers add an id slug so `#anchor` links can scroll to them. */
function makeHeading(Tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6') {
  function Heading({ node, children }: ComponentPropsWithoutRef<'h1'> & ExtraProps): ReactElement {
    return (
      <Tag id={slugifyHeading(hastText(node))} className="scroll-mt-4">
        {children}
      </Tag>
    );
  }
  Heading.displayName = `Heading(${Tag})`;
  return Heading;
}

const HEADINGS = {
  h1: makeHeading('h1'),
  h2: makeHeading('h2'),
  h3: makeHeading('h3'),
  h4: makeHeading('h4'),
  h5: makeHeading('h5'),
  h6: makeHeading('h6'),
} as const;

/**
 * Read-only Obsidian-style markdown renderer. Resolves `[[wikilinks]]`,
 * `![[embeds]]`, and relative markdown links/images against the project's
 * file index, turning internal links into in-app navigation and pointing
 * images at the authenticated file-content endpoint.
 */
export function MarkdownView({
  content,
  files,
  currentFile,
  projectId,
  onNavigate,
  labels,
  ancestors,
  hideProperties,
}: MarkdownViewProps): ReactElement {
  const embedAncestors = useMemo(
    () => new Set([...(ancestors ?? []), currentFile.id]),
    [ancestors, currentFile.id],
  );

  const components = useMemo<Components>(() => {
    return {
      ...HEADINGS,

      // A paragraph that is nothing but a note embed becomes a block
      // transclusion. Anything else renders as a normal paragraph (so
      // inline embeds fall back to the link form handled by `a`).
      p({ node, children }: ComponentPropsWithoutRef<'p'> & ExtraProps) {
        const embed = soleEmbedInner(node);
        if (embed) {
          return (
            <EmbeddedNote
              key={embed}
              inner={embed}
              files={files}
              projectId={projectId}
              onNavigate={onNavigate}
              ancestors={embedAncestors}
              labels={labels}
            />
          );
        }
        return <p>{children}</p>;
      },

      a({ href, children }: ComponentPropsWithoutRef<'a'> & ExtraProps) {
        const raw = href ?? '';

        // Wiki link / embed-as-link.
        if (raw.startsWith('wikilink:') || raw.startsWith('wikiembed:')) {
          const inner = safeDecode(raw.slice(raw.indexOf(':') + 1));
          const { target, heading: hd } = parseWikiTarget(inner);
          // Heading-only link → jump within the current note.
          if (!target) {
            return (
              <InternalLink
                href={noteHref(projectId, currentFile.path, slugifyHeading(hd ?? ''))}
                onActivate={() => onNavigate(currentFile, hd)}
              >
                {children}
              </InternalLink>
            );
          }
          const resolved = resolveWikiTarget(target, files);
          if (!resolved) return <DanglingLink title={labels.dangling}>{children}</DanglingLink>;
          return (
            <InternalLink
              href={noteHref(projectId, resolved.path, hd ? slugifyHeading(hd) : undefined)}
              onActivate={() => onNavigate(resolved, hd)}
            >
              {children}
            </InternalLink>
          );
        }

        // External URL.
        if (isExternalUrl(raw)) {
          return (
            <a
              href={raw}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="inline-flex items-center gap-0.5 text-sky-400 hover:underline"
            >
              {children}
              <ExternalLinkIcon className="size-3 opacity-70" />
            </a>
          );
        }

        // Relative markdown link.
        const hashIdx = raw.indexOf('#');
        const anchor = hashIdx === -1 ? null : raw.slice(hashIdx + 1);
        const resolved = resolveRelativeLink(raw, currentFile.path, files);
        if (!resolved) return <DanglingLink title={labels.dangling}>{children}</DanglingLink>;
        return (
          <InternalLink
            href={noteHref(projectId, resolved.path, anchor ? slugifyHeading(anchor) : undefined)}
            onActivate={() => onNavigate(resolved, anchor)}
          >
            {children}
          </InternalLink>
        );
      },

      img({ src, alt }: ComponentPropsWithoutRef<'img'> & ExtraProps) {
        const resolvedSrc = resolveImageSrc(
          typeof src === 'string' ? src : '',
          currentFile.path,
          files,
          projectId,
        );
        if (!resolvedSrc) {
          return <span className="text-muted-foreground text-sm italic">[{alt || 'image'}]</span>;
        }
        return (
          <AuthedImage
            src={resolvedSrc}
            alt={alt ?? ''}
            loading="lazy"
            className="my-2 max-w-full rounded-md border"
          />
        );
      },
    };
  }, [files, currentFile, projectId, onNavigate, labels, embedAncestors]);

  const { properties, body } = useMemo(() => parseFrontmatter(content), [content]);

  return (
    <>
      {!hideProperties && properties.length > 0 && <PropertiesPanel properties={properties} />}
      <div className={cn('markdown-body')}>
        {/* `remarkBreaks`: a single newline is a line break, as in Obsidian with
            "Strict line breaks" off (its default). Plain CommonMark folds such
            lines into one paragraph — notes read fine in Obsidian but ran
            together here. */}
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkFrontmatter, remarkWikilink, remarkBreaks]}
          urlTransform={transformUrl}
          components={components}
          skipHtml
        >
          {body}
        </ReactMarkdown>
      </div>
    </>
  );
}

/** Obsidian-style read-only properties table for YAML frontmatter. */
function PropertiesPanel({ properties }: { properties: NoteProperty[] }): ReactElement {
  return (
    <dl className="mb-5 grid grid-cols-[minmax(6rem,9rem)_1fr] gap-x-3 gap-y-1.5 border-b pb-4 text-sm">
      {properties.map((p) => (
        <div key={p.key} className="contents">
          <dt className="text-muted-foreground truncate py-0.5">{p.key}</dt>
          <dd className="flex min-w-0 flex-wrap items-center gap-1.5">
            {Array.isArray(p.value) ? (
              p.value.length === 0 ? (
                <span className="text-muted-foreground">—</span>
              ) : (
                p.value.map((v, i) => (
                  <span
                    key={`${v}-${i}`}
                    className="bg-accent text-accent-foreground rounded px-1.5 py-0.5 text-xs"
                  >
                    {v}
                  </span>
                ))
              )
            ) : (
              <span className="break-words">{p.value || '—'}</span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Internal note link. The `href` is a real, shareable project URL so the
 * browser's "open in new tab" / cmd-click open the linked document directly.
 * A plain left-click is intercepted for in-pane SPA navigation; modifier or
 * non-primary clicks fall through to the browser (new tab/window).
 */
function InternalLink({
  href,
  onActivate,
  children,
}: {
  href: string;
  onActivate: () => void;
  children?: ReactNode;
}): ReactElement {
  return (
    <a
      href={href}
      className="text-sky-400 no-underline hover:underline"
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        onActivate();
      }}
    >
      {children}
    </a>
  );
}

function DanglingLink({ title, children }: { title: string; children?: ReactNode }): ReactElement {
  return (
    <span
      className="text-muted-foreground cursor-not-allowed underline decoration-dotted"
      title={title}
    >
      {children}
    </span>
  );
}

interface HastElement {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastElement[];
}

/**
 * If a paragraph's only meaningful content is a single note embed
 * (`wikiembed:` link), returns its decoded inner target; otherwise null.
 * Whitespace-only text siblings are ignored so `![[Note]]` on its own line
 * still counts as standalone.
 */
function soleEmbedInner(node: unknown): string | null {
  const el = node as HastElement;
  const kids = (el?.children ?? []).filter(
    (c) => !(c.type === 'text' && (c.value ?? '').trim() === ''),
  );
  if (kids.length !== 1) return null;
  const only = kids[0]!;
  if (only.tagName !== 'a') return null;
  const href = only.properties?.['href'];
  if (typeof href !== 'string' || !href.startsWith('wikiembed:')) return null;
  return safeDecode(href.slice('wikiembed:'.length));
}

interface EmbeddedNoteProps {
  inner: string;
  files: NoteFile[];
  projectId: string;
  onNavigate: (file: NoteFile, heading: string | null) => void;
  ancestors: Set<string>;
  labels: EmbedLabels;
}

/**
 * Obsidian-style block transclusion for `![[Note]]` / `![[Note#Heading]]`.
 * Resolves the target, fetches its body (whole note or a single heading
 * section), and renders it inside a titled callout via a nested MarkdownView.
 * Guards against unresolved targets, self/cyclic embeds, and runaway depth.
 */
function EmbeddedNote({
  inner,
  files,
  projectId,
  onNavigate,
  ancestors,
  labels,
}: EmbeddedNoteProps): ReactElement {
  const { target, heading } = parseWikiTarget(inner);
  const file = resolveWikiTarget(target, files);

  // Single status object so the effect only ever sets state asynchronously
  // (in the fetch callbacks). The embed is keyed by its inner target up in
  // the `p` renderer, so a changed target remounts this with fresh state
  // rather than needing a synchronous reset here.
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error'; content: string }>({
    status: 'loading',
    content: '',
  });

  const blocked = !file || ancestors.has(file.id) || ancestors.size > MAX_EMBED_DEPTH;
  const fileId = file?.id;

  useEffect(() => {
    if (!fileId || blocked) return;
    let active = true;
    fetchNoteContent(projectId, fileId)
      .then((text) => {
        if (active) setState({ status: 'ready', content: text });
      })
      .catch(() => {
        if (active) setState({ status: 'error', content: '' });
      });
    return () => {
      active = false;
    };
  }, [fileId, blocked, projectId]);

  if (!file) {
    return <EmbedBox title={target}>{labels.dangling}</EmbedBox>;
  }
  if (ancestors.has(file.id)) {
    return <EmbedBox title={file.path}>{labels.circular}</EmbedBox>;
  }
  if (ancestors.size > MAX_EMBED_DEPTH) {
    return <EmbedBox title={file.path}>{labels.tooDeep}</EmbedBox>;
  }

  const title = file.path.replace(/\.md$/i, '');
  const header = (
    <button
      type="button"
      onClick={() => onNavigate(file, heading)}
      className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-xs font-medium"
    >
      <FileTextIcon className="size-3.5" />
      {heading ? `${title} › ${heading}` : title}
    </button>
  );

  if (state.status === 'error') {
    return <EmbedBox header={header}>{labels.error}</EmbedBox>;
  }
  if (state.status === 'loading') {
    return (
      <EmbedBox header={header}>
        <span className="text-muted-foreground inline-flex items-center gap-1.5">
          <LoaderCircleIcon className="size-3.5 animate-spin" />
          {labels.loading}
        </span>
      </EmbedBox>
    );
  }

  const body = heading
    ? (extractHeadingSection(state.content, slugifyHeading(heading)) ?? state.content)
    : state.content;

  return (
    <EmbedBox header={header}>
      <MarkdownView
        content={body}
        files={files}
        currentFile={file}
        projectId={projectId}
        onNavigate={onNavigate}
        labels={labels}
        ancestors={ancestors}
        hideProperties
      />
    </EmbedBox>
  );
}

/** Callout chrome shared by every embed state (loaded, loading, error). */
function EmbedBox({
  title,
  header,
  children,
}: {
  title?: string;
  header?: ReactNode;
  children?: ReactNode;
}): ReactElement {
  return (
    <div className="note-embed border-border bg-muted/30 my-3 rounded-md border-l-2 py-2 pr-3 pl-3">
      <div className="mb-1.5">
        {header ?? (
          <span className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium">
            <FileTextIcon className="size-3.5" />
            {title}
          </span>
        )}
      </div>
      <div className="text-sm">{children}</div>
    </div>
  );
}

function resolveImageSrc(
  src: string,
  currentPath: string,
  files: NoteFile[],
  projectId: string,
): string | null {
  if (!src) return null;
  if (src.startsWith('wikiembed:')) {
    const inner = safeDecode(src.slice('wikiembed:'.length));
    const { target } = parseWikiTarget(inner);
    const file = resolveWikiTarget(target, files);
    return file ? fileContentUrl(projectId, file.id) : null;
  }
  if (isExternalUrl(src)) {
    // Only http(s) data is allowed through for safety.
    return /^https?:\/\//i.test(src) ? src : null;
  }
  const file = resolveRelativeLink(src, currentPath, files);
  return file ? fileContentUrl(projectId, file.id) : null;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
