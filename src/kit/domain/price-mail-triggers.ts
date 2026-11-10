/**
 * Поиск признаков «письмо о ценах»: повышение цен, изменение цен, новый прайс. Сами слова,
 * правила и подписи - данные в `price-mail-trigger-phrases.ts`; здесь они собираются в
 * регулярные выражения и применяются к письму. Правка словаря не требует правки кода поиска.
 *
 * Поиск идёт по токенам: нижний регистр, `ё` -> `е`, всё кроме букв и цифр - разделитель.
 * Правило срабатывает, когда токен-«якорь» стоит не дальше `PRICE_MAIL_TRIGGER_WINDOW_TOKENS`
 * токенов от токена-«партнёра» (в любом порядке) либо, если партнёра в правиле нет, - просто
 * при наличии якоря. Токены сравниваются с записью целиком (или по основе со звёздочкой), поэтому
 * «прайсовая политика» или «центр» ничему не соответствуют.
 */

import {
  PRICE_MAIL_SUPPLIER_TABLE_EXTENSIONS,
  PRICE_MAIL_TRIGGER_BODY_MAX_CHARS,
  PRICE_MAIL_TRIGGER_SPECS,
  PRICE_MAIL_TRIGGER_WINDOW_TOKENS,
  PRICE_MAIL_WORD_CLASSES,
  type PriceMailField,
  type PriceMailTriggerId,
  type PriceMailWordClass,
} from './price-mail-trigger-phrases';

/** Признак основы в записи слова: `повыш*`. */
const STEM_MARK = '*';
/** Спецсимволы регулярных выражений: слова словаря в шаблон вставляются экранированными. */
const REGEXP_SPECIAL_RE = /[.*+?^${}()|[\]\\]/g;

/** Правило триггера: якорь и (необязательно) партнёр рядом с ним. */
interface PriceMailTriggerRule {
  /** В каких частях письма правило действует. */
  fields: readonly PriceMailField[];
  /** Шаблон токена-якоря. */
  anchor: RegExp;
  /** Шаблон токена-партнёра; без него достаточно одного якоря. */
  partner?: RegExp;
}

/** Описание триггера: подпись и собранные правила. */
export interface PriceMailTrigger {
  id: PriceMailTriggerId;
  /** Подпись для сообщения сотруднику. */
  label: string;
  rules: readonly PriceMailTriggerRule[];
}

/** Шаблон одной записи словаря: слово целиком либо основа с любым окончанием. */
function entryPattern(entry: string): string {
  if (entry.endsWith(STEM_MARK)) {
    const stem = entry.slice(0, -STEM_MARK.length).replace(REGEXP_SPECIAL_RE, '\\$&');
    return `${stem}\\p{L}*`;
  }
  return entry.replace(REGEXP_SPECIAL_RE, '\\$&');
}

/** Шаблон токена для набора классов слов: любая запись любого из классов. */
function classesPattern(classes: readonly PriceMailWordClass[]): RegExp {
  const entries = classes.flatMap((name) => PRICE_MAIL_WORD_CLASSES[name]);
  return new RegExp(`^(?:${entries.map(entryPattern).join('|')})$`, 'u');
}

/** Словарь триггеров, собранный из данных (порядок - порядок в сообщении). */
export const PRICE_MAIL_TRIGGERS: readonly PriceMailTrigger[] = PRICE_MAIL_TRIGGER_SPECS.map(
  (spec) => ({
    id: spec.id,
    label: spec.label,
    rules: spec.rules.map((rule) => ({
      fields: rule.fields,
      anchor: classesPattern(rule.anchor),
      ...(rule.partner === undefined ? {} : { partner: classesPattern(rule.partner) }),
    })),
  }),
);

/** Что передаётся на проверку: только поля, нужные словарю. */
export interface PriceMailTriggerInput {
  subject: string;
  body: string;
  attachmentNames: readonly string[];
}

/** Найденный триггер: что нашли и в каких частях письма. */
export interface PriceMailTriggerMatch {
  id: PriceMailTriggerId;
  label: string;
  fields: readonly PriceMailField[];
}

/** Не буква и не цифра - разделитель токенов. */
const NON_WORD_RE = /[^\p{L}\p{N}]+/gu;

/** Разбить текст на токены: нижний регистр, `ё` -> `е`, пунктуация и подчёркивания - границы. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(NON_WORD_RE, ' ')
    .split(' ')
    .filter((token) => token !== '');
}

/** Правило срабатывает на этом списке токенов. */
function ruleMatches(rule: PriceMailTriggerRule, tokens: readonly string[]): boolean {
  for (const [index, token] of tokens.entries()) {
    if (!rule.anchor.test(token)) continue;
    if (rule.partner === undefined) return true;
    const from = Math.max(0, index - PRICE_MAIL_TRIGGER_WINDOW_TOKENS);
    const to = Math.min(tokens.length - 1, index + PRICE_MAIL_TRIGGER_WINDOW_TOKENS);
    for (let near = from; near <= to; near += 1) {
      const candidate = tokens[near];
      if (near !== index && candidate !== undefined && rule.partner.test(candidate)) return true;
    }
  }
  return false;
}

/**
 * Какие триггеры из словаря есть в письме. Пустой список - письмо не про цены. Каждый
 * триггер возвращается один раз, поля - те, где он найден.
 */
export function detectPriceMailTriggers(input: PriceMailTriggerInput): PriceMailTriggerMatch[] {
  const parts: Record<PriceMailField, string[][]> = {
    subject: [tokenize(input.subject)],
    body: [tokenize(input.body.slice(0, PRICE_MAIL_TRIGGER_BODY_MAX_CHARS))],
    attachment: input.attachmentNames.map(tokenize),
  };
  const found: PriceMailTriggerMatch[] = [];
  for (const trigger of PRICE_MAIL_TRIGGERS) {
    const fields = new Set<PriceMailField>();
    for (const rule of trigger.rules) {
      for (const field of rule.fields) {
        if (parts[field].some((tokens) => ruleMatches(rule, tokens))) fields.add(field);
      }
    }
    if (fields.size > 0) found.push({ id: trigger.id, label: trigger.label, fields: [...fields] });
  }
  return found;
}

/** Есть ли среди имён вложений таблица или pdf (по расширению, регистр не важен). */
export function hasSupplierTableAttachment(attachmentNames: readonly string[]): boolean {
  return attachmentNames.some((name) => {
    const dot = name.trim().lastIndexOf('.');
    if (dot === -1) return false;
    return PRICE_MAIL_SUPPLIER_TABLE_EXTENSIONS.includes(
      name.trim().slice(dot + 1).toLowerCase(),
    );
  });
}
