import type {
  AccessPolicy,
  AuditRepository,
  ChatChannel,
  Clock,
  DocumentRenderer,
  FileSource,
  WorkflowStateStore,
} from '@business-ai/core';
import type { ContractAmender } from '../../kit/ports/contract-amender';
import type { ContractNumbering } from '../../kit/ports/contract-numbering';
import type { DealManagerReader } from '../../kit/ports/deal-manager';
import type { KnowledgeSearch } from '../../kit/ports/knowledge-search.owned';
import type { OwnLegalEntityRepository } from '../../kit/ports/own-legal-entities';
import type { OwnRequisitesSource } from '../../kit/ports/own-requisites';
import type {
  PurchaseRequestRepository,
  SupplierRepository,
} from '../../kit/ports/repositories.owned';
import type { SignatoryInflector } from '../../kit/ports/signatory-inflector';
import type { SupplierQuoteRepository } from '../../kit/ports/supplier-quote-repository';
import type { DocumentKind } from '../../kit/domain/models';
import type { ConversationHistoryHost } from '@business-ai/core';
import type { CreateFileHost } from '@business-ai/core';
import type { DataScriptHost } from '@business-ai/core';
import type { ChatAttachmentsHost } from '../order-calc/read-chat-attachments';
import type { SupplierCardsDeps } from '../suppliers/deps';
import type { WebSearchHost } from '@business-ai/core';

/** Идентификатор агента «Подготовка документов (ИИ агент)». */
export const DOCUMENTS_AGENT_ID = 'documents';

/**
 * Зависимости инструментов агента «Подготовка документов (ИИ агент)» (приходят в рантайм как
 * `toolDeps`).
 */
export interface DocumentsDeps extends
    WebSearchHost,
    ConversationHistoryHost,
    DataScriptHost,
    CreateFileHost,
    ChatAttachmentsHost {
  /** Диск с шаблонами документов. */
  files: FileSource;
  /**
   * Диск К (корень файлов) только на чтение: второй корень поиска реестра договоров. Не задан -
   * реестр ищут только в корне шаблонов.
   */
  registryFiles?: FileSource | undefined;
  /** `CONTRACT_REGISTRY_PATH`: `files:<путь>` или `templates:<путь>`; пусто - только поиск. */
  contractRegistryPath?: string | undefined;
  knowledge: KnowledgeSearch;
  renderer: DocumentRenderer;
  suppliers: SupplierRepository;
  chat: ChatChannel;
  /** Названия собственных юрлиц: сторона документа, которой нет в базе поставщиков. */
  ownCompanyNames: readonly string[];
  /**
   * Реквизиты наших юрлиц (ИНН, КПП, ОГРН, адрес, почта: `OWN_COMPANY_REQUISITES`). Нужны одному:
   * не дать записать значения нашей компании в карточку поставщика при дополнении из договора
   * (этап 219). Не задано - отбрасывается только совпадение с названием.
   */
  ownCompanyRequisites?: readonly string[] | undefined;
  /** Каталог шаблонов на диске (префикс пути); пусто = искать по всему источнику. */
  templatesPrefix?: string;
  /**
   * Явный перечень разрешённых шаблонов (DOCUMENT_TEMPLATE_ALLOWLIST). Не задан — разрешены
   * только шаблоны каталога (как в findTemplate); путь вне перечня отклоняется (R4-SEC-8).
   */
  templateAllowlist?: readonly string[] | undefined;
  /** Сохранённые КП (их пишет «Поиск поставщика (ИИ агент)»). */
  quotes?: SupplierQuoteRepository | undefined;
  /** Статусы передачи документов на проверку. */
  state?: WorkflowStateStore | undefined;
  clock?: Clock | undefined;
  /**
   * Счётчик нумерации (этап 139). С этапа 152 агент номер не выдаёт: его называет сотрудник по
   * реестру; порт остаётся для поиска выданных ранее номеров (основной договор NDA).
   */
  contractNumbering?: ContractNumbering | undefined;
  /**
   * Менеджер сделки («От Заказчика» в договоре): его ФИО, телефон и почту подставляет код.
   * Не задан - контакт спрашивают у сотрудника, как раньше.
   */
  dealManagers?: DealManagerReader | undefined;
  /**
   * Заявки: по ним id заявки документа переводится в ссылку на сделку для `dealManagers`.
   * Не задан - ссылкой на сделку считается сам id заявки.
   */
  requests?: PurchaseRequestRepository | undefined;
  /** Тред сотрудника, который проверяет и подписывает документы; по умолчанию — тред диалога. */
  reviewerThreadId?: string | undefined;
  /** Карточки поставщиков (`SUPPLIER_CARDS_ENABLED`); без них инструменты модуля not_configured. */
  supplierCards?: SupplierCardsDeps | undefined;
  /**
   * Виды документов, которые агент готовит (`DOCUMENTS_ENABLED_KINDS`). Не задано - все виды.
   * Отклонение выключенного вида делает код инструментов, схемы от флага не зависят.
   */
  enabledKinds?: readonly DocumentKind[] | undefined;
  /**
   * Склонение подписанта поставщика: по ФИО руководителя и должности код сам составляет
   * `seller_representative`. Не задано - этот вопрос задают сотруднику, как раньше.
   */
  signatoryInflector?: SignatoryInflector | undefined;
  /**
   * Дополнение присланного договора исполнителя (этап 227, `DOCUMENTS_COUNTERPARTY_AMEND_ENABLED`):
   * сервис вписывает наш номер и наши реквизиты, не трогая текст исполнителя. Не задано - режима
   * дополнения нет, инструмент `amendCounterpartyContract` недоступен.
   */
  contractAmender?: ContractAmender | undefined;
  /**
   * Источник наших реквизитов для дополнения договора. Не задан - берётся блок «Заказчик» из
   * шаблона договора юрлица (то, что печатает и сборка по шаблону); этап 230: записи БД, нет
   * записи - отказ, а не текст шаблона.
   */
  ownRequisites?: OwnRequisitesSource | undefined;
  /**
   * Записи реквизитов наших юрлиц (этап 230). С `ownRequisites` задаются вместе при
   * `OWN_REQUISITES_DB_ENABLED`: источник реквизитов для договоров, сверка шаблонов и изменение
   * реквизитов по указанию сотрудника. Фильтру «наших реквизитов» нужны отдельно от флага.
   */
  ownEntities?: OwnLegalEntityRepository | undefined;
  /**
   * Права сотрудников: изменение реквизитов требует `documents.update_own_requisites`. Нет
   * политики - изменять нельзя (fail closed).
   */
  access?: AccessPolicy | undefined;
  /** Журнал аудита изменения реквизитов: кто, когда, какие поля; значений в нём нет. */
  audit?: AuditRepository | undefined;
}

/** Расширения файлов шаблонов. */
export const TEMPLATE_EXTENSIONS: readonly string[] = ['.docx', '.dotx', '.xlsx'];
/** Лимит выдачи базы знаний при поиске шаблона. */
export const TEMPLATE_KNOWLEDGE_LIMIT = 5;
/** Лимит выдачи поставщиков при сверке сторон документа. */
export const PARTY_LOOKUP_LIMIT = 20;
/** Расширение выпускаемого файла: рендерер собирает docx. */
export const OUTPUT_EXTENSION = '.docx';

/** Пространство имён статусов документов на проверке. */
export const REVIEW_NAMESPACE = 'documents:review';
/** Единственный статус, который ставит агент: подписывает и согласует человек. */
export const AWAITING_REVIEW = 'awaiting_review';
