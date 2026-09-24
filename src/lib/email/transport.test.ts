// @vitest-environment node
/**
 * SMTP-транспорт писем на настоящем nodemailer против SMTP-сервера в процессе
 * теста.
 *
 * Интеграционные тесты подменяют `sendMail` целиком, так что до этого файла
 * nodemailer не исполнялся ни одним тестом. Смена мажорной версии (8 → 9, ради
 * GHSA-p6gq-j5cr-w38f и GHSA-2x7j-588g-ccc2) могла бы сломать письма сброса
 * пароля и приглашений незаметно для гейтов.
 *
 * Покрыты два пути:
 * - сервер без расширений: письмо уходит открытым текстом без AUTH;
 * - боевой путь по умолчанию (порт 587, задан SMTP_USER): nodemailer поднимает
 *   STARTTLS, заново шлёт EHLO и только внутри TLS проходит AUTH PLAIN. Как раз
 *   эти места nodemailer 9 переписывал («harden STARTTLS upgrade»).
 *
 * Неявный TLS (порт 465, `secure: true`) не покрыт: для него серверу нужен
 * именно порт 465, а транспорт выбирает режим по номеру порта.
 */
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { TLSSocket, createSecureContext } from 'node:tls';
import nodemailer from 'nodemailer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMailTransport, resetMailTransportForTests } from './transport';

// --- Самоподписанный сертификат для STARTTLS ---------------------------------
//
// В Node нет API для выпуска X.509, а приватный ключ-фикстура в публичном
// репозитории пугал бы сканеры секретов. Поэтому сертификат собирается в DER
// вручную: EC P-256, subjectAltName = IP 127.0.0.1, срок — сутки.

function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  // Короткая форма длины — до 127 байт, дальше длинная: 0x80 | число байт длины.
  const length: number[] = [];
  if (body.length < 0x80) length.push(body.length);
  else {
    for (let n = body.length; n > 0; n >>= 8) length.unshift(n & 0xff);
    length.unshift(0x80 | length.length);
  }
  return Buffer.concat([Buffer.from([tag, ...length]), body]);
}

