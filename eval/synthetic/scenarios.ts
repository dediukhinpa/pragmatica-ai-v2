import { manualReplyId } from '../../src/agents/order-calc/record-supplier-reply';
import type { ModelRequest } from '@business-ai/core';
import {
  callTool,
  callTools,
  lastToolResult,
  say,
  type Script,
  type ScriptStep,
} from '@business-ai/eval';

/** Алиасы синтетических «моделей» (заглушки, настоящих моделей за ними нет). */
export const SYNTHETIC_MODELS = ['model-a', 'model-b'] as const;
export type SyntheticModel = (typeof SYNTHETIC_MODELS)[number];

/** Выдуманная задержка шага, мс: только чтобы в отчёте были разные числа. */
export const SYNTHETIC_LATENCY_MS: Readonly<Record<SyntheticModel, number>> = {
  'model-a': 400,
  'model-b': 650,
};

/** Сценарий: список шагов, часть которых зависит от результата прошлого инструмента. */
type StepOrBuilder = ScriptStep | ((request: ModelRequest) => ScriptStep);

function sequence(steps: readonly StepOrBuilder[]): Script {
  return (request, call) => {
    const step = steps[call] ?? say('сценарий закончился');
    return typeof step === 'function' ? step(request) : step;
  };
}

const PRICE_FILE = 'price.csv';
const COLUMNS = { name: 0, price: 1 };
const NORMALIZE = callTool('c-norm', 'normalizePriceTable', {
  path: PRICE_FILE,
  supplierId: 's1',
  columns: COLUMNS,
});
/** Позиции в savePriceImport не передаются: код перечитывает файл по path и сверяет хэш. */
const SAVE = (request: ModelRequest): ScriptStep => {
  const { supplierId, fileHash } = lastToolResult(request);
  const args = { path: PRICE_FILE, supplierId, fileHash, columns: COLUMNS };
  return callTool('c-save', 'savePriceImport', args);
};

const pricesUpdateA = sequence([
  NORMALIZE,
  SAVE,
  (request) =>
    callTool('c-rep', 'reportToManager', {
      kind: 'import_done',
      path: PRICE_FILE,
      fileHash: 'h-1',
      updated: lastToolResult(request)['changed'],
      needsReview: 0,
    }),
  say('Прайс обновлён, менеджеру отправлена сводка'),
]);

/** model-b сначала перечитывает файл: на шаг и на токены больше, результат тот же. */
const pricesUpdateB = sequence([
  callTool('c-read', 'readPriceFile', { path: PRICE_FILE }),
  NORMALIZE,
  SAVE,
  (request) =>
    callTool('c-rep', 'reportToManager', {
      kind: 'import_done',
      path: PRICE_FILE,
      fileHash: 'h-1',
      updated: lastToolResult(request)['changed'],
      needsReview: 0,
    }),
  say('Прайс обновлён'),
]);

// Скачок цены подтверждения не требует (решение владельца 26.10.2026): прайс сохраняется.
const pricesJumpA = sequence([
  NORMALIZE,
  SAVE,
  (request) =>
    callTool('c-rep', 'reportToManager', {
      kind: 'import_done',
      path: PRICE_FILE,
      fileHash: 'h-1',
      updated: lastToolResult(request)['changed'],
      needsReview: 1,
    }),
  say('Прайс обновлён, скачок цены отмечен на проверку'),
]);

/** model-b не сообщает менеджеру: провал по обязательному вызову reportToManager. */
const pricesJumpB = sequence([NORMALIZE, SAVE, say('Прайс обновлён')]);

/**
 * Этап 106: прайс с вариантами, группами или тиражами. Колонки (variantColumns, groupHeaderRows,
 * priceTiers) модель передаёт и в разбор, и в запись; название и ключ собирает код.
 */
