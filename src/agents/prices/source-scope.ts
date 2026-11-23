import { matchedNullRowKeys, planSourceReplacement } from '../../kit/domain/price-file-stream';
import { priceItemKey } from '../../kit/domain/price-diff';
import { type PriceItem } from '../../kit/domain/models';

/** Часть прайса поставщика, на которую влияет импорт одного файла. */
export interface SourceScope {
  /** Строки, которые импорт заменит: сравнение «снятые/изменения» идёт только с ними. */
  replaced: PriceItem[];
  /** Более новая версия того же потока уже в базе (старая дата не перетирает новую). */
  newerFile: string | null;
  /** Ключи позиций из ДРУГИХ файлов поставщика: их подтверждённые цены импорт не касается. */
  otherKeys: ReadonlySet<string>;
}

/**
 * Область влияния импорта файла `sourceFile` на прайс `all`. Без файла (`undefined`) - весь
 * прайс, как до поддержки нескольких прайсов у поставщика. Правило то же, что у репозитория
 * (`planSourceReplacement`, включая историю файлов поставщика), иначе проверка и запись разошлись бы.
 */
export function sourceScopeOf(
  all: readonly PriceItem[],
  sourceFile: string | undefined,
  history?: readonly string[],
  incoming: readonly PriceItem[] = [],
  fileHashMatch = false,
): SourceScope {
  if (sourceFile === undefined) {
    return { replaced: [...all], newerFile: null, otherKeys: new Set() };
  }
  const existing = all.map((item) => item.sourceFile ?? null);
  const plan = planSourceReplacement(existing, sourceFile, history, fileHashMatch);
  const files = new Set(plan.replaceFiles);
  // Как в репозитории: без доказательства строки без файла заменяются построчно. Остальные
  // чужие - в otherKeys, иначе они выглядели бы «снятыми» из-за импорта соседнего файла.
  const matched = plan.replaceNull
    ? new Set<string>()
    : matchedNullRowKeys(
        all.filter((item) => item.sourceFile === undefined),
        incoming,
      );
  const replaced: PriceItem[] = [];
  const otherKeys = new Set<string>();
  for (const item of all) {
    const own =
      item.sourceFile === undefined
        ? plan.replaceNull || matched.has(priceItemKey(item))
        : files.has(item.sourceFile);
    if (own) replaced.push(item);
    else otherKeys.add(priceItemKey(item));
  }
  return { replaced, newerFile: plan.newerFile, otherKeys };
}

/**
 * Подтверждённые цены в пределах файла: позиции, которые есть только в чужих файлах поставщика,
 * в сравнение не попадают, иначе они выглядели бы «снятыми» из-за импорта соседнего файла.
 */
export function confirmedInScope(
  confirmed: readonly PriceItem[],
  scope: SourceScope,
): PriceItem[] {
  if (scope.otherKeys.size === 0) return [...confirmed];
  const own = new Set(scope.replaced.map((item) => priceItemKey(item)));
  return confirmed.filter((item) => {
    const key = priceItemKey(item);
    return !scope.otherKeys.has(key) || own.has(key);
  });
}
