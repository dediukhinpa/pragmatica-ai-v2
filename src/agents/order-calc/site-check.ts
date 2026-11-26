import { z } from 'zod';
import {
  isDomainError,
  mapPool,
  readState,
  runAuditedWebUrlRead,
  stableHash,
  toStoredJson,
} from '@business-ai/core';
import type { ToolContext, WebPageReadOutcome } from '@business-ai/core';
import {
  SITE_CHECK_STATUSES,
  type ShortlistEntry,
  type SiteCheck,
  type SiteCheckStatus,
} from '../../kit/domain/shortlist';
import type { OrderCalcDeps } from './deps';

/**
 * Проверка сайтов показанных поставщиков (замечания заказчика 26.11.2026): в шорт-листе сайт
 * карточки показывается, только если ссылка открывается, а не битая. Читается одна главная
 * страница тем же читателем, что и обогащение (`runAuditedWebUrlRead`: защита адреса от
 * служебных сетей, предел времени и редиректов, аудит расхода; лимит хода не тратится - это
 * служебное чтение, как у реестров). Исход кэшируется: «открывается» на неделю, «не
 * открывается» на сутки, «не удалось проверить» не кэшируется.
 */

export const SITE_CHECK_NAMESPACE = 'order-calc:site-check';
/** Сколько дней верить «сайт открывается». */
export const SITE_CHECK_OK_CACHE_DAYS = 7;
/** Сколько дней верить «сайт не открывается»: адрес в карточке могут исправить. */
export const SITE_CHECK_BROKEN_CACHE_DAYS = 1;
/** Предел ожидания одной проверки (оба варианта адреса), мс: сборка шорт-листа не ждёт дольше. */
export const SITE_CHECK_TIMEOUT_MS = 6_000;
/** Одновременно проверяемых сайтов: вся страница шорт-листа (10 строк) разом. */
export const SITE_CHECK_CONCURRENCY = 10;
const MS_PER_DAY = 86_400_000;

/**
 * Сайт ответил, хотя текста не отдал: редирект на другой домен, файл вместо страницы, пустая
 * страница (сайт на скриптах). В браузере такая ссылка открывается.
 */
const OPENS_CODES: ReadonlySet<string> = new Set([
  'redirect_off_site',
  'unsupported_content_type',
  'no_content',
]);
/**
 * Ссылка не открывается: домена нет, сервер не принимает соединение (в том числе ошибка
 * сертификата), адрес негодный или ведёт во внутреннюю сеть.
 */
const BROKEN_CODES: ReadonlySet<string> = new Set([
  'dns_failed',
  'url_not_accessible',
  'invalid_domain',
  'url_not_allowed',
]);
/**
 * Остальное (`http_error` - это и 404, и защита от роботов 403; таймаут; цикл редиректов) -
 * «не удалось проверить»: живой сайт под защитой от роботов битым не называем.
 */

const HTTP_SCHEME = /^https?:\/\//iu;
/** Разделители, если в поле сайта записано несколько адресов. */
const SITE_SEPARATORS = /[\s,;]+/u;

const cacheSchema = z.object({
  status: z.enum(SITE_CHECK_STATUSES),
  url: z.string().min(1),
  checkedAt: z.string().min(1),
});

/** Исход чтения главной страницы как вердикт проверки сайта. */
export function classifySiteOutcome(outcome: WebPageReadOutcome): SiteCheckStatus {
  if (outcome.status === 'ok') return 'ok';
  const code = outcome.failureCode ?? '';
  if (OPENS_CODES.has(code)) return 'ok';
  return BROKEN_CODES.has(code) ? 'broken' : 'unknown';
}

/**
 * Варианты адреса для проверки: первый адрес поля, со схемой - как записан, затем с другой
 * схемой; без схемы - сначала https, потом http. Негодный адрес - пустой список.
 */
