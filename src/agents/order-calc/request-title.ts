import { z } from 'zod';
import { DEFAULT_BUSINESS_TIMEZONE } from '../../kit/domain/monitoring';
import { DomainError, employeeOfThread, localDateKey } from '@business-ai/core';
import { type RequestItem } from '../../kit/domain/models';
import { stateEntries } from '@business-ai/core';
import type { AnyToolDefinition } from '@business-ai/core';
import { WORK_OWNER_NAMESPACE, readState, writeState } from '@business-ai/core';
import { workSubject } from '../shared/work-owner.owned';
import { SENT_NAMESPACE, STATE_SCAN_MAX_PAGES, STATE_SCAN_PAGE, type OrderCalcDeps } from './deps';
import { activeRequestId } from './active-request';
import { sentSchema } from './state';

/**
 * Человеческое название заявки (этап 125). Сотрудник не читает и не копирует `req-<хэш>`, а
 * модель по-прежнему оперирует id. Название хранится в состоянии, а не в таблице заявок: так
 * не нужна миграция, а старые заявки без названия получают его кодом из позиций при показе.
 * Пространство в `WORKFLOW_STATE_STALE_SCOPE` не входит намеренно: запись пишется один раз при
 * приёме заявки и нужна, пока заявка жива.
 */
export const REQUEST_TITLE_NAMESPACE = 'request-title.v1';

/** Предел длины названия, знаков. */
export const REQUEST_TITLE_MAX_CHARS = 60;
/** Сколько первых позиций идёт в название, собранное кодом. */
const FALLBACK_TITLE_ITEMS = 3;
/** Название заявки, которой нет (id не показываем даже тогда). */
const UNKNOWN_REQUEST_LABEL = 'заявка без названия';
/** Самое короткое название-фрагмент, по которому ищем заявку (иначе «а» найдёт всё). */
const MIN_LOOKUP_CHARS = 3;
/** Сколько заявок показываем в вопросе при неоднозначном названии. */
const AMBIGUOUS_LISTED_MAX = 8;
/** Число цифр подряд, начиная с которого строка похожа на номер/телефон, а не на продукцию. */
const NUMBER_RUN_DIGITS = 5;

const titleRecordSchema = z.object({
  title: z.string().min(1),
  createdAt: z.string().min(1),
  /** Сотрудник, принявший заявку: по нему ищем заявку по названию (чужие не видны). */
  employee: z.string().min(1).optional(),
});
type TitleRecord = z.infer<typeof titleRecordSchema>;

/** Заявка с названием для показа и поиска. */
export interface TitledRequest {
  requestId: string;
  title: string;
  createdAt: string;
}

/** Ключ для сравнения названий: регистр, ё/е, пробелы и крайняя пунктуация не важны. */
export function normalizeTitle(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .replace(/^[\s"'«»(),.;:!-]+|[\s"'«»(),.;:!-]+$/g, '');
}

/** Похоже на ФИО: три слова с заглавной подряд либо «Фамилия И.О.». */
const FULL_NAME = /(?:[А-ЯЁ][а-яё]+\s+){2}[А-ЯЁ][а-яё]+|[А-ЯЁ][а-яё]+\s+[А-ЯЁ]\.\s?[А-ЯЁ]\./;
const EMAIL_OR_ID = /@|\breq-|\bRFQ-|https?:/i;

/** Обрезать по границе слова до предела. */
function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  return (space > limit / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:-]+$/, '');
}

/**
 * Проверить название от модели. Пусто, id, почта, ссылка, номер (много цифр) или ФИО - null
 * (название соберёт код из позиций); длинное обрезается по слову. Проверка кодом: модель
 * могла положить в название то, чего сотруднику показывать нельзя.
 */
