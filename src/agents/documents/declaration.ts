import { SESSION_SUMMARY_PROMPT } from '../shared/legacy-prompts.owned';
import { FILE_TOOL_PROMPT, createFileWarningsTool } from '@business-ai/core';
import type { AgentDeclaration } from '@business-ai/core';
import { withRequestRef } from '../order-calc/request-title';
import {
  readChatAttachments,
  readChatAttachmentsRecorded,
} from '../order-calc/read-chat-attachments';
import { DOCUMENTS_AGENT_ID } from './deps';
import { checkTemplateFieldsTool } from './check-template-fields';
import { searchContractRegistry } from './contract-registry';
import { fillTemplate } from './fill-template';
import { findTemplate } from './find-template';
import { getSelectedQuote } from './get-selected-quote';
import { getSupplierRequisites } from './get-supplier-requisites';
import {
  handoffForReview,
  handoffScopeValidator,
  handoffSupplierValidator,
} from './handoff-for-review';
import { prepareSupplierDocument } from './prepare-supplier-document';
import { ATTACHMENT_ONLY_SCRIPT_PROMPT, DATA_SCRIPT_PROMPT } from '@business-ai/core';
import { runDataScript } from './run-data-script';
import { searchConversationHistory } from '@business-ai/core';
import { searchInternetForDocuments } from './search-internet';
import { askToConfirmWebFields, recordWebFieldsDecision } from './web-confirmation';
import {
  CHAT_ATTACHMENTS_PROMPT,
  CONTRACT_CARD_ENRICH_PROMPT,
  COUNTERPARTY_AMEND_PROMPT,
  OWN_REQUISITES_PROMPT,
  buildDocumentsPrompt,
} from './prompt';
import { amendCounterpartyContract } from './amend-counterparty-contract';
import { confirmOwnRequisitesUpdate, proposeOwnRequisitesUpdate } from './update-own-requisites';
import { enabledKindsOf } from './enabled-kinds';
import {
  documentFieldsValidator,
  documentPartiesValidator,
  documentSourcesValidator,
  saveDocument,
  supplierDocumentViaHandoffValidator,
} from './save-document';
import { validateDocument } from './validate-document';
import { buildDocumentsGreeting } from './greeting';
import type { DocumentKind } from '../../kit/domain/models';
import {
  SUPPLIER_CARDS_PROMPT_WITHOUT_ENRICH,
  withSupplierCardsGreeting,
} from '../suppliers/prompt';
import {
  supplierCardsToolsWithoutEnrich,
  type SupplierCardsAgentOptions,
} from '../suppliers/tools';
import { recordSupplierLookupDecision } from '../suppliers/supplier-lookup-offer';
import { enrichSupplierCardFromContract } from './contract-card-enrich';
import { lookupSupplierInBaseForDocuments } from './contract-card-offer';

/**
 * Лимит шагов агента документов: цепочка договора (шаблон, реквизиты, КП, сборка, номер,
 * проверка полей, файл, передача на проверку) занимает 9-10 вызовов и при дефолте 10
 * обрывалась. Только для этого агента, общий дефолт рантайма не меняется.
 */
export const DOCUMENTS_AGENT_MAX_STEPS = 25;

/**
 * Дополнительные шаги при дополнении карточки из договора (этап 219): к цепочке договора
 * добавляются чтение присланного файла (`readChatAttachments`), справка о карточке
 * (`findSupplierCard`), само дополнение (`enrichSupplierCard`), повтор после отказа проверки
 * источника и правка расходящегося значения (`prepareSupplierCardEdit`). Без этих шагов запас
 * в 25 вызовов съедался до дополнения, и оно молча не выполнялось. Добавка действует только там,
 * где инструмент подключён.
 */
export const CONTRACT_ENRICH_EXTRA_STEPS = 5;

/**
 * Сотрудник называет заявку по названию: в `requestId` инструментов документов название
 * переводится в id. Без отката на активную заявку: чужую заявку в договор подставлять нельзя.
 */
const DOCUMENT_REF_OPTIONS = { activeFallback: false } as const;

/** Параметры создания агента: модель задаётся алиасом снаружи, не жёстко. */
export interface DocumentsAgentOptions {
  model: string;
  /** Карточки поставщиков: инструменты, промпт и кнопки приветствия. Без опции - прежняя. */
  supplierCards?: SupplierCardsAgentOptions;
  /**
   * Виды документов, которые агент готовит (`DOCUMENTS_ENABLED_KINDS`): промпт и приветствие
   * говорят только о них. Не задано - все виды, декларация прежняя.
   */
  enabledKinds?: readonly DocumentKind[] | undefined;
  /** Песочница скриптов (`AGENT_SANDBOX_ENABLED`): инструмент `runDataScript` и промпт. */
  dataScript?: boolean;
  /**
   * Чтение файлов и фото, присланных в чат (инструмент `readChatAttachments`): подключается,
   * когда есть скачивание вложений портала. Без опции инструмента и абзаца промпта нет.
   */
  chatAttachments?: boolean;
  /**
   * Режим «дополнить присланный договор исполнителя» (этап 227): инструмент
   * `amendCounterpartyContract` и абзац промпта. Только вместе с договорами (`contract`) и
   * чтением файлов чата; без опции агент ведёт себя как раньше.
   */
  counterpartyAmend?: boolean;
  /**
   * Наши реквизиты как данные (этап 230, `OWN_REQUISITES_DB_ENABLED`): инструменты изменения
   * реквизитов по указанию сотрудника и абзац промпта. Без опции агент прежний.
   */
  ownRequisitesUpdate?: boolean;
}

