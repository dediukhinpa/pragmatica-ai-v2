import { z } from 'zod';
import type { RequestItem } from '../kit/domain/models';

/** Единица измерения по умолчанию, если у позиции её нет. */
export const DEFAULT_DEAL_UNIT = 'шт';
/** Имя пользовательского поля сделки Bitrix24. */
const FIELD_NAME_PATTERN = /^UF_CRM_[A-Z0-9_]+$/;
/** Разделитель частей строки позиции в пользовательском поле. */
const LINE_SEPARATOR = ';';
/** Минимум частей строки: название и количество. */
const LINE_PARTS_MIN = 2;
/** Максимум частей строки: название, количество, единица. */
const LINE_PARTS_MAX = 3;
/** Количество: целое или дробное с точкой либо запятой; `1e3` не принимается. */
const QUANTITY_PATTERN = /^\d+(?:[.,]\d+)?$/;
const NEWLINE = /\r?\n/;

/**
 * Карта полей сделки (переменная `BITRIX24_DEAL_FIELD_MAP`): откуда берутся позиции заявки.
 * Без карты позиции идут из товарных строк сделки. `deadlineField` и `slaHours` остаются
 * допустимыми ключами и игнорируются: схема строгая, и уже заданная в окружении карта иначе
 * уронила бы старт службы.
 */
export const dealFieldMapSchema = z
  .object({
    /** Источник позиций: товарные строки сделки либо пользовательское поле построчного вида. */
    items: z
      .discriminatedUnion('source', [
        z.object({ source: z.literal('productRows') }).strict(),
        z
          .object({
            source: z.literal('field'),
            field: z.string().regex(FIELD_NAME_PATTERN),
            /** Каждая строка: `Название; количество; единица` (единица необязательна). */
            format: z.literal('lines'),
          })
          .strict(),
      ])
      .default({ source: 'productRows' }),
    deadlineField: z.string().regex(FIELD_NAME_PATTERN).optional(),
    slaHours: z.number().positive().optional(),
    /** Единица, если у позиции её нет (по умолчанию `шт`). */
    defaultUnit: z.string().trim().min(1).optional(),
  })
  .strict();

/** Карта полей сделки (разобранная). */
export type DealFieldMap = z.infer<typeof dealFieldMapSchema>;

/** Результат разбора позиций: годные позиции и номера (с 1) отброшенных строк. */
export interface ParsedDealItems {
  items: RequestItem[];
  /** Номера отброшенных строк источника: без их текстов (в них могут быть данные клиента). */
  droppedRows: number[];
}

/** Количество: положительное конечное число; `10.0000` и `10,5` допустимы, `1e3` - нет. */
export function parseQuantity(value: string | number): number | null {
  const number =
    typeof value === 'number'
      ? value
      : QUANTITY_PATTERN.test(value.trim())
        ? Number(value.trim().replace(',', '.'))
        : Number.NaN;
  return Number.isFinite(number) && number > 0 ? number : null;
}

/** Позиция из названия, количества и единицы; пустое название или плохое количество - null. */
export function itemFrom(
  name: string,
  quantity: string | number,
  unit: string,
): RequestItem | null {
  const trimmed = name.trim();
  const amount = parseQuantity(quantity);
  if (trimmed === '' || amount === null) return null;
  return { name: trimmed, quantity: amount, unit };
}

/**
 * Разобрать построчное поле. Пустые строки пропускаются без счёта; строка не из 2-3 частей,
 * с нечитаемым количеством или пустым названием отбрасывается и считается (номер - по тексту
 * поля, пустые строки в нумерации участвуют).
 */
export function scanLineItems(text: string, defaultUnit: string): ParsedDealItems {
  const items: RequestItem[] = [];
  const droppedRows: number[] = [];
  for (const [index, rawLine] of text.split(NEWLINE).entries()) {
    const line = rawLine.trim();
    if (line === '') continue;
    const parts = line.split(LINE_SEPARATOR).map((part) => part.trim());
    const [name, quantity, unit] = parts;
    const shapeOk = parts.length >= LINE_PARTS_MIN && parts.length <= LINE_PARTS_MAX;
    const item =
      shapeOk && name !== undefined && quantity !== undefined
        ? itemFrom(name, quantity, unit === undefined || unit === '' ? defaultUnit : unit)
        : null;
    if (item === null) droppedRows.push(index + 1);
    else items.push(item);
  }
  return { items, droppedRows };
}

/** Число годных позиций и число отброшенных строк поля. */
export function parseLineItems(
  text: string,
  defaultUnit: string,
): { items: RequestItem[]; dropped: number } {
  const { items, droppedRows } = scanLineItems(text, defaultUnit);
  return { items, dropped: droppedRows.length };
}
