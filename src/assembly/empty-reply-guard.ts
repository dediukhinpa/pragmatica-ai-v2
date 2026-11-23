import { MastraAgentRuntime } from '@business-ai/adapters';
import type {
  AgentEvent,
  AgentRunOptions,
  AgentRunResult,
  AgentRunSpec,
  AgentRuntime,
} from '@business-ai/core';

/**
 * Защита от пустого ответа сотруднику (этап 9t, живой баг на большом docx).
 *
 * Платформа 1.1.6: если модель закончила ход без текста, рантайм один раз просит её продолжить
 * (`agent_empty_turn_retry`), а при втором пустом ответе возвращает пустой итог. Рантайм сохраняет
 * его в историю как пустое сообщение ассистента, а насос чата отправляет сотруднику «Готово.»:
 * сотрудник считает, что всё сделано, хотя файла нет. Менять платформу нельзя, поэтому проект
 * оборачивает методы рантайма (`run`, `stream`, `resume`, `streamResume`) на прототипе
 * `MastraAgentRuntime`: пустой итог ХОДА СОТРУДНИКА заменяется понятным сообщением, а факт
 * пишется в журнал. Выключатель `EMPTY_REPLY_GUARD_ENABLED=false` возвращает прежнее поведение
 * (обёртки остаются, но передают результат как есть).
 *
 * Не трогаются: ход, законченный инструментом (`turnEndedByTool`), приостановленный ход, дочерние
 * ходы (режим вызова, глубина больше нуля) и плановые запуски: их итог читает код, а не человек.
 */

/** Событие журнала: пустой итог заменён сообщением сотруднику. */
export const EMPTY_REPLY_EVENT = 'empty_reply_guarded';

/** Что увидит сотрудник вместо пустого ответа: без служебных деталей. */
export const EMPTY_REPLY_TEXT =
  'Не получилось подготовить ответ. Исходный файл не менялся. Если файл или сообщение ' +
  'уже пришли выше, пользуйтесь ими; иначе повторите просьбу, а если ошибка повторится, ' +
  'обратитесь к руководителю.';

/** Журнал защиты: только коды и числа. */
type GuardLog = (event: string, fields?: Record<string, string | number>) => void;

/** Какой метод рантайма вернул пустой итог (поле журнала). */
type GuardedOperation = 'run' | 'stream' | 'resume' | 'stream_resume';

/** Настройка защиты. */
export interface EmptyReplyGuardOptions {
  /** Включена ли замена; `false` - обёртки пропускают результат без изменений. */
  enabled: boolean;
  /** Журнал службы; нет - событие не пишется. */
  log?: GuardLog | undefined;
}

/** Методы рантайма, которые оборачиваются. */
type GuardedMethods = Pick<AgentRuntime, 'run' | 'stream' | 'resume' | 'streamResume'>;

/** Метка на прототипе: обёртки уже установлены (повторная настройка их не удваивает). */
const INSTALLED = Symbol.for('pragmatika.emptyReplyGuard.installed');

/** Текущая настройка: обёртки читают её при каждом вызове, поэтому выключатель действует сразу. */
const current: { enabled: boolean; log: GuardLog | undefined } = {
  enabled: false,
  log: undefined,
};

/** Ход сотрудника: итог получает человек, а не код другого агента или планировщик. */
function isEmployeeTurn(options: AgentRunOptions | undefined): boolean {
  const context = options?.context;
  if (context === undefined) return true;
  if (context.mode === 'call') return false;
  if ((context.depth ?? 0) > 0) return false;
  return context.initiator?.kind !== 'scheduler';
}

/** Итог завершён, не закончен инструментом и пуст (в том числе из одних пробелов). */
function isEmptyOutcome(result: AgentRunResult): boolean {
  return (
    result.status === 'completed' && result.turnEndedByTool !== true && result.output.trim() === ''
  );
}

/** Заменить пустой итог сообщением и записать событие; прочие итоги возвращаются как есть. */
function guardResult(
  result: AgentRunResult,
  agentId: string | undefined,
  operation: GuardedOperation,
  options: AgentRunOptions | undefined,
): AgentRunResult {
  if (!current.enabled || !isEmployeeTurn(options) || !isEmptyOutcome(result)) return result;
  try {
    current.log?.(EMPTY_REPLY_EVENT, { agent: agentId ?? 'unknown', operation });
  } catch {
    // Журнал вторичен: его сбой не должен отнять у сотрудника сообщение.
  }
  return { ...result, output: EMPTY_REPLY_TEXT };
}

/** Поток событий с заменой итога в завершающем `done`. */
async function* guardEvents(
  events: AsyncIterable<AgentEvent>,
  agentId: string | undefined,
  operation: GuardedOperation,
  options: AgentRunOptions | undefined,
): AsyncGenerator<AgentEvent> {
  for await (const event of events) {
    yield event.type === 'done'
      ? { type: 'done', result: guardResult(event.result, agentId, operation, options) }
      : event;
  }
}

/** Установить обёртки на прототип рантайма (один раз за процесс). */
function install(): void {
  const proto = MastraAgentRuntime.prototype as unknown as GuardedMethods &
    Record<symbol, boolean | undefined>;
  if (proto[INSTALLED] === true) return;
  const { run, stream, resume, streamResume } = proto;
  proto.run = async function guardedRun(
    this: AgentRuntime,
    spec: AgentRunSpec,
    threadId: string,
    input: string,
    options?: AgentRunOptions,
  ): Promise<AgentRunResult> {
    const result = await run.call(this, spec, threadId, input, options);
    return guardResult(result, spec.id, 'run', options);
  };
  proto.stream = function guardedStream(
    this: AgentRuntime,
    spec: AgentRunSpec,
    threadId: string,
    input: string,
    options?: AgentRunOptions,
  ): AsyncIterable<AgentEvent> {
    const events = stream.call(this, spec, threadId, input, options);
    return guardEvents(events, spec.id, 'stream', options);
  };
  proto.resume = async function guardedResume(
    this: AgentRuntime,
    threadId: string,
    input: string,
    options?: AgentRunOptions,
  ): Promise<AgentRunResult> {
    const result = await resume.call(this, threadId, input, options);
    return guardResult(result, undefined, 'resume', options);
  };
  proto.streamResume = function guardedStreamResume(
    this: AgentRuntime,
    threadId: string,
    input: string,
    options?: AgentRunOptions,
  ): AsyncIterable<AgentEvent> {
    return guardEvents(
      streamResume.call(this, threadId, input, options),
      undefined,
      'stream_resume',
      options,
    );
  };
  proto[INSTALLED] = true;
}

/**
 * Настроить защиту (вызывает сборка агентов с флагом `EMPTY_REPLY_GUARD_ENABLED`). Включённая
 * защита ставит обёртки на рантайм; выключенная их не ставит, а уже стоящие (повторная сборка в
 * том же процессе, тесты) переключает в режим «как есть». Повтор вызова безопасен.
 */
export function configureEmptyReplyGuard(options: EmptyReplyGuardOptions): void {
  current.enabled = options.enabled;
  current.log = options.log;
  if (options.enabled) install();
}
