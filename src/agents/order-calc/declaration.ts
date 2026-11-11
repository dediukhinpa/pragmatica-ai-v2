import { SESSION_SUMMARY_PROMPT } from '../shared/legacy-prompts.owned';
import { FILE_TOOL_PROMPT, createFileWarningsTool } from '@business-ai/core';
import type { AgentDeclaration } from '@business-ai/core';
import { askManagerToChoose, recordManagerChoice } from './ask-manager-to-choose';
import { recordSupplierCardDecision } from './supplier-card-offer';
import { buildShortlist } from './build-shortlist';
import { COMPLETENESS_PROMPT, checkRequestCompleteness } from './check-request-completeness';
import { compareQuotesTool } from './compare-quotes';
import { confirmQuoteReplacement } from './confirm-quote-replacement';
import { DATA_SCRIPT_PROMPT } from '@business-ai/core';
import { runDataScript } from './run-data-script';
import { searchConversationHistory } from '@business-ai/core';
import { searchInternet } from '@business-ai/core';
import { ORDER_CALC_AGENT_ID } from './deps';
import {
  HANDOFF_TO_PRICES_PROMPT,
  handoffResultTool,
  handoffToPrices,
  handoffToPricesValidator,
} from './handoff-to-prices';
import { INTAKE_PROMPT } from './intake';
import { prepareSupplierRequestText } from './prepare-supplier-request-text';
import {
  ORDER_CALC_DATA_SCRIPT_PROMPT,
  ORDER_CALC_DIGEST_PROMPT,
  ORDER_CALC_MAIL_PROMPT,
  ORDER_CALC_PROMPT,
} from './prompt';
import { closeOrder, orderStatus } from './order-status';
import { recordSupplierReply } from './record-supplier-reply';
import { readChatAttachments, readChatAttachmentsRecorded } from './read-chat-attachments';
import { readIntakeSource } from './read-intake-source';
import { saveIntakeRequest } from './save-intake-request';
import { answerOrderReminder } from './reminder-reply';
import { ORDER_CALC_REMINDER_REPLY_PROMPT } from './reminder-reply-prompt';
import { quoteValidator, recordQuote } from './record-quote';
import { recordSelection, selectionValidator } from './record-selection';
import { readReplyAttachment, readSupplierReplies } from './reply-reading';
import { remindManager } from './remind-manager';
import { routeSupplierMail } from './route-supplier-mail';
import { reminderValidator, scheduleReminder } from './schedule-reminder';
import { searchKnowledgeSuppliers, searchWeb } from './search-sources';
import { quoteSummaryValidator, sendQuoteSummary } from './send-quote-summary';
import { withRequestRef } from './request-title';
import { ORDER_CALC_GREETING, ORDER_CALC_MAIL_GREETING } from './greeting';
import {
  BUSINESS_CARD_PHOTO_PROMPT,
  SUPPLIER_CARDS_PROMPT,
  SUPPLIER_MAIL_PROPOSALS_PROMPT,
  withSupplierCardsGreeting,
} from '../suppliers/prompt';
import { SUPPLIER_EXPORT_PROMPT } from '../suppliers/export-suppliers';
import { recordMailSupplierProposalDecision } from '../suppliers/mail-proposal-decision';
import {
  supplierCardsTools,
  supplierExportTools,
  type SupplierCardsAgentOptions,
} from '../suppliers/tools';

