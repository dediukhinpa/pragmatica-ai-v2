import { beforeEach, describe, expect, test } from 'bun:test';
import { CONTRACT_TEMPLATES } from '../../src/agents/documents/template-registry';
import { checkTemplateFieldsTool } from '../../src/agents/documents/check-template-fields';
import { fillTemplate } from '../../src/agents/documents/fill-template';
import { monthsPhrase, parseWarrantyMonths } from '../../src/agents/documents/contract-defaults';
import type { DealDocument } from '../../src/kit/domain/models';
import type { RenderRequest } from '@business-ai/core';
import { CTX, buildDocument, buildDocumentsDeps, putFile } from './support';

let deps: Awaited<ReturnType<typeof buildDocumentsDeps>>;

const MG_READY = '2026_МГ_Шаблон_Договора_на_поставку_готовой_продукции.docx';
const MG_CONTRACT = '2026_МГ_Шаблон_Договора_на_поставку_контрактной_продукции.docx';

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
/** Метки без спецификации, ТЗ и гарантии: их код подставляет сам. */
const BASE_FIELDS: Record<string, string> = {
  seller_representative: 'директора Иванова И. И.',
  seller_position: 'директор',
  seller_authority_basis: 'Устава',
  payment_variant: 'postpay',
  delivery_variant: 'pickup',
  production_days: '20',
  delivery_days: '5',
  buyer_contact_name: 'Петров П. П.',
  buyer_contact_phone: '+7 900 000-00-00',
  buyer_contact_email: 'p@example.com',
  seller_contactName: 'Сидоров С. С.',
  seller_phone: '+7 900 111-11-11',
  seller_email: 's@example.com',
};

function contract(templateFields: Record<string, string>): DealDocument {
  return buildDocument({
    kind: 'contract',
    number: 'МОДЕЛЬ-1',
    issuedAt: '2026-10-21',
    seller: 'ООО «Ромашка»',
    supplierId: 's1',
    requestId: 'REQ-1',
    total: 1,
    lines: [
      { name: 'Болт М8', quantity: 10, unitPrice: 12_000, characteristics: 'сталь', term: '10 дн.' },
    ],
    requisites: REQUISITES,
    templateFields,
  });
}

beforeEach(async () => {
  deps = await buildDocumentsDeps();
  for (const template of CONTRACT_TEMPLATES) putFile(deps, template.fileName, 'tpl');
});

const check = (document: DealDocument, templatePath = MG_READY) =>
  checkTemplateFieldsTool.execute({ templatePath, document }, deps, CTX);

async function renderedFields(document: DealDocument, templatePath = MG_READY) {
  const seen: RenderRequest[] = [];
  const spy = {
    render: async (request: RenderRequest) => {
      seen.push(request);
      return deps.renderer.render(request);
    },
  };
  await fillTemplate.execute({ templatePath, document }, { ...deps, renderer: spy }, CTX);
  return seen[0]?.data.fields ?? {};
}

describe('спецификация и ТЗ: значения по умолчанию', () => {
  test('без значений: № 1, дата договора, ТЗ № 1, вопросов про них нет', async () => {
    const doc = contract({ ...BASE_FIELDS, warranty_months: '12' });
    const out = await check(doc);
    for (const label of ['spec_number', 'spec_date', 'tz_number']) {
      expect(out.missingLabels).not.toContain(label);
    }
    const fields = await renderedFields(doc);
    expect(fields['spec_number']).toBe('1');
    expect(fields['tz_number']).toBe('1');
    expect(fields['spec_date']).toBe(fields['issuedAt']);
    expect(fields['spec_date']).toBe('«21» октября 2026 года');
  });

  test('значения сотрудника сохраняются', async () => {
    const doc = contract({
      ...BASE_FIELDS,
      warranty_months: '12',
      spec_number: '3',
      spec_date: '2026-10-25',
      tz_number: '2',
    });
    const fields = await renderedFields(doc);
    expect(fields['spec_number']).toBe('3');
    expect(fields['tz_number']).toBe('2');
    expect(fields['spec_date']).toBe('«25» октября 2026 года');
  });

  test('договор с нераспознанной датой: дату спецификации не выдумываем', async () => {
    const doc = { ...contract({ ...BASE_FIELDS, warranty_months: '12' }), issuedAt: 'вчера' };
    const out = await check(doc);
    expect(out.missingLabels).toContain('spec_date');
    expect(out.missingLabels).not.toContain('spec_number');
  });
});

