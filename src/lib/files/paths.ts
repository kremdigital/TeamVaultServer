import { isAbsolute, join, normalize, relative, sep } from 'node:path';

export class InvalidPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPathError';
  }
}

/** Our own storage layout — never a legal vault path, in any direction. */
const RESERVED_STORAGE_NAMES = new Set(['.versions', '.staging']);

/**
 * Client-side folders that no vault should publish: a plugin config folder
 * (it holds the server URL and the API key), Obsidian's trash, a repository.
 * The plugin refuses them locally too (`path-utils.ts`), but the server is the
 * shared choke point: REST clients, MCP agents and older plugin builds all
 * pass here, and a path like `.obsidian/plugins/team-vault/data.json` was
 * enough to make another member's client hand over its own settings file
 * (TASK-0027). Checked case-insensitively — `.OBSIDIAN` is the same folder on
 * Windows and macOS.
 *
 * Only *incoming* paths are refused. Reading, listing and deleting keep
 * working for rows an older client already stored, otherwise a leaked file
 * would become impossible to download or clean up — see `allowClientDirs`.
 *
 * A custom Obsidian config folder (the "Override config folder" setting) has
 * an arbitrary name the server cannot know; against that the client-side gate
 * is the only defence.
 */
const RESERVED_CLIENT_NAMES = new Set(['.obsidian', '.trash', '.git']);

/**
 * An 8.3 short name: up to 8 characters ending in `~<digits>`, then
 * optionally a dot and up to 3 more (`OBSIDI~1`, `GIT~1`, `DROPBO~1.CAC`).
 * Group 1 is the part before the extension. Same rule as the plugin's path
 * gate (`src/watcher/path-utils.ts` in TeamVaultPlugin).
 */
const SHORT_NAME_PATTERN = /^([^.\s]*~\d+)(?:\.[^.\s]{1,3})?$/;

/**
 * True for a name that Windows opens as a different file or folder than the
 * one it spells, so no name comparison can vouch for it: any `:` (on NTFS
 * `.obsidian::$INDEX_ALLOCATION` IS the config folder, `name:stream` a stream
 * of `name`; Obsidian forbids `:` on every platform) and any 8.3 short name
 * (`OBSIDI~1/plugins/team-vault/data.json` opens a Windows client's plugin
 * settings, API key included). The server itself runs on Linux, where these
 * names are harmless — it refuses them because it hands paths to Windows
 * clients.
 */
export function isWindowsAlias(segment: string): boolean {
  if (segment.includes(':')) return true;
  const shortName = SHORT_NAME_PATTERN.exec(segment);
  return shortName !== null && (shortName[1] ?? '').length <= 8;
}

/**
 * Characters a Windows disk can't hold in a name (`:` is covered by
 * `isWindowsAlias`), control characters included; NUL is refused earlier.
 */