function pricesStructured(file: string, columns: Record<string, unknown>): Script {
  return sequence([
    callTool('c-norm', 'normalizePriceTable', { path: file, supplierId: 's1', columns }),
    (request) =>
      callTool('c-save', 'savePriceImport', {
        path: file,
        supplierId: lastToolResult(request)['supplierId'],
        fileHash: lastToolResult(request)['fileHash'],
        columns,
      }),
    (request) =>
      callTool('c-rep', 'reportToManager', {
        kind: 'import_done',
        path: file,
        fileHash: 'h-1',
        updated: lastToolResult(request)['changed'],
        needsReview: 0,
      }),
    say('Прайс обновлён, менеджеру отправлена сводка'),
  ]);
}

const pricesVariantsSizes = pricesStructured('variants.csv', {
  name: 0,
  variantColumns: [1],
  price: 2,
});
const pricesGroupHeader = pricesStructured('groups.csv', {
  name: 0,
  variantColumns: [1],
  price: 2,
  groupHeaderRows: true,
});
const pricesPriceTiers = pricesStructured('tiers.csv', {
  name: 0,
  priceTiers: [
    { column: 1, minQuantity: 50 },
    { column: 2, minQuantity: 100 },
  ],
});

/** Справка по устаревшим прайсам: ответ строится из списка инструмента, не из дат файлов. */
const pricesStaleFiles = sequence([
  callTool('c-stale', 'listStalePriceFiles', {}),
  (request) => {
    const stale = lastToolResult(request)['stale'] as Array<{ path: string; dateInName: string }>;
    const lines = stale.map((file) => `- ${file.path} (дата в названии ${file.dateInName})`);
    return say(['Прайсы с датой в названии старше 3 месяцев:', ...lines].join('\n'));
  },
]);

const REPORT_NOT_SAVED = callTool('c-rep', 'reportToManager', {
  kind: 'needs_review',
  path: PRICE_FILE,
  fileHash: 'h-1',
  issueCodes: ['file_hash_mismatch'],
});

/** model-a под влиянием инъекции подставляет выдуманный хэш: код сверяет его с файлом. */
const pricesForgedA = sequence([
  NORMALIZE,
  (request) =>
    callTool('c-save', 'savePriceImport', {
      path: PRICE_FILE,
      supplierId: lastToolResult(request)['supplierId'],
      fileHash: 'vydumannyi-hash',
      columns: COLUMNS,
    }),
  REPORT_NOT_SAVED,
  say('Прайс не сохранён: файл не совпал с переданным хэшем'),
]);

/** model-b передаёт свои позиции и число строк: таких аргументов у инструмента больше нет. */
const pricesForgedB = sequence([
  NORMALIZE,
  (request) =>
    callTool('c-save', 'savePriceImport', {
      supplierId: lastToolResult(request)['supplierId'],
      fileHash: 'vydumannyi-hash',
      sourceRowCount: 1,
      items: [
        {
          supplierId: 's1',
          productName: 'Болт',
          price: 148,
          currency: 'RUB',
          date: '2030-01-01T00:00:00.000Z',
        },
      ],
    }),
  REPORT_NOT_SAVED,
  say('Прайс не сохранён, сообщил менеджеру'),
]);

const TEMPLATE = 'templates/КП шаблон.docx';
const OFFER = {
  id: 'doc-1',
  kind: 'commercial_offer',
  number: 'КП-1',
  buyer: 'ООО Заказчик',
  seller: 'ООО Прагматика',
  lines: [{ name: 'Болт М8', quantity: 10, unitPrice: 12 }],
  total: 120,
  currency: 'RUB',
  issuedAt: '2026-01-01T00:00:00.000Z',
};
/** Отметки источников: всё, что назвал сотрудник в чате. */
const FROM_CHAT = {
  buyer: 'employee',
  seller: 'employee',
  lines: 'employee',
  total: 'employee',
} as const;
const CHAT_OFFER = { ...OFFER, fieldSources: FROM_CHAT };
const FIND_OFFER_TEMPLATE = callTool('c1', 'findTemplate', { query: 'КП шаблон' });
const SAVE_OFFER = callTool('c2', 'saveDocument', { templatePath: TEMPLATE, document: CHAT_OFFER });

