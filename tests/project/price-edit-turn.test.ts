import { describe, expect, test } from 'bun:test';
import {
  UPDATED_VERSION_MARK,
  emptyTurnRecord,
  isReplay,
  isUpdatedVersion,
  versionedFileName,
  withTurnQueue,
  type TurnRecord,
} from '../../src/price-edit-turn';

/** Учёт отправленных файлов правки за ход: имена версий и очередь вызовов. */

const NAME = 'Прайс_новые_цены_01.01.2026.pptx';
/** Пауза первой работы в очереди, мс: вторая не должна обогнать её. */
const SLOW_MS = 20;

function recordOf(...keys: string[]): TurnRecord {
  return { sends: keys.map((key) => ({ key, name: `имя-${key}` })), carried: [] };
}

describe('versionedFileName', () => {
  test('первая отправка хода: имя как есть', () => {
    expect(versionedFileName(NAME, emptyTurnRecord(), 'k1')).toBe(NAME);
  });

  test('вторая: пометка перед расширением, третья: с номером', () => {
    expect(versionedFileName(NAME, recordOf('k1'), 'k2')).toBe(
      `Прайс_новые_цены_01.01.2026_${UPDATED_VERSION_MARK}.pptx`,
    );
    expect(versionedFileName(NAME, recordOf('k1', 'k2'), 'k3')).toBe(
      `Прайс_новые_цены_01.01.2026_${UPDATED_VERSION_MARK}_2.pptx`,
    );
  });

  test('повтор отправки: прежнее имя из записи, пометки нет', () => {
    expect(versionedFileName(NAME, recordOf('k1'), 'k1')).toBe('имя-k1');
    expect(isReplay(recordOf('k1'), 'k1')).toBe(true);
    expect(isUpdatedVersion(recordOf('k1'), 'k1')).toBe(false);
    expect(isUpdatedVersion(recordOf('k1'), 'k2')).toBe(true);
    expect(isUpdatedVersion(emptyTurnRecord(), 'k1')).toBe(false);
  });

  test('имя без расширения: пометка в конце', () => {
    expect(versionedFileName('Прайс', recordOf('k1'), 'k2')).toBe(`Прайс_${UPDATED_VERSION_MARK}`);
  });
});

describe('withTurnQueue', () => {
  test('работы с одним ключом идут по очереди, с разными - независимо', async () => {
    const order: string[] = [];
    const slow = withTurnQueue('a', async () => {
      await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
      order.push('a1');
    });
    const fast = withTurnQueue('a', async () => {
      order.push('a2');
    });
    const other = withTurnQueue('b', async () => {
      order.push('b');
    });
    await Promise.all([slow, fast, other]);
    expect(order).toEqual(['b', 'a1', 'a2']);
  });

  test('сбой первой работы не останавливает очередь', async () => {
    const failing = withTurnQueue('c', async () => {
      throw new Error('сбой');
    });
    const next = withTurnQueue('c', async () => 'ок');
    await expect(failing).rejects.toThrow('сбой');
    expect(await next).toBe('ок');
  });
});
