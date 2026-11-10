import { beforeEach, describe, expect, test } from 'bun:test';
import { MemoryAccessPolicy } from '@business-ai/adapters';
import { WORKFLOW_STATE_STALE_SCOPE } from '../../src/kit/app/workflow-state-retention';
import {
  ATTACHMENT_TEXT_NAMESPACE,
  noteAttachmentText,
} from '../../src/agents/suppliers/document-source-text';
import { OwnCompanyFilter } from '../../src/agents/suppliers/own-company-filter';
import {
  PREPARED_CONTRACT_NAMESPACE,
  notePreparedContract,
  preparedContractSuppliers,
} from '../../src/agents/documents/prepared-contract';
import {
  cardFromFields,
  newCardId,
  type SupplierCardFields,
} from '../../src/agents/suppliers/card-fields';
import { createDocumentsAgent } from '../../src/agents/documents/declaration';
import { createToolContext } from '@business-ai/core';
import { enrichSupplierCardFromContract } from '../../src/agents/documents/contract-card-enrich';
import { noteEmployeeMessage } from '../../src/agents/documents/employee-messages';
import { noteWebSearchText } from '../../src/agents/documents/web-confirmation';
import { prepareSupplierDocument } from '../../src/agents/documents/prepare-supplier-document';
import { readChatAttachmentsRecorded } from '../../src/agents/order-calc/read-chat-attachments';
import { type DocumentsDeps } from '../../src/agents/documents/deps';
import { ACTION_CONFIRM_SUPPLIER_CARD } from '../../src/kit/domain/access.owned';
import { type SupplierCard } from '../../src/kit/domain/supplier-card';
import { OWN_COMPANY, SUPPLIER_ID, buildDocumentsDeps } from './support';
import {
  INN_ALPHA,
  INN_BETA,
  USER_A,
  buildSupplierWorld,
  type SupplierWorld,
} from './suppliers-support';

/**
 * Агент «Подготовка документов»: дополнение карточки поставщика данными договора (этап 219).
 * Данные синтетические; ИНН нашей компании - INN_BETA, поставщика - INN_ALPHA.
 */

const BOT = 'documents';
const THREAD = `${BOT}/${USER_A}`;
/** Начало абзаца промпта о дополнении карточки (в основном тексте есть лишь ссылка на него). */
const BLOCK_MARK = 'Это единственный случай, когда ты меняешь карточку';
const OWN_PHONE = '+7 (900) 111-22-33';
const OWN_REQUISITES = [
  `ИНН ${INN_BETA}`,
  'КПП 500101001',
  'г. Свой, ул. Наша, 5',
  'office@own.example',
  `тел. ${OWN_PHONE}`,
];
const SUPPLIER_KPP = '770701001';
const SUPPLIER_ADDRESS = 'г. Альфа, ул. Первая, 1';

let world: SupplierWorld;
let host: DocumentsDeps;

beforeEach(async () => {
  world = buildSupplierWorld();
  const access = new MemoryAccessPolicy();
  access.allow({ userId: USER_A, botId: BOT, action: ACTION_CONFIRM_SUPPLIER_CARD });
  world.deps.access = access;
  host = {
    ...(await buildDocumentsDeps()),
    supplierCards: world.deps,
    ownCompanyRequisites: OWN_REQUISITES,
  };
});

const ctx = () =>
  createToolContext({
    threadId: THREAD,
    agentId: BOT,
    operationId: 'op-enrich',
    initiator: { kind: 'user', userId: USER_A },
  });

async function seed(fields: SupplierCardFields): Promise<SupplierCard> {
  const card = cardFromFields(
    fields,
    { userId: 'seed', nowIso: '2026-05-01T09:00:00.000Z', source: 'chat' },
    newCardId(fields),
  );
  return world.suppliers.saveCard(card, { createOnly: true });
}

const stored = async (id: string): Promise<SupplierCard> => {
  const card = await world.suppliers.getCard(id);
  if (card === null) throw new Error('карточки нет');
  return card;
};

