import { MastraAgentRuntime } from '@business-ai/adapters';
import type {
  AgentEvent,
  AgentRunOptions,
  AgentRunResult,
  AgentRunSpec,
  AgentRuntime,
} from '@business-ai/core';
import {
  configureTurnFileBuffer,
  createTurnFileStore,
  currentTurnFiles,
  flushTurnFiles,
  runInTurnFileStore,
  type TurnFileStore,
} from '../turn-file-buffer';

/**
 * Обёртка рантайма для хода сотрудника (этап 9u: один файл правки прайса за ход).
 *
 * 1. Накопленные за ход файлы (`turn-file-buffer.ts`) отправляются ОДИН раз в конце хода и ДО
 *    финального текста: для `run`/`resume` после результата, для потоков перед событием `done`.
 *    Ход, закончившийся исключением или закрытый досрочно, отправляет собранное с пометкой.
 * 2. Для агента прайсов промежуточный текст шагов («отправляю копию заново») не склеивается с
 *    итогом: между шагами в поток уходит разделитель, а итог `done` - только текст после
 *    последнего вызова инструмента.
 *
 * Ставится на прототип `MastraAgentRuntime` один раз за процесс и вызывает «прежний» метод, какой
 * бы он ни был: защита от пустого ответа (`empty-reply-guard.ts`) стоит на тех же методах, порядок
 * установки не важен. Настройка читается при каждом вызове.
 */

/** Событие журнала: промежуточные тексты шагов не ушли сотруднику. */
export const STEP_TEXT_DROPPED_EVENT = 'step_text_dropped';

/** Разделитель между текстами шагов в потоке черновика. */
export const STEP_TEXT_SEPARATOR = '\n\n';

/** Журнал обёртки: только коды и числа. */
type WrapLog = (event: string, fields?: Record<string, string | number>) => void;

/** Настройка обёртки. */
export interface TurnRuntimeWrapOptions {
  /** `PRICE_FILE_ONCE_PER_TURN_ENABLED`: откладывать файлы до конца хода. */
  enabled: boolean;
  /** `STEP_TEXT_SEPARATE_ENABLED`: отделять промежуточный текст шагов агента прайсов. */
  stepTextEnabled: boolean;
  /** Идентификатор агента прайсов (`PRICES_AGENT_ID`). */
  pricesAgentId: string;
  /** Журнал службы; нет - события не пишутся. */
  log?: WrapLog | undefined;
}

/** Методы рантайма, которые оборачиваются. */
type WrappedMethods = Pick<AgentRuntime, 'run' | 'stream' | 'resume' | 'streamResume'>;

/** Метка на прототипе: обёртки уже установлены. */
const INSTALLED = Symbol.for('pragmatika.turnRuntimeWrap.installed');

/** Текущая настройка. */
const current: TurnRuntimeWrapOptions = {
  enabled: false,
  stepTextEnabled: false,
  pricesAgentId: '',
  log: undefined,
};

/** Ход сотрудника (то же правило, что у защиты от пустого ответа). */
function isEmployeeTurn(options: AgentRunOptions | undefined): boolean {
  const context = options?.context;
  if (context === undefined) return true;
  if (context.mode === 'call') return false;
  if ((context.depth ?? 0) > 0) return false;
  return context.initiator?.kind !== 'scheduler';
}

/** Записать событие; сбой журнала не ломает ход. */
function emit(event: string, fields?: Record<string, string | number>): void {
  try {
    current.log?.(event, fields);
  } catch {
    // Журнал вторичен.
  }
}

/** Новое состояние отслеживания сегментов. */
export function createSegmentTracker(): SegmentTracker {
  return { segments: [], afterTool: false };
}

/** Состояние отслеживания сегментов текста между вызовами инструментов. */
export interface SegmentTracker {
  /** Тексты сегментов по порядку (сегмент начинается с первого текста после инструмента). */
  segments: string[];
  /** После инструмента ещё не было текста: следующий текст начнёт новый сегмент. */
  afterTool: boolean;
}

/** Есть ли в сегментах непустой текст. */
function hasText(segments: readonly string[]): boolean {
  return segments.some((segment) => segment.trim() !== '');
}

/**
 * Учесть событие потока. Возвращает разделитель, который надо отдать ПЕРЕД событием (или
 * `undefined`).
 */
export function trackEvent(tracker: SegmentTracker, event: AgentEvent): AgentEvent | undefined {
  if (event.type === 'tool_start' || event.type === 'tool_end' || event.type === 'tool_blocked') {
    tracker.afterTool = true;
    return undefined;
  }
  if (event.type !== 'text_delta') return undefined;
  let separator: AgentEvent | undefined;
  if (tracker.afterTool || tracker.segments.length === 0) {
    if (hasText(tracker.segments)) separator = { type: 'text_delta', text: STEP_TEXT_SEPARATOR };
    tracker.segments.push('');
    tracker.afterTool = false;
  }
  tracker.segments[tracker.segments.length - 1] += event.text;
  return separator;
}

/** Итог без промежуточных текстов: только последний сегмент (после последнего инструмента). */
export function withLastSegmentOnly(
  result: AgentRunResult,
  tracker: SegmentTracker,
): AgentRunResult {
  if (result.status !== 'completed' || result.turnEndedByTool === true) return result;
  if (tracker.afterTool) return result;
  const last = tracker.segments[tracker.segments.length - 1];
  if (last === undefined || last.trim() === '') return result;
  const earlier = tracker.segments.slice(0, -1).filter((segment) => segment.trim() !== '');
  if (earlier.length === 0) return result;
  emit(STEP_TEXT_DROPPED_EVENT, { segments: earlier.length });
  return { ...result, output: last.trim() };
}

