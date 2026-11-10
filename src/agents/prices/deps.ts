import { DAY_MS } from '../../kit/domain/time';
import type {
  AccessPolicy,
  ChatChannel,
  Clock,
  DocumentParser,
  TurnScope,
  FileAuthorship,
  FileSource,
  IntakeStore,
  MailboxDirectory,
  StaffDirectory,
  TableExporter,
  WorkflowStateStore,
} from '@business-ai/core';
import type { ImportStaging } from '../../kit/ports/import-staging';
import type { PriceFileDateFallback } from '../../kit/ports/price-file-date-fallback';
import type { PriceMailAssessor } from '../../kit/ports/price-mail-assessor';
import type { PriceTableIndex } from '../../kit/ports/price-table-index';
import type { PriceRepository, SupplierRepository } from '../../kit/ports/repositories.owned';
import type { SupplierPriceScriptRepository } from '../../kit/ports/supplier-price-scripts';
import type { PriceFileEditor } from '../../kit/ports/price-file-editor';
import type { SupplierCardsDeps } from '../suppliers/deps';
import type { FailureLog, ScriptResultKindHandler } from '@business-ai/core';
import type { MailSenderTrustSettings } from '@business-ai/core';
import type { ConversationHistoryHost } from '@business-ai/core';
import type { CreateFileHost } from '@business-ai/core';
import type { DataScriptHost } from '@business-ai/core';
import type { WebSearchHost } from '@business-ai/core';
import { resolveRecipientThread } from '@business-ai/core';

/** Идентификатор агента «Актуализация прайса (ИИ агент)». */
export const PRICES_AGENT_ID = 'prices';

/**
 * Зависимости инструментов агента «Актуализация прайса (ИИ агент)» (приходят в рантайм как
 * `toolDeps`).
 */
