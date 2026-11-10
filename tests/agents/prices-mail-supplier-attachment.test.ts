import { describe, expect, test } from 'bun:test';
import { runPriceMailTriggers } from '../../src/agents/prices/price-mail-triggers';
import { MemoryPriceMailAssessor } from '../../src/kit/adapters/memory/price-mail-assessor';
import { hasSupplierTableAttachment } from '../../src/kit/domain/price-mail-triggers';
import { USER_1, encode } from './prices-support';
import { BUSINESS_ZONE, buildTriggerDeps, triggerMail } from './prices-trigger-support';

const OPTIONS = { timezone: BUSINESS_ZONE };

/** Письмо поставщика с таблицей и без слов-триггеров. */
function tableMail(id: string, fileName = 'file.xlsx', overrides = {}) {
  return triggerMail(id, {
    subject: 'Документы',
    body: 'Во вложении актуальный файл',
    attachments: [{ fileName, mimeType: 'x', bytes: encode('1') }],
    ...overrides,
  });
}

describe('4б: письма поставщиков с таблицей без слов-триггеров', () => {
  test('расширения вложений: таблицы и pdf, регистр не важен', () => {
    expect(hasSupplierTableAttachment(['A.XLSX'])).toBe(true);
    expect(hasSupplierTableAttachment(['a.csv', 'b.doc'])).toBe(true);
    expect(hasSupplierTableAttachment(['a.pdf'])).toBe(true);
    expect(hasSupplierTableAttachment(['a.docx', 'xlsx', 'a.png'])).toBe(false);
  });

  test('поставщик + xlsx без триггеров: оценка и уведомление с признаком', async () => {
    const assessor = new MemoryPriceMailAssessor();
    const deps = { ...(await buildTriggerDeps()), mailAssessor: assessor };
    deps.mailboxes.deliver(USER_1, tableMail('m1'));
    const result = await runPriceMailTriggers(deps, OPTIONS);
    expect(assessor.calls).toBe(1);
    expect(result).toMatchObject({ notified: 1, noTrigger: 0, supplierAttachmentMatched: 1 });
    expect(deps.chat.outbox[0]?.message?.text).toContain('Найдено: письмо поставщика с таблицей.');
  });

  test('не поставщик + xlsx без триггеров: пропуск без оценки', async () => {
    const assessor = new MemoryPriceMailAssessor();
    const deps = { ...(await buildTriggerDeps()), mailAssessor: assessor };
    deps.mailboxes.deliver(USER_1, tableMail('m1', 'file.xlsx', { from: 'stranger@other.example' }));
    const result = await runPriceMailTriggers(deps, OPTIONS);
    expect(assessor.calls).toBe(0);
    expect(result).toMatchObject({ notified: 0, skippedForeign: 1, supplierAttachmentMatched: 0 });
  });

  test('поставщик без вложения и триггеров: пропуск', async () => {
    const assessor = new MemoryPriceMailAssessor();
    const deps = { ...(await buildTriggerDeps()), mailAssessor: assessor };
    deps.mailboxes.deliver(
      USER_1,
      triggerMail('m1', { subject: 'Добрый день', body: 'Как дела?', attachments: [] }),
    );
    const result = await runPriceMailTriggers(deps, OPTIONS);
    expect(assessor.calls).toBe(0);
    expect(result).toMatchObject({ notified: 0, noTrigger: 1 });
  });

  test('поставщик с вложением не-таблицей (png): пропуск', async () => {
    const deps = await buildTriggerDeps();
    deps.mailboxes.deliver(USER_1, tableMail('m1', 'logo.png'));
    const result = await runPriceMailTriggers(deps, OPTIONS);
    expect(result).toMatchObject({ notified: 0, noTrigger: 1 });
  });

  test('оценщик «не про цены»: без уведомления', async () => {
    const assessor = new MemoryPriceMailAssessor(() => ({
      verdict: 'not_relevant',
      reason: 'unrelated_mention',
    }));
    const deps = { ...(await buildTriggerDeps()), mailAssessor: assessor };
    deps.mailboxes.deliver(USER_1, tableMail('m1'));
    const result = await runPriceMailTriggers(deps, OPTIONS);
    expect(result).toMatchObject({ notified: 0, assessedNotRelevant: 1 });
    expect(deps.chat.outbox).toEqual([]);
  });

  test('оценщик выключен: уведомление, как при сработавшем триггере', async () => {
    const deps = await buildTriggerDeps();
    deps.mailboxes.deliver(USER_1, tableMail('m1', 'file.PDF'));
    const result = await runPriceMailTriggers(deps, OPTIONS);
    expect(result).toMatchObject({ notified: 1, supplierAttachmentMatched: 1 });
  });

  test('лимит за прогон: сверх предела письмо ждёт следующего тика', async () => {
    const assessor = new MemoryPriceMailAssessor();
    const deps = { ...(await buildTriggerDeps()), mailAssessor: assessor };
    for (const id of ['m1', 'm2', 'm3']) deps.mailboxes.deliver(USER_1, tableMail(id));
    const first = await runPriceMailTriggers(deps, { ...OPTIONS, supplierAttachmentMaxPerRun: 2 });
    expect(first).toMatchObject({
      notified: 2,
      supplierAttachmentMatched: 2,
      supplierAttachmentDeferred: 1,
    });
    // Слот не закрыт: следующий тик дообрабатывает остаток, прежние письма не дублируются.
    const second = await runPriceMailTriggers(deps, { ...OPTIONS, supplierAttachmentMaxPerRun: 2 });
    expect(second).toMatchObject({ status: 'done', notified: 1, duplicates: 2 });
    expect(deps.chat.outbox).toHaveLength(3);
  });
});
