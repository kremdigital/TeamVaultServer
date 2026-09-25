// @vitest-environment node
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  TEXT_KEY,
  buildInitialState,
  editYText,
  extendYjsState,
  hashText,
  type TextDiffLimits,
} from './persistence';

describe('buildInitialState', () => {
  it('encodes a Y.Doc that decodes back to the same text', () => {
    const { state } = buildInitialState('# Заголовок\nТекст');
    const restored = new Y.Doc();
    Y.applyUpdate(restored, state);
    expect(restored.getText(TEXT_KEY).toString()).toBe('# Заголовок\nТекст');
  });

  it('hashText is stable for the same input', () => {
    expect(hashText('hello')).toBe(hashText('hello'));
    expect(hashText('hello')).not.toBe(hashText('world'));
  });
});

describe('вектор состояния не отражает удаления', () => {
  // Ради этого свойства и существует проверка по тексту в applyYjsUpdate.
  // Вектор состояния — это счётчик ВСТАВОК на клиента; удаления живут в
  // отдельном delete-set и счётчик не двигают. Раньше `changed` считался
  // только по вектору, поэтому правка-удаление не попадала ни на диск, ни к
  // другим клиентам (обнаружено 2026-08-06).
  it('удаление меняет текст, но НЕ меняет вектор состояния', () => {
    const server = new Y.Doc();
    server.getText(TEXT_KEY).insert(0, 'dx');

    const client = new Y.Doc();
    Y.applyUpdate(client, Y.encodeStateAsUpdate(server));
    // Клиент удаляет один символ — чистое удаление, без вставок.
    client.getText(TEXT_KEY).delete(1, 1);
    const deleteUpdate = Y.encodeStateAsUpdate(client, Y.encodeStateVector(server));

    const beforeVector = Y.encodeStateVector(server);
    const beforeText = server.getText(TEXT_KEY).toString();
    Y.applyUpdate(server, deleteUpdate);
    const afterVector = Y.encodeStateVector(server);
    const afterText = server.getText(TEXT_KEY).toString();

    expect(beforeText).toBe('dx');
    expect(afterText).toBe('d'); // текст изменился
    expect(Buffer.from(afterVector).equals(Buffer.from(beforeVector))).toBe(true); // вектор — нет
  });

  it('вставка, наоборот, меняет и текст, и вектор', () => {
    const server = new Y.Doc();
    server.getText(TEXT_KEY).insert(0, 'd');
    const client = new Y.Doc();
    Y.applyUpdate(client, Y.encodeStateAsUpdate(server));
    client.getText(TEXT_KEY).insert(1, 'x');
    const insertUpdate = Y.encodeStateAsUpdate(client, Y.encodeStateVector(server));

    const beforeVector = Y.encodeStateVector(server);
    Y.applyUpdate(server, insertUpdate);
    expect(server.getText(TEXT_KEY).toString()).toBe('dx');
    expect(Buffer.from(Y.encodeStateVector(server)).equals(Buffer.from(beforeVector))).toBe(false);
  });
});

describe('Y.applyUpdate convergence (sanity)', () => {
  it('two clients converge to the same state regardless of merge order', () => {
    // Client A
    const a = new Y.Doc();
    a.getText(TEXT_KEY).insert(0, 'Hello ');
    const updateA = Y.encodeStateAsUpdate(a);

    // Client B (independent)
    const b = new Y.Doc();
    b.getText(TEXT_KEY).insert(0, 'World!');
    const updateB = Y.encodeStateAsUpdate(b);

    // Merge in different orders.
    const ab = new Y.Doc();
    Y.applyUpdate(ab, updateA);
    Y.applyUpdate(ab, updateB);

    const ba = new Y.Doc();
    Y.applyUpdate(ba, updateB);
    Y.applyUpdate(ba, updateA);

    expect(ab.getText(TEXT_KEY).toString()).toBe(ba.getText(TEXT_KEY).toString());
  });
});

