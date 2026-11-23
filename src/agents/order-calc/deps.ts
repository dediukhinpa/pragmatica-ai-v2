import type { SupplierCardsDeps } from '../suppliers/deps';
import type { SupplierMailProposalsDeps } from '../suppliers/mail-proposal-store';
import type { ShortlistCompareDeps } from './shortlist-compare';
import type { SupplierEnrichSettings } from './supplier-enrich';
import type { SupplierRatingDeps } from './supplier-rating';
import type { TelegramChannelDeps } from './telegram-source';
import type { AgentCallCapable, AgentCallDeps } from '@business-ai/core';
import type { HandoffCapable, HandoffDeps } from '@business-ai/core';
import type { MailSenderTrustSettings } from '@business-ai/core';
import type { ConversationHistoryHost } from '@business-ai/core';
import type { CreateFileHost } from '@business-ai/core';
import type { DataScriptHost } from '@business-ai/core';
import type { WebPageReadHost } from '@business-ai/core';
import type { WebSearchHost } from '@business-ai/core';
import type {
  AccessPolicy,
  BitrixAttachmentReader,
  ChatChannel,
  Clock,
  DocumentParser,
  BotFileRegistry,
  ImageReader,
  IntakeStore,
  MailboxDirectory,
  PortalLinks,
  Scheduler,
  TableExporter,
  TaskReader,
  WebSearch,
  WorkflowStateStore,
} from '@business-ai/core';
import type { Crm } from '../../kit/ports/crm.owned';
import type { KnowledgeSearch } from '../../kit/ports/knowledge-search.owned';
import type { PriceRelevanceChecker } from '../../kit/ports/price-relevance';
import type {
  PriceRepository,
  PurchaseRequestRepository,
  SupplierRepository,
} from '../../kit/ports/repositories.owned';
import type { SupplierQuoteRepository } from '../../kit/ports/supplier-quote-repository';
import type {
  SitePagePicker,
  SupplierSiteChooser,
  WebCandidateEnricher,
  WebHitClassifier,
  WebQueryPlanner,
} from '../../kit/ports/web-candidate-model';

/** Идентификатор агента «Поиск поставщика (ИИ агент)». */
export const ORDER_CALC_AGENT_ID = 'order-calc';

/**
 * Тип отложенной задачи запуска агента. Совпадает с `AGENT_RUN_JOB` службы (app); значение
 * продублировано, потому что application не знает слой app. Совпадение проверяет тест.
 */
export const AGENT_RUN_TASK_NAME = 'agent.run';

/**
 * Зависимости инструментов агента «Поиск поставщика (ИИ агент)» (приходят в рантайм как
 * `toolDeps`).
 */
