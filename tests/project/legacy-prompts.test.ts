import { describe, expect, test } from 'bun:test';
import {
  HISTORY_SEARCH_PROMPT as PLATFORM_HISTORY,
  SESSION_SUMMARY_PROMPT as PLATFORM_SUMMARY,
} from '@business-ai/core';
import {
  HISTORY_SEARCH_PROMPT,
  SESSION_SUMMARY_PROMPT,
} from '../../src/agents/shared/legacy-prompts.owned';

describe('проектные блоки промпта', () => {
  test('история диалога называет КП и сделки, а не нейтральные заявки', () => {
    expect(HISTORY_SEARCH_PROMPT).toContain('searchConversationHistory');
    expect(HISTORY_SEARCH_PROMPT).toContain('КП');
    expect(HISTORY_SEARCH_PROMPT).not.toBe(PLATFORM_HISTORY);
  });

  test('сводка диалогов называет поставщиков и КП', () => {
    expect(SESSION_SUMMARY_PROMPT).toContain('поставщики');
    expect(SESSION_SUMMARY_PROMPT).toContain('КП');
    expect(SESSION_SUMMARY_PROMPT).not.toBe(PLATFORM_SUMMARY);
  });
});