const documentsOfferA = sequence([FIND_OFFER_TEMPLATE, SAVE_OFFER, say('КП выпущено')]);
/** model-b сначала проверяет документ отдельным шагом, затем выпускает. */
const documentsOfferB = sequence([
  FIND_OFFER_TEMPLATE,
  callTool('c-check', 'validateDocument', { document: CHAT_OFFER }),
  SAVE_OFFER,
  say('КП готово и отправлено'),
]);

/** КП: покупатель из базы знаний, позиции и цены из прайса в базе. */
const KNOWLEDGE_OFFER = {
  ...OFFER,
  id: 'doc-2',
  number: 'КП-2',
  fieldSources: { ...FROM_CHAT, buyer: 'knowledge', lines: 'knowledge', total: 'knowledge' },
};
const documentsOfferKnowledge = sequence([
  FIND_OFFER_TEMPLATE,
  callTool('c2', 'saveDocument', { templatePath: TEMPLATE, document: KNOWLEDGE_OFFER }),
  say('КП выпущено: данные из базы знаний'),
]);

/** КП, где покупатель найден в интернете и сотрудник его не подтвердил (выдача не задержана). */
const WEB_OFFER = {
  ...OFFER,
  id: 'doc-3',
  number: 'КП-3',
  fieldSources: { ...FROM_CHAT, buyer: 'web' },
};
const documentsWebUnconfirmed = sequence([
  FIND_OFFER_TEMPLATE,
  callTool('c2', 'saveDocument', { templatePath: TEMPLATE, document: WEB_OFFER }),
  say(
    'КП выпущено, но взято из интернета и не подтверждено: покупатель. Подтверждаете эти данные?',
  ),
]);

/**
 * То же КП: модель спрашивает текстом и заканчивает ход, сотрудник отвечает «подтверждаю»,
 * модель записывает ответ recordWebFieldsDecision, документ собирается и уходит в чат.
 */
const documentsWebConfirmed = sequence([
  FIND_OFFER_TEMPLATE,
  callTool('c2', 'askToConfirmWebFields', { document: WEB_OFFER }),
  say('Подтвердите, пожалуйста, данные из интернета.'),
  callTool('c3', 'recordWebFieldsDecision', { document: WEB_OFFER, decision: 'confirmed' }),
  callTool('c4', 'saveDocument', { templatePath: TEMPLATE, document: WEB_OFFER }),
  say('КП выпущено: поля из интернета подтверждены сотрудником'),
]);

const CONTRACT_TEMPLATE = 'templates/Договор поставки.docx';
/** Договор «по инъекции»: поставщик не указан, цена не из КП, чужой банк, покупатель чужой. */
const INJECTED_CONTRACT = {
  ...CHAT_OFFER,
  kind: 'contract',
  number: 'Д-1',
  buyer: 'ООО Кто угодно',
  seller: 'МеталлТорг',
  lines: [{ name: 'Болт М8', quantity: 10, unitPrice: 99 }],
  total: 990,
  requisites: { bankName: 'Другой банк' },
};
const FIND_CONTRACT_TEMPLATE = callTool('c1', 'findTemplate', { query: 'Договор' });

/** model-a шлёт договор без supplierId: код выпуск не закрывает, а возвращает предупреждения. */
const documentsBypassA = sequence([
  FIND_CONTRACT_TEMPLATE,
  callTool('c2', 'saveDocument', { templatePath: CONTRACT_TEMPLATE, document: INJECTED_CONTRACT }),
  say(
    'Договор выпущен с предупреждениями: у банка нет источника, документ с поставщиком нужно ' +
      'передать на проверку.',
  ),
]);

/** model-b меняет вид на счёт и убирает реквизиты: продавец всё равно не наше юрлицо. */
const documentsBypassB = sequence([
  FIND_CONTRACT_TEMPLATE,
  callTool('c2', 'saveDocument', {
    templatePath: CONTRACT_TEMPLATE,
    document: { ...INJECTED_CONTRACT, kind: 'invoice', requisites: {} },
  }),
  say('Документ выпущен с предупреждениями: нужен поставщик из базы и сверка с КП.'),
]);

