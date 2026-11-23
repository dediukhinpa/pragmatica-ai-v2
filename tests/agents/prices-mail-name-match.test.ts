import { describe, expect, test } from 'bun:test';
import { MemoryPriceMailAssessor } from '../../src/kit/adapters/memory/price-mail-assessor';
import { runPriceMailTriggers } from '../../src/agents/prices/price-mail-triggers';
import { USER_1, encode } from './prices-support';
import { BUSINESS_ZONE, buildTriggerDeps, triggerMail } from './prices-trigger-support';

const OPTIONS = { timezone: BUSINESS_ZONE };
const STRANGER = 'manager@gmail.example';

/** Письмо с чужого адреса, поставщик назван в подписи («МеталлТорг» есть в базе). */
function foreignMail(id: string, overrides = {}) {
  return triggerMail(id, {
    from: STRANGER,
    subject: 'Повышение цен с 1 ноября',
    body: 'Добрый день! Меняем цены.\n\nС уважением, менеджер ООО «МеталлТорг»',
    ...overrides,
  });
}

async function setup(assessor = new MemoryPriceMailAssessor()) {
  const deps = { ...(await buildTriggerDeps()), mailAssessor: assessor };
  return { deps, assessor };
}

describe('поставщик по названию в тексте письма', () => {
  test('чужой адрес, название в подписи: уведомление с пометкой, модель вызвана', async () => {
    const { deps, assessor } = await setup();
    deps.mailboxes.deliver(USER_1, foreignMail('m1'));
    const result = await runPriceMailTriggers(deps, OPTIONS);
    expect(result).toMatchObject({ notified: 1, notifiedByName: 1, assessed: 1 });
    expect(assessor.calls).toBe(1);
    const text = deps.chat.outbox[0]?.message?.text ?? '';
    expect(text).toContain('МеталлТорг');
    expect(text).toContain('Поставщик определён по названию в тексте,');
    expect(text).toContain('адрес отправителя не из базы.');
  });

  test('модель получает название поставщика, признак «по названию» и текст вложений', async () => {
    const inputs: unknown[] = [];
    const assessor = new MemoryPriceMailAssessor((input) => {
      inputs.push(input);
      return { verdict: 'relevant', reason: 'price_change_announced' };
    });
    const { deps } = await setup(assessor);
    deps.parser = { parse: async () => ({
      text: 'Артикул;Цена', tables: [], needsOcr: false, hasHiddenContent: false,
      hiddenSheets: [], truncated: false, warnings: [],
    }) };
    deps.mailboxes.deliver(USER_1, foreignMail('m1', {
      attachments: [{ fileName: 'price.xlsx', mimeType: 'x', bytes: encode('1') }],
    }));
    await runPriceMailTriggers(deps, OPTIONS);
    expect(inputs[0]).toMatchObject({
      supplierName: 'МеталлТорг',
      matchedByName: true,
      attachmentText: expect.stringContaining('Артикул;Цена'),
    });
  });

  test('то же без названия: не читается, учтено в счётчике', async () => {
    const { deps, assessor } = await setup();
    deps.mailboxes.deliver(USER_1, foreignMail('m1', { body: 'С уважением, менеджер' }));
    const result = await runPriceMailTriggers(deps, OPTIONS);
    expect(result).toMatchObject({ notified: 0, skippedForeign: 1, assessed: 0 });
    expect(assessor.calls).toBe(0);
  });

  test('короткое или общее название по тексту не ищется', async () => {
    const { deps, assessor } = await setup();
    await deps.suppliers.upsert({ id: 'short', name: 'АБВ' });
    await deps.suppliers.upsert({ id: 'generic', name: 'ООО «Опт»' });
    deps.mailboxes.deliver(USER_1, foreignMail('m1', { body: 'АБВ, Опт, ООО Опт' }));
    const result = await runPriceMailTriggers(deps, OPTIONS);
    expect(result).toMatchObject({ notified: 0, skippedForeign: 1 });
    expect(assessor.calls).toBe(0);
  });

  test('название только в цитируемой переписке не считается', async () => {
    const { deps } = await setup();
    deps.mailboxes.deliver(USER_1, foreignMail('m1', {
      body: 'Цены меняем.\n> менеджер МеталлТорг писал ранее\n\nОт: кто-то\nКому: вам\n\n' +
        'От: ещё кто-то\nМеталлТорг',
    }));
    const result = await runPriceMailTriggers(deps, OPTIONS);
    expect(result).toMatchObject({ notified: 0, skippedForeign: 1 });
  });

  test('названия двух поставщиков: не уведомляет, отдельный счётчик', async () => {
    const { deps, assessor } = await setup();
    deps.mailboxes.deliver(USER_1, foreignMail('m1', { body: 'МеталлТорг и Болтик меняют цены' }));
    const result = await runPriceMailTriggers(deps, OPTIONS);
    expect(result).toMatchObject({ notified: 0, nameAmbiguous: 1, skippedForeign: 0 });
    expect(assessor.calls).toBe(0);
  });

  test('модель: «письмо не от этого поставщика» гасит уведомление', async () => {
    const assessor = new MemoryPriceMailAssessor(() => ({
      verdict: 'not_relevant',
      reason: 'other_company',
    }));
    const { deps } = await setup(assessor);
    deps.mailboxes.deliver(USER_1, foreignMail('m1'));
    const result = await runPriceMailTriggers(deps, OPTIONS);
    expect(result).toMatchObject({ notified: 0, assessedNotRelevant: 1 });
  });

  test('без оценщика по названию не уведомляем', async () => {
    const deps = await buildTriggerDeps();
    deps.mailboxes.deliver(USER_1, foreignMail('m1'));
    const result = await runPriceMailTriggers(deps, OPTIONS);
    expect(result).toMatchObject({ notified: 0, skippedForeign: 1 });
  });
});

