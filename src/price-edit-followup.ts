import { z } from 'zod';
import { chatThreadOf, defineTool, readState, writeState } from '@business-ai/core';
import type { ToolContext } from '@business-ai/core';
import type { WorkflowStateStore } from '@business-ai/core';
import type { PricesDeps } from './agents/prices/deps';

/**
 * Ожидание ответа сотрудника после правки файла без поставщика (этап 9p). Агент сразу правит
 * цену и присылает файл, а в том же сообщении спрашивает название поставщика и «обновить цены
 * этих позиций в базе?». Пока сотрудник не ответил, здесь лежит что именно изменено: ответ
 * «да» на следующем ходе иначе не к чему привязать. В базу ничего не пишется без явного «да».
 */

/** Пространство состояния; ключ записи - тред чата сотрудника (одно ожидание на тред). */
export const PRICE_EDIT_FOLLOWUP_NAMESPACE = 'prices:edit-followup';

const MS_PER_HOUR = 3_600_000;
/** Срок ожидания ответа, часов: дольше вопрос о базе устаревает (цены в файле уже чужие). */
export const PRICE_EDIT_FOLLOWUP_TTL_HOURS = 24;
/** Срок ожидания ответа, мс. */
export const PRICE_EDIT_FOLLOWUP_TTL_MS = PRICE_EDIT_FOLLOWUP_TTL_HOURS * MS_PER_HOUR;
/** Сколько ячеек строки храним для узнавания позиции (название, артикул, единицы). */
export const FOLLOWUP_ROW_CELLS_MAX = 8;
/** Предел длины ячейки строки в состоянии. */
export const FOLLOWUP_CELL_MAX_CHARS = 80;
/** Предел числа изменений в одном ожидании. */
export const FOLLOWUP_CHANGES_MAX = 50;

/** Одно изменение цены: место, строка файла, было и стало. */
export const followupChangeSchema = z.object({
  /** Метка места: «Слайд 11», «Страница 3», «Лист «Прайс»»; null - не определено. */
  place: z.string().nullable(),
  table: z.number().int().nonnegative(),
  row: z.number().int().nonnegative(),
  col: z.number().int().nonnegative(),
  /** Заголовок столбца цены (первая строка таблицы), если он есть. */
  header: z.string().optional(),
  /**
   * Ячейки строки (без служебных), чтобы узнать позицию: название, артикул. У числа в текстовом
   * блоке слайда - один элемент: отрывок текста вокруг числа.
   */
  rowCells: z.array(z.string()),
  /**
   * Число в текстовом блоке слайда pptx (этап 9q): локатор правки и отрывок текста. Есть только у
   * такой правки (`table`, `row`, `col` у неё нули-заглушки); в ожидании, записанном до 9q,
   * этих полей нет, и оно читается как прежде.
   */
  slide: z.number().int().positive().optional(),
  shape: z.string().min(1).optional(),
  paragraph: z.number().int().nonnegative().optional(),
  start: z.number().int().nonnegative().optional(),
  /**
   * Число в тексте PDF вне таблиц с линиями (этап 9r): страница с 1 и номер места на ней с 0 (у
   * такой правки тоже нули-заглушки `table`, `row`, `col`) и отрывок текста в `context`.
   */
  page: z.number().int().positive().optional(),
  spot: z.number().int().nonnegative().optional(),
  context: z.string().optional(),
  oldPrice: z.number(),
  newPrice: z.number(),
});
export type FollowupChange = z.infer<typeof followupChangeSchema>;

/** Поставщик, если он определён (подсказка из письма или названный моделью и найденный в базе). */
const supplierSchema = z.object({ id: z.string().min(1), name: z.string() });

/** Состояние ожидания по треду. */
export const priceEditFollowupSchema = z.object({
  createdAt: z.string(),
  expiresAt: z.string(),
  /** Имя исходного файла сотрудника. */
  sourceName: z.string(),
  /** Имя отправленного файла с новыми ценами. */
  resultName: z.string(),
  supplier: supplierSchema.nullable(),
  changes: z.array(followupChangeSchema).min(1).max(FOLLOWUP_CHANGES_MAX),
});
export type PriceEditFollowup = z.infer<typeof priceEditFollowupSchema>;

/** Живо ли ожидание на момент `now`. */
export function isFollowupAlive(value: PriceEditFollowup, now: Date): boolean {
  const expires = Date.parse(value.expiresAt);
  return Number.isFinite(expires) && expires > now.getTime();
}

/** Срок окончания ожидания, ISO. */
export function followupExpiry(now: Date): string {
  return new Date(now.getTime() + PRICE_EDIT_FOLLOWUP_TTL_MS).toISOString();
}

/** Прочитать живое ожидание треда; просроченное убирается и считается отсутствующим. */
export async function loadFollowup(
  state: WorkflowStateStore,
  threadId: string,
  now: Date,
): Promise<PriceEditFollowup | null> {
  const value = await readState(
    state,
    PRICE_EDIT_FOLLOWUP_NAMESPACE,
    threadId,
    priceEditFollowupSchema,
  );
  if (value === null) return null;
  if (isFollowupAlive(value, now)) return value;
  await state.delete(PRICE_EDIT_FOLLOWUP_NAMESPACE, threadId);
  return null;
}

