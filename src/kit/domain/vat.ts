import { fromMinorUnits, toMinorUnits } from './money';

/**
 * Действующие ставки НДС в РФ, % - единственный источник для валидаторов, схем и подсказок
 * модели (R9-A1-02). 22 - общая ставка с 01.01.2026, 20 - прежняя общая (документы прошлых
 * периодов), 10 - льготная, 5 и 7 - ставки плательщиков УСН с НДС, 0 - нулевая/без НДС.
 * Ставка документа берётся из источника как есть: ни одна из них не «умолчание».
 */
export const VAT_RATES_PERCENT = [0, 5, 7, 10, 20, 22] as const;

/** Действующая ставка НДС, %. */
export type VatRatePercent = (typeof VAT_RATES_PERCENT)[number];

const PERCENT = 100;

/** Ставка входит в число действующих (сравнение точное: 21.9 не 22). */
export function isAllowedVatRate(rate: number): rate is VatRatePercent {
  return VAT_RATES_PERCENT.some((allowed) => allowed === rate);
}

/** Перечень действующих ставок для сообщений и описаний: «0, 5, 7, 10, 20, 22%». */
export function allowedVatRatesText(): string {
  return `${VAT_RATES_PERCENT.join(', ')}%`;
}

/**
 * НДС, входящий в итог: итог × ставка / (100 + ставка), округление до копейки «от нуля» -
 * тем же `toMinorUnits`, что и суммы строк. Считается от итога в копейках, чтобы двоичная
 * дробь рублей не сдвигала половину копейки.
 */
export function vatIncludedInTotal(total: number, rate: number): number {
  return fromMinorUnits(vatCentsOf(toMinorUnits(total), rate));
}

/** НДС в копейках, входящий в сумму `cents` копеек, с округлением до копейки «от нуля». */
function vatCentsOf(cents: number, rate: number): number {
  return toMinorUnits((cents * rate) / (PERCENT + rate), 0);
}

/**
 * НДС, посчитанный построчно (как в счёте и УПД из 1С): НДС каждой строки округляется до
 * копейки, затем складывается. На многострочном документе отличается от НДС «от итога» до
 * половины копейки на строку: 10 строк по 1,00 ₽ при 20% - 1,70 построчно и 1,67 от итога
 * (R9-A1-07). `lineCents` - суммы строк в копейках.
 */
export function vatIncludedPerLine(lineCents: readonly number[], rate: number): number {
  let vatCents = 0;
  for (const cents of lineCents) vatCents += vatCentsOf(cents, rate);
  return fromMinorUnits(vatCents);
}

/** Начало действия общей ставки НДС: дата ISO `ГГГГ-ММ-ДД` и ставка, %. */
interface VatRateEra {
  from: string;
  rate: number;
}

/**
 * История общей ставки НДС в РФ, по возрастанию даты начала. 18% - с 01.01.2004 (ст. 164 НК РФ),
 * 20% - с 01.01.2019 (ФЗ от 03.08.2018 № 303-ФЗ), 22% - с 01.01.2026 (ФЗ от 28.11.2025 № 425-ФЗ).
 * Источник по 22%: ФНС России, https://www.nalog.gov.ru/rn26/news/smi/16596761/.
 */
const VAT_RATE_HISTORY: readonly VatRateEra[] = [
  { from: '2004-01-01', rate: 18 },
  { from: '2019-01-01', rate: 20 },
  { from: '2026-01-01', rate: 22 },
];

/** Длина даты ISO без времени: `ГГГГ-ММ-ДД`. */
const ISO_DATE_LENGTH = 10;

/**
 * Общая ставка НДС на дату, %. Принимает `ГГГГ-ММ-ДД` (время после даты отбрасывается) либо
 * `Date` (по UTC). Дата раньше начала таблицы или не дата - `undefined`.
 */
export function vatRateOn(date: string | Date): number | undefined {
  const day = (typeof date === 'string' ? date : date.toISOString()).slice(0, ISO_DATE_LENGTH);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  let rate: number | undefined;
  for (const era of VAT_RATE_HISTORY) {
    if (era.from <= day) rate = era.rate;
  }
  return rate;
}