export function sanitizeRequestTitle(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const text = raw.replace(/\s+/g, ' ').trim().replace(/^["'«]+|["'»]+$/g, '').trim();
  if (text === '' || EMAIL_OR_ID.test(text) || FULL_NAME.test(text)) return null;
  if (new RegExp(`\\d[\\d\\s().+-]{${NUMBER_RUN_DIGITS - 1},}`).test(text)) return null;
  const clipped = clip(text, REQUEST_TITLE_MAX_CHARS);
  return clipped === '' ? null : clipped;
}

/** Название из первых позиций: «мёд, пледы, коробка» (без количества, артикулов и скобок). */
export function fallbackRequestTitle(items: readonly RequestItem[]): string {
  const names = items
    .slice(0, FALLBACK_TITLE_ITEMS)
    .map((item) => item.name.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((name) => name !== '');
  for (let count = names.length; count >= 1; count -= 1) {
    const joined = names.slice(0, count).join(', ');
    if (joined.length <= REQUEST_TITLE_MAX_CHARS) return joined;
  }
  return clip(names[0] ?? '', REQUEST_TITLE_MAX_CHARS) || UNKNOWN_REQUEST_LABEL;
}

/** Выбрать название: проверенное от модели, иначе собранное кодом. */
export function chooseRequestTitle(
  fromModel: string | undefined,
  items: readonly RequestItem[],
): string {
  return sanitizeRequestTitle(fromModel) ?? fallbackRequestTitle(items);
}

/** `дд.мм` даты создания заявки по часам бизнеса. */
function shortDateOf(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '';
  const [, month = '', day = ''] = localDateKey(new Date(time), DEFAULT_BUSINESS_TIMEZONE).split('-');
  return `${day}.${month}`;
}

/**
 * Подписи заявок одного сотрудника: название; если у нескольких заявок оно одинаково, к
 * каждой добавляется «от дд.мм» (дата создания). Чистая функция: сводка считает её по своему
 * списку, одиночные сообщения - по записям состояния.
 */
export function labelsOf(list: readonly TitledRequest[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const entry of list) {
    const key = normalizeTitle(entry.title);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const labels = new Map<string, string>();
  for (const entry of list) {
    const date = shortDateOf(entry.createdAt);
    const repeated = (counts.get(normalizeTitle(entry.title)) ?? 0) > 1;
    labels.set(entry.requestId, repeated && date !== '' ? `${entry.title} от ${date}` : entry.title);
  }
  return labels;
}

/** Записать название при приёме заявки; без `employee` заявку нельзя найти по названию. */
export async function saveRequestTitle(
  deps: Pick<OrderCalcDeps, 'state'>,
  request: { id: string; createdAt: string },
  title: string,
  threadId: string,
): Promise<void> {
  const existing = await deps.state.get(REQUEST_TITLE_NAMESPACE, request.id);
  // Первое название сохраняется: повторный приём той же заявки его не меняет.
  if (existing !== null) return;
  const employee = employeeOfThread(threadId);
  const record: TitleRecord = {
    title,
    createdAt: request.createdAt,
    ...(employee === null ? {} : { employee }),
  };
  await writeState(deps.state, REQUEST_TITLE_NAMESPACE, request.id, record);
}

/** Название заявки: сохранённое, иначе из позиций (старые заявки); null, если заявки нет. */
export async function titledRequest(
  deps: Pick<OrderCalcDeps, 'state' | 'requests'>,
  requestId: string,
): Promise<TitledRequest | null> {
  const stored = await readState(deps.state, REQUEST_TITLE_NAMESPACE, requestId, titleRecordSchema);
  if (stored !== null) {
    return { requestId, title: stored.title, createdAt: stored.createdAt };
  }
  const request = await deps.requests.get(requestId);
  if (request === null) return null;
  return {
    requestId,
    title: fallbackRequestTitle(request.items),
    createdAt: request.createdAt,
  };
}

/** Записи названий сотрудника (или все, если сотрудник не задан) постранично. */
async function storedTitles(
  deps: Pick<OrderCalcDeps, 'state'>,
  employee: string | null,
): Promise<Array<TitledRequest & { employee?: string | undefined }>> {
  const found: Array<TitledRequest & { employee?: string | undefined }> = [];
  const entries = stateEntries(deps.state, REQUEST_TITLE_NAMESPACE, {
    pageSize: STATE_SCAN_PAGE,
    maxPages: STATE_SCAN_MAX_PAGES,
  });
  for await (const entry of entries) {
    const parsed = titleRecordSchema.safeParse(entry.value);
    if (!parsed.success) continue;
    const { employee: owner, title, createdAt } = parsed.data;
    if (employee !== null && owner !== employee) continue;
    found.push({ requestId: entry.key, title, createdAt, employee: owner });
  }
  return found;
}

/**
 * Подпись заявки для сотрудника: название (с датой, если у него есть заявка с таким же
 * названием). Внутренний идентификатор не показывается никогда: заявки нет - общая подпись.
 */
export async function requestLabel(
  deps: Pick<OrderCalcDeps, 'state' | 'requests'>,
  requestId: string,
): Promise<string> {
  const own = await titledRequest(deps, requestId);
  if (own === null) return UNKNOWN_REQUEST_LABEL;
  const record = await readState(deps.state, REQUEST_TITLE_NAMESPACE, requestId, titleRecordSchema);
  // Сравнивать есть с чем только у заявок с известным сотрудником: у остальных подпись - название.
  if (record?.employee === undefined) return own.title;
  const peers = (await storedTitles(deps, record.employee)).filter(
    (entry) => normalizeTitle(entry.title) === normalizeTitle(own.title),
  );
  const list = peers.some((entry) => entry.requestId === requestId) ? peers : [...peers, own];
  return labelsOf(list).get(requestId) ?? own.title;
}

/**
 * Подписи нескольких заявок для одного сообщения (вопрос о письме, уведомление): названия,
 * а при совпадении названий внутри сообщения - с датой. Заявки нет - общая подпись.
 */
export async function requestLabels(
  deps: Pick<OrderCalcDeps, 'state' | 'requests'>,
  requestIds: readonly string[],
): Promise<Map<string, string>> {
  const titled: TitledRequest[] = [];
  for (const requestId of new Set(requestIds)) {
    const entry = await titledRequest(deps, requestId);
    if (entry !== null) titled.push(entry);
  }
  const labels = labelsOf(titled);
  for (const requestId of requestIds) {
    if (!labels.has(requestId)) labels.set(requestId, UNKNOWN_REQUEST_LABEL);
  }
  return labels;
}

/**
 * Название заявки только по записи состояния (без репозитория заявок): для мест, где под
 * рукой лишь хранилище, например ответ на нажатие кнопки. Нет записи - null.
 */
export async function storedRequestTitle(
  state: Pick<OrderCalcDeps, 'state'>['state'],
  requestId: string,
): Promise<string | null> {
  const record = await readState(state, REQUEST_TITLE_NAMESPACE, requestId, titleRecordSchema);
  return record?.title ?? null;
}

/** Заявки сотрудника: с сохранённым названием и отправленные с его ящика (старые). */
async function employeeRequests(
  deps: Pick<OrderCalcDeps, 'state' | 'requests'>,
  employee: string,
): Promise<TitledRequest[]> {
  const byId = new Map<string, TitledRequest>();
  for (const entry of await storedTitles(deps, employee)) byId.set(entry.requestId, entry);
  const sent = stateEntries(deps.state, SENT_NAMESPACE, {
    pageSize: STATE_SCAN_PAGE,
    maxPages: STATE_SCAN_MAX_PAGES,
  });
  for await (const entry of sent) {
    const parsed = sentSchema.safeParse(entry.value);
    if (!parsed.success || parsed.data.mailboxOwnerId !== employee) continue;
    if (byId.has(parsed.data.requestId)) continue;
    const titled = await titledRequest(deps, parsed.data.requestId);
    if (titled !== null) byId.set(titled.requestId, titled);
  }
  // Заявки, которые сотрудник ведёт, но запросов по ним ещё не отправлял (шорт-лист собран,
  // выбор не сделан): без этого старая заявка без сохранённого названия по названию не
  // находилась, и инструменты отвечали «не найдена» (бой 29.10).
  const orderPrefix = workSubject.order('');
  const owned = stateEntries(deps.state, WORK_OWNER_NAMESPACE, {
    pageSize: STATE_SCAN_PAGE,
    maxPages: STATE_SCAN_MAX_PAGES,
    // Ключи упорядочены: начинаем сразу перед `order:` и останавливаемся на первом чужом.
    after: orderPrefix.slice(0, -1),
    prefix: orderPrefix,
  });
  for await (const entry of owned) {
    const parsed = ownerSchema.safeParse(entry.value);
    if (!parsed.success || employeeOfThread(parsed.data.threadId) !== employee) continue;
    const requestId = entry.key.slice(orderPrefix.length);
    if (requestId === '' || byId.has(requestId)) continue;
    const titled = await titledRequest(deps, requestId);
    if (titled !== null) byId.set(titled.requestId, titled);
  }
  return [...byId.values()];
}

/** Запись владельца работы: только тред (см. `work-owner.ts`). */
const ownerSchema = z.object({ threadId: z.string().min(1) });

/** Хвост «от дд.мм» в названии, которым сотрудник уточняет заявку. */
const DATE_SUFFIX = /\s+от\s+\d{1,2}\.\d{1,2}$/i;

/**
 * Какую заявку имеет в виду ссылка. Известный id возвращается как есть. Иначе ссылка читается
 * как название среди заявок сотрудника этого треда (точное, затем по вхождению); одна
 * найденная - её id; несколько - DomainError со списком, чтобы модель переспросила; ни одной -
 * ссылка без изменений (инструмент сам ответит «не найдена»).
 */
export async function resolveRequestRef(
  deps: Pick<OrderCalcDeps, 'state' | 'requests'>,
  ref: string,
  threadId: string,
): Promise<string> {
  const text = ref.trim();
  if (text === '' || (await deps.requests.get(text)) !== null) return ref;
  const employee = employeeOfThread(threadId);
  if (employee === null) return ref;
  const wanted = normalizeTitle(text);
  if (wanted.length < MIN_LOOKUP_CHARS) return ref;
  const list = await employeeRequests(deps, employee);
  const labels = labelsOf(list);
  const exact = list.filter(
    (entry) =>
      normalizeTitle(labels.get(entry.requestId) ?? '') === wanted ||
      normalizeTitle(entry.title) === normalizeTitle(text.replace(DATE_SUFFIX, '')),
  );
  const loose = list.filter((entry) => {
    const title = normalizeTitle(entry.title);
    return title.includes(wanted) || wanted.includes(title);
  });
  // Точное совпадение с подписью важнее: «пледы от 28.10» выбирает одну из двух «пледы».
  const exactLabel = exact.filter(
    (entry) => normalizeTitle(labels.get(entry.requestId) ?? '') === wanted,
  );
  const matches = exactLabel.length > 0 ? exactLabel : exact.length > 0 ? exact : loose;
  if (matches.length === 0) return ref;
  const [only] = matches;
  if (matches.length === 1 && only !== undefined) return only.requestId;
  const shown = matches
    .slice(0, AMBIGUOUS_LISTED_MAX)
    .map((entry) => `«${labels.get(entry.requestId) ?? entry.title}»`)
    .join(', ');
  throw new DomainError(
    'conflict',
    `Под «${text}» подходит несколько заявок: ${shown}. Спроси сотрудника, какая из них ` +
      'нужна, и повтори вызов с уточнённым названием.',
  );
}

/** Название заявки для имени файла: знаки, недопустимые в имени, заменены на «_». */
export function fileSafeLabel(label: string): string {
  return label.replace(/[\\/:*?"<>|\s]+/gu, '_');
}

/** Есть ли у входа инструмента поле `requestId` (инструменты по заявке). */
function hasRequestId(tool: AnyToolDefinition): boolean {
  const shape = (tool.inputSchema as { shape?: unknown }).shape;
  return typeof shape === 'object' && shape !== null && 'requestId' in shape;
}

/** Подмена `requestId`-названия на id; одна функция на все инструменты. */
async function resolveRequestIdInput(
  input: unknown,
  deps: unknown,
  threadId: string,
  activeFallback: boolean,
): Promise<unknown> {
  const record = input as { requestId?: unknown } | null;
  if (record === null || typeof record !== 'object') return input;
  if (typeof record.requestId !== 'string') return input;
  const orderDeps = deps as Partial<OrderCalcDeps>;
  // Зависимостей заявок нет (узкая сборка, например передача другому агенту): подменять нечем.
  if (orderDeps.requests === undefined || orderDeps.state === undefined) return input;
  let requestId = record.requestId;
  try {
    requestId = await resolveRequestRef(orderDeps as OrderCalcDeps, record.requestId, threadId);
    // Ни id, ни название не нашли заявку (модель не помнит id между ходами): берём активную
    // заявку треда, а не отказываем и не заводим новую.
    // Документам откат на активную заявку не нужен: подставить чужую заявку в договор хуже,
    // чем переспросить, поэтому он включается только для инструментов расчёта.
    if ((await orderDeps.requests.get(requestId)) === null) {
      if (activeFallback) {
        requestId = (await activeRequestId(orderDeps as OrderCalcDeps, threadId)) ?? requestId;
      } else {
        throw new DomainError(
          'not_found',
          `Заявка «${record.requestId}» не найдена. Попроси сотрудника уточнить название заявки.`,
        );
      }
    }
  } catch (error) {
    // Вопрос «какая из заявок» - ответ модели; сбой поиска не должен блокировать сам вызов.
    if (error instanceof DomainError) throw error;
  }
  return requestId === record.requestId ? input : { ...record, requestId };
}

const resolveForOrderCalc = (input: unknown, deps: unknown, threadId: string) =>
  resolveRequestIdInput(input, deps, threadId, true);
const resolveForDocuments = (input: unknown, deps: unknown, threadId: string) =>
  resolveRequestIdInput(input, deps, threadId, false);

/**
 * Научить инструмент понимать название заявки в `requestId`: рантайм подменит его id до
 * ключа идемпотентности и валидаторов. Инструменты без такого поля возвращаются как есть.
 */
export function withRequestRef<T extends AnyToolDefinition>(
  tool: T,
  options: { activeFallback?: boolean } = {},
): T {
  if (!hasRequestId(tool)) return tool;
  // Одна и та же функция на вид подмены: декларации сравниваются по равенству инструментов.
  const resolveInput =
    options.activeFallback === false ? resolveForDocuments : resolveForOrderCalc;
  return { ...tool, resolveInput };
}
