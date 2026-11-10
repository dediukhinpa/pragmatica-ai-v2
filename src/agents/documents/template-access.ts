import { DomainError } from '@business-ai/core';
import { extensionOf } from '@business-ai/core';
import { TEMPLATE_EXTENSIONS, type DocumentsDeps } from './deps';

/**
 * Путь без ведущих `./` и обратных слэшей, в NFC: сравнение не зависит от записи. Кириллица
 * «й»/«ё» бывает целым знаком или разложенной (NFD) на SMB и macOS; перечень и путь сводятся
 * к одной форме, иначе разрешённый шаблон не совпал бы с собственным именем.
 */
export function normalizeTemplatePath(path: string): string {
  return path.trim().replaceAll('\\', '/').replace(/^(\.\/)+/, '').normalize('NFC');
}

/** Путь безопасен: относительный, без `..` и пустых сегментов, без ведущего `/`. */
function isSafeRelativePath(path: string): boolean {
  if (path === '' || path.startsWith('/') || /^[a-zA-Z]:/.test(path)) return false;
  return !path.split('/').some((part) => part === '..' || part === '');
}

/**
 * Единое правило доступа к шаблону для чтения и для поиска. Явный перечень: запись с `/` на
 * конце - префикс каталога (только файлы шаблонов по расширению), иначе точный путь. Перечня
 * нет - префикс каталога шаблонов и расширения. Путь с `..` или абсолютный не проходит никогда.
 */
export function isTemplatePathAllowed(deps: DocumentsDeps, rawPath: string): boolean {
  const path = normalizeTemplatePath(rawPath);
  if (!isSafeRelativePath(path)) return false;
  const isTemplateFile = TEMPLATE_EXTENSIONS.includes(extensionOf(path));
  if (deps.templateAllowlist === undefined) {
    return path.startsWith(normalizeTemplatePath(deps.templatesPrefix ?? '')) && isTemplateFile;
  }
  return deps.templateAllowlist.map(normalizeTemplatePath).some((entry) => {
    if (!entry.endsWith('/')) return entry === path;
    // Запись каталога сама должна быть безопасной (без `..`, не корень): иначе не разрешает ничего.
    const dir = entry.slice(0, -1);
    return isSafeRelativePath(dir) && path.startsWith(entry) && isTemplateFile;
  });
}

/** Разрешённый шаблон: нормализованный путь (его же проверяет сервис документов) и байты. */
export interface AllowedTemplate {
  path: string;
  content: Uint8Array;
}

/**
 * Прочитать шаблон, если он в перечне разрешённых. Путь шаблона заполняет модель, поэтому
 * код не доверяет ему: при явном перечне допустимы только его пути, иначе только файлы
 * каталога шаблонов (префикс и расширения те же, что у findTemplate); отсутствующий файл даёт
 * not_found от источника.
 */
export async function readAllowedTemplate(
  deps: DocumentsDeps,
  templatePath: string,
): Promise<AllowedTemplate> {
  const path = normalizeTemplatePath(templatePath);
  const denied = new DomainError(
    'access_denied',
    'Этот шаблон не входит в список разрешённых: выберите шаблон из findTemplate.',
  );
  if (!isTemplatePathAllowed(deps, path)) throw denied;
  return { path, content: await readByNormalizedPath(deps, path) };
}

/**
 * Читает файл по пути в NFC. Если на диске имя хранится в другой форме Юникода (NFD) и прямое
 * чтение не нашло файл, берётся его настоящее имя из списка файлов.
 */
async function readByNormalizedPath(deps: DocumentsDeps, path: string): Promise<Uint8Array> {
  try {
    return await deps.files.read(path);
  } catch (error) {
    if (!(error instanceof DomainError) || error.code !== 'not_found') throw error;
    const actual = (await deps.files.list()).find(
      (entry) => normalizeTemplatePath(entry.path) === path,
    );
    if (actual === undefined || actual.path === path) throw error;
    return deps.files.read(actual.path);
  }
}
