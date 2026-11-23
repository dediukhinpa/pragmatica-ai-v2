import { z } from 'zod';
import { RATING_MAX, RATING_MIN } from './supplier-rating';

/**
 * Оценка поставщика с коротким обоснованием (ответ модели или кэш). Обоснование читает
 * менеджер, поэтому код проверяет его так же строго, как оценку: длина, одна строка, ни email,
 * ни телефонов, ни серий цифр, ни ссылок.
 */

/** Предел длины обоснования, символов. */
export const SUPPLIER_RATING_RATIONALE_MAX_LENGTH = 200;

/** С какой длины серия цифр в обосновании считается открытым числом (ИНН, телефон, счёт). */
const RATIONALE_DIGIT_SERIES_MIN = 5;

const WHITESPACE = /\s+/g;
/** Разделители внутри числа: «8 (495) 123-45-67» читается как одна серия цифр. */
const DIGIT_SEPARATORS = /(?<=\d)[\s().-]+(?=\d)/g;
const DIGIT_SERIES = new RegExp(`\\d{${RATIONALE_DIGIT_SERIES_MIN},}`);
const URL_MARK = /:\/\/|www\./i;

/** Результат оценки: целое от 1 до 5 и короткое обоснование. */
export interface SupplierRatingVerdict {
  score: number;
  rationale: string;
}

/** Строгая схема ответа: ровно два поля, лишние отвергаются. */
const verdictSchema = z
  .object({
    score: z.number().int().min(RATING_MIN).max(RATING_MAX),
    rationale: z.string(),
  })
  .strict();

/**
 * Обоснование в одну строку либо `null`, если оно не подходит: пустое, длиннее предела,
 * с email, ссылкой или серией из пяти и более цифр (в том числе телефоном с разделителями).
 */
export function normalizeRationale(raw: string): string | null {
  const text = raw.normalize('NFC').replace(WHITESPACE, ' ').trim();
  if (text === '' || text.length > SUPPLIER_RATING_RATIONALE_MAX_LENGTH) return null;
  if (text.includes('@') || URL_MARK.test(text)) return null;
  if (DIGIT_SERIES.test(text.replace(DIGIT_SEPARATORS, ''))) return null;
  return text;
}

/** Проверить значение извне (ответ модели, запись кэша); не подошло - `null`. */
export function parseSupplierRatingVerdict(raw: unknown): SupplierRatingVerdict | null {
  const parsed = verdictSchema.safeParse(raw);
  if (!parsed.success) return null;
  const rationale = normalizeRationale(parsed.data.rationale);
  return rationale === null ? null : { score: parsed.data.score, rationale };
}
