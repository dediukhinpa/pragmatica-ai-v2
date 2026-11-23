import type { AgentDeclaration, AnyToolDefinition } from '@business-ai/core';
import { PRICES_AGENT_ID } from './agents/prices/deps';
import { createScanPriceCopy, SCAN_COPY_TOOL } from './scan-price-copy';
import { withScanReadGuard } from './scan-price-guard';

/**
 * Работа со сканами для агента «Актуализация прайса» (этап 9v, флаг `PRICES_SCAN_FLOW_ENABLED`).
 * Файлы агентов (`src/agents/**`) генерируются, поэтому инструмент и охрана итога добавляются
 * здесь, при сборке манифеста, а не правкой декларации (как `withPriceCopyTools`).
 */

/** Имя переменной окружения флага (включён по умолчанию; `false` - прежнее поведение). */
export const SCAN_FLOW_FLAG = 'PRICES_SCAN_FLOW_ENABLED';

/** Параметры подключения. */
export interface ScanFlowOptions {
  /** Включён ли флаг; нет - декларация возвращается как есть (байт в байт прежняя). */
  enabled: boolean;
}

/**
 * Декларация агента прайсов с `createScanPriceCopy` и охраной `reportToManager`; остальные
 * агенты и выключенный флаг - без изменений. Повторное применение декларацию не меняет.
 */
export function withScanFlowTools(
  declaration: AgentDeclaration,
  options: ScanFlowOptions,
): AgentDeclaration {
  if (!options.enabled || declaration.id !== PRICES_AGENT_ID) return declaration;
  const tools = declaration.tools.map(withScanReadGuard);
  if (!tools.some((tool) => tool.name === SCAN_COPY_TOOL)) {
    tools.push(createScanPriceCopy as unknown as AnyToolDefinition);
  }
  return { ...declaration, tools };
}

/**
 * Абзац промпта про сканы (этап 9v): подключается сборкой вместе с `withScanFlowTools` и
 * заменяет прежнее правило «скан не обрабатывай». Если слово «скан» стоит в других местах
 * промпта прайсов, действует этот абзац.
 */
export const PRICES_SCAN_FLOW_PROMPT = `

Сканы и фото счетов и прайсов. Скан читается: readPriceFile и readIntakeFile отдают
распознанный текст или таблицу с предупреждением «распознано со скана». Правило «скан не
обрабатывай» действует, ТОЛЬКО если скан не прочитался (needsOcr=true или текста нет).
 а) Просьба правки по скану (изменить цену, пересчитать сумму и итого): вызови
    createScanPriceCopy ОДИН раз со всеми правками (path, edits: слова из названия позиции и
    новая цена за единицу). Суммы позиций и итого считает код: не пересчитывай сам, не
    правь через editPriceInFile, не создавай файл через createFile. Покажи сотруднику table
    из ответа дословно (там пометка «распознано со скана, сверьте») и message. doubtful -
    позиции с нечитаемыми или несошедшимися числами: назови их, они не правились. no_match
    или ambiguous - один вопрос с названиями из message. За ход уходит один файл.
 б) Скан-прайс с диска, из письма доверенного отправителя или из чата обрабатывается теми же
    шагами и по тем же правилам записи, что текстовый файл этого источника (с диска - в базу
    без подтверждения владельца; из чата и письма - только предложением). Цены берутся из
    таблицы; в предупреждениях скрыт список «на проверку»: такие позиции в базу не идут,
    посчитай их в needsReview. В итоге и сводке называй источник «из скана».
 в) reportToManager kind=scan_skipped - только когда скан НЕ прочитан (needsOcr=true или
    текста нет). Для прочитанного скана инструмент вернёт ошибку scan_was_read и ничего не
    отправит: тогда обработай файл как обычный.
`;