/** Параметры потока: что открывать и к какому агенту относится. */
interface StreamTurn {
  open: () => AsyncIterable<AgentEvent>;
  /** Агент известен (`stream`) и это агент прайсов: можно отделять текст шагов. */
  separateSteps: boolean;
}

/** Поток хода сотрудника: контекст файлов на каждом шаге, flush перед `done`. */
async function* turnStream(turn: StreamTurn): AsyncGenerator<AgentEvent> {
  const store: TurnFileStore | undefined =
    current.enabled && currentTurnFiles() === undefined ? createTurnFileStore() : undefined;
  const inStore = <T>(work: () => T): T =>
    store === undefined ? work() : runInTurnFileStore(store, work);
  const tracker = createSegmentTracker();
  let iterator: AsyncIterator<AgentEvent> | undefined;
  let flushed = false;
  let finished = false;
  try {
    // Работа Mastra может стартовать при создании потока или при первом next: покрываем оба.
    iterator = inStore(() => turn.open()[Symbol.asyncIterator]());
    const source = iterator;
    for (;;) {
      const step = await inStore(() => source.next());
      if (step.done === true) {
        finished = true;
        return;
      }
      const event = step.value;
      if (event.type === 'done') {
        const result = turn.separateSteps
          ? withLastSegmentOnly(event.result, tracker)
          : event.result;
        flushed = true;
        if (store !== undefined) await flushTurnFiles(store, 'ok');
        finished = true;
        yield { type: 'done', result };
        return;
      }
      if (turn.separateSteps) {
        const separator = trackEvent(tracker, event);
        if (separator !== undefined) yield separator;
      }
      yield event;
    }
  } finally {
    if (!flushed && store !== undefined) await flushTurnFiles(store, 'failed');
    const source = iterator;
    if (!finished && source?.return !== undefined) {
      try {
        await inStore(() => source.return?.());
      } catch {
        // Закрытие внутреннего потока вторично.
      }
    }
  }
}

/** Установить обёртки на прототип рантайма (один раз за процесс). */
function install(): void {
  const proto = MastraAgentRuntime.prototype as unknown as WrappedMethods &
    Record<symbol, boolean | undefined>;
  if (proto[INSTALLED] === true) return;
  const { run, stream, resume, streamResume } = proto;

  /** Выполнить `run`/`resume` с накоплением файлов хода и отправкой в конце. */
  const runTurn = async (
    options: AgentRunOptions | undefined,
    work: () => Promise<AgentRunResult>,
  ): Promise<AgentRunResult> => {
    if (!current.enabled || !isEmployeeTurn(options) || currentTurnFiles() !== undefined) {
      return work();
    }
    const store = createTurnFileStore();
    let result: AgentRunResult;
    try {
      result = await runInTurnFileStore(store, work);
    } catch (error) {
      await flushTurnFiles(store, 'failed');
      throw error;
    }
    await flushTurnFiles(store, 'ok');
    return result;
  };

  proto.run = function turnRun(
    this: AgentRuntime,
    spec: AgentRunSpec,
    threadId: string,
    input: string,
    options?: AgentRunOptions,
  ): Promise<AgentRunResult> {
    return runTurn(options, () => run.call(this, spec, threadId, input, options));
  };
  proto.resume = function turnResume(
    this: AgentRuntime,
    threadId: string,
    input: string,
    options?: AgentRunOptions,
  ): Promise<AgentRunResult> {
    return runTurn(options, () => resume.call(this, threadId, input, options));
  };
  proto.stream = function turnStreamMethod(
    this: AgentRuntime,
    spec: AgentRunSpec,
    threadId: string,
    input: string,
    options?: AgentRunOptions,
  ): AsyncIterable<AgentEvent> {
    const employee = isEmployeeTurn(options);
    const separateSteps =
      employee && current.stepTextEnabled && spec.id === current.pricesAgentId;
    if (!employee || (!current.enabled && !separateSteps)) {
      return stream.call(this, spec, threadId, input, options);
    }
    return turnStream({
      open: () => stream.call(this, spec, threadId, input, options),
      separateSteps,
    });
  };
  proto.streamResume = function turnStreamResume(
    this: AgentRuntime,
    threadId: string,
    input: string,
    options?: AgentRunOptions,
  ): AsyncIterable<AgentEvent> {
    // Агента при возобновлении не знаем: текст шагов не отделяем, только файлы.
    if (!current.enabled || !isEmployeeTurn(options)) {
      return streamResume.call(this, threadId, input, options);
    }
    return turnStream({
      open: () => streamResume.call(this, threadId, input, options),
      separateSteps: false,
    });
  };
  proto[INSTALLED] = true;
}

/**
 * Настроить обёртку (вызывает сборка агентов). Включает буфер файлов хода и ставит обёртки на
 * рантайм; повтор вызова безопасен (обёртки не удваиваются), выключатели действуют сразу.
 */
export function configureTurnRuntimeWrap(options: TurnRuntimeWrapOptions): void {
  current.enabled = options.enabled;
  current.stepTextEnabled = options.stepTextEnabled;
  current.pricesAgentId = options.pricesAgentId;
  current.log = options.log;
  configureTurnFileBuffer({ enabled: options.enabled, log: options.log });
  if (options.enabled || options.stepTextEnabled) install();
}
