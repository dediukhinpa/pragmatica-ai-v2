import { SITE_DESCRIPTION_MAX_CHARS } from '../../kit/domain/site-export';
import type { SiteTextEditRequest, SiteTextEditor } from '../../kit/ports/site-text-editor';
import type { TemplateStructure } from '@business-ai/core';
import { compareInvariants, normalizeSpaces, violatesInvariants } from './cell-text';
import {
  cellVerdictKey,
  type CellVerdict,
  type FillPlan,
  type PlanCell,
  type PlannedEdit,
} from './fill-plan';
import {
  convertSize,
  convertSizeParts,
  DEFAULT_SIZE_UNIT,
  headerUnit,
  type SizeConversion,
} from './size-units';
import type { FreshUnresolved } from './size-unresolved';
import { findHeader, isBlank, lookupColumn, textColumnKinds } from './template-columns';

/**
 * Подготовка значений вокруг плана записи (этап 225), в два шага вокруг `planFill`:
 * 1) `prepareCells` - локально, без модели: пробелы, единица размера по шапке;
 * 2) `refineDescriptions` - только для ячеек, которые план УЖЕ принял: предел и орфография
 *    описания моделью; затем вызывающий повторяет план с исправленными значениями.
 * Так модель не получает тексты, которые всё равно будут отклонены (чужая непустая ячейка,
 * защищённая строка, дубль), а повторная проверка идёт по тем же правилам плана.
 */

/** Текстов в одном вызове модели: ответ (до 1500 знаков на текст) должен уложиться в лимит. */
const TEXT_EDIT_BATCH_SIZE = 15;
/** Попыток правки одного текста: первая и одна повторная с указанием, что не так. */
const TEXT_EDIT_ATTEMPTS = 2;
/** Сколько различий показываем в сообщении об отказе. */
const DIFF_LISTED_MAX = 6;
/** Причина для текста, пакет которого не обработан сервисом. */
const EDITOR_UNAVAILABLE = 'сервис правки текстов недоступен';

/** Единица размера, которой пользовались при переводе, - для ответа инструмента. */
interface SizeUnitNote {
  column: string;
  unit: string;
  /** Единицы в шапке нет: взята единица по умолчанию. */
  assumed: boolean;
}

/** Длина названия позиции в предупреждении о неопределённых размерах. */
const POSITION_NAME_MAX = 60;
/** Отказ для `dimensions` вне столбца «Размер упаковки» главного листа. */
const DIMENSIONS_ONLY_FOR_SIZE =
  'Поле dimensions принимается только для столбца «Размер упаковки» главного листа; ' +
  'здесь передай value.';

/** Позиция запроса с изменяемым списком ячеек: значения подменяются на месте. */
interface MutableItem {
  row?: number | undefined;
  cells: PlanCell[];
}

/** Что локальная подготовка вернула планировщику. */
export interface PreparedCells {
  items: MutableItem[];
  verdicts: Map<string, CellVerdict>;
  warnings: string[];
  sizeUnits: SizeUnitNote[];
  /**
   * Позиции, у которых размер есть в источнике, но не записан: порядок Ш×В×Г определить нельзя
   * либо запись не разобрана (решение владельца 15). Ячейка размера пуста, вопрос сотруднику не
   * задаётся, позиции выводятся предупреждением в итоге задачи.
   * Подпись без строки собирает вызывающий: строка листа известна только после плана.
   */
  sizeUnresolved: FreshUnresolved[];
  /** Позиции, у которых размер разобран и записывается (снимают прежнее предупреждение). */
  sizeResolved: number[];
}

export interface PrepareInput {
  items: ReadonlyArray<{ row?: number | undefined; cells: readonly PlanCell[] }>;
  structure: TemplateStructure;
  isMainSheet: boolean;
}

/**
 * Локальная подготовка до плана, без модели: пробелы и размер упаковки в единице шапки.
 * Пробелы: полная нормализация только в колонках «Название» и «Описание», в остальных (артикулы,
 * ссылки, списки, листы 2-4) - только края и неразрывные. Позиции и номера ячеек не меняются,
 * поэтому решения сопоставляются с ячейками по `cellVerdictKey`.
 */
