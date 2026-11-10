import { afterAll, describe, expect, test } from 'bun:test';
import { removeTempDirs } from '@business-ai/testing';
import { pragmatikaRuntime } from '../../src/runtime';
import { buildPragmatika } from './support';

afterAll(removeTempDirs);

type PragmatikaApp = ReturnType<typeof buildPragmatika>['app'];

/**
 * Инструменты агентов при всех выключенных флагах - вариант `minimal` эталона прежней сборки
 * (stage-0/baseline/behavior/agents.json). Только имена, значений окружения здесь нет.
 */
const BASELINE_MINIMAL_TOOLS: Record<string, readonly string[]> = {
  'documents': [
    'askToConfirmWebFields',
    'checkTemplateFields',
    'createFile',
    'fillTemplate',
    'findTemplate',
    'getSelectedQuote',
    'getSupplierRequisites',
    'handoffForReview',
    'lookupSupplierInBase',
    'prepareSupplierDocument',
    'recordFeedback',
    'recordSupplierLookupDecision',
    'recordWebFieldsDecision',
    'saveDocument',
    'searchContractRegistry',
    'searchConversationHistory',
    'searchInternet',
    'validateDocument',
  ],
  'order-calc': [
    'askManagerToChoose',
    'buildShortlist',
    'closeOrder',
    'compareQuotes',
    'confirmQuoteReplacement',
    'createFile',
    'orderStatus',
    'prepareSupplierRequestText',
    'recordFeedback',
    'recordManagerChoice',
    'recordQuote',
    'recordSelection',
    'recordSupplierCardDecision',
    'recordSupplierReply',
    'searchConversationHistory',
    'searchInternet',
    'searchKnowledgeSuppliers',
    'searchWeb',
    'sendQuoteSummary',
  ],
  'prices': [
    'answerPriceFileSupplier',
    'commitPriceImport',
    'createFile',
    'editPricesInSourceFile',
    'listIntakeFiles',
    'listPriceFiles',
    'listStalePriceFiles',
    'listStalePriceSuppliers',
    'lookupSupplierInBase',
    'normalizePriceTable',
    'previewPriceChanges',
    'readIntakeFile',
    'readPriceFile',
    'recordEmployeePriceUpdates',
    'recordFeedback',
    'recordSupplierLookupDecision',
    'reportToManager',
    'savePriceImport',
    'searchConversationHistory',
    'searchInternet',
    'searchSuppliers',
    'sendPriceChangeFile',
    'stagePriceRows',
  ],
  'site-export': [
    'computeSitePrice',
    'createFile',
    'fillTemplateRows',
    'gatherItemData',
    'lookupSupplierInBase',
    'nameSitePhotos',
    'openChatTemplate',
    'prepareCleanTemplate',
    'readChatAttachments',
    'readEmployeeIdentity',
    'readTemplateStructure',
    'recordFeedback',
    'recordSupplierLookupDecision',
    'reportToManager',
    'searchConversationHistory',
    'searchInternet',
    'sendTemplateFile',
  ]
};

/** Инструменты, которые добавляет включение карточек поставщиков. */
const SUPPLIER_CARD_TOOLS = [
  'addSupplierNote',
  'confirmSupplierRequest',
  'createSupplierFromAttachment',
  'enrichSupplierCard',
  'findSupplierCard',
  'forgetMyNote',
  'prepareSupplierCard',
  'prepareSupplierCardEdit',
  'rememberForMe',
  'whatDoYouRemember',
];

const AGENT_IDS = ['prices', 'documents', 'order-calc', 'site-export'] as const;

function toolsOf(app: PragmatikaApp, agentId: string): string[] {
  return app.registry
    .get(agentId)
    .tools.map((tool) => tool.name)
    .sort();
}

describe('сборка агентов Прагматики', () => {
  test('четыре агента с моделями из алиасов', () => {
    const { app } = buildPragmatika();
    expect(app.registry.get('prices').model).toBe('prices-alias');
    expect(app.registry.get('documents').model).toBe('documents-alias');
    expect(app.registry.get('order-calc').model).toBe('order-calc-alias');
    expect(app.registry.get('site-export').model).toBe('site-export-alias');
  });

  test('все флаги выключены: наборы инструментов равны эталону прежней сборки', () => {
    const { app } = buildPragmatika();
    for (const id of AGENT_IDS) {
      expect(toolsOf(app, id)).toEqual([...(BASELINE_MINIMAL_TOOLS[id] ?? [])].sort());
    }
  });

  test('SUPPLIER_CARDS_ENABLED добавляет карточки всем четырём агентам', () => {
    const { app } = buildPragmatika({ SUPPLIER_CARDS_ENABLED: 'true' });
    for (const id of AGENT_IDS) {
      const expected = [...(BASELINE_MINIMAL_TOOLS[id] ?? []), ...SUPPLIER_CARD_TOOLS].sort();
      expect(toolsOf(app, id)).toEqual(expected);
    }
  });

  test('выгрузка поставщиков появляется только у «Поиска поставщика» и только с карточками', () => {
    const on = buildPragmatika({
      SUPPLIER_CARDS_ENABLED: 'true',
      SUPPLIER_EXPORT_ENABLED: 'true',
    }).app;
    expect(toolsOf(on, 'order-calc')).toContain('exportSuppliers');
    for (const id of ['prices', 'documents', 'site-export']) {
      expect(toolsOf(on, id)).not.toContain('exportSuppliers');
    }
    const cardsOnly = buildPragmatika({ SUPPLIER_CARDS_ENABLED: 'true' }).app;
    expect(toolsOf(cardsOnly, 'order-calc')).not.toContain('exportSuppliers');
  });

  test('приём заявки включается флагом и добавляет три инструмента', () => {
    const base = toolsOf(buildPragmatika().app, 'order-calc');
    const on = toolsOf(buildPragmatika({ ORDER_CALC_INTAKE_ENABLED: 'true' }).app, 'order-calc');
    expect(on.filter((name) => !base.includes(name))).toEqual([
      'readChatAttachments',
      'readIntakeSource',
      'saveIntakeRequest',
    ]);
  });

  test('SUPPLIER_EXPORT_ENABLED без SUPPLIER_CARDS_ENABLED роняет сборку', () => {
    expect(() => buildPragmatika({ SUPPLIER_EXPORT_ENABLED: 'true' })).toThrow(
      /SUPPLIER_EXPORT_ENABLED/,
    );
  });

  test('состояние приложения для кнопок и задач появляется после сборки', () => {
    buildPragmatika({ PRICE_DISK_SYNC_ENABLED: 'true', BUSINESS_TIMEZONE: 'Asia/Yekaterinburg' });
    const runtime = pragmatikaRuntime();
    expect(runtime).toBeDefined();
    expect(runtime?.priceDiskSyncEnabled).toBe(true);
    expect(runtime?.timezone).toBe('Asia/Yekaterinburg');
    expect(runtime?.supplierCards).toBeUndefined();
    buildPragmatika({ SUPPLIER_CARDS_ENABLED: 'true' });
    expect(pragmatikaRuntime()?.supplierCards).toBeDefined();
    expect(pragmatikaRuntime()?.priceDiskSyncEnabled).toBe(false);
  });

  test('шаблон выгрузки сайта всегда помечен как временный', () => {
    const { app } = buildPragmatika();
    expect(app.unconfigured.some((line) => line.startsWith('exportTemplate'))).toBe(true);
  });
});