const WINDOWS_FORBIDDEN_CHARS = /[*?<>"|\u0001-\u001f]/;

/**
 * True for a name a Windows client can't keep as spelled: an alias
 * (`isWindowsAlias`), a forbidden character, or a trailing dot or space —
 * Windows drops those, so `Notes.` and `Notes` are one folder there. Obsidian
 * allows most of these on macOS and Linux; the plugin (0.3.8) refuses them in
 * both directions so that no device uploads a name another can't write, and
 * the server refuses them for every client.
 */
export function isUnsafeForWindows(segment: string): boolean {
  return isWindowsAlias(segment) || WINDOWS_FORBIDDEN_CHARS.test(segment) || /[. ]$/.test(segment);
}

/**
 * Code points HFS+ skips when it compares names, so there `.obs<U+200C>idian`
 * IS `.obsidian` (git's list, CVE-2014-9390).
 */
const HFS_IGNORABLE = /[\u200C-\u200F\u202A-\u202E\u206A-\u206F\uFEFF]/g;

/**
 * The key two names that some client file system opens as the same folder
 * share — the plugin's `nameKey` (src/watcher/path-utils.ts in
 * TeamVaultPlugin): compatibility forms merged (`．obsidian`), full Unicode case
 * folding like case-insensitive APFS (`.obſidian` is `.obsidian`, `ß` is `ss`),
 * the code points HFS+ skips removed. Lower, upper and lower again gets full
 * case folding out of the built-in string functions.
 */
export function nameKey(segment: string): string {
  return segment
    .normalize('NFKC')
    .normalize('NFD')
    .toLowerCase()
    .toUpperCase()
    .toLowerCase()
    .replace(HFS_IGNORABLE, '')
    .normalize('NFC');
}

/** A content hash must be a bare 64-char lowercase hex string — used as a
 *  filename in the staging area, so it must never contain path separators. */
const SHA256_HEX = /^[a-f0-9]{64}$/;

export interface NormalizeOptions {
  /**
   * Allow the client-side reserved folders (`.obsidian`, `.trash`, `.git`).
   * Set for paths that already live in the database — reads, listings,
   * deletions and cleanup — so historical rows stay reachable. Never set it
   * for a path a client is trying to create or move to.
   */
  allowClientDirs?: boolean;
}

/**
 * Normalize and validate a vault-relative file path.
 *
 * - rejects absolute paths, NUL bytes, names with `..`
 * - converts Windows separators to forward slashes
 * - rejects empty segments and reserved folder names
 * - for incoming paths, rejects names Windows resolves to another file
 *   (`isWindowsAlias`)
 */
export function normalizeVaultPath(input: string, opts: NormalizeOptions = {}): string {
  if (input.includes('\0')) {
    throw new InvalidPathError('Path contains NUL byte');
  }
  if (isAbsolute(input)) {
    throw new InvalidPathError('Absolute paths are not allowed');
  }

  // Use posix-style normalization on the input.
  const normalized = normalize(input).replaceAll('\\', '/');
  if (normalized.startsWith('/')) {
    throw new InvalidPathError('Absolute paths are not allowed');
  }

  const segments = normalized.split('/').filter((s) => s.length > 0);
  for (const segment of segments) {
    if (segment === '..') throw new InvalidPathError('Parent traversal is not allowed');
    if (segment === '.') throw new InvalidPathError('Single-dot segments are not allowed');
    const lower = segment.toLowerCase();
    if (RESERVED_STORAGE_NAMES.has(lower)) {
      throw new InvalidPathError(`Reserved folder name: ${segment}`);
    }
    // The rest only for paths a client creates or moves to: a row stored
    // before a rule must stay readable, renamable and removable.
    if (!opts.allowClientDirs) {
      // Compared the way client disks compare names (`nameKey`): otherwise
      // `.obſidian/…` or `．git/…` passes here and a Mac opens the real folder.
      const key = nameKey(segment);
      if (key === '') throw new InvalidPathError('Empty path segment');
      if (RESERVED_STORAGE_NAMES.has(key) || RESERVED_CLIENT_NAMES.has(key)) {
        throw new InvalidPathError(`Reserved folder name: ${segment}`);
      }
      if (isUnsafeForWindows(segment)) {
        throw new InvalidPathError(`Name a Windows client can't keep: ${segment}`);
      }
    }
    if (segment.length > 255) throw new InvalidPathError('Path segment too long');
  }
  if (segments.length === 0) throw new InvalidPathError('Empty path');

  return segments.join('/');
}

export function getStorageRoot(): string {
  return process.env.STORAGE_PATH ?? './storage';
}

/**
 * Resolve a project-relative file path into an absolute filesystem path,
 * guaranteeing the result stays within the project directory.
 */
export function resolveProjectFile(projectId: string, vaultPath: string): string {
  // Resolving an existing path: only the escape-the-root guards apply, so a
  // file an older client stored under `.trash/` can still be read and removed.
  const safe = normalizeVaultPath(vaultPath, { allowClientDirs: true });
  const root = join(getStorageRoot(), projectId);
  const target = join(root, ...safe.split('/'));

  const rel = relative(root, target);
  if (rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
    throw new InvalidPathError('Path escapes project root');
  }
  return target;
}

export function getProjectRoot(projectId: string): string {
  return join(getStorageRoot(), projectId);
}

export function getVersionPath(projectId: string, fileId: string, versionNumber: number): string {
  return join(getProjectRoot(projectId), '.versions', fileId, `${versionNumber}.snapshot`);
}

/**
 * Resolve the staging path for a content-addressed binary blob.
 *
 * Large binary files are uploaded out-of-band over REST into
 * `<projectRoot>/.staging/<contentHash>` and then referenced by a metadata-only
 * `file:create` / `file:update-binary` socket event — keeping multi-megabyte
 * payloads off the Socket.IO channel (which is sized for tiny Yjs ops). The
 * socket handler and the REST process share the storage volume, so the blob
 * written by REST is readable by the socket process by hash.
 */
export function getStagingPath(projectId: string, contentHash: string): string {
  if (!SHA256_HEX.test(contentHash)) {
    throw new InvalidPathError('Invalid content hash');
  }
  return join(getProjectRoot(projectId), '.staging', contentHash);
}