export interface PricesDeps extends
    WebSearchHost,
    ConversationHistoryHost,
    DataScriptHost,
    CreateFileHost {
  /** Журнал сбоев побочных чтений (владелец работы): только коды. Не задан - не пишется. */
  log?: FailureLog | undefined;
  /** Обработчик вида результата `price_items` (тесты подменяют сверку). Не задан - штатный. */
  priceItemsHandler?: ScriptResultKindHandler | undefined;
  /** Сетевой диск с прайсами. */
  files: FileSource;
  /**
   * Серверный секрет идентификаторов файлов диска (`fileref:`): постоянный, из конфигурации,
   * чтобы идентификатор в очереди поручений пережил перезапуск.
   */
  fileRefSecret: string;
  parser: DocumentParser;
  /**
   * Связь общего разбора с ходами (этап 239g): отмена одного хода не роняет разбор у остальных.
   * Не задана - ходы не различаются, разбор идёт в контексте первого вызывающего.
   */
  turnScope?: TurnScope | undefined;
  /**
   * Зрение включено (`VISION_ENABLED`). `false` - сканы из писем не сохраняются (читать их
   * нечем); не задан - решает `parser.readsImages`.
   */
  visionEnabled?: boolean | undefined;
  /**
   * Модель доверия к отправителям писем (этап 233, `MAIL_SENDER_TRUST_ENABLED`). Не задана -
   * как раньше: подтверждает только проверка отправителя. Цены из писем в базу не пишутся.
   */
  senderTrust?: MailSenderTrustSettings | undefined;
  prices: PriceRepository;
  /** Промежуточное хранилище больших прайсов (куски до фиксации). */
  staging: ImportStaging;
  suppliers: SupplierRepository;
  /**
   * Сохранённые скрипты разбора прайсов за поставщиками (этап 111, тема 3). Без них скрипт
   * разбирает прайс, но не запоминается и сам при следующем прайсе не запускается.
   */
  priceScripts?: SupplierPriceScriptRepository | undefined;
  chat: ChatChannel;
  clock: Clock;
  /** Тред менеджера, куда агент отчитывается: запуск идёт по расписанию, не из чата. */
  managerThreadId: string;
  /**
   * Состояние сценариев: источники импорта, решения по письмам, файл изменений, почта.
   * Без него прайс из письма неподтверждённого отправителя зафиксировать нельзя, а
   * инструменты, которым состояние нужно, отвечают not_configured.
   */
  state?: WorkflowStateStore | undefined;
  /** Файлы, присланные сотрудниками в чат. Без него listIntakeFiles — not_configured. */
  intake?: IntakeStore | undefined;
  /**
   * Политика доступа: плановый просмотр писем с триггерами не шлёт уведомления сотруднику,
   * у которого больше нет права писать агенту «Актуализация прайса (ИИ агент)». Нет - реестр
   * обращений не фильтруется
   * (прежнее поведение).
   */
  access?: AccessPolicy | undefined;
  /**
   * Ящики сотрудников. Есть: письма с прайсами читаются из ящика сотрудника (курсор по его
   * id). Писем поставщикам агент не отправляет: ящик нужен только для чтения.
   * Нет: почта выключена, инструментов писем у агента нет.
   */
  mailboxes?: MailboxDirectory | undefined;
  /**
   * Чей ящик читает плановый разбор почты (запуск не от сотрудника). Без него плановый
   * `readPriceMail` отвечает not_configured «не указан ящик». Ход сотрудника читает его ящик.
   */
  mailboxOwnerUserId?: string | undefined;
  /**
   * Бот агента (ключ в `CHAT_BOTS`). Нужен, чтобы написать сотруднику, который боту ещё не
   * писал: тред связки строится по его id Bitrix24 (`<бот>/<id>`). Не задан (режим одного бота
   * или у агента несколько ботов) - такому сотруднику писать некуда, его ящик пропускается.
   */
  botId?: string | undefined;
  /**
   * Оценка письма моделью поверх кодового фильтра (необязательна): вызывается только для писем
   * подтверждённого поставщика с найденным признаком; `not_relevant` гасит уведомление, сбой
   * оценки - уведомление как без неё. Не задана - уведомляет один кодовый фильтр.
   */
  mailAssessor?: PriceMailAssessor | undefined;
  /**
   * Запасной разбор даты из названия прайса моделью (необязателен): проверка диска зовёт его
   * только для имён, похожих на прайс, где кодовый разбор даты не нашёл; ответ строго
   * проверяется кодом. Не задан - такие файлы остаются в списке «дата не найдена».
   */
  priceDateFallback?: PriceFileDateFallback | undefined;
  /**
   * Авторство Office-файлов (создатель, последний редактор) из свойств документа. Вместе с
   * `staff` и составом (`staffDepartmentIds` / `staffExtraUserIds`) включает адресную раздачу
   * недельной сводки по устаревшим прайсам: каждому сотруднику - по его файлам. Не задано что-то
   * из трёх - всё уходит в тред ответственного, как раньше.
   */
  authorship?: FileAuthorship | undefined;
  /** Сотрудники отдела закупок с ФИО: имена из свойств файла сопоставляются только кодом. */
  staff?: StaffDirectory | undefined;
  /**
   * Группы отделов в каталоге (`department:<id>`), чьи сотрудники (с подотделами) сопоставляются
   * по фамилии в пути (этап 217: было одно значение). Прежнее поведение - один отдел закупок.
   */
  staffDepartmentIds?: readonly string[] | undefined;
  /**
   * Отдельные сотрудники (id Bitrix24) сверх отделов: берутся из каталога всех активных. Нужны,
   * когда сотрудник числится в корне компании или в отделе вне закупок, а целый отдел вводить
   * нельзя (родительский отдел притянул бы всех). Тоже включают адресную раздачу.
   */
  staffExtraUserIds?: ReadonlySet<string> | undefined;
  /**
   * Бот пишет первым сотруднику, которого нет в реестре обращений (этап 217): тред строится по
   * его id Bitrix24 (`<botId>/<id>`). Нужен `botId`. Не задан - адресат только из реестра,
   * без треда файл уходит ответственному, как раньше.
   */
  recipientOpenThread?: boolean | undefined;
  /**
   * Идентификаторы сотрудников (`StaffPerson.userId`, id Bitrix24), которые не бывают получателями
   * недельной сводки ни на одном шаге (`PRICE_RECIPIENT_EXCLUDE_IDS`): системные и тестовые
   * учётки. Исключённый пропускается, шаг продолжается. Не задано или пусто - никого не исключаем.
   */
  recipientExcludeUserIds?: ReadonlySet<string> | undefined;
  /**
   * Область недельной проверки устаревших прайсов (только она; инструменты агента не затронуты).
   * Не задана - проверяется весь корень без исключений, как раньше.
   */
  staleScan?: { prefixes: readonly string[]; excludePattern?: string | undefined } | undefined;
  /**
   * Признак «таблица цен» по тексту в базе знаний. Задан - недельная проверка считает прайсом
   * файл со словом «прайс»/«price» в имени или с таблицей цен в тексте; не задан - прежнее
   * правило (всё, что не опознано как «не прайс»).
   */
  priceTables?: PriceTableIndex | undefined;
  /** Файл изменений для ответственного. Без него sendPriceChangeFile — not_configured. */
  tableExporter?: TableExporter | undefined;
  /** Правка цен в копии исходного файла. Без него editPricesInSourceFile — not_configured. */
  priceFileEditor?: PriceFileEditor | undefined;
  /**
   * Тред ответственного за прайсы: запасной адресат файла изменений, когда
   * владельца работы нет (плановый запуск, почта); по умолчанию менеджер.
   */
  responsibleThreadId?: string | undefined;
  /**
   * Пояс бизнеса для календарного порога `listStalePriceSuppliers` (тот же срок в месяцах, что
   * у файлов на диске). Не задан - `DEFAULT_BUSINESS_TIMEZONE`.
   */
  businessTimeZone?: string | undefined;
  /** Предел писем поставщиков с таблицей без триггеров на оценку за прогон просмотра. */
  supplierAttachmentMaxPerRun?: number | undefined;
  /**
   * Карточки поставщиков (зависимости модуля `suppliers`). Без них инструменты модуля
   * отвечают not_configured; без опции фабрики `supplierCards` инструментов нет вовсе.
   */
  supplierCards?: SupplierCardsDeps | undefined;
}

