import { beforeEach, describe, expect, test } from 'bun:test';
// Срок датой («до 05.11.2026») код переводит в рабочие дни по производственному календарю.
import { CONTRACT_TEMPLATES } from '../../src/agents/documents/template-registry';
import { checkTemplateFieldsTool } from '../../src/agents/documents/check-template-fields';
import { fillTemplate } from '../../src/agents/documents/fill-template';
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
    issuedAt: '2026-10-28',
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

const withTerms = (terms: Record<string, string>): DealDocument =>
  contract({ templateFields: { ...FIELDS, delivery_days: '5', ...terms } });

describe('срок датой - в рабочие дни', () => {
  test('срок поставки «до 05.11.2026» от 28.10.2026 = 5 (4 ноября праздник)', async () => {
    const document = withTerms({ delivery_days: 'до 05.11.2026' });
    const result = await check(document, PR_READY);
    expect(result.complete).toBe(true);
    expect(result.workingDayTerms).toEqual([
      { label: 'delivery_days', asNamed: 'до 05.11.2026', workingDays: 5 },
    ]);
    const request = await renderedRequest(document, PR_READY);
    expect(request?.data.fields['delivery_days']).toBe('5');
  });

  test('МГ: срок не от даты договора - дата не переводится, вопрос с объяснением', async () => {
    const document = withTerms({ delivery_days: 'до 05.11.2026', production_days: '10' });
    const result = await check(document, MG_READY);
    expect(result.complete).toBe(false);
    expect(result.workingDayTerms).toEqual([]);
    expect(result.questions.join(' ')).toContain('не от даты договора');
  });

  test('МГ: срок поставки спрашивается до сборки, а не падает в шаблоне', async () => {
    const { delivery_days: _omit, ...rest } = { ...FIELDS, delivery_days: '' };
    const result = await check(contract({ templateFields: rest }), MG_READY);
    expect(result.missingLabels).toContain('delivery_days');
  });

  test('число остаётся числом, в workingDayTerms его нет', async () => {
    const result = await check(withTerms({ delivery_days: '8' }), PR_READY);
    expect(result.complete).toBe(true);
    expect(result.workingDayTerms).toEqual([]);
  });

  test('дата раньше договора или вне календаря - вопрос сотруднику', async () => {
    for (const value of ['до 20.10.2026', 'до 15.01.2028']) {
      const result = await check(withTerms({ delivery_days: value }), PR_READY);
      expect(result.complete).toBe(false);
      expect(result.missingLabels).toContain('delivery_days');
      expect(result.questions.join(' ')).toContain('не переводится в рабочие дни');
    }
  });
});
