import { describe, expect, test } from 'bun:test';
import { hasWorkCalendar, isCalendarWorkingDay } from '@business-ai/core';
import { workingDaysUntil } from '../../../src/kit/domain/work-calendar.owned';

describe('производственный календарь РФ', () => {
  test('праздники и переносы 2026 и 2027', () => {
    expect(isCalendarWorkingDay('2026-11-04')).toBe(false);
    expect(isCalendarWorkingDay('2026-01-09')).toBe(false); // перенос с 3 января
    expect(isCalendarWorkingDay('2026-12-31')).toBe(false); // перенос с 4 января
    expect(isCalendarWorkingDay('2027-02-20')).toBe(true); // рабочая суббота
    expect(isCalendarWorkingDay('2027-11-05')).toBe(false); // перенос с 2 января
    expect(isCalendarWorkingDay('2026-10-28')).toBe(true);
  });

  test('рабочих дней в году - как в календаре: 247 и 247', () => {
    for (const year of [2026, 2027]) {
      expect(workingDaysUntil(`${year - 1}-12-31`, `${year}-12-31`)).toBe(247);
    }
  });

  test('«до 05.11.2026» от 28.10.2026 - 5 рабочих дней (4 ноября праздник)', () => {
    expect(workingDaysUntil('2026-10-28', '2026-11-05')).toBe(5);
  });

  test('дата не позже начала или год вне календаря - undefined', () => {
    expect(workingDaysUntil('2026-10-28', '2026-10-28')).toBeUndefined();
    expect(workingDaysUntil('2026-10-28', '2026-10-01')).toBeUndefined();
    expect(workingDaysUntil('2027-12-20', '2028-01-20')).toBeUndefined();
    expect(hasWorkCalendar(2028)).toBe(false);
  });
});