/** Параметры создания агента: модель задаётся алиасом снаружи, не жёстко. */
export interface OrderCalcAgentOptions {
  model: string;
  /**
   * Передача задачи агенту «Актуализация прайса (ИИ агент)» (освежить цены по позициям). По
   * умолчанию выключена: без флага
   * инструментов нет в декларации, а промпт не меняется.
   */
  handoffToPrices?: boolean;
  /**
   * Приём заявки (текст, задача, сделка): инструменты readIntakeSource и saveIntakeRequest.
   * По умолчанию выключен: без флага инструментов нет, а промпт не меняется.
   */
  intake?: boolean;
  /**
   * Подсказка о полноте запроса (`ORDER_CALC_COMPLETENESS_ENABLED`): инструмент
   * checkRequestCompleteness и дополнение промпта. Поиск она не блокирует (этап 140: шлюз и
   * инструмент решения «ищи так» убраны). По умолчанию выключена: декларация и промпт прежние.
   */
  completeness?: boolean;
  /**
   * Чтение почты сотрудников (`EMPLOYEE_MAILBOX_ENABLED`): чтение ответов поставщиков и всё,
   * что из них следует (КП, сводка, напоминания), промпт и приветствие с почтой. Писем агент
   * НЕ отправляет ни с этой опцией, ни без неё (ТЗ, разд. 5): текст запроса готовит
   * `prepareSupplierRequestText`, отправляет сотрудник. Без опции инструментов чтения ответов
   * нет, промпт и приветствие о них не упоминают. По умолчанию выключено.
   */
  mailbox?: boolean;
  /**
   * Утренняя сводка по заказам вместо суточного напоминания по каждой заявке: scheduleReminder
   * не объявляется (ставить нечего), к промпту дописывается
   * ORDER_CALC_DIGEST_PROMPT. По умолчанию выключено: декларация и промпт прежние.
   */
  dailyDigest?: boolean;
  /**
   * Ответ на утреннее напоминание (`ORDER_REMINDER_REPLY_ENABLED`, этап 226): инструмент
   * answerOrderReminder и дополнение промпта. Имеет смысл только вместе с `dailyDigest`
   * (без сводки отвечать не на что). По умолчанию выключено: декларация и промпт прежние.
   */
  reminderReply?: boolean;
  /**
   * Карточки поставщиков (общая база): поиск, подготовка и правка карточки, заметки, личный
   * слой «сотрудник + агент», дополнение промпта и кнопки приветствия. Запись карточки делает
   * код после нажатия кнопки. Без опции декларация и промпт прежние.
   */
  supplierCards?: SupplierCardsAgentOptions;
  /** Песочница скриптов (`AGENT_SANDBOX_ENABLED`): инструмент `runDataScript` и промпт. */
  dataScript?: boolean;
  /**
   * Выгрузка базы поставщиков файлом в чат (`SUPPLIER_EXPORT_ENABLED`, этап 215): инструмент
   * `exportSuppliers` и строка промпта. Работает поверх зависимостей карточек (`supplierCards`).
   * По умолчанию выключена: без флага инструмента нет, а промпт и записи eval прежние.
   */
  supplierExport?: boolean;
  /**
   * Предложения завести карточки по письмам сотрудников (этап 222, `SUPPLIER_MAIL_PROPOSALS_
   * ENABLED`): инструмент ответа и абзац промпта. Предложение шлёт код по расписанию. Без опции
   * декларация и промпт прежние.
   */
  supplierMailProposals?: boolean;
}

/**
 * Декларация агента «Поиск поставщика (ИИ агент)». Зависимости инструментов приходят как
 * `OrderCalcDeps`.
 */
