/**
 * Регрессия GHSA-2m8v-j782-fhvr: socket.io-parser < 4.2.7 (TASK-0023).
 *
 * Пакет BINARY_EVENT, объявляющий ноль вложений (`50-[...]`), старый парсер
 * принимал: отдавал событие и оставлял сборщик вложений открытым. После этого
 * каждый бинарный кадр клиента копился в памяти процесса без предела. Сокет-процесс
 * прода (:3001) открыт в интернет, так что один клиент мог выесть его память.
 * Исправленный парсер считает такой пакет некорректным («Illegal attachments»), и
 * сервер рвёт соединение.
 *
 * Пакеты пишутся в engine.io-транспорт напрямую: штатный клиент такой кадр не
 * соберёт никогда, его шлёт только злоумышленник.
 */
import { createServer, type Server as HttpServer } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server as IOServer } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { createIoServer } from '@/socket/server';
import { generateApiKey } from '@/lib/auth/api-key';
import { resetDatabase, testPrisma } from '../db';

let httpServer: HttpServer;
let io: IOServer;
let port: number;
/** Ошибки, которые сервер поднял на серверных сокетах (ошибки разбора пакетов). */
const serverErrors: Error[] = [];

beforeAll(async () => {
  httpServer = createServer();
  ({ io } = createIoServer({ httpServer, corsOrigin: '*' }));
  io.on('connection', (socket) => {
    socket.on('error', (err: Error) => serverErrors.push(err));
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
  const addr = httpServer.address();
  if (!addr || typeof addr === 'string') throw new Error('failed to bind');
  port = addr.port;
});

afterAll(async () => {
  io.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  await testPrisma.$disconnect();
});

beforeEach(async () => {
  await resetDatabase();
  serverErrors.length = 0;
});

const openClients: ClientSocket[] = [];
afterEach(() => {
  for (const c of openClients) c.disconnect();
  openClients.length = 0;
});

async function connectOwner(): Promise<{ client: ClientSocket; projectId: string }> {
  const user = await testPrisma.user.create({
    data: { email: `parser-${Date.now()}-${Math.random()}@x.test`, passwordHash: 'h', name: 'p' },
  });
  const key = await generateApiKey();
  await testPrisma.apiKey.create({
    data: { userId: user.id, name: 'cli', keyHash: key.hash, keyPrefix: key.prefix },
  });
  const project = await testPrisma.project.create({
    data: {
      slug: `s-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: 'P',
      ownerId: user.id,
      members: { create: { userId: user.id, role: 'ADMIN', addedById: user.id } },
    },
  });

  const client = ioClient(`http://127.0.0.1:${port}`, {
    auth: { apiKey: key.plain },
    transports: ['websocket'],
    reconnection: false,
  });
  openClients.push(client);
  await new Promise<void>((resolve, reject) => {
    client.on('connect', () => resolve());
    client.on('connect_error', (err) => reject(err));
  });
  return { client, projectId: project.id };
}

/** Записать сырой socket.io-пакет в транспорт в обход кодировщика клиента. */
function sendRaw(client: ClientSocket, packet: string): void {
  client.io.engine.send(packet);
}

function waitForDisconnect(client: ClientSocket, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`сервер не разорвал соединение за ${timeoutMs} мс`)),
      timeoutMs,
    );
    client.once('disconnect', (reason) => {
      clearTimeout(timer);
      resolve(reason);
    });
  });
}

function joinProject(client: ClientSocket, projectId: string): Promise<{ ok: boolean }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ack timeout for project:join')), 5000);
    client.emit('project:join', { projectId, sinceVectorClock: {} }, (ack: { ok: boolean }) => {
      clearTimeout(timer);
      resolve(ack);
    });
  });
}

describe('socket.io-parser: пакет с нулём вложений (GHSA-2m8v-j782-fhvr)', () => {
  it('контроль: сырой корректный пакет разбирается, соединение живо', async () => {
    // Без этого контроля обрыв в следующем тесте можно было бы списать на
    // саму запись в обход кодировщика, а не на отказ парсера.
    const { client, projectId } = await connectOwner();

    sendRaw(client, '2["noop"]');
    const ack = await joinProject(client, projectId);

    expect(ack.ok).toBe(true);
    expect(client.connected).toBe(true);
    expect(serverErrors).toEqual([]);
  });

  it('сервер отвергает BINARY_EVENT с нулём вложений и рвёт соединение', async () => {
    const { client } = await connectOwner();
    const disconnected = waitForDisconnect(client, 5000);

    sendRaw(client, '50-["noop"]');

    // Уязвимый парсер принимал пакет молча: соединение оставалось открытым, а
    // сборщик вложений копил все последующие бинарные кадры.
    expect(await disconnected).toBe('transport close');
    expect(serverErrors.map((e) => e.message)).toEqual(['Illegal attachments']);
  });
});