const derSeq = (...parts: Buffer[]): Buffer => der(0x30, ...parts);
const derOid = (hex: string): Buffer => der(0x06, Buffer.from(hex, 'hex'));
const derUtcTime = (d: Date): Buffer =>
  der(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'));

function selfSignedCertificate(ip: string): { key: string; cert: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const ecdsaWithSha256 = derSeq(derOid('2a8648ce3d040302'));
  const name = derSeq(der(0x31, derSeq(derOid('550403'), der(0x0c, Buffer.from(ip)))));
  const serial = randomBytes(16);
  serial[0] = (serial[0]! & 0x7f) | 0x01; // положительное и без ведущего нуля
  const now = Date.now();
  const subjectAltName = derSeq(
    derOid('551d11'),
    der(0x04, derSeq(der(0x87, Buffer.from(ip.split('.').map(Number))))),
  );
  const tbs = derSeq(
    der(0xa0, der(0x02, Buffer.from([2]))), // v3
    der(0x02, serial),
    ecdsaWithSha256,
    name,
    derSeq(derUtcTime(new Date(now - 3_600_000)), derUtcTime(new Date(now + 86_400_000))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    der(0xa3, derSeq(subjectAltName)),
  );
  const certDer = derSeq(
    tbs,
    ecdsaWithSha256,
    der(0x03, Buffer.from([0]), sign('sha256', tbs, privateKey)),
  );
  const base64 = certDer.toString('base64').replace(/.{64}/g, '$&\n');
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    cert: `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n`,
  };
}

// --- Фейковый SMTP-сервер ----------------------------------------------------

interface SmtpSession {
  mailFrom: string;
  rcptTo: string[];
  data: string;
  /** Письмо принято внутри TLS. */
  secure: boolean;
}

interface FakeSmtpOptions {
  /** Сервер объявит STARTTLS и после апгрейда продолжит сессию по TLS. */
  tls?: { key: string; cert: string };
  /**
   * Учётка, которую сервер примет в AUTH PLAIN. Без аутентификации MAIL FROM
   * отклоняется. Если задан `tls`, AUTH объявляется только внутри TLS, как у
   * боевых серверов на порту 587.
   */
  auth?: { user: string; pass: string };
}

interface FakeSmtp {
  port: number;
  sessions: SmtpSession[];
  /** Команды клиента по порядку; команды внутри TLS — с префиксом `TLS `. */
  commands: string[];
  close: () => Promise<void>;
}

/**
 * Минимальный SMTP-сервер: EHLO/HELO, STARTTLS, AUTH PLAIN, MAIL/RCPT/DATA,
 * RSET/NOOP/QUIT. Каждое принятое письмо попадает в `sessions`.
 */
async function startFakeSmtp(options: FakeSmtpOptions = {}): Promise<FakeSmtp> {
  const sessions: SmtpSession[] = [];
  const commands: string[] = [];
  const sockets = new Set<Socket>();
  const secureContext = options.tls ? createSecureContext(options.tls) : null;

  const serve = (stream: Socket | TLSSocket, secure: boolean): void => {
    stream.setEncoding('utf8');
    stream.on('error', () => undefined);

    let session: SmtpSession = { mailFrom: '', rcptTo: [], data: '', secure };
    let authenticated = false;
    let inData = false;
    let buffer = '';

    const ehloReply = (): string => {
      const lines = ['fake.smtp'];
      if (secureContext && !secure) lines.push('STARTTLS');
      if (options.auth && (secure || !secureContext)) lines.push('AUTH PLAIN LOGIN');
      return lines.map((l, i) => `250${i === lines.length - 1 ? ' ' : '-'}${l}\r\n`).join('');
    };

    const onData = (chunk: string): void => {
      buffer += chunk;
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          session.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          sessions.push(session);
          session = { mailFrom: '', rcptTo: [], data: '', secure };
          stream.write('250 OK queued\r\n');
          continue;
        }
        const eol = buffer.indexOf('\r\n');
        if (eol === -1) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        commands.push(secure ? `TLS ${line}` : line);
        const cmd = line.toUpperCase();

        if (cmd.startsWith('EHLO') || cmd.startsWith('HELO')) {
          stream.write(ehloReply());
        } else if (cmd === 'STARTTLS' && secureContext && !secure) {
          // RFC 3207: всё, что клиент прислал до рукопожатия, отбрасывается.
          stream.removeListener('data', onData);
          buffer = '';
          stream.write('220 Ready to start TLS\r\n');
          serve(new TLSSocket(stream, { isServer: true, secureContext }), true);
          return;
        } else if (cmd.startsWith('AUTH PLAIN ') && options.auth) {
          const expected = `\0${options.auth.user}\0${options.auth.pass}`;
          const given = Buffer.from(line.slice('AUTH PLAIN '.length), 'base64').toString('utf8');
          authenticated = given === expected;
          stream.write(authenticated ? '235 2.7.0 Accepted\r\n' : '535 5.7.8 Bad credentials\r\n');
        } else if (cmd.startsWith('MAIL FROM:')) {
          if (options.auth && !authenticated) {
            stream.write('530 5.7.0 Authentication required\r\n');
            continue;
          }
          session.mailFrom = line.slice('MAIL FROM:'.length).trim();
          stream.write('250 OK\r\n');
        } else if (cmd.startsWith('RCPT TO:')) {
          session.rcptTo.push(line.slice('RCPT TO:'.length).trim());
          stream.write('250 OK\r\n');
        } else if (cmd === 'DATA') {
          inData = true;
          stream.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (cmd === 'QUIT') {
          stream.end('221 Bye\r\n');
          return;
        } else if (cmd === 'RSET' || cmd === 'NOOP') {
          stream.write('250 OK\r\n');
        } else {
          stream.write('502 Command not implemented\r\n');
        }
      }
    };

    stream.on('data', onData);
  };

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    serve(socket, false);
    socket.write('220 fake.smtp ESMTP\r\n');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('failed to bind');

  return {
    port: addr.port,
    sessions,
    commands,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

/**
 * Доверить nodemailer тестовый сертификат. Транспорт собирает опции сам и
 * своих TLS-настроек не задаёт, поэтому доверие добавляется обёрткой над
 * `createTransport`: остальные опции уходят как есть, и тест видит, какими
 * транспорт их собрал.
 */
function trustCertificate(cert: string) {
  const original = nodemailer.createTransport.bind(nodemailer);
  return vi
    .spyOn(nodemailer, 'createTransport')
    .mockImplementation(((transportOptions: Record<string, unknown>) =>
      original({ ...transportOptions, tls: { ca: [cert] } })) as typeof nodemailer.createTransport);
}

const SMTP_ENV = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM'] as const;
const MESSAGE = {
  to: 'alice@example.test',
  subject: 'Reset your Team Vault password',
  text: 'Plain body line',
  html: '<p>HTML body line</p>',
};

let savedEnv: Record<string, string | undefined> = {};
let smtp: FakeSmtp | null = null;

function useSmtp(server: FakeSmtp): FakeSmtp {
  smtp = server;
  process.env.SMTP_HOST = '127.0.0.1';
  process.env.SMTP_PORT = String(server.port);
  return server;
}

beforeEach(() => {
  savedEnv = Object.fromEntries(SMTP_ENV.map((k) => [k, process.env[k]]));
  process.env.SMTP_FROM = 'Team Vault <no-reply@vault.test>';
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASSWORD;
  resetMailTransportForTests();
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetMailTransportForTests();
  for (const k of SMTP_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await smtp?.close();
  smtp = null;
});

describe('SMTP-транспорт писем (nodemailer)', () => {
  it('доставляет письмо: конверт, заголовки, текстовая и HTML-части', async () => {
    const server = useSmtp(await startFakeSmtp());
    const transport = getMailTransport();
    expect(transport.describe()).toBe(`smtp://127.0.0.1:${server.port}`);

    await transport.send(MESSAGE);

    expect(server.sessions).toHaveLength(1);
    const [mail] = server.sessions;
    expect(mail!.mailFrom).toBe('<no-reply@vault.test>');
    expect(mail!.rcptTo).toEqual(['<alice@example.test>']);
    expect(mail!.data).toMatch(/^From: Team Vault <no-reply@vault\.test>$/m);
    expect(mail!.data).toMatch(/^To: alice@example\.test$/m);
    expect(mail!.data).toMatch(/^Subject: Reset your Team Vault password$/m);
    expect(mail!.data).toMatch(/^Content-Type: multipart\/alternative;/m);
    expect(mail!.data).toContain('Plain body line');
    expect(mail!.data).toContain('<p>HTML body line</p>');
    // Без SMTP_USER транспорт не аутентифицируется.
    expect(server.commands.some((c) => c.toUpperCase().startsWith('AUTH'))).toBe(false);
  });

  it('с SMTP_USER на порту 587: STARTTLS, затем AUTH PLAIN только внутри TLS', async () => {
    const certificate = selfSignedCertificate('127.0.0.1');
    const createTransport = trustCertificate(certificate.cert);
    const server = useSmtp(
      await startFakeSmtp({ tls: certificate, auth: { user: 'mailer', pass: 's3cret:пароль' } }),
    );
    process.env.SMTP_USER = 'mailer';
    process.env.SMTP_PASSWORD = 's3cret:пароль';

    await getMailTransport().send(MESSAGE);

    // Порт не 465 — значит, без неявного TLS: шифрование только через STARTTLS.
    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(createTransport).toHaveBeenCalledWith({
      host: '127.0.0.1',
      port: server.port,
      secure: false,
      auth: { user: 'mailer', pass: 's3cret:пароль' },
    });

    const credentials = Buffer.from('\0mailer\0s3cret:пароль', 'utf8').toString('base64');
    expect(server.commands.slice(0, 7)).toEqual([
      expect.stringMatching(/^EHLO /),
      'STARTTLS',
      expect.stringMatching(/^TLS EHLO /),
      `TLS AUTH PLAIN ${credentials}`,
      'TLS MAIL FROM:<no-reply@vault.test>',
      'TLS RCPT TO:<alice@example.test>',
      'TLS DATA',
    ]);
    // Открытым текстом ушли только EHLO и STARTTLS — пароль не покидает TLS.
    expect(server.commands.filter((c) => !c.startsWith('TLS '))).toHaveLength(2);

    expect(server.sessions).toHaveLength(1);
    expect(server.sessions[0]!.secure).toBe(true);
    expect(server.sessions[0]!.data).toMatch(/^Subject: Reset your Team Vault password$/m);
    expect(server.sessions[0]!.data).toContain('Plain body line');
  });

  it('неверный пароль: send отклоняется с EAUTH, письмо не уходит', async () => {
    const certificate = selfSignedCertificate('127.0.0.1');
    trustCertificate(certificate.cert);
    const server = useSmtp(
      await startFakeSmtp({ tls: certificate, auth: { user: 'mailer', pass: 'right' } }),
    );
    process.env.SMTP_USER = 'mailer';
    process.env.SMTP_PASSWORD = 'wrong';

    await expect(getMailTransport().send(MESSAGE)).rejects.toMatchObject({ code: 'EAUTH' });

    expect(server.commands).toContain(
      `TLS AUTH PLAIN ${Buffer.from('\0mailer\0wrong').toString('base64')}`,
    );
    expect(server.commands.some((c) => c.includes('MAIL FROM:'))).toBe(false);
    expect(server.sessions).toHaveLength(0);
  });
});
