// @vitest-environment node
/**
 * SMTP-транспорт писем на настоящем nodemailer против SMTP-сервера в процессе
 * теста.
 *
 * Интеграционные тесты подменяют `sendMail` целиком, так что до этого файла
 * nodemailer не исполнялся ни одним тестом. Смена мажорной версии (8 → 9, ради
 * GHSA-p6gq-j5cr-w38f и GHSA-2x7j-588g-ccc2) могла бы сломать письма сброса
 * пароля и приглашений незаметно для гейтов.
 */
import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getMailTransport, resetMailTransportForTests } from './transport';

interface SmtpSession {
  mailFrom: string;
  rcptTo: string[];
  data: string;
}

/**
 * Минимальный SMTP-сервер: EHLO без расширений (значит, без STARTTLS и AUTH),
 * MAIL/RCPT/DATA/QUIT. Каждое принятое письмо попадает в `sessions`.
 */
async function startFakeSmtp(): Promise<{
  port: number;
  sessions: SmtpSession[];
  close: () => Promise<void>;
}> {
  const sessions: SmtpSession[] = [];
  const sockets = new Set<Socket>();

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.setEncoding('utf8');

    let session: SmtpSession = { mailFrom: '', rcptTo: [], data: '' };
    let inData = false;
    let buffer = '';

    const pump = (): void => {
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          session.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          sessions.push(session);
          session = { mailFrom: '', rcptTo: [], data: '' };
          socket.write('250 OK queued\r\n');
          continue;
        }
        const eol = buffer.indexOf('\r\n');
        if (eol === -1) return;
        const line = buffer.slice(0, eol);
        buffer = buffer.slice(eol + 2);
        const cmd = line.toUpperCase();
        if (cmd.startsWith('EHLO') || cmd.startsWith('HELO')) {
          socket.write('250 fake.smtp\r\n');
        } else if (cmd.startsWith('MAIL FROM:')) {
          session.mailFrom = line.slice('MAIL FROM:'.length).trim();
          socket.write('250 OK\r\n');
        } else if (cmd.startsWith('RCPT TO:')) {
          session.rcptTo.push(line.slice('RCPT TO:'.length).trim());
          socket.write('250 OK\r\n');
        } else if (cmd === 'DATA') {
          inData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (cmd === 'QUIT') {
          socket.end('221 Bye\r\n');
          return;
        } else if (cmd === 'RSET' || cmd === 'NOOP') {
          socket.write('250 OK\r\n');
        } else {
          socket.write('502 Command not implemented\r\n');
        }
      }
    };

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      pump();
    });
    socket.write('220 fake.smtp ESMTP\r\n');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('failed to bind');

  return {
    port: addr.port,
    sessions,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

const SMTP_ENV = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM'] as const;
let savedEnv: Record<string, string | undefined> = {};
let smtp: Awaited<ReturnType<typeof startFakeSmtp>>;

beforeEach(async () => {
  savedEnv = Object.fromEntries(SMTP_ENV.map((k) => [k, process.env[k]]));
  smtp = await startFakeSmtp();
  process.env.SMTP_HOST = '127.0.0.1';
  process.env.SMTP_PORT = String(smtp.port);
  process.env.SMTP_FROM = 'Team Vault <no-reply@vault.test>';
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASSWORD;
  resetMailTransportForTests();
});

afterEach(async () => {
  resetMailTransportForTests();
  for (const k of SMTP_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  await smtp.close();
});

describe('SMTP-транспорт писем (nodemailer)', () => {
  it('доставляет письмо: конверт, заголовки, текстовая и HTML-части', async () => {
    const transport = getMailTransport();
    expect(transport.describe()).toBe(`smtp://127.0.0.1:${smtp.port}`);

    await transport.send({
      to: 'alice@example.test',
      subject: 'Reset your Team Vault password',
      text: 'Plain body line',
      html: '<p>HTML body line</p>',
    });

    expect(smtp.sessions).toHaveLength(1);
    const [mail] = smtp.sessions;
    expect(mail!.mailFrom).toBe('<no-reply@vault.test>');
    expect(mail!.rcptTo).toEqual(['<alice@example.test>']);
    expect(mail!.data).toMatch(/^From: Team Vault <no-reply@vault\.test>$/m);
    expect(mail!.data).toMatch(/^To: alice@example\.test$/m);
    expect(mail!.data).toMatch(/^Subject: Reset your Team Vault password$/m);
    expect(mail!.data).toMatch(/^Content-Type: multipart\/alternative;/m);
    expect(mail!.data).toContain('Plain body line');
    expect(mail!.data).toContain('<p>HTML body line</p>');
  });
});
