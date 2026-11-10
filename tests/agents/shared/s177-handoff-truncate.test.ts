import { describe, expect, test } from 'bun:test';
import { HANDOFF_OUTPUT_MAX_CHARS, truncateHandoffText } from '@business-ai/core';

/** Этап 177: обрезка результата передачи больше не молчаливая. */
describe('truncateHandoffText', () => {
  test('короткий текст не меняется', () => {
    expect(truncateHandoffText('коротко', HANDOFF_OUTPUT_MAX_CHARS)).toBe('коротко');
  });

  test('длинный итог: пометка «обрезано» с числами, длина в пределе', () => {
    const long = 'я'.repeat(HANDOFF_OUTPUT_MAX_CHARS + 500);
    const cut = truncateHandoffText(long, HANDOFF_OUTPUT_MAX_CHARS);
    expect(cut.length).toBeLessThanOrEqual(HANDOFF_OUTPUT_MAX_CHARS);
    const match = /\[обрезано: показано (\d+) из (\d+) символов\]$/.exec(cut);
    expect(match).not.toBeNull();
    expect(Number(match?.[2])).toBe(long.length);
    expect(cut.startsWith('я'.repeat(Number(match?.[1])))).toBe(true);
  });

  test('эмодзи на границе не рвётся пополам', () => {
    const cut = truncateHandoffText('😀'.repeat(100), 60);
    expect(cut).not.toMatch(/[\ud800-\udbff]\n/);
  });
});
