import { SUPPLIER_FULL_KEYS } from '../../kit/domain/supplier-card-full';
import {
  normalizeEmail,
  type SupplierCard,
  type SupplierContact,
} from '../../kit/domain/supplier-card';
import { normalizeProductName, normalizeSku } from '../../kit/domain/price-diff';
import { type PriceItem } from '../../kit/domain/models';

/**
 * Чистые функции слияния данных двух карточек поставщика: пустые поля целевой карточки
 * дополняются данными донора, значения целевой никогда не затираются (`mergeDraftIntoCard`), и
 * слияние списков цен (`mergePriceLists`). Этап 240: черновиков больше нет, поэтому слияния
 * «черновик -> настоящая» с удалением карточки нет; файл остаётся ради обогащения карточки
 * (`enrichCard`) и переноса цен.
 */

/** Простые поля, которые берутся из непроверенной карточки, если у настоящей пусты. */
const FILLABLE_KEYS = [
  'inn',
  'website',
  'kpp',
  'ogrn',
  'legalAddress',
  'bankName',
  'bik',
  'settlementAccount',
  'correspondentAccount',
  'directorName',
  'productionCity',
  'address',
  'strengths',
  'weaknesses',
  'defectRatePercent',
] as const;

/** Условия работы, которые дополняются так же. */
const TERM_KEYS = ['payment', 'delivery', 'minBatch', 'leadTime', 'discounts'] as const;

/** Шаг, на который версия карточки опережает прежнюю, если часы не ушли вперёд. */
const VERSION_STEP_MS = 1;

/** Кто и когда сливает карточки. */
export interface DraftMergeContext {
  userId: string;
  nowIso: string;
}

function sameContact(a: SupplierContact, b: SupplierContact): boolean {
  if (a.email !== undefined && b.email !== undefined) {
    return normalizeEmail(a.email) === normalizeEmail(b.email);
  }
  if (a.phone !== undefined && a.phone === b.phone) return true;
  const nameA = a.fullName?.trim().toLowerCase();
  return nameA !== undefined && nameA === b.fullName?.trim().toLowerCase();
}

/** Копия значения поля: массивы и их объекты не разделяются с непроверенной карточкой. */
function cloneValue(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((item: unknown) =>
    typeof item === 'object' && item !== null ? { ...item } : item,
  );
}

function unionList(current: readonly string[], extra: readonly string[]): string[] {
  const seen = new Set(current.map((item) => item.trim().toLowerCase()));
  const added = extra.filter((item) => !seen.has(item.trim().toLowerCase()));
  return [...current, ...added];
}

/** Версия карточки строго позже прежней: оптимистичная проверка отличает правки. */
function versionAfter(nowIso: string, previous: string | undefined): string {
  const before = previous === undefined ? Number.NaN : Date.parse(previous);
  const now = Date.parse(nowIso);
  if (Number.isNaN(before) || Number.isNaN(now) || now > before) return nowIso;
  return new Date(before + VERSION_STEP_MS).toISOString();
}

/**
 * Целевая карточка, дополненная данными донора (чистая функция): пустые поля берутся у донора,
 * контакты и списки объединяются, заметки переносятся, добавляется заметка об объединении.
 */
