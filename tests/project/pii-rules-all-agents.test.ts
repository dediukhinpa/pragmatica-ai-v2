import { afterAll, describe, expect, test } from 'bun:test';
import { removeTempDirs } from '@business-ai/testing';
import { REPLY_LANGUAGE_PROMPT_RULE } from '../../src/reply-language';
import { buildPragmatika } from './support';

afterAll(removeTempDirs);

/**
 * Правило про слова «токен/метка/условное обозначение» действует во ВСЕХ агентах проекта, а не
 * только в документах (этап 8y, п. 1): в промпте каждого агента при любом наборе флагов.
 */
const AGENT_IDS = ['prices', 'documents', 'order-calc', 'site-export'] as const;
const FLAG_SETS: ReadonlyArray<Record<string, string>> = [
  {},
  { SUPPLIER_CARDS_ENABLED: 'true' },
];

describe('правило языка ответов во всех агентах', () => {
  for (const flags of FLAG_SETS) {
    test(`промпт каждого агента содержит правило (флаги: ${JSON.stringify(flags)})`, () => {
      const { app } = buildPragmatika(flags);
      for (const id of AGENT_IDS) {
        expect(app.registry.get(id).prompt).toContain(REPLY_LANGUAGE_PROMPT_RULE);
      }
    });
  }
});
