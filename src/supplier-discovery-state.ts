import { z } from 'zod';
import { writeState } from '@business-ai/core';
import type { WorkflowStateStore } from '@business-ai/core';
import { HOUR_MS } from './kit/domain/time';

/**
 * Состояние режима «пополнение базы поставщиков» (этап 8z, раздел B). Хранится по треду чата
 * сотрудника: список найденных в интернете кандидатов с номерами, чтобы «заведи 1, 3, 5» и
 * «покажи ещё» опирались на тот же список, а не искали заново.
 *
 * Что хранится и чего нет. Тексты страниц НЕ хранятся: у кандидата лежат только факты, которые
 * код уже извлёк и проверил по тексту страницы (название, сайт, ИНН с верной контрольной
 * суммой, телефоны и почты компании, город, категория), и `evidence` - выжимка из этих же
 * фактов строками «как на странице». Причина: общий разбор письма (`mergeExtracted` в
 * `prepareSupplierCard`) добавил бы в карточку из полного текста страницы ФИО сотрудников,
 * личные почты и ИП-названия, а по правилам защиты ПДн они в карточку не идут. Запись идёт
 * через `prepareSupplierCard` с `sourceText = evidence`, поэтому проверка происхождения
 * значений (`enforceSourceProvenance`) всё равно срабатывает на записи.
 *
 * Запись помечена `done`, поэтому ретенция состояния уберёт её по сроку без записи; свой срок
 * жизни - `SUPPLIER_DISCOVERY_TTL_MS`: просроченное состояние читается как отсутствующее.
 */

/** Пространство имён состояния пополнения базы; ключ - тред чата. */
export const SUPPLIER_DISCOVERY_NAMESPACE = 'order-calc:supplier-discovery';

/** Срок жизни списка кандидатов: за это время сотрудник успевает ответить «заведи 1, 3». */
export const SUPPLIER_DISCOVERY_TTL_MS = 6 * HOUR_MS;

/** Сколько платных поисков в интернете разрешено на одно состояние (один запрос сотрудника). */
export const DISCOVERY_SEARCHES_MAX = 4;

/** Сколько кандидатов хранится в состоянии: дальше список считается исчерпанным. */
export const DISCOVERY_CANDIDATES_MAX = 60;

/** Длиннее выжимка не хранится: название, два адреса и несколько контактов короче. */
export const DISCOVERY_EVIDENCE_MAX_CHARS = 2000;

/** Кандидат из интернета: проверенные факты и ссылка на источник. */
const candidateSchema = z.object({
  /** Номер в списке для сотрудника; сквозной по всем порциям состояния. */
  number: z.number().int().positive(),
  name: z.string().min(1),
  /** Название взято со страницы (юрлицо с формой или заголовок), а не по домену. */
  nameConfirmed: z.boolean(),
  /** Корень сайта (схема и хост): попадает в поле «сайт» карточки. */
  website: z.string().min(1),
  /** Регистрируемый домен сайта: ключ отсева известных. */
  domain: z.string().min(1),
  /** Страница, на которой найдены сведения: попадает в заметку карточки. */
  sourceUrl: z.string().min(1),
  /** ИНН юрлица (10 цифр) только с верной контрольной суммой. */
  inn: z.string().optional(),
  phones: z.array(z.string()),
  /** Только корпоративные ролевые адреса (`info@`, `sales@`): личные почты не хранятся. */
  emails: z.array(z.string()),
  city: z.string().optional(),
  /** Категория (слова запроса), подтверждённая текстом страницы; иначе пусто. */
  categories: z.array(z.string()),
  evidence: z.string(),
  /** Кандидат уже показан сотруднику списком. */
  shown: z.boolean(),
});
export type DiscoveredCandidate = z.infer<typeof candidateSchema>;

const stateSchema = z.object({
  queryKey: z.string().min(1),
  query: z.string().min(1),
  region: z.string().optional(),
  createdAt: z.string().min(1),
  expiresAt: z.string().min(1),
  /** Сколько платных поисков уже выполнено (предел - `DISCOVERY_SEARCHES_MAX`). */
  searchesDone: z.number().int().nonnegative(),
  /** Новых кандидатов по этому запросу больше не будет (предел поисков или пустая выдача). */
  exhausted: z.boolean(),
  nextNumber: z.number().int().positive(),
  /** Ключи идентичности всех уже просмотренных: показанных, кэшированных и известных базе. */
  seenKeys: z.array(z.string()),
  /** Сколько найденных отсеяно как уже известные базе (за всё время состояния). */
  skippedKnown: z.number().int().nonnegative(),
  candidates: z.array(candidateSchema),
});
export type DiscoveryState = z.infer<typeof stateSchema>;

/** Нормализация для ключа запроса: регистр, «ё» и пробелы не различают запросы. */
function normalizeForKey(text: string): string {
  return text.toLowerCase().replaceAll('ё', 'е').replace(/\s+/gu, ' ').trim();
}

/** Ключ запроса: тот же запрос (и регион) продолжает список, другой начинает новый. */
export function discoveryQueryKey(query: string, region: string | undefined): string {
  const regionPart = region === undefined ? '' : normalizeForKey(region);
  return `${normalizeForKey(query)}|${regionPart}`;
}

/** Пустое состояние нового запроса. */
export function newDiscoveryState(input: {
  query: string;
  region?: string | undefined;
  now: Date;
}): DiscoveryState {
  return {
    queryKey: discoveryQueryKey(input.query, input.region),
    query: input.query,
    ...(input.region === undefined ? {} : { region: input.region }),
    createdAt: input.now.toISOString(),
    expiresAt: new Date(input.now.getTime() + SUPPLIER_DISCOVERY_TTL_MS).toISOString(),
    searchesDone: 0,
    exhausted: false,
    nextNumber: 1,
    seenKeys: [],
    skippedKnown: 0,
    candidates: [],
  };
}

/**
 * Состояние треда; null - нет, просрочено или не читается по схеме. Повреждённая или устаревшая
 * по формату запись не ошибка: список просто начинается заново (в отличие от записей, на
 * которых держится подтверждение, тут нечего терять - поиск повторяется).
 */
export async function loadDiscoveryState(
  store: WorkflowStateStore,
  threadId: string,
  now: Date,
): Promise<DiscoveryState | null> {
  const raw = await store.get(SUPPLIER_DISCOVERY_NAMESPACE, threadId);
  if (raw === null) return null;
  const parsed = stateSchema.safeParse(raw);
  if (!parsed.success) return null;
  if (Date.parse(parsed.data.expiresAt) <= now.getTime()) return null;
  return parsed.data;
}

/** Записать состояние; запись `done`: ретенция уберёт её по сроку хранения состояния. */
export async function saveDiscoveryState(
  store: WorkflowStateStore,
  threadId: string,
  state: DiscoveryState,
): Promise<void> {
  await writeState(store, SUPPLIER_DISCOVERY_NAMESPACE, threadId, stateSchema.parse(state), {
    done: true,
  });
}

/** Кандидат по номеру среди уже ПОКАЗАННЫХ сотруднику; иначе undefined. */
export function shownCandidateByNumber(
  state: DiscoveryState,
  number: number,
): DiscoveredCandidate | undefined {
  return state.candidates.find((item) => item.number === number && item.shown);
}
