import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Разовый проход по info@ (220b): отчёт подтверждают владелец и координатор на сервере
 * (`--report`/`--apply`/`--recheck`), а не сотрудники в Битриксе. Охранный тест, перенесённый из
 * прежней сборки: у кода прохода, отчёта и применения нет доступа к чату и CRM, то есть написать
 * сотруднику он не может.
 */

const ROOT = join(import.meta.dir, '../../src');
const FILES = [
  'agents/suppliers/mail-enrich.ts',
  'agents/suppliers/mail-backfill-report.ts',
  'agents/suppliers/mail-backfill-apply.ts',
  'background-mail-backfill.ts',
];
const CHAT_MARKERS = [/ChatChannel/u, /\bchat\.(send|post|reply)/u, /sendMessage/u, /Bitrix/iu];

describe('разовый проход info@ не обращается к сотрудникам', () => {
  for (const file of FILES) {
    test(`${file}: нет чата и Битрикса`, () => {
      const text = readFileSync(join(ROOT, file), 'utf8');
      for (const marker of CHAT_MARKERS) expect(text).not.toMatch(marker);
    });
  }

  test('точка входа собирает приложение на заглушках чата и CRM', () => {
    const text = readFileSync(join(ROOT, 'background-cli.ts'), 'utf8');
    expect(text).toContain('new MemoryChatChannel(');
    expect(text).toContain('new MemoryCrm(');
  });
});
