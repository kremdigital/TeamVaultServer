/**
 * Создание проекта на дашборде: после ответа API пользователь попадает на
 * страницу нового проекта через клиентский роутер Next.js.
 *
 * Раньше переход делался через `window.location.assign`, то есть полной
 * перезагрузкой: заново грузились все чанки и серверный layout, а
 * eslint-config-next 16.3 помечает такой переход правилом
 * `no-location-assign-relative-destination`. Тест фиксирует, что переход идёт
 * через `router.push` на `/projects/<id>` из ответа API.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { push, apiGet, apiPost } = vi.hoisted(() => ({
  push: vi.fn(),
  apiGet: vi.fn(),
  apiPost: vi.fn(),
}));

vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push,
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
}));
vi.mock('@/lib/api/client', () => ({
  ApiError: class ApiError extends Error {},
  apiGet,
  apiPost,
}));

import DashboardPage from '@/app/(app)/dashboard/page';

beforeEach(() => {
  push.mockReset();
  apiGet.mockReset().mockResolvedValue({ projects: [] });
  apiPost.mockReset().mockResolvedValue({ project: { id: 'p-42' } });
});

describe('Дашборд — создание проекта', () => {
  it('после создания переходит на страницу проекта через router.push', async () => {
    const user = userEvent.setup();
    render(<DashboardPage />);

    // Пустой список: кнопка создания есть и в шапке, и в пустом состоянии.
    await screen.findByText('empty.title');
    await user.click(screen.getAllByRole('button', { name: 'createProject' })[0]!);
    await user.type(await screen.findByLabelText('name'), 'Сценарий');
    await user.click(screen.getByRole('button', { name: 'submit' }));

    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    expect(push).toHaveBeenCalledWith('/projects/p-42');
    expect(apiPost).toHaveBeenCalledWith('/api/projects', { name: 'Сценарий' });
    // Диалог закрыт, список проектов перезапрошен.
    await waitFor(() => expect(screen.queryByLabelText('name')).toBeNull());
    expect(apiGet).toHaveBeenCalledTimes(2);
  });
});
