/**
 * Frontmatter заметки разбирается на сервере: `MarkdownView` рендерится и при
 * SSR, а заметку может написать любой участник проекта. js-yaml до 4.3.2
 * разворачивал merge-ключи (`<<`) без предела, и небольшой документ нагружал
 * web-процесс квадратичной работой (GHSA-52cp-r559-cp3m, GHSA-2883-xcg3-v3hh).
 * С 4.3.2 у загрузчика есть бюджет `maxTotalMergeKeys`
 * (10 000): такой документ отвергается, а `parseFrontmatter` отдаёт тело заметки
 * без свойств, как и для любого битого YAML.
 */
import { describe, expect, it } from 'vitest';
import { parseFrontmatter } from './frontmatter';

const BODY = '# Заметка\n\nтекст';

function note(yaml: string): string {
  return `---\n${yaml}\n---\n${BODY}`;
}

describe('parseFrontmatter: бюджет merge-ключей js-yaml', () => {
  it('контроль: обычное слияние через << по-прежнему работает', () => {
    const r = parseFrontmatter(note('base: &b {a: 1}\nx: {<<: *b, c: 2}'));
    expect(r.properties).toEqual([
      { key: 'base', value: '{"a":1}' },
      { key: 'x', value: '{"a":1,"c":2}' },
    ]);
    expect(r.body).toBe(BODY);
  });

  it('отвергает размножение ключей через слияние (GHSA-52cp-r559-cp3m)', () => {
    // Якорь на 200 ключей, влитый в 60 отображений: 12 000 слитых ключей
    // из документа меньше 3 КБ.
    const keys = Array.from({ length: 200 }, (_, i) => `k${i}: ${i}`).join(', ');
    const merges = Array.from({ length: 60 }, (_, i) => `m${i}: {<<: *a}`).join('\n');
    const r = parseFrontmatter(note(`a: &a {${keys}}\n${merges}`));

    expect(r.properties).toEqual([]);
    expect(r.body).toBe(BODY);
  });

  it('отвергает цепочку пустых источников слияния (GHSA-2883-xcg3-v3hh)', () => {
    // Пустое отображение ключей не добавляет, и 4.3.0–4.3.1 такие источники не
    // считали. Одна последовательность `<<` ограничена 20 источниками, поэтому
    // их 520: 10 400 слияний проходили мимо бюджета.
    const sources = Array.from({ length: 20 }, () => '*e').join(', ');
    const merges = Array.from({ length: 520 }, (_, i) => `m${i}: {<<: [${sources}]}`).join('\n');
    const r = parseFrontmatter(note(`e: &e {}\n${merges}`));

    expect(r.properties).toEqual([]);
    expect(r.body).toBe(BODY);
  });
});