/**
 * Декларация агента «Подготовка документов (ИИ агент)». Зависимости инструментов приходят как
 * `DocumentsDeps`.
 */
export function createDocumentsAgent(options: DocumentsAgentOptions): AgentDeclaration {
  const kinds = enabledKindsOf(options.enabledKinds);
  const greeting = buildDocumentsGreeting(kinds);
  const supplierCards = options.supplierCards;
  const withButtons = supplierCards !== undefined && supplierCards.greetingButtons !== false;
  // Дополнение карточки из договора - только если договоры вообще готовятся.
  const withContractEnrich = supplierCards !== undefined && kinds.includes('contract');
  // Дополнение присланного договора: только для договоров и при чтении файлов чата.
  const withAmend =
    options.counterpartyAmend === true &&
    options.chatAttachments === true &&
    kinds.includes('contract');
  return {
    id: DOCUMENTS_AGENT_ID,
    prompt:
      buildDocumentsPrompt(kinds) +
      (options.chatAttachments === true ? CHAT_ATTACHMENTS_PROMPT : '') +
      // Общий абзац про enrichSupplierCard агенту не нужен: его инструмент ограничен договором
      // и описан в своём разделе (этап 219).
      (supplierCards === undefined ? '' : SUPPLIER_CARDS_PROMPT_WITHOUT_ENRICH) +
      (withContractEnrich ? CONTRACT_CARD_ENRICH_PROMPT : '') +
      (withAmend ? COUNTERPARTY_AMEND_PROMPT : '') +
      (options.ownRequisitesUpdate === true ? OWN_REQUISITES_PROMPT : '') +
      (options.dataScript === true ? DATA_SCRIPT_PROMPT + ATTACHMENT_ONLY_SCRIPT_PROMPT : '') +
      // Договоры выпускаются только по шаблону: createFile не обход проверок шаблона.
      'Договоры и соглашения делай только по шаблону, не через createFile.\n' +
      SESSION_SUMMARY_PROMPT +
      FILE_TOOL_PROMPT,
    model: options.model,
    maxSteps: DOCUMENTS_AGENT_MAX_STEPS + (withContractEnrich ? CONTRACT_ENRICH_EXTRA_STEPS : 0),
    greeting: withButtons ? withSupplierCardsGreeting(greeting) : greeting,
    tools: [
      findTemplate,
      getSupplierRequisites,
      // Поиск по базе нужен и без полного набора карточек (этап 182); без deps он unavailable.
      // Предложение завести карточку - только для договора (этап 219): своя обёртка поиска.
      lookupSupplierInBaseForDocuments,
      recordSupplierLookupDecision,
      withRequestRef(getSelectedQuote, DOCUMENT_REF_OPTIONS),
      withRequestRef(prepareSupplierDocument, DOCUMENT_REF_OPTIONS),
      searchContractRegistry,
      checkTemplateFieldsTool,
      fillTemplate,
      validateDocument,
      saveDocument,
      handoffForReview,
      searchInternetForDocuments,
      searchConversationHistory,
      // Режим предупреждений: пределы файла - обрезка с замечаниями, а не отказ (этап 177).
      createFileWarningsTool,
      askToConfirmWebFields,
      recordWebFieldsDecision,
      // С дополнением карточки текст прочитанных файлов запоминается: sourceText принимается
      // только из него (этап 219).
      ...(options.chatAttachments === true
        ? [withContractEnrich ? readChatAttachmentsRecorded : readChatAttachments]
        : []),
      ...(options.dataScript === true ? [runDataScript] : []),
      ...(supplierCards === undefined ? [] : supplierCardsToolsWithoutEnrich()),
      ...(withContractEnrich ? [enrichSupplierCardFromContract] : []),
      ...(withAmend ? [amendCounterpartyContract] : []),
      ...(options.ownRequisitesUpdate === true
        ? [proposeOwnRequisitesUpdate, confirmOwnRequisitesUpdate]
        : []),
    ],
    validators: [
      documentFieldsValidator,
      documentPartiesValidator,
      documentSourcesValidator,
      supplierDocumentViaHandoffValidator,
      handoffScopeValidator,
      handoffSupplierValidator,
    ],
  };
}
