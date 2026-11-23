/**
 * Область еженедельной проверки устаревших прайсов: префиксы путей и исключения по сегментам.
 * Чистые функции, без обращения к диску. Действуют только на проверку, не на инструменты
 * агента и не на корень диска (`PRICES_FILES_ROOT`).
 */

/** Исключение по умолчанию: папки «Архив» и «НЕ БРАТЬ» (регистр не важен). */
export const DEFAULT_PRICE_STALE_EXCLUDE_PATTERN = 'архив|не брать';

/** Разделитель списка префиксов в настройке. */
export const PRICE_STALE_PREFIX_SEPARATOR = ',';

/** Настройки области проверки (уже разобранные конфигом). */
export interface PriceStaleScopeOptions {
  /** Префиксы путей от корня диска; пусто - весь корень. */
  prefixes: readonly string[];
  /** Регулярное выражение по сегментам пути (без учёта регистра); нет - без исключений. */
  excludePattern?: string | undefined;
}

/** Путь с единым разделителем `/` и без ведущего `/`. */
function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '');
}

/**
 * Префикс из настройки: единый разделитель, без ведущего `/`; `produkciya` и `produkciya/`
 * означают одну папку (граница по сегменту, а не по началу строки).
 */
export function normalizePriceStalePrefix(prefix: string): string {
  const normalized = normalizePath(prefix.trim()).replace(/\/+$/, '');
  return normalized === '' ? '' : `${normalized}/`;
}

/**
 * Проверить регулярное выражение исключений.
 *
 * @returns Текст ошибки или `null`, если выражение корректно.
 */
export function validatePriceStalePattern(pattern: string): string | null {
  try {
    new RegExp(pattern, 'iu');
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'некорректное регулярное выражение';
  }
}

/** Файл-блокировка Office: базовое имя (не папка) начинается с `~$`. */
export function isOfficeLockFile(path: string): boolean {
  return normalizePath(path).split('/').pop()?.startsWith('~$') ?? false;
}

/**
 * Предикат «путь входит в область проверки»: путь начинается с одного из префиксов (если они
 * заданы) и ни один его сегмент (папки и имя файла) не подходит под выражение исключений.
 */
export function createPriceStaleScope(options: PriceStaleScopeOptions): (path: string) => boolean {
  const prefixes = options.prefixes.map(normalizePriceStalePrefix).filter((p) => p !== '');
  const exclude =
    options.excludePattern === undefined || options.excludePattern === ''
      ? null
      : new RegExp(options.excludePattern, 'iu');
  return (path) => {
    const normalized = normalizePath(path);
    // Файлы-блокировки Office (`~$...`) - не прайсы: исключаются всегда, независимо от настроек.
    if (isOfficeLockFile(normalized)) return false;
    if (prefixes.length > 0 && !prefixes.some((prefix) => normalized.startsWith(prefix))) {
      return false;
    }
    return exclude === null || !normalized.split('/').some((segment) => exclude.test(segment));
  };
}
