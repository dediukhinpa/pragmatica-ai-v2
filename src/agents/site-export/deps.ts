import type {
  ChatChannel,
  Clock,
  EmployeeIdentityResolver,
  FileSource,
  MailboxDirectory,
  TableExporter,
  TemplateWorkbook,
  WebSearch,
  WorkflowStateStore,
} from '@business-ai/core';
import type { KnowledgeSearch } from '../../kit/ports/knowledge-search.owned';
import type { PriceRepository, SupplierRepository } from '../../kit/ports/repositories.owned';
import type { SiteTextEditor } from '../../kit/ports/site-text-editor';
import type { OwnLegalEntityRepository } from '../../kit/ports/own-legal-entities';
import type { ExportTemplate } from '../../kit/domain/site-export';
import type { ConversationHistoryHost } from '@business-ai/core';
import type { CreateFileHost } from '@business-ai/core';
import type { ChatAttachmentsHost } from '../order-calc/read-chat-attachments';
import type { DataScriptHost } from '@business-ai/core';
import type { SupplierCardsDeps } from '../suppliers/deps';
import type { WebSearchHost } from '@business-ai/core';
import { resolveRecipientThread } from '@business-ai/core';
import { workSubject } from '../shared/work-owner.owned';

/** Идентификатор агента «Актуализация сайта (ИИ агент)». */
export const SITE_EXPORT_AGENT_ID = 'site-export';

/**
 * Зависимости инструментов агента «Актуализация сайта (ИИ агент)» (приходят в рантайм как
 * `toolDeps`).
 */
export interface SiteExportDeps extends
    WebSearchHost,
    ConversationHistoryHost,
    DataScriptHost,
    CreateFileHost,
    ChatAttachmentsHost {
  prices: PriceRepository;
  /** Подсказки для описаний: документы базы знаний по названию товара. */
  knowledge: KnowledgeSearch;
  /** Набор карточек в работе: между шагами лежит здесь, а не в контексте модели. */
  state: WorkflowStateStore;
  /** Шаблон выгрузки как данные (структура задаётся конфигурацией). */
  template: ExportTemplate;
  chat: ChatChannel;
  /** Тред менеджера, куда агент отчитывается: запуск может идти не из чата. */
  managerThreadId: string;
  /** Веб-страницы поставщиков для сбора данных; без него источник «веб» недоступен. */
  web?: WebSearch | undefined;
  /**
   * Ящики сотрудников. Есть и ход ведёт сотрудник: письма ищутся в ящике этого сотрудника
   * (сбор данных читает без пометки «обработано» и не сдвигает ничьих курсоров). Нет, либо ход
   * плановый, либо ящик не подключён - источник «почта» недоступен.
   */
  mailboxes?: MailboxDirectory | undefined;
  /**
   * Справочник поставщиков: письма читаются только от известных адресов (R3-SEC-4). Без него
   * источник «почта» недоступен.
   */
  suppliers?: SupplierRepository | undefined;
  /** Выгрузка таблиц: нужна общему инструменту createFile; шаблон отдаёт sendTemplateFile. */
  tableExporter?: TableExporter | undefined;
  /** Часы: отметки времени в шаблоне и журнале отправки. */
  clock?: Clock | undefined;
  /** Часовой пояс бизнеса: дата корректировки в шаблоне (по умолчанию Europe/Moscow). */
  businessTimeZone?: string | undefined;
  /** Карточки поставщиков (`SUPPLIER_CARDS_ENABLED`); без них инструменты модуля not_configured. */
  supplierCards?: SupplierCardsDeps | undefined;
  /** Названия наших юрлиц: не дают записать их в карточку поставщика (этап 219). */
  ownCompanyNames?: readonly string[] | undefined;
  /**
   * Реквизиты наших юрлиц (`OWN_COMPANY_REQUISITES`). Не заданы - дополнение карточки не пишет
   * ИНН, КПП, адреса, ФИО директора и контакты (этап 219).
   */
  ownCompanyRequisites?: readonly string[] | undefined;
  /** Записи реквизитов наших юрлиц из БД: объединяются с `ownCompanyRequisites` (этап 230). */
  ownEntities?: OwnLegalEntityRepository | undefined;
  /**
   * Шаблон заказчика как книга xlsx (этап 158): структура, очистка примеров, запись ячеек через
   * сервис документов. Без него инструменты шаблона отвечают not_configured.
   */
  workbook?: TemplateWorkbook | undefined;
  /**
   * Диск шаблонов ТОЛЬКО на чтение (корень `TEMPLATES_FILES_ROOT`): тот же источник, что у агента
   * «Документы», с его защитой от выхода за корень и символических ссылок. Записи на диск у
   * агента нет: здесь намеренно только `read`/`stat`.
   */
  templateFiles?: Pick<FileSource, 'read' | 'stat'> | undefined;
  /** Путь к чистому шаблону сайта от корня шаблонов (`SITE_TEMPLATE_PATH`); нет — не задан. */
  siteTemplatePath?: string | undefined;
  /**
   * Личность сотрудника для поля «менеджер»: имя и фамилия из каталога сотрудников по
   * идентификатору канала, не из текста сообщения. Без неё имя всегда `unknown`.
   */
  employeeIdentity?: EmployeeIdentityResolver | undefined;
  /**
   * Сжатие и орфография описаний моделью (этап 225, `SITE_TEXT_EDITOR_ENABLED`, выключен). Нет —
   * орфография не правится, а описание длиннее предела возвращается агенту на сокращение.
   */
  textEditor?: SiteTextEditor | undefined;
}

