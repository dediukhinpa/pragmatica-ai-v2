import { afterAll, describe, expect, test } from 'bun:test';
import { removeTempDirs } from '@business-ai/testing';
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
