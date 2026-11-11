import {
  FileShareGuard,
  LocalFileSource,
  StaffEmployeeIdentity,
  VisionTableDocumentParser,
  HttpDocumentParser,
  HttpTemplateWorkbook,
  turnScope,
} from '@business-ai/adapters';
import {
  WebSearchLimiter,
  createDurableSteps,
  isValidBotId,
  type FileSource,
  type ProjectAgents,
  type ProjectContext,
} from '@business-ai/core';
import { ORDER_CALC_AGENT_ID } from '../agents/order-calc';
import { createOrderCalcAgent } from '../agents/order-calc/declaration';
import type { OrderCalcDeps } from '../agents/order-calc';
import { createDocumentsAgent } from '../agents/documents/declaration';
import { DOCUMENTS_AGENT_ID, type DocumentsDeps } from '../agents/documents/deps';
import { ownRequisitesFromRepository } from '../agents/documents/own-requisites';
import { PRICES_AGENT_ID, type PricesDeps } from '../agents/prices/deps';
import { createPricesAgent } from '../agents/prices/declaration';
import { createSiteExportAgent } from '../agents/site-export/declaration';
import { PLACEHOLDER_EXPORT_TEMPLATE } from '../agents/site-export/default-template';
import { SITE_EXPORT_AGENT_ID, type SiteExportDeps } from '../agents/site-export/deps';
import { createSupplierCardService } from '../agents/suppliers/card-approval';
import type { SupplierCardsDeps } from '../agents/suppliers/deps';
import type { SupplierCardsAgentOptions } from '../agents/suppliers/tools';
import type { SupplierMailProposalsDeps } from '../agents/suppliers/mail-proposal-store';
import { buildBackgroundCommands } from '../background-wiring';
import { HttpSignatoryInflector } from '../adapters/http-signatory-inflector';
import { dealRequestsOf } from '../adapters/deal-request-ports';
import { PlatformBackedCrm } from '../adapters/platform-crm';
import { assertCrossChecks, type PragmatikaConfig } from '../config';
import { restoreLegacyTools } from '../legacy-tools';
import { HttpContractAmender } from '../kit/adapters/http/http-contract-amender';
import { HttpPriceFileEditor } from '../kit/adapters/http/http-price-file-editor';
import {
  ModelSupplierMailClassifier,
} from '../kit/adapters/litellm/supplier-mail-model-classifier';
import {
  DEFAULT_PRICE_STALE_EXCLUDE_PATTERN as DEFAULT_STALE_EXCLUDE,
} from '../kit/domain/price-stale-scope';
import { pragmatikaPortsOf } from '../ports';
import {
  setPragmatikaRuntime,
  type MailProposalsRuntime,
  type SupplierCardsRuntime,
} from '../runtime';
import { attachModelAdapters } from './model-adapters';
import { projectModels } from './project-models';
import { supplierTemplateLoader } from './supplier-template-loader';

/** Контекст сборки Прагматики (типизирован предметными переменными проекта). */
type Context = ProjectContext<PragmatikaConfig>;

/** Миллисекунд в минуте: окно лимита поиска на сотрудника задаётся в минутах. */
const MS_PER_MINUTE = 60_000;

/** Источники файлов: прайсы/диск К и шаблоны, под одним сторожем шары. */
interface ProjectFiles {
  prices: FileSource;
  templates: FileSource;
}

/** Файлы Прагматики: два корня, лимит параллелизма и выключатель шары общие (как раньше). */
function buildFiles(ctx: Context): ProjectFiles {
  const guard = new FileShareGuard();
  const common = { stableSeconds: ctx.config.files.stableSeconds, guard };
  return {
    prices: new LocalFileSource({ root: ctx.project.PRICES_FILES_ROOT, ...common }),
    templates: new LocalFileSource({ root: ctx.project.TEMPLATES_FILES_ROOT, ...common }),
  };
}