/**
 * Адресат итога выгрузки: тред сотрудника, начавшего набор, иначе менеджер (прежний адрес).
 */
export function exportReportRecipient(deps: SiteExportDeps, exportId: string): Promise<string> {
  return resolveRecipientThread(deps.state, workSubject.export(exportId), deps.managerThreadId);
}

/** Размер пачки при чтении набора из состояния. */
export const PUBLISH_BATCH_SIZE = 50;
/** Размер страницы чтения карточек для агента. */
export const READ_PAGE_SIZE = 50;
/** Верхняя граница выборки карточек из базы: курсор — смещение внутри неё. */
export const READ_MAX_TOTAL = 5_000;
/** Сколько документов базы знаний отдаём как подсказки к описанию. */
export const HINT_LIMIT = 3;
/** Сколько замечаний показываем агенту; остальные сводятся в одно сообщение. */
export const EXPORT_MAX_ISSUES_LISTED = 20;

/** Пространство имён состояния набора карточек выгрузки. */
export function exportNamespace(exportId: string): string {
  return `site-export:${exportId}`;
}

/** Сколько результатов просим у каждого источника при сборе данных по позиции. */
export const GATHER_LIMIT = 10;
/** Сколько позиций с одним артикулом читаем при подстановке цены (больше - цена снимается). */
export const SKU_LOOKUP_LIMIT = 100;
/** Письма: размер страницы, предел страниц просмотра и длина выдержки из письма. */
export const GATHER_INBOX_PAGE_SIZE = 50;
export const GATHER_INBOX_MAX_PAGES = 10;
export const GATHER_EXCERPT_CHARS = 500;
/** Знаков темы письма, которые проверяются кодом и отдаются модели (R8-D2-02). */
export const GATHER_SUBJECT_MAX_CHARS = 300;
/** Слова запроса короче этого в поиске по письмам не участвуют. */
export const GATHER_MIN_WORD_LENGTH = 3;

/**
 * Пространство имён индекса артикулов набора: по нормализованному артикулу находит ключи
 * карточек без чтения всего набора (R5-CORE-6). Записи индекса проверяются по самой карточке.
 */
export function skuIndexNamespace(exportId: string): string {
  return `site-export-sku:${exportId}`;
}

/** Пространство имён заметок набора: значения из источников и вопросы к людям. */
export function notesNamespace(exportId: string): string {
  return `site-export-notes:${exportId}`;
}
