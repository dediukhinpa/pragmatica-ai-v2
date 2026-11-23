import { afterAll, describe, expect, test } from 'bun:test';
import { removeTempDirs } from '@business-ai/testing';
import { IMAGE_WARNINGS_PROMPT } from '../../src/image-warnings-prompt';
import { PRICES_SCAN_FLOW_PROMPT, SCAN_FLOW_FLAG } from '../../src/scan-price-flow';
import { buildPragmatika } from './support';

afterAll(removeTempDirs);

/** Агент из собранного приложения при заданном окружении. */
function agentOf(env: Record<string, string>, id: string) {
  return buildPragmatika(env).app.registry.get(id);
}

describe('сканы и предупреждения о картинках в сборке (этап 9v)', () => {
  test('по умолчанию агент прайсов получает инструмент скана и оба абзаца промпта', () => {
    const prices = agentOf({}, 'prices');
    expect(prices.tools.map((tool) => tool.name)).toContain('createScanPriceCopy');
    expect(prices.prompt).toContain(PRICES_SCAN_FLOW_PROMPT);
    expect(prices.prompt).toContain(IMAGE_WARNINGS_PROMPT);
  });

  test('PRICES_SCAN_FLOW_ENABLED=false: нет инструмента и абзаца про сканы', () => {
    const prices = agentOf({ [SCAN_FLOW_FLAG]: 'false' }, 'prices');
    expect(prices.tools.map((tool) => tool.name)).not.toContain('createScanPriceCopy');
    expect(prices.prompt).not.toContain(PRICES_SCAN_FLOW_PROMPT);
  });

  test('VISION_TEXT_FIRST=false: промпт без абзаца про предупреждения о картинках', () => {
    const prices = agentOf({ VISION_TEXT_FIRST: 'false' }, 'prices');
    expect(prices.prompt).not.toContain(IMAGE_WARNINGS_PROMPT);
  });

  test('другие агенты инструмент и абзацы не получают', () => {
    for (const id of ['documents', 'order-calc', 'site-export']) {
      const agent = agentOf({}, id);
      expect(agent.tools.map((tool) => tool.name)).not.toContain('createScanPriceCopy');
      expect(agent.prompt).not.toContain(PRICES_SCAN_FLOW_PROMPT);
      expect(agent.prompt).not.toContain(IMAGE_WARNINGS_PROMPT);
    }
  });
});
