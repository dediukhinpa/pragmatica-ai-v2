import { beforeEach, describe, expect, test } from 'bun:test';
import { CONTRACT_TEMPLATES } from '../../src/agents/documents/template-registry';
import { buildRenderData } from '../../src/agents/documents/render-data';
import { createDocumentsAgent } from '../../src/agents/documents/declaration';
import { checkTemplateFieldsTool } from '../../src/agents/documents/check-template-fields';
import { fillTemplate } from '../../src/agents/documents/fill-template';
import {
  issueContractNumber,
  resolveRenderContext,
} from '../../src/agents/documents/contract-number';
import { withIssueDate } from '../../src/agents/documents/issue-date';
import type { DealDocument } from '../../src/kit/domain/models';
import type { RenderRequest } from '@business-ai/core';
import { CTX, buildDocument, buildDocumentsDeps, putFile } from './support';

let deps: Awaited<ReturnType<typeof buildDocumentsDeps>>;

beforeEach(async () => {
  deps = await buildDocumentsDeps();
  for (const template of CONTRACT_TEMPLATES) putFile(deps, template.fileName, 'tpl');
});

const MG_READY = '2026_МГ_Шаблон_Договора_на_поставку_готовой_продукции.docx';
const PR_READY = 'Шаблон_ПР_Договора_на_поставку_готовой_продукции.docx';
const NDA = 'МГ Соглашение NDA.docx';

const REQUISITES = {
  inn: '7707083893',
  kpp: '770701001',
  bik: '044525225',
  settlementAccount: '40702810900000000001',
  bankName: 'ПАО Банк',
  correspondentAccount: '30101810400000000225',
  legalAddress: 'г. Москва, ул. Тестовая, 1',
  directorName: 'Иванов И. И.',
};
const FIELDS = {
  seller_representative: 'директора Иванова И. И.',
  seller_position: 'директор',
  seller_authority_basis: 'Устава',
  payment_variant: 'advance',
  delivery_variant: 'pickup',
  prepayment_percent: '30',
  spec_number: '1',
  spec_date: '2026-10-22',
  tz_number: '2',
  production_days: '20',
  delivery_days: '5',
  warranty_period: '12 месяцев',
  warranty_months: '12',
  buyer_contact_name: 'Петров П. П.',
  buyer_contact_phone: '+7 900 000-00-00',
  buyer_contact_email: 'p@example.com',
  seller_contactName: 'Сидоров С. С.',
  seller_phone: '+7 900 111-11-11',
  seller_email: 's@example.com',
};

function contract(overrides: Partial<DealDocument> = {}): DealDocument {
  return buildDocument({
    kind: 'contract',
    number: 'МОДЕЛЬ-1',
    issuedAt: '2026-10-21',
    seller: 'ООО «Ромашка»',
    supplierId: 's1',
    requestId: 'REQ-1',
    total: 1,
    lines: [
      {
        name: 'Болт М8',
        quantity: 10,
        unitPrice: 12_000,
        characteristics: 'сталь',
        term: '10 дн.',
      },
    ],
    requisites: REQUISITES,
    templateFields: FIELDS,
    ...overrides,
  });
}

const check = (document: DealDocument, templatePath = MG_READY) =>
  checkTemplateFieldsTool.execute({ templatePath, document }, deps, CTX);

/** Данные, с которыми fillTemplate вызвал рендерер. */
async function renderedRequest(document: DealDocument, templatePath: string) {
  const seen: RenderRequest[] = [];
  const spy = {
    render: async (request: RenderRequest) => {
      seen.push(request);
      return deps.renderer.render(request);
    },
  };
  await fillTemplate.execute({ templatePath, document }, { ...deps, renderer: spy }, CTX);
  return seen[0];
}

