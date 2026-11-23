import { z } from 'zod';
import {
  companyNameFromDomain,
  hostOfUrl,
  isForeignHost,
  isMarketplaceHost,
  registrableDomain,
  requestMentionsImport,
} from '@business-ai/core';
import { type PurchaseRequest } from '../../kit/domain/models';
import { type SupplierCandidate } from '../../kit/domain/shortlist';
import type { WebHitDigest } from '../../kit/ports/web-candidate-model';
import type { ToolContext } from '@business-ai/core';
import { externalQueryProblem, requirementsForModel } from '@business-ai/core';
import type { OrderCalcDeps } from './deps';
import { loadCompleteness } from './state';
import { codeOf, withTimeout, type WebFound } from './web-enrichment';

/**
 * Выдача веба -> компании. Хиты поиска - это страницы, а сотрудник выбирает поставщиков, поэтому
 * код (1) отсеивает площадки и зарубежные домены, (2) склеивает хиты одного сайта в одного
 * кандидата со всеми ссылками, (3) одним вызовом модели отсеивает «не тот товар» и тару и
 * называет компанию. Модель тут только классифицирует и только через шлюз псевдонимизации;
 * сбой модели не убирает кандидатов (остаются после шагов кода, название - по домену).
 */

/** Типы сайта в ответе классификатора. */
export const WEB_HIT_TYPES = ['производитель', 'оптовик', 'магазин', 'тара', 'прочее'] as const;
type WebHitType = (typeof WEB_HIT_TYPES)[number];

/** Тип, который отсеивается всегда: банки и пакеты для товара - не поставщик самого товара. */
const DROPPED_TYPE: WebHitType = 'тара';

/** Вес типа в оценке: производитель и оптовик нужнее магазина (закупка партией). */
const TYPE_WEIGHT: Readonly<Record<WebHitType, number>> = {
  производитель: 1,
  оптовик: 0.9,
  магазин: 0.6,
  тара: 0,
  прочее: 0.4,
};
/** Доля места в выдаче и доля типа в итоговой оценке классифицированного кандидата. */
const RANK_SHARE = 0.5;
const TYPE_SHARE = 1 - RANK_SHARE;

/** Сколько доменов уходит на классификацию за вызов (лучшие по месту в выдаче). */
export const WEB_CLASSIFY_MAX_DOMAINS = 40;
/** Пределы текстов хита в запросе к модели (знаки): экономия токенов и меньше чужого текста. */
/**
 * Если классификатор отсеял больше этой доли доменов (или все), ответ недостоверен: шорт-лист
 * из веба не должен опустеть из-за сбойного ответа модели, откат на результат без модели.
 */
export const WEB_CLASSIFY_MAX_DROP_SHARE = 0.8;
const DIGEST_TITLE_MAX_CHARS = 120;
const DIGEST_SNIPPET_MAX_CHARS = 240;
/** Самое длинное название компании от модели (знаки). */
const COMPANY_NAME_MAX_CHARS = 80;
/** Многоточие в названии = обрезанный заголовок выдачи, такое название не показываем. */
const ELLIPSIS = /\.{2,}|…/;

const WHITESPACE_RUN = /\s+/g;
/** Контакты и ссылки в текстах страниц: в модель не уходят (контакты строит и хранит код). */
const EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[^\s@]+/g;
const URL_PATTERN = /(?:https?:\/\/|www\.)\S+/gi;
const PHONE_PATTERN = /\+?\d[\d\s().-]{7,}\d/g;

/** Проверенный ответ модели по одному домену. */
interface WebHitVerdict {
  relevant: boolean;
  type: WebHitType;
  company?: string | undefined;
}

const verdictSchema = z.object({
  domain: z.string().min(1),
  relevant: z.preprocess(
    (value) => (value === 'да' ? true : value === 'нет' ? false : value),
    z.boolean(),
  ),
  type: z.enum(WEB_HIT_TYPES),
  company: z.string().nullish(),
});
const envelopeSchema = z.object({ results: z.array(z.unknown()) });