const CONTRACT_TEXT = [
  `ДОГОВОР ПОСТАВКИ. Покупатель: ${OWN_COMPANY}, ИНН ${INN_BETA}, КПП 500101001, ` +
    `г. Свой, ул. Наша, 5, почта office@own.example, тел. ${OWN_PHONE}.`,
  `Поставщик: ООО «Альфа», ИНН ${INN_ALPHA}, КПП ${SUPPLIER_KPP}, ${SUPPLIER_ADDRESS},`,
  'сайт https://alfa.example, тел. +7 (900) 123-45-67.',
  'Оплата: предоплата 50%, остальное по факту отгрузки.',
  'Примечание: отгрузка со склада поставщика, самовывоз без доплат.',
].join('\n');

interface RunOptions {
  /** Вид документа в вызове (по умолчанию договор). */
  kind?: string;
  /** Записать, что в треде собран договор с этим поставщиком (по умолчанию да). */
  prepared?: boolean;
  /** Текст вложения, прочитанный в треде; null - вложений не читали. */
  attached?: string | null;
}

async function run(fields: Record<string, unknown>, options: RunOptions = {}) {
  const supplierId = typeof fields['supplierId'] === 'string' ? fields['supplierId'] : undefined;
  if (options.prepared !== false && supplierId !== undefined) {
    await notePreparedContract(host.state, THREAD, supplierId);
  }
  if (options.attached !== null) {
    await noteAttachmentText(host.state, THREAD, [options.attached ?? CONTRACT_TEXT]);
  }
  return enrichSupplierCardFromContract.execute(
    enrichSupplierCardFromContract.inputSchema.parse({
      origin: 'document',
      documentKind: options.kind ?? 'contract',
      sourceText: CONTRACT_TEXT,
      ...fields,
    }),
    host,
    ctx(),
  );
}

describe('documents: декларация дополнения карточки', () => {
  const names = (agent: { tools: ReadonlyArray<{ name: string }> }): string[] =>
    agent.tools.map((tool) => tool.name);

  test('с карточками и договорами: инструмент и абзац промпта есть', () => {
    const agent = createDocumentsAgent({ model: 'm', supplierCards: {} });
    expect(names(agent)).toContain('enrichSupplierCard');
    expect(new Set(names(agent)).size).toBe(names(agent).length);
    expect(agent.prompt).toContain(BLOCK_MARK);
    expect(agent.prompt).toContain('enrichSupplierCard');
    expect(agent.prompt).toContain('prepareSupplierCardEdit');
    const tool = agent.tools.find((item) => item.name === 'enrichSupplierCard');
    expect(tool?.sideEffect).toBe(true);
    expect(tool?.replay).toBe('confirm');
    expect(tool?.inputSchema.safeParse({ documentKind: 'contract' }).success).toBe(true);
    expect(tool?.inputSchema.safeParse({ sourceText: 'x' }).success).toBe(false);
  });

  test('без карточек или без договоров инструмента и абзаца нет', () => {
    const without = createDocumentsAgent({ model: 'm' });
    const noContracts = createDocumentsAgent({
      model: 'm',
      supplierCards: {},
      enabledKinds: ['invoice'],
    });
    for (const agent of [without, noContracts]) {
      expect(names(agent)).not.toContain('enrichSupplierCard');
      expect(agent.prompt).not.toContain(BLOCK_MARK);
    }
  });

  test('описание своё, без противоречий; messageText в схеме нет (п.7 ревью)', () => {
    const description = enrichSupplierCardFromContract.description;
    expect(description).not.toContain('messageText');
    expect(description).not.toContain('БЕЗ вопросов');
    expect(description).toContain('Новых карточек');
    const parsed = enrichSupplierCardFromContract.inputSchema.parse({
      documentKind: 'contract',
      messageText: 'выдумка модели',
      categories: ['Сумки'],
      packaging: 'box',
      strengths: 'лучший',
      sourceText: 'x',
    }) as Record<string, unknown>;
    for (const key of ['messageText', 'categories', 'packaging', 'strengths']) {
      expect(key in parsed).toBe(false);
    }
    expect(parsed['sourceText']).toBe('x');
  });
});

