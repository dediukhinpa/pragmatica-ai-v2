import { z } from 'zod';
import type { ShortlistProposal } from '../../kit/domain/shortlist';
import type { Clock, WorkflowStateStore } from '@business-ai/core';
import { hasPressIdentity, readState, stableHash, writeState } from '@business-ai/core';
import {
  CHOICE_ASK_NAMESPACE,
  CHOICE_CONFIRM_NAMESPACE,
  PICK_BUTTON_PREFIX,
  PICK_DONE_BUTTON_PREFIX,
} from './deps';

/**
 * Подтверждение выбора поставщиков менеджером (S-01).
 *
 * Подтверждение пишет код обработчика чата (`recordChoiceButton` - старые кнопки) либо
 * инструмент `recordManagerChoice` (`recordChoicePicks`; смысл свободного ответа определяет
 * модель, этап 164, кода разбора слов нет): он работает только в ходе, начатом сообщением
 * сотрудника в чате, и автором решения пишет этого сотрудника. `recordSelection` лишь читает
 * запись.
 */

/** Кандидат шорт-листа в открытом вопросе (имя нужно для сопоставления названного выбора). */
const askEntrySchema = z.object({ supplierId: z.string().min(1), name: z.string() });

/**
 * Вопрос менеджеру; его создаёт askManagerToChoose. На тред может приходиться несколько
 * вопросов (по одному на заявку): вопрос закрывается после записи выбора (`closedAt`).
 */
const choiceAskSchema = z.object({
  requestId: z.string().min(1),
  version: z.string().min(1),
  threadId: z.string().min(1),
  entries: z.array(askEntrySchema),
  askedAt: z.string(),
  closedAt: z.string().optional(),
  /** Сколько раз ответ сотрудника был неясен: вопрос повторяется один раз, не чаще. */
  unclear: z.number().int().default(0),
});
export type ChoiceAsk = z.infer<typeof choiceAskSchema>;

/**
 * Вопросы треда (ключ записи - тред). Запись прежнего формата (один вопрос на тред) читается
 * как книга из одного вопроса.
 */
const askBookSchema = z.union([
  z.object({ asks: z.array(choiceAskSchema) }),
  choiceAskSchema.transform((ask) => ({ asks: [ask] })),
]);

/** Сколько вопросов помним на тред: закрытые и самые старые вытесняются первыми. */
const MAX_THREAD_ASKS = 20;

/** Подтверждённый менеджером набор; ключ - заявка. Действует только для своей версии шорт-листа. */
const choiceConfirmationSchema = z.object({
  requestId: z.string().min(1),
  version: z.string().min(1),
  supplierIds: z.array(z.string().min(1)).min(1),
  confirmedBy: z.string().min(1),
  confirmedAt: z.string(),
  via: z.enum(['button', 'text']),
  /** Менеджер завершил выбор («Готово» или полный перечень текстом): набор можно фиксировать. */
  done: z.boolean().default(false),
  doneBy: z.string().optional(),
  doneAt: z.string().optional(),
});
export type ChoiceConfirmation = z.infer<typeof choiceConfirmationSchema>;

/** Итог обработки ответа менеджера. */
export type ChoiceOutcome =
  | { kind: 'recorded'; supplierIds: string[] }
  | { kind: 'already_recorded' }
  /** Выбор уже завершён («Готово»): набор больше не меняется нажатиями. */
  | { kind: 'already_done' }
  | { kind: 'no_open_ask' }
  | { kind: 'stale_button' }
  | { kind: 'not_in_shortlist' }
  | { kind: 'no_identity' };

/** Знаков отпечатка вопроса в id кнопки (лимит id кнопки канала 64 байта). */
const CHOICE_TOKEN_CHARS = 8;
/** Разделитель отпечатка вопроса и id поставщика в id кнопки и в «цели» нажатия. */
const PICK_SEPARATOR = ':';

