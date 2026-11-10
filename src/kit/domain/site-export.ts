import { z } from 'zod';
import { parseNumberText } from './number-text';
import { findTextRisks } from '@business-ai/core';
import type { ValidationIssue } from '@business-ai/core';

/** Допустимые типы значений поля карточки. */
const EXPORT_FIELD_TYPES = ['string', 'number', 'boolean'] as const;
type ExportFieldType = (typeof EXPORT_FIELD_TYPES)[number];

/** Значение поля карточки выгрузки. */
type CardValue = string | number | boolean;
/** Карточка в формате шаблона: имя поля -> значение; пустые поля отсутствуют. */
export type ExportCard = Record<string, CardValue>;
/** Карточка из источника до применения шаблона. */
export type SourceCard = Record<string, CardValue | null | undefined>;

/** Поле шаблона выгрузки. */
interface ExportFieldSpec {
  name: string;
  type: ExportFieldType;
  required: boolean;
  /** Из какого поля исходной карточки брать значение; по умолчанию то же имя. */
  from?: string | undefined;
}

/** Правила для сгенерированных описаний. */
export interface DescriptionRules {
  minLength: number;
  maxLength: number;
  /** Запрещённые шаблонные фразы (без учёта регистра). */
  forbiddenPhrases: string[];
}

/** Длины описания по умолчанию: допущение до получения шаблона заказчика. */
const DEFAULT_DESCRIPTION_MIN_LENGTH = 40;
const DEFAULT_DESCRIPTION_MAX_LENGTH = 1_000;
/** Шаблонные фразы-«вода» и следы незаполненного текста. */
const DEFAULT_FORBIDDEN_PHRASES: readonly string[] = [
  'лучшее предложение',
  'лучшая цена',
  'не имеет аналогов',
  'высокое качество по низкой цене',
  'lorem ipsum',
  'todo',
  '[вставьте',
];

/**
 * Предел длины столбца «Описание» выгрузочной таблицы сайта (этап 225): сайт не принимает
 * длиннее. Превышение не обрезается: текст сжимается смыслово (моделью) либо возвращается
 * агенту на сокращение.
 */
export const SITE_DESCRIPTION_MAX_CHARS = 1_500;

/** Значения по умолчанию для `ExportTemplate.description`. */
export const DEFAULT_DESCRIPTION_RULES: DescriptionRules = {
  minLength: DEFAULT_DESCRIPTION_MIN_LENGTH,
  maxLength: DEFAULT_DESCRIPTION_MAX_LENGTH,
  forbiddenPhrases: [...DEFAULT_FORBIDDEN_PHRASES],
};

/**
 * Шаблон выгрузки как данные. Реального формата заказчика пока нет: структура задаётся
 * конфигурацией, код от конкретных имён полей не зависит.
 */
export interface ExportTemplate {
  name: string;
  fields: ExportFieldSpec[];
  /** Поле артикула: по нему ищутся дубли и адресуются карточки. */
  skuField: string;
  /** Поле цены: пустая или неположительная цена блокирует публикацию. */
  priceField?: string | undefined;
  /** Поле описания; без него описания в карточки не пишутся. */
  descriptionField?: string | undefined;
  description?: DescriptionRules | undefined;
}
export const exportTemplateSchema: z.ZodType<ExportTemplate, z.ZodTypeDef, unknown> = z.object({
  name: z.string().min(1),
  fields: z
    .array(
      z.object({
        name: z.string().min(1),
        type: z.enum(EXPORT_FIELD_TYPES),
        required: z.boolean(),
        from: z.string().min(1).optional(),
      }),
    )
    .min(1),
  skuField: z.string().min(1),
  priceField: z.string().min(1).optional(),
  descriptionField: z.string().min(1).optional(),
  description: z
    .object({
      minLength: z.number().int().nonnegative(),
      maxLength: z.number().int().positive(),
      forbiddenPhrases: z.array(z.string().min(1)),
    })
    .optional(),
});

/**
 * Привести значение к типу поля, если это однозначно (числа из текста, единый разбор
 * `parseNumberText`); неоднозначное «1,234» остаётся текстом - проверка вернёт `wrong_type`.
 */
function coerce(value: CardValue, type: ExportFieldType): CardValue {
  if (typeof value === 'string') {
    const text = value.trim();
    if (type === 'number') {
      const parsed = parseNumberText(text);
      if (parsed.kind === 'ok') return parsed.value;
    }
    return text;
  }
  return value;
}

/**
 * Применить шаблон к исходной карточке: оставить только поля шаблона (с переименованием
 * `from` -> `name`), убрать пустые значения. Типы не «чинятся»: несоответствие найдёт проверка.
 */