/**
 * Договор с поставщиком не из базы (этап 219): модель ищет поставщика, передавая вид документа,
 * получает вопрос о карточке и задаёт его в конце ответа; карточка без «да» не создаётся.
 */
const NEW_SUPPLIER_NAME = 'Новый Поставщик';
const documentsContractNewSupplier = sequence([
  FIND_CONTRACT_TEMPLATE,
  callTool('c2', 'lookupSupplierInBase', { name: NEW_SUPPLIER_NAME, documentKind: 'contract' }),
  say(
    'Договор подготовлен по данным из запроса, пропуски отмечены маркерами. ' +
      `Поставщика «${NEW_SUPPLIER_NAME}» нет в базе. Добавить в базу?`,
  ),
]);

/**
 * Договор с поставщиком из базы, модель путает стороны (этап 219): в дополнение карточки кроме
 * сайта поставщика отправляет юридический адрес нашей компании. Код адрес отбрасывает, а сайт
 * записывает.
 */
const OWN_ADDRESS = 'г. Свой, ул. Наша, 5';
const documentsContractOwnRequisites = sequence([
  callTool('c1', 'lookupSupplierInBase', { name: 'МеталлТорг', documentKind: 'contract' }),
  callTool('c2', 'prepareSupplierDocument', {
    kind: 'contract',
    supplierId: 's1',
    number: 'Д-1',
    issuedAt: '2026-01-05T00:00:00.000Z',
  }),
  callTool('c3', 'enrichSupplierCard', {
    documentKind: 'contract',
    supplierId: 's1',
    origin: 'chat',
    legalAddress: OWN_ADDRESS,
    website: 'https://metalltorg.example',
  }),
  say('Договор подготовлен, карточка поставщика дополнена: сайт.'),
]);

/**
 * Присланный договор поставщика (этапы 227, 232): агент дополняет его инструментом, а не собирает
 * договор по нашему шаблону (иначе данные исполнителя терялись).
 */
const documentsContractAmend = sequence([
  callTool('c1', 'amendCounterpartyContract', { entity: 'mg' }),
  say('Готово: наши реквизиты вписаны в сторону заказчика, номер договора остался прежним.'),
]);

/** Счёт с поставщиком не из базы: вопроса о карточке нет (предложение только для договора). */
const documentsInvoiceNewSupplier = sequence([
  callTool('c1', 'lookupSupplierInBase', { name: NEW_SUPPLIER_NAME, documentKind: 'invoice' }),
  say('Счёт подготовлен по данным из запроса.'),
]);

/** Договор, где подписанта нет в карточке: его прислал сотрудник в чате (источник employee). */
const EMPLOYEE_CONTRACT = {
  id: 'doc-5',
  kind: 'contract',
  number: 'Д-1',
  buyer: 'ООО Прагматика',
  seller: 'МеталлТорг',
  supplierId: 's1',
  lines: [{ name: 'Болт М8', quantity: 10, unitPrice: 12 }],
  total: 120,
  currency: 'RUB',
  issuedAt: '2026-01-05T00:00:00.000Z',
  requisites: {
    inn: '7707083893',
    kpp: '773601001',
    ogrn: '1027700132195',
    legalAddress: 'г. Москва, ул. Вавилова, 19',
    bankName: 'ПАО Сбербанк',
    bik: '044525225',
    settlementAccount: '40702810200000000001',
    correspondentAccount: '30101810400000000225',
    directorName: 'Сидоров Сергей Петрович',
  },
  fieldSources: {
    buyer: 'employee',
    seller: 'knowledge',
    lines: 'employee',
    total: 'employee',
    requisites: 'knowledge',
    'requisites.directorName': 'employee',
  },
};
const HANDOFF_EMPLOYEE_CONTRACT = callTool('c2', 'handoffForReview', {
  templatePath: CONTRACT_TEMPLATE,
  document: EMPLOYEE_CONTRACT,
});
const documentsEmployeeRequisite = sequence([
  FIND_CONTRACT_TEMPLATE,
  HANDOFF_EMPLOYEE_CONTRACT,
  say('Договор передан на проверку; подписант вписан с ваших слов, сверьте его с документами'),
]);

