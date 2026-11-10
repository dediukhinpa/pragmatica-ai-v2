import type { AnyToolDefinition } from '@business-ai/core';
import { createSupplierFromAttachment } from './attachment-create';
import { confirmSupplierRequest } from './card-decision';
import { exportSuppliers } from './export-suppliers';
import { enrichSupplierCard } from './enrich-card-tool';
import { lookupSupplierInBase } from './supplier-lookup';
import { recordSupplierLookupDecision } from './supplier-lookup-offer';
import { forgetMyNote, rememberForMe, whatDoYouRemember } from './pair-notes';
import {
  addSupplierNote,
  findSupplierCard,
  prepareSupplierCard,
  prepareSupplierCardEdit,
} from './supplier-tools';

/**
 * Опция фабрик агента «Актуализация прайса (ИИ агент)» и агента «Поиск поставщика (ИИ агент)»:
 * подключить карточки поставщиков.
 */
export interface SupplierCardsAgentOptions {
  /**
   * Кнопки «Добавить поставщика», «Помощь» и «Шаблон» в приветствии. По умолчанию true;
   * false - только инструменты и промпт.
   */
  greetingButtons?: boolean;
  /**
   * Правило про фото визитки в промпте (`BUSINESS_CARD_PHOTO_PROMPT`). Включается, когда фото с
   * текстом читаются как текст (`IMAGE_TEXT_MODE=tokens`); действует только у агента
   * заявок с `readChatAttachments` (у сайта дополнение карточки привязано к выгрузке).
   * По умолчанию выключено: промпт прежний.
   */
  businessCardPhoto?: boolean;
}

/**
 * Инструменты модуля. Запись в общую базу - только `confirmSupplierRequest` по ответу сотрудника
 * в его ходе в чате (тот же код, что у старой кнопки).
 */
export function supplierCardsTools(): AnyToolDefinition[] {
  return [
    findSupplierCard,
    prepareSupplierCard,
    createSupplierFromAttachment,
    enrichSupplierCard,
    prepareSupplierCardEdit,
    addSupplierNote,
    confirmSupplierRequest,
    rememberForMe,
    whatDoYouRemember,
    forgetMyNote,
  ];
}

/** Имя инструмента дополнения карточки: его фильтруют агенты, которым карточки менять нельзя. */
const ENRICH_CARD_TOOL_NAME = enrichSupplierCard.name;

/**
 * Инструменты карточек без `enrichSupplierCard`: для агента документов (этап 218). Общий
 * инструмент ему не выдают: вместо него (этап 219) в декларации стоит обёртка с тем же именем,
 * ограниченная договором и сведениями самого поставщика (`enrichSupplierCardFromContract`).
 */
export function supplierCardsToolsWithoutEnrich(): AnyToolDefinition[] {
  return supplierCardsTools().filter((tool) => tool.name !== ENRICH_CARD_TOOL_NAME);
}

/**
 * Поиск поставщика по базе и предложение добавить его (этап 182) для агентов, у которых нет
 * полного набора карточек: одна строка в declaration вместо шести инструментов.
 */
export function supplierLookupTools(): AnyToolDefinition[] {
  return [lookupSupplierInBase, recordSupplierLookupDecision];
}

/**
 * Выгрузка базы поставщиков файлом в чат (этап 215, `SUPPLIER_EXPORT_ENABLED`): отдельный
 * набор, чтобы инструмент не появился у агентов, где его не просили.
 */
export function supplierExportTools(): AnyToolDefinition[] {
  return [exportSuppliers];
}
