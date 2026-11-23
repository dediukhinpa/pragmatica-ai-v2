import { describe, expect, test } from 'bun:test';
import { parseIsoDeadline } from '../../../src/kit/domain/iso-datetime';

/** D-14: срок «действует до» без времени истекает в конце суток по МСК, а не в её начале. */
describe('срок действия КП без времени', () => {
  const MSK_END_OF_DAY = Date.parse('2026-03-10T23:59:59.999+03:00');

  test('дата без времени — конец суток по Москве', () => {
    expect(parseIsoDeadline('2026-03-10')).toBe(MSK_END_OF_DAY);
  });

  test('в полдень того же дня срок ещё не истёк', () => {
    const noonUtc = Date.parse('2026-03-10T12:00:00Z');
    expect((parseIsoDeadline('2026-03-10') ?? 0) < noonUtc).toBe(false);
  });
});