describe('номер и дата договора называет сотрудник, система их не присваивает', () => {
  test('номер и дата сотрудника подставлены как названы, счётчик не тронут', async () => {
    const request = await renderedRequest(
      contract({ number: 'Д-15', issuedAt: '2026-10-21' }),
      MG_READY,
    );
    expect(request?.data.fields['number']).toBe('Д-15');
    expect(request?.data.fields['contract_number']).toBe('Д-15');
    expect(request?.outputName).toBe('Ромашка_Договор_Д-15.docx');
    expect(await deps.contractNumbering?.find('contract-number:s1:request:REQ-1')).toBeNull();
  });

  test('номера нет: маркер вместо номера и ни одного выданного номера', async () => {
    const context = await resolveRenderContext(contract({ number: '' }), deps, MG_READY, 'issue');
    expect(context.document.number).toBe('');
    expect(context.options.contractNumber).toBeUndefined();
    const request = await renderedRequest(contract({ number: '' }), MG_READY);
    expect(request?.data.fields['number']).toBe('[ЗАПОЛНИТЬ: номер договора]');
    expect(request?.data.fields['contract_number']).toBe('[ЗАПОЛНИТЬ: номер договора]');
    const latest = await deps.contractNumbering?.findLatest('contract-number:', 'mg');
    expect(latest).toBeNull();
  });

  test('даты нет: сегодняшняя не подставляется, в файле маркер даты', async () => {
    const context = await resolveRenderContext(contract({ issuedAt: '' }), deps, MG_READY, 'issue');
    expect(context.document.issuedAt).toBe('');
    const request = await renderedRequest(contract({ issuedAt: '' }), MG_READY);
    expect(request?.data.fields['issuedAt']).toBe('[ЗАПОЛНИТЬ: дата договора]');
  });

  test('checkTemplateFields: номер и дата в недостающих, вопрос шлёт в реестр', async () => {
    const out = await check(contract({ number: '', issuedAt: '' }));
    expect(out.missingLabels).toEqual(expect.arrayContaining(['number', 'issuedAt']));
    expect(out.questions.join(' ')).toContain('реестре договоров');
  });

  test('у остальных видов документов пустая дата по-прежнему сегодняшняя', () => {
    const offer = buildDocument({ kind: 'commercial_offer', issuedAt: '' });
    expect(withIssueDate(offer, deps).issuedAt).toBe('2026-01-01');
    expect(withIssueDate(contract({ issuedAt: '' }), deps).issuedAt).toBe('');
  });

  test('агент не получает инструмент issueContractNumber', () => {
    const names = createDocumentsAgent({ model: 'm' }).tools.map((tool) => tool.name);
    expect(names).not.toContain('issueContractNumber');
    expect(names).toContain('searchContractRegistry');
  });

  test('промпт не обещает номер от системы и требует напомнить про реестр', () => {
    const prompt = createDocumentsAgent({ model: 'm' }).prompt;
    expect(prompt).not.toContain('Номер договора присваивает система');
    expect(prompt).not.toContain('issueContractNumber');
    expect(prompt).toContain('[ЗАПОЛНИТЬ: номер договора]');
    expect(prompt).toContain('напомни сотруднику посмотреть номер в реестре договоров');
  });

  test('с templatesPrefix: разные заявки - разные номера, повтор - тот же', async () => {
    const prefixed = { ...deps, templatesPrefix: 'Договоры/' };
    putFile(prefixed, `Договоры/${MG_READY}`, 'tpl');
    const path = `Договоры/${MG_READY}`;
    const base = { templatePath: path, supplierId: 's1', issuedAt: '2026-10-21' };
    const run = (requestId: string) =>
      issueContractNumber.execute({ ...base, requestId }, prefixed, CTX);
    const first = await run('REQ-1');
    const second = await run('REQ-2');
    expect(second.number).not.toBe(first.number);
    expect((await run('REQ-1')).number).toBe(first.number);
    const key = issueContractNumber.idempotencyKey;
    expect(key?.({ ...base, requestId: 'REQ-1' })).not.toBe(key?.({ ...base, requestId: 'REQ-2' }));
    expect(key?.({ ...base, requestId: 'REQ-1' })).toBe(
      key?.({ ...base, templatePath: MG_READY, requestId: 'REQ-1' }),
    );
  });

  test('ключ: неизвестный шаблон - ошибка, нераспознанная дата - ключ без года', () => {
    const key = issueContractNumber.idempotencyKey;
    const input = { templatePath: MG_READY, supplierId: 's1', issuedAt: '2026-10-21' };
    expect(() => key?.({ ...input, templatePath: 'нет.docx' })).toThrow();
    expect(key?.({ ...input, issuedAt: 'вчера' })).toEndWith(':today');
  });

  test('issueContractNumber: неизвестный поставщик, плохая дата и год вне диапазона', async () => {
    const input = { templatePath: MG_READY, supplierId: 's1', issuedAt: '2026-10-21' };
    const run = (override: Partial<typeof input>) =>
      issueContractNumber.execute({ ...input, ...override }, deps, CTX);
    await expect(run({ supplierId: 'нет-такого' })).rejects.toThrow('Поставщик не найден');
    await expect(run({ issuedAt: '2030-01-01' })).rejects.toThrow('вне допустимого');
    await expect(run({ issuedAt: '2024-12-31' })).rejects.toThrow('вне допустимого');
    expect((await run({ issuedAt: '2027-01-01' })).number).toBe('МГ-2027-0001');
  });

  test('нераспознанная дата: номер по сегодняшней дате, повтор не тратит номер', async () => {
    const input = { templatePath: MG_READY, supplierId: 's1', issuedAt: 'вчера' };
    const first = await issueContractNumber.execute(input, deps, CTX);
    expect(first.number).toBe(`МГ-${deps.clock.now().getUTCFullYear()}-0001`);
    expect((await issueContractNumber.execute(input, deps, CTX)).number).toBe(first.number);
  });

  test('контракт кладёт ключ idempotencyKey по заявке, поставщику и шаблону', () => {
    const key = issueContractNumber.idempotencyKey;
    const input = {
      templatePath: MG_READY,
      supplierId: 's1',
      requestId: 'R',
      issuedAt: '2026-10-21',
    };
    expect(key?.(input)).toBe(key?.({ ...input, issuedAt: '2026-12-31' }));
    expect(key?.(input)).not.toBe(key?.({ ...input, requestId: 'R2' }));
  });
});

