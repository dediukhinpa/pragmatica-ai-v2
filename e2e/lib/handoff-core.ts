import {
  MemoryChatChannel,
  MemoryCrm,
  SystemClock,
  SystemIdGenerator,
  type PgClient,
} from '@business-ai/adapters';
import {
  chatHooksOf,
  effectiveSchedules,
  handoffRecordSchema,
  lifecycleOf,
  type HandoffRecord,
} from '@business-ai/core';
import { pragmatikaProject, type PragmatikaConfig } from '../../src';
import { composeProduction, type StopReport } from './project-env';
import {
  createService,
  type ProductionApp,
  type ProductionConfig,
  type Service,
} from '@business-ai/core/compose';
import { firstToken } from '@business-ai/testing/e2e';
import { e2eConfig, e2eEnv } from './project-env';
import type { StubReply } from '@business-ai/testing/e2e';

/** Агенты передачи (идентификаторы из реестра ядра). */
export const ORDER_CALC = 'order-calc';
/** Алиасы моделей из `e2eConfig`: по ним заглушка отличает агентов. */
export const ORDER_CALC_MODEL = 'e2e-order-calc';
export const PRICES_MODEL = 'e2e-prices';

/** Как часто воркер опрашивает очередь, мс: достаточно быстро для теста. */
export const E2E_WORKER_INTERVAL_MS = 150;
/** Сколько служба ждёт текущие задачи при остановке, мс: подвешенный ход ждать незачем. */
export const E2E_SHUTDOWN_MS = 400;
/**
 * Сколько ждать наступления условия в сценарии, мс.
 * Этап 185: 90 с не хватало на полном прогоне под нагрузкой (n2 ждал «Передал» ровно 90 с,
 * в одиночном прогоне проходит за секунды), поэтому запас увеличен; таймаут теста — 180 с.
 */
export const WAIT_TIMEOUT_MS = 120_000;
const POLL_MS = 100;
/** Срок, на который «старим» захват задачи при имитации падения процесса: больше видимости. */
const STALE_LOCK_MINUTES = 21;
/** Срок в прошлом для просроченных записей, часов. */
const PAST_HOURS = 3;

/** Периодически проверяет условие; при таймауте бросает ошибку с понятным описанием. */
export async function waitFor(
  what: string,
  check: () => boolean | Promise<boolean>,
  timeoutMs = WAIT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`Не дождались: ${what}`);
    await Bun.sleep(POLL_MS);
  }
}

/** Пауза «ничего не должно произойти»: проверка отсутствия повторного эффекта. */
export async function settle(ms: number): Promise<void> {
  await Bun.sleep(ms);
}

/** Файл правил доступа: бот -> сотрудники, которым он разрешён (`chat.message`). */
export async function writeAccessRules(
  name: string,
  bots: Readonly<Record<string, readonly string[]>>,
): Promise<string> {
  const rules = {
    version: 1,
    bots: Object.fromEntries(
      Object.entries(bots).map(([bot, users]) => [bot, { allow: { users: [...users] } }]),
    ),
  };
  const path = `${e2eEnv().work}/out/access-${name}.json`;
  await Bun.write(path, JSON.stringify(rules));
  return path;
}

/** Параметры запуска «ядра»: приложение + служба (воркер, насос чата) на общей БД. */
export interface CoreOptions {
  /** Путь к файлу правил (`writeAccessRules`). */
  accessFile: string;
  /** Дополнительные переменные окружения (флаги передачи, вызова). */
  env?: Record<string, string>;
  /** Канал чата; по умолчанию новый (после «перезапуска» канал тоже новый). */
  chat?: MemoryChatChannel;
  workerIntervalMs?: number;
  /** Журнал службы (коды без ПДн) для разбора. */
  logs?: string[];
}