export function prepareCells(input: PrepareInput): PreparedCells {
  const verdicts = new Map<string, CellVerdict>();
  const warnings: string[] = [];
  const sizeUnits: SizeUnitNote[] = [];
  const sizeUnresolved: FreshUnresolved[] = [];
  const sizeResolved: number[] = [];
  const { headers } = input.structure;
  const text = textColumnKinds(headers);
  const nameLetter = findHeader(headers, 'name')?.letter;
  for (const kind of text.ambiguous) {
    warnings.push(
      `В шапке несколько колонок вида «${kind === 'size' ? 'Размер упаковки' : 'Описание'}»: ` +
        'роль колонки неоднозначна, проверки (предел, единица) не выполнялись - проверь значения.',
    );
  }
  const items: MutableItem[] = input.items.map((item) => ({
    ...item,
    cells: item.cells.map((cell): PlanCell => {
      if (typeof cell.value !== 'string') return cell;
      const found = input.isMainSheet ? lookupColumn(headers, cell.column) : null;
      const header = found?.status === 'ok' ? found.header : null;
      const prose =
        header !== null &&
        (text.kinds.get(header.letter) === 'description' || header.letter === nameLetter);
      return { ...cell, value: normalizeSpaces(cell.value, prose ? 'prose' : 'strict') };
    }),
  }));
  if (!input.isMainSheet) {
    // Размер по подписям собирается только в столбце главного листа: на листах 2-4 ячейка без
    // value молча стала бы «пустой» - отказ называет причину.
    items.forEach((item, itemIndex) => {
      item.cells.forEach((cell, cellIndex) => {
        if (cell.dimensions === undefined) return;
        verdicts.set(cellVerdictKey(itemIndex, cellIndex), {
          reason: 'size_unparsable',
          message: DIMENSIONS_ONLY_FOR_SIZE,
        });
      });
    });
    return { items, verdicts, warnings, sizeUnits, sizeUnresolved, sizeResolved };
  }

  const noted = new Set<string>();
  items.forEach((item, itemIndex) => {
    item.cells.forEach((cell, cellIndex) => {
      const found = lookupColumn(headers, cell.column);
      if (found.status !== 'ok') return;
      const { header } = found;
      const isSize = text.kinds.get(header.letter) === 'size';
      const key = cellVerdictKey(itemIndex, cellIndex);
      if (cell.dimensions !== undefined && !isSize) {
        verdicts.set(key, {
          reason: 'size_unparsable',
          message: DIMENSIONS_ONLY_FOR_SIZE,
        });
        return;
      }
      if (!isSize || (isBlank(cell.value) && cell.dimensions === undefined)) return;
      if (cell.dimensions !== undefined && !isBlank(cell.value)) {
        verdicts.set(key, {
          reason: 'size_unparsable',
          message: 'Передай размер либо в value, либо в dimensions, не вместе.',
        });
        return;
      }
      const unit = headerUnit(header.text);
      const target = unit ?? DEFAULT_SIZE_UNIT;
      if (!noted.has(header.letter)) {
        noted.add(header.letter);
        sizeUnits.push({ column: header.text, unit: target, assumed: unit === null });
        if (unit === null) {
          warnings.push(
            `В шапке «${header.text}» нет единицы измерения: размер записан в ` +
              `${DEFAULT_SIZE_UNIT} (единица по умолчанию), проверь шапку шаблона.`,
          );
        }
      }
      const converted: SizeConversion =
        cell.dimensions === undefined
          ? convertSize(cell.value, target)
          : convertSizeParts(cell.dimensions, target);
      if (converted.ok) {
        const { dimensions: _parts, ...rest } = cell;
        item.cells[cellIndex] = { ...rest, value: converted.value };
        sizeResolved.push(itemIndex);
        return;
      }
      // Размер в источнике есть, но в ячейку не попал (порядок неясен или запись не разобрана):
      // позицию называет предупреждение, которое собирает код, а не память модели (решение 15).
      sizeUnresolved.push({ itemIndex, name: positionName(item, headers, nameLetter) });
      verdicts.set(key, {
        reason: converted.kind === 'order_unclear' ? 'size_order_unclear' : 'size_unparsable',
        message: converted.message,
      });
    });
  });
  return { items, verdicts, warnings, sizeUnits, sizeUnresolved, sizeResolved };
}

/** Название позиции для предупреждения: ячейка «Название»; нет названия - null. */
function positionName(
  item: MutableItem,
  headers: TemplateStructure['headers'],
  nameLetter: string | undefined,
): string | null {
  const nameCell = item.cells.find((cell) => {
    const found = lookupColumn(headers, cell.column);
    return found.status === 'ok' && found.header.letter === nameLetter;
  });
  const raw = String(nameCell?.value ?? '').trim();
  if (raw === '') return null;
  return raw.length > POSITION_NAME_MAX ? `${raw.slice(0, POSITION_NAME_MAX)}...` : raw;
}

