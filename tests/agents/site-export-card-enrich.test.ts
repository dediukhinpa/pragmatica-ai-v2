import { beforeEach, describe, expect, test } from 'bun:test';
import { MemoryAccessPolicy, MemoryWorkflowStateStore } from '@business-ai/adapters';
import {
  cardFromFields,
  newCardId,
  type SupplierCardFields,
} from '../../src/agents/suppliers/card-fields';
import { createSiteExportAgent } from '../../src/agents/site-export/declaration';
import {
  noteAttachmentText,
  readAttachmentText,
} from '../../src/agents/suppliers/document-source-text';
import { noteWebSearchText } from '../../src/agents/documents/web-confirmation';
import { readChatAttachmentsRecorded } from '../../src/agents/order-calc/read-chat-attachments';
import { type SiteExportDeps } from '../../src/agents/site-export/deps';
import { ACTION_CONFIRM_SUPPLIER_CARD } from '../../src/kit/domain/access.owned';
import { type SupplierCard } from '../../src/kit/domain/supplier-card';
import {
  INN_ALPHA,
  USER_A,
  buildSupplierWorld,
  turnContext,
  type SupplierWorld,
} from './suppliers-support';

/**
 * Агент «Актуализация сайта»: дополнение карточки поставщика свежими сведениями из документа
 * (этап 219). Решение, что сведения свежие и их нет в базе, принимает модель; код записывает
 * только пустые поля. Данные синтетические.
 */

const BOT = 'site-export';
/** Фрагмент абзаца промпта о дополнении карточки. */
const RULE_MARK = 'Свежие сведения о поставщике';

const THREAD = `${BOT}/${USER_A}`;
const OWN_NAME = 'ООО Наша Компания';
const OWN_INN_TEXT = 'ИНН 5001007327';
let world: SupplierWorld;
let host: SiteExportDeps;
beforeEach(() => {
  world = buildSupplierWorld();
  host = {
    ...world.host,
    state: new MemoryWorkflowStateStore(),
    ownCompanyNames: [OWN_NAME],
    ownCompanyRequisites: [OWN_INN_TEXT, 'office@own.example'],
  } as unknown as SiteExportDeps;
  const access = new MemoryAccessPolicy();
  access.allow({ userId: USER_A, botId: BOT, action: ACTION_CONFIRM_SUPPLIER_CARD });
  world.deps.access = access;
});

async function seed(fields: SupplierCardFields): Promise<SupplierCard> {
  const card = cardFromFields(
    fields,
    { userId: 'seed', nowIso: '2026-05-01T09:00:00.000Z', source: 'chat' },
    newCardId(fields),
  );
  return world.suppliers.saveCard(card, { createOnly: true });
}

describe('site-export: правило дополнения карточки', () => {
  test('с карточками: инструмент и абзац в промпте, порядок и границы названы', () => {
    const agent = createSiteExportAgent({ model: 'm', supplierCards: {} });
    expect(agent.tools.map((tool) => tool.name)).toContain('enrichSupplierCard');
    expect(agent.prompt).toContain(RULE_MARK);
    // Сначала проверка по базе, потом дополнение; файл не задерживает; новых карточек нет.
    const block = agent.prompt.slice(agent.prompt.indexOf(RULE_MARK));
    expect(block).toContain('lookupSupplierInBase');
    expect(block).toContain('findSupplierCard');
    expect(block).toContain('enrichSupplierCard');
    expect(block).toContain('не задерживает');
    expect(block).toContain('prepareSupplierCardEdit');
    // Столбцы выгрузки правило не затрагивает.
    expect(block).not.toContain('fillTemplateRows');
  });

  test('порядок: после заполнения файла и отчёта менеджеру; веб не источник', () => {
    const agent = createSiteExportAgent({ model: 'm', supplierCards: {} });
    const block = agent.prompt.slice(agent.prompt.indexOf(RULE_MARK));
    expect(block).toContain('строго после заполнения файла и после отчёта менеджеру');
    expect(block).toContain('reportToManager');
    expect(block).toMatch(/страниц\s+сайтов и из веб-поиска/);
    expect(block).toContain('только присланный документ');
    // Упаковка и материалы (перечисления) проверить по тексту нельзя: инструмент их не берёт.
    expect(block).not.toContain('упаковка');
  });

  test('своя обёртка: поля ограничены, messageText в схеме нет, вложения пишутся', () => {
    const agent = createSiteExportAgent({ model: 'm', supplierCards: {} });
    const tools = agent.tools.filter((tool) => tool.name === 'enrichSupplierCard');
    expect(tools).toHaveLength(1);
    const tool = tools[0];
    const parsed = tool?.inputSchema.parse({
      messageText: 'x',
      packaging: 'box',
      inn: '7707083893',
      website: 'https://a.example',
    }) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['origin', 'website']);
    expect(tool?.description).not.toContain('messageText');
    const reader = agent.tools.find((item) => item.name === 'readChatAttachments');
    expect(reader).toBe(readChatAttachmentsRecorded);
    const plain = createSiteExportAgent({ model: 'm' });
    expect(plain.tools.find((item) => item.name === 'readChatAttachments')).not.toBe(reader);
  });

  test('без карточек: абзаца и инструмента нет', () => {
    const agent = createSiteExportAgent({ model: 'm' });
    expect(agent.tools.map((tool) => tool.name)).not.toContain('enrichSupplierCard');
    expect(agent.prompt).not.toContain(RULE_MARK);
  });
});

