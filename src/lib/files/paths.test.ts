// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { InvalidPathError, normalizeVaultPath, resolveProjectFile } from './paths';

describe('normalizeVaultPath', () => {
  it('accepts simple paths', () => {
    expect(normalizeVaultPath('note.md')).toBe('note.md');
    expect(normalizeVaultPath('folder/sub/file.md')).toBe('folder/sub/file.md');
  });

  it('normalizes Windows separators and double slashes', () => {
    expect(normalizeVaultPath('folder\\sub\\file.md')).toBe('folder/sub/file.md');
    expect(normalizeVaultPath('a//b///c')).toBe('a/b/c');
  });

  it('rejects parent traversal', () => {
    expect(() => normalizeVaultPath('../etc/passwd')).toThrow(InvalidPathError);
    expect(() => normalizeVaultPath('a/../../b')).toThrow(InvalidPathError);
    expect(() => normalizeVaultPath('a/..')).toThrow(InvalidPathError);
  });

  it('rejects absolute paths', () => {
    expect(() => normalizeVaultPath('/etc/passwd')).toThrow(InvalidPathError);
  });

  it('rejects NUL bytes', () => {
    expect(() => normalizeVaultPath('a\0b')).toThrow(InvalidPathError);
  });

  it('rejects reserved .versions folder', () => {
    expect(() => normalizeVaultPath('.versions/x')).toThrow(InvalidPathError);
    expect(() => normalizeVaultPath('a/.versions/b')).toThrow(InvalidPathError);
  });

  /**
   * Клиентские папки — вторая половина гейта путей (TASK-0027, аудит перед
   * подачей в каталог). Путь `.obsidian/plugins/team-vault/data.json`,
   * созданный участником проекта, заставлял клиент другого участника отдать
   * собственный файл настроек вместе с API-ключом. Запрет только на входящих
   * путях: уже сохранённые строки должны оставаться читаемыми и удаляемыми,
   * иначе утёкший файл нечем убрать.
   */
  it('rejects client-side folders: config, trash, repository', () => {
    expect(() => normalizeVaultPath('.obsidian/plugins/team-vault/data.json')).toThrow(
      /Reserved folder name/,
    );
    expect(() => normalizeVaultPath('.trash/deleted.md')).toThrow(/Reserved folder name/);
    expect(() => normalizeVaultPath('notes/.git/HEAD')).toThrow(/Reserved folder name/);
  });

  it('rejects reserved folders regardless of case', () => {
    expect(() => normalizeVaultPath('.OBSIDIAN/plugins/team-vault/data.json')).toThrow(
      /Reserved folder name/,
    );
    expect(() => normalizeVaultPath('.Trash/note.md')).toThrow(/Reserved folder name/);
  });

  it('keeps notes whose name merely resembles a reserved folder', () => {
    expect(normalizeVaultPath('.obsidian-notes/idea.md')).toBe('.obsidian-notes/idea.md');
    expect(normalizeVaultPath('notes/.gitignore')).toBe('notes/.gitignore');
    expect(normalizeVaultPath('.trashed.md')).toBe('.trashed.md');
  });

  it('allows client folders for paths already stored (reads, cleanup)', () => {
    expect(normalizeVaultPath('.trash/deleted.md', { allowClientDirs: true })).toBe(
      '.trash/deleted.md',
    );
    expect(
      normalizeVaultPath('.obsidian/plugins/team-vault/data.json', { allowClientDirs: true }),
    ).toBe('.obsidian/plugins/team-vault/data.json');
    // Раскладка хранилища сервера остаётся запрещённой в обе стороны.
    expect(() => normalizeVaultPath('.versions/x', { allowClientDirs: true })).toThrow(
      InvalidPathError,
    );
  });

  it('rejects names Windows resolves to another file, on incoming paths', () => {
    for (const path of [
      '.obsidian::$INDEX_ALLOCATION/plugins/team-vault/data.json',
      'desktop.ini::$DATA',
      'notes/a:b.md',
      'OBSIDI~1/plugins/team-vault/data.json',
      'GIT~1/hooks/pre-commit',
      'docs/DROPBO~1.CAC',
      'obsidi~1/x.md',
    ]) {
      expect(() => normalizeVaultPath(path), path).toThrow(InvalidPathError);
    }
  });

  it('rejects names a Windows client cannot keep, on incoming paths', () => {
    for (const path of [
      'Why?.md',
      'a*b.md',
      'a<b.md',
      'a>b.md',
      'a"b.md',
      'a|b.md',
      'x\u0001.md',
      'Notes./x.md',
      'Notes /x.md',
      'note.md.',
    ]) {
      expect(() => normalizeVaultPath(path), JSON.stringify(path)).toThrow(InvalidPathError);
      expect(normalizeVaultPath(path, { allowClientDirs: true }), JSON.stringify(path)).toBe(path);
    }
  });

  it('rejects client folders spelled the way a Mac or a NAS opens as the real one', () => {
    for (const path of [
      '.obſidian/plugins/team-vault/data.json',
      '．git/hooks/pre-commit',
      '.ＧＩＴ/config',
      '.tra\u200Csh/x.md',
    ]) {
      expect(() => normalizeVaultPath(path), JSON.stringify(path)).toThrow(InvalidPathError);
    }
    expect(() => normalizeVaultPath('\u200C\uFEFF/x.md')).toThrow(InvalidPathError);
  });

  it('keeps ordinary names with non-ASCII letters', () => {
    expect(normalizeVaultPath('Straße/Übersicht.md')).toBe('Straße/Übersicht.md');
    expect(normalizeVaultPath('заметки/Ёлка.md')).toBe('заметки/Ёлка.md');
    expect(normalizeVaultPath('日記/メモ.md')).toBe('日記/メモ.md');
  });

  it('keeps names that only look like a Windows short name', () => {
    // Longer than 8 before the `~`, or `~` not followed by digits only.
    expect(normalizeVaultPath('Chapter~1.md')).toBe('Chapter~1.md');
    expect(normalizeVaultPath('notes/draft~final.md')).toBe('notes/draft~final.md');
    expect(normalizeVaultPath('a~1.markdown')).toBe('a~1.markdown');
    expect(normalizeVaultPath('~/readme.md')).toBe('~/readme.md');
  });

  it('still reads a stored row whose name Windows would alias', () => {
    expect(normalizeVaultPath('notes/a:b.md', { allowClientDirs: true })).toBe('notes/a:b.md');
    expect(normalizeVaultPath('DRAFT~1.md', { allowClientDirs: true })).toBe('DRAFT~1.md');
  });

  it('rejects empty input', () => {
    expect(() => normalizeVaultPath('')).toThrow(InvalidPathError);
    expect(() => normalizeVaultPath('/')).toThrow(InvalidPathError);
  });
});

describe('resolveProjectFile', () => {
  it('produces a path inside the project root', () => {
    process.env.STORAGE_PATH = '/tmp/storage';
    const resolved = resolveProjectFile('proj-1', 'note.md');
    expect(resolved.replaceAll('\\', '/')).toContain('proj-1/note.md');
  });

  it('refuses traversal even after normalization', () => {
    process.env.STORAGE_PATH = '/tmp/storage';
    expect(() => resolveProjectFile('proj-1', '../../etc/passwd')).toThrow(InvalidPathError);
  });

  it('still resolves a legacy path under a client folder', () => {
    // Строка могла попасть в БД до запрета — скачать и удалить её должно быть
    // можно, иначе утёкший `data.json` не вычистить ничем, кроме правки БД.
    process.env.STORAGE_PATH = '/tmp/storage';
    const resolved = resolveProjectFile('proj-1', '.trash/note.md');
    expect(resolved.replaceAll('\\', '/')).toContain('proj-1/.trash/note.md');
  });
});
