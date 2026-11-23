import { z } from 'zod';
import { DomainError } from '@business-ai/core';
import type { AnyToolDefinition } from '@business-ai/core';
import type { PricesDeps } from './agents/prices/deps';
import { openPriceSource } from './agents/prices/price-sources';
import { readPricePage } from './agents/prices/read-price-file';

/**
 * Менеджеру - только реальная неудача (этап 9v). Пока скан не читался, `reportToManager` с
 * kind=scan_skipped сообщал менеджеру «скан без текста» и по удачно распознанному скану (живой
 * баг 23.11). Теперь инструмент сам перечитывает файл (разбор в кэше хода): если текст или
 * таблица распознаны, итог scan_skipped отклоняется ошибкой `scan_was_read` без уведомления.
 * Пустой и нечитаемый скан проходят как раньше: отказ и сообщение менеджеру.
 */

/** Название инструмента, который охраняется. */
export const REPORT_TOOL_NAME = 'reportToManager';
/** Вид итога, который проверяется. */
const SCAN_SKIPPED_KIND = 'scan_skipped';
/** Код отказа в тексте ошибки: по нему отказ узнаётся в журнале и в тестах. */
export const SCAN_WAS_READ_CODE = 'scan_was_read';

/** Пометка в описании инструмента. */
export const SCAN_READ_GUARD_NOTE =
  ' scan_skipped принимается, только если скан НЕ прочитан (needsOcr=true или текста нет): ' +
  `для прочитанного скана инструмент вернёт ошибку ${SCAN_WAS_READ_CODE}, менеджеру ничего не ` +
  'уходит; в таком случае обработай скан как обычный файл.';

/** Текст отказа для модели. */
export const SCAN_WAS_READ_MESSAGE =
  `${SCAN_WAS_READ_CODE}: скан прочитан (текст или таблица распознаны), менеджеру ничего не ` +
  'отправлено. Не сообщай о нём как о пропущенном: обработай файл как обычный прайс или ' +
  'выполни просьбу сотрудника, а числа покажи с пометкой «распознано со скана, сверьте».';

const guardedInput = z.object({ kind: z.string(), path: z.string() }).passthrough();

/** Прочитан ли файл по пути: есть текст или таблица и `needsOcr` снят. Сбой чтения - нет. */
async function scanWasRead(
  deps: PricesDeps,
  path: string,
  context: Parameters<typeof openPriceSource>[2],
): Promise<boolean> {
  try {
    const source = await openPriceSource(deps, path, context);
    const page = await readPricePage(deps, source, undefined);
    return !page.needsOcr && (page.markdown.trim() !== '' || page.tableCount > 0);
  } catch {
    // Не удалось проверить: сообщение менеджеру не подавляется (прежнее поведение).
    return false;
  }
}

/** `reportToManager` с проверкой: итог scan_skipped по прочитанному скану отклоняется. */
export function withScanReadGuard(tool: AnyToolDefinition): AnyToolDefinition {
  if (tool.name !== REPORT_TOOL_NAME) return tool;
  if (tool.description.endsWith(SCAN_READ_GUARD_NOTE)) return tool;
  return {
    ...tool,
    description: `${tool.description}${SCAN_READ_GUARD_NOTE}`,
    async execute(input, deps, context) {
      const checked = guardedInput.safeParse(input);
      if (
        checked.success &&
        checked.data.kind === SCAN_SKIPPED_KIND &&
        (await scanWasRead(deps as PricesDeps, checked.data.path, context))
      ) {
        throw new DomainError('conflict', SCAN_WAS_READ_MESSAGE);
      }
      return tool.execute(input, deps, context);
    },
  };
}
