import { beforeEach, describe, expect, test } from 'bun:test';
import { MemoryDealManagerReader } from '../../src/kit/adapters/memory/deal-manager-reader';
import { CONTRACT_TEMPLATES } from '../../src/agents/documents/template-registry';
import { checkTemplateFieldsTool } from '../../src/agents/documents/check-template-fields';
import { fillTemplate } from '../../src/agents/documents/fill-template';
import { handoffForReview } from '../../src/agents/documents/handoff-for-review';
import { supplierNumberKeyPrefix } from '../../src/agents/documents/party-data';
import { supplierRequisitesRecord } from '../../src/kit/domain/requisites';
import { type DealDocument } from '../../src/kit/domain/models';
import { type SupplierCard } from '../../src/kit/domain/supplier-card';
import type { RenderRequest } from '@business-ai/core';
import { FULL_SUPPLIER } from '../kit/support/supplier-fixtures';
import {
  OWN_COMPANY,
  CTX,
  buildDocument,
  buildDocumentsDeps,
  putFile,
  withSources,
} from './support';

let deps: Awaited<ReturnType<typeof buildDocumentsDeps>>;
let managers: MemoryDealManagerReader;

const MG_READY = '2026_МГ_Шаблон_Договора_на_поставку_готовой_продукции.docx';
const NDA = 'МГ Соглашение NDA.docx';
const REQUESTER = '77';
const AUTHOR = { name: 'Автор Андрей', phone: '+7 900 777-77-77', email: 'a@corp.ru' };
const SELLER_PHONE = '+79123456789';
const SELLER_EMAIL = 'sales@romashka.ru';
const SELLER_NAME = 'Сидорова Светлана';
const PERSONAL = [AUTHOR.name, AUTHOR.phone, AUTHOR.email, SELLER_PHONE, SELLER_EMAIL, SELLER_NAME];

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
/** Всё, кроме контактов сторон, спецификации и гарантии. */
const BASE_FIELDS: Record<string, string> = {
  seller_representative: 'директора Иванова И. И.',
  seller_position: 'директор',
  seller_authority_basis: 'Устава',
  payment_variant: 'postpay',
  delivery_variant: 'pickup',
  production_days: '20',
  delivery_days: '5',
  warranty_months: '12',
};

function contract(templateFields: Record<string, string> = BASE_FIELDS): DealDocument {
  return buildDocument({
    kind: 'contract',
    number: 'МОДЕЛЬ-1',
    issuedAt: '2026-10-21',
    seller: 'ООО «Ромашка»',
    supplierId: 's1',
    total: 1,
    lines: [
      { name: 'Болт М8', quantity: 10, unitPrice: 12_000, characteristics: 'сталь', term: '10 дн.' },
    ],
    requisites: REQUISITES,
    templateFields,
  });
}

function nda(templateFields: Record<string, string> = {}): DealDocument {
  return buildDocument({
    kind: 'contract',
    number: 'NDA-1',
    issuedAt: '2026-11-02',
    seller: 'ООО «Ромашка»',
    supplierId: 's1',
    total: 0,
    lines: [],
    requisites: REQUISITES,
    templateFields: {
      seller_representative: 'директора Иванова И. И.',
      seller_position: 'директор',
      seller_authority_basis: 'Устава',
      nda_penalty_amount: '100000',
      ...templateFields,
    },
  });
}

async function setCard(contacts: SupplierCard['contacts']): Promise<void> {
  const card = await deps.suppliers.getCard('s1');
  if (card === null) throw new Error('нет карточки');
  await deps.suppliers.saveCard({ ...card, contacts });
}

beforeEach(async () => {
  deps = await buildDocumentsDeps();
  for (const template of CONTRACT_TEMPLATES) putFile(deps, template.fileName, 'tpl');
  managers = new MemoryDealManagerReader();
  managers.setUser(REQUESTER, AUTHOR);
  Object.assign(deps, { dealManagers: managers });
});

const ctxOf = (userId?: string) => ({
  ...CTX,
  initiator: userId === undefined ? ({ kind: 'scheduler' } as const) : { kind: 'user' as const, userId },
});