/** Один пробельный знак (для среза маркеров списка). */
const SPACE_CHAR = /^\s$/u;
/** Ведущие знаки маркера списка («-», «–», «•») помимо пробелов. */
const LEADING_MARKERS = new Set(['-', '–', '•']);
/** Завершающий знак, срезаемый помимо пробелов: точка после номера или названия. */
const TRAILING_DOT = '.';
/**
 * Самый длинный пункт выбора, который ещё сопоставляется с шорт-листом: название поставщика
 * с запасом. Длиннее - не название, пункт обрезается до предела до любых регулярок (R9-A1-04).
 */
const MAX_CHOICE_TEXT_CHARS = 1_000;
const INDEX_PART = /^(\d+)[.)]?$/u;

/** Все вопросы треда (открытые и закрытые); null, если в треде менеджеру ничего не предлагали. */
async function loadAskBook(
  state: WorkflowStateStore,
  threadId: string,
): Promise<ChoiceAsk[] | null> {
  const book = await readState(state, CHOICE_ASK_NAMESPACE, threadId, askBookSchema);
  return book === null ? null : book.asks;
}

function isOpen(ask: ChoiceAsk): boolean {
  return ask.closedAt === undefined;
}

/** Открытые вопросы треда: по одному на заявку, ещё без записанного выбора. */
export async function loadOpenChoiceAsks(
  state: WorkflowStateStore,
  threadId: string,
): Promise<ChoiceAsk[]> {
  return ((await loadAskBook(state, threadId)) ?? []).filter(isOpen);
}

/** Последний открытый вопрос треда; null, если открытых нет. */
export async function loadChoiceAsk(
  state: WorkflowStateStore,
  threadId: string,
): Promise<ChoiceAsk | null> {
  return (await loadOpenChoiceAsks(state, threadId)).at(-1) ?? null;
}

async function saveAskBook(
  state: WorkflowStateStore,
  threadId: string,
  asks: ChoiceAsk[],
): Promise<void> {
  // Вытесняем в первую очередь закрытые, затем самые старые: книга ограничена.
  let kept = asks;
  while (kept.length > MAX_THREAD_ASKS) {
    const drop = kept.findIndex((ask) => !isOpen(ask));
    kept = kept.filter((_, index) => index !== (drop < 0 ? 0 : drop));
  }
  await writeState(state, CHOICE_ASK_NAMESPACE, threadId, { asks: kept });
}

/**
 * Запомнить вопрос менеджеру (вызывает askManagerToChoose до отправки сообщения). Ключ -
 * (тред, заявка): новый вопрос по той же заявке заменяет прежний (его кнопки становятся
 * устаревшими), вопросы по другим заявкам треда остаются открытыми (R4-AGT-8).
 */
export async function saveChoiceAsk(
  state: WorkflowStateStore,
  clock: Clock,
  threadId: string,
  proposal: ShortlistProposal,
): Promise<void> {
  const ask: ChoiceAsk = {
    requestId: proposal.requestId,
    version: proposal.version,
    threadId,
    entries: proposal.entries.map((entry) => ({ supplierId: entry.supplierId, name: entry.name })),
    askedAt: clock.now().toISOString(),
    unclear: 0,
  };
  const others = ((await loadAskBook(state, threadId)) ?? []).filter(
    (known) => known.requestId !== proposal.requestId,
  );
  await saveAskBook(state, threadId, [...others, ask]);
}

/**
 * Закрыть вопрос по заявке после записи выбора: кнопки и текст больше ничего не подтвердят.
 * Нет открытого вопроса - ничего не делает.
 */
export async function closeChoiceAsk(
  state: WorkflowStateStore,
  clock: Clock,
  threadId: string,
  requestId: string,
): Promise<void> {
  const asks = await loadAskBook(state, threadId);
  if (asks === null) return;
  const closedAt = clock.now().toISOString();
  const updated = asks.map((ask) =>
    ask.requestId === requestId && isOpen(ask) ? { ...ask, closedAt } : ask,
  );
  await saveAskBook(state, threadId, updated);
}