/** Бот агента для адресата подтверждений: единственный бот агента в `CHAT_BOTS`. */
function botOf(ctx: Context, agentId: string): string | undefined {
  const bots = Object.entries(ctx.config.service.chatBots ?? {}).filter(([, id]) => id === agentId);
  const [only] = bots;
  return bots.length === 1 && only !== undefined ? only[0] : undefined;
}

/** Тред оператора: прежний `MANAGER_THREAD_ID`, иначе `OWNER_THREAD_ID` платформы. */
export function managerThreadOf(ctx: Context): string {
  return ctx.project.MANAGER_THREAD_ID ?? ctx.config.agents.ownerThreadId;
}

/**
 * Собрать зависимости и декларации четырёх агентов Прагматики из контекста сборки. Условия
 * подключения инструментов (флаги и порты) те же, что были в `composeProduction` до манифеста.
 */
export function assemblePragmatikaAgents(ctx: Context): ProjectAgents {
  const { config, project, services, ports: external } = ctx;
  assertCrossChecks(project, { employeeMailboxEnabled: config.agents.employeeMailboxEnabled });
  const own = pragmatikaPortsOf(external.extra);
  const files = buildFiles(ctx);
  const { clock, state, chat } = services;
  const managerThreadId = managerThreadOf(ctx);
  const secret = config.pseudonymizer.apiToken;
  if (secret === undefined) throw new Error('Не задан PSEUDONYMIZER_API_TOKEN');
  // Поиск общий на процесс; лимит за ход берётся из WEB_SEARCH_MAX_PER_TURN.
  const webSearchLimiter = new WebSearchLimiter({
    clock,
    maxPerTurn: project.WEB_SEARCH_MAX_PER_TURN,
    userMaxPerWindow: config.agents.webSearchUserMaxPerWindow,
    userWindowMs: config.agents.webSearchUserWindowMinutes * MS_PER_MINUTE,
  });
  // Прайсы-картинки и сканы читает зрение (режим table), дальше обычный разбор таблиц.
  const parser =
    services.parser instanceof HttpDocumentParser
      ? new VisionTableDocumentParser(services.parser, services.imageReader)
      : services.parser;
  const shared = { tableExporter: services.tableExporter, intake: services.intake };
  const prices: PricesDeps = {
    files: files.prices,
    fileRefSecret: secret,
    parser,
    // Общий разбор прайса не привязан к ходу, который начал его первым.
    turnScope,
    prices: own.prices,
    staging: own.staging,
    suppliers: own.suppliers,
    chat,
    clock,
    managerThreadId,
    state,
    ...(project.PRICE_RESPONSIBLE_THREAD_ID === undefined
      ? {}
      : { responsibleThreadId: project.PRICE_RESPONSIBLE_THREAD_ID }),
    // Правка цен в копии исходного прайса; результат большого файла пишется на диск (спул).
    priceFileEditor: new HttpPriceFileEditor({
      spool: services.fileSpool,
      ...(services.documentsResultVolume === undefined
        ? {}
        : { resultVolume: services.documentsResultVolume }),
      baseUrl: config.documents.baseUrl,
      timeoutMs: config.documents.renderTimeoutMs,
      telemetry: services.telemetry,
    }),
    ...shared,
  };
  const documents = buildDocumentsDeps(ctx, own, files, shared);
  const orderCalc: OrderCalcDeps = {
    requests: own.requests,
    suppliers: own.suppliers,
    prices: own.prices,
    knowledge: own.knowledge,
    web: services.webSearch,
    webSearchLimiter,
    webFetchLimiter: services.webFetchLimiter,
    webUrlReadLimiter: services.webUrlReadLimiter,
    ...(services.webPageReader === undefined ? {} : { webPageReader: services.webPageReader }),
    scheduler: services.scheduler,
    chat,
    clock,
    state,
    quotes: own.quotes,
    managerThreadId,
    parser,
    shortlistAttachEnabled: project.SHORTLIST_ATTACH_ENABLED === 'true',
    shortlistXlsxEnabled: project.SHORTLIST_XLSX_ENABLED === 'true',
    senderTrust: services.mailSenderTrust,
    ...shared,
  };
  const siteExport: SiteExportDeps = {
    prices: own.prices,
    knowledge: own.knowledge,
    state,
    // Формат выгрузки заказчика порт платформы не даёт: временный шаблон и строка в сводке.
    template: PLACEHOLDER_EXPORT_TEMPLATE,
    chat,
    managerThreadId,
    web: services.webSearch,
    webSearchLimiter,
    webSearchQueryPiiAllowed: services.webSearchQueryPiiAllowed,
    suppliers: own.suppliers,
    clock,
    // Значения нашей компании не попадают в карточки поставщиков при дополнении из документа.
    ownCompanyNames: project.OWN_COMPANY_NAMES,
    ownCompanyRequisites: project.OWN_COMPANY_REQUISITES ?? [],
    ownEntities: own.ownLegalEntities,
    ...shared,
    ...(services.mailboxes === undefined ? {} : { mailboxes: services.mailboxes }),
  };
  ctx.markUnconfigured('exportTemplate');
  const botFileAgentIds = wireOrderIntake(ctx, orderCalc, documents, siteExport);
  wireWebAndMail(ctx, { prices, documents, orderCalc, siteExport }, webSearchLimiter);
  wireSiteExport(ctx, siteExport, files);
  wirePrices(ctx, prices);
  const mailConnected = isMailConnected(ctx);
  const yandexReady =
    config.yandexSearch?.apiKey !== undefined && config.yandexSearch.folderId !== undefined;
  attachModelAdapters({
    models: modelsOf(ctx),
    config,
    services,
    ports: own,
    modelOf: ctx.modelOf,
    mailConnected,
    yandexReady,
    prices,
    orderCalc,
    siteExport,
  });
  const { supplierCards, cardsOption } = wireSupplierCards(ctx, own, {
    prices,
    documents,
    orderCalc,
    siteExport,
  });
  const proposals = wireMailProposals(ctx, orderCalc, mailConnected);
  wireAccessAndHandoff(ctx, { prices, documents, orderCalc }, supplierCards?.deps, proposals);
  wireCommon(ctx, [prices, documents, orderCalc, siteExport], parser);
  if (supplierCards !== undefined) {
    // Дополнение карточки из документа: общие значения читает тот же разбор.
    supplierCards.deps.parser = parser;
  }
  setPragmatikaRuntime({
    clock,
    state,
    orderCalc,
    prices,
    timezone: project.BUSINESS_TIMEZONE,
    orderDigestOpenMaxDays: project.ORDER_DIGEST_OPEN_MAX_DAYS,
    monitoringEnabled: config.agents.monitoringEnabled,
    priceDiskSyncEnabled: project.PRICE_DISK_SYNC_ENABLED === 'true',
    priceDiskInitialImportEnabled: project.PRICE_DISK_INITIAL_IMPORT_ENABLED === 'true',
    supplierCards,
    mailProposals: proposals,
    // Разовые команды владельца (проход по ящику, обследование, CRM); модель - при вызове.
    background: buildBackgroundCommands(ctx, {
      mailConnected,
      classifier: () =>
        new ModelSupplierMailClassifier(modelsOf(ctx), ctx.modelOf(PRICES_AGENT_ID)),
    }),
  });
  return {
    declarations: declarationsOf(ctx, cardsOption, proposals !== undefined),
    deps: {
      [PRICES_AGENT_ID]: prices,
      [DOCUMENTS_AGENT_ID]: documents,
      [ORDER_CALC_AGENT_ID]: orderCalc,
      [SITE_EXPORT_AGENT_ID]: siteExport,
    },
    botFileAgentIds,
  };
}

