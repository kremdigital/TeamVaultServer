// @vitest-environment node
import { describe, expect, it } from 'vitest';
import nextConfig from '../../next.config';

describe('next.config', () => {
  it('next dev не создаёт AGENTS.md и CLAUDE.md в корне репозитория (Next 16.3+)', () => {
    // Без этого флага `next dev` под ИИ-агентом пишет файлы в рабочее дерево
    // публичного репозитория. Флаг должен пережить обёртку плагина next-intl.
    expect(nextConfig.agentRules).toBe(false);
  });
});
