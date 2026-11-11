import { beforeEach, describe, expect, test } from 'bun:test';
import {
  PRICES_MAIL_READ_PROMPT,
  PRICES_MONITORING_MAIL_PROMPT,
  PRICES_MONITORING_PROMPT,
  PRICES_PROMPT,
} from '../../src/agents/prices/prompt';
import { createPricesAgent, type PricesAgentOptions } from '../../src/agents/prices/declaration';
import { listStalePriceSuppliers } from '../../src/agents/prices/stale-price-suppliers';
import { type ToolContext, FILE_TOOL_PROMPT } from '@business-ai/core';
import { SESSION_SUMMARY_PROMPT } from '../../src/agents/shared/legacy-prompts.owned';
import { SUPPLIER_ID } from './support';
import {
  USER_1,
  USER_THREAD_1,
  buildMailboxPricesDeps,
  employeeContext,
  type MailboxPricesDeps,
} from './prices-support';

/**
 * Агент «Актуализация прайса (ИИ агент)» писем не отправляет и не готовит: ни инструмента
 * черновика, ни кнопок «Отправить» в промпте, ни при каких опциях декларации.
 */

const MODEL = 'm';
const FLAGS = [false, true] as const;
/** Имена, по которым инструмент отправки или подготовки письма узнаётся. */
const MAIL_SEND_TOOL_PATTERN = /draft|send.*mail|mail.*send|sendSupplier|smtp/i;
/** Инструменты чтения почты: единственное, что у агента остаётся от почты. */
const MAIL_READ_TOOLS = ['readPriceMail', 'markPriceMailHandled'];

/** Все сочетания опций декларации, включая снятую опцию `mailSend` (её игнорируют). */
function allOptionSets(): PricesAgentOptions[] {
  const out: PricesAgentOptions[] = [];
  for (const mailbox of FLAGS) {
    for (const monitoring of FLAGS) {
      for (const cards of FLAGS) {
        for (const legacySend of FLAGS) {
          const options = {
            model: MODEL,
            mailbox,
            monitoring,
            mailSend: legacySend,
            ...(cards ? { supplierCards: {} } : {}),
          };
          out.push(options as PricesAgentOptions);
        }
      }
    }
  }
  return out;
}

describe('у агента цен нет отправки почты', () => {
  test('ни одного инструмента отправки или черновика письма ни при каких опциях', () => {
    for (const options of allOptionSets()) {
      const names = createPricesAgent(options).tools.map((tool) => tool.name);
      expect(names.filter((name) => MAIL_SEND_TOOL_PATTERN.test(name))).toEqual([]);
      expect(names).not.toContain('preparePriceRequestDraft');
    }
  });

  test('чтение почты остаётся только при опции mailbox', () => {
    for (const options of allOptionSets()) {
      const names = createPricesAgent(options).tools.map((tool) => tool.name);
      for (const name of MAIL_READ_TOOLS) {
        expect(names.includes(name)).toBe(options.mailbox === true);
      }
    }
  });

  test('промпт не упоминает кнопку «Отправить» и черновик письма', () => {
    for (const options of allOptionSets()) {
      const { prompt } = createPricesAgent(options);
      expect(prompt).not.toContain('Отправить');
      expect(prompt).not.toContain('preparePriceRequestDraft');
      expect(prompt).not.toMatch(/черновик/i);
    }
  });

  test('промпт: задачу ставит сотрудник, писем поставщикам агент не отправляет', () => {
    for (const prompt of [PRICES_PROMPT, PRICES_MAIL_READ_PROMPT]) {
      expect(prompt).toContain('Задачу по ценам даёт сотрудник');
      expect(prompt).toContain('Писем поставщикам ты не готовишь и не');
      expect(prompt).toContain('Готовых «обновлений прайса» по письму или расписанию сам не');
    }
    expect(PRICES_MONITORING_PROMPT).not.toContain('Отправить');
    expect(PRICES_MONITORING_MAIL_PROMPT).not.toContain('Отправить');
  });

  test('без mailbox и с mailbox промпт без дополнений, как и прежде', () => {
    const tail = SESSION_SUMMARY_PROMPT + FILE_TOOL_PROMPT;
    expect(createPricesAgent({ model: MODEL }).prompt).toBe(PRICES_PROMPT + tail);
    expect(createPricesAgent({ model: MODEL, mailbox: true }).prompt).toBe(
      PRICES_MAIL_READ_PROMPT + tail,
    );
  });

  test('описание listStalePriceSuppliers говорит, что письма агент не отправляет', () => {
    expect(listStalePriceSuppliers.description).toContain('не отправля');
  });
});