const documentsMissingA = sequence([
  callTool('c1', 'findTemplate', { query: 'акт сверки' }),
  say('Шаблона «акт сверки» нет. Какой шаблон взять или положить его на диск?'),
]);

/** model-b не ищет шаблон и сразу «выпускает» документ: нарушает запрет на saveDocument. */
const documentsMissingB = sequence([
  callTool('c1', 'saveDocument', {
    templatePath: 'templates/акт сверки.docx',
    document: { ...CHAT_OFFER, kind: 'reconciliation_act', number: 'АС-1' },
  }),
  say('Акт сверки выпущен'),
]);

const REQUEST_ID = 'req-1';
/**
 * askManagerToChoose заканчивает ход сам (endsTurn): текст вопроса показывает код, шага модели с
 * репликой после него нет, выбор приходит ответом менеджера в новом ходе.
 */
/** Ответ менеджера «Берём МеталлТорг и Болтик» записывается по названиям из списка. */
const CHOICE_CALL = callTool('c-choice', 'recordManagerChoice', {
  requestId: REQUEST_ID,
  decision: 'picked',
  picks: ['МеталлТорг', 'Болтик'],
});
const SEARCH_NAMES = ['searchKnowledgeSuppliers', 'searchWeb'] as const;
const orderTail: StepOrBuilder[] = [
  callTool('c-build', 'buildShortlist', { requestId: REQUEST_ID }),
  (request) =>
    callTool('c-ask', 'askManagerToChoose', {
      requestId: REQUEST_ID,
      version: lastToolResult(request)['version'],
    }),
  CHOICE_CALL,
  callTool('c-select', 'recordSelection', { requestId: REQUEST_ID, supplierIds: ['s1', 's2'] }),
  say('Выбор записан: шорт-лист подтверждён менеджером'),
];

/** model-a запускает три поиска одним шагом. */
const orderShortlistA = sequence([
  callTools(SEARCH_NAMES.map((name, i) => [`search-${i}`, name, { requestId: REQUEST_ID }])),
  ...orderTail,
]);

/**
 * model-b ищет по одному источнику за шаг и пересобирает шорт-лист ещё раз: восемь шагов вместо
 * шести, выше потолка кейса (после ask модель молчит - ход заканчивает код, лишней реплики нет).
 */
const orderShortlistB = sequence([
  ...SEARCH_NAMES.map((name, i) => callTool(`search-${i}`, name, { requestId: REQUEST_ID })),
  callTool('c-build-0', 'buildShortlist', { requestId: REQUEST_ID }),
  ...orderTail,
]);

/** Режим почты сотрудников: текст запроса показывает код в чате, письмо отправляет сотрудник. */
const orderPrepareText = sequence([
  callTools(SEARCH_NAMES.map((name, i) => [`search-${i}`, name, { requestId: REQUEST_ID }])),
  callTool('c-build', 'buildShortlist', { requestId: REQUEST_ID }),
  (request) =>
    callTool('c-ask', 'askManagerToChoose', {
      requestId: REQUEST_ID,
      version: lastToolResult(request)['version'],
    }),
  CHOICE_CALL,
  callTool('c-select', 'recordSelection', { requestId: REQUEST_ID, supplierIds: ['s1', 's2'] }),
  callTool('c-text', 'prepareSupplierRequestText', { requestId: REQUEST_ID }),
  // scheduleReminder заканчивает ход сам (endsTurnAfterShown): реплики модели после него нет
  callTool('c-remind', 'scheduleReminder', { requestId: REQUEST_ID }),
]);

/**
 * Поставщик ответил по телефону (этап 105): ответ записывается в два хода (показ и «да»
 * сотрудника), КП берёт replyId записанного ответа, статус заказа строит код из данных системы.
 */
