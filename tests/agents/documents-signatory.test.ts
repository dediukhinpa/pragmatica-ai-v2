import { beforeEach, describe, expect, test } from 'bun:test';
// Подписант в родительном падеже составляется кодом по ФИО руководителя и должности.
import { CONTRACT_TEMPLATES } from '../../src/agents/documents/template-registry';
import { checkTemplateFieldsTool } from '../../src/agents/documents/check-template-fields';
import { fillTemplate } from '../../src/agents/documents/fill-template';
import type { DealDocument } from '../../src/kit/domain/models';
import type { RenderRequest } from '@business-ai/core';
import type { SignatoryInflector } from '../../src/kit/ports/signatory-inflector';
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
  directorName: 'Дудорова Марина Евгеньевна',
};
const FIELDS = {
  seller_position: 'Генеральный директор',
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

const GENITIVE = 'генерального директора Дудоровой Марины Евгеньевны';

/** Сервис склонения: запоминает вызовы и отвечает заданным текстом (или падает). */
function inflector(answer: string | null | Error): SignatoryInflector & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    signatoryGenitive: async (position: string, fullName: string) => {
      calls.push([position, fullName]);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
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

describe('подписант поставщика в родительном падеже', () => {
  test('составлен кодом: вопроса нет, в файле склонённое ФИО', async () => {
    const service = inflector(GENITIVE);
    deps.signatoryInflector = service;
    const result = await check(contract());
    expect(result.missingLabels).not.toContain('seller_representative');
    const request = await renderedRequest(contract(), MG_READY);
    expect(request?.data.fields['seller_representative']).toBe(GENITIVE);
    expect(service.calls[0]).toEqual(['Генеральный директор', 'Дудорова Марина Евгеньевна']);
  });

  test('NDA тоже получает подписанта', async () => {
    deps.signatoryInflector = inflector(GENITIVE);
    const result = await check(contract(), NDA);
    expect(result.missingLabels).not.toContain('seller_representative');
  });

  test('значение сотрудника не перекрывается и сервис не зовётся', async () => {
    const service = inflector(GENITIVE);
    deps.signatoryInflector = service;
    const own = { ...FIELDS, seller_representative: 'директора Дудоровой М. Е.' };
    const request = await renderedRequest(contract({ templateFields: own }), MG_READY);
    expect(request?.data.fields['seller_representative']).toBe('директора Дудоровой М. Е.');
    expect(service.calls).toHaveLength(0);
  });

  test('не разобрал, упал или сервиса нет - вопрос сотруднику, как раньше', async () => {
    for (const service of [inflector(null), inflector(new Error('down')), undefined]) {
      deps.signatoryInflector = service;
      const result = await check(contract());
      expect(result.missingLabels).toContain('seller_representative');
    }
  });

  test('без должности сервис не зовётся', async () => {
    const service = inflector(GENITIVE);
    deps.signatoryInflector = service;
    const { seller_position: _omit, ...rest } = FIELDS;
    const result = await check(contract({ templateFields: rest }));
    expect(result.missingLabels).toContain('seller_representative');
    expect(service.calls).toHaveLength(0);
  });
});
