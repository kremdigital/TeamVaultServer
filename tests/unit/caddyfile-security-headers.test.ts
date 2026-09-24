// @vitest-environment node
/**
 * Заголовки безопасности прода задаются не в коде, а в шаблоне
 * `config/Caddyfile.example`: `install.sh` рендерит его через `envsubst` в
 * `/etc/caddy/Caddyfile`. Поэтому договорённости о них проверяются здесь, по
 * самому шаблону:
 *
 * - HSTS — год и `includeSubDomains`, но без `preload`: preload необратим на
 *   месяцы и включается только отдельным решением, случайно его не добавить;
 * - фрейминг запрещён согласованно: `X-Frame-Options: DENY` и CSP
 *   `frame-ancestors 'none'` — два правила для старых и новых браузеров не
 *   должны разойтись;
 * - блок заголовков стоит на уровне site-блока, а не внутри `handle`, иначе
 *   ответы одного из процессов (web или socket) останутся без заголовков;
 * - других директив `header` в шаблоне нет, и заголовки безопасности нигде
 *   больше не упоминаются: однострочный `header` в site-блоке или в `handle`
 *   (как и `header_down` у `reverse_proxy`) молча перебил бы или снял значения
 *   блока, а разбор одного блока этого не увидел бы;
 * - в шаблоне нет переменных, которых `install.sh` не подставит: `envsubst` со
 *   списком оставит чужой `${VAR}` как есть, и Caddy получит мусор.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const template = readFileSync(join(ROOT, 'config', 'Caddyfile.example'), 'utf8');
const installScript = readFileSync(join(ROOT, 'scripts', 'install.sh'), 'utf8');

/** Заголовки, которые задаёт блок `header { … }` и больше никто. */
const SECURITY_HEADERS = [
  'Strict-Transport-Security',
  'X-Content-Type-Options',
  'X-Frame-Options',
  'Content-Security-Policy',
  'Referrer-Policy',
  'Permissions-Policy',
] as const;

/** Строки шаблона без комментариев: в них `${VAR}` упоминается как текст. */
const codeLines = template
  .split(/\r?\n/)
  .map((line) => line.replace(/#.*$/, ''))
  .filter((line) => line.trim() !== '');

const HEADER_BLOCK_OPEN = /^\s*header\s*\{\s*$/;

/**
 * Индексы строк с директивой `header` в любой форме: блок, установка одной
 * строкой, снятие (`header -Name`), с матчером. `header_up` и `header_down` —
 * другие директивы, их регэксп не задевает.
 */
const headerDirectiveLines = codeLines.flatMap((line, index) =>
  /^\s*header(?:\s|\{|$)/.test(line) ? [index] : [],
);

/** Индексы открывающей и закрывающей строк блока `header { … }`. */
function headerBlockRange(): { start: number; end: number } {
  const start = codeLines.findIndex((line) => HEADER_BLOCK_OPEN.test(line));
  if (start < 0) throw new Error('в шаблоне нет блока `header { … }`');
  const end = codeLines.findIndex((line, i) => i > start && /^\s*\}\s*$/.test(line));
  if (end < 0) throw new Error('блок `header { … }` не закрыт');
  return { start, end };
}

function securityHeaders(): Map<string, string> {
  const { start, end } = headerBlockRange();
  const headers = new Map<string, string>();
  for (const line of codeLines.slice(start + 1, end)) {
    const m = /^\s*([A-Za-z-]+)\s+"([^"]*)"\s*$/.exec(line);
    if (!m?.[1] || m[2] === undefined) throw new Error(`не разобрать строку заголовка: ${line}`);
    if (headers.has(m[1])) throw new Error(`заголовок ${m[1]} задан дважды`);
    headers.set(m[1], m[2]);
  }
  return headers;
}

function directives(value: string): string[] {
  return value
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean);
}

const ONE_YEAR = 365 * 24 * 60 * 60;

describe('Caddyfile.example: заголовки безопасности', () => {
  const headers = securityHeaders();

  it('HSTS — не меньше года, с includeSubDomains и без preload', () => {
    const hsts = headers.get('Strict-Transport-Security');
    expect(hsts).toBeDefined();
    const parts = directives(hsts ?? '').map((d) => d.toLowerCase());

    const maxAge = parts.find((d) => d.startsWith('max-age='));
    expect(maxAge).toBeDefined();
    expect(Number((maxAge ?? '').slice('max-age='.length))).toBeGreaterThanOrEqual(ONE_YEAR);

    expect(parts).toContain('includesubdomains');
    expect(parts).not.toContain('preload');
  });

  it('фрейминг запрещён обоими правилами', () => {
    expect(headers.get('X-Frame-Options')).toBe('DENY');

    const csp = directives(headers.get('Content-Security-Policy') ?? '');
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('остальные заголовки на месте', () => {
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(headers.get('Permissions-Policy')).toMatch(/camera=\(\)/);
  });

  it('блок заголовков стоит прямо в site-блоке и покрывает и /socket.io/*', () => {
    // Внутри `handle` заголовки получил бы только один процесс: перенос блока
    // в `handle { … }` молча снял бы их с ответов второго.
    let depth = 0;
    let headerDepth: number | undefined;
    for (const line of codeLines) {
      if (HEADER_BLOCK_OPEN.test(line)) headerDepth = depth;
      depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
    }
    expect(depth).toBe(0);
    expect(headerDepth).toBe(1);
  });

  it('директива `header` в шаблоне одна — этот блок, без матчера', () => {
    // `header Strict-Transport-Security "max-age=0"` рядом с блоком или
    // `header -X-Frame-Options` внутри `handle /socket.io/*` перебили бы блок
    // для всего сайта или для одного процесса.
    expect(headerDirectiveLines).toEqual([headerBlockRange().start]);
  });

  it('заголовки безопасности не упоминаются вне блока', () => {
    // Ловит и правку в обход директивы `header`, например
    // `header_down -X-Frame-Options` у `reverse_proxy`.
    const { start, end } = headerBlockRange();
    const outside = codeLines.filter((_, i) => i < start || i > end);
    for (const name of SECURITY_HEADERS) {
      const mentions = outside.filter((line) => line.toLowerCase().includes(name.toLowerCase()));
      expect(mentions, name).toEqual([]);
    }
  });
});

describe('Caddyfile.example: подстановка install.sh', () => {
  it('шаблон использует только переменные, которые подставляет envsubst', () => {
    const list = /envsubst\s+'([^']+)'/.exec(installScript)?.[1];
    expect(list, 'в install.sh нет envsubst со списком переменных').toBeDefined();
    const substituted = new Set((list ?? '').split(/\s+/).filter(Boolean));

    const used = new Set(codeLines.flatMap((line) => line.match(/\$\{[A-Z_]+\}/g) ?? []));
    expect(used.size).toBeGreaterThan(0);
    for (const variable of used) expect(substituted).toContain(variable);
  });
});