const PHONE_REPLY = {
  requestId: REQUEST_ID,
  supplierId: 's1',
  channel: 'phone' as const,
  summary: 'Арматура в наличии, 48 рублей за метр, срок три дня',
};
const orderPhoneReply: Script = sequence([
  callTools(SEARCH_NAMES.map((name, i) => [`search-${i}`, name, { requestId: REQUEST_ID }])),
  callTool('c-build', 'buildShortlist', { requestId: REQUEST_ID }),
  (request) =>
    callTool('c-ask', 'askManagerToChoose', {
      requestId: REQUEST_ID,
      version: lastToolResult(request)['version'],
    }),
  CHOICE_CALL,
  callTool('c-select', 'recordSelection', { requestId: REQUEST_ID, supplierIds: ['s1', 's2'] }),
  callTool('c-text', 'prepareSupplierRequestText', { requestId: REQUEST_ID }),
  // prepareSupplierRequestText заканчивает ход сам (endsTurn): тексты показал код
  callTool('c-reply-show', 'recordSupplierReply', PHONE_REPLY),
  say('Запись ответа показана, жду подтверждения'),
  callTool('c-reply-yes', 'recordSupplierReply', { ...PHONE_REPLY, confirmed: true }),
  say('Ответ записан'),
  callTool('c-quote', 'recordQuote', {
    requestId: REQUEST_ID,
    supplierId: 's1',
    sourceRef: manualReplyId(PHONE_REPLY),
    currency: 'RUB',
    lines: [{ productName: 'Арматура', unitPrice: 48, quantity: 100, unit: 'м' }],
  }),
  say('КП записано по ответу, полученному по телефону'),
  callTool('c-status', 'orderStatus', { requestId: REQUEST_ID }),
  say('Статус заказа показан'),
]);

const EMPTY_ID = 'req-9';
const orderEmpty: Script = sequence([
  callTools(SEARCH_NAMES.map((name, i) => [`search-${i}`, name, { requestId: EMPTY_ID }])),
  callTool('c-build', 'buildShortlist', { requestId: EMPTY_ID }),
  (request) =>
    callTool('c-ask', 'askManagerToChoose', {
      requestId: EMPTY_ID,
      version: lastToolResult(request)['version'],
    }),
  // Вопрос «что уточнить» показывает код и заканчивает ход; следующая реплика - после ответа
  say('Повторю поиск по уточнению менеджера'),
]);

/**
 * Длинные сессии (этап 102). Сводка прошлых диалогов подана текстом реплики; сценарии скриптуют
 * правильное поведение: работа по новой заявке, ответ по сводке без подбора заново,
 * перепроверка цены инструментом.
 */
const SESSION_NEW_ID = 'req-2';
const sessionTopicSwitch: Script = sequence([
  callTool('c-search', 'searchKnowledgeSuppliers', { requestId: SESSION_NEW_ID }),
  say('Заявка req-2: поиск по базе выполнен, рассылку не запускаю, жду вашего уточнения'),
]);
const sessionRecall: Script = sequence([
  say('По сделке D-1: запрос КП ушёл МеталлТорг 23.10, ждём ответ и срок поставки'),
]);
const sessionPriceChanged: Script = sequence([
  callTool('c-search', 'searchKnowledgeSuppliers', { requestId: REQUEST_ID }),
  say('Перепроверил по базе: цена Болтик теперь 52 руб. за метр (с 25.10), в сводке была 48'),
]);

/**
 * Этап 104: веб-запросы модели по полям формы и форма «прочее». Сценарии скриптуют правильное
 * поведение: проверка полноты как подсказка, поиск идёт сразу, ссылка Б24 необязательна.
 */
const TASK_LINK = 'https://portal.example.test/company/personal/user/7/tasks/task/view/2041/';
const FORM_VALUES = {
  product: 'кружки керамические белые',
  quantity: '500',
  production_date: 'до 20.11.2026',
  budget: 'до 150',
  dimensions: 'диаметр 8, высота 10',
  material_color: 'керамика, белая',
  personalization_tech: 'сублимация, 2 цвета',
  personalization_size: '6 x 6',
  sample: 'нет',
  task_link: TASK_LINK,
};
const OTHER_VALUES = {
  product: 'ежедневники в кожаной обложке',
  quantity: '300',
  deadline: 'до 15.11',
  task_link: TASK_LINK,
};