// Оба способа записи продолжают историю: без неотправленных правок устройство сходится
// ровно к новому тексту.
describe.each(['edit', 'replace'] as const)(
  'extendYjsState(%s): новый текст поверх истории',
  (mode) => {
    const OLD = 'Old line one\nOld line two\n';
    const NEW = 'Brand new note\n';

    /** Документ, который держит устройство: история сервера плюс своя правка. */
    function deviceWithHistory(): { device: Y.Doc; serverState: Uint8Array } {
      const server = new Y.Doc();
      server.getText(TEXT_KEY).insert(0, OLD);
      const device = new Y.Doc();
      Y.applyUpdate(device, Y.encodeStateAsUpdate(server));
      device.getText(TEXT_KEY).insert(OLD.length, 'edit\n');
      Y.applyUpdate(server, Y.encodeStateAsUpdate(device, Y.encodeStateVector(server)));
      return { device, serverState: Y.encodeStateAsUpdate(server) };
    }

    it('устройство со старой историей сходится ровно к новому тексту, в обе стороны', () => {
      const { device, serverState } = deviceWithHistory();

      const next = extendYjsState(serverState, NEW, mode);
      expect(next.changed).toBe(true);

      // Сервер → устройство: catch-up или yjs:update с полным состоянием.
      Y.applyUpdate(device, next.state);
      expect(device.getText(TEXT_KEY).toString()).toBe(NEW);

      // Устройство → сервер: то, чего у сервера по его вектору нет (pushMissingOps).
      const server = new Y.Doc();
      Y.applyUpdate(server, next.state);
      Y.applyUpdate(server, Y.encodeStateAsUpdate(device, next.stateVector));
      expect(server.getText(TEXT_KEY).toString()).toBe(NEW);
    });

    it('подмена свежей историей (buildInitialState) задваивает — поэтому её и нет', () => {
      // Механизм находки: тот же fileId, независимая история. Тест фиксирует,
      // почему extendYjsState обязан продолжать историю, а не строить новую.
      const { device } = deviceWithHistory();
      Y.applyUpdate(device, buildInitialState(NEW).state);
      const merged = device.getText(TEXT_KEY).toString();
      expect(merged).not.toBe(NEW);
      expect(merged).toContain('Old line one');
      expect(merged).toContain('Brand new note');
    });

    it('тот же текст (восстановление из корзины) историю не трогает и не задваивает', () => {
      const { device, serverState } = deviceWithHistory();
      const sameText = 'Old line one\nOld line two\nedit\n';

      const next = extendYjsState(serverState, sameText, mode);
      expect(next.changed).toBe(false);

      Y.applyUpdate(device, next.state);
      expect(device.getText(TEXT_KEY).toString()).toBe(sameText);
      const before = new Y.Doc();
      Y.applyUpdate(before, serverState);
      expect(Buffer.from(next.stateVector).equals(Buffer.from(Y.encodeStateVector(before)))).toBe(
        true,
      );
    });

    it('без сохранённого состояния — свежий документ с текстом', () => {
      for (const stored of [null, undefined, new Uint8Array()]) {
        const next = extendYjsState(stored, NEW, mode);
        const doc = new Y.Doc();
        Y.applyUpdate(doc, next.state);
        expect(doc.getText(TEXT_KEY).toString()).toBe(NEW);
        expect(next.changed).toBe(true);
      }
    });
  },
);

describe('extendYjsState(edit): неотправленные правки устройства встают на свои места', () => {
  // MCP `write_note` меняет одну строку заметки, а устройство, у которого её история
  // лежит в y-indexeddb, тем временем правит её офлайн. Сервер удалял весь текст и
  // вставлял новый в позицию 0, и слияние у всей команды искажалось: вставка в середине
  // строки уезжала в начало заметки, удалённая строка возвращалась, заменённое слово
  // удваивалось («ALPHAalpha»), дописанная строка вставала первой.
  const BASE = 'alpha beta\ngamma\ndelta\n';
  const MCP = 'alpha beta\nGAMMA\ndelta\n';

  /** Слить офлайн-правку устройства с записью `MCP`; сервер и устройство сходятся. */
  function merge(offline: (text: Y.Text) => void, limits?: TextDiffLimits): string {
    const origin = new Y.Doc();
    origin.getText(TEXT_KEY).insert(0, BASE);
    const stored = Y.encodeStateAsUpdate(origin);
    const device = new Y.Doc();
    Y.applyUpdate(device, stored);
    offline(device.getText(TEXT_KEY));

    const next = extendYjsState(stored, MCP, 'edit', limits);
    // Сервер получает то, чего у него нет (pushMissingOps), устройство — полное состояние.
    const server = new Y.Doc();
    Y.applyUpdate(server, next.state);
    Y.applyUpdate(server, Y.encodeStateAsUpdate(device, next.stateVector));
    Y.applyUpdate(device, next.state);
    const merged = server.getText(TEXT_KEY).toString();
    expect(device.getText(TEXT_KEY).toString()).toBe(merged);
    return merged;
  }

  const cases: Array<[string, (text: Y.Text) => void, string]> = [
    ['вставка в середине строки', (t) => t.insert(1, '2'), 'a2lpha beta\nGAMMA\ndelta\n'],
    [
      'удалённая строка',
      (t) => t.delete(BASE.indexOf('delta'), 'delta\n'.length),
      'alpha beta\nGAMMA\n',
    ],
    [
      'заменённое слово',
      (t) => {
        t.delete(0, 'alpha'.length);
        t.insert(0, 'ALPHA');
      },
      'ALPHA beta\nGAMMA\ndelta\n',
    ],
    [
      'строка в конце',
      (t) => t.insert(BASE.length, 'offline\n'),
      'alpha beta\nGAMMA\ndelta\noffline\n',
    ],
  ];

  it.each(cases)('%s', (_name, offline, expected) => {
    expect(merge(offline)).toBe(expected);
  });

  it.each(cases)('%s — и в запасном построчном диффе', (_name, offline, expected) => {
    // Большая правка не проходит в лимит посимвольного диффа: строки, которых она не
    // касается, всё равно сохраняют свои элементы.
    expect(merge(offline, { chars: 0, lines: 1000, timeoutMs: 1000 })).toBe(expected);
  });

  it('replace (оживление тумбстоуна) удаляет весь прежний текст: вставки встают у края', () => {
    // Новая заметка под старым id — другой текст. Правки старой встают целиком перед
    // новым текстом или сразу после него, а не внутрь его слов.
    const origin = new Y.Doc();
    origin.getText(TEXT_KEY).insert(0, BASE);
    const stored = Y.encodeStateAsUpdate(origin);
    const device = new Y.Doc();
    Y.applyUpdate(device, stored);
    device.getText(TEXT_KEY).insert(1, '2');

    const next = extendYjsState(stored, 'Brand new note\n', 'replace');
    Y.applyUpdate(device, next.state);
    expect(device.getText(TEXT_KEY).toString()).toBe('2Brand new note\n');
  });
});