/** Порты проекта, нужные частям сборки. */
type OwnPorts = ReturnType<typeof pragmatikaPortsOf>;

/** Зависимости агента «Подготовка документов». */
function buildDocumentsDeps(
  ctx: Context,
  own: OwnPorts,
  files: ProjectFiles,
  shared: { tableExporter: PricesDeps['tableExporter']; intake: PricesDeps['intake'] },
): DocumentsDeps {
  const { config, project, services } = ctx;
  // Дополнение присланного договора и сверка печатного блока шаблона читают один клиент.
  const amend =
    project.DOCUMENTS_COUNTERPARTY_AMEND_ENABLED === 'true' ||
    project.OWN_REQUISITES_DB_ENABLED === 'true';
  return {
    files: files.templates,
    // Диск К - второй корень поиска реестра договоров (только чтение).
    registryFiles: files.prices,
    ...(project.CONTRACT_REGISTRY_PATH === undefined
      ? {}
      : { contractRegistryPath: project.CONTRACT_REGISTRY_PATH }),
    knowledge: own.knowledge,
    renderer: services.renderer,
    suppliers: own.suppliers,
    chat: services.chat,
    ownCompanyNames: project.OWN_COMPANY_NAMES,
    ownCompanyRequisites: project.OWN_COMPANY_REQUISITES ?? [],
    ...(project.TEMPLATES_PREFIX === undefined
      ? {}
      : { templatesPrefix: project.TEMPLATES_PREFIX }),
    ...(config.files.templateAllowlist === undefined
      ? {}
      : { templateAllowlist: config.files.templateAllowlist }),
    quotes: own.quotes,
    state: services.state,
    clock: services.clock,
    // Номер договора присваивает база: счётчик по (юрлицо, год).
    contractNumbering: own.contractNumbering,
    enabledKinds: project.DOCUMENTS_ENABLED_KINDS,
    ...(amend
      ? {
          contractAmender: new HttpContractAmender({
            baseUrl: config.documents.baseUrl,
            timeoutMs: project.DOCUMENTS_CONTRACT_TIMEOUT_MS,
            telemetry: services.telemetry,
          }),
        }
      : {}),
    // Фильтр «наших реквизитов» читает записи всегда, источник для договоров - под флагом.
    ownEntities: own.ownLegalEntities,
    ...(project.OWN_REQUISITES_DB_ENABLED === 'true'
      ? { ownRequisites: ownRequisitesFromRepository(own.ownLegalEntities) }
      : {}),
    // Подписант в родительном падеже склоняет псевдонимизатор по настоящему ФИО.
    signatoryInflector: new HttpSignatoryInflector({
      baseUrl: config.pseudonymizer.baseUrl,
      timeoutMs: config.pseudonymizer.timeoutMs,
      apiToken: config.pseudonymizer.apiToken,
    }),
    ...shared,
  };
}