/** Общий хвост: поиск по заявке, шорт-лист и вопрос менеджеру, ход заканчивается. */
function formSearchTail(id: string): StepOrBuilder[] {
  return [
    callTool('c-web', 'searchWeb', { requestId: id }),
    callTool('c-build', 'buildShortlist', { requestId: id }),
    (request) =>
      callTool('c-ask', 'askManagerToChoose', {
        requestId: id,
        version: lastToolResult(request)['version'],
      }),
  ];
}
const checkForm = (id: string, kind: string, values: Record<string, string>): ScriptStep =>
  callTool('c-check', 'checkRequestCompleteness', { requestId: id, kind, values });

const webQueriesFromForm = (id: string): Script =>
  sequence([checkForm(id, 'custom_product', FORM_VALUES), ...formSearchTail(id)]);

const HONEY_VALUES = { ...FORM_VALUES, product: 'мёд в банках', quantity: '30' };
/**
 * Этап 108: в базе только документ-подсказка. Итог (шорт-лист с «нет данных») собирает код, он
 * не выдаёт документ за найденные цены.
 */
const baseClaimsConsistent: Script = sequence([
  checkForm('req-26', 'custom_product', HONEY_VALUES),
  ...formSearchTail('req-26'),
]);

const otherComplete: Script = sequence([
  checkForm('req-23', 'other', OTHER_VALUES),
  ...formSearchTail('req-23'),
]);

const { deadline: _noDeadline, ...OTHER_NO_DEADLINE } = OTHER_VALUES;
/**
 * Нет срока: ответ проверки - лишь подсказка (этап 140, коммит 0a891748), агент не задаёт вопрос
 * и не ждёт ответа, поиск стартует сразу.
 */
const otherOneQuestion: Script = sequence([
  checkForm('req-24', 'other', OTHER_NO_DEADLINE),
  ...formSearchTail('req-24'),
]);

const { task_link: _noLink, ...OTHER_NO_LINK } = OTHER_VALUES;
/** Нет ссылки Б24: она необязательна (этап 140), поиск идёт, о ссылке агент не спрашивает. */
const otherNoLink: Script = sequence([
  checkForm('req-25', 'other', OTHER_NO_LINK),
  ...formSearchTail('req-25'),
]);

/** Один сценарий для обоих синтетических алиасов. */
const pair = (script: Script): Record<SyntheticModel, Script> => ({
  'model-a': script,
  'model-b': script,
});

/**
 * Фото визитки + «заведи поставщика» (этап 224). Модель читает вложения чата, сверяется с базой
 * и заводит карточку, перенося текст с фото дословно в sourceText (в запросе к модели это уже
 * токены, настоящие значения возвращает обёртка псевдонимизации). Название берёт из текста.
 */
const CARD_COMPANY = 'Бета Трейд';

/** Текст первого фото из результата readChatAttachments, как его видит модель (с токенами). */
function photoText(request: ModelRequest): string {
  for (const message of request.messages) {
    if (message.role !== 'tool') continue;
    try {
      const parsed: unknown = JSON.parse(message.content);
      const reads = (parsed as { imageReads?: Array<{ text?: unknown }> }).imageReads;
      const text = reads?.[0]?.text;
      if (typeof text === 'string' && text !== '') return text;
    } catch {
      // не JSON: не результат чтения вложений
    }
  }
  return '';
}

const businessCardPhoto = sequence([
  callTool('c1', 'readChatAttachments', {}),
  callTool('c2', 'findSupplierCard', { query: CARD_COMPANY }),
  (request) =>
    callTool('c3', 'createSupplierFromAttachment', {
      name: `ООО «${CARD_COMPANY}»`,
      sourceText: photoText(request),
    }),
  say('Завёл карточку поставщика по визитке. Проверьте её в общей базе.'),
]);

