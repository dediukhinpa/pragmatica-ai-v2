import { afterAll, describe, expect, test } from 'bun:test';
import { removeTempDirs } from '@business-ai/testing';
import { withPriceCopyTools } from '../../src/assembly/price-copy-tools';
import { PRICE_EDIT_DIRECT_TOOL, PRICE_ROUNDING_NOTE } from '../../src/price-edit-direct';
import { PRICE_EDIT_FIRST_PROMPT, PRICE_FILE_ONCE_PROMPT } from '../../src/price-edit-prompt';
import { buildPragmatika } from './support';

afterAll(removeTempDirs);

/** Инструменты агента из собранного приложения. */
function toolsOf(env: Record<string, string>, agentId: string): string[] {
  const { app } = buildPragmatika(env);
  return app.registry.get(agentId).tools.map((tool) => tool.name);
}

describe('xlsx-копия прайса в сборке (этап 9t)', () => {
  test('агент прайсов получает createPriceFileCopy, другие агенты - нет', () => {
    expect(toolsOf({}, 'prices')).toContain('createPriceFileCopy');
    for (const id of ['documents', 'order-calc', 'site-export']) {
      expect(toolsOf({}, id)).not.toContain('createPriceFileCopy');
    }
  });

  test('PRICE_EDIT_FIRST_ENABLED=false возвращает прежний набор без копии', () => {
    expect(toolsOf({ PRICE_EDIT_FIRST_ENABLED: 'false' }, 'prices')).not.toContain(
      'createPriceFileCopy',
    );
  });
});

/** Агент прайсов из собранного приложения. */
function pricesOf(env: Record<string, string>) {
  return buildPragmatika(env).app.registry.get('prices');
}

describe('повторная отправка последнего файла (этап 9u)', () => {
  // Флаг по умолчанию включён: явное «выключено» даёт прежнюю сборку
  const FLAGS = { PRICE_FILE_ONCE_PER_TURN_ENABLED: 'true' };
  const OFF = { PRICE_FILE_ONCE_PER_TURN_ENABLED: 'false' };

  test('флаг выключен: нет инструмента, правила округления и абзаца промпта', () => {
    const prices = pricesOf(OFF);
    expect(prices.tools.map((tool) => tool.name)).not.toContain('resendLastPriceFile');
    const edit = prices.tools.find((tool) => tool.name === PRICE_EDIT_DIRECT_TOOL);
    expect(edit?.description).not.toContain(PRICE_ROUNDING_NOTE);
    expect(prices.prompt).not.toContain(PRICE_FILE_ONCE_PROMPT);
  });

  test('с флагом инструмент подключён один раз, описание правки с правилом округления', () => {
    const prices = pricesOf(FLAGS);
    const names = prices.tools.map((tool) => tool.name);
    expect(names.filter((name) => name === 'resendLastPriceFile')).toHaveLength(1);
    const edit = prices.tools.find((tool) => tool.name === PRICE_EDIT_DIRECT_TOOL);
    expect(edit?.description.endsWith(PRICE_ROUNDING_NOTE)).toBe(true);
    expect(prices.prompt).toContain(PRICE_FILE_ONCE_PROMPT);
  });

  test('флаг без PRICE_EDIT_FIRST_ENABLED инструмент не подключает', () => {
    const names = pricesOf({ ...FLAGS, PRICE_EDIT_FIRST_ENABLED: 'false' }).tools.map(
      (tool) => tool.name,
    );
    expect(names).not.toContain('resendLastPriceFile');
  });

  test('другие агенты инструмент не получают', () => {
    for (const id of ['documents', 'order-calc', 'site-export']) {
      expect(toolsOf(FLAGS, id)).not.toContain('resendLastPriceFile');
    }
  });

  test('withPriceCopyTools: повторное применение не дублирует инструмент и фразу', () => {
    const base = pricesOf(OFF);
    const once = withPriceCopyTools(base, { copy: true, resend: true });
    const twice = withPriceCopyTools(once, { copy: true, resend: true });
    const names = twice.tools.map((tool) => tool.name);
    expect(names.filter((name) => name === 'resendLastPriceFile')).toHaveLength(1);
    const edit = twice.tools.find((tool) => tool.name === PRICE_EDIT_DIRECT_TOOL);
    expect(edit?.description.split(PRICE_ROUNDING_NOTE)).toHaveLength(2);
  });

  test('без опции resend набор инструментов и описания прежние', () => {
    const base = pricesOf(OFF);
    const same = withPriceCopyTools(base, { copy: true });
    expect(same.tools.map((tool) => tool.name)).toEqual(base.tools.map((tool) => tool.name));
    expect(same.tools.map((tool) => tool.description)).toEqual(
      base.tools.map((tool) => tool.description),
    );
  });

  test('промпт правила не меняет прежний абзац правки цены', () => {
    expect(PRICE_EDIT_FIRST_PROMPT).not.toContain('resendLastPriceFile');
  });
});