/**
 * Отметить неясный ответ сотрудника на вопрос выбора (этап 164) и вернуть, сколько их уже было
 * до этого: ноль - вопрос повторяется (один раз), больше - больше не переспрашиваем. Нет
 * открытого вопроса по заявке - null.
 */
export async function noteUnclearChoiceAnswer(
  state: WorkflowStateStore,
  threadId: string,
  requestId: string,
): Promise<number | null> {
  const asks = await loadAskBook(state, threadId);
  const ask = asks?.find((item) => item.requestId === requestId && isOpen(item));
  if (asks === null || ask === undefined) return null;
  await saveAskBook(
    state,
    threadId,
    asks.map((item) => (item === ask ? { ...item, unclear: item.unclear + 1 } : item)),
  );
  return ask.unclear;
}

/** Подтверждённый набор по заявке; null, если менеджер ничего не выбрал. */
export function loadChoiceConfirmation(
  state: WorkflowStateStore,
  requestId: string,
): Promise<ChoiceConfirmation | null> {
  return readState(state, CHOICE_CONFIRM_NAMESPACE, requestId, choiceConfirmationSchema);
}

/** Отпечаток вопроса (заявка + версия шорт-листа): кнопка действует только на свой вопрос. */
export function choiceToken(requestId: string, version: string): string {
  return stableHash([requestId, version]).slice(0, CHOICE_TOKEN_CHARS);
}

/** id кнопки выбора: `pick:<отпечаток вопроса>:<supplierId>`. */
export function pickButtonId(requestId: string, version: string, supplierId: string): string {
  return `${PICK_BUTTON_PREFIX}${choiceToken(requestId, version)}${PICK_SEPARATOR}${supplierId}`;
}

/** id кнопки «Готово»: `pickdone:<отпечаток вопроса>`. */
export function pickDoneButtonId(requestId: string, version: string): string {
  return `${PICK_DONE_BUTTON_PREFIX}${choiceToken(requestId, version)}`;
}

/** Отпечаток вопроса из id кнопки «Готово»; null, если это не она. */
export function parsePickDoneButton(buttonId: string): string | null {
  if (!buttonId.startsWith(PICK_DONE_BUTTON_PREFIX)) return null;
  const token = buttonId.slice(PICK_DONE_BUTTON_PREFIX.length);
  return token === '' || token.includes(PICK_SEPARATOR) ? null : token;
}

/** Разобрать «цель» нажатия `<отпечаток>:<supplierId>`; null, если формат другой. */
export function splitPickTarget(target: string): { token: string; supplierId: string } | null {
  const at = target.indexOf(PICK_SEPARATOR);
  if (at <= 0) return null;
  const supplierId = target.slice(at + 1);
  return supplierId === '' ? null : { token: target.slice(0, at), supplierId };
}

/**
 * «Цель» нажатия из id кнопки `pick:<отпечаток>:<supplierId>` (строка `<отпечаток>:<supplierId>`,
 * её принимает `recordChoiceButton` в поле `supplierId`); null, если это не кнопка выбора или
 * у неё старый формат без отпечатка вопроса: такая кнопка ничего не подтверждает.
 */
export function parsePickButton(buttonId: string): string | null {
  if (!buttonId.startsWith(PICK_BUTTON_PREFIX)) return null;
  const target = buttonId.slice(PICK_BUTTON_PREFIX.length);
  return splitPickTarget(target) === null ? null : target;
}

async function writeConfirmation(
  state: WorkflowStateStore,
  clock: Clock,
  ask: ChoiceAsk,
  supplierIds: string[],
  userId: string,
  via: ChoiceConfirmation['via'],
  done: boolean,
): Promise<void> {
  const now = clock.now().toISOString();
  const confirmation: ChoiceConfirmation = {
    requestId: ask.requestId,
    version: ask.version,
    supplierIds,
    confirmedBy: userId,
    confirmedAt: now,
    via,
    done,
    ...(done ? { doneBy: userId, doneAt: now } : {}),
  };
  await writeState(state, CHOICE_CONFIRM_NAMESPACE, ask.requestId, confirmation);
}

