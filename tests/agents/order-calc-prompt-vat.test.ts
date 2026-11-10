import { describe, expect, test } from 'bun:test';
import {
  ORDER_CALC_NO_VAT_RULE,
  ORDER_CALC_MAIL_PROMPT,
  ORDER_CALC_PROMPT,
} from '../../src/agents/order-calc/prompt';

/**
 * п.2 доработок 08.11: «НДС / без НДС / НДС не указан» показывает только шорт-лист (код).
 * Агент поиска поставщиков в свободных ответах вне шорт-листа НДС не пишет.
 */

const PROMPTS: Array<[string, string]> = [
  ['без почты', ORDER_CALC_PROMPT],
  ['с почтой', ORDER_CALC_MAIL_PROMPT],
];

/** Абзац шага КП про НДС ответа поставщика: функциональное поле recordQuote, не пересказ цен. */
function isQuoteStepLine(line: string): boolean {
  return /vatIncluded|помечает как/u.test(line);
}

describe('промпт агента поиска поставщиков: НДС только в шорт-листе', () => {
  test('правило называет шорт-лист единственным местом и запрещает пересказ', () => {
    expect(ORDER_CALC_NO_VAT_RULE).toContain('только шорт-лист');
    expect(ORDER_CALC_NO_VAT_RULE).toContain('не упоминай');
    expect(ORDER_CALC_NO_VAT_RULE).toContain('не пересказывай');
    expect(ORDER_CALC_NO_VAT_RULE).toContain('searchInternet');
  });

  for (const [title, prompt] of PROMPTS) {
    test(`${title}: правило есть в разделе «Правила»`, () => {
      const rules = prompt.slice(prompt.indexOf('\nПравила:'));
      expect(rules).toContain(ORDER_CALC_NO_VAT_RULE);
    });

    test(`${title}: вне шага КП НДС в промпте упомянут только в самом правиле`, () => {
      const outside = prompt
        .replace(ORDER_CALC_NO_VAT_RULE, '')
        .split('\n')
        .filter((line) => /НДС/u.test(line) && !isQuoteStepLine(line));
      expect(outside).toEqual([]);
    });
  }
});
