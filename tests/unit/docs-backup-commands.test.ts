// @vitest-environment node
/**
 * Разовые бэкапы на проде кладутся в `/var/backups/team-vault`, а таймер
 * `team-vault-prune-backups` удаляет оттуда всё, у чего mtime старше 30 суток
 * (`find -mtime +30`, по каждому файлу). Копия, снятая с сохранением времени
 * (`cp -a`, `cp -p`, `rsync -a`, `install -p`), наследует mtime исходника. Если
 * исходник не менялся больше месяца, а это обычное дело для
 * `/etc/caddy/Caddyfile`, бэкап исчезнет при ближайшем прогоне таймера, хотя
 * документация обещает 30 суток.
 *
 * Тест проходит по командам в блоках кода документации (`README.md`, `docs/`)
 * и не даёт вернуть такую копию в инструкции. Целью считается и путь
 * `/var/backups/…`, и переменная, которой этот путь присвоен в том же блоке
 * (`BACKUP=/var/backups/…; cp … "$BACKUP"`).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const BACKUP_ROOT = '/var/backups';

const docs = [
  'README.md',
  ...readdirSync(join(ROOT, 'docs'), { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.md'))
    .map((f) => join('docs', f)),
];

/** Содержимое блоков ```…``` документа. */
function codeBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)].map((m) => m[1] ?? '');
}

/**
 * Простые команды блока: продолжения строк `\` склеены, комментарии сняты,
 * цепочки разрезаны по `&&`, `||`, `;` и `|`.
 */
function simpleCommands(block: string): string[] {
  return block
    .replace(/\\\r?\n/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)#.*$/, ''))
    .flatMap((line) => line.split(/&&|\|\||;|\|/))
    .map((cmd) => cmd.trim())
    .filter(Boolean);
}

/** Переменные блока, которым присвоен путь внутри /var/backups. */
function backupVariables(commands: string[]): string[] {
  return commands.flatMap((cmd) => {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(\S+)/.exec(cmd);
    return m?.[1] && m[2]?.includes(BACKUP_ROOT) ? [m[1]] : [];
  });
}

function writesToBackups(cmd: string, variables: string[]): boolean {
  if (cmd.includes(BACKUP_ROOT)) return true;
  return variables.some((v) => cmd.includes(`$${v}`) || cmd.includes(`\${${v}}`));
}

/** Флаг копирования, который переносит mtime исходника на копию, или null. */
function timestampPreservingFlag(cmd: string): string | null {
  const words = cmd.split(/\s+/).map((w) => w.replace(/^['"]|['"]$/g, ''));
  const [tool, ...args] = words[0] === 'sudo' ? words.slice(1) : words;
  const shortFlags: Record<string, string> = { cp: 'ap', rsync: 'at', install: 'p' };
  const longFlags: Record<string, RegExp> = {
    cp: /^--(archive|preserve(=.*(timestamps|all).*)?)$/,
    rsync: /^--(archive|times)$/,
    install: /^--preserve-timestamps$/,
  };
  const short = tool ? shortFlags[tool] : undefined;
  const long = tool ? longFlags[tool] : undefined;
  if (short === undefined || long === undefined) return null;
  for (const arg of args) {
    if (long.test(arg)) return arg;
    if (/^-[A-Za-z]+$/.test(arg) && [...arg.slice(1)].some((c) => short.includes(c))) return arg;
  }
  return null;
}

/** Команды копирования в /var/backups из всех блоков кода документа. */
function backupCopies(markdown: string): string[] {
  return codeBlocks(markdown).flatMap((block) => {
    const commands = simpleCommands(block);
    const variables = backupVariables(commands);
    return commands.filter(
      (cmd) => /^(sudo\s+)?(cp|rsync|install)\s/.test(cmd) && writesToBackups(cmd, variables),
    );
  });
}

describe('документация: бэкапы в /var/backups не наследуют старый mtime', () => {
  it('в README есть хотя бы одна команда бэкапа — проверке есть что проверять', () => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    expect(backupCopies(readme).length).toBeGreaterThan(0);
  });

  it.each(docs)('%s: копии в /var/backups без -a / -p / --preserve', (doc) => {
    const copies = backupCopies(readFileSync(join(ROOT, doc), 'utf8'));
    const offending = copies.filter((cmd) => timestampPreservingFlag(cmd) !== null);
    expect(offending).toEqual([]);
  });

  it('разбор флагов ловит сохранение времени у cp, rsync и install', () => {
    expect(timestampPreservingFlag('sudo cp -a /etc/caddy/Caddyfile /var/backups/x')).toBe('-a');
    expect(timestampPreservingFlag('cp -rp dir /var/backups/x')).toBe('-rp');
    expect(timestampPreservingFlag('cp --preserve /a /var/backups/x')).toBe('--preserve');
    expect(timestampPreservingFlag('cp --preserve=mode,timestamps /a /b')).not.toBeNull();
    expect(timestampPreservingFlag('rsync -av /a /var/backups/x')).toBe('-av');
    expect(timestampPreservingFlag('sudo install -pm 0644 /a /var/backups/x')).toBe('-pm');

    expect(timestampPreservingFlag('sudo cp /a /var/backups/x')).toBeNull();
    expect(timestampPreservingFlag('cp --preserve=mode,ownership /a /b')).toBeNull();
    expect(timestampPreservingFlag('sudo install -d -m 0750 /var/backups/team-vault')).toBeNull();
    expect(timestampPreservingFlag('sudo install -m 0644 /a "$BACKUP"')).toBeNull();
  });

  it('целью считается и переменная с путём в /var/backups', () => {
    const block = [
      '```bash',
      'BACKUP=/var/backups/team-vault/Caddyfile.before-$(date +%F-%H%M%S)',
      'sudo install -d -m 0750 /var/backups/team-vault \\',
      '  && sudo cp -a /etc/caddy/Caddyfile "$BACKUP" \\',
      '  && sudo systemctl reload caddy',
      '```',
    ].join('\n');
    expect(backupCopies(block)).toEqual([
      'sudo install -d -m 0750 /var/backups/team-vault',
      'sudo cp -a /etc/caddy/Caddyfile "$BACKUP"',
    ]);
  });
});