/**
 * Запасной тред ответственного, когда владельца работы нет: явная настройка, иначе менеджер.
 * Им же пользуется служба для ожиданий плановых запусков (`waitThreadByAgent`).
 */
export function responsibleThread(deps: PricesDeps): string {
  return deps.responsibleThreadId ?? deps.managerThreadId;
}

/**
 * Адресат информационного сообщения по работе (итог импорта, запрос обновления менеджеру):
 * тред владельца работы, иначе менеджер. Без `state` - всегда менеджер, как раньше.
 */
export function workRecipient(deps: PricesDeps, subject: string): Promise<string> {
  return resolveRecipientThread(deps.state, subject, deps.managerThreadId);
}

/**
 * Адресат файла изменений «для внесения в корпоративный диск»: сотрудник, который поручил работу
 * (владелец работы), иначе ответственный за прайсы (плановый запуск, почта без владельца), иначе
 * менеджер. Учётка сетевого диска только читает: данные на диск вносит сам сотрудник
 * (решение владельца 26.10.2026: файл получает тот, кто попросил, а не общий ответственный).
 */
export function changeFileRecipient(deps: PricesDeps, subject: string): Promise<string> {
  return resolveRecipientThread(deps.state, subject, responsibleThread(deps));
}

/** Расширения прайс-файлов, которые умеем разбирать. */
export const PRICE_TEXT_EXTENSIONS: readonly string[] = [
  '.xlsx',
  '.xlsm',
  '.xls',
  '.docx',
  '.doc',
  '.pptx',
  '.rtf',
  '.pdf',
  '.csv',
  '.txt',
];
/**
 * Расширения сканов и фото. Читаются моделью зрения (режим `table`), если парсер умеет
 * картинки (`readsImages`); иначе файл не обрабатывается.
 */
