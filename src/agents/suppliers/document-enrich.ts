import type { z } from 'zod';
import { ownEntityFilterValues } from '../../kit/domain/own-legal-entity';
import type { OwnLegalEntityRepository } from '../../kit/ports/own-legal-entities';
import type { WorkflowStateStore } from '@business-ai/core';
import type { ToolContext } from '@business-ai/core';
import { stableHash } from '@business-ai/core';
import { failureName, type FailureLog } from '@business-ai/core';
import { readAttachmentText } from './document-source-text';
import {
  MAX_SOURCE_TEXT_LENGTH,
  enrichCardOutputSchema,
  runEnrichSupplierCard,
  type EnrichCardInput,
} from './enrich-card-tool';
import { OwnCompanyFilter } from './own-company-filter';
import type { SupplierCardsHost } from './deps';
import {
  SourceMatcher,
  VALUE_NOT_IN_SOURCE,
  rejectedNotice,
  type RejectedValue,
} from './source-provenance';

/**
 * Дополнение карточки поставщика из документа для агентов, которые не ведут карточки сами
 * («Подготовка документов», «Актуализация сайта»; этап 219). Общий `enrichSupplierCard`
 * верит тому, что модель передала как `sourceText`; здесь источник и значения ограничены кодом:
 * - `sourceText` принимается, только если он дословно есть в тексте файлов и фото, прочитанных
 *   в этом треде (`document-source-text.ts`); текст веб-страницы и пересказ модели не проходят;
 * - слова сотрудника код берёт из сохранённых сообщений треда, а не от модели;
 * - значения нашей компании отбрасываются (`OwnCompanyFilter`), без заданных реквизитов -
 *   поля, которые нечем проверить, не пишутся вовсе;
 * - свободные поля, которые модель формулирует своими словами (условия, примечания, списки),
 *   записываются, только если дословно есть в источнике.
 */

type EnrichOutput = z.infer<typeof enrichCardOutputSchema>;

/** Что нужно дополнению карточки от зависимостей агента. */
export interface DocumentEnrichHost extends SupplierCardsHost {
  /** Состояние: по нему берётся текст прочитанных вложений. */
  state?: WorkflowStateStore | undefined;
  /** Названия наших юрлиц. */
  ownCompanyNames?: readonly string[] | undefined;
  /** Реквизиты наших юрлиц (`OWN_COMPANY_REQUISITES`); не заданы - fail closed. */
  ownCompanyRequisites?: readonly string[] | undefined;
  /**
   * Записи реквизитов наших юрлиц из БД (этап 230): объединяются с `ownCompanyRequisites`.
   * Нет ни записей, ни переменной - прежний fail closed. Сбой чтения не роняет ход: остаётся
   * переменная окружения, в журнал уходит `own_requisites_read_failed`.
   */
  ownEntities?: OwnLegalEntityRepository | undefined;
  /** Журнал событий (только коды). */
  log?: FailureLog | undefined;
}

/** Реквизиты нашей компании для фильтра: переменная окружения плюс записи БД. */
async function ownRequisitesForFilter(host: DocumentEnrichHost): Promise<string[]> {
  const configured = [...(host.ownCompanyRequisites ?? [])];
  if (host.ownEntities === undefined) return configured;
  try {
    const entities = await host.ownEntities.list();
    return [...configured, ...entities.flatMap(ownEntityFilterValues)];
  } catch (error) {
    host.log?.('own_requisites_read_failed', { code: failureName(error) });
    return configured;
  }
}

const SOURCE_NOT_IN_FILES_TEXT =
  'sourceText не совпал с текстом файлов и фото, прочитанных в этом чате (readChatAttachments), ' +
  'и не принят: значения проверяются только по присланным файлам и словам сотрудника. ' +
  'Передайте фрагмент файла дословно (не страницу сайта и не пересказ).';
const DROPPED_OWN_TEXT =
  'Значения нашей компании (название, реквизиты, контакты) в карточку поставщика не ' +
  'записываются; отброшены поля: ';
const UNVERIFIABLE_TEXT =
  'Реквизиты нашей компании в настройках не заданы, поэтому поля, которые нечем проверить на ' +
  'совпадение с ними, не записаны: ';

/** Условия поставщика, которые модель формулирует текстом. */
const TERM_KEYS = ['payment', 'delivery', 'minBatch', 'leadTime', 'discounts'] as const;
/** Одиночные свободные поля. */
const FREE_TEXT_KEYS = ['paymentNotes', 'contractNotes'] as const;
/** Списки свободных строк. */
const FREE_LIST_KEYS = ['categories', 'brands', 'technologies', 'personalizationTypes'] as const;

/** Хвост-ограничение как у исходного инструмента: источник режется с начала. */
function head(text: string): string {
  return text.length <= MAX_SOURCE_TEXT_LENGTH ? text : text.slice(0, MAX_SOURCE_TEXT_LENGTH);
}