describe('site-export: дополнение карточки из документа', () => {
  const agent = createSiteExportAgent({ model: 'm', supplierCards: {} });
  const tool = agent.tools.find((item) => item.name === 'enrichSupplierCard');
  const text =
    'Прайс ООО «Альфа» 2026. Упаковка: подарочная коробка. Сайт: https://alfa.example. ' +
    'Оплата: предоплата 30%. Покупатель: ' + OWN_NAME + ', office@own.example, ' + OWN_INN_TEXT;
  const call = async (id: string, fields: Record<string, unknown> = {}, attach = true) => {
    if (tool === undefined) throw new Error('инструмента нет');
    if (attach) await noteAttachmentText(host.state, THREAD, [text]);
    const input = tool.inputSchema.parse({
      supplierId: id,
      origin: 'file',
      sourceText: text,
      website: 'https://alfa.example',
      ...fields,
    });
    return (await tool.execute(input, host, turnContext(USER_A, THREAD, BOT))) as {
      status: string;
      added: string[];
      warnings: string[];
      rejected: Array<{ field: string }>;
    };
  };

  test('свежий факт, которого нет в карточке: дополнено; повтор и нет нового: ничего', async () => {
    const existing = await seed({ name: 'Альфа', inn: INN_ALPHA });
    const first = await call(existing.id);
    expect(first.status).toBe('enriched');
    expect(first.added).toContain('website');
    const second = await call(existing.id);
    expect(second.status).toBe('unchanged');
    const card = await world.suppliers.getCard(existing.id);
    expect(card?.notes.filter((note) => note.text.includes('Дополнено из'))).toHaveLength(1);
  });

  test('факт уже есть в карточке: ничего не записано', async () => {
    const existing = await seed({ name: 'Альфа', inn: INN_ALPHA, website: 'https://alfa.example' });
    expect((await call(existing.id)).status).toBe('unchanged');
  });

  test('текст веб-страницы как sourceText (п.6): не принят, карточка не тронута', async () => {
    const existing = await seed({ name: 'Альфа', inn: INN_ALPHA });
    const page = 'Альфа: официальный сайт https://web.example, контакты и условия';
    await noteWebSearchText(host.state, THREAD, [
      { title: 'Альфа', snippet: page, url: 'https://web.example' },
    ]);
    await noteAttachmentText(host.state, THREAD, [text]);
    const out = await call(
      existing.id,
      { sourceText: page, website: 'https://web.example' },
      false,
    );
    expect(out.status).toBe('no_source');
    expect(out.warnings.join(' ')).toContain('sourceText не совпал');
    expect((await world.suppliers.getCard(existing.id))?.website).toBeUndefined();
  });

  test('значения нашей компании из документа отброшены, поставщика записан', async () => {
    const existing = await seed({ name: 'Альфа' });
    const out = await call(existing.id, {
      contacts: [{ email: 'office@own.example' }],
    });
    expect(out.status).toBe('enriched');
    const card = await world.suppliers.getCard(existing.id);
    expect(card?.contacts).toHaveLength(0);
    expect(card?.website).toBe('https://alfa.example');
    expect(out.warnings.join(' ')).toContain('contacts');
  });

  test('реквизиты нашей компании не заданы: контакты не пишутся, сайт пишется', async () => {
    const existing = await seed({ name: 'Альфа' });
    delete host.ownCompanyRequisites;
    const out = await call(existing.id, { contacts: [{ email: 'office@own.example' }] });
    expect(out.status).toBe('enriched');
    const card = await world.suppliers.getCard(existing.id);
    expect(card?.contacts).toHaveLength(0);
    expect(card?.website).toBe('https://alfa.example');
    expect(out.warnings.join(' ')).toContain('не заданы');
  });

  test('условия: пересказ отклонён, цитата документа записана', async () => {
    const existing = await seed({ name: 'Альфа' });
    const out = await call(existing.id, {
      terms: { payment: 'предоплата 30%', delivery: 'бесплатно по Москве' },
    });
    expect(out.rejected.map((item) => item.field)).toEqual(['terms.delivery']);
    const card = await world.suppliers.getCard(existing.id);
    expect(card?.terms.payment).toBe('предоплата 30%');
    expect(card?.terms.delivery).toBeUndefined();
  });
});

describe('site-export: чтение вложений запоминает текст для проверки источника', () => {
  test('прочитанный файл попадает в состояние треда, повтор не раздувает', async () => {
    const reader = readChatAttachmentsRecorded;
    const bytes = new TextEncoder().encode('Прайс Альфа. Сайт https://alfa.example');
    const deps = {
      ...host,
      botFiles: { recent: () => [{ botId: 1, fileId: 7, name: 'price.txt' }] },
      attachments: {
        fetchAttachments: async () => ({
          attachments: [{ name: 'price.txt', mime: 'text/plain', bytes, source: 'bot' as const }],
          errors: [],
        }),
      },
    } as unknown as SiteExportDeps;
    const context = turnContext(USER_A, THREAD, BOT);
    const out = (await reader.execute({}, deps, context)) as { filesInChat: number };
    expect(out.filesInChat).toBe(1);
    const first = await readAttachmentText(host.state, THREAD);
    expect(first).toContain('https://alfa.example');
    await reader.execute({}, deps, context);
    expect(await readAttachmentText(host.state, THREAD)).toBe(first);
  });
});
