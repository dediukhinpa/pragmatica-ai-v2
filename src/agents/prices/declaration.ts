import { searchConversationHistory, searchInternet } from '../shared/common-tools.owned';
import { SESSION_SUMMARY_PROMPT } from '../shared/legacy-prompts.owned';
import { FILE_TOOL_PROMPT, createFileWarningsTool } from '@business-ai/core';
import type { AgentDeclaration } from '@business-ai/core';
import { searchSuppliers } from '../../kit/application/search-suppliers';
import { PRICES_AGENT_ID } from './deps';
import { listPriceFiles } from './list-price-files';
import { normalizePriceTable } from './normalize-price-table';
import {
  PRICES_MAIL_READ_PROMPT,
  PRICES_MONITORING_MAIL_PROMPT,
  PRICES_MONITORING_PROMPT,
  PRICES_PROMPT,
  PRICES_DATA_SCRIPT_PROMPT,
} from './prompt';
import { readPriceFile } from './read-price-file';
import { runDataScript } from './run-data-script';
import { DATA_SCRIPT_PROMPT } from '@business-ai/core';
import { reportToManager } from './report-to-manager';
import { recordEmployeePriceUpdates } from './employee-updates';
import { listIntakeFiles, readIntakeFile } from './intake-tools';
import { previewPriceChanges, sendPriceChangeFile } from './price-changes';
import { editPricesInSourceFile } from './price-edit-source';
import { markPriceMailHandled, readPriceMail } from './price-mail';
import { listStalePriceSuppliers } from './stale-price-suppliers';
import { listStalePriceFiles } from './stale-price-files-tool';
import { commitPriceImport, stagedImportValidator } from './commit-price-import';
import { answerPriceFileSupplier } from './answer-price-file-supplier';
import { priceImportValidator, savePriceImport } from './save-price-import';
import { scriptAttemptValidator } from './script-attempt-check';
import { stagePriceRows } from './stage-price-rows';
import { PRICES_GREETING } from './greeting';
import { SUPPLIER_CARDS_PROMPT, withSupplierCardsGreeting } from '../suppliers/prompt';
import {
  supplierCardsTools,
  supplierLookupTools,
  type SupplierCardsAgentOptions,
} from '../suppliers/tools';

/** Параметры создания агента: модель задаётся алиасом снаружи, не жёстко. */
export interface PricesAgentOptions {
  model: string;
  /**
   * Чтение почты сотрудников (`EMPLOYEE_MAILBOX_ENABLED`): чтение прайс-почты, промпт с
   * почтой. Писем поставщикам агент не готовит и не отправляет ни с этой, ни с какой-либо
   * другой опцией: инструментов отправки у него нет.
   */
  mailbox?: boolean;
  /**
   * Режим мониторинга (`MONITORING_ENABLED`): к промпту добавлено дополнение про плановую
   * проверку, которую ведёт код. Набор инструментов не меняется. Без опции промпт прежний.
   */
  monitoring?: boolean;
  /**
   * Карточки поставщиков (общая база): инструменты поиска, подготовки и правки карточки,
   * заметки, личный слой «сотрудник + агент», дополнение промпта и кнопки приветствия.
   * Запись карточки делает код после нажатия кнопки. Без опции декларация прежняя.
   */
  supplierCards?: SupplierCardsAgentOptions;
  /**
   * Песочница скриптов (`AGENT_SANDBOX_ENABLED`): инструмент `runDataScript` и дополнение
   * промпта. Без опции инструмента нет, декларация прежняя.
   */
  dataScript?: boolean;
}

/**
 * Декларация агента «Актуализация прайса (ИИ агент)». Зависимости инструментов приходят в рантайм
 * как `PricesDeps`.
 */
export function createPricesAgent(options: PricesAgentOptions): AgentDeclaration {
  const mail = options.mailbox === true;
  const monitoring = options.monitoring === true;
  const supplierCards = options.supplierCards;
  const withButtons = supplierCards !== undefined && supplierCards.greetingButtons !== false;
  return {
    id: PRICES_AGENT_ID,
    prompt:
      (mail ? PRICES_MAIL_READ_PROMPT : PRICES_PROMPT) +
      (monitoring ? (mail ? PRICES_MONITORING_MAIL_PROMPT : PRICES_MONITORING_PROMPT) : '') +
      (supplierCards === undefined ? '' : SUPPLIER_CARDS_PROMPT) +
      (options.dataScript === true ? DATA_SCRIPT_PROMPT + PRICES_DATA_SCRIPT_PROMPT : '') +
      SESSION_SUMMARY_PROMPT +
      FILE_TOOL_PROMPT,
    model: options.model,
    greeting: withButtons ? withSupplierCardsGreeting(PRICES_GREETING) : PRICES_GREETING,
    tools: [
      listPriceFiles,
      readPriceFile,
      searchSuppliers,
      normalizePriceTable,
      savePriceImport,
      stagePriceRows,
      commitPriceImport,
      answerPriceFileSupplier,
      reportToManager,
      listIntakeFiles,
      readIntakeFile,
      ...(mail ? [readPriceMail, markPriceMailHandled] : []),
      recordEmployeePriceUpdates,
      previewPriceChanges,
      sendPriceChangeFile,
      editPricesInSourceFile,
      searchInternet,
      searchConversationHistory,
      // Режим предупреждений: пределы файла - обрезка с замечаниями, а не отказ (этап 177).
      createFileWarningsTool,
      listStalePriceSuppliers,
      listStalePriceFiles,
      // Поиск по базе нужен всегда; без deps.supplierCards он отвечает unavailable.
      ...supplierLookupTools(),
      ...(options.dataScript === true ? [runDataScript] : []),
      ...(supplierCards === undefined ? [] : supplierCardsTools()),
    ],
    validators: [
      priceImportValidator,
      stagedImportValidator,
      ...(options.dataScript === true ? [scriptAttemptValidator] : []),
    ],
  };
}