/**
 * Приём заявки и файлы чата. Возвращает агентов, чьи файлы читает `readChatAttachments`.
 * Сделки, задачи и ссылки работают, если настроен портал (иначе только текст).
 */
function wireOrderIntake(
  ctx: Context,
  orderCalc: OrderCalcDeps,
  documents: DocumentsDeps,
  siteExport: SiteExportDeps,
): string[] {
  const { project, services, ports } = ctx;
  const maxChars = ctx.config.bitrix24?.attachments?.maxChars;
  const ids: string[] = [];
  const withFiles = (deps: DocumentsDeps | SiteExportDeps | OrderCalcDeps, id: string): void => {
    if (ports.attachments === undefined || services.botFiles === undefined) return;
    deps.attachments = ports.attachments;
    deps.botFiles = services.botFiles;
    if (maxChars !== undefined) deps.attachmentMaxChars = maxChars;
    deps.imageReader = services.imageReader;
    // Сотрудники шлют файлы без расширения или с чужим: «Документы» и сайт берут формат по
    // содержимому (у заявки так не было).
    if (id !== ORDER_CALC_AGENT_ID) {
      (deps as DocumentsDeps | SiteExportDeps).sniffAttachmentFormat = true;
    }
    ids.push(id);
  };
  if (project.ORDER_CALC_INTAKE_ENABLED === 'true') {
    // Разбор заявки по сделке (карта полей) даёт проектный читатель на клиенте портала платформы.
    orderCalc.crm = new PlatformBackedCrm(ports.crm, dealRequestsOf(ports.extra));
    if (ports.tasks === undefined || ports.portalLinks === undefined) {
      ctx.markUnconfigured('portalIntake');
    } else {
      orderCalc.tasks = ports.tasks;
      orderCalc.links = ports.portalLinks;
      withFiles(orderCalc, ORDER_CALC_AGENT_ID);
    }
  }
  // «Документы» и «Актуализация сайта» читают файлы чата независимо от приёма заявок.
  withFiles(documents, DOCUMENTS_AGENT_ID);
  withFiles(siteExport, SITE_EXPORT_AGENT_ID);
  return ids;
}