/** Накопленное подтверждение по вопросу своей версии; иначе null. */
async function currentConfirmation(
  state: WorkflowStateStore,
  ask: ChoiceAsk,
): Promise<ChoiceConfirmation | null> {
  const known = await loadChoiceConfirmation(state, ask.requestId);
  return known !== null && known.version === ask.version ? known : null;
}

/** Нажатие кнопки выбора. */
export interface ChoiceButtonPress {
  /**
   * Что нажато: `<отпечаток вопроса>:<supplierId>` (результат `parsePickButton`) либо чистый
   * supplierId вместе с `token`. Нажатие без отпечатка вопроса отклоняется.
   */
  supplierId: string;
  /** Отпечаток вопроса из id кнопки, если supplierId передан отдельно. */
  token?: string | undefined;
  /** Кто нажал: идентификатор из канала, не из аргументов модели. */
  userId: string;
  threadId: string;
}

/** Найти открытый вопрос треда по отпечатку; отдельно - «вопросов в треде не было вовсе». */
async function askByToken(
  state: WorkflowStateStore,
  threadId: string,
  token: string,
): Promise<{ ask: ChoiceAsk } | { kind: 'no_open_ask' | 'stale_button' }> {
  const book = await loadAskBook(state, threadId);
  if (book === null) return { kind: 'no_open_ask' };
  const ask = book.find(
    (item) => isOpen(item) && choiceToken(item.requestId, item.version) === token,
  );
  return ask === undefined ? { kind: 'stale_button' } : { ask };
}

/**
 * Кнопка `pick:<id>`: добавить поставщика в накопленное подтверждение. Нажатия только копятся
 * (можно выбрать несколько), повтор того же нажатия ничего не меняет; набор действует лишь
 * после «Готово» (`recordChoiceDone`). Нужны личность нажавшего, открытый вопрос в этом
 * треде и поставщик из предложенного шорт-листа.
 */
export async function recordChoiceButton(
  state: WorkflowStateStore,
  clock: Clock,
  press: ChoiceButtonPress,
): Promise<ChoiceOutcome> {
  if (!hasPressIdentity(press.userId)) return { kind: 'no_identity' };
  const target =
    press.token === undefined
      ? splitPickTarget(press.supplierId)
      : { token: press.token, supplierId: press.supplierId };
  // Кнопка от другой заявки или другой версии шорт-листа (вопрос в треде уже заменён).
  if (target === null) {
    return (await loadAskBook(state, press.threadId)) === null
      ? { kind: 'no_open_ask' }
      : { kind: 'stale_button' };
  }
  const found = await askByToken(state, press.threadId, target.token);
  if ('kind' in found) return { kind: found.kind };
  const { ask } = found;
  if (!ask.entries.some((entry) => entry.supplierId === target.supplierId)) {
    return { kind: 'not_in_shortlist' };
  }
  const known = await currentConfirmation(state, ask);
  if (known?.done === true) return { kind: 'already_done' };
  const current = known === null ? [] : known.supplierIds;
  if (current.includes(target.supplierId)) return { kind: 'already_recorded' };
  const supplierIds = [...current, target.supplierId];
  await writeConfirmation(state, clock, ask, supplierIds, press.userId, 'button', false);
  return { kind: 'recorded', supplierIds };
}

/** Нажатие кнопки «Готово». */
export interface ChoiceDonePress {
  /** Отпечаток вопроса из id кнопки (`parsePickDoneButton`). */
  token: string;
  /** Кто нажал: идентификатор из канала. */
  userId: string;
  threadId: string;
}

/** Итог нажатия «Готово». */
export type ChoiceDoneOutcome =
  | { kind: 'finalized'; supplierIds: string[] }
  /** Выбор уже завершён, а вопрос ещё открыт (прошлый ход агента не дошёл до записи). */
  | { kind: 'already_done'; supplierIds: string[] }
  | { kind: 'nothing_selected' }
  | { kind: 'no_open_ask' }
  | { kind: 'stale_button' }
  | { kind: 'no_identity' };