describe('editYText: минимальный дифф и запасные пути', () => {
  const FULL: TextDiffLimits = { chars: 100_000, lines: 100_000, timeoutMs: 10_000 };
  const LINES: TextDiffLimits = { chars: 0, lines: 100_000, timeoutMs: 10_000 };
  const SPAN: TextDiffLimits = { chars: 0, lines: 0, timeoutMs: 10_000 };

  const pairs: Array<[string, string]> = [
    ['', 'abc\n'],
    ['abc\n', ''],
    ['alpha beta\ngamma\ndelta\n', 'alpha beta\nGAMMA\ndelta\n'],
    // Общий старший суррогат (U+1F600 → U+1F601) и общий младший (U+1F600 → U+1FA00).
    ['x😀y', 'x😁y'],
    ['a😀b', 'a🨀b'],
    ['😀😀\n', '😀\n'],
    ['a😀\nb', 'a😀\nb😀c'],
    ['a\r\nb\r\n', 'a\nb\n'],
    ['line1\nline2', 'line1\nline2\n'],
    ['\n\n\n', '\n'],
    ['абв где\nжз', 'абв ГДЕ\nжз\nик'],
  ];

  it.each([
    ['посимвольно', FULL, 'chars'],
    ['построчно', LINES, 'lines'],
    ['одним куском', SPAN, 'span'],
  ] as const)(
    '%s: ровно новый текст, пары суррогатов целы, прежняя история сходится',
    (_n, limits, path) => {
      for (const [before, after] of pairs) {
        const seed = new Y.Doc();
        seed.getText(TEXT_KEY).insert(0, before);
        const server = new Y.Doc();
        const device = new Y.Doc();
        Y.applyUpdate(server, Y.encodeStateAsUpdate(seed));
        Y.applyUpdate(device, Y.encodeStateAsUpdate(seed));

        let used = '';
        server.transact(() => {
          used = editYText(server.getText(TEXT_KEY), after, limits);
        });
        expect(used).toBe(path);
        // Разрезанная пара суррогатов превратилась бы в U+FFFD.
        expect(server.getText(TEXT_KEY).toString()).toBe(after);

        Y.applyUpdate(device, Y.encodeStateAsUpdate(server));
        expect(device.getText(TEXT_KEY).toString()).toBe(after);
      }
    },
  );

  it('тот же текст — ничего', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText(TEXT_KEY);
    ytext.insert(0, 'same\n');
    const before = Y.encodeStateVector(doc);
    expect(editYText(ytext, 'same\n')).toBe('none');
    expect(Buffer.from(Y.encodeStateVector(doc)).equals(Buffer.from(before))).toBe(true);
  });

  it('посимвольный дифф трогает только изменённое', () => {
    const doc = new Y.Doc();
    const ytext = doc.getText(TEXT_KEY);
    ytext.insert(0, 'alpha beta\ngamma\ndelta\n');
    const was = Y.decodeStateVector(Y.encodeStateVector(doc)).get(doc.clientID) ?? 0;
    doc.transact(() => editYText(ytext, 'alpha beta\nGAMMA\ndelta\n'));
    // Новых элементов ровно столько, сколько вставлено символов.
    const now = Y.decodeStateVector(Y.encodeStateVector(doc)).get(doc.clientID) ?? 0;
    expect(now - was).toBe('GAMMA'.length);
  });
});
