import { describe, expect, test } from 'bun:test';
import { mapPool } from '@business-ai/core';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('mapPool', () => {
  test('результаты в порядке элементов, а не завершения', async () => {
    const out = await mapPool([30, 1, 10], 3, async (ms) => {
      await sleep(ms);
      return ms;
    });
    expect(out).toEqual([30, 1, 10]);
  });

  test('одновременно идёт не больше concurrency задач', async () => {
    let running = 0;
    let peak = 0;
    await mapPool([1, 2, 3, 4, 5, 6, 7], 3, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await sleep(2);
      running -= 1;
    });
    expect(peak).toBe(3);
  });

  test('после ошибки новые элементы не берутся, бросается первая ошибка', async () => {
    const started: number[] = [];
    const run = mapPool([0, 1, 2, 3, 4, 5], 2, async (item) => {
      started.push(item);
      await sleep(1);
      if (item === 1) throw new Error('boom');
      return item;
    });
    await expect(run).rejects.toThrow('boom');
    expect(started.length).toBeLessThan(6);
  });

  test('пустой список и некорректный concurrency не ломают обход', async () => {
    expect(await mapPool([], 3, async (x: number) => x)).toEqual([]);
    expect(await mapPool([1, 2], 0, async (x) => x * 2)).toEqual([2, 4]);
  });
});
