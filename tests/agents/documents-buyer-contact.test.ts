import { beforeEach, describe, expect, test } from 'bun:test';
import { MemoryDealManagerReader } from '../../src/kit/adapters/memory/deal-manager-reader';
import { MemoryPurchaseRequestRepository } from '../../src/kit/adapters/memory/repositories.owned';
import { CONTRACT_TEMPLATES } from '../../src/agents/documents/template-registry';
import { checkTemplateFieldsTool } from '../../src/agents/documents/check-template-fields';
import { fillTemplate } from '../../src/agents/documents/fill-template';
import type { DealDocument } from '../../src/kit/domain/models';
import type { RenderRequest } from '@business-ai/core';
import { CTX, buildDocument, buildDocumentsDeps, putFile } from './support';

let deps: Awaited<ReturnType<typeof buildDocumentsDeps>>;
let managers: MemoryDealManagerReader;

const MG_READY = '2026_МГ_Шаблон_Договора_на_поставку_готовой_продукции.docx';
const DEAL = '4242';
const MANAGER = {
  name: 'Кузнецов Кирилл Петрович',
  phone: '+7 495 111-22-33',
  email: 'k@corp.ru',
};
const PERSONAL = [MANAGER.name, MANAGER.phone, MANAGER.email];

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
/** Все метки МГ, кроме контакта «От Заказчика»: его даёт менеджер сделки. */
const FIELDS: Record<string, string> = {
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
  seller_contactName: 'Сидоров С. С.',
  seller_phone: '+7 900 111-11-11',
  seller_email: 's@example.com',
};

function contract(templateFields: Record<string, string> = FIELDS): DealDocument {
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
    templateFields,
  });
}

beforeEach(async () => {
  deps = await buildDocumentsDeps();
  for (const template of CONTRACT_TEMPLATES) putFile(deps, template.fileName, 'tpl');
  managers = new MemoryDealManagerReader();
  const requests = new MemoryPurchaseRequestRepository();
  await requests.save({
    id: 'REQ-1',
    dealRef: DEAL,
    items: [],
    createdAt: '2026-10-01T00:00:00.000Z',
  });
  Object.assign(deps, { dealManagers: managers, requests });
});

const check = (document: DealDocument) =>
  checkTemplateFieldsTool.execute({ templatePath: MG_READY, document }, deps, CTX);

async function rendered(document: DealDocument): Promise<{
  request: RenderRequest | undefined;
  result: unknown;
}> {
  const seen: RenderRequest[] = [];
  const spy = {
    render: async (request: RenderRequest) => {
      seen.push(request);
      return deps.renderer.render(request);
    },
  };
  const result = await fillTemplate.execute(
    { templatePath: MG_READY, document },
    { ...deps, renderer: spy },
    CTX,
  );
  return { request: seen[0], result };
}

describe('контакт менеджера сделки в договоре', () => {
  test('сборка берёт контакт из менеджера, вопросов нет', async () => {
    managers.set(DEAL, MANAGER);
    expect((await check(contract())).complete).toBe(true);
    const { request } = await rendered(contract());
    expect(request?.data.fields['buyer_contact_name']).toBe(MANAGER.name);
    expect(request?.data.fields['buyer_contact_phone']).toBe(MANAGER.phone);
    expect(request?.data.fields['buyer_contact_email']).toBe(MANAGER.email);
  });

  test('код главнее модели, ответ сотрудника заполняет только недостающее', async () => {
    managers.set(DEAL, { name: MANAGER.name, phone: null, email: null });
    const fields = {
      ...FIELDS,
      buyer_contact_name: 'Выдумано Моделью',
      buyer_contact_phone: '+7 900 000-00-00',
      buyer_contact_email: 'e@example.com',
    };
    const { request } = await rendered(contract(fields));
    expect(request?.data.fields['buyer_contact_name']).toBe(MANAGER.name);
    expect(request?.data.fields['buyer_contact_phone']).toBe('+7 900 000-00-00');
    expect(request?.data.fields['buyer_contact_email']).toBe('e@example.com');
  });

  test('менеджера нет - вопрос по каждому недостающему полю', async () => {
    const out = await check(contract());
    expect(out.complete).toBe(false);
    expect(out.missingLabels).toEqual(
      expect.arrayContaining(['buyer_contact_name', 'buyer_contact_phone', 'buyer_contact_email']),
    );
  });

  test('у менеджера нет телефона - спрашивают только телефон', async () => {
    managers.set(DEAL, { name: MANAGER.name, phone: null, email: MANAGER.email });
    const out = await check(contract());
    expect(out.missingLabels).toEqual(['buyer_contact_phone']);
  });

  test('dealManagers не настроен - прежнее поведение: спрашивать сотрудника', async () => {
    Object.assign(deps, { dealManagers: undefined });
    const out = await check(contract());
    expect(out.missingLabels).toContain('buyer_contact_name');
    expect(managers.calls).toBe(0);
  });

  test('документ без заявки - менеджера не читают', async () => {
    managers.set(DEAL, MANAGER);
    const out = await check({ ...contract(), requestId: undefined });
    expect(out.missingLabels).toContain('buyer_contact_name');
    expect(managers.calls).toBe(0);
  });

  test('заявки нет в хранилище - id модели не трактуется как сделка', async () => {
    managers.set('REQ-X', MANAGER);
    const out = await check({ ...contract(), requestId: 'REQ-X' });
    expect(out.missingLabels).toContain('buyer_contact_name');
    expect(managers.calls).toBe(0);
  });

  test('без хранилища заявок ссылкой на сделку служит id заявки', async () => {
    Object.assign(deps, { requests: undefined });
    managers.set('REQ-1', MANAGER);
    expect((await check(contract())).complete).toBe(true);
  });

  test('ПДн менеджера не попадают в результат инструментов и в чат', async () => {
    managers.set(DEAL, MANAGER);
    const checked = JSON.stringify(await check(contract()));
    const { result } = await rendered(contract());
    for (const value of PERSONAL) {
      expect(checked).not.toContain(value);
      expect(JSON.stringify(result)).not.toContain(value);
      expect(JSON.stringify(deps.chat)).not.toContain(value);
    }
  });

  test('ПДн не просачиваются в ошибку неполного договора', async () => {
    managers.set(DEAL, { name: MANAGER.name, phone: null, email: null });
    const fields = { ...FIELDS };
    delete fields['seller_position'];
    const error = await fillTemplate
      .execute({ templatePath: MG_READY, document: contract(fields) }, deps, CTX)
      .catch((e: unknown) => String(e));
    expect(String(error)).not.toContain(MANAGER.name);
  });
});
