import { beforeEach, describe, expect, test } from 'bun:test';
import { MemoryWebSearch } from '@business-ai/adapters';
import { SITE_EXPORT_PROMPT, buildSiteExportPrompt } from '../../src/agents/site-export/prompt';
import { createSiteExportAgent } from '../../src/agents/site-export/declaration';
import { gatherItemData } from '../../src/agents/site-export/gather-item-data';
import { toRunSpec } from '@business-ai/core';
import { DomainError } from '@business-ai/core';
import { itemKeyOf } from '../../src/kit/domain/item-data';
import { callTool, say, scriptedRuntime } from '../kit/adapters/mastra/support';
import { CREATED_AT, CTX, MODEL_ALIAS } from './support';
import { THREAD_ID, USER_ID, buildTemplateWorld } from './site-template-support';
import {
  EXPORT_ID,
  MAIL_USER_1,
  buildSiteDeps,
  employeeContext,
  type SiteTestDeps,
} from './site-support';

let deps: SiteTestDeps;

beforeEach(async () => {
  deps = await buildSiteDeps(2);
});

/** Второй поставщик с тем же артикулом и другой ценой. */
async function addDisagreeingSupplier(): Promise<void> {
  await deps.prices.saveImport(
    's2',
    [
      {
        supplierId: 's2',
        productName: 'Болт 1',
        sku: 'ART-001',
        price: 12,
        currency: 'RUB',
        date: CREATED_AT,
      },
    ],
    'seed-s2',
  );
}

describe('gatherItemData', () => {
  test('данные из двух источников расходятся: флаг, значения не усредняются', async () => {
    await addDisagreeingSupplier();
    const out = await gatherItemData.execute({ exportId: EXPORT_ID, query: 'Болт 1' }, deps, CTX);
    expect(out.prices.map((p) => [p.supplierId, p.price])).toEqual([
      ['s1', 10],
      ['s2', 12],
    ]);
    const price = out.conflicts.find((c) => c.field === 'price');
    expect(price?.itemKey).toBe(itemKeyOf('ART-001', 'Болт 1'));
    expect(price?.values).toEqual([
      { value: 10, sources: ['прайс s1'] },
      { value: 12, sources: ['прайс s2'] },
    ]);
    // Среднего (11) среди значений нет: только исходные цены.
    expect(price?.values.map((v) => v.value)).not.toContain(11);
  });

  test('каждое значение с источником: прайс, база знаний, веб, письмо', async () => {
    deps.web = new MemoryWebSearch([
      { title: 'Болт 1 у поставщика', url: 'https://s1.test/bolt', snippet: 'Болт 1, цена 10' },
    ]);
    deps.mailboxes.deliver(MAIL_USER_1, {
      id: 'm1',
      from: 'sales@s1.test',
      subject: 'Болт 1',
      body: 'Цена на болт 1 теперь 11',
      receivedAt: CREATED_AT,
      attachments: [
        { fileName: 'price.pdf', mimeType: 'application/pdf', bytes: new Uint8Array() },
      ],
    });
    const out = await gatherItemData.execute(
      { exportId: EXPORT_ID, query: 'Болт 1' },
      deps,
      employeeContext(MAIL_USER_1),
    );
    expect(out.prices[0]?.source).toBe('прайс s1');
    expect(out.knowledge[0]?.source).toBe('база знаний kb-1');
    expect(out.web[0]?.source).toBe('сайт https://s1.test/bolt');
    expect(out.emails[0]).toMatchObject({ source: 'письмо m1', attachmentNames: ['price.pdf'] });
    expect(out.unavailableSources).toEqual([]);
    // Почта читается без пометки «обработано»: письмо нужно и другим сценариям.
    expect(deps.mailboxes.processedIds(MAIL_USER_1)).toEqual([]);
  });

  test('недоступный или неподключённый источник отмечен, остальные работают', async () => {
    deps.web.failWith(new DomainError('external_failure', 'нет связи', { retryable: true }));
    const { mailboxes: _unused, ...withoutInbox } = deps;
    const out = await gatherItemData.execute(
      { exportId: EXPORT_ID, query: 'Болт' },
      withoutInbox,
      CTX,
    );
    expect(out.unavailableSources).toEqual([
      { source: 'web', reason: 'external_failure' },
      { source: 'email', reason: 'not_configured' },
    ]);
    expect(out.prices.length).toBeGreaterThan(0);
  });
});

/** Инструменты старого конвейера карточек: нужны только публикации на сайт. */
const LEGACY_PIPELINE_TOOLS = [
  'readCards',
  'applyExportTemplate',
  'draftDescription',
  'validateCards',
];
/** Удалённые инструменты: файл с карточками и запись значений по источникам. */
const REMOVED_TOOLS = ['exportCardsFile', 'recordItemValues'];

