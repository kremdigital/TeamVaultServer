// @vitest-environment node
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { signAccessToken, verifyAccessToken } from '@/lib/auth/jwt';
import proxy from './proxy';

beforeAll(() => {
  process.env.JWT_SECRET = 'test-jwt-secret';
  process.env.JWT_REFRESH_SECRET = 'test-jwt-refresh-secret';
  process.env.JWT_ACCESS_TTL = '15m';
  process.env.JWT_REFRESH_TTL = '30d';
  process.env.JWT_REMEMBER_TTL = '30d';
});

const DAY = 24 * 3600;
const REMEMBER_TTL = 30 * DAY;

function withAccessCookie(url: string, token: string): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    headers: { cookie: `osync_access=${token}` },
  });
}

function readSetCookieToken(response: Response): string | null {
  const setCookie = response.headers.get('set-cookie');
  if (!setCookie) return null;
  const m = /osync_access=([^;]+)/.exec(setCookie);
  return m && m[1] ? decodeURIComponent(m[1]) : null;
}

/**
 * Время в этих тестах фейковое: подменён только `Date`, таймеры настоящие.
 * Токен выпускается настоящим `signAccessToken` в момент T0, затем часы
 * переводятся вперёд на нужную точку окна. И подпись, и проверка `exp` в jose,
 * и расчёт остатка в `proxy` читают одни и те же часы, поэтому исход не зависит
 * от скорости машины.
 *
 * Раньше кейсы с коротким окном спали 1,1 с внутри двухсекундного токена. Если
 * машина задерживалась, токен истекал целиком: кейс со скольжением падал, а кейс
 * без скольжения проходил вхолостую — истёкший токен тоже не даёт Set-Cookie
 * (TASK-0022).
 */
describe('proxy — sliding "Remember me" sessions', () => {
  const T0 = new Date('2026-09-01T00:00:00.000Z');
  const nowSeconds = () => Math.floor(Date.now() / 1000);
  /** Перевести фейковые часы на `seconds` после выпуска токена. */
  const advance = (seconds: number) => vi.setSystemTime(T0.getTime() + seconds * 1000);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not refresh a fresh remember-me token (plenty of life left)', async () => {
    const token = await signAccessToken('user-1', 'USER', { rememberMe: true });
    const res = await proxy(withAccessCookie('/dashboard', token));
    expect(res.headers.get('location')).toBeNull();
    expect(readSetCookieToken(res)).toBeNull();
  });

  it('refreshes a remember-me token past the half-life mark', async () => {
    const stale = await signAccessToken('user-1', 'USER', { rememberMe: true });
    advance(25 * DAY); // 5 d left of 30 d: 5*2 < 30, the half-life trigger fires

    const res = await proxy(withAccessCookie('/dashboard', stale));
    const fresh = readSetCookieToken(res);
    expect(fresh).not.toBeNull();
    expect(fresh).not.toBe(stale);
    // The cookie's lifetime restarts from this visit, not from login.
    expect(res.headers.get('set-cookie')).toMatch(new RegExp(`Max-Age=${REMEMBER_TTL}(;|$)`));

    // Fresh token re-verifies, keeps the rememberMe flag and gets a full window.
    const payload = await verifyAccessToken(fresh!);
    expect(payload?.rememberMe).toBe(true);
    expect(payload?.sub).toBe('user-1');
    expect(payload?.exp).toBe(nowSeconds() + REMEMBER_TTL);
  });

  it('leaves a remember-me token alone while more than half the window remains', async () => {
    const token = await signAccessToken('user-1', 'USER', { rememberMe: true });
    advance(10 * DAY); // 20 d left of 30 d: 20*2 > 30, no re-issue
    const res = await proxy(withAccessCookie('/dashboard', token));
    expect(res.headers.get('location')).toBeNull();
    expect(readSetCookieToken(res)).toBeNull();
  });

  it('slides exactly at the half-life mark, not a second earlier', async () => {
    const token = await signAccessToken('user-1', 'USER', { rememberMe: true });

    advance(REMEMBER_TTL / 2 - 1);
    expect(readSetCookieToken(await proxy(withAccessCookie('/dashboard', token)))).toBeNull();

    advance(REMEMBER_TTL / 2);
    expect(readSetCookieToken(await proxy(withAccessCookie('/dashboard', token)))).not.toBeNull();
  });

  it('does not slide short (non-remember-me) sessions', async () => {
    const token = await signAccessToken('user-1', 'USER'); // default 15 min
    advance(14 * 60); // 1 min left: far past the half-life of any window

    const res = await proxy(withAccessCookie('/dashboard', token));
    // The token is still valid — the request passes through, not to a
    // redirect — and the proxy must not touch the cookie.
    expect(res.headers.get('location')).toBeNull();
    expect(readSetCookieToken(res)).toBeNull();
  });

  it('does not slide for Bearer-token (plugin) requests', async () => {
    // The Obsidian plugin uses an Authorization header, not the cookie.
    // Sliding the cookie there would be pointless and might overwrite
    // an unrelated session if the same browser had one.
    const token = await signAccessToken('user-1', 'USER', { rememberMe: true });
    advance(25 * DAY);

    // Control: the very same token in the cookie is due for a slide.
    expect(readSetCookieToken(await proxy(withAccessCookie('/dashboard', token)))).not.toBeNull();

    const req = new NextRequest('http://localhost/dashboard', {
      headers: { authorization: `Bearer ${token}` },
    });
    const res = await proxy(req);
    expect(res.headers.get('location')).toBeNull();
    expect(readSetCookieToken(res)).toBeNull();
  });
});