describe('documents: запись состояния для проверки источника и договора', () => {
  test('чтение файлов чата запоминает текст только при дополнении карточки', () => {
    const find = (agent: { tools: ReadonlyArray<{ name: string }> }) =>
      agent.tools.find((tool) => tool.name === 'readChatAttachments');
    const recorded = createDocumentsAgent({
      model: 'm',
      supplierCards: {},
      chatAttachments: true,
    });
    const plain = createDocumentsAgent({ model: 'm', chatAttachments: true });
    expect(find(recorded)).toBe(readChatAttachmentsRecorded);
    expect(find(plain)).not.toBe(readChatAttachmentsRecorded);
  });

  test('записи чистятся по сроку вместе с остальным состоянием разговора', () => {
    expect(WORKFLOW_STATE_STALE_SCOPE.namespaces).toContain(ATTACHMENT_TEXT_NAMESPACE);
    expect(WORKFLOW_STATE_STALE_SCOPE.namespaces).toContain(PREPARED_CONTRACT_NAMESPACE);
  });
});

describe('documents: дополнение карточки из договора', () => {
  test('не договор: ничего не записано', async () => {
    const existing = await seed({ name: 'Альфа', inn: INN_ALPHA });
    for (const kind of ['commercial_offer', 'invoice', 'closing']) {
      const out = await run({ supplierId: existing.id, website: 'https://alfa.example' }, { kind });
      expect(out.status).toBe('not_contract');
    }
    expect((await stored(existing.id)).website).toBeUndefined();
  });

  test('вид договор выключен флагом: отказ', async () => {
    const existing = await seed({ name: 'Альфа', inn: INN_ALPHA });
    host = { ...host, enabledKinds: ['invoice'] };
    const out = await run({ supplierId: existing.id, website: 'https://alfa.example' });
    expect(out.status).toBe('not_contract');
    expect((await stored(existing.id)).website).toBeUndefined();
  });

  test('договор: пустые поля дополнены, заметка из документа, вопросов нет', async () => {
    const existing = await seed({ name: 'Альфа', inn: INN_ALPHA });
    const out = await run({
      supplierId: existing.id,
      website: 'https://alfa.example',
      contacts: [{ phone: '+7 (900) 123-45-67' }],
      terms: { payment: 'предоплата 50%' },
    });
    expect(out.status).toBe('enriched');
    expect(out.added).toEqual(expect.arrayContaining(['website', 'terms.payment']));
    const saved = await stored(existing.id);
    expect(saved.website).toBe('https://alfa.example');
    expect(saved.notes.at(-1)?.text).toContain('Дополнено из документа');
    expect(world.chat.outbox.length).toBe(0);
  });

  test('расхождение не записано и отдано модели для prepareSupplierCardEdit', async () => {
    const existing = await seed({
      name: 'Альфа',
      inn: INN_ALPHA,
      terms: { payment: 'полная предоплата' },
    });
    const out = await run({ supplierId: existing.id, terms: { payment: 'предоплата 50%' } });
    expect(out.conflicts.map((item) => item.field)).toEqual(['terms.payment']);
    expect(out.message).toContain('prepareSupplierCardEdit');
    expect((await stored(existing.id)).terms.payment).toBe('полная предоплата');
  });

  test('повтор того же вызова: второй заметки нет', async () => {
    const existing = await seed({ name: 'Альфа', inn: INN_ALPHA });
    const fields = { supplierId: existing.id, website: 'https://alfa.example' };
    await run(fields);
    const again = await run(fields);
    expect(again.status).toBe('unchanged');
    const notes = (await stored(existing.id)).notes.filter((note) =>
      note.text.includes('Дополнено из документа'),
    );
    expect(notes).toHaveLength(1);
  });

  test('нет права записи карточек: отказ, карточка не тронута', async () => {
    delete world.deps.access;
    world.deps.access = new MemoryAccessPolicy();
    const existing = await seed({ name: 'Альфа', inn: INN_ALPHA });
    const out = await run({ supplierId: existing.id, website: 'https://alfa.example' });
    expect(out.status).toBe('access_denied');
    expect((await stored(existing.id)).website).toBeUndefined();
  });
});

