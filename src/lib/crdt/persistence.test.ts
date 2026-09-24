// @vitest-environment node
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { TEXT_KEY, buildInitialState, extendYjsState, hashText } from './persistence';

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

describe('extendYjsState: новый текст поверх сохранённой истории', () => {
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

    const next = extendYjsState(serverState, NEW);
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

    const next = extendYjsState(serverState, sameText);
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
      const next = extendYjsState(stored, NEW);
      const doc = new Y.Doc();
      Y.applyUpdate(doc, next.state);
      expect(doc.getText(TEXT_KEY).toString()).toBe(NEW);
      expect(next.changed).toBe(true);
    }
  });
});