const check = (document: DealDocument, path = MG_READY, userId?: string) =>
  checkTemplateFieldsTool.execute({ templatePath: path, document }, deps, ctxOf(userId));

async function rendered(document: DealDocument, path = MG_READY, userId?: string) {
  const seen: RenderRequest[] = [];
  const spy = {
    render: async (request: RenderRequest) => {
      seen.push(request);
      return deps.renderer.render(request);
    },
  };
  await fillTemplate.execute({ templatePath: path, document }, { ...deps, renderer: spy }, ctxOf(userId));
  return seen[0]?.data.fields ?? {};
}

describe('«От Исполнителя» из карточки поставщика', () => {
  test('карточка с контактами: вопросов нет, значения в сборке', async () => {
    await setCard([
      { fullName: SELLER_NAME, phone: SELLER_PHONE, email: SELLER_EMAIL, isPrimary: true },
    ]);
    const out = await check(contract(), MG_READY, REQUESTER);
    expect(out.missingLabels.filter((l) => l.startsWith('seller_'))).toEqual([]);
    const fields = await rendered(contract(), MG_READY, REQUESTER);
    expect(fields['seller_contactName']).toBe(SELLER_NAME);
    expect(fields['seller_phone']).toBe(SELLER_PHONE);
    expect(fields['seller_email']).toBe(SELLER_EMAIL);
  });

  test('частичные контакты: спрашиваем только недостающее', async () => {
    await setCard([{ fullName: SELLER_NAME, isPrimary: true }]);
    const out = await check(contract(), MG_READY, REQUESTER);
    expect(out.missingLabels.filter((l) => l.startsWith('seller_')).sort()).toEqual([
      'seller_email',
      'seller_phone',
    ]);
  });

  test('слово сотрудника главнее карточки', async () => {
    await setCard([
      { fullName: SELLER_NAME, phone: SELLER_PHONE, email: SELLER_EMAIL, isPrimary: true },
    ]);
    const fields = await rendered(
      contract({ ...BASE_FIELDS, seller_phone: '+7 000 000-00-00' }),
      MG_READY,
      REQUESTER,
    );
    expect(fields['seller_phone']).toBe('+7 000 000-00-00');
    expect(fields['seller_email']).toBe(SELLER_EMAIL);
  });

  test('в карточке контактов нет: вопросы остаются', async () => {
    await setCard([]);
    const out = await check(contract(), MG_READY, REQUESTER);
    expect(out.missingLabels).toEqual(
      expect.arrayContaining(['seller_contactName', 'seller_phone', 'seller_email']),
    );
  });
});

describe('«От Заказчика»: автор запроса как запасной путь', () => {
  test('договор без заявки: контакт автора запроса', async () => {
    const out = await check(issued(), MG_READY, REQUESTER);
    expect(out.missingLabels.filter((l) => l.startsWith('buyer_'))).toEqual([]);
    const fields = await rendered(issued(), MG_READY, REQUESTER);
    expect(fields['buyer_contact_name']).toBe(AUTHOR.name);
    expect(fields['buyer_contact_phone']).toBe(AUTHOR.phone);
    expect(fields['buyer_contact_email']).toBe(AUTHOR.email);
  });

  test('менеджер сделки главнее автора запроса', async () => {
    const other = { name: 'Менеджер Михаил', phone: '+7 1', email: 'm@corp.ru' };
    managers.set('REQ-1', other);
    const doc = { ...issued(), requestId: 'REQ-1' };
    const fields = await rendered(doc, MG_READY, REQUESTER);
    expect(fields['buyer_contact_name']).toBe(other.name);
  });

  test('плановый ход без сотрудника: запасного пути нет, контакт спрашивают', async () => {
    const out = await check(issued(), MG_READY);
    expect(out.missingLabels).toEqual(expect.arrayContaining(['buyer_contact_name']));
    expect(managers.userCalls).toBe(0);
  });

  test('сбой портала при чтении автора: не обрыв, а прежний вопрос', async () => {
    managers.failing = true;
    const out = await check(issued(), MG_READY, REQUESTER);
    expect(out.missingLabels).toContain('buyer_contact_name');
  });

  test('ПДн автора и поставщика не попадают в результат инструментов и чат', async () => {
    await setCard([
      { fullName: SELLER_NAME, phone: SELLER_PHONE, email: SELLER_EMAIL, isPrimary: true },
    ]);
    const checked = JSON.stringify(await check(issued(), MG_READY, REQUESTER));
    for (const value of PERSONAL) {
      expect(checked).not.toContain(value);
      expect(JSON.stringify(deps.chat)).not.toContain(value);
    }
  });
});