/**
 * Кнопка «Готово»: завершить накопление выбора. Только после неё `recordSelection` и рассылка
 * берут набор из подтверждения. Пустой набор не завершается.
 */
export async function recordChoiceDone(
  state: WorkflowStateStore,
  clock: Clock,
  press: ChoiceDonePress,
): Promise<ChoiceDoneOutcome> {
  if (!hasPressIdentity(press.userId)) return { kind: 'no_identity' };
  const found = await askByToken(state, press.threadId, press.token);
  if ('kind' in found) return { kind: found.kind };
  const known = await currentConfirmation(state, found.ask);
  if (known === null || known.supplierIds.length === 0) return { kind: 'nothing_selected' };
  if (known.done) return { kind: 'already_done', supplierIds: known.supplierIds };
  await writeConfirmation(state, clock, found.ask, known.supplierIds, press.userId, 'button', true);
  return { kind: 'finalized', supplierIds: known.supplierIds };
}

/** Что менеджер выбрал к этому моменту: для ответа на нажатие кнопки. */
export interface ChoiceSummary {
  requestId: string;
  /** Названия выбранных поставщиков в порядке выбора. */
  names: string[];
  done: boolean;
}

/** Накопленный выбор по открытому вопросу треда с этим отпечатком; null, если вопроса нет. */
export async function loadChoiceSummary(
  state: WorkflowStateStore,
  threadId: string,
  token: string,
): Promise<ChoiceSummary | null> {
  const found = await askByToken(state, threadId, token);
  if ('kind' in found) return null;
  const known = await currentConfirmation(state, found.ask);
  const names = (known?.supplierIds ?? []).map(
    (id) => found.ask.entries.find((entry) => entry.supplierId === id)?.name ?? id,
  );
  return { requestId: found.ask.requestId, names, done: known?.done === true };
}

/** Нормализация для сравнения названий: регистр, «ё», лишние пробелы. */
function normalizeName(text: string): string {
  return text.toLowerCase().replaceAll('ё', 'е').replace(/\s+/gu, ' ').trim();
}

/**
 * Срезать ведущие пробелы и маркеры списка («-», «–», «•») и завершающие пробелы и точки.
 * Кодом, а не регуляркой `^[\s\-–•]+|[\s.]+$`: та на длинном ряде пробелов внутри текста
 * пробовала `[\s.]+$` с каждой позиции ряда - квадратично (R9-A1-04).
 */
function stripListMarker(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && isLeadingMarker(text.charAt(start))) start += 1;
  while (end > start && isTrailingMarker(text.charAt(end - 1))) end -= 1;
  return text.slice(start, end);
}

function isLeadingMarker(char: string): boolean {
  return LEADING_MARKERS.has(char) || SPACE_CHAR.test(char);
}

function isTrailingMarker(char: string): boolean {
  return char === TRAILING_DOT || SPACE_CHAR.test(char);
}

/** Единственный кандидат по названию; null при отсутствии или неоднозначности. */
function matchByName(entries: ChoiceAsk['entries'], part: string): string | null {
  const wanted = normalizeName(part);
  const found = entries.filter((entry) => normalizeName(entry.name) === wanted);
  return found.length === 1 ? (found[0]?.supplierId ?? null) : null;
}

/** Часть ответа - номер из списка («2») или точное название; иначе null. */
function matchPart(entries: ChoiceAsk['entries'], part: string): string | null {
  const index = INDEX_PART.exec(part);
  if (index !== null) return entries[Number(index[1]) - 1]?.supplierId ?? null;
  return matchByName(entries, part);
}

/** Самая короткая часть названия, по которой ещё ищем поставщика вхождением в имя. */
const MIN_NAME_FRAGMENT_CHARS = 3;

/**
 * Один пункт выбора, названный моделью по тексту сотрудника: номер из списка («3»), точное
 * название либо однозначная часть названия («Альфа» для «ООО Альфа»). null - не сопоставлено.
 */