describe('ставка и сумма НДС по дате документа', () => {
  test.each([
    ['2025-12-31', 20, 20_000],
    ['2026-01-01', 22, 21_639.34],
  ])('%s: ставка %d%%, НДС %d', (issuedAt, rate, vat) => {
    const data = buildRenderData(contract({ issuedAt }));
    expect(data.fields['vat_rate']).toBe(rate);
    expect(data.fields['vat_amount']).toBe(vat);
  });

  test('слово модели и сотрудника ставку не перекрывает', async () => {
    const document = contract({ vatRate: 10, templateFields: { ...FIELDS, vat_rate: '10' } });
    expect(buildRenderData(document).fields['vat_rate']).toBe(22);
    expect((await check(document)).rejectedKeys).toEqual(['vat_rate']);
  });

  test('дата не распознана - вопрос про ставку', async () => {
    const out = await check(contract({ issuedAt: 'вчера' }));
    expect(out.missingLabels).toContain('vat_rate');
  });

  test('суммы позиций и итог считает код', () => {
    const data = buildRenderData(contract());
    expect(data.lists['items']?.[0]).toMatchObject({ unitPrice: 12_000, sum: 120_000 });
    expect(data.fields['total_rubles']).toBe(120_000);
    expect(data.fields['total_rubles_words']).toBe('сто двадцать тысяч');
    expect(data.fields['current_year']).toBe(2026);
  });
});

