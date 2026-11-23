import { beforeEach, describe, expect, test } from 'bun:test';
import { MemoryAccessPolicy, MemoryAgentRuntime } from '@business-ai/adapters';
import {
  CHAT_JUMP_NOT_REQUIRED_TEXT,
  retiredPriceJumpButton,
} from '../../src/kit/app/chat-pump.owned';
import {
  JUMP_DECISION_NAMESPACE,
  JUMP_REQUEST_NAMESPACE,
  PRICES_AGENT_ID,
} from '../../src/agents/prices/deps';
import { mailRecordId, readPriceMail } from '../../src/agents/prices/price-mail';
import { stagePriceRows } from '../../src/agents/prices/stage-price-rows';
import {
  commitPriceImport,
  stagedImportValidator,
} from '../../src/agents/prices/commit-price-import';
import { createPricesAgent } from '../../src/agents/prices/declaration';
import { previewPriceChanges } from '../../src/agents/prices/price-changes';
import { toRunSpec } from '@business-ai/core';
import { callTool, say, scriptedRuntime, type StepFn } from '../kit/adapters/mastra/support';
import { buildPump, declaration } from '../kit/app/support';
import { MODEL_ALIAS, SUPPLIER_ID, lastToolResult } from './support';
import {
  COLUMNS,
  USER_1,
  USER_THREAD_1,
  buildFullPricesDeps,
  employeeContext,
  encode,
  mailMessage,
  skuCsv,
  skuItem,
  stageDiskCsv,
  type FullPricesDeps,
} from './prices-support';

/*
 * Скачки цен и прайс из письма неподтверждённого отправителя подтверждения не требуют (решения
 * владельца 26.10.2026): скачок с диска пишется в базу и показывается в файле изменений, прайс
 * не с диска становится предложением. Кнопок решения нет; старые кнопки `pjump:` получают
 * короткий ответ и ничего не записывают.
 */

/** Ход сотрудника, чей ящик читается: он поручил работу. */
const CTX = employeeContext(USER_1, USER_THREAD_1);
const BOSS = 'boss-user';
/** Цена в базе и цена со скачком (x4, выше порога). */
const BASE_PRICE = 10;
const JUMP_PRICE = 40;

let deps: FullPricesDeps;
beforeEach(async () => {
  deps = await buildFullPricesDeps();
  await deps.prices.saveImport(SUPPLIER_ID, [skuItem('Болт', BASE_PRICE, 'B1')], 'seed');
});

const args = (fileHash: string) => ({ supplierId: SUPPLIER_ID, fileHash });
const codes = async (fileHash: string) =>
  (await stagedImportValidator.validate(args(fileHash), deps, CTX)).map((i) => i.code);
const basePrice = async () => (await deps.prices.listBySupplier(SUPPLIER_ID))[0]?.price;
const anyButtons = () =>
  deps.chat.outbox.some((item) => (item.message?.buttons?.length ?? 0) > 0);

/** Прайс со скачком цены из письма раскладывается в staging. */
async function stageMail(senderAuth?: 'verified'): Promise<string> {
  const csv = skuCsv([['Болт', JUMP_PRICE, 'B1']]);
  const attachments = [{ fileName: 'p.csv', mimeType: 'text/csv', bytes: encode(csv) }];
  const auth = senderAuth ? { senderAuth } : {};
  deps.mailboxes.deliver(USER_1, mailMessage({ id: 'm1', attachments, ...auth }));
  await readPriceMail.execute({}, deps, CTX);
  const staged = await stagePriceRows.execute(
    {
      path: `mail:${mailRecordId(USER_1, 'm1')}#0`,
      supplierId: SUPPLIER_ID,
      columns: COLUMNS,
      reset: true,
    },
    deps,
    CTX,
  );
  return staged.fileHash;
}

describe('скачок цены решения человека не требует', () => {
  test('файл с диска: скачок виден в preview, commit пишет в базу без кнопки', async () => {
    const { fileHash } = await stageDiskCsv(deps, [['Болт', JUMP_PRICE, 'B1']]);
    const preview = await previewPriceChanges.execute(args(fileHash), deps, CTX);
    expect(preview.counts.jumps).toBe(1);
    expect(preview).not.toHaveProperty('approvalStatus');
    expect(await codes(fileHash)).toEqual([]);
    const done = await commitPriceImport.execute(args(fileHash), deps, CTX);
    expect(done).toMatchObject({ saved: 1, changed: 1 });
    expect(await basePrice()).toBe(JUMP_PRICE);
    expect(deps.chat.outbox).toHaveLength(0);
  });

  for (const senderAuth of [undefined, 'verified'] as const) {
    const who = senderAuth === undefined ? 'неподтверждённого' : 'подтверждённого';
    test(`письмо ${who} отправителя со скачком: предложение, база прежняя`, async () => {
      const fileHash = await stageMail(senderAuth);
      const preview = await previewPriceChanges.execute(args(fileHash), deps, CTX);
      expect(preview.counts.jumps).toBe(1);
      expect(await codes(fileHash)).toEqual([]);
      const done = await commitPriceImport.execute(args(fileHash), deps, CTX);
      expect(done).toMatchObject({ saved: 0, status: 'proposed_not_written' });
      expect(await basePrice()).toBe(BASE_PRICE);
      expect(anyButtons()).toBe(false);
    });
  }
});