describe('documents: договор определяется записью о сборке, а не словами модели (п.5)', () => {
  const tool = enrichSupplierCardFromContract;

  test('documentKind=contract без собранного договора: отказ, карточка не тронута', async () => {
    const existing = await seed({ name: 'Альфа', inn: INN_ALPHA });
    const out = await run(
      { supplierId: existing.id, website: 'https://alfa.example' },
      { prepared: false },
    );
    expect(out.status).toBe('not_contract');
    expect(out.message).toContain('prepareSupplierDocument');
    expect((await stored(existing.id)).website).toBeUndefined();
  });

  test('договор собран по другому поставщику: отказ', async () => {
    const existing = await seed({ name: 'Альфа', inn: INN_ALPHA });
    const other = await seed({ name: 'Гамма' });
    await notePreparedContract(host.state, THREAD, other.id);
    const out = await run(
      { supplierId: existing.id, website: 'https://alfa.example' },
      { prepared: false },
    );
    expect(out.status).toBe('not_contract');
    expect((await stored(existing.id)).website).toBeUndefined();
  });

  test('supplierId не назван: берётся единственный поставщик собранного договора', async () => {
    const existing = await seed({ name: 'Альфа', inn: INN_ALPHA });
    await notePreparedContract(host.state, THREAD, existing.id);
    const out = await run({ website: 'https://alfa.example' }, { prepared: false });
    expect(out.status).toBe('enriched');
    expect((await stored(existing.id)).website).toBe('https://alfa.example');
  });

  test('prepareSupplierDocument запоминает поставщика только для готового договора', async () => {
    const make = (kind: 'contract' | 'invoice', supplierId: string) =>
      prepareSupplierDocument.execute(
        { kind, supplierId, number: 'Д-1', issuedAt: '2026-01-05T00:00:00.000Z' },
        host,
        ctx(),
      );
    expect((await make('invoice', SUPPLIER_ID)).ready).toBe(true);
    expect(await preparedContractSuppliers(host.state, THREAD)).toEqual([]);
    expect((await make('contract', 'нет-такого')).ready).toBe(false);
    expect(await preparedContractSuppliers(host.state, THREAD)).toEqual([]);
    expect((await make('contract', SUPPLIER_ID)).ready).toBe(true);
    expect(await preparedContractSuppliers(host.state, THREAD)).toEqual([SUPPLIER_ID]);
  });

  test('отказ до сборки не кешируется: ключ операции меняется после сборки договора', async () => {
    const input = tool.inputSchema.parse({ documentKind: 'contract', supplierId: 'x' });
    const before = await tool.idempotencyPredecessor?.(input, host, THREAD);
    await notePreparedContract(host.state, THREAD, 'x');
    const after = await tool.idempotencyPredecessor?.(input, host, THREAD);
    expect(after).not.toBe(before);
  });
});

