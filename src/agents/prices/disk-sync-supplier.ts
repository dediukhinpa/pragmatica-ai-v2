import { normalizePriceStalePrefix } from '../../kit/domain/price-stale-scope';
import { supplierSearchName } from '../../kit/domain/price-draft-name';
import { type Supplier } from '../../kit/domain/models';
import type { FileEntry } from '@business-ai/core';
import { baseName } from '@business-ai/core';
import { buildSupplierNameIndex, nameTokens } from '../shared/supplier-name-index';
import type { PricesDeps } from './deps';
import { readPricePage } from './read-price-file';
import { diskPriceSource, type PriceSource } from './price-sources';

/**
 * Определение поставщика файла с диска КОДОМ тика, до постановки поручения агенту (этап 145).
 * Раньше поставщика находил и заводил сама модель; теперь карточка создаётся только по
 * надёжному названию (папка поставщика или шапка файла), а там, где без догадки не обойтись,
 * прайс не импортируется и сотрудника спрашивают.
 *
 * Признаки по порядку: (а) папка поставщика на диске; (б) имя файла - только вспомогательный
 * признак, одно оно НЕ надёжно; (в) название и ИНН в шапке файла. Сопоставление с базой: по
 * ИНН, затем по ядру названия (`supplier-name-index`: регистр, кавычки, `ё`, ООО/ИП/АО).
 */

/** Результат определения поставщика файла. */
export type DiskFileSupplier =
  | { kind: 'found'; supplierId: string }
  | { kind: 'create'; name: string; inn?: string | undefined }
  | { kind: 'ask'; candidates: string[]; candidateIds: string[] };

/** Корневая папка с поставщиками на диске: `produkciya/<Поставщик>/...`. */
const PRODUCT_ROOT_FOLDER = 'produkciya';
/** Сколько знаков начала файла просматривается в поисках реквизитов шапки. */
const HEADER_SCAN_CHARS = 4_000;
/** Сколько знаков перед ИНН просматривается в поисках названия покупателя. */
const BUYER_LOOKBEHIND_CHARS = 120;
/** Покупатель - мы: его название и ИНН в шапке поставщиком не считаются. */
const BUYER_CORE = 'прагматик';
/** Сколько вариантов называть в вопросе сотруднику. */
export const SUPPLIER_ASK_MAX_CANDIDATES = 5;
/** Папки, не называющие поставщика. */
const GENERIC_FOLDERS: ReadonlySet<string> = new Set([
  'прайс',
  'прайсы',
  'прайслист',
  'прайслисты',
  'прайс листы',
  'новые',
  'новое',
  'актуальные',
  'актуальное',
  'price',
  'prices',
  'files',
  'загрузки',
  'разное',
  'прочее',
  'другое',
  'остальное',
  'общее',
  'общие',
]);
/** Наименьшее число букв в надёжном названии. */
const MIN_RELIABLE_LETTERS = 3;

const INN_RE = /ИНН(?:\s*\/\s*КПП)?[\s:№.|]*(\d{12}|\d{10})(?!\d)/giu;
const QUOTED_NAME = '[«"“„]([^»"”“\\n|]{2,80})[»"”“]';
const PLAIN_NAME = '([А-ЯЁ][А-Яа-яЁё-]+(?:\\s+[А-ЯЁ][А-Яа-яЁё-]+){0,2})';
const ORG_NAME_RE = new RegExp(
  `(?<![\\p{L}])(ООО|ЗАО|ПАО|ОАО|АО|ИП)\\s*(?:${QUOTED_NAME}|${PLAIN_NAME})`,
  'gu',
);

/** Реквизиты из шапки файла. */
export interface PriceHeader {
  name?: string | undefined;
  inn?: string | undefined;
}

/** Пригодно ли название как надёжное: есть буквы и не общее слово. */
function isReliableName(name: string): boolean {
  const letters = name.match(/\p{L}/gu)?.length ?? 0;
  if (letters < MIN_RELIABLE_LETTERS) return false;
  return !GENERIC_FOLDERS.has(nameTokens(name).join(' '));
}

/** Реквизиты шапки по тексту первой страницы файла (чистая функция). */
export function extractPriceHeader(markdown: string): PriceHeader {
  const text = markdown.slice(0, HEADER_SCAN_CHARS);
  const lowered = text.toLowerCase();
  let inn: string | undefined;
  for (const match of text.matchAll(INN_RE)) {
    const at = match.index ?? 0;
    const before = lowered.slice(Math.max(0, at - BUYER_LOOKBEHIND_CHARS), at);
    // ИНН, стоящий сразу после названия покупателя, - не поставщика.
    if (before.includes(BUYER_CORE) && !before.includes('поставщик')) continue;
    inn = match[1];
    break;
  }
  let name: string | undefined;
  for (const match of text.matchAll(ORG_NAME_RE)) {
    const core = (match[2] ?? match[3] ?? '').trim();
    if (core === '' || nameTokens(core).join(' ').includes(BUYER_CORE)) continue;
    name = `${match[1] ?? ''} ${core}`.trim();
    break;
  }
  return { name, inn };
}