export interface OrderCalcDeps extends HandoffCapable,
    AgentCallCapable,
    WebSearchHost,
    WebPageReadHost,
    ConversationHistoryHost,
    DataScriptHost,
    CreateFileHost {
  requests: PurchaseRequestRepository;
  suppliers: SupplierRepository;
  /**
   * Модель доверия к отправителям писем (этап 233, `MAIL_SENDER_TRUST_ENABLED`). Не задана -
   * как раньше: подтверждает только проверка отправителя.
   */
  senderTrust?: MailSenderTrustSettings | undefined;
  prices: PriceRepository;
  /** База знаний: подсказки-документы к поиску поставщиков. */
  knowledge: KnowledgeSearch;
  /** Веб-поиск (в этой сборке всегда есть: заглушка «не настроено» либо адаптер). */
  web: WebSearch;
  scheduler: Scheduler;
  chat: ChatChannel;
  clock: Clock;
  /** Результаты поиска, предложенный и выбранный шорт-листы, тексты ответов. */
  state: WorkflowStateStore;
  /** Разобранные КП поставщиков (их читает и «Подготовка документов (ИИ агент)»). */
  quotes: SupplierQuoteRepository;
  /** Тред менеджера по закупу по умолчанию (для напоминаний, если в заявке не сохранён). */
  managerThreadId: string;
  /**
   * Ящики сотрудников (только чтение): ответы поставщиков читаются из ящика сотрудника,
   * отправившего запрос. Агент письма НЕ отправляет (ТЗ, разд. 5): текст запроса показывается
   * сотруднику, отправляет он сам. Нет порта - почта выключена (`EMPLOYEE_MAILBOX_ENABLED` не
   * задан): инструментов чтения ответов у агента нет, плановые разборы почты ничего не читают.
   */
  mailboxes?: MailboxDirectory | undefined;
  /**
   * Хранилище приёма файлов сотрудников. Письма агент не отправляет (текст запроса показывается
   * в чате), поэтому вложений к письмам поставщикам он не готовит.
   */
  intake?: IntakeStore | undefined;
  /**
   * Журнал служебных событий (только коды и числа, без текстов, адресов и имён). Без него
   * события не пишутся.
   */
  log?: ((event: string, fields?: Record<string, string | number | boolean>) => void) | undefined;
  /** Файл-таблица сводки по КП. Без неё sendQuoteSummary отвечает not_configured. */
  tableExporter?: TableExporter | undefined;
  /**
   * Разбор вложений ответов (xlsx, xls, docx, doc, pptx, rtf, pdf). Без него - not_configured.
   * Им же читаются вложения задач и сделок при приёме заявки (`attachments`): отдельного
   * парсера для них нет.
   */
  parser?: DocumentParser | undefined;
  /**
   * Скачивание вложений задачи, сделки и чатов Bitrix24 для приёма заявки. Без него
   * содержимое файлов не читается, остаются только имена вложений.
   */
  attachments?: BitrixAttachmentReader | undefined;
  /**
   * Суммарный лимит текста вложений на заявку, символов (`B24_ATTACHMENT_MAX_CHARS`). Нет -
   * {@link DEFAULT_ATTACHMENT_CONTEXT_MAX_CHARS}.
   */
  attachmentMaxChars?: number | undefined;
  /**
   * Распознавание изображений-вложений и сканов PDF. Нет порта - изображения помечаются
   * «распознавание изображений не настроено».
   */
  imageReader?: ImageReader | undefined;
  /**
   * Файлы и фото из личного чата с ботом (ссылки в памяти). Нет реестра - инструмент
   * readChatAttachments ничего не читает.
   */
  botFiles?: BotFileRegistry | undefined;
  /** Передача задач другим агентам; подключается только при включённом флаге. */
  handoff?: HandoffDeps | undefined;
  /** Синхронный вызов других агентов; подключается только при `AGENT_CALL_ENABLED`. */
  agentCall?: AgentCallDeps | undefined;
  /** CRM: заявка из сделки. Без неё приём из сделки отвечает not_configured. */
  crm?: Crm | undefined;
  /** Задачи портала: заявка из задачи. Без них - not_configured. */
  tasks?: TaskReader | undefined;
  /** Разбор ссылок портала. Без него любая ссылка отклоняется («пришлите текстом»). */
  links?: PortalLinks | undefined;
  /**
   * Карточки поставщиков (зависимости модуля `suppliers`). Без них инструменты модуля
   * отвечают not_configured; без опции фабрики `supplierCards` инструментов нет вовсе.
   */
  supplierCards?: SupplierCardsDeps | undefined;
  /**
   * Политика доступа для заведения карточек по ходу заявки (этап 234): черновик в общей базе
   * создаётся только руководителем отдела (`suppliers.confirm_card`). Нет политики - карточки
   * агент не заводит, а вопрос про создание не задаёт.
   */
  access?: AccessPolicy | undefined;
  /**
   * Обзор почты сотрудников (этап 222): зависимости инструмента ответа на предложение завести
   * карточки по письмам. Нет - инструмента у агента нет (флаг `SUPPLIER_MAIL_PROPOSALS_ENABLED`).
   */
  mailProposals?: SupplierMailProposalsDeps | undefined;
  /**
   * Оценка рейтинга поставщиков моделью (оценщик + кэш по хэшу фактов). Без неё рейтинг
   * считает запасное правило по карточке; в боевой сборке подключается флагом
   * `SUPPLIER_RATING_MODEL_ENABLED` (по умолчанию включён).
   */
  supplierRating?: SupplierRatingDeps | undefined;
  /**
   * Сравнение кандидатов шорт-листа моделью (срок, стоимость, рейтинг). Без него порядок даёт
   * правило кода; в боевой сборке подключается вместе с оценкой рейтинга
   * (`SUPPLIER_RATING_MODEL_ENABLED`).
   */
  shortlistCompare?: ShortlistCompareDeps | undefined;
  /**
   * Шорт-лист карточками-вложениями (`SHORTLIST_ATTACH_ENABLED`). Не задано - включено; `false` -
   * менеджер получает только текст.
   */
  shortlistAttachEnabled?: boolean | undefined;
  /**
   * Файл Excel с шорт-листом (`SHORTLIST_XLSX_ENABLED`). Не задано - включено; `false` - файла нет.
   * Без порта выгрузки (`tableExporter`) файл тоже не отправляется, в журнал идёт событие.
   */
  shortlistXlsxEnabled?: boolean | undefined;
  /**
   * Составитель веб-запросов (модель через шлюз псевдонимизации, ТЗ разд. 3). Без него
   * веб-запросом остаются названия позиций заявки; в боевой сборке подключается флагом
   * `WEB_SEARCH_MODEL_ENABLED`.
   */
  webQueryPlanner?: WebQueryPlanner | undefined;
  /**
   * Обогащение веб-кандидатов по странице (город, контакты, цена, срок). Без него кандидат -
   * заголовок и адрес страницы, как раньше.
   */
  webEnricher?: WebCandidateEnricher | undefined;
  /**
   * Выбор официального сайта и проверка названия карточек базы моделью (этап 125). Без него сайт
   * из выдачи выбирает правило по словам названия. В боевой сборке - `SUPPLIER_SITE_MODEL_ENABLED`.
   */
  supplierSiteChooser?: SupplierSiteChooser | undefined;
  /**
   * Выбор моделью 1-2 страниц сайта по ссылкам главной, когда на прочитанных нет контактов или
   * цен. Без него читаются только главная, контакты по обычным адресам и каталог по словам.
   * В боевой сборке - тем же флагом `SUPPLIER_SITE_MODEL_ENABLED`.
   */
  sitePagePicker?: SitePagePicker | undefined;
  /**
   * Классификатор хитов выдачи (один вызов модели на весь список: релевантность, тип и
   * название компании). Без него хиты склеиваются и фильтруются только кодом, названием
   * становится домен. В боевой сборке - флаг `WEB_HIT_CLASSIFY_ENABLED`.
   */
  webClassifier?: WebHitClassifier | undefined;
  /**
   * Проверка строк прайсов моделью: один вызов на сборку отвечает, какие найденные строки - тот
   * же товар, что в позиции заявки (этап 121). Без неё найденные строки принимаются как есть. В
   * боевой сборке - флаг `PRICE_RELEVANCE_ENABLED` (по умолчанию включён).
   */
  priceRelevance?: PriceRelevanceChecker | undefined;
  /** Сколько названий строк уходит модели за один вызов проверки (`PRICE_RELEVANCE_MAX_NAMES`). */
  priceRelevanceMaxNames?: number | undefined;
  /**
   * Бюджет обогащения веб-кандидатов (каждый запрос - платный поиск). Нет - значения по
   * умолчанию из `web-enrichment.ts`. В боевой сборке - `WEB_ENRICH_*`.
   */
  webEnrichBudget?: WebEnrichBudget | undefined;
  /**
   * Обогащение карточек поставщиков базы через интернет (этап 121): бюджет на сборку и сутки
   * (`WEB_ENRICH_SUPPLIERS_*`). Нет - обогащения нет. Нужен также читатель страниц с `readUrl`.
   */
  supplierEnrich?: SupplierEnrichSettings | undefined;
  /**
   * Ответ на утреннее напоминание (`ORDER_REMINDER_REPLY_ENABLED`, этап 226): сводка запоминает
   * показанные заявки, агент получает справку и инструмент `answerOrderReminder`, сводка
   * пропускает отложенные заявки. Нет - всё прежнее. Пояс - тот же, что у сводки
   * (`BUSINESS_TIMEZONE`): отложенный день считается по нему.
   */
  reminderReply?: ReminderReplySettings | undefined;
  /**
   * Закрытый Telegram-канал как источник шорт-листа (этап 216, `TELEGRAM_CHANNEL_SOURCE_ENABLED`).
   * Нет поля - источника нет: записей `telegram` не создаётся, статусов источников и поведения
   * поиска это не меняет.
   */
  telegramChannel?: TelegramChannelDeps | undefined;
}