export function siteUrlVariants(raw: string): string[] {
  const first = raw.trim().split(SITE_SEPARATORS)[0] ?? '';
  if (first === '') return [];
  const withScheme = HTTP_SCHEME.test(first) ? first : `https://${first}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return [];
  }
  if (!url.hostname.includes('.')) return [];
  const other = new URL(url.href);
  other.protocol = url.protocol === 'https:' ? 'http:' : 'https:';
  return [url.href, other.href];
}

/** Какой сайт строки проверять: сайт карточки, иначе найденный обогащением. */
export function siteToCheck(
  entry: ShortlistEntry,
): { raw: string; origin: SiteCheck['origin'] } | undefined {
  // Веб-кандидат показывает адрес найденной страницы: она только что открылась поиску.
  if (entry.references.some((item) => HTTP_SCHEME.test(item))) return undefined;
  if (entry.website !== undefined) return { raw: entry.website, origin: 'card' };
  const found = entry.webEnrichment?.site;
  return found === undefined ? undefined : { raw: found, origin: 'web' };
}

async function loadCached(
  deps: OrderCalcDeps,
  key: string,
): Promise<z.infer<typeof cacheSchema> | null> {
  let cached: z.infer<typeof cacheSchema> | null;
  try {
    cached = await readState(deps.state, SITE_CHECK_NAMESPACE, key, cacheSchema);
  } catch {
    // Повреждённая запись - как будто её нет: проверка дешевле сбоя сборки.
    return null;
  }
  if (cached === null || cached.status === 'unknown') return null;
  const days = cached.status === 'ok' ? SITE_CHECK_OK_CACHE_DAYS : SITE_CHECK_BROKEN_CACHE_DAYS;
  const age = deps.clock.now().getTime() - Date.parse(cached.checkedAt);
  if (!Number.isFinite(age) || age < 0 || age >= days * MS_PER_DAY) return null;
  return cached;
}

/** Проверить варианты адреса по порядку: первый открывшийся - ответ. */
async function checkVariants(
  deps: OrderCalcDeps,
  context: ToolContext,
  variants: readonly string[],
): Promise<{ status: SiteCheckStatus; url: string }> {
  const signal =
    context.signal === undefined
      ? AbortSignal.timeout(SITE_CHECK_TIMEOUT_MS)
      : AbortSignal.any([context.signal, AbortSignal.timeout(SITE_CHECK_TIMEOUT_MS)]);
  const bounded: ToolContext = { ...context, signal };
  let verdict: { status: SiteCheckStatus; url: string } | undefined;
  for (const url of variants) {
    if (signal.aborted) break;
    const outcome = await runAuditedWebUrlRead(deps, bounded, url, { charge: false });
    const status = classifySiteOutcome(outcome);
    if (status === 'ok') return { status, url };
    // «Не удалось проверить» важнее «не открывается»: битым сайт называем, только если все
    // варианты отказали явно. Из равных - первый вариант (https).
    if (verdict === undefined || (status === 'unknown' && verdict.status !== 'unknown')) {
      verdict = { status, url };
    }
  }
  const [first = ''] = variants;
  return verdict ?? { status: 'unknown', url: first };
}

/** Код сбоя для журнала: код ошибки домена либо имя класса, без текста. */
function failureCode(error: unknown): string {
  if (isDomainError(error)) return error.code;
  return error instanceof Error ? error.name : 'unexpected';
}

/** Счётчики проверки для журнала (без адресов). */
interface SiteCheckStats {
  checked: number;
  cached: number;
  ok: number;
  broken: number;
  unknown: number;
}

/**
 * Проверить сайты показанных строк и записать исход в `siteCheck`. Порядок строк прежний;
 * сбой проверки строку не убирает (исход «не удалось проверить»). Читателя страниц нет -
 * строки как есть (сайт карточки показывается без проверки).
 */
export async function checkShownSites(
  deps: OrderCalcDeps,
  context: ToolContext,
  entries: readonly ShortlistEntry[],
): Promise<ShortlistEntry[]> {
  if (deps.webPageReader?.readUrl === undefined) return [...entries];
  const stats: SiteCheckStats = { checked: 0, cached: 0, ok: 0, broken: 0, unknown: 0 };
  const results = await mapPool(entries, SITE_CHECK_CONCURRENCY, async (entry) => {
    const site = siteToCheck(entry);
    const variants = site === undefined ? [] : siteUrlVariants(site.raw);
    const [first] = variants;
    if (site === undefined || first === undefined) return entry;
    const key = stableHash(first);
    const cached = await loadCached(deps, key);
    let result: { status: SiteCheckStatus; url: string; checkedAt: string };
    if (cached !== null) {
      stats.cached += 1;
      result = cached;
    } else {
      stats.checked += 1;
      try {
        result = {
          ...(await checkVariants(deps, context, variants)),
          checkedAt: deps.clock.now().toISOString(),
        };
      } catch (error) {
        if (context.signal?.aborted === true) throw error;
        deps.log?.('shortlist_site_check_failed', { code: failureCode(error) });
        result = { status: 'unknown', url: first, checkedAt: deps.clock.now().toISOString() };
      }
      if (result.status !== 'unknown') {
        // `done`: кэш, а не живое состояние - уберёт обычная ретенция; срок - по `checkedAt`.
        await deps.state.put(SITE_CHECK_NAMESPACE, key, toStoredJson(result), { done: true });
      }
    }
    stats[result.status] += 1;
    const siteCheck: SiteCheck = { ...result, origin: site.origin };
    return { ...entry, siteCheck };
  });
  if (stats.checked > 0 || stats.cached > 0) {
    // Только числа: без адресов и названий поставщиков.
    deps.log?.('shortlist_site_check', { ...stats });
  }
  return results;
}
