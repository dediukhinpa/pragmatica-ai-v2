import { isDomainError } from '@business-ai/core';
import type { SiteExportDeps } from './deps';

/**
 * Чистый шаблон заказчика с диска (только чтение). Путь задаёт оператор (`SITE_TEMPLATE_PATH`,
 * от корня шаблонов), агент путь не выбирает: так он не может прочитать с диска ничего другого.
 * Выход за корень, `..` и символические ссылки отсекает сам источник файлов (LocalFileSource).
 */

/** Код отказа: файла шаблона нет. Агент в ответ просит сотрудника прислать шаблон в чат. */
export const TEMPLATE_NOT_FOUND = 'template_not_found';

/** Результат чтения шаблона с диска. */
export type SiteTemplateRead =
  | { status: 'ok'; path: string; bytes: Uint8Array }
  | { status: typeof TEMPLATE_NOT_FOUND; message: string };

const NOT_SET_MESSAGE =
  'Шаблон сайта на диске не настроен. Попросите сотрудника прислать файл шаблона в чат.';
const MISSING_MESSAGE =
  'Файл шаблона сайта на диске не найден. Попросите сотрудника прислать файл шаблона в чат.';

/**
 * Прочитать шаблон сайта с диска. Нет настройки, нет файла - `template_not_found`. Сбой диска
 * (шара недоступна, файл слишком велик) пробрасывается как DomainError: это не «шаблона нет».
 */
export async function readSiteTemplate(
  deps: Pick<SiteExportDeps, 'templateFiles' | 'siteTemplatePath'>,
): Promise<SiteTemplateRead> {
  const path = deps.siteTemplatePath;
  if (deps.templateFiles === undefined || path === undefined || path === '') {
    return { status: TEMPLATE_NOT_FOUND, message: NOT_SET_MESSAGE };
  }
  try {
    return { status: 'ok', path, bytes: await deps.templateFiles.read(path) };
  } catch (error) {
    if (isDomainError(error) && error.code === 'not_found') {
      return { status: TEMPLATE_NOT_FOUND, message: MISSING_MESSAGE };
    }
    throw error;
  }
}