export function mergeDraftIntoCard(
  target: SupplierCard,
  draft: SupplierCard,
  context: DraftMergeContext,
): SupplierCard {
  const merged: SupplierCard = {
    ...target,
    contacts: target.contacts.map((contact) => ({ ...contact })),
    supplies: {
      categories: unionList(target.supplies.categories, draft.supplies.categories),
      brands: unionList(target.supplies.brands, draft.supplies.brands),
      regions: unionList(target.supplies.regions, draft.supplies.regions),
    },
    terms: { ...target.terms },
  };
  const fillable = merged as unknown as Record<string, unknown>;
  const from = draft as unknown as Record<string, unknown>;
  for (const key of [...FILLABLE_KEYS, ...SUPPLIER_FULL_KEYS]) {
    const value = from[key];
    if (fillable[key] === undefined && value !== undefined) fillable[key] = cloneValue(value);
  }
  for (const key of TERM_KEYS) {
    const value = draft.terms[key];
    if (merged.terms[key] === undefined && value !== undefined) merged.terms[key] = value;
  }
  for (const contact of draft.contacts) {
    if (merged.contacts.some((item) => sameContact(item, contact))) continue;
    // Основной контакт настоящей карточки остаётся; без контактов основным станет первый.
    merged.contacts.push({ ...contact, isPrimary: merged.contacts.length === 0 });
  }
  const knownNotes = new Set(
    target.notes.map((note) => `${note.authorId}|${note.createdAt}|${note.text}`),
  );
  const carried = draft.notes.filter(
    (note) => !knownNotes.has(`${note.authorId}|${note.createdAt}|${note.text}`),
  );
  merged.notes = [
    ...target.notes,
    ...carried.map((note) => ({ ...note })),
    {
      text: `Объединена с непроверенной карточкой «${draft.name}»: цены и данные перенесены.`,
      authorId: context.userId,
      createdAt: context.nowIso,
    },
  ];
  merged.updatedBy = context.userId;
  merged.updatedAt = versionAfter(context.nowIso, target.updatedAt);
  return merged;
}

/** Ключ позиции прайса при слиянии: артикул, а без него название, плюс валюта. */
function priceKey(item: PriceItem): string {
  const key =
    item.sku === undefined
      ? `name:${normalizeProductName(item.productName)}`
      : `sku:${normalizeSku(item.sku)}`;
  return `${key}|${item.currency}`;
}

/** Позиции из разных файлов - разные прайс-линии; строка без файла сочетается с любой. */
function sameLine(a: PriceItem, b: PriceItem): boolean {
  return a.sourceFile === undefined || b.sourceFile === undefined || a.sourceFile === b.sourceFile;
}

/**
 * Прайс настоящей карточки после переноса цен непроверенной карточки (чистая функция): все позиции
 * переписываются на `targetId`, `sourceFile` строк сохраняется. Позиция, которая есть у обоих
 * (тот же артикул или название и валюта, и она из одного файла либо у одной из сторон файла
 * нет), остаётся одна - с более поздней датой цены, при равных датах - цена настоящей
 * карточки. Одинаковые позиции из РАЗНЫХ файлов остаются обе: это разные прайс-линии
 * (значки и медали), а не дубль; иначе слияние стирало бы линию одной из карточек. Порядок:
 * сначала прежний прайс карточки, затем новые позиции непроверенной карточки.
 */
export function mergePriceLists(
  targetId: string,
  targetItems: readonly PriceItem[],
  draftItems: readonly PriceItem[],
): PriceItem[] {
  const result = targetItems.map((item): PriceItem => ({ ...item, supplierId: targetId }));
  const index = new Map<string, number[]>();
  const register = (item: PriceItem, position: number): void => {
    const key = priceKey(item);
    index.set(key, [...(index.get(key) ?? []), position]);
  };
  result.forEach((item, position) => register(item, position));
  for (const incoming of draftItems) {
    const moved: PriceItem = { ...incoming, supplierId: targetId };
    const position = (index.get(priceKey(moved)) ?? []).find((at) => {
      const current = result[at];
      return current !== undefined && sameLine(current, moved);
    });
    if (position === undefined) {
      register(moved, result.length);
      result.push(moved);
      continue;
    }
    const current = result[position];
    if (current !== undefined && Date.parse(moved.date) > Date.parse(current.date)) {
      // Файл прежней строки не теряется, если у новой его нет (старая строка без файла).
      const sourceFile = moved.sourceFile ?? current.sourceFile;
      result[position] = sourceFile === undefined ? moved : { ...moved, sourceFile };
    }
  }
  return result;
}