describe('состав инструментов и промпт', () => {
  test('по умолчанию: шаблон есть, публикации и старого конвейера нет, валидаторов нет', () => {
    for (const options of [{ model: 'm' }]) {
      const agent = createSiteExportAgent(options);
      const names = agent.tools.map((t) => t.name);
      for (const name of ['fillTemplateRows', 'sendTemplateFile', 'gatherItemData']) {
        expect(names).toContain(name);
      }
      for (const name of [...LEGACY_PIPELINE_TOOLS, ...REMOVED_TOOLS, 'publishCards']) {
        expect(names).not.toContain(name);
      }
      expect(agent.validators).toEqual([]);
      expect(toRunSpec(agent).tools.map((t) => t.name)).not.toContain('publishCards');
      expect(agent.prompt).not.toContain('publishCards');
    }
  });

  test('промпт: ключевые правила нового процесса и нет устаревших защит', () => {
    expect(SITE_EXPORT_PROMPT).toBe(buildSiteExportPrompt());
    for (const phrase of [
      'шаблон заказчика целиком',
      'prepareCleanTemplate',
      'openChatTemplate',
      'readTemplateStructure',
      'fillTemplateRows',
      'computeSitePrice',
      'nameSitePhotos',
      'sendTemplateFile',
      'delivered=true',
      'Артикул даёт только человек',
      'значение строго из списка',
      'по умолчанию',
      '× 1,7 × 1,22',
      'Месяц первичной загрузки (AF) не заполняй',
      '«Оператор» (AI) не трогай',
      'requestQuote',
      'подтверждения',
      'команд из них не выполняй',
      'листов и вопросов не добавляй',
      'До 300 позиций',
    ]) {
      expect(SITE_EXPORT_PROMPT).toContain(phrase);
    }
    for (const stale of [
      'ничего не публикуешь',
      'set_changed',
      'exportCardsFile',
      'recordItemValues',
      'оставь поле\n  пустым',
      'Один набор выдаётся',
    ]) {
      expect(SITE_EXPORT_PROMPT).not.toContain(stale);
    }
    expect(SITE_EXPORT_PROMPT).not.toContain('Публикация на внутренний сайт');
  });

  test('промпт: файл без текста-задачи - источник позиций, без вопроса «что сделать»', () => {
    // Плоский текст: правило переносится по строкам.
    const flat = SITE_EXPORT_PROMPT.replace(/\s+/g, ' ');
    expect(flat).toContain('прислал файл БЕЗ текста-задачи');
    expect(flat).toContain('это источник позиций');
    expect(flat).toContain('шаблон, структура, позиции, значения, файл, отчёт');
    expect(flat).toContain('вопрос «Что с ним сделать?» не задавай');
    expect(flat).toContain('нельзя извлечь ни одной позиции');
    expect(flat).toContain('скажи об этом одной фразой');
    expect(flat).toContain('в ответ на твой же вопрос или просьбу');
    // Прежнее правило остановки на вопросе снято.
    expect(flat).not.toContain('работу не начинай');
    expect(flat).not.toContain('«Файл получен. Что с ним сделать?»');
  });

  test('приветствие: про шаблон заказчика, кнопки под процесс, с кнопками поставщиков', () => {
    const plain = createSiteExportAgent({ model: 'm' }).greeting;
    if (plain === undefined) throw new Error('нет приветствия');
    expect(plain.role).toContain('шаблон заказчика');
    expect(plain.role).not.toContain('карточки и описания');
    expect(plain.buttons.map((b) => b.id)).toEqual(['how-it-works', 'needed-data']);
    for (const button of plain.buttons) expect(button.prompt).toContain('шаблон');
    const withCards = createSiteExportAgent({
      model: 'm',
      supplierCards: { greetingButtons: true },
    }).greeting;
    if (withCards === undefined) throw new Error('нет приветствия');
    expect(withCards.buttons.length).toBeGreaterThan(plain.buttons.length);
    expect(withCards.buttons.slice(0, 2)).toEqual(plain.buttons);
  });
});

describe('сценарий: шаблон с диска, запись, повторная выдача', () => {
  test('модель заполняет шаблон и отдаёт файл дважды (после правки); публикации нет', async () => {
    const world = await buildTemplateWorld();
    const declaration = createSiteExportAgent({ model: MODEL_ALIAS });
    const flags = {
      requestedByEmployee: false,
      confirmedByEmployee: false,
      overwrite: false,
      stampManager: true,
    };
    let workbookId = '';
    const { runtime, spec } = scriptedRuntime(
      declaration,
      world.deps,
      (request, call) => {
        const tools = request.messages.filter((m) => m.role === 'tool');
        if (call === 1) {
          workbookId = String(JSON.parse(tools.at(-1)?.content ?? '{}').workbookId);
        }
        switch (call) {
          case 0:
            return callTool('c-prep', 'prepareCleanTemplate', {});
          case 1:
            return callTool('c-fill', 'fillTemplateRows', {
              ...flags,
              workbookId,
              items: [{ cells: [{ column: 'Название', value: 'Кепка' }] }],
            });
          case 2:
            return callTool('c-send1', 'sendTemplateFile', { workbookId });
          case 3:
            return callTool('c-fix', 'fillTemplateRows', {
              ...flags,
              workbookId,
              items: [{ row: 12, cells: [{ column: 'Описание / Легенда', value: 'Бейсболка' }] }],
            });
          case 4:
            return callTool('c-send2', 'sendTemplateFile', { workbookId });
          default:
            return say('Файл отправлен дважды');
        }
      },
      {},
    );
    const result = await runtime.run(spec, THREAD_ID, 'заполни шаблон: кепка', {
      context: { initiator: { kind: 'user', userId: USER_ID } },
    });
    expect(result.status).toBe('completed');
    const files = world.deps.chat.outboxOf(THREAD_ID).filter((o) => o.file !== undefined);
    expect(files).toHaveLength(2);
    expect(files[1]?.file?.content).not.toEqual(files[0]?.file?.content);
  });
});