/** Веб-поиск, аудит, журналы и почта для четырёх агентов. */
function wireWebAndMail(
  ctx: Context,
  deps: {
    prices: PricesDeps;
    documents: DocumentsDeps;
    orderCalc: OrderCalcDeps;
    siteExport: SiteExportDeps;
  },
  limiter: WebSearchLimiter,
): void {
  const { services, project, config } = ctx;
  const { prices, documents, orderCalc, siteExport } = deps;
  for (const host of [prices, documents, orderCalc, siteExport]) {
    host.web = services.webSearch;
    host.webSearchLimiter = limiter;
    host.webSearchQueryPiiAllowed = services.webSearchQueryPiiAllowed;
    host.webSearchLimitWarnings = services.webSearchLimitWarnings;
    // Аудит веб-поиска (запрос, число поисков, домены, стоимость) и журнал отмен.
    host.webSearchAudit = services.audit;
    host.webSearchLog = services.log;
  }
  orderCalc.log = services.log;
  prices.log = services.log;
  documents.log = services.log;
  siteExport.log = services.log;
  // Журнал изменения наших реквизитов (кто, когда, какие поля).
  documents.audit = services.audit;
  // Ответ на утреннее напоминание: пояс тот же, что у сводки; без сводки отвечать не на что.
  if (project.ORDER_REMINDER_REPLY_ENABLED === 'true' && config.agents.monitoringEnabled) {
    orderCalc.reminderReply = { timezone: project.BUSINESS_TIMEZONE };
  }
  const mailboxes = services.mailboxes;
  if (mailboxes !== undefined) {
    orderCalc.mailboxes = mailboxes;
    prices.mailboxes = mailboxes;
    prices.mailboxOwnerUserId = project.PRICES_MAILBOX_OWNER_USER_ID;
    // Тред для сотрудника, не писавшего боту, строится по id: нужен ключ бота прайсов.
    prices.botId = botOf(ctx, PRICES_AGENT_ID);
  }
}

/** Шаблон заказчика сайта: порт книги xlsx, диск шаблонов (чтение) и личность сотрудника. */
function wireSiteExport(ctx: Context, siteExport: SiteExportDeps, files: ProjectFiles): void {
  const { config, project, services, ports } = ctx;
  siteExport.workbook =
    services.templateWorkbook ??
    new HttpTemplateWorkbook({
      baseUrl: config.documents.baseUrl,
      timeoutMs: config.documents.parseTimeoutMs,
      telemetry: services.telemetry,
    });
  siteExport.templateFiles = files.templates;
  if (project.SITE_TEMPLATE_PATH !== undefined) {
    siteExport.siteTemplatePath = project.SITE_TEMPLATE_PATH;
  }
  siteExport.businessTimeZone = project.BUSINESS_TIMEZONE;
  if (ports.staff !== undefined) {
    siteExport.employeeIdentity = new StaffEmployeeIdentity({
      staff: ports.staff,
      clock: services.clock,
    });
  }
}