export const SCAN_EXTENSIONS: readonly string[] = [
  '.jpg',
  '.jpeg',
  '.png',
  '.tif',
  '.tiff',
  '.webp',
  '.gif',
  '.bmp',
];
/** Валюта по умолчанию, если в прайсе нет столбца с валютой. */
export const DEFAULT_PRICE_CURRENCY = 'RUB';

/** Сколько примеров показываем агенту в сводке; остальное только числом. */
export const PREVIEW_EXAMPLES_LIMIT = 20;
/** Формат файла изменений для ответственного. */
export const CHANGES_FILE_FORMAT = 'xlsx';
/**
 * Идентификатор треда снятой недельной проверки прайсов. Задача с этим тредом могла остаться в
 * очереди: обработчик `agent.run` её пропускает, модель не вызывается.
 */
export const PRICE_UPDATE_THREAD_ID = `${PRICES_AGENT_ID}-weekly-update`;

/** Пространства имён состояния агента «Актуализация прайса (ИИ агент)». */
export const IMPORT_META_NAMESPACE = 'prices:import-meta';
/**
 * Версии скриптов разбора, ещё не подтверждённые фиксацией импорта: пока метка есть, сохранённый
 * скрипт не запускается сам. Метки без `done`: ретенция их не трогает, иначе непроверенный
 * скрипт «подтвердился» бы временем.
 */
export const SCRIPT_UNCONFIRMED_NAMESPACE = 'prices:script-unconfirmed';
/** Координаты ячеек цен в исходном файле по importId (без миграций: JSON-состояние). */
export const SOURCE_CELLS_NAMESPACE = 'prices:source-cells';
export const PREVIEW_NAMESPACE = 'prices:preview';
/**
 * Запросы и решения снятого подтверждения прайса кнопкой (`pjump`). Новых записей нет; имена
 * нужны ретенции, чтобы вычистить старые.
 */
export const JUMP_REQUEST_NAMESPACE = 'prices:jump-request';
export const JUMP_DECISION_NAMESPACE = 'prices:jump-decision';
export const MAIL_NAMESPACE = 'prices:mail';
export const MAIL_FILE_NAMESPACE = 'prices:mail-file';
export const MAIL_CURSOR_NAMESPACE = 'prices:inbox-cursor';
/** Счётчик перечитываний письма без содержимого (ключ - id записи письма), R7-04. */
export const MAIL_REREAD_NAMESPACE = 'prices:mail-reread';
/**
 * Письма с триггером о ценах (мониторинг): ключ - токен «сотрудник + письмо». Нужны только для
 * правила «одно письмо - одно уведомление»; только идентификаторы и даты, тексты и адреса не
 * хранятся.
 */
export const MAIL_TRIGGER_NAMESPACE = 'prices:mail-trigger';
/** Курсор просмотра ящика на триггеры (ключ - id сотрудника), независим от разбора прайсов. */
export const TRIGGER_CURSOR_NAMESPACE = 'prices:trigger-cursor';
/** Учёт отправленных запросов прайса: старые записи; новых агент не пишет (ретенция их чистит). */
export const PRICE_REQUEST_SENT_NAMESPACE = 'prices:price-request-sent';
/** Последние цены, подтверждённые человеком (от них считается накопленное изменение). */
export const CONFIRMED_PRICE_NAMESPACE = 'prices:confirmed-price';
/** Дата последней загрузки файла прайса по поставщику (правки словами её не меняют). */
export const PRICE_UPLOAD_NAMESPACE = 'prices:last-upload';

/** На сколько дата цены может опережать часы сервера (расхождение часов, часовые пояса). */
export const PRICE_DATE_FUTURE_TOLERANCE_MS = DAY_MS;

/**
 * Неподтверждённые предложения цен (чат, письмо, слова сотрудника): в базу цен не пишутся,
 * диск - источник правды. Ключ - `<поставщик>:<импорт>`; закрываются импортом с диска.
 */
export const PRICE_PROPOSAL_NAMESPACE = 'prices:proposal';