/**
 * Свободные поля только дословно из источника: условия, примечания, списки категорий, брендов,
 * технологий, юрлица. Общая проверка происхождения их не знает (модель формулирует их сама),
 * поэтому для документа они проверяются здесь; не найденное в тексте отклоняется.
 */
function groundFreeFields(
  fields: EnrichCardInput,
  matcher: SourceMatcher,
): { fields: EnrichCardInput; rejected: RejectedValue[] } {
  const kept: EnrichCardInput = { ...fields };
  const rejected: RejectedValue[] = [];
  const reject = (field: string): void => {
    rejected.push({ field, code: VALUE_NOT_IN_SOURCE });
  };
  if (kept.terms !== undefined) {
    const terms = { ...kept.terms };
    for (const key of TERM_KEYS) {
      const value = terms[key];
      if (value !== undefined && !matcher.text(value)) {
        delete terms[key];
        reject(`terms.${key}`);
      }
    }
    if (Object.keys(terms).length > 0) kept.terms = terms;
    else delete kept.terms;
  }
  for (const key of FREE_TEXT_KEYS) {
    const value = kept[key];
    if (value !== undefined && !matcher.text(value)) {
      delete kept[key];
      reject(key);
    }
  }
  for (const key of FREE_LIST_KEYS) {
    const list = kept[key];
    if (list === undefined) continue;
    const found = list.filter((item, index) => {
      const ok = matcher.text(item);
      if (!ok) reject(`${key}[${index}]`);
      return ok;
    });
    if (found.length > 0) kept[key] = found;
    else delete kept[key];
  }
  if (kept.legalEntities !== undefined) {
    const entities = kept.legalEntities.flatMap((entity, index) => {
      if (!matcher.text(entity.name)) {
        reject(`legalEntities[${index}]`);
        return [];
      }
      if (entity.inn !== undefined && !matcher.code(entity.inn)) {
        reject(`legalEntities[${index}].inn`);
        return [{ name: entity.name }];
      }
      return [entity];
    });
    if (entities.length > 0) kept.legalEntities = entities;
    else delete kept.legalEntities;
  }
  return { fields: kept, rejected };
}

/** Отпечаток текстов, по которым решается запись: входит в ключ операции инструмента. */
export async function enrichSourcesFingerprint(
  host: DocumentEnrichHost,
  threadId: string,
  extra: readonly string[],
): Promise<string> {
  const attachments = await readAttachmentText(host.state, threadId);
  return stableHash([attachments, ...extra]);
}

/**
 * Дополнить карточку из документа с ограничениями кода. `employeeText` - слова сотрудника из
 * сохранённых сообщений треда (у агента без такого хранилища - пусто). Вход - поля без
 * `messageText`: слова сотрудника подставляет код.
 */
export async function runDocumentEnrich(
  input: EnrichCardInput,
  host: DocumentEnrichHost,
  context: ToolContext,
  employeeText: string,
): Promise<EnrichOutput> {
  const warnings: string[] = [];
  const stored = await readAttachmentText(host.state, context.threadId);
  const claimed = input.sourceText;
  // Источник и слова сотрудника берёт код: заявленные моделью в проверяемые поля не попадают.
  const rest: EnrichCardInput = { ...input };
  delete rest.sourceText;
  delete rest.messageText;
  let sourceText: string | undefined;
  if (claimed !== undefined && claimed.trim() !== '') {
    if (new SourceMatcher([stored]).text(claimed)) sourceText = claimed;
    else warnings.push(SOURCE_NOT_IN_FILES_TEXT);
  }
  const matcher = new SourceMatcher([head(sourceText ?? ''), employeeText]);
  const grounded = groundFreeFields(rest, matcher);
  if (grounded.rejected.length > 0) warnings.push(rejectedNotice(grounded.rejected).trim());
  const own = new OwnCompanyFilter(
    host.ownCompanyNames ?? [],
    await ownRequisitesForFilter(host),
  ).clean(grounded.fields);
  if (own.dropped.length > 0) warnings.push(`${DROPPED_OWN_TEXT}${own.dropped.join(', ')}.`);
  if (own.unverifiable.length > 0) {
    warnings.push(`${UNVERIFIABLE_TEXT}${own.unverifiable.join(', ')}.`);
  }
  const result = await runEnrichSupplierCard(
    {
      ...own.fields,
      ...(sourceText === undefined ? {} : { sourceText }),
      ...(employeeText === '' ? {} : { messageText: employeeText }),
    },
    host,
    context,
    // Тексты вложений записал инструмент чтения агента в его состояние: доказательство берётся
    // оттуда же, откуда проверяется `sourceText`.
    { attachmentState: host.state },
  );
  return {
    ...result,
    rejected: [...result.rejected, ...grounded.rejected],
    warnings: [...warnings, ...result.warnings],
  };
}