describe('варианты оплаты и доставки', () => {
  test('варианты не названы - вопросы, проценты и адрес пока не спрашиваются', async () => {
    const fields: Record<string, string> = { ...FIELDS };
    for (const key of ['payment_variant', 'delivery_variant', 'prepayment_percent']) {
      delete fields[key];
    }
    const out = await check(contract({ templateFields: fields }));
    expect(out.missingLabels).toEqual(
      expect.arrayContaining(['payment_variant', 'delivery_variant']),
    );
    expect(out.missingLabels).not.toContain('prepayment_percent');
    expect(out.missingLabels).not.toContain('delivery_address');
  });

  test('advance требует процент предоплаты', async () => {
    const fields: Record<string, string> = { ...FIELDS };
    delete fields['prepayment_percent'];
    const out = await check(contract({ templateFields: fields }));
    expect(out.missingLabels).toEqual(['prepayment_percent']);
  });

  test('prepay и postpay: проценты задаёт код, слово сотрудника не нужно', async () => {
    const fields: Record<string, string> = { ...FIELDS, payment_variant: 'prepay' };
    delete fields['prepayment_percent'];
    expect((await check(contract({ templateFields: fields }))).complete).toBe(true);
    const prepay = buildRenderData(contract({ templateFields: fields })).fields;
    expect(prepay).toMatchObject({ prepayment_percent: '100', final_payment_percent: '0' });
    const post = buildRenderData(
      contract({ templateFields: { ...fields, payment_variant: 'postpay' } }),
    ).fields;
    expect(post).toMatchObject({ prepayment_percent: '0', final_payment_percent: '100' });
  });

  test('delivery требует адрес, pickup - нет', async () => {
    const delivery = { ...FIELDS, delivery_variant: 'delivery' };
    expect((await check(contract({ templateFields: delivery }))).missingLabels).toEqual([
      'delivery_address',
    ]);
    const full = contract({ templateFields: { ...delivery, delivery_address: 'г. Пермь, ул. 1' } });
    expect((await check(full)).complete).toBe(true);
    expect(buildRenderData(full).fields['delivery_address']).toBe('г. Пермь, ул. 1');
    expect(buildRenderData(contract()).fields['delivery_address']).toBe('—');
  });

  test('недопустимое значение варианта - вопрос с перечнем', async () => {
    const out = await check(
      contract({ templateFields: { ...FIELDS, payment_variant: 'потом', delivery_variant: 'x' } }),
    );
    expect(out.complete).toBe(false);
    expect(out.questions.join(' ')).toContain('advance, prepay, postpay');
    expect(out.questions.join(' ')).toContain('pickup, delivery');
  });
});

describe('сроки, подписант и контакты исполнителя', () => {
  test('seller_position, контакты исполнителя спрашиваются', async () => {
    const fields: Record<string, string> = { ...FIELDS };
    for (const key of ['seller_position', 'seller_contactName', 'seller_phone', 'seller_email']) {
      delete fields[key];
    }
    const out = await check(contract({ templateFields: fields }));
    expect(out.missingLabels).toEqual([
      'seller_position',
      'seller_contactName',
      'seller_phone',
      'seller_email',
    ]);
    expect(out.questions.join(' ')).toContain('Исполнителя');
  });

  test('МГ: нужны срок изготовления и поставки; ПР готовая - только поставки', async () => {
    const fields: Record<string, string> = { ...FIELDS };
    delete fields['production_days'];
    delete fields['delivery_days'];
    expect((await check(contract({ templateFields: fields }))).missingLabels).toEqual([
      'delivery_days',
      'production_days',
    ]);
    const pr = await check(contract({ templateFields: fields }), PR_READY);
    expect(pr.missingLabels).toEqual(['delivery_days']);
  });

  test('срок поставки из КП или от сотрудника попадает в delivery_days', async () => {
    const fromQuote = buildRenderData(contract({ deliveryDays: 14 })).fields;
    expect(fromQuote).toMatchObject({ delivery_days: 14, deliveryDays: 14 });
    const withEmployee = contract({ templateFields: { ...FIELDS, delivery_days: '21' } });
    expect(buildRenderData(withEmployee).fields['delivery_days']).toBe('21');
    expect((await check(withEmployee, PR_READY)).complete).toBe(true);
  });
});

