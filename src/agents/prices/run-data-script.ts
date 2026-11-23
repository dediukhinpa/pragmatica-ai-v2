import { DomainError } from '@business-ai/core';
import {
  createRunDataScriptTool,
  type ScriptResultKindHandler as PriceItemsHandler,
} from '@business-ai/core';
import { z } from 'zod';
import { requirePort } from '@business-ai/core';
import { LEGACY_RUN_DATA_SCRIPT_PRESENTATION } from '../shared/common-tools.owned';
import type { PricesDeps } from './deps';
import { parseSource } from './parse-cache';
import { openPriceSource, sourceSizeOf } from './price-sources';
import { isPriceDataSource, stageScriptItems, type PriceDataScriptSource } from './script-import';

/**
 * Источник данных скрипта у агента прайсов: те же пути, что у `readPriceFile` (файл диска,
 * `fileref:`, вложение чата, `mail:`) и те же проверки доступа (`openPriceSource`). Без ссылки -
 * единственное вложение текущего диалога. Разбор берётся из общего кэша разборов прайсов.
 */
async function openPricesDataSource(
  deps: PricesDeps,
  ref: string | undefined,
  context: Parameters<typeof openPriceSource>[2],
): Promise<PriceDataScriptSource> {
  let path = ref;
  if (path === undefined) {
    const intake = requirePort(deps.intake, 'файлы от сотрудников');
    const files = await intake.list(context.threadId);
    if (files.length !== 1) {
      throw new DomainError(
        'invalid_input',
        files.length === 0
          ? 'В этом диалоге нет вложений: укажите fileRef файла прайса или не угадывайте данные.'
          : 'В диалоге несколько вложений: укажите fileRef нужного файла (listIntakeFiles).',
      );
    }
    path = files[0]?.path;
  }
  if (path === undefined) throw new DomainError('invalid_input', 'Не указан файл для скрипта.');
  const source = await openPriceSource(deps, path, context);
  return {
    name: source.name,
    read: () => source.read(),
    size: sourceSizeOf(source),
    parse: () => parseSource(deps.parser, source, deps.turnScope),
    price: source,
  };
}

/**
 * Результат `price_items` агента прайсов: сверка и staging того же импорта, что у
 * `stagePriceRows` (запись дальше только `commitPriceImport` и его валидатор). Модели - сводка.
 */
function priceItemsHandlerOf(deps: PricesDeps): PriceItemsHandler {
  return async (items, context) => {
    const { supplierId, onEmployeeRequest } = extraOf(context.extra);
    if (supplierId === undefined) {
      throw new DomainError(
        'invalid_input',
        'Для price_items укажи supplierId поставщика, чей прайс разбираешь.',
      );
    }
    if (!isPriceDataSource(context.source)) {
      throw new DomainError('invalid_input', 'price_items разбирает только файл прайса.');
    }
    const staged = await stageScriptItems(deps, {
      supplierId,
      source: context.source,
      parsed: await context.source.parse(),
      code: context.code,
      raw: items,
      context: context.toolContext,
      createdBy: onEmployeeRequest ? 'employee_request' : 'agent',
      withDiff: onEmployeeRequest,
    });
    return staged.accepted
      ? staged.summary
      : { accepted: false, count: staged.count, issues: staged.issues.map((i) => ({ ...i })) };
  };
}

/** Поля ввода вида `price_items` из дополнительных полей реестра платформы. */
function extraOf(extra: Readonly<Record<string, unknown>>): {
  supplierId: string | undefined;
  onEmployeeRequest: boolean;
} {
  const supplierId = extra['supplierId'];
  return {
    supplierId: typeof supplierId === 'string' ? supplierId : undefined,
    onEmployeeRequest: extra['onEmployeeRequest'] === true,
  };
}

const SUPPLIER_ID_MAX_CHARS = 100;

/** `runDataScript` агента прайсов: вид `price_items` регистрируется в реестре платформы. */
export const runDataScript = createRunDataScriptTool<PricesDeps>(openPricesDataSource, {
  presentation: LEGACY_RUN_DATA_SCRIPT_PRESENTATION,
  resultKinds: [
    {
      name: 'price_items',
      // Песочница платформы знает общий вид `rows`; форму позиции проверяет обработчик проекта.
      sandboxKind: 'rows',
      description:
        'price_items (список позиций {name, price>0, variant?, sku?, note?, currency? (USD), ' +
        'tier_basis?: quantity|order_sum, tiers?: [{min_quantity>0, price>0}] (порог по ' +
        'возрастанию, цена позиции = цене первого тиража), price_qualifier?: from|range, ' +
        'price_max?}, лишние ключи - ошибка; для прайса поставщика укажи supplierId: позиции ' +
        'пройдут сверку и лягут в staging (дальше commitPriceImport), вернётся сводка, не ' +
        'сами позиции; onEmployeeRequest=true, если сотрудник просил исправить разбор)',
      inputShape: {
        supplierId: z.string().trim().min(1).max(SUPPLIER_ID_MAX_CHARS).optional(),
        onEmployeeRequest: z.boolean().optional(),
      },
      handlerFor: (deps) => deps.priceItemsHandler ?? priceItemsHandlerOf(deps),
    },
  ],
});