describe('documents: наши реквизиты в карточку поставщика не попадают', () => {
  test('ИНН, адрес и почта нашей компании отброшены кодом, поставщика записан', async () => {
    const existing = await seed({ name: 'Альфа' });
    const out = await run({
      supplierId: existing.id,
      inn: INN_BETA,
      legalAddress: 'г. Свой, ул. Наша, 5',
      contacts: [{ email: 'office@own.example' }, { phone: '+7 (900) 123-45-67' }],
      website: 'https://alfa.example',
    });
    expect(out.status).toBe('enriched');
    const saved = await stored(existing.id);
    expect(saved.inn).toBeUndefined();
    expect(saved.legalAddress).toBeUndefined();
    expect(saved.contacts.map((contact) => contact.email)).not.toContain('office@own.example');
    expect(saved.website).toBe('https://alfa.example');
    expect(out.warnings.join(' ')).toContain('нашей компании');
    expect(JSON.stringify(out)).not.toContain('office@own.example');
  });

  test('без заданных реквизитов нашей компании ИНН, адрес, контакты не пишутся (п.1)', async () => {
    const existing = await seed({ name: 'Альфа' });
    delete host.ownCompanyRequisites;
    const out = await run({
      supplierId: existing.id,
      inn: INN_ALPHA,
      kpp: SUPPLIER_KPP,
      legalAddress: SUPPLIER_ADDRESS,
      contacts: [{ phone: '+7 (900) 123-45-67' }],
      website: 'https://alfa.example',
    });
    expect(out.status).toBe('enriched');
    const saved = await stored(existing.id);
    expect(saved.inn).toBeUndefined();
    expect(saved.kpp).toBeUndefined();
    expect(saved.legalAddress).toBeUndefined();
    expect(saved.contacts).toHaveLength(0);
    expect(saved.website).toBe('https://alfa.example');
    expect(out.warnings.join(' ')).toContain('не заданы');
    for (const field of ['inn', 'kpp', 'legalAddress', 'contacts']) {
      expect(out.warnings.join(' ')).toContain(field);
    }
  });

  test('с заданными реквизитами значения поставщика записываются', async () => {
    const existing = await seed({ name: 'Альфа' });
    const out = await run({
      supplierId: existing.id,
      inn: INN_ALPHA,
      kpp: SUPPLIER_KPP,
      legalAddress: SUPPLIER_ADDRESS,
      contacts: [{ phone: '+7 (900) 123-45-67' }],
    });
    expect(out.status).toBe('enriched');
    const saved = await stored(existing.id);
    expect(saved.inn).toBe(INN_ALPHA);
    expect(saved.kpp).toBe(SUPPLIER_KPP);
    expect(saved.legalAddress).toBe(SUPPLIER_ADDRESS);
    expect(saved.contacts).toHaveLength(1);
  });

  test('карточка поставщика с ИНН: чужой (наш) ИНН не подменяет карточку', async () => {
    const existing = await seed({ name: 'Альфа', inn: INN_ALPHA });
    delete host.ownCompanyRequisites;
    const out = await run({ supplierId: existing.id, inn: INN_BETA });
    expect((await stored(existing.id)).inn).toBe(INN_ALPHA);
    expect(out.status).not.toBe('enriched');
  });
});