/** Настройки ответа на напоминание. */
interface ReminderReplySettings {
  timezone: string;
}

/** Бюджет обогащения веб-кандидатов на одну заявку. */
export interface WebEnrichBudget {
  /** Скольких лучших кандидатов обогащать (по умолчанию - весь показ). */
  maxCandidates: number;
  /** Сколько платных поисков `site:` потратить на заявку. */
  maxQueries: number;
  /** Сколько кандидатов обогащается одновременно. */
  concurrency: number;
}

/** Лимит текста вложений на заявку по умолчанию (дефолт `B24_ATTACHMENT_MAX_CHARS`). */
export const DEFAULT_ATTACHMENT_CONTEXT_MAX_CHARS = 20_000;

/** Сколько результатов просим у каждого источника на одну позицию заявки. */
export const SOURCE_RESULT_LIMIT = 10;
/** Сколько документов базы знаний возвращаем агенту как подсказки. */
export const KNOWLEDGE_REFERENCE_LIMIT = 3;

/** Пространства имён состояния. */
export const SOURCE_NAMESPACE = 'order-calc:source';
export const PROPOSAL_NAMESPACE = 'order-calc:proposal';
export const SELECTION_NAMESPACE = 'order-calc:selection';
export const SENT_NAMESPACE = 'order-calc:sent';
/**
 * Устаревшее пространство прежней отправки черновиком (ключ - заявка, значение - id сотрудника).
 * Новых записей нет; константа нужна, чтобы ретенция убирала уже записанные.
 */