/** Адресная недельная сводка, область проверки устаревших прайсов, получатели. */
function wirePrices(ctx: Context, prices: PricesDeps): void {
  const { project, services, ports } = ctx;
  prices.businessTimeZone = project.BUSINESS_TIMEZONE;
  prices.supplierAttachmentMaxPerRun = project.PRICE_MAIL_SUPPLIER_ATTACHMENT_MAX_PER_RUN;
  prices.visionEnabled = ctx.config.vision.enabled;
  prices.senderTrust = services.mailSenderTrust;
  const departments = project.PRICE_STAFF_DEPARTMENT ?? [];
  const extraIds = project.PRICE_STAFF_EXTRA_USER_IDS ?? [];
  if (departments.length > 0 || extraIds.length > 0) {
    if (ports.staff === undefined) {
      ctx.markUnconfigured('staffDirectory');
    } else {
      prices.staff = ports.staff;
      if (departments.length > 0) prices.staffDepartmentIds = departments;
      if (extraIds.length > 0) prices.staffExtraUserIds = new Set(extraIds);
      prices.authorship = services.authorship;
    }
  }
  // Бот пишет первым не открывавшему диалог - только по флагу.
  if (project.PRICE_RECIPIENT_OPEN_THREAD === 'true') {
    prices.botId ??= botOf(ctx, PRICES_AGENT_ID);
    if (prices.botId !== undefined && isValidBotId(prices.botId)) {
      prices.recipientOpenThread = true;
    } else {
      ctx.markUnconfigured('priceOpenThreadBot');
    }
  }
  const excluded = project.PRICE_RECIPIENT_EXCLUDE_IDS ?? [];
  if (excluded.length > 0) prices.recipientExcludeUserIds = new Set(excluded);
  const prefixes = project.PRICE_STALE_SCAN_PREFIXES ?? [];
  const contentCheck = project.PRICE_STALE_CONTENT_CHECK === 'true';
  // Шаблон исключения по умолчанию действует, только если задана область или проверка текста.
  const excludePattern =
    project.PRICE_STALE_EXCLUDE_PATTERN ??
    (prefixes.length > 0 || contentCheck ? DEFAULT_STALE_EXCLUDE : undefined);
  if (prefixes.length > 0 || excludePattern !== undefined) {
    prices.staleScan = { prefixes, excludePattern };
  }
  if (contentCheck) prices.priceTables = pragmatikaPortsOf(ctx.ports.extra).priceTables;
}

/** Почта подключена по-настоящему: ящики снаружи или настроенный адаптер, не заглушка. */
function isMailConnected(ctx: Context): boolean {
  const { config, ports } = ctx;
  return (
    config.agents.employeeMailboxEnabled &&
    (ports.mailboxes !== undefined || config.mail !== undefined)
  );
}

/** Шлюз модели для вызовов вне агентского цикла: один на сборку (платформа его не отдаёт). */
function modelsOf(ctx: Context): ReturnType<typeof projectModels> {
  return projectModels({
    config: ctx.config,
    services: ctx.services,
    alertThreadId: managerThreadOf(ctx),
  });
}

/** Карточки поставщиков: общий набор зависимостей модуля, сервис нажатий и шаблон-файл. */
function wireSupplierCards(
  ctx: Context,
  own: OwnPorts,
  deps: {
    prices: PricesDeps;
    documents: DocumentsDeps;
    orderCalc: OrderCalcDeps;
    siteExport: SiteExportDeps;
  },
): {
  supplierCards: SupplierCardsRuntime | undefined;
  cardsOption: { supplierCards?: SupplierCardsAgentOptions };
} {
  const { config, project, services } = ctx;
  if (project.SUPPLIER_CARDS_ENABLED !== 'true') {
    return { supplierCards: undefined, cardsOption: {} };
  }
  const cardsDeps: SupplierCardsDeps = {
    suppliers: own.suppliers,
    chat: services.chat,
    clock: services.clock,
    state: services.state,
    pairNotes: services.pairNotes ?? own.pairNotes,
    audit: services.audit,
    // Цены нужны инструментам карточек (перенос и сверка прайса).
    prices: own.prices,
    parser: deps.prices.parser,
    tableExporter: services.tableExporter,
    log: services.log,
  };
  deps.prices.supplierCards = cardsDeps;
  deps.documents.supplierCards = cardsDeps;
  deps.siteExport.supplierCards = cardsDeps;
  deps.orderCalc.supplierCards = cardsDeps;
  // Правило про фото визитки в промпте - только когда фото читаются как текст (режим tokens).
  const cardsOption: { supplierCards?: SupplierCardsAgentOptions } = {
    supplierCards: config.vision.textGate.mode === 'tokens' ? { businessCardPhoto: true } : {},
  };
  return {
    supplierCards: {
      deps: cardsDeps,
      buttons: createSupplierCardService(cardsDeps),
      loadTemplate: supplierTemplateLoader(
        project.SUPPLIER_TEMPLATE_PATH,
        services.tableExporter,
        services.log,
      ),
    },
    cardsOption,
  };
}