describe('documents: сравнение с нашими значениями не по полному равенству (п.2)', () => {
  test('ИНН в виде «ИНН ...» в переменной и с пробелами в значении: отброшен', async () => {
    const existing = await seed({ name: 'Альфа' });
    const spaced = `${INN_BETA.slice(0, 4)} ${INN_BETA.slice(4, 7)} ${INN_BETA.slice(7)}`;
    const out = await run({
      supplierId: existing.id,
      inn: spaced,
      website: 'https://alfa.example',
    });
    expect((await stored(existing.id)).inn).toBeUndefined();
    expect(out.warnings.join(' ')).toContain('inn');
  });

  test('КПП и ОГРН по цифрам: «КПП 500101001» в переменной, «500 101 001» в значении', () => {
    const filter = new OwnCompanyFilter([], ['КПП 500101001', 'ОГРН: 1027700132195']);
    expect(filter.isOwnCode('500 101 001')).toBe(true);
    expect(filter.isOwnCode('1027700132195')).toBe(true);
    expect(filter.isOwnCode('770701001')).toBe(false);
  });

  test('телефон по хвосту 10 цифр: «8 900 111 22 33» совпал с «+7 (900) 111-22-33»', async () => {
    const existing = await seed({ name: 'Альфа' });
    const out = await run({
      supplierId: existing.id,
      contacts: [{ phone: '8 900 111 22 33' }, { phone: '8 (900) 123-45-67' }],
    });
    const saved = await stored(existing.id);
    expect(saved.contacts).toHaveLength(1);
    expect(saved.contacts[0]?.phone?.endsWith('9001234567')).toBe(true);
    expect(out.warnings.join(' ')).toContain('contacts');
  });

  test('адрес по вхождению: наш адрес с офисом и другой пунктуацией отброшен', async () => {
    const existing = await seed({ name: 'Альфа' });
    const address = 'Г Свой УЛ Наша 5, офис 3';
    const text = `${CONTRACT_TEXT}\nАдрес покупателя: ${address}`;
    await run(
      {
        supplierId: existing.id,
        sourceText: text,
        legalAddress: address,
        website: 'https://alfa.example',
      },
      { attached: text },
    );
    expect((await stored(existing.id)).legalAddress).toBeUndefined();
  });

  test('почта в другом регистре отброшена, чужая запись не задета', async () => {
    const existing = await seed({ name: 'Альфа' });
    const text = `${CONTRACT_TEXT}\nОтдел продаж поставщика: sales@alfa.example`;
    await run(
      {
        supplierId: existing.id,
        sourceText: text,
        contacts: [{ email: 'Office@Own.Example' }, { email: 'sales@alfa.example' }],
      },
      { attached: text },
    );
    const saved = await stored(existing.id);
    expect(saved.contacts.map((contact) => contact.email)).toEqual(['sales@alfa.example']);
  });

  test('фильтр: короткое вхождение не считается совпадением', () => {
    const filter = new OwnCompanyFilter(['ООО Свои'], ['г. Свой, ул. Наша, 5']);
    expect(filter.isOwnText('5')).toBe(false);
    expect(filter.isOwnText('ул. Наша')).toBe(false);
    expect(filter.isOwnText('г. Свой, ул. Наша, 5, офис 2')).toBe(true);
    expect(filter.isOwnCode(INN_ALPHA)).toBe(false);
  });
});

describe('documents: юрлица и свободные поля (п.3)', () => {
  test('legalEntities: наше юрлицо отброшено, чужое из договора записано', async () => {
    const existing = await seed({ name: 'Альфа' });
    const text = `${CONTRACT_TEXT}\nАффилированное лицо: ООО «Альфа-Трейд», ИНН ${INN_ALPHA}.`;
    const out = await run(
      {
        supplierId: existing.id,
        sourceText: text,
        legalEntities: [
          { name: OWN_COMPANY, inn: INN_BETA },
          { name: 'ООО «Альфа-Трейд»', inn: INN_ALPHA },
        ],
      },
      { attached: text },
    );
    expect(out.status).toBe('enriched');
    const names = ((await stored(existing.id)).legalEntities ?? []).map((entity) => entity.name);
    expect(names).toEqual(['ООО «Альфа-Трейд»']);
    expect(out.warnings.join(' ')).toContain('legalEntities');
  });

  test('legalEntities, которых нет в тексте источника, отклонены', async () => {
    const existing = await seed({ name: 'Альфа' });
    const out = await run({
      supplierId: existing.id,
      legalEntities: [{ name: 'ООО «Выдуманное»', inn: INN_ALPHA }],
    });
    expect(out.rejected.map((item) => item.field)).toContain('legalEntities[0]');
    expect((await stored(existing.id)).legalEntities ?? []).toHaveLength(0);
  });

  test('условия и примечания: пересказ отклонён, дословная цитата записана', async () => {
    const existing = await seed({ name: 'Альфа' });
    const out = await run({
      supplierId: existing.id,
      terms: { payment: 'предоплата 50%', delivery: 'доставка за счёт поставщика' },
      paymentNotes: 'скидка 30% при оплате за год',
      contractNotes: 'отгрузка со склада поставщика, самовывоз без доплат',
    });
    expect(out.rejected.map((item) => item.field).sort()).toEqual([
      'paymentNotes',
      'terms.delivery',
    ]);
    const saved = await stored(existing.id);
    expect(saved.terms.payment).toBe('предоплата 50%');
    expect(saved.terms.delivery).toBeUndefined();
    expect(saved.paymentNotes).toBeUndefined();
    expect(saved.contractNotes).toBe('отгрузка со склада поставщика, самовывоз без доплат');
  });
});