/** Запущенное ядро. */
export interface Core {
  app: ProductionApp;
  chat: MemoryChatChannel;
  service: Service;
  logs: string[];
  /** Штатная остановка (SIGTERM): воркер возвращает неоконченную задачу в очередь. */
  stop(): Promise<StopReport>;
  /**
   * Имитация внезапной смерти процесса: соединения с БД закрываются, ничего больше записать
   * процесс не может; захваченная задача остаётся `running` до таймаута видимости.
   */
  crash(): Promise<void>;
  /** Остановить хвосты прежнего экземпляра после теста (все ошибки гасятся). */
  dispose(): Promise<void>;
}

/** Собрать боевое приложение на настоящих сервисах и запустить службу (как `main.ts`). */
export async function startCore(options: CoreOptions): Promise<Core> {
  const logs = options.logs ?? [];
  const config = e2eConfig({
    CHAT_AGENT_ID: ORDER_CALC,
    AGENT_HANDOFF_ORDER_CALC_TO_PRICES: 'true',
    ACCESS_POLICY_FILE: options.accessFile,
    ...(options.env ?? {}),
  });
  const chat = options.chat ?? new MemoryChatChannel();
  const app = composeProduction(config, { chat, crm: new MemoryCrm(new Map()) });
  const service = createService({
    app,
    chat,
    access: app.access,
    clock: new SystemClock(),
    ids: new SystemIdGenerator(),
    healthPort: 0,
    chatAgentId: config.service.chatAgentId,
    chatTurnTimeoutMs: config.service.chatTurnTimeoutMs,
    chatTurnJournalEnabled: config.service.chatTurnJournalEnabled,
    // Как в `main.ts` платформы: задачи, обработчики чата и жизненный цикл идут из манифеста.
    operatorThreadId: config.agents.ownerThreadId,
    schedules: effectiveSchedules(
      pragmatikaProject.schedules,
      config as unknown as ProductionConfig<PragmatikaConfig>,
    ),
    chatHooks: chatHooksOf(pragmatikaProject),
    lifecycle: lifecycleOf(pragmatikaProject),
    workerIntervalMs: options.workerIntervalMs ?? E2E_WORKER_INTERVAL_MS,
    shutdownTimeoutMs: E2E_SHUTDOWN_MS,
    log: (event, fields) => {
      logs.push(`${event} ${JSON.stringify(fields ?? {})}`);
    },
  });
  await service.start();
  let closed = false;
  const closeApp = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await app.close().catch(() => undefined);
  };
  return {
    app,
    chat,
    service,
    logs,
    async stop() {
      const report = await service.stop();
      await closeApp();
      return report;
    },
    async crash() {
      await closeApp();
    },
    async dispose() {
      await service.stop().catch(() => undefined);
      await closeApp();
    },
  };
}

/** Тексты исходящих сообщений в треде. */
export function textsTo(chat: MemoryChatChannel, threadId: string): string[] {
  return chat.outbox
    .filter((item) => item.threadId === threadId)
    .map((item) => item.message?.text ?? '');
}

/** Ждёт, пока в треде появится сообщение, содержащее `mark`. */
export function waitForText(
  what: string,
  chat: MemoryChatChannel,
  threadId: string,
  mark: string,
): Promise<void> {
  return waitFor(what, () => textsTo(chat, threadId).some((text) => text.includes(mark)));
}

/** Сообщение сотрудника в тред чата. */
export async function sendText(
  chat: MemoryChatChannel,
  threadId: string,
  userId: string,
  text: string,
): Promise<void> {
  await chat.emit({ kind: 'message', threadId, userId, text });
}

/** Нажатие сотрудником кнопки под вопросом. */
export async function pressButton(
  chat: MemoryChatChannel,
  threadId: string,
  userId: string,
  buttonId: string,
): Promise<void> {
  await chat.emit({ kind: 'button', threadId, userId, buttonId });
}

/**
 * Первый ход родителя агента «Поиск поставщика (ИИ агент)»: вызов инструмента `tool` с позицией и
 * токеном имени
 * клиента из запроса (имя родитель видит только токеном; иначе - ошибка сценария).
 */