/**
 * Название поставщика по папке диска: первая папка после `produkciya/` (или после заданного
 * префикса области) при условии, что файл лежит в ней, а не рядом с ней. Нет пригодной
 * папки - `null`.
 */
export function supplierFolderName(
  path: string,
  prefixes: readonly string[] = [],
): string | null {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
  let rest = normalized;
  const prefix = prefixes
    .map(normalizePriceStalePrefix)
    .find((item) => item !== '' && normalized.toLowerCase().startsWith(item.toLowerCase()));
  const rootPrefix = `${PRODUCT_ROOT_FOLDER}/`;
  if (prefix !== undefined) rest = normalized.slice(prefix.length);
  else if (normalized.toLowerCase().startsWith(rootPrefix)) {
    rest = normalized.slice(rootPrefix.length);
  }
  const parts = rest.split('/').filter((part) => part !== '');
  // Первая часть - папка поставщика, только если за ней есть ещё и файл.
  const folder = parts.length >= 2 ? parts[0] : undefined;
  if (folder === undefined) return null;
  const cleaned = supplierSearchName(folder);
  return cleaned !== '' && isReliableName(cleaned) ? cleaned : null;
}

/** Шапка файла; сбой чтения (скан, битый файл) - пустая шапка: решение тогда по папке. */
export async function readDiskFileHeader(
  deps: PricesDeps,
  entry: FileEntry,
): Promise<PriceHeader> {
  const source: PriceSource = diskPriceSource(deps, entry);
  try {
    const page = await readPricePage(deps, source, undefined);
    return extractPriceHeader(page.markdown);
  } catch {
    return {};
  }
}

/** Ядро названия одной строкой: по нему сравниваются «ООО «Ромашка»» и «ромашка». */
function coreOf(name: string): string {
  return nameTokens(name).join(' ');
}

/**
 * Определить поставщика файла. `suppliers` - все поставщики базы (список ведёт вызывающий и
 * дополняет созданными в тике). Не создаёт ничего сам: решение `create` исполняет тик.
 */
export async function resolveDiskFileSupplier(
  deps: PricesDeps,
  suppliers: readonly Supplier[],
  entry: FileEntry,
): Promise<DiskFileSupplier> {
  const header = await readDiskFileHeader(deps, entry);
  const folder = supplierFolderName(entry.path, deps.staleScan?.prefixes ?? []);
  const headerName =
    header.name !== undefined && isReliableName(header.name) ? header.name : undefined;
  // 1. ИНН: самый точный признак.
  if (header.inn !== undefined) {
    const byInn = suppliers.filter((item) => item.inn === header.inn);
    const [only] = byInn;
    if (byInn.length === 1 && only !== undefined) return { kind: 'found', supplierId: only.id };
    if (byInn.length > 1) return askOf(byInn);
  }
  // 2. Ядро названия: папка и шапка (надёжные), потом имя файла (только подсказка).
  const index = buildSupplierNameIndex(suppliers);
  const reliable = [folder, headerName].filter(
    (name): name is string => name !== null && name !== undefined,
  );
  const matched = new Map<string, Supplier>();
  for (const name of reliable) {
    const exact = suppliers.filter((item) => coreOf(item.name) === coreOf(name));
    // Точное совпадение ядра важнее вхождения: «Ромашка» не двусмысленна из-за «Ромашка Опт».
    const hits = exact.length > 0 ? exact : index.find(name);
    for (const item of hits) matched.set(item.id, item);
  }
  if (matched.size === 1) {
    const [only] = [...matched.values()];
    if (only !== undefined) return { kind: 'found', supplierId: only.id };
  }
  if (matched.size > 1) return askOf([...matched.values()]);
  const name = reliable[0];
  if (name !== undefined) return { kind: 'create', name, inn: header.inn };
  // 3. Только имя файла: ненадёжно даже при совпадении, спрашиваем (с вариантами).
  return askOf(index.find(baseName(entry.path)));
}

function askOf(candidates: readonly Supplier[]): DiskFileSupplier {
  const top = candidates.slice(0, SUPPLIER_ASK_MAX_CANDIDATES);
  return {
    kind: 'ask',
    candidates: top.map((item) => item.name),
    candidateIds: top.map((item) => item.id),
  };
}