describe('КПП ИП', () => {
  test('ИП без КПП: пустой ключ, КПП не спрашивается', async () => {
    const document = contract({ requisites: { ...REQUISITES, inn: '500100732259', kpp: '' } });
    expect(buildRenderData(document).fields['seller_kpp']).toBe('');
    expect((await check(document)).missingLabels).not.toContain('seller_kpp');
  });

  test('юрлицо без КПП: КПП спрашивается', async () => {
    const out = await check(contract({ requisites: { ...REQUISITES, kpp: '' } }));
    expect(out.missingLabels).toContain('seller_kpp');
  });
});

describe('позиции', () => {
  test('поля строки: характеристики, количество, цена, сумма, срок', () => {
    expect(buildRenderData(contract()).lists['items']?.[0]).toEqual({
      name: 'Болт М8',
      characteristics: 'сталь',
      quantity: 10,
      unitPrice: 12_000,
      sum: 120_000,
      term: '10 дн.',
    });
  });

  test('без характеристик и срока - пустые строки и вопросы сотруднику', async () => {
    const document = contract({ lines: [{ name: 'Болт М8', quantity: 1, unitPrice: 5 }] });
    expect(buildRenderData(document).lists['items']?.[0]).toMatchObject({
      characteristics: '',
      term: '',
    });
    const out = await check(document);
    expect(out.missingLabels).toEqual(['items.characteristics', 'items.term']);
    expect(out.questions.join(' ')).toContain('Болт М8');
  });

  test('позиций нет - вопрос сотруднику', async () => {
    const out = await check(contract({ lines: [] }));
    expect(out.missingLabels).toContain('items');
  });
});

describe('NDA: штраф и пропись', () => {
  const nda = (amount: string): DealDocument =>
    contract({
      templateFields: {
        seller_representative: 'директора Иванова И. И.',
        seller_position: 'директор',
        seller_authority_basis: 'Устава',
        contract_number: '15/26',
        contract_date: '2026-10-01',
        nda_penalty_amount: amount,
      },
    });

  test('сумма от сотрудника, число тысяч прописью и полная пропись считает код', async () => {
    expect((await check(nda('50000'), NDA)).complete).toBe(true);
    const fields = buildRenderData(nda('50 000')).fields;
    expect(fields).toMatchObject({
      nda_penalty_amount: 50_000,
      nda_penalty_thousands_words: 'пятьдесят',
      nda_penalty_words: 'пятьдесят тысяч рублей',
    });
    expect(buildRenderData(nda('2000')).fields['nda_penalty_thousands_words']).toBe('две');
  });

  test('сумма штрафа не обязана быть кратной тысяче: пропись целиком от кода', async () => {
    const out = await check(nda('1500'), NDA);
    expect(out.complete).toBe(true);
    expect(buildRenderData(nda('1500')).fields['nda_penalty_words']).toBe(
      'одна тысяча пятьсот рублей',
    );
  });

  test('прописью сотрудник не вводит: ключ отклоняется', async () => {
    const document = nda('50000');
    const withWords = {
      ...document,
      templateFields: { ...document.templateFields, nda_penalty_words: 'сто' },
    };
    expect((await check(withWords, NDA)).rejectedKeys).toEqual(['nda_penalty_words']);
    expect(buildRenderData(withWords).fields['nda_penalty_words']).toBe('пятьдесят тысяч рублей');
  });

  test('NDA номера системы не получает: номер основного договора от сотрудника', async () => {
    const request = await renderedRequest(nda('50000'), NDA);
    expect(request?.data.fields['contract_number']).toBe('15/26');
  });
});