/** Текст хита для модели: без контактов и ссылок, схлопнутые пробелы, ограниченная длина. */
function digestText(text: string, maxChars: number): string {
  const clean = text
    .replace(EMAIL_PATTERN, ' ')
    .replace(URL_PATTERN, ' ')
    .replace(PHONE_PATTERN, ' ')
    .replace(WHITESPACE_RUN, ' ')
    .trim();
  return Array.from(clean).slice(0, maxChars).join('');
}

/** Название компании от модели либо undefined: пустое, обрезанное, с контактами, с токенами. */
function cleanCompanyName(raw: string | null | undefined): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  const name = raw.replace(WHITESPACE_RUN, ' ').trim();
  if (name === '' || Array.from(name).length > COMPANY_NAME_MAX_CHARS) return undefined;
  if (ELLIPSIS.test(name) || externalQueryProblem(name) !== null) return undefined;
  if (digestText(name, COMPANY_NAME_MAX_CHARS) !== name) return undefined;
  return name;
}

/**
 * Разбор ответа классификатора. Всё, что не по схеме (не объект, не массив, чужой домен,
 * неизвестный тип), отбрасывается: домен без вердикта остаётся в выдаче. Пустая карта - сбой.
 */
export function parseWebHitVerdicts(
  raw: unknown,
  knownDomains: ReadonlySet<string>,
): Map<string, WebHitVerdict> {
  const verdicts = new Map<string, WebHitVerdict>();
  const envelope = envelopeSchema.safeParse(raw);
  if (!envelope.success) return verdicts;
  for (const item of envelope.data.results) {
    const parsed = verdictSchema.safeParse(item);
    if (!parsed.success) continue;
    const domain = registrableDomain(parsed.data.domain.trim());
    if (!knownDomains.has(domain) || verdicts.has(domain)) continue;
    const company = cleanCompanyName(parsed.data.company);
    verdicts.set(domain, {
      relevant: parsed.data.relevant,
      type: parsed.data.type,
      ...(company === undefined ? {} : { company }),
    });
  }
  return verdicts;
}

/** Хиты одного сайта: лучший (по оценке) и остальные ссылки. */
interface DomainGroup {
  domain: string;
  best: WebFound;
  /** Адреса всех хитов сайта без повторов, лучший первым. */
  urls: string[];
  score: number;
}

/** Склейка хитов по регистрируемому домену; порядок - по оценке лучшего хита. */
function groupByDomain(found: readonly WebFound[]): DomainGroup[] {
  const groups = new Map<string, DomainGroup>();
  for (const item of found) {
    const domain = registrableDomain(item.hit.url);
    const group = groups.get(domain);
    if (group === undefined) {
      groups.set(domain, { domain, best: item, urls: [item.hit.url], score: item.candidate.score });
      continue;
    }
    if (!group.urls.includes(item.hit.url)) group.urls.push(item.hit.url);
    if (item.candidate.score > group.best.candidate.score) {
      group.best = item;
      group.urls = [item.hit.url, ...group.urls.filter((url) => url !== item.hit.url)];
      group.score = item.candidate.score;
    }
  }
  return [...groups.values()].sort((a, b) => b.score - a.score);
}

/** Тексты заявки, по которым определяется «про импорт»: позиции и значения полей формы. */
async function requestTexts(deps: OrderCalcDeps, request: PurchaseRequest): Promise<string[]> {
  const completeness = await loadCompleteness(deps, request.id).catch(() => null);
  return [
    ...request.items.map((item) => item.name),
    ...Object.values(completeness?.values ?? {}),
  ];
}

/** Вердикт отсева: нерелевантен или тип «тара». */
function isRejected(verdict: WebHitVerdict): boolean {
  return !verdict.relevant || verdict.type === DROPPED_TYPE;
}

/**
 * Классификация доменов одним вызовом. `null` - не вызывали или сбой/невалидный ответ:
 * вызывающий код оставляет кандидатов как есть. Позиции с ПДн в запрос не берутся (та же
 * проверка, что у веб-запросов); не осталось ни одной - модель не вызывается.
 */