export function createOrderCalcAgent(options: OrderCalcAgentOptions): AgentDeclaration {
  const supplierCards = options.supplierCards;
  const withButtons = supplierCards !== undefined && supplierCards.greetingButtons !== false;
  // Почта сотрудников выключена: инструментов чтения ответов и всего, что стоит на них, у
  // агента нет (а не «объявлены и отвечают not_configured»). Инструмента отправки письма у
  // агента нет вовсе, вне зависимости от опций.
  const mail = options.mailbox === true;
  const completeness = options.completeness === true;
  const legacyReminder = mail && options.dailyDigest !== true;
  const reminderReply = options.reminderReply === true && options.dailyDigest === true;
  const greeting = mail ? ORDER_CALC_MAIL_GREETING : ORDER_CALC_GREETING;
  return {
    id: ORDER_CALC_AGENT_ID,
    prompt:
      (mail ? ORDER_CALC_MAIL_PROMPT : ORDER_CALC_PROMPT) +
      (options.handoffToPrices === true ? HANDOFF_TO_PRICES_PROMPT : '') +
      (options.intake === true ? INTAKE_PROMPT : '') +
      (completeness ? COMPLETENESS_PROMPT : '') +
      (mail && options.dailyDigest === true ? ORDER_CALC_DIGEST_PROMPT : '') +
      (reminderReply ? ORDER_CALC_REMINDER_REPLY_PROMPT : '') +
      (supplierCards === undefined ? '' : SUPPLIER_CARDS_PROMPT) +
      (options.supplierExport === true ? SUPPLIER_EXPORT_PROMPT : '') +
      (supplierCards?.businessCardPhoto === true && options.intake === true
        ? BUSINESS_CARD_PHOTO_PROMPT
        : '') +
      (options.supplierMailProposals === true ? SUPPLIER_MAIL_PROPOSALS_PROMPT : '') +
      (options.dataScript === true ? DATA_SCRIPT_PROMPT + ORDER_CALC_DATA_SCRIPT_PROMPT : '') +
      SESSION_SUMMARY_PROMPT +
      FILE_TOOL_PROMPT,
    model: options.model,
    greeting: withButtons ? withSupplierCardsGreeting(greeting) : greeting,
    tools: [
      searchKnowledgeSuppliers,
      searchWeb,
      searchInternet,
      searchConversationHistory,
      // Режим предупреждений: пределы файла - обрезка с замечаниями, а не отказ (этап 177).
      createFileWarningsTool,
      buildShortlist,
      askManagerToChoose,
      recordManagerChoice,
      recordSupplierCardDecision,
      recordSelection,
      // Текст запроса готовится и без почты: учёт «подготовлено» нужен и без ящика.
      // С суточным напоминанием (mail без сводки) после текста запроса модель ещё вызывает
      // scheduleReminder, поэтому prepare ход не заканчивает: его заканчивает напоминание.
      legacyReminder
        ? { ...prepareSupplierRequestText, endsTurn: false }
        : prepareSupplierRequestText,
      // В режиме сводки суточное напоминание заменено утренней сводкой, и после снятия проверок
      // срока ставить через scheduleReminder нечего: инструмент не объявляется.
      ...(legacyReminder ? [{ ...scheduleReminder, endsTurnAfterShown: true }] : []),
      ...(mail ? [remindManager] : []),
      // Только почтовые: чтение писем, их вложений и разнесение писем по заявкам.
      ...(mail ? [readSupplierReplies, readReplyAttachment, routeSupplierMail] : []),
      // Ответ мог прийти по телефону или в мессенджере, поэтому запись ответа, КП, сравнение,
      // сводка и статус заказа доступны и без почты.
      recordSupplierReply,
      recordQuote,
      confirmQuoteReplacement,
      compareQuotesTool,
      sendQuoteSummary,
      orderStatus,
      closeOrder,
      ...(options.handoffToPrices === true ? [handoffToPrices, handoffResultTool] : []),
      // С карточками текст прочитанных файлов запоминается: по нему дополнение карточки отличает
      // присланный документ от письма и решает, можно ли писать реквизиты (ревью 233).
      ...(options.intake === true
        ? [
            readIntakeSource,
            supplierCards === undefined ? readChatAttachments : readChatAttachmentsRecorded,
            saveIntakeRequest,
          ]
        : []),
      ...(completeness ? [checkRequestCompleteness] : []),
      ...(options.dataScript === true ? [runDataScript] : []),
      ...(supplierCards === undefined ? [] : supplierCardsTools()),
      ...(options.supplierExport === true ? supplierExportTools() : []),
      ...(options.supplierMailProposals === true ? [recordMailSupplierProposalDecision] : []),
      // Сотрудник называет заявку по названию, а не по id: подмена на id до выполнения.
    ]
      .map((tool) => withRequestRef(tool))
      // Без withRequestRef намеренно: подмена неизвестного id на активную заявку диалога и
      // была ошибкой этапа 226 (ответ на напоминание уходил к последней заявке чата).
      // Допустимые заявки инструмент проверяет сам по последней сводке.
      .concat(reminderReply ? [answerOrderReminder] : []),
    validators: [
      selectionValidator,
      quoteValidator,
      quoteSummaryValidator,
      // Валидатор привязан к scheduleReminder: без инструмента (режим сводки) он не нужен.
      ...(mail && options.dailyDigest !== true ? [reminderValidator] : []),
      ...(options.handoffToPrices === true ? [handoffToPricesValidator] : []),
    ],
  };
}
