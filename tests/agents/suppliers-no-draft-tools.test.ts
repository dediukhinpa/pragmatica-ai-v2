import { beforeEach, describe, expect, test } from 'bun:test';
import { SUPPLIER_CARD_REQUEST_NAMESPACE } from '../../src/agents/suppliers/deps';
import { supplierCardsTools } from '../../src/agents/suppliers/tools';
import { toStoredJson } from '@business-ai/core';
import { type SupplierCardRequest } from '../../src/agents/suppliers/card-request';
import {
  THREAD_A,
  USER_A,
  buildSupplierWorld,
  pressOf,
  type SupplierWorld,
} from './suppliers-support';

/** Этап 240: черновиков нет, инструментов подтверждения и слияния черновика больше нет. */

const OLD_TOKEN = 'old-draft-request';
const NOW = '2026-11-09T10:00:00.000Z';

let world: SupplierWorld;
beforeEach(() => {
  world = buildSupplierWorld();
});

function legacyRequest(kind: 'draft_confirm' | 'draft_merge'): SupplierCardRequest {
  return {
    token: OLD_TOKEN,
    agentId: 'suppliers',
    ownerUserId: USER_A,
    threadId: THREAD_A,
    requestedAt: NOW,
    status: 'shown',
    kind,
    mode: 'edit',
    targetId: 'real-1',
    ...(kind === 'draft_merge' ? { draftId: 'draft-1' } : {}),
    duplicateIds: [],
    source: 'chat',
  } as SupplierCardRequest;
}

describe('карточки без черновиков', () => {
  test('инструментов подтверждения и слияния черновика нет', () => {
    const names = supplierCardsTools().map((tool) => tool.name);
    expect(names).not.toContain('prepareCardMerge');
    expect(names).not.toContain('prepareCardVerify');
  });

  test('запрос прежнего вида, показанный до обновления, закрывается без записи', async () => {
    for (const kind of ['draft_confirm', 'draft_merge'] as const) {
      await world.state.put(
        SUPPLIER_CARD_REQUEST_NAMESPACE,
        OLD_TOKEN,
        toStoredJson(legacyRequest(kind)),
      );
      const outcome = await world.service.press(pressOf(OLD_TOKEN, USER_A, THREAD_A, 'save'));
      expect(outcome.kind).toBe('unknown_request');
      expect(await world.suppliers.searchCards({ limit: 10 })).toHaveLength(0);
      // Повторное нажатие тоже ничего не меняет.
      const again = await world.service.press(pressOf(OLD_TOKEN, USER_A, THREAD_A, 'save'));
      expect(['unknown_request', 'already_done']).toContain(again.kind);
    }
  });
});