describe('гарантия одним вопросом (МГ на готовую продукцию)', () => {
  test('нет обоих: один вопрос про месяцы', async () => {
    const out = await check(contract(BASE_FIELDS));
    expect(out.missingLabels.filter((l) => l.startsWith('warranty'))).toEqual([
      'warranty_months',
    ]);
  });

  test('только месяцы: срок спецификации выводится с верным склонением', async () => {
    const cases: Array<[string, string]> = [
      ['1', '1 месяц'],
      ['3', '3 месяца'],
      ['12', '12 месяцев'],
      ['24', '24 месяца'],
    ];
    for (const [months, phrase] of cases) {
      const doc = contract({ ...BASE_FIELDS, warranty_months: months });
      expect((await check(doc)).missingLabels).toEqual([]);
      const fields = await renderedFields(doc);
      expect(fields['warranty_period']).toBe(phrase);
      expect(fields['warranty_months']).toBe(months);
    }
  });

  test('только срок словами: месяцы выводятся', async () => {
    for (const [period, months] of [
      ['12 месяцев', '12'],
      ['12 мес.', '12'],
      ['1 год', '12'],
      ['2 года', '24'],
    ] as const) {
      const doc = contract({ ...BASE_FIELDS, warranty_period: period });
      expect((await check(doc)).missingLabels).toEqual([]);
      const fields = await renderedFields(doc);
      expect(fields['warranty_months']).toBe(months);
      expect(fields['warranty_period']).toBe(period);
    }
  });

  test('срок не разбирается: прежний вопрос только про месяцы', async () => {
    const doc = contract({ ...BASE_FIELDS, warranty_period: 'по согласованию' });
    expect((await check(doc)).missingLabels).toEqual(['warranty_months']);
  });

  test('оба названы сотрудником - не трогаем', async () => {
    const doc = contract({
      ...BASE_FIELDS,
      warranty_months: '12',
      warranty_period: 'один год',
    });
    const fields = await renderedFields(doc);
    expect(fields['warranty_period']).toBe('один год');
  });

  test('другие договоры: один вопрос про warranty_period, месяцы не нужны', async () => {
    const out = await check(contract(BASE_FIELDS), MG_CONTRACT);
    expect(out.missingLabels.filter((l) => l.startsWith('warranty'))).toEqual([
      'warranty_period',
    ]);
    const filled = await check(
      contract({ ...BASE_FIELDS, warranty_period: '12 месяцев' }),
      MG_CONTRACT,
    );
    expect(filled.missingLabels).toEqual([]);
  });
});

describe('склонение и разбор гарантии', () => {
  test('monthsPhrase', () => {
    expect(
      [1, 2, 4, 5, 11, 12, 14, 21, 22, 25].map(monthsPhrase),
    ).toEqual([
      '1 месяц', '2 месяца', '4 месяца', '5 месяцев', '11 месяцев', '12 месяцев',
      '14 месяцев', '21 месяц', '22 месяца', '25 месяцев',
    ]);
  });
  test('parseWarrantyMonths', () => {
    expect(parseWarrantyMonths('12')).toBe(12);
    expect(parseWarrantyMonths('18 мес.')).toBe(18);
    expect(parseWarrantyMonths('1 год')).toBe(12);
    expect(parseWarrantyMonths('5 лет')).toBe(60);
    expect(parseWarrantyMonths('0')).toBeUndefined();
    expect(parseWarrantyMonths('полгода')).toBeUndefined();
  });
});