/** Обзор почты сотрудников: предложения завести карточки; нужна подключённая почта. */
function wireMailProposals(
  ctx: Context,
  orderCalc: OrderCalcDeps,
  mailConnected: boolean,
): MailProposalsRuntime | undefined {
  const { project, services } = ctx;
  if (project.SUPPLIER_MAIL_PROPOSALS_ENABLED !== 'true') return undefined;
  const mailboxes = services.mailboxes;
  if (!mailConnected || mailboxes === undefined) {
    services.log('mail_proposals_ignored', { reason: 'mailboxes_not_connected' });
    return undefined;
  }
  const own = pragmatikaPortsOf(ctx.ports.extra);
  const deps: SupplierMailProposalsDeps = {
    suppliers: own.suppliers,
    state: services.state,
    clock: services.clock,
    classifier: new ModelSupplierMailClassifier(modelsOf(ctx), ctx.modelOf(PRICES_AGENT_ID)),
    mailboxes,
    chat: services.chat,
    addresseeAgentId: ORDER_CALC_AGENT_ID,
    // Тред для сотрудника, не писавшего боту, строится по ключу бота «Поиск поставщика».
    botId: botOf(ctx, ORDER_CALC_AGENT_ID),
    ownCompanyNames: project.OWN_COMPANY_NAMES,
    ownCompanyRequisites: project.OWN_COMPANY_REQUISITES ?? [],
    audit: services.audit,
    log: services.log,
    senderTrust: services.mailSenderTrust,
    autoEnrich: project.SUPPLIER_MAIL_PROPOSALS_AUTO_ENRICH_ENABLED === 'true',
  };
  orderCalc.mailProposals = deps;
  return {
    deps,
    options: {
      timezone: project.BUSINESS_TIMEZONE,
      intervalDays: project.SUPPLIER_MAIL_PROPOSALS_INTERVAL_DAYS,
      checkHour: project.SUPPLIER_MAIL_PROPOSALS_CHECK_HOUR,
      windowDays: project.SUPPLIER_MAIL_PROPOSALS_WINDOW_DAYS,
      maxClassifyPerRun: project.SUPPLIER_MAIL_PROPOSALS_MAX_CLASSIFY_PER_RUN,
    },
  };
}

/** Политика доступа в зависимости, передача задач между агентами и синхронный вызов агента. */
function wireAccessAndHandoff(
  ctx: Context,
  deps: { prices: PricesDeps; documents: DocumentsDeps; orderCalc: OrderCalcDeps },
  cards: SupplierCardsDeps | undefined,
  proposals: { deps: SupplierMailProposalsDeps } | undefined,
): void {
  const { config, project, services } = ctx;
  const access = services.access;
  // Запись карточек по ответу текстом проверяет то же право, что и кнопка.
  if (cards !== undefined) cards.access = access;
  // Изменение наших реквизитов проверяет право documents.update_own_requisites.
  deps.documents.access = access;
  // Карточки по ходу заявки заводит только руководитель отдела.
  deps.orderCalc.access = access;
  if (proposals !== undefined) proposals.deps.access = access;
  // Без файла правил чат закрыт для всех (заглушка), реестр обращений не фильтруем.
  if (config.access !== undefined) deps.prices.access = access;
  if (project.AGENT_HANDOFF_ORDER_CALC_TO_PRICES === 'true') {
    deps.orderCalc.handoff = {
      state: services.state,
      scheduler: services.scheduler,
      clock: services.clock,
      access,
      audit: services.audit,
      log: services.log,
    };
  }
  if (project.AGENT_CALL_ENABLED === 'true') {
    deps.orderCalc.agentCall = {
      steps: createDurableSteps({
        state: services.state,
        idempotency: services.idempotency,
        clock: services.clock,
      }),
      state: services.state,
      clock: services.clock,
      access,
      audit: services.audit,
      log: services.log,
    };
  }
}