/** Описание в работе у редактора. */
interface Job {
  key: string;
  itemIndex: number;
  cellIndex: number;
  original: string;
  compress: boolean;
}

/** Почему текст пока не принят. */
interface Failure {
  problem: string;
  /** Прошлый вариант модели, который не подошёл по длине. */
  draft?: string;
  /** Нарушены инварианты (числа, артикулы, единицы, токены). */
  invariants: boolean;
  /** Пакет не обработан сервисом (сбой), а не отвергнут проверкой кода. */
  unavailable: boolean;
}

type Judged = { ok: true; text: string; dropped: string[] } | ({ ok: false } & Failure);

function listed(items: readonly string[]): string {
  const head = items.slice(0, DIFF_LISTED_MAX).join(', ');
  return items.length > DIFF_LISTED_MAX ? `${head} и ещё ${items.length - DIFF_LISTED_MAX}` : head;
}

/** Проверить ответ редактора кодом: инварианты относительно исходного текста, затем длина. */
function judge(job: Job, raw: string | undefined): Judged {
  const reject = (problem: string, extra: Partial<Failure> = {}): Judged => ({
    ok: false,
    problem,
    invariants: false,
    unavailable: false,
    ...extra,
  });
  if (raw === undefined) return reject('модель не вернула текст');
  const text = normalizeSpaces(raw);
  if (text === '') return reject('модель вернула пустой текст');
  const diff = compareInvariants(job.original, text);
  if (violatesInvariants(diff, job.compress)) {
    const parts = [
      diff.added.length > 0 ? `изменено или выдумано: ${listed(diff.added)}` : '',
      !job.compress && diff.dropped.length > 0 ? `потеряно: ${listed(diff.dropped)}` : '',
      !job.compress && diff.reordered ? 'порядок чисел и единиц изменён' : '',
    ].filter((part) => part !== '');
    return reject(parts.join('; '), { invariants: true });
  }
  if (text.length > SITE_DESCRIPTION_MAX_CHARS) {
    return reject(`длина ${text.length} знаков при пределе ${SITE_DESCRIPTION_MAX_CHARS}`, {
      draft: text,
    });
  }
  return { ok: true, text, dropped: job.compress ? diff.dropped : [] };
}

/** Сообщение агенту, когда описание не записано: сокращать придётся ему. */
function shortenYourself(job: Job, reason: string): string {
  return (
    `Описание ${job.original.length} знаков, предел ${SITE_DESCRIPTION_MAX_CHARS}; ${reason}. ` +
    'Сократи текст своими словами (без обрезки на полуслове): числа, артикулы и единицы ' +
    'измерения не меняй, передай ту же позицию с row.'
  );
}

/**
 * Ответ пакета не доверенный: набор id обязан быть подмножеством запрошенных без повторов.
 * Чужой или повторный id - ответу целиком верить нельзя (непонятно, чей текст чей), пакет
 * отвергается и идёт на повтор. Пропущенный id - не беда, это отказ по одной ячейке.
 */
function answerIdsProblem(
  asked: readonly SiteTextEditRequest[],
  answered: ReadonlyArray<{ id: string }>,
): string | null {
  const known = new Set(asked.map((request) => request.id));
  const seen = new Set<string>();
  for (const { id } of answered) {
    if (!known.has(id)) return 'ответ модели содержит чужой идентификатор';
    if (seen.has(id)) return 'ответ модели повторяет идентификатор';
    seen.add(id);
  }
  return null;
}

/** Результат правки описаний. */
export interface RefinedDescriptions {
  /** Позиции запроса с принятыми текстами. */
  items: MutableItem[];
  /** Решения по ячейкам, которые писать нельзя. */
  verdicts: Map<string, CellVerdict>;
  warnings: string[];
}

export interface RefineInput {
  /** План без модели: правятся только его принятые ячейки. */
  plan: FillPlan;
  /** Позиции, по которым строился план. */
  items: readonly MutableItem[];
  structure: TemplateStructure;
  editor: SiteTextEditor;
  signal: AbortSignal;
  /** Тред агента: токены псевдонимизации стабильны в его рамках. */
  threadId: string;
}

/** Принятые планом правки значений описания (кроме штампов кода). */
function descriptionJobs(input: RefineInput): Job[] {
  const { kinds } = textColumnKinds(input.structure.headers);
  const jobs: Job[] = [];
  for (const edit of input.plan.edits as readonly PlannedEdit[]) {
    if (edit.stamped || kinds.get(edit.letter ?? '') !== 'description') continue;
    if (typeof edit.value !== 'string' || edit.value === '') continue;
    jobs.push({
      key: cellVerdictKey(edit.itemIndex, edit.cellIndex),
      itemIndex: edit.itemIndex,
      cellIndex: edit.cellIndex,
      original: edit.value,
      compress: edit.value.length > SITE_DESCRIPTION_MAX_CHARS,
    });
  }
  return jobs;
}