export const SUPPLIER_DRAFT_OWNER_NAMESPACE = 'order-calc:draft-owner';
/**
 * Полнота запроса по заявке (ключ - заявка): вид запроса, известные характеристики заказа и
 * отказ сотрудника дополнять. Читается перед поиском поставщиков.
 */
export const COMPLETENESS_NAMESPACE = 'order-calc:completeness';
/**
 * Счётчик повторных показов текста запроса по заявке (ключ - заявка): нужен, чтобы «покажи ещё
 * раз» получал новый ключ идемпотентности и новые ключи сообщений. Только число, без текстов.
 */
export const REQUEST_TEXT_RESHOW_NAMESPACE = 'order-calc:request-text-reshow';
/**
 * Индекс открытых выборов (ключ - заявка, значение - копия выбора): выбор попадает сюда при
 * записи и снимается, когда запрос ушёл всем выбранным поставщикам либо вышло окно ответов.
 * Обход идёт по этому небольшому пространству, а не по всем выборам с хэш-ключами.
 */
export const OPEN_SELECTION_NAMESPACE = 'order-calc:selection-open';
/** Отметка «выборы, сделанные до появления индекса, однократно внесены в него». */
export const OPEN_SELECTION_BACKFILL_NAMESPACE = 'order-calc:selection-open-backfill';
/** Отметка однократного внесения в индекс писем без привязки и ожидающих писем. */
export const MAIL_INDEX_BACKFILL_NAMESPACE = 'order-calc:mail-index-backfill';
/** Вопросы менеджеру (ключ - тред, внутри по заявкам) и подтверждённый им набор (ключ - заявка). */
export const CHOICE_ASK_NAMESPACE = 'order-calc:choice-ask';
export const CHOICE_CONFIRM_NAMESPACE = 'order-calc:choice-confirm';
/** Предложение создать карточку названного поставщика, которого нет в базе (этап 163): тред. */
export const SUPPLIER_CARD_OFFER_NAMESPACE = 'order-calc:card-offer';

/**
 * Пространства имён чтения ответов: тексты и вложения по заявке; курсор почты ОДИН на весь
 * сценарий (не по заявке: иначе каждая новая заявка читала бы ящик с начала).
 */
export const REPLIES_NAMESPACE_PREFIX = 'order-calc:reply:';
/**
 * Вложения ответов лежат отдельно от записей ответов (R5-CORE-7): base64-тело до 5 МБ не
 * должно читаться и разбираться при каждом `list` ответов. Записи, сохранённые раньше в
 * `REPLIES_NAMESPACE_PREFIX`, читаются как запасной путь.
 */
export const REPLY_FILES_NAMESPACE_PREFIX = 'order-calc:reply-file:';
export const INBOX_CURSOR_NAMESPACE = 'order-calc:inbox-cursor';
/**
 * Замена КП поставщика новым ответом: предложения менеджеру (ключ - отпечаток предложения) и
 * его решения (ключ - заявка и поставщик).
 */