function matchPick(entries: ChoiceAsk['entries'], pick: string): string | null {
  const part = stripListMarker(pick.slice(0, MAX_CHOICE_TEXT_CHARS));
  if (part === '') return null;
  const exact = matchPart(entries, part);
  if (exact !== null) return exact;
  const wanted = normalizeName(part);
  if (wanted.length < MIN_NAME_FRAGMENT_CHARS) return null;
  const found = entries.filter((entry) => normalizeName(entry.name).includes(wanted));
  return found.length === 1 ? (found[0]?.supplierId ?? null) : null;
}

/** Выбор, переданный инструментом по ответу сотрудника в чате. */
export interface ChoicePicksAnswer {
  requestId: string;
  /** Номера из списка или названия поставщиков, как их назвал сотрудник. */
  picks: readonly string[];
  /** Автор решения: сотрудник, начавший ход (проверено предохранителем). */
  userId: string;
  threadId: string;
  /**
   * Пункт, которого нет в шорт-листе, ищется в базе поставщиков этим поиском: названного
   * человеком поставщика не отвергаем из-за того, что в шорт-лист он не попал. Нет поиска -
   * выбор только из шорт-листа.
   */
  resolveOutside?: OutsidePickResolver | undefined;
}

/**
 * Поиск названного в базе поставщика для пункта, которого нет в шорт-листе. Поставщика находит
 * код по базе, а не модель: `card` - единственная подходящая карточка, `ambiguous` - несколько
 * (не угадываем), `inactive` - карточка со статусом «не действующий», `none` - в базе нет.
 */
export type OutsidePickMatch =
  | { kind: 'card'; supplierId: string; name: string }
  | { kind: 'ambiguous'; candidates: string[] }
  | { kind: 'inactive'; name: string }
  | { kind: 'none' };
export type OutsidePickResolver = (pick: string) => Promise<OutsidePickMatch>;

/** Итог записи выбора по ответу сотрудника. */
export type ChoicePicksOutcome =
  | { kind: 'recorded'; supplierIds: string[]; names: string[] }
  | { kind: 'already_recorded'; supplierIds: string[]; names: string[] }
  | { kind: 'no_open_ask' }
  /**
   * Часть пунктов - названия, которых нет ни в шорт-листе, ни в базе (этап 163). Найденные
   * записаны (`supplierIds` может быть пустым), по недостающим код спрашивает про карточку.
   */
  | { kind: 'card_missing'; supplierIds: string[]; names: string[]; missing: string[] }
  | {
      kind: 'unmatched';
      /** Пункты, которых нет ни в шорт-листе, ни в базе. */
      picks: string[];
      /** Пункты, которым подходят несколько карточек базы (с названиями кандидатов). */
      ambiguous: Array<{ pick: string; candidates: string[] }>;
      /** Пункты, чья карточка в базе не действует. */
      inactive: string[];
    }
  | { kind: 'no_identity' };

/**
 * Записать выбор сотрудника по номерам или названиям (решение владельца 26.10.2026: кнопок
 * нет). Пишет то же подтверждение, что текстовый ответ и кнопки с «Готово»: полный перечень,
 * выбор сразу завершён. Нужен открытый вопрос по этой заявке в этом треде; любой пункт, который
 * не сопоставлен однозначно, отклоняет весь ответ (переспросить надёжнее, чем угадать).
 */