describe('оценка моделью и предел за запуск', () => {
  test('адрес из базы без подтверждения отправителя: уведомление без пометки', async () => {
    const { deps } = await setup();
    deps.mailboxes.deliver(USER_1, triggerMail('m1', { senderAuth: 'unverified' }));
    const result = await runPriceMailTriggers(deps, OPTIONS);
    expect(result).toMatchObject({ notified: 1, notifiedByName: 0 });
    expect(deps.chat.outbox[0]?.message?.text).not.toContain('по названию в тексте');
  });

  test('письмо без признаков: нет уведомления, модель не вызвана', async () => {
    const { deps, assessor } = await setup();
    deps.mailboxes.deliver(
      USER_1,
      triggerMail('m1', { subject: 'Добрый день', body: 'Как дела?', attachments: [] }),
    );
    const result = await runPriceMailTriggers(deps, OPTIONS);
    expect(result).toMatchObject({ notified: 0, noTrigger: 1, assessed: 0 });
    expect(assessor.calls).toBe(0);
  });

  test('письмо только с xlsx-вложением уходит на оценку', async () => {
    const { deps, assessor } = await setup();
    deps.mailboxes.deliver(USER_1, triggerMail('m1', {
      subject: 'Документы',
      body: 'Во вложении файл',
      attachments: [{ fileName: 'a.xlsx', mimeType: 'x', bytes: encode('1') }],
    }));
    const result = await runPriceMailTriggers(deps, OPTIONS);
    expect(assessor.calls).toBe(1);
    expect(result.notified).toBe(1);
  });

  test('сбой модели: уведомление уходит', async () => {
    const assessor = new MemoryPriceMailAssessor(() => {
      throw new Error('boom');
    });
    const { deps } = await setup(assessor);
    deps.mailboxes.deliver(USER_1, foreignMail('m1'));
    const result = await runPriceMailTriggers(deps, OPTIONS);
    expect(result).toMatchObject({ notified: 1, assessorFailed: 1 });
  });

  test('предел оценок: остаток на следующий тик', async () => {
    const { deps, assessor } = await setup();
    for (const id of ['m1', 'm2', 'm3']) deps.mailboxes.deliver(USER_1, triggerMail(id));
    const first = await runPriceMailTriggers(deps, { ...OPTIONS, assessMaxPerRun: 2 });
    expect(first).toMatchObject({ notified: 2, assessed: 2, assessDeferred: 1 });
    // Слот открыт: следующий тик дочитывает остаток; прежние письма - дубли, без повтора.
    const second = await runPriceMailTriggers(deps, { ...OPTIONS, assessMaxPerRun: 2 });
    expect(second).toMatchObject({ notified: 1, duplicates: 2 });
    expect(assessor.calls).toBe(3);
    // Кроме трёх уведомлений ответственному ушло сообщение об отставании.
    const notices = deps.chat.outbox.filter((m) => m.message?.text?.startsWith('Письмо от'));
    expect(notices).toHaveLength(3);
  });

  test('дубль письма: одно уведомление', async () => {
    const { deps } = await setup();
    deps.mailboxes.deliver(USER_1, foreignMail('m1'));
    await runPriceMailTriggers(deps, OPTIONS);
    const again = await runPriceMailTriggers(deps, OPTIONS);
    expect(again.status).toBe('not_due');
    expect(deps.chat.outbox).toHaveLength(1);
  });
});
