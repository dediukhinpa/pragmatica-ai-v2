import { describe, expect, test } from 'bun:test';
import { MemoryCrm } from '@business-ai/adapters';
import type { IdempotencyKey } from '@business-ai/core';
import { PlatformBackedCrm } from '../../src/adapters/platform-crm';

const KEY = 'note-key-1' as IdempotencyKey;

describe('PlatformBackedCrm', () => {
  test('заметка уходит в платформенный порт, повтор под тем же ключом не дублирует', async () => {
    const base = new MemoryCrm();
    const crm = new PlatformBackedCrm(base);
    await crm.addNote('deal-1', 'Текст заметки', KEY);
    await crm.addNote('deal-1', 'Текст заметки', KEY);
    expect(base.notes.get('deal-1')).toEqual(['Текст заметки']);
  });

  test('заявка по сделке не разбирается: платформенный порт этого не умеет', async () => {
    const crm = new PlatformBackedCrm(new MemoryCrm());
    expect(await crm.getPurchaseRequest('deal-1')).toBeNull();
  });
});