/** Записать ожидание (новая правка в треде заменяет прежнее ожидание). */
export async function saveFollowup(
  state: WorkflowStateStore,
  threadId: string,
  value: PriceEditFollowup,
): Promise<void> {
  // `done`: запись не «живой сценарий», её уберёт ретенция состояния по сроку
  await writeState(state, PRICE_EDIT_FOLLOWUP_NAMESPACE, threadId, value, { done: true });
}

/** Нет состояния сценариев или не определён тред: ожидание вести негде. */
const NO_FOLLOWUP_MESSAGE =
  'Ожидающей правки в этом чате нет (её не было, срок вышел или вопрос уже закрыт). Ничего не ' +
  'записывай в базу: спроси сотрудника, какие цены он имеет в виду.';

/** Тред чата сотрудника, в котором ведётся ожидание; null - не чат (плановый ход). */
export async function followupThreadOf(
  deps: PricesDeps,
  context: ToolContext,
): Promise<string | null> {
  return deps.state === undefined ? null : chatThreadOf(deps.state, context);
}

interface PendingOutput {
  pending: boolean;
  /** Что было изменено в файле и ждёт ответа сотрудника. */
  followup?: PriceEditFollowup | undefined;
  message: string;
}

const pendingOutputSchema = z.object({
  pending: z.boolean(),
  followup: priceEditFollowupSchema.optional(),
  message: z.string(),
});

/**
 * Показать правку файла, ждущую ответа сотрудника («да»/«нет» про базу, название поставщика).
 * Только чтение: запись в базу идёт отдельным инструментом по правилам промпта (с этапа 9q -
 * writeEditedPricesToDb) и только после явного «да» сотрудника.
 */
export const getPendingPriceEdit = defineTool<Record<string, never>, PendingOutput, PricesDeps>({
  name: 'getPendingPriceEdit',
  description:
    'Показать правку цен в файле, по которой ты ждёшь ответа сотрудника в этом чате: что ' +
    'изменено (место, было, стало, ячейки строки) и имя файла. Вызови, когда сотрудник отвечает ' +
    'на твой вопрос «обновить цены этих позиций в базе?» или называет поставщика. Ответ ' +
    '«да» - запиши цены способом из инструкции (поставщик должен быть найден в базе), ' +
    '«нет» - closePendingPriceEdit. Без явного «да» в базу ничего не пиши.',
  inputSchema: z.object({}),
  outputSchema: pendingOutputSchema,
  async execute(_input, deps, context) {
    const threadId = await followupThreadOf(deps, context);
    if (deps.state === undefined || threadId === null) {
      return { pending: false, message: NO_FOLLOWUP_MESSAGE };
    }
    const value = await loadFollowup(deps.state, threadId, deps.clock.now());
    if (value === null) return { pending: false, message: NO_FOLLOWUP_MESSAGE };
    return {
      pending: true,
      followup: value,
      message:
        'Правка ждёт ответа сотрудника. Название позиции возьми из ячеек строки (rowCells), ' +
        'цену - из newPrice. Если поставщик не определён (supplier=null), сначала выясни его ' +
        '(searchSuppliers по названию от сотрудника); без поставщика в базу не пиши.',
    };
  },
});

const closeInputSchema = z.object({
  decision: z.enum(['saved', 'declined']),
});
interface CloseInput {
  decision: 'saved' | 'declined';
}
interface CloseOutput {
  closed: boolean;
  message: string;
}

/**
 * Закрыть ожидание правки: сотрудник ответил «нет» (`declined`) либо цены уже записаны прежним
 * путём (`saved`). Ничего в базу не пишет.
 */
export const closePendingPriceEdit = defineTool<CloseInput, CloseOutput, PricesDeps>({
  name: 'closePendingPriceEdit',
  sideEffect: true,
  description:
    'Закрыть ожидание ответа по правке файла: decision=declined, когда сотрудник отказался ' +
    'обновлять базу («нет», «не надо»), decision=saved после того, как цены записаны прежним ' +
    'путём. В базу этот инструмент ничего не пишет.',
  inputSchema: closeInputSchema,
  outputSchema: z.object({ closed: z.boolean(), message: z.string() }),
  async execute(input, deps, context) {
    const threadId = await followupThreadOf(deps, context);
    if (deps.state === undefined || threadId === null) {
      return { closed: false, message: NO_FOLLOWUP_MESSAGE };
    }
    const value = await loadFollowup(deps.state, threadId, deps.clock.now());
    if (value === null) return { closed: false, message: NO_FOLLOWUP_MESSAGE };
    await deps.state.delete(PRICE_EDIT_FOLLOWUP_NAMESPACE, threadId);
    return {
      closed: true,
      message:
        input.decision === 'declined'
          ? 'Ожидание закрыто, база не менялась. Скажи сотруднику, что цены в базе остались ' +
            'прежними.'
          : 'Ожидание закрыто.',
    };
  },
});
