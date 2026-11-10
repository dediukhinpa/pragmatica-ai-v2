import { HOUR_MS } from '../../kit/domain/time';
import type {
  AccessPolicy,
  AuditRepository,
  ChatChannel,
  Clock,
  DocumentParser,
  PairNoteStore,
  TableExporter,
  WorkflowStateStore,
} from '@business-ai/core';
import type { PriceRepository, SupplierRepository } from '../../kit/ports/repositories.owned';

/**
 * Зависимости модуля карточек поставщиков. Модуль не отдельный агент: его инструменты
 * подключаются к агенту «Актуализация прайса (ИИ агент)» и агенту «Поиск поставщика (ИИ агент)»
 * опцией `supplierCards`, а зависимости лежат в
 * поле `supplierCards` их собственных deps (см. {@link SupplierCardsHost}).
 */
export interface SupplierCardsDeps {
  suppliers: SupplierRepository;
  chat: ChatChannel;
  clock: Clock;
  /** Запросы подтверждения карточек и пачек (пространства ниже). */
  state: WorkflowStateStore;
  /** Личные заметки и предпочтения связки «сотрудник + бот». */
  pairNotes: PairNoteStore;
  /** Журнал аудита: только токен запроса и коды, без текстов и ПДн. */
  audit: AuditRepository;
  /**
   * Цены поставщиков (перенос и сверка прайса). Необязательны.
   */
  prices?: PriceRepository | undefined;
  /** Разбор присланной таблицы (xlsx). Без него загрузка файлом отвечает not_configured. */
  parser?: DocumentParser | undefined;
  /** Сборка файла-шаблона из строк. Без него шаблон отдаётся готовым файлом репозитория. */
  tableExporter?: TableExporter | undefined;
  /**
   * Права сотрудников: запись в общую базу по ответу текстом требует того же права
   * `suppliers.confirm_card`, что и кнопка. Нет политики - такая запись запрещена.
   */
  access?: AccessPolicy | undefined;
  /** Сбой побочной записи (аудит) не роняет нажатие: только метка в журнал. */
  log?: ((event: string, fields?: Record<string, string | number | boolean>) => void) | undefined;
}

/**
 * Хозяин зависимостей модуля: deps агента («Актуализация прайса (ИИ агент)», «Поиск поставщика (ИИ
 * агент)») с полем
 * `supplierCards`. Инструменты модуля принимают именно такой тип, поэтому подходят обоим.
 */
export interface SupplierCardsHost {
  supplierCards?: SupplierCardsDeps | undefined;
}

/** Пространство запросов подтверждения карточки и заметки: ключ - токен запроса. */
export const SUPPLIER_CARD_REQUEST_NAMESPACE = 'suppliers:card-request';
/** Пространство запросов подтверждения пачки из файла: ключ - токен пачки. */
export const SUPPLIER_BATCH_NAMESPACE = 'suppliers:card-batch';
/** Указатель на последний показ треда, ждущий ответа сотрудника текстом: ключ - тред чата. */
export const SUPPLIER_PENDING_NAMESPACE = 'suppliers:card-pending';

/**
 * Предложение добавить поставщика в базу (этап 182): ключ - тред чата + хеш нормализованного
 * названия, чтобы отказ не спрашивался повторно в том же треде.
 */
export const SUPPLIER_LOOKUP_OFFER_NAMESPACE = 'suppliers:lookup-offer';

/**
 * Срок жизни запроса карточки: после него кнопки не действуют (как у черновика письма).
 * В запросе лежат данные карточки с ПДн: в терминальном статусе они стираются.
 */
export const SUPPLIER_CARD_REQUEST_TTL_MS = 24 * HOUR_MS;
/** Срок жизни запроса подтверждения пачки. */
export const SUPPLIER_BATCH_TTL_MS = 24 * HOUR_MS;
/** Не больше строк данных в одном файле пачки. */
export const SUPPLIER_BATCH_MAX_ROWS = 500;
/** Сколько карточек отдаёт поиск модели за раз. */
export const SUPPLIER_SEARCH_LIMIT = 10;
/** Предел одной строки списка в отчётах и показе (остальное - «и ещё N»). */
export const SUPPLIER_REPORT_LIST_LIMIT = 20;

/** Журнал аудита: действия модуля. */
export const SUPPLIER_AUDIT_SAVE = 'suppliers.card_save';
export const SUPPLIER_AUDIT_NOTE = 'suppliers.note_add';
export const SUPPLIER_AUDIT_PAIR_NOTE = 'suppliers.pair_note_add';
export const SUPPLIER_AUDIT_BATCH = 'suppliers.batch_save';
export const SUPPLIER_AUDIT_CANCEL = 'suppliers.card_cancel';
export const SUPPLIER_AUDIT_EDIT = 'suppliers.card_edit';
export const SUPPLIER_AUDIT_EXPORT = 'suppliers.export';
export const SUPPLIER_AUDIT_ENRICH = 'suppliers.card_enrich';