export async function recordChoicePicks(
  state: WorkflowStateStore,
  clock: Clock,
  answer: ChoicePicksAnswer,
): Promise<ChoicePicksOutcome> {
  if (!hasPressIdentity(answer.userId)) return { kind: 'no_identity' };
  const open = await loadOpenChoiceAsks(state, answer.threadId);
  const ask = open.find((item) => item.requestId === answer.requestId);
  if (ask === undefined) return { kind: 'no_open_ask' };
  const supplierIds: string[] = [];
  const outsideNames = new Map<string, string>();
  const unmatched: string[] = [];
  // Номер вне списка - опечатка, а не поставщик без карточки: карточку по нему не предлагаем.
  const badIndexes: string[] = [];
  const ambiguous: Array<{ pick: string; candidates: string[] }> = [];
  const inactive: string[] = [];
  for (const pick of answer.picks) {
    const id = matchPick(ask.entries, pick);
    if (id !== null) {
      if (!supplierIds.includes(id)) supplierIds.push(id);
      continue;
    }
    // Номер списка вне диапазона в базе не ищем: это опечатка, а не название поставщика.
    if (INDEX_PART.test(stripListMarker(pick))) {
      badIndexes.push(pick);
      continue;
    }
    const outside =
      answer.resolveOutside === undefined
        ? ({ kind: 'none' } as const)
        : await answer.resolveOutside(stripListMarker(pick.slice(0, MAX_CHOICE_TEXT_CHARS)));
    if (outside.kind === 'card') {
      outsideNames.set(outside.supplierId, outside.name);
      if (!supplierIds.includes(outside.supplierId)) supplierIds.push(outside.supplierId);
    } else if (outside.kind === 'ambiguous') {
      ambiguous.push({ pick, candidates: outside.candidates });
    } else if (outside.kind === 'inactive') {
      inactive.push(pick);
    } else {
      unmatched.push(pick);
    }
  }
  // Неоднозначное, не действующее и опечатка в номере отклоняют весь ответ, как раньше.
  if (
    badIndexes.length > 0 ||
    ambiguous.length > 0 ||
    inactive.length > 0 ||
    (unmatched.length === 0 && supplierIds.length === 0)
  ) {
    return { kind: 'unmatched', picks: [...unmatched, ...badIndexes], ambiguous, inactive };
  }
  const names = supplierIds.map(
    (id) =>
      ask.entries.find((entry) => entry.supplierId === id)?.name ?? outsideNames.get(id) ?? id,
  );
  if (unmatched.length > 0) {
    // Письмо для найденных не блокируем (решение владельца 03.11): их выбор записывается сразу,
    // а про поставщика без карточки задаётся вопрос.
    if (supplierIds.length > 0) {
      await writeConfirmation(state, clock, ask, supplierIds, answer.userId, 'text', true);
    }
    return { kind: 'card_missing', supplierIds, names, missing: unmatched };
  }
  const known = await currentConfirmation(state, ask);
  const same =
    known !== null &&
    known.done &&
    known.supplierIds.length === supplierIds.length &&
    supplierIds.every((id) => known.supplierIds.includes(id));
  if (same) return { kind: 'already_recorded', supplierIds, names };
  await writeConfirmation(state, clock, ask, supplierIds, answer.userId, 'text', true);
  return { kind: 'recorded', supplierIds, names };
}

/**
 * Добавить в подтверждённый менеджером набор поставщиков, чью карточку завели по его ответу
 * «создавай» (этап 163). Версия - у уже записанного набора, иначе у открытого вопроса заявки.
 * Возвращает false, если версию взять неоткуда: тогда набор не менялся.
 */
export async function addConfirmedSuppliers(
  state: WorkflowStateStore,
  clock: Clock,
  input: { requestId: string; threadId: string; userId: string; supplierIds: readonly string[] },
): Promise<boolean> {
  const known = await loadChoiceConfirmation(state, input.requestId);
  const open = (await loadOpenChoiceAsks(state, input.threadId)).find(
    (item) => item.requestId === input.requestId,
  );
  const version = known?.version ?? open?.version;
  if (version === undefined) return false;
  // Набор от другой версии шорт-листа не продолжаем: он всё равно не подтверждает эту.
  const base = known !== null && known.version === version ? known.supplierIds : [];
  const supplierIds = [...new Set([...base, ...input.supplierIds])];
  const now = clock.now().toISOString();
  const confirmation: ChoiceConfirmation = {
    requestId: input.requestId,
    version,
    supplierIds,
    confirmedBy: input.userId,
    confirmedAt: now,
    via: 'text',
    done: true,
    doneBy: input.userId,
    doneAt: now,
  };
  await writeState(state, CHOICE_CONFIRM_NAMESPACE, input.requestId, confirmation);
  return true;
}