export function mapCardToTemplate(source: SourceCard, template: ExportTemplate): ExportCard {
  const card: ExportCard = {};
  for (const field of template.fields) {
    const raw = source[field.from ?? field.name];
    if (raw === null || raw === undefined) continue;
    const value = coerce(raw, field.type);
    if (value !== '') card[field.name] = value;
  }
  return card;
}

function skuLabel(card: ExportCard, template: ExportTemplate, index: number): string {
  const sku = card[template.skuField];
  return typeof sku === 'string' && sku !== '' ? `«${sku}»` : `№${index + 1}`;
}

/** Число должно быть конечным (NaN и бесконечность — не цена и не количество). */
function isFiniteValue(value: CardValue): boolean {
  return typeof value !== 'number' || Number.isFinite(value);
}

function normalizeSku(value: CardValue | undefined): string {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * Проверка набора карточек перед публикацией: обязательные поля, типы, дубли артикулов,
 * пустые цены. Чистая функция: сообщения называют артикул или номер, без значений полей.
 */
export function validateExportCards(
  cards: readonly ExportCard[],
  template: ExportTemplate,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (cards.length === 0) {
    issues.push({ code: 'no_cards', message: 'Набор карточек пуст.' });
    return issues;
  }
  const firstSeen = new Map<string, number>();
  cards.forEach((card, index) => {
    const label = skuLabel(card, template, index);
    for (const field of template.fields) {
      const value = card[field.name];
      if (value === undefined) {
        // Пустая цена отмечается отдельным кодом ниже.
        if (field.required && field.name !== template.priceField) {
          issues.push({
            code: 'missing_field',
            message: `Карточка ${label}: не заполнено обязательное поле ${field.name}.`,
          });
        }
      } else if (typeof value !== field.type || !isFiniteValue(value)) {
        issues.push({
          code: 'wrong_type',
          message: `Карточка ${label}: поле ${field.name} должно быть типа ${field.type}.`,
        });
      }
    }
    issues.push(...textRiskIssues(card, template, label));
    if (template.priceField !== undefined) {
      const price = card[template.priceField];
      if (price === undefined || (typeof price === 'number' && !(price > 0))) {
        issues.push({
          code: 'empty_price',
          message: `Карточка ${label}: цена не указана или не положительна.`,
        });
      }
    }
    const sku = normalizeSku(card[template.skuField]);
    if (sku !== '') {
      const first = firstSeen.get(sku);
      if (first === undefined) firstSeen.set(sku, index);
      else {
        issues.push({
          code: 'duplicate_sku',
          message: `Артикул ${label} повторяется (карточки №${first + 1} и №${index + 1}).`,
        });
      }
    }
  });
  return issues;
}

/**
 * Текстовые поля карточки не должны нести ПДн (почта, телефон, токен) и, в описании, ссылки:
 * текст пришёл из чужих писем и страниц (R3-SEC-4). Артикул не проверяется.
 */
function textRiskIssues(
  card: ExportCard,
  template: ExportTemplate,
  label: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const field of template.fields) {
    const value = card[field.name];
    if (typeof value !== 'string' || field.name === template.skuField) continue;
    const risks = findTextRisks(value);
    const personal = risks.filter((risk) => risk !== 'link');
    if (personal.length > 0) {
      issues.push({
        code: 'text_has_pii',
        message: `Карточка ${label}: в поле ${field.name} похоже на ПДн (${personal.join(', ')}).`,
      });
    }
    if (risks.includes('link') && field.name === template.descriptionField) {
      issues.push({
        code: 'text_has_link',
        message: `Карточка ${label}: в описании ссылка, публиковать её нельзя.`,
      });
    }
  }
  return issues;
}

/** Проверка описания: длина, запрещённые шаблонные фразы, ПДн и ссылки. */
export function validateDescription(
  text: string,
  rules: DescriptionRules = DEFAULT_DESCRIPTION_RULES,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const length = text.trim().length;
  if (length < rules.minLength) {
    issues.push({
      code: 'description_too_short',
      message: `Описание короче ${rules.minLength} символов (сейчас ${length}).`,
    });
  }
  if (length > rules.maxLength) {
    issues.push({
      code: 'description_too_long',
      message: `Описание длиннее ${rules.maxLength} символов (сейчас ${length}).`,
    });
  }
  const risks = findTextRisks(text);
  if (risks.length > 0) {
    issues.push({
      code: 'description_has_pii_or_link',
      message: `В описании ПДн или ссылка (${risks.join(', ')}): уберите их.`,
    });
  }
  const lower = text.toLowerCase();
  for (const phrase of rules.forbiddenPhrases) {
    if (lower.includes(phrase.toLowerCase())) {
      issues.push({
        code: 'forbidden_phrase',
        message: `В описании запрещённая шаблонная фраза «${phrase}».`,
      });
    }
  }
  return issues;
}