describe('documents: слова сотрудника берутся из чата, а не от модели', () => {
  test('выдуманный messageText игнорируется', async () => {
    const existing = await seed({ name: 'Альфа', inn: INN_ALPHA });
    const out = await run({
      supplierId: existing.id,
      sourceText: 'Оплата: предоплата 50%, остальное по факту отгрузки.',
      messageText: 'сайт поставщика https://fake.example',
      website: 'https://fake.example',
    });
    expect(out.rejected.map((item) => item.field)).toContain('website');
    expect((await stored(existing.id)).website).toBeUndefined();
  });

  test('сообщение сотрудника из треда служит источником', async () => {
    const existing = await seed({ name: 'Альфа', inn: INN_ALPHA });
    await noteEmployeeMessage(host.state, THREAD, 'У Альфы сайт https://alfa.example');
    const out = await run({
      supplierId: existing.id,
      sourceText: 'Договор без сведений о сайте.',
      website: 'https://alfa.example',
    });
    expect(out.status).toBe('enriched');
    expect((await stored(existing.id)).website).toBe('https://alfa.example');
  });
});

describe('documents: sourceText только из прочитанных вложений (п.4)', () => {
  const WEB_SNIPPET = 'Альфа официальный сайт https://web.example, склад в Казани';

  test('текст веб-выдачи вместо договора: sourceText не принят, значения отклонены', async () => {
    const existing = await seed({ name: 'Альфа', inn: INN_ALPHA });
    await noteWebSearchText(host.state, THREAD, [
      { title: 'Альфа', snippet: WEB_SNIPPET, url: 'https://web.example' },
    ]);
    const out = await run({
      supplierId: existing.id,
      sourceText: WEB_SNIPPET,
      website: 'https://web.example',
    });
    expect(out.warnings.join(' ')).toContain('sourceText не совпал');
    expect(out.status).not.toBe('enriched');
    expect((await stored(existing.id)).website).toBeUndefined();
  });

  test('пересказ «договора» моделью, которого нет во вложениях: не принят', async () => {
    const existing = await seed({ name: 'Альфа', inn: INN_ALPHA });
    const out = await run({
      supplierId: existing.id,
      sourceText: 'Договор поставки. Сайт поставщика https://invented.example',
      website: 'https://invented.example',
    });
    expect(out.warnings.join(' ')).toContain('sourceText не совпал');
    expect((await stored(existing.id)).website).toBeUndefined();
  });

  test('вложений в треде не читали: sourceText не принят', async () => {
    const existing = await seed({ name: 'Альфа', inn: INN_ALPHA });
    const out = await run(
      { supplierId: existing.id, website: 'https://alfa.example' },
      { attached: null },
    );
    expect(out.warnings.join(' ')).toContain('sourceText не совпал');
    expect(out.status).toBe('no_source');
    expect((await stored(existing.id)).website).toBeUndefined();
  });

  test('фрагмент вложения (с другой пунктуацией и регистром) принимается', async () => {
    const existing = await seed({ name: 'Альфа', inn: INN_ALPHA });
    const out = await run({
      supplierId: existing.id,
      sourceText: 'САЙТ https://alfa.example, ТЕЛ +7 (900) 123-45-67',
      website: 'https://alfa.example',
    });
    expect(out.status).toBe('enriched');
    expect((await stored(existing.id)).website).toBe('https://alfa.example');
  });
});
