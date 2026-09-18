import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MarkdownView, type EmbedLabels } from './MarkdownView';
import { apiGetText } from '@/lib/api/client';
import type { NoteFile } from '@/lib/notes/types';

vi.mock('@/lib/api/client', () => ({ apiGetText: vi.fn() }));
const mockedGetText = vi.mocked(apiGetText);

const files: NoteFile[] = [
  { id: 'welcome', path: 'Welcome.md', fileType: 'TEXT', mimeType: null },
  { id: 'beta', path: 'projects/Beta.md', fileType: 'TEXT', mimeType: null },
  { id: 'logo', path: 'assets/logo.png', fileType: 'BINARY', mimeType: 'image/png' },
];
const current = files[0]!;

const LABELS: EmbedLabels = {
  dangling: 'dangling',
  loading: 'loading',
  error: 'error',
  circular: 'circular',
  tooDeep: 'too deep',
};

function renderView(content: string, onNavigate = vi.fn()) {
  render(
    <MarkdownView
      content={content}
      files={files}
      currentFile={current}
      projectId="P1"
      onNavigate={onNavigate}
      labels={LABELS}
    />,
  );
  return { onNavigate };
}

describe('MarkdownView', () => {
  it('renders a resolvable wikilink as a clickable internal link', () => {
    const { onNavigate } = renderView('See [[projects/Beta|Beta]] here');
    const link = screen.getByText('Beta');
    expect(link.tagName).toBe('A');
    fireEvent.click(link);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(onNavigate.mock.calls[0]![0]).toMatchObject({ id: 'beta' });
    expect(onNavigate.mock.calls[0]![1]).toBeNull();
  });

  it('passes the heading anchor when a wikilink has one', () => {
    const { onNavigate } = renderView('[[projects/Beta#Intro]]');
    fireEvent.click(screen.getByText('projects/Beta › Intro'));
    expect(onNavigate.mock.calls[0]![1]).toBe('Intro');
  });

  it('renders a dangling wikilink as a non-link span', () => {
    renderView('[[DoesNotExist]]');
    const el = screen.getByText('DoesNotExist');
    expect(el.tagName).toBe('SPAN');
    expect(el).toHaveAttribute('title', 'dangling');
  });

  it('renders external links with target=_blank', () => {
    renderView('[site](https://example.com)');
    const link = screen.getByText('site').closest('a')!;
    expect(link).toHaveAttribute('href', 'https://example.com');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('resolves relative markdown links to internal navigation', () => {
    const { onNavigate } = renderView('[go](projects/Beta.md)');
    fireEvent.click(screen.getByText('go'));
    expect(onNavigate.mock.calls[0]![0]).toMatchObject({ id: 'beta' });
  });

  it('slugifies heading ids for anchor scrolling', () => {
    const { container } = renderHtml('## Hello World');
    expect(container.querySelector('h2')?.id).toBe('hello-world');
  });

  it('points image embeds at the file-content endpoint', () => {
    const { container } = renderHtml('![[logo.png]]');
    const img = container.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('/api/projects/P1/files/logo');
  });

  it('renders GFM tables', () => {
    renderView('| A | B |\n| - | - |\n| 1 | 2 |');
    expect(screen.getByText('A').tagName).toBe('TH');
  });

  it('renders frontmatter as a properties panel and hides it from the body', () => {
    renderView('---\ntitle: My Note\ntags:\n  - x\n  - y\n---\n# Heading');
    expect(screen.getByText('title')).toBeInTheDocument();
    expect(screen.getByText('My Note')).toBeInTheDocument();
    expect(screen.getByText('x')).toBeInTheDocument();
    // The raw `---` fence must not leak into the rendered body.
    expect(screen.queryByText('---')).not.toBeInTheDocument();
  });

  it('keeps single line breaks, as Obsidian does by default', () => {
    // Plain CommonMark folds these into one line: «один два три».
    const { container } = render(
      <MarkdownView
        content={'один\nдва\nтри\n\nновый абзац'}
        files={files}
        currentFile={current}
        projectId="P1"
        onNavigate={vi.fn()}
        labels={LABELS}
      />,
    );
    const paragraphs = container.querySelectorAll('p');
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]!.querySelectorAll('br')).toHaveLength(2);
    expect(paragraphs[0]!.textContent).toBe('один\nдва\nтри');
    expect(paragraphs[1]!.textContent).toBe('новый абзац');
  });
});

/** Renders with an isolated projectId so the note-content cache key is unique. */
function renderEmbed(content: string, projectId: string, onNavigate = vi.fn()) {
  render(
    <MarkdownView
      content={content}
      files={files}
      currentFile={current}
      projectId={projectId}
      onNavigate={onNavigate}
      labels={LABELS}
    />,
  );
  return { onNavigate };
}

describe('MarkdownView — note transclusion', () => {
  it('inlines a standalone note embed as a block with its body and title', async () => {
    mockedGetText.mockResolvedValue('Embedded beta body.');
    renderEmbed('![[projects/Beta]]', 'E1');
    expect(await screen.findByText('Embedded beta body.')).toBeInTheDocument();
    // Header shows the embedded note's title (path without .md).
    expect(screen.getByText('projects/Beta')).toBeInTheDocument();
  });

  it('inlines only the requested heading section of an embed', async () => {
    mockedGetText.mockResolvedValue('# Top\n\ntop body\n\n## Section\n\nsection body');
    renderEmbed('![[projects/Beta#Section]]', 'E2');
    expect(await screen.findByText('section body')).toBeInTheDocument();
    expect(screen.queryByText('top body')).not.toBeInTheDocument();
  });

  it('shows a dangling box for an embed whose target is missing', () => {
    renderEmbed('![[Nope]]', 'E3');
    expect(screen.getByText('dangling')).toBeInTheDocument();
  });

  it('navigates when the embed header is clicked', async () => {
    mockedGetText.mockResolvedValue('body');
    const { onNavigate } = renderEmbed('![[projects/Beta]]', 'E4');
    fireEvent.click(await screen.findByText('projects/Beta'));
    expect(onNavigate.mock.calls[0]![0]).toMatchObject({ id: 'beta' });
  });
});

/** Variant returning the container for DOM-shape assertions. */
function renderHtml(content: string) {
  return render(
    <MarkdownView
      content={content}
      files={files}
      currentFile={current}
      projectId="P1"
      onNavigate={vi.fn()}
      labels={LABELS}
    />,
  );
}