describe('старая кнопка pjump из отправленного сообщения', () => {
  /** Чат-насос с общей с агентом базой состояния; агента он запускать не должен. */
  function buildPricesPump(withState: boolean) {
    const access = new MemoryAccessPolicy();
    access.allow({ userId: BOSS, botId: PRICES_AGENT_ID, action: 'chat.button' });
    const runtime = new MemoryAgentRuntime();
    const pump = buildPump({
      channel: deps.chat,
      access,
      runtime,
      agent: toRunSpec({ ...declaration, id: PRICES_AGENT_ID }),
      buttonHandlers: [retiredPriceJumpButton],
      ...(withState ? { state: deps.state } : {}),
    });
    return { pump, runtime };
  }

  for (const withState of [true, false]) {
    test(`короткий ответ, ничего не записано (состояние: ${withState})`, async () => {
      const { pump, runtime } = buildPricesPump(withState);
      for (const buttonId of ['pjump:ok:tok1', 'pjump:no:tok1']) {
        await pump.accept({ kind: 'button', threadId: USER_THREAD_1, userId: BOSS, buttonId });
      }
      await pump.whenIdle();
      const texts = deps.chat.outbox.map((item) => item.message?.text);
      expect(texts).toEqual([CHAT_JUMP_NOT_REQUIRED_TEXT, CHAT_JUMP_NOT_REQUIRED_TEXT]);
      expect(await runtime.getThread(USER_THREAD_1)).toBeNull();
      expect(await deps.state.list(JUMP_DECISION_NAMESPACE, null, 1)).toHaveLength(0);
      expect(await deps.state.list(JUMP_REQUEST_NAMESPACE, null, 1)).toHaveLength(0);
    });
  }
});

describe('агентский цикл: без паузы на подтверждение', () => {
  const agentRuntime = (steps: StepFn) =>
    scriptedRuntime(createPricesAgent({ model: MODEL_ALIAS, mailbox: true }), deps, steps);
  /** Ход сотрудника, чей ящик читается: он и есть владелец работы. */
  const TURN = { context: { initiator: { kind: 'user', userId: USER_1 } } } as const;

  test('письмо неподтверждённого отправителя: preview → commit → файл, ход завершён', async () => {
    const csv = skuCsv([['Болт', JUMP_PRICE, 'B1']]);
    const attachments = [{ fileName: 'p.csv', mimeType: 'text/csv', bytes: encode(csv) }];
    deps.mailboxes.deliver(USER_1, mailMessage({ id: 'm1', attachments }));
    let fileHash = '';
    let diffHash = '';
    const { runtime, spec } = agentRuntime((request, call) => {
      if (call === 0) return callTool('c-read', 'readPriceMail', {});
      if (call === 1) {
        return callTool('c-stage', 'stagePriceRows', {
          path: `mail:${mailRecordId(USER_1, 'm1')}#0`,
          supplierId: SUPPLIER_ID,
          columns: COLUMNS,
          reset: true,
        });
      }
      if (call === 2) {
        fileHash = String(lastToolResult(request).fileHash);
        return callTool('c-prev', 'previewPriceChanges', args(fileHash));
      }
      if (call === 3) {
        diffHash = String(lastToolResult(request).diffHash);
        return callTool('c-commit', 'commitPriceImport', args(fileHash));
      }
      if (call === 4) {
        return callTool('c-send', 'sendPriceChangeFile', { ...args(fileHash), diffHash });
      }
      return say('Предложение цен отправлено сотруднику файлом изменений');
    });
    const done = await runtime.run(spec, 't1', 'обработай прайс', TURN);
    expect(done.status).toBe('completed');
    expect(await basePrice()).toBe(BASE_PRICE);
    expect(deps.chat.outbox.some((o) => o.file !== undefined)).toBe(true);
    const texts = deps.chat.outbox.map((o) => o.message?.text ?? '').join('\n');
    expect(texts).toContain('Отправитель письма не подтверждён.');
    expect(anyButtons()).toBe(false);
  });
});