/** Договор с контактами исполнителя (полные поля для сборки). */
function issued(overrides: Partial<DealDocument> = {}): DealDocument {
  const base = contract({
    ...BASE_FIELDS,
    seller_contactName: 'Х',
    seller_phone: '1',
    seller_email: 'x@x.ru',
  });
  return { ...base, ...overrides };
}

/**
 * Номер, выданный счётчиком раньше (этап 139): агент с этапа 152 сам номера не выдаёт, но
 * историю счётчика NDA по-прежнему читает. Возвращает номер и читаемую дату договора.
 */
async function seedIssued(
  requestId = 'REQ-1',
  documentDate = '2026-10-21',
): Promise<{ number: string }> {
  const issuedNumber = await deps.contractNumbering?.issue({
    operationKey: `${supplierNumberKeyPrefix('s1')}request:${requestId}`,
    legalEntity: 'mg',
    year: 2026,
    documentDate,
  });
  return { number: issuedNumber?.number ?? '' };
}

describe('NDA: основной договор из выданных номеров', () => {
  test('номер уже выдавали: вопроса нет, подставлены номер и дата', async () => {
    const first = await seedIssued();
    const out = await check(nda(), NDA, REQUESTER);
    expect(out.missingLabels).not.toContain('contract_number');
    expect(out.missingLabels).not.toContain('contract_date');
    const fields = await rendered(nda(), NDA, REQUESTER);
    expect(fields['contract_number']).toBe(first.number);
    expect(fields['contract_date']).toBe('«21» октября 2026 года');
  });

  test('несколько договоров: берётся последний', async () => {
    await seedIssued();
    const second = await seedIssued('REQ-9', '2026-10-25');
    const fields = await rendered(nda(), NDA, REQUESTER);
    expect(fields['contract_number']).toBe(second.number);
    expect(fields['contract_date']).toBe('«25» октября 2026 года');
  });

  test('номеров нет: прежний вопрос', async () => {
    const out = await check(nda(), NDA, REQUESTER);
    expect(out.missingLabels).toEqual(expect.arrayContaining(['contract_number', 'contract_date']));
  });

  test('сотрудник назвал номер сам: система его не подменяет', async () => {
    await seedIssued();
    const out = await check(nda({ contract_number: 'Д-5' }), NDA, REQUESTER);
    expect(out.missingLabels).toEqual(['contract_date']);
  });

  test('договоры другого поставщика не подходят', async () => {
    await deps.suppliers.upsert({ id: 's2', name: 'Другой' });
    await deps.contractNumbering?.issue({
      operationKey: `${supplierNumberKeyPrefix('s2')}request:REQ-1`,
      legalEntity: 'mg',
      year: 2026,
      documentDate: '2026-10-21',
    });
    const out = await check(nda(), NDA, REQUESTER);
    expect(out.missingLabels).toContain('contract_number');
  });
});

describe('чек-лист передачи на проверку', () => {
  test('NDA: основной договор помечен как подставленный системой, без ПДн', async () => {
    await deps.suppliers.upsert(FULL_SUPPLIER);
    const requisites = supplierRequisitesRecord(FULL_SUPPLIER);
    const base = { supplierId: FULL_SUPPLIER.id, seller: FULL_SUPPLIER.name, requisites };
    const first = await seedIssued();
    const document = withSources({ ...nda(), ...base, buyer: OWN_COMPANY }, 'knowledge');
    const out = await handoffForReview.execute({ templatePath: NDA, document }, deps, CTX);
    const item = out.checklist.find((entry) => entry.label === 'Основной договор для NDA');
    expect(item?.value).toContain(first.number);
    expect(item?.value).toContain('21.10.2026');
    expect(item?.source).toContain('система');
    expect(JSON.stringify(out)).not.toContain(AUTHOR.phone);
  });
});
