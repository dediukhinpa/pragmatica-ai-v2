import { describe, expect, test } from 'bun:test';
import { createDocumentsAgent } from '../../src/agents/documents/declaration';
import { createOrderCalcAgent } from '../../src/agents/order-calc/declaration';
import { createPricesAgent } from '../../src/agents/prices/declaration';
import { createSiteExportAgent } from '../../src/agents/site-export/declaration';
import { FILE_TOOL_PROMPT } from '@business-ai/core';
import { SESSION_SUMMARY_PROMPT } from '../../src/agents/shared/legacy-prompts.owned';

const MODEL = 'alias-main';

describe('правило про сводку прошлых диалогов в промптах агентов', () => {
  test('все четыре агента получают правило перепроверки цифр из сводки', () => {
    const agents = [
      createPricesAgent({ model: MODEL }),
      createPricesAgent({ model: MODEL, mailbox: true }),
      createOrderCalcAgent({ model: MODEL }),
      createDocumentsAgent({ model: MODEL }),
      createSiteExportAgent({ model: MODEL }),
    ];
    for (const agent of agents) {
      expect(agent.prompt.endsWith(SESSION_SUMMARY_PROMPT + FILE_TOOL_PROMPT)).toBe(true);
    }
    expect(SESSION_SUMMARY_PROMPT).toContain('перепроверьте инструментом');
    expect(SESSION_SUMMARY_PROMPT).toContain('источник важнее сводки');
  });
});