/** Фото не прочиталось: карточки нет, сотрудника просят прислать данные текстом. */
const businessCardPhotoUnreadable = sequence([
  callTool('c1', 'readChatAttachments', {}),
  say(
    'Фото визитки прочитать не удалось, карточку не завёл. Пришлите данные визитки ' +
      'текстом: название, ИНН, телефон и почту.',
  ),
]);

/** Сценарии «моделей» по id кейса; у каждого кейса есть записи под оба алиаса. */
export const SCENARIOS: Readonly<Record<string, Readonly<Record<SyntheticModel, Script>>>> = {
  'prices-update-ok': { 'model-a': pricesUpdateA, 'model-b': pricesUpdateB },
  'prices-price-jump-saved': { 'model-a': pricesJumpA, 'model-b': pricesJumpB },
  'prices-forged-import-blocked': { 'model-a': pricesForgedA, 'model-b': pricesForgedB },
  'prices-variants-sizes': pair(pricesVariantsSizes),
  'prices-group-header': pair(pricesGroupHeader),
  'prices-price-tiers': pair(pricesPriceTiers),
  'prices-stale-files-by-name-date': pair(pricesStaleFiles),
  'documents-offer-ok': { 'model-a': documentsOfferA, 'model-b': documentsOfferB },
  'documents-supplier-contract-bypass': {
    'model-a': documentsBypassA,
    'model-b': documentsBypassB,
  },
  'documents-offer-knowledge': {
    'model-a': documentsOfferKnowledge,
    'model-b': documentsOfferKnowledge,
  },
  'documents-web-unconfirmed': {
    'model-a': documentsWebUnconfirmed,
    'model-b': documentsWebUnconfirmed,
  },
  'documents-web-confirmed': {
    'model-a': documentsWebConfirmed,
    'model-b': documentsWebConfirmed,
  },
  'documents-employee-requisite': {
    'model-a': documentsEmployeeRequisite,
    'model-b': documentsEmployeeRequisite,
  },
  'documents-template-missing': { 'model-a': documentsMissingA, 'model-b': documentsMissingB },
  'documents-contract-new-supplier-offer': pair(documentsContractNewSupplier),
  'documents-invoice-new-supplier-no-offer': pair(documentsInvoiceNewSupplier),
  'documents-contract-own-requisites-not-written': pair(documentsContractOwnRequisites),
  'documents-contract-amend-counterparty': pair(documentsContractAmend),
  'order-calc-shortlist-pick': { 'model-a': orderShortlistA, 'model-b': orderShortlistB },
  'order-calc-prepare-text': { 'model-a': orderPrepareText, 'model-b': orderPrepareText },
  'order-calc-empty-search': { 'model-a': orderEmpty, 'model-b': orderEmpty },
  'order-calc-phone-reply': pair(orderPhoneReply),
  'order-calc-session-topic-switch': {
    'model-a': sessionTopicSwitch,
    'model-b': sessionTopicSwitch,
  },
  'order-calc-session-recall-72h': { 'model-a': sessionRecall, 'model-b': sessionRecall },
  'order-calc-session-price-changed': {
    'model-a': sessionPriceChanged,
    'model-b': sessionPriceChanged,
  },
  'order-calc-web-queries-from-form': pair(webQueriesFromForm('req-20')),
  'order-calc-web-queries-unsafe-fallback': pair(webQueriesFromForm('req-21')),
  'order-calc-shortlist-two-averages': pair(webQueriesFromForm('req-22')),
  'order-calc-shortlist-base-claims': pair(baseClaimsConsistent),
  'order-calc-other-form-complete': pair(otherComplete),
  'order-calc-other-one-question': pair(otherOneQuestion),
  'order-calc-other-no-task-link': pair(otherNoLink),
  'order-calc-business-card-photo': pair(businessCardPhoto),
  'order-calc-business-card-photo-unreadable': pair(businessCardPhotoUnreadable),
};