/** Общее для четырёх агентов: история диалога, журнал файлов, оценка ответа, песочница. */
function wireCommon(
  ctx: Context,
  hosts: [PricesDeps, DocumentsDeps, OrderCalcDeps, SiteExportDeps],
  parser: PricesDeps['parser'],
): void {
  const { config, services } = ctx;
  const [prices, documents, orderCalc, siteExport] = hosts;
  for (const host of hosts) {
    host.conversationHistory = services.conversationHistory;
    host.historySearchLimits = config.agents.historySearch;
    host.historySearchLog = services.log;
    // Журнал общего инструмента файлов (вид, размер, число строк).
    host.fileLog = services.log;
    Object.assign(host, { feedbackLog: services.feedbackLog });
  }
  if (services.scriptSandbox !== undefined) {
    for (const host of hosts) {
      host.scriptSandbox = services.scriptSandbox;
      host.parser = parser;
      host.dataScriptLog = services.log;
    }
    // Удачные скрипты разбора прайсов запоминаются за поставщиком.
    prices.priceScripts = pragmatikaPortsOf(ctx.ports.extra).priceScripts;
  }
  // Реестр договоров и файлы чата читает разбор таблиц независимо от песочницы.
  documents.parser ??= parser;
  siteExport.parser ??= parser;
  orderCalc.parser ??= parser;
}

/** Декларации агентов по флагам окружения. */
function declarationsOf(
  ctx: Context,
  cardsOption: { supplierCards?: SupplierCardsAgentOptions },
  proposalsReady: boolean,
): ProjectAgents['declarations'] {
  const { config, project, services, ports } = ctx;
  const dataScript = services.scriptSandbox === undefined ? {} : { dataScript: true };
  const mailbox = config.agents.employeeMailboxEnabled;
  const monitoring = config.agents.monitoringEnabled;
  const declarations = [
    createPricesAgent({
      model: ctx.modelOf(PRICES_AGENT_ID),
      ...dataScript,
      mailbox,
      monitoring,
      ...cardsOption,
    }),
    createDocumentsAgent({
      model: ctx.modelOf(DOCUMENTS_AGENT_ID),
      ...dataScript,
      enabledKinds: project.DOCUMENTS_ENABLED_KINDS,
      chatAttachments: ports.attachments !== undefined,
      counterpartyAmend: project.DOCUMENTS_COUNTERPARTY_AMEND_ENABLED === 'true',
      ownRequisitesUpdate: project.OWN_REQUISITES_DB_ENABLED === 'true',
      ...cardsOption,
    }),
    createOrderCalcAgent({
      model: ctx.modelOf(ORDER_CALC_AGENT_ID),
      ...dataScript,
      handoffToPrices: project.AGENT_HANDOFF_ORDER_CALC_TO_PRICES === 'true',
      intake: project.ORDER_CALC_INTAKE_ENABLED === 'true',
      completeness: project.ORDER_CALC_COMPLETENESS_ENABLED === 'true',
      mailbox,
      // Утренняя сводка вместо напоминания «через 24 часа».
      dailyDigest: monitoring,
      reminderReply: project.ORDER_REMINDER_REPLY_ENABLED === 'true',
      supplierMailProposals: proposalsReady,
      ...cardsOption,
      // Только у агента «Поиск поставщика»; кросс-проверка гарантирует включённые карточки.
      supplierExport: project.SUPPLIER_EXPORT_ENABLED === 'true',
    }),
    createSiteExportAgent({
      model: ctx.modelOf(SITE_EXPORT_AGENT_ID),
      ...dataScript,
      ...cardsOption,
    }),
  ];
  // Инструменты и общие блоки промпта - как в прежней сборке (модель настроена на них).
  return restoreLegacyTools(declarations, {
    limitWarnings: config.agents.feedbackLimitWarnings,
  });
}
