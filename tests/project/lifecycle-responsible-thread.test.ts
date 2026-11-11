import { afterEach, describe, expect, test } from 'bun:test';
import { PRICES_AGENT_ID, type PricesDeps } from '../../src/agents/prices';
import { responsibleThread } from '../../src/agents/prices/deps';
import { clearPragmatikaRuntime } from '../../src/runtime';
import { buildPragmatika } from './support';

/**
 * `PRICE_RESPONSIBLE_THREAD_ID` (SRC `compose-production.ts:750`): тред ответственного за прайсы
 * доходит до зависимостей агента прайсов; не задан - адресат менеджер. Регрессионная защита:
 * в сборке v2 переменная действует, в том числе как тред ожиданий планового запуска
 * (`waitThreadByAgentOf`, см. `lifecycle-disk-sync.test.ts`).
 */

const RESPONSIBLE = 'responsible-thread';
const OWNER = 'owner-1';
const MANAGER = 'manager-thread';

afterEach(() => {
  clearPragmatikaRuntime();
});

function pricesOf(envExtra: Record<string, string>): PricesDeps {
  const { app } = buildPragmatika(envExtra);
  return app.agentDeps?.[PRICES_AGENT_ID] as PricesDeps;
}

describe('PRICE_RESPONSIBLE_THREAD_ID в сборке', () => {
  test('задан - ответственный получает сводки и файл изменений', () => {
    const prices = pricesOf({ PRICE_RESPONSIBLE_THREAD_ID: RESPONSIBLE });
    expect(prices.responsibleThreadId).toBe(RESPONSIBLE);
    expect(responsibleThread(prices)).toBe(RESPONSIBLE);
  });

  test('не задан - запасной адресат владелец, а при MANAGER_THREAD_ID - менеджер', () => {
    expect(responsibleThread(pricesOf({}))).toBe(OWNER);
    expect(responsibleThread(pricesOf({ MANAGER_THREAD_ID: MANAGER }))).toBe(MANAGER);
  });

  test('пустое значение считается незаданным', () => {
    expect(pricesOf({ PRICE_RESPONSIBLE_THREAD_ID: '  ' }).responsibleThreadId).toBeUndefined();
  });
});