export function parentHandoffReply(
  raw: string,
  tool: string,
  requestId: string,
  position: string,
): StubReply {
  const person = firstToken(raw, 'PERSON');
  if (person === null) throw new Error('модель не увидела токен имени клиента');
  const positions = [`${position} для ${person}`];
  return { kind: 'tool', name: tool, input: { requestId, positions } };
}

/** Исходящие с кнопками в треде (вопрос дочернего агента): подпись -> id кнопки. */
export function lastButtons(chat: MemoryChatChannel, threadId: string): Record<string, string> {
  const withButtons = chat.outbox.filter(
    (item) => item.threadId === threadId && (item.message?.buttons?.length ?? 0) > 0,
  );
  const last = withButtons[withButtons.length - 1];
  return Object.fromEntries((last?.message?.buttons ?? []).map((b) => [b.label, b.id]));
}

/** Очистить таблицы, которые трогают сценарии передачи (знания остаются). */
export async function resetHandoffTables(db: PgClient): Promise<void> {
  await db.query(
    'TRUNCATE jobs, workflow_state, threads, audit_log, idempotency_keys, price_items, ' +
      'suppliers, purchase_requests, operation_metrics RESTART IDENTITY CASCADE',
  );
}

/** Все записи передач из состояния (в порядке ключа). */
export async function handoffRecords(db: PgClient): Promise<HandoffRecord[]> {
  const rows = await db.query(
    "SELECT value FROM workflow_state WHERE namespace = 'handoff.v1' ORDER BY key",
  );
  return rows.map((row) => handoffRecordSchema.parse(row['value']));
}

/** Состояние джоба очереди: id задач агента и их статусы. */
export async function agentRunJobs(
  db: PgClient,
): Promise<Array<{ status: string; payload: string; attempts: number; dueAt: string }>> {
  const rows = await db.query(
    "SELECT status, payload, attempts, due_at::text AS due_at FROM jobs WHERE name = 'agent.run' " +
      'ORDER BY created_at, id',
  );
  return rows.map((row) => ({
    status: String(row['status']),
    payload: String(row['payload']),
    attempts: Number(row['attempts']),
    dueAt: String(row['due_at']),
  }));
}

/** Записи аудита передачи (`agent_handoff`) или вызова агента (`agent_call`): стадия, итог. */
export async function handoffAudit(
  db: PgClient,
  action: 'agent_handoff' | 'agent_call' = 'agent_handoff',
): Promise<Array<{ stage: string; result: string; details: string }>> {
  const rows = await db.query(
    'SELECT details, result FROM audit_log WHERE action = $1 ORDER BY id',
    [action],
  );
  return rows.map((row) => {
    const details = String(row['details']);
    return {
      stage: /stage=(\w+)/.exec(details)?.[1] ?? '?',
      result: String(row['result']),
      details,
    };
  });
}

/**
 * Имитация падения процесса: захваченная задача «протухает» (захват старше таймаута
 * видимости очереди), как через 20 минут после kill -9.
 */
export async function ageRunningJobLocks(db: PgClient): Promise<number> {
  const rows = await db.query(
    `UPDATE jobs SET locked_at = locked_at - interval '${STALE_LOCK_MINUTES} minutes'
     WHERE status = 'running' RETURNING id`,
  );
  return rows.length;
}

/** Состарить срок годности открытой передачи: «срок уже прошёл» (запись в состоянии). */
export async function expireHandoffRecord(
  db: PgClient,
  field: 'expiresAt' | 'answerDeadline',
): Promise<void> {
  const past = new Date(Date.now() - PAST_HOURS * 3_600_000).toISOString();
  await db.query(
    `UPDATE workflow_state SET value = jsonb_set(value, '{${field}}', to_jsonb($1::text))
     WHERE namespace = 'handoff.v1'`,
    [past],
  );
}