async function classifyDomains(
  deps: OrderCalcDeps,
  context: ToolContext,
  request: PurchaseRequest,
  groups: readonly DomainGroup[],
): Promise<Map<string, WebHitVerdict> | null> {
  const classifier = deps.webClassifier;
  if (classifier === undefined || groups.length === 0) return null;
  const items = request.items
    .filter((item) => externalQueryProblem(item.name) === null)
    .map((item) => {
      const requirements = requirementsForModel(item.requirements);
      return {
        name: item.name,
        ...(item.quantity === undefined ? {} : { quantity: item.quantity }),
        unit: item.unit,
        ...(requirements === undefined ? {} : { requirements }),
      };
    });
  if (items.length === 0) return null;
  const sent = groups.slice(0, WEB_CLASSIFY_MAX_DOMAINS);
  const hits: WebHitDigest[] = sent.map((group) => ({
    domain: group.domain,
    title: digestText(group.best.hit.title, DIGEST_TITLE_MAX_CHARS),
    snippet: digestText(group.best.hit.snippet, DIGEST_SNIPPET_MAX_CHARS),
  }));
  try {
    const raw = await withTimeout(
      (signal) => classifier.classify({ items, hits }, { signal }),
      context.signal,
    );
    const verdicts = parseWebHitVerdicts(raw, new Set(sent.map((group) => group.domain)));
    deps.log?.('web_hit_classify', { sent: hits.length, answered: verdicts.size });
    if (verdicts.size === 0) return null;
    const rejected = [...verdicts.values()].filter(isRejected).length;
    // Доля считается от отправленных доменов: без вердикта домен остаётся в выдаче.
    if (rejected === sent.length || rejected / sent.length > WEB_CLASSIFY_MAX_DROP_SHARE) {
      deps.log?.('web_hit_classify_implausible', { sent: sent.length, rejected });
      return null;
    }
    return verdicts;
  } catch (error) {
    deps.log?.('web_hit_classify_failed', { code: codeOf(error) });
    return null;
  }
}

/** Итог обработки выдачи. */
export interface RefinedWebHits {
  /** По одному кандидату на сайт (лучший хит): их и обогащают. */
  primary: WebFound[];
  /** Остальные ссылки тех же сайтов: кандидаты с тем же названием, при слиянии копят ссылки. */
  extras: SupplierCandidate[];
}

/**
 * Отсев, склейка и классификация хитов веб-выдачи (см. описание модуля). Название кандидата -
 * компания от модели, запасное - домен; заголовок выдачи названием не служит.
 */
export async function refineWebHits(
  deps: OrderCalcDeps,
  context: ToolContext,
  request: PurchaseRequest,
  found: readonly WebFound[],
): Promise<RefinedWebHits> {
  // Зарубежные зоны режем, только если заявка не про импорт: иначе «из Китая» дал бы пустоту.
  const allowForeign = requestMentionsImport(await requestTexts(deps, request));
  const usable = found.filter(({ hit }) => {
    // Площадку определяем по полному хосту: `market.yandex.ru` - маркетплейс, `yandex.ru` - нет.
    const host = hostOfUrl(hit.url);
    if (host === '' || isMarketplaceHost(host)) return false;
    return allowForeign || !isForeignHost(host);
  });
  const groups = groupByDomain(usable);
  const verdicts = await classifyDomains(deps, context, request, groups);
  const primary: WebFound[] = [];
  const extras: SupplierCandidate[] = [];
  let dropped = 0;
  for (const group of groups) {
    const verdict = verdicts?.get(group.domain);
    if (verdict !== undefined && isRejected(verdict)) {
      dropped += 1;
      continue;
    }
    const name = verdict?.company ?? companyNameFromDomain(group.domain);
    const score =
      verdict === undefined
        ? group.score
        : group.score * RANK_SHARE + TYPE_WEIGHT[verdict.type] * TYPE_SHARE;
    primary.push({
      candidate: { name, reference: group.best.hit.url, score },
      hit: group.best.hit,
    });
    for (const url of group.urls.slice(1)) extras.push({ name, reference: url, score });
  }
  deps.log?.('web_hits_refined', {
    hits: found.length,
    marketplaceOrForeign: found.length - usable.length,
    domains: groups.length,
    droppedByModel: dropped,
    kept: primary.length,
  });
  return { primary, extras };
}