/**
 * Прогнать описания, принятые планом, через редактор: до двух попыток на текст, каждый ответ
 * проверяется кодом. Пакеты независимы: сбой или негодный ответ одного пакета не выбрасывает
 * принятое в других, повтор идёт только по непринятым. Не прошло - правка модели отвергается:
 * короткий текст остаётся исходным (с предупреждением), длинный не пишется (отказ с причиной).
 * Отмену хода пробрасываем, прочие сбои - как «сервис недоступен».
 */
export async function refineDescriptions(input: RefineInput): Promise<RefinedDescriptions> {
  const items: MutableItem[] = input.items.map((item) => ({ ...item, cells: [...item.cells] }));
  const verdicts = new Map<string, CellVerdict>();
  const warnings: string[] = [];
  let pending = descriptionJobs(input);
  const last = new Map<string, Failure>();
  const write = (job: Job, value: string): void => {
    const target = items[job.itemIndex];
    const cell = target?.cells[job.cellIndex];
    if (target !== undefined && cell !== undefined) {
      target.cells[job.cellIndex] = { ...cell, value };
    }
  };
  for (let attempt = 1; attempt <= TEXT_EDIT_ATTEMPTS && pending.length > 0; attempt += 1) {
    const requests: SiteTextEditRequest[] = pending.map((job) => {
      const failed = last.get(job.key);
      return {
        id: job.key,
        text: job.original,
        maxChars: SITE_DESCRIPTION_MAX_CHARS,
        compress: job.compress,
        ...(failed === undefined ? {} : { problem: failed.problem }),
        ...(failed?.draft === undefined ? {} : { draft: failed.draft }),
      };
    });
    const answers = new Map<string, string>();
    const batchFailed = new Map<string, Failure>();
    for (let from = 0; from < requests.length; from += TEXT_EDIT_BATCH_SIZE) {
      const batch = requests.slice(from, from + TEXT_EDIT_BATCH_SIZE);
      const fail = (problem: string, unavailable: boolean): void => {
        for (const request of batch) {
          batchFailed.set(request.id, { problem, invariants: false, unavailable });
        }
      };
      try {
        const answered = await input.editor.edit(batch, {
          signal: input.signal,
          threadId: input.threadId,
        });
        const problem = answerIdsProblem(batch, answered);
        if (problem !== null) fail(problem, false);
        else for (const item of answered) answers.set(item.id, item.text);
      } catch {
        input.signal.throwIfAborted();
        fail(EDITOR_UNAVAILABLE, true);
      }
    }
    const retry: Job[] = [];
    for (const job of pending) {
      const failedBatch = batchFailed.get(job.key);
      const judged: Judged =
        failedBatch === undefined
          ? judge(job, answers.get(job.key))
          : { ok: false, ...failedBatch };
      if (judged.ok) {
        write(job, judged.text);
        if (judged.dropped.length > 0) {
          warnings.push(
            `Позиция ${job.itemIndex}: при сжатии описания опущено: ${listed(judged.dropped)}.`,
          );
        }
      } else {
        last.set(job.key, judged);
        retry.push(job);
      }
    }
    pending = retry;
  }
  const unavailable = pending.filter((job) => last.get(job.key)?.unavailable === true);
  if (unavailable.length > 0) {
    warnings.push(
      `Сервис правки текстов недоступен: орфография ${unavailable.length} описаний не проверена.`,
    );
  }
  for (const job of pending) {
    const failed = last.get(job.key);
    const reason = failed?.problem ?? EDITOR_UNAVAILABLE;
    if (job.original.length <= SITE_DESCRIPTION_MAX_CHARS) {
      // Исходный текст укладывается в предел: пишем его, правка модели отвергнута.
      if (failed?.unavailable !== true) {
        warnings.push(
          `Позиция ${job.itemIndex}: правка описания отклонена (${reason}), записан исходный ` +
            'текст без правки орфографии.',
        );
      }
      continue;
    }
    verdicts.set(job.key, {
      reason: failed?.invariants === true ? 'text_invariant_changed' : 'value_too_long',
      message: shortenYourself(job, `модель не смогла сжать текст: ${reason}`),
    });
  }
  return { items, verdicts, warnings };
}
