import { SESSION_SUMMARY_PROMPT } from '@business-ai/core';
import { FILE_TOOL_PROMPT, createFileWarningsTool } from '@business-ai/core';
import type { AgentDeclaration } from '@business-ai/core';
import {
  readChatAttachments,
  readChatAttachmentsRecorded,
} from '../order-calc/read-chat-attachments';
import { ATTACHMENT_ONLY_SCRIPT_PROMPT, DATA_SCRIPT_PROMPT } from '@business-ai/core';
import { runDataScript } from './run-data-script';
import { searchConversationHistory } from '@business-ai/core';
import { searchInternet } from '@business-ai/core';
import { SITE_EXPORT_AGENT_ID } from './deps';
import { gatherItemData } from './gather-item-data';
import { SITE_CARD_ENRICH_PROMPT, buildSiteExportPrompt } from './prompt';
import { reportExportToManager } from './report-to-manager';
import { computeSitePrice } from './site-price';
import { fillTemplateRows } from './fill-template-rows';
import { nameSitePhotos } from './site-photo-names';
import { openChatTemplate } from './open-chat-template';
import { prepareCleanTemplate } from './prepare-clean-template';
import { readEmployeeIdentity } from './read-employee-identity';
import { readTemplateStructure } from './read-template-structure';
import { sendTemplateFile } from './send-template-file';
import { enrichSupplierCardFromExportMaterial } from './card-enrich';
import { SITE_EXPORT_GREETING } from './greeting';
import { SUPPLIER_CARDS_PROMPT, withSupplierCardsGreeting } from '../suppliers/prompt';
import {
  supplierCardsToolsWithoutEnrich,
  supplierLookupTools,
  type SupplierCardsAgentOptions,
} from '../suppliers/tools';

/** Параметры создания агента: модель задаётся алиасом снаружи, не жёстко. */
export interface SiteExportAgentOptions {
  model: string;
  /** Карточки поставщиков: инструменты, промпт и кнопки приветствия. Без опции - прежняя. */
  supplierCards?: SupplierCardsAgentOptions;
  /** Песочница скриптов (`AGENT_SANDBOX_ENABLED`): инструмент `runDataScript` и промпт. */
  dataScript?: boolean;
}

/**
 * Декларация агента «Актуализация сайта (ИИ агент)». Зависимости инструментов — `SiteExportDeps`.
 */
export function createSiteExportAgent(options: SiteExportAgentOptions): AgentDeclaration {
  const supplierCards = options.supplierCards;
  const withButtons = supplierCards !== undefined && supplierCards.greetingButtons !== false;
  return {
    id: SITE_EXPORT_AGENT_ID,
    prompt: buildSiteExportPrompt() +
      (supplierCards === undefined ? '' : SUPPLIER_CARDS_PROMPT + SITE_CARD_ENRICH_PROMPT) +
      // Правила про ФОТО визитки (`businessCardPhoto`) здесь нет намеренно: дополнение карточки
      // у сайта идёт только после выгрузки (SITE_CARD_ENRICH_PROMPT), правило ему противоречило бы.
      (options.dataScript === true ? DATA_SCRIPT_PROMPT + ATTACHMENT_ONLY_SCRIPT_PROMPT : '') +
      SESSION_SUMMARY_PROMPT +
      FILE_TOOL_PROMPT,
    model: options.model,
    greeting: withButtons ? withSupplierCardsGreeting(SITE_EXPORT_GREETING) : SITE_EXPORT_GREETING,
    tools: [
      // Этап 158: единственный выходной документ - шаблон заказчика, заполняемый этими
      // инструментами. Условий «проверка -> отпечаток» перед выдачей файла нет.
      prepareCleanTemplate,
      openChatTemplate,
      readTemplateStructure,
      fillTemplateRows,
      sendTemplateFile,
      computeSitePrice,
      nameSitePhotos,
      readEmployeeIdentity,
      // Файлы и фото из чата (материал по позициям); без реестра файлов вернёт filesInChat: 0.
      // С карточками текст прочитанного запоминается: дополнение карточки принимает источник
      // только из него (этап 219).
      supplierCards === undefined ? readChatAttachments : readChatAttachmentsRecorded,
      gatherItemData,
      reportExportToManager,
      searchInternet,
      searchConversationHistory,
      // Режим предупреждений: пределы файла - обрезка с замечаниями, а не отказ (этап 177).
      createFileWarningsTool,
      ...(options.dataScript === true ? [runDataScript] : []),
      // Этап 182: поиск поставщика по базе нужен всегда; без supplierCards в deps он вернёт
      // unavailable, и работа продолжается.
      // Дополнение карточки - своя обёртка с источником из файлов и фильтром наших реквизитов.
      ...(supplierCards === undefined
        ? []
        : [...supplierCardsToolsWithoutEnrich(), enrichSupplierCardFromExportMaterial]),
      ...supplierLookupTools(),
    ],
    validators: [],
  };
}