/**
 * Истёкший access при живом refresh больше не выбрасывает на форму входа.
 *
 * Раньше `proxy` в этом случае слал на `/login`, хотя сессия действительна ещё
 * 30 дней: человек отходил на двадцать минут, возвращался, кликал по ссылке — и
 * оказывался на входе. Теперь он идёт на маршрут обновления и возвращается
 * туда, куда шёл.
 */
describe('proxy — обновление сессии вместо формы входа', () => {
  const req = (url: string, cookie: string): NextRequest =>
    new NextRequest(`http://localhost${url}`, { headers: { cookie } });

  const location = (res: Response) =>
    new URL(res.headers.get('location') ?? '', 'http://localhost');

  it('без access, но с refresh — отправляет на обновление и хранит адрес', async () => {
    const res = await proxy(req('/projects/p1?tab=notes', 'osync_refresh=r1'));
    const loc = location(res);
    expect(loc.pathname).toBe('/api/auth/session-refresh');
    expect(loc.searchParams.get('next')).toBe('/projects/p1?tab=notes');
  });

  it('с непроходящим проверку access и живым refresh — тоже на обновление', async () => {
    // Намеренно без ожидания реального истечения: `proxy` идёт одной и той же
    // веткой `if (!payload)` и для протухшего, и для битого токена, а сон на
    // секунду ради этого делал тест плавающим.
    const broken = 'not.a.valid.jwt';
    expect(await verifyAccessToken(broken)).toBeNull();

    const res = await proxy(req('/dashboard', `osync_access=${broken}; osync_refresh=r1`));
    expect(location(res).pathname).toBe('/api/auth/session-refresh');
  });

  it('без refresh-cookie — по-прежнему на форму входа', async () => {
    const res = await proxy(req('/dashboard', ''));
    expect(location(res).pathname).toBe('/login');
  });

  it('повторный заход с меткой попытки — на форму входа, а не по кругу', async () => {
    // Метку ставит сам маршрут обновления. Без этой проверки протухший refresh
    // дал бы бесконечный круг proxy ⇄ обновление.
    const res = await proxy(req('/dashboard', 'osync_refresh=r1; osync_refresh_attempt=1'));
    expect(location(res).pathname).toBe('/login');
  });

  it('незащищённые пути не трогаются', async () => {
    const res = await proxy(req('/about', ''));
    expect(res.headers.get('location')).toBeNull();
  });
});