export const QUOTE_REPLACE_OFFER_NAMESPACE = 'order-calc:quote-replace-offer';
export const QUOTE_REPLACE_NAMESPACE = 'order-calc:quote-replace';
/** Сколько часов действует предложение замены и решение менеджера по нему. */
export const QUOTE_REPLACE_TTL_HOURS = 24;
/**
 * Ответ поставщика вне почты (телефон, мессенджер), показанный сотруднику и ждущий его «да»
 * (ключ - заявка и поставщик). Только текст, который сотрудник сам продиктовал.
 */
export const REPLY_PENDING_NAMESPACE = 'order-calc:reply-pending';
/** Сколько часов действует показанный ответ поставщика, ждущий подтверждения сотрудника. */
export const REPLY_PENDING_TTL_HOURS = 24;
/**
 * Заказ закрыт сотрудником (ключ - заявка): утренняя сводка его больше не показывает. Запись
 * открытого заказа не требуется: нет записи - заказ открыт, пока по поставщикам нет КП/отказа.
 */
export const ORDER_CLOSED_NAMESPACE = 'order-calc:order-closed';
/** Показанное сотруднику закрытие заказа, ждущее его «да» (ключ - заявка). */
export const ORDER_CLOSE_PENDING_NAMESPACE = 'order-calc:order-close-pending';
/**
 * Что показала утренняя сводка в треде сотрудника (ключ - тред): время, текст и заявки. Нужно,
 * чтобы ответ на напоминание («да, ответили») можно было связать с заявками из сводки.
 */
export const ORDER_DIGEST_SHOWN_NAMESPACE = 'order-calc:digest-shown';
/**
 * Заявка отложена до даты (ключ - заявка): сводка её пропускает, пока локальная дата меньше
 * `untilDate`. Закрытие заказа (`ORDER_CLOSED_NAMESPACE`) отдельное и окончательное.
 */
export const ORDER_REMINDER_SNOOZE_NAMESPACE = 'order-calc:reminder-snooze';
/** Письма без однозначной привязки к заявке: ждут разнесения менеджером. */
export const UNASSIGNED_MAIL_NAMESPACE = 'order-calc:unassigned-mail';
/** Вложения писем на разнесении отдельно от самих писем (читаются как запасной путь из старого). */
export const UNASSIGNED_FILES_NAMESPACE = 'order-calc:unassigned-file';
/** Сколько дней после отправки запроса письмо поставщика считается возможным ответом. */
export const REPLY_WINDOW_DAYS = 60;
/** Сколько записей состояния читаем за запрос и предел запросов при обходе пространства. */
export const STATE_SCAN_PAGE = 200;
export const STATE_SCAN_MAX_PAGES = 50;
/** Письма за один запрос к почте и предел страниц за один вызов readSupplierReplies. */
export const INBOX_PAGE_SIZE = 50;
export const INBOX_MAX_PAGES = 20;
/**
 * Вложение крупнее не сохраняется (в ответе - пометка); текст ответа обрезается до лимита.
 * 20 МиБ (этап 231, было 5 МБ): как предел вложений заявки из Bitrix24
 * (`B24_ATTACHMENT_MAX_BYTES`), чтобы КП поставщика читалось тем же размером, каким бы путём ни
 * пришло. Выше не поднято: ответ хранится в состоянии вместе с base64 и целиком читается при
 * каждом просмотре.
 */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_REPLY_TEXT_CHARS = 8_000;
export const MAX_ATTACHMENT_TEXT_CHARS = 12_000;
/** Сколько замечаний выводим в сообщении менеджеру; остальные сводятся в одну строку. */
export const SUMMARY_MAX_FLAGS = 15;
/** Формат файла сводки по КП. */
export const SUMMARY_FILE_FORMAT = 'xlsx';

/** Префикс id поставщиков, найденных вне базы (веб); дальше отпечаток названия. */
export const EXTERNAL_SUPPLIER_PREFIX = 'ext-';
/** Префикс id кнопки выбора поставщика в сообщении менеджеру. */
export const PICK_BUTTON_PREFIX = 'pick:';
/** Префикс id кнопки «Готово»: выбор поставщиков завершён. */
export const PICK_DONE_BUTTON_PREFIX = 'pickdone:';

/** Тред отдельного запуска агента с напоминанием по заявке. */
export function reminderThreadId(requestId: string): string {
  return `${ORDER_CALC_AGENT_ID}-reminder:${requestId}`;
}
