import {
  Bitrix24ChatChannel,
  FixedClock,
  MemoryCrm,
  SystemClock,
  type FetchFn,
  SystemIdGenerator,
  type PgClient,
} from '@business-ai/adapters';
import { DOCUMENTS_AGENT_ID } from '../../src/agents/documents/deps';
import { ORDER_CALC_AGENT_ID } from '../../src/agents/order-calc/deps';
import { PRICES_AGENT_ID } from '../../src/agents/prices/deps';
import { SITE_EXPORT_AGENT_ID } from '../../src/agents/site-export/deps';
import { composeProduction, type StopReport } from './project-env';
import {
  createBitrix24Integrations,
  createService,
  unwrapChat,
  withChannelLifecycle,
  type ExternalPorts,
  type ProductionApp,
  type ProductionConfig,
  type Service,
} from '@business-ai/core/compose';
import type { MailboxDirectory } from '@business-ai/core';
import {
  startBitrix24PortalStub,
  type Bitrix24PortalStub,
  type Bitrix24PortalStubOptions,
} from '@business-ai/testing';
import { BitrixEmployee } from './employee';
import { e2eConfig, e2eEnv, requireEnv } from './project-env';
import { E2E_SHUTDOWN_MS, E2E_WORKER_INTERVAL_MS } from './handoff-core';
import { XLSX_MIME } from './supplier-xlsx';

/** Корневой отдел заглушки портала и номер, с которого идут отделы руководителей. */
const ROOT_DEPARTMENT_ID = 1;
const FIRST_HEAD_DEPARTMENT_ID = 2;

/** Предел частоты заглушки портала: в тестах ограничитель реального портала не нужен. */
const PORTAL_LIMIT_PER_SECOND = 50;
/** Числовой id ответственного на портале стенда. */
const OWNER_PORTAL_USER_ID = 1;
/** Минимум интервала опроса, который допускает конфигурация, мс. */
const MIN_POLL_INTERVAL_MS = 1_000;
/** Пауза между ручными опросами, пока тест ждёт ответ, мс. */
export const MANUAL_POLL_PAUSE_MS = 250;
const DEFAULT_TIMEZONE = 'Europe/Moscow';
/** Сколько `crash()` ждёт, пока остановится служба; остальное доделывает `dispose()`, мс. */
const CRASH_STOP_WAIT_MS = 100;
/** Шаблон файла поставщиков в репозитории (относительно корня, который выставляет run.sh). */
const SUPPLIER_TEMPLATE_RELATIVE = 'docs/templates/supplier-template.xlsx';

/**
 * Бот портала: ключ в заглушке, числовой id и агент, которого он обслуживает. Без `id` бот
 * на портале не существует до старта: его создаёт служба при `autoRegister`.
 */
export interface BotSpec {
  key: string;
  id?: number;
  agent: string;
  /** Имя и описание бота для автосоздания (по умолчанию имя выводится из ключа). */
  name?: string;
  description?: string;
}

/** Четыре бота боевой раскладки (id 101..104 совпадают с умолчанием заглушки портала). */
export const DEFAULT_BOTS: readonly BotSpec[] = [
  { key: 'prices', id: 101, agent: PRICES_AGENT_ID },
  { key: 'documents', id: 102, agent: DOCUMENTS_AGENT_ID },
  { key: 'orders', id: 103, agent: ORDER_CALC_AGENT_ID },
  { key: 'site', id: 104, agent: SITE_EXPORT_AGENT_ID },
];

/** Ключи ботов по умолчанию. */
export const BOT_PRICES = 'prices';
export const BOT_DOCUMENTS = 'documents';
export const BOT_ORDERS = 'orders';
export const BOT_SITE = 'site';

/** Включаемые флагами подсистемы (переменные окружения ставит помощник). */
export interface WorldFlags {
  /** `MONITORING_ENABLED` и `BUSINESS_TIMEZONE`. */
  monitoring?: boolean;
  /** `ORDER_CALC_INTAKE_ENABLED`: приём заявки из задачи и сделки портала. */
  intake?: boolean;
  /**
   * Чтение вложений задач (`B24_ATTACHMENT_*`): настоящий читатель вложений портала подключён
   * к агенту расчёта. Без флага вложения не читаются, как в остальных сценариях.
   */
  attachments?: boolean;
  /** `SUPPLIER_CARDS_ENABLED` и путь к файлу-шаблону. */
  supplierCards?: boolean;
}

/** Порты, которые можно подставить снаружи (канал и CRM собирает сам мир). */
export type WorldExternalPorts = Omit<
  ExternalPorts,
  'chat' | 'crm' | 'mailboxes' | 'directory' | 'tasks' | 'portalLinks' | 'dealSearch' | 'staff'
>;

/** Параметры запуска мира. */
export interface BitrixWorldOptions {
  /** Путь к файлу правил доступа (`writeBitrixRules`). */
  rules: string;
  /** Переопределения переменных окружения (после флагов). */
  env?: Record<string, string>;
  flags?: WorldFlags;
  mailboxes?: MailboxDirectory;
  /**
   * Часы службы и зависимостей агентов. Боевая сборка берёт `SystemClock` внутри, поэтому
   * зависимости агентов подменяются копиями; сервис черновиков писем остаётся на реальном
   * времени (стартуйте `FixedClock` с реального «сейчас», если нужна цепочка до письма).
   */
  clock?: FixedClock;
  bots?: readonly BotSpec[];
  /**
   * `BITRIX24_BOT_AUTOREGISTER=true`: служба сама находит или регистрирует ботов при старте.
   * Боты без `id` на портале отсутствуют до старта; с `id` - уже существуют (портал
   * стартует с ними). Без флага у каждого бота обязан быть `id` (прежнее поведение).
   */
  autoRegister?: boolean;
  /**
   * Готовая заглушка портала: нужна, чтобы поднять второй экземпляр службы на том же
   * портале (рестарт). Такой портал мир при `dispose` не останавливает.
   */
  portal?: Bitrix24PortalStub;
  portalOptions?: Bitrix24PortalStubOptions;
  /**
   * Руководители отделов портала (`UF_HEAD`, этап 234): id сотрудников. Права «только
   * руководителям» (подтверждение записи карточек поставщиков, выгрузка) читают их из
   * `department.get`; без руководителей на портале такие действия закрыты всем, как в бою.
   * Мир заводит корневой отдел и по одному дочернему отделу на каждого руководителя. Работает
   * только с собственным порталом мира (для чужого заполните отделы сами через `addDepartment`).
   */
  departmentHeads?: readonly number[];
  external?: WorldExternalPorts;
  /** Подмена клиента БД (сбои записи); по умолчанию сборка создаёт свой. */
  db?: PgClient;
  /** Общий журнал (рестарт: оба экземпляра пишут в один массив). */
  logs?: string[];
  workerIntervalMs?: number;
  /**
   * Фоновый опрос портала (жизненный цикл службы). По умолчанию опрос ручной: детерминизм
   * обеспечивают `pollOnce()` и ожидания сотрудника.
   */
  background?: boolean;
  /**
   * Вызывается после сборки и до запуска службы: обработчик, подписанный здесь, стоит в
   * цепочке канала РАНЬШЕ насоса (ловушка «событие не принято»: насос его не увидит).
   */
  beforeStart?: (channel: Bitrix24ChatChannel) => void;
  /**
   * Портал отдаёт файл без имени: `Content-Disposition` не подставляется, а тип содержимого
   * выводится из расширения присланного имени (xlsx -> тип xlsx вместо `octet-stream`).
   * Так сквозным сценарием исполняется ветка адаптера «имя не пришло, расширение по MIME».
   */
  anonymousDownloads?: boolean;
}

/** Правило одного агента для файла правил. */
export interface BotRule {
  users?: readonly string[];
  departments?: readonly string[];
  workgroups?: readonly string[];
  /** Права на отдельные действия (например `suppliers.confirm_card`). */
  actions?: Readonly<
    Record<string, { users?: readonly string[]; departments?: readonly string[] }>
  >;
}

/** Записать файл правил доступа (`ACCESS_POLICY_FILE`): агент -> кому разрешён. */
export async function writeBitrixRules(
  name: string,
  rules: Readonly<Record<string, BotRule>>,
): Promise<string> {
  const toAllow = (rule: {
    users?: readonly string[] | undefined;
    departments?: readonly string[] | undefined;
    workgroups?: readonly string[] | undefined;
  }): Record<string, string[]> => ({
    ...(rule.users === undefined ? {} : { users: [...rule.users] }),
    ...(rule.departments === undefined ? {} : { departments: [...rule.departments] }),
    ...(rule.workgroups === undefined ? {} : { workgroups: [...rule.workgroups] }),
  });
  const bots = Object.fromEntries(
    Object.entries(rules).map(([agent, rule]) => {
      const actions =
        rule.actions === undefined
          ? {}
          : {
              actions: Object.fromEntries(
                Object.entries(rule.actions).map(([action, who]) => [
                  action,
                  { allow: toAllow(who) },
                ]),
              ),
            };
      return [agent, { allow: toAllow(rule), ...actions }];
    }),
  );
  const path = `${e2eEnv().work}/out/access-bitrix-${name}.json`;
  await Bun.write(path, JSON.stringify({ version: 1, bots }));
  return path;
}

/** Переменные окружения сборки: заглушка портала, боты, флаги. */
function worldEnv(
  portal: Bitrix24PortalStub,
  bots: readonly BotSpec[],
  options: BitrixWorldOptions,
): Record<string, string> {
  const flags = options.flags ?? {};
  const auto = options.autoRegister === true;
  const botTable = Object.fromEntries(
    bots.map((bot) => [
      bot.key,
      {
        agent: bot.agent,
        ...(bot.id === undefined ? {} : { id: bot.id }),
        // Имя нужно только боту, которого ещё нет на портале.
        ...(auto ? { name: bot.name ?? `Бот ${bot.key}` } : {}),
        ...(auto && bot.description !== undefined ? { description: bot.description } : {}),
      },
    ]),
  );
  return {
    BITRIX24_WEBHOOK_URL: portal.url,
    BITRIX24_BOT_TOKEN: portal.botToken,
    BITRIX24_BOTS: JSON.stringify(botTable),
    ...(auto ? { BITRIX24_BOT_AUTOREGISTER: 'true' } : {}),
    BITRIX24_POLL_INTERVAL_MS: String(MIN_POLL_INTERVAL_MS),
    // Платформа проверяет формат треда ответственного при Bitrix24: `<ключ бота>/<id сотрудника>`.
    OWNER_THREAD_ID: `${bots[0]?.key ?? 'alpha'}/${OWNER_PORTAL_USER_ID}`,
    ACCESS_POLICY_FILE: options.rules,
    ...(flags.monitoring === true
      ? { MONITORING_ENABLED: 'true', BUSINESS_TIMEZONE: DEFAULT_TIMEZONE }
      : {}),
    ...(flags.intake === true ? { ORDER_CALC_INTAKE_ENABLED: 'true' } : {}),
    ...(flags.supplierCards === true
      ? {
          SUPPLIER_CARDS_ENABLED: 'true',
          SUPPLIER_TEMPLATE_PATH: `${requireEnv('E2E_PROJECT_ROOT')}/${SUPPLIER_TEMPLATE_RELATIVE}`,
        }
      : {}),
    ...(options.mailboxes === undefined ? {} : { EMPLOYEE_MAILBOX_ENABLED: 'true' }),
    ...(options.env ?? {}),
  };
}

/** Копия зависимостей агентов с подставленными часами (только там, где есть поле `clock`). */
function withClock(
  deps: Readonly<Record<string, unknown>>,
  clock: FixedClock,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(deps).map(([agent, value]) => {
      const hasClock = typeof value === 'object' && value !== null && 'clock' in value;
      return [agent, hasClock ? { ...(value as object), clock } : value];
    }),
  );
}

/** Метод REST, которым адаптер запрашивает ссылку на файл сотрудника. */
const FILE_DOWNLOAD_METHOD = 'imbot.v2.File.download';
/** Типы содержимого, которые в режиме анонимной выдачи заглушка «сообщает» вместо octet-stream. */
const MIME_BY_EXTENSION: ReadonlyMap<string, string> = new Map([['.xlsx', XLSX_MIME]]);

/**
 * Сеть мира: обёртка над `fetch` для адаптера Bitrix24.
 *
 * Заглушка портала отдаёт файл без имени (в событии только id файла, а `Content-Disposition`
 * она не ставит), и адаптер назвал бы файл `file-<id>` без расширения. Живой портал имя
 * отдаёт в заголовке скачивания; обёртка запоминает, какому файлу выдана ссылка, и добавляет
 * к ответу скачивания `Content-Disposition` с именем из `names`. В режиме `anonymous` имя не
 * подставляется, вместо этого выставляется тип содержимого по расширению имени.
 *
 * После `sever()` сеть «умерла» вместе с процессом: все запросы отклоняются, а журнал
 * молчит (мёртвый процесс не пишет). Так упавший экземпляр не может ни ответить сотруднику,
 * ни оставить следов, даже если его ход агента ещё висит на ответе модели.
 */
class WorldNetwork {
  readonly names = new Map<number, string>();
  /** Сколько запросов отклонено после смерти процесса (проверка «упавший ничего не шлёт»). */
  refused = 0;
  private severedFlag = false;
  private readonly nameByUrl = new Map<string, string>();

  constructor(private readonly anonymous: boolean) {}

  get severed(): boolean {
    return this.severedFlag;
  }

  sever(): void {
    this.severedFlag = true;
  }

  readonly fetchFn: FetchFn = async (input, init) => {
    if (this.severedFlag) {
      this.refused += 1;
      throw new TypeError('fetch failed: процесс остановлен');
    }
    const response = await fetch(input, init);
    if (init.method === 'POST' && input.includes(FILE_DOWNLOAD_METHOD)) {
      await this.rememberDownloadUrl(init, response);
      return response;
    }
    const isGet = init.method === 'GET' || init.method === undefined;
    const name = isGet ? this.nameByUrl.get(input) : undefined;
    if (name === undefined || !response.ok) return response;
    const headers = new Headers(response.headers);
    if (this.anonymous) {
      const mime = MIME_BY_EXTENSION.get(name.slice(name.lastIndexOf('.')).toLowerCase());
      if (mime !== undefined) headers.set('Content-Type', mime);
    } else {
      headers.set(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      );
    }
    return new Response(response.body, { status: response.status, headers });
  };

  /** Запомнить, какому файлу портал выдал ссылку скачивания. */
  private async rememberDownloadUrl(init: RequestInit, response: Response): Promise<void> {
    try {
      const request: unknown = JSON.parse(String(init.body));
      const payload: unknown = await response.clone().json();
      const fileId = (request as { fileId?: unknown }).fileId;
      const url = (payload as { result?: { downloadUrl?: unknown } }).result?.downloadUrl;
      const name = typeof fileId === 'number' ? this.names.get(fileId) : undefined;
      if (typeof url === 'string' && name !== undefined) this.nameByUrl.set(url, name);
    } catch {
      // Не тот формат: имя не подставляем, адаптер получит файл как есть.
    }
  }
}

/** Запущенный экземпляр: настоящий канал Bitrix24 + служба + боевая сборка на заглушке портала. */
export class BitrixWorld {
  readonly portal: Bitrix24PortalStub;
  readonly app: ProductionApp;
  readonly config: ProductionConfig;
  readonly service: Service;
  /** Служба с опросом канала (жизненный цикл `withChannelLifecycle`). */
  readonly lifecycle: Service;
  readonly channel: Bitrix24ChatChannel;
  /** Журнал службы и адаптера: строки `событие {json полей}`. */
  readonly logs: string[];
  readonly clock: FixedClock | undefined;
  readonly mailboxes: MailboxDirectory | undefined;
  readonly bots: readonly BotSpec[];
  readonly background: boolean;
  private readonly ownsPortal: boolean;
  private readonly network: WorldNetwork;
  private readonly employees = new Map<number, BitrixEmployee>();
  private polling: Promise<unknown> = Promise.resolve();
  private closed = false;
  private disposed = false;

  constructor(parts: {
    portal: Bitrix24PortalStub;
    app: ProductionApp;
    config: ProductionConfig;
    service: Service;
    lifecycle: Service;
    channel: Bitrix24ChatChannel;
    logs: string[];
    clock: FixedClock | undefined;
    mailboxes: MailboxDirectory | undefined;
    bots: readonly BotSpec[];
    background: boolean;
    ownsPortal: boolean;
    network: WorldNetwork;
  }) {
    this.portal = parts.portal;
    this.app = parts.app;
    this.config = parts.config;
    this.service = parts.service;
    this.lifecycle = parts.lifecycle;
    this.channel = parts.channel;
    this.logs = parts.logs;
    this.clock = parts.clock;
    this.mailboxes = parts.mailboxes;
    this.bots = parts.bots;
    this.background = parts.background;
    this.ownsPortal = parts.ownsPortal;
    this.network = parts.network;
  }

  /** Запомнить имя присланного файла (для `Content-Disposition` при скачивании). */
  rememberFile(fileId: number, name: string): void {
    this.network.names.set(fileId, name);
  }

  /** Сотрудник портала с числовым id (один объект на id). */
  employee(userId: number): BitrixEmployee {
    let found = this.employees.get(userId);
    if (found === undefined) {
      found = new BitrixEmployee(userId, this);
      this.employees.set(userId, found);
    }
    return found;
  }

  /** Один цикл опроса всех ботов; вызовы не пересекаются (идут по цепочке). */
  pollOnce(): Promise<unknown> {
    // Остановленный или «упавший» экземпляр события больше не забирает у портала.
    if (this.closed) return Promise.resolve(undefined);
    const run = this.polling.then(() => this.channel.pollOnce());
    this.polling = run.catch(() => undefined);
    return run;
  }

  /** Опрашивать `ms` миллисекунд (проверка «ничего не должно произойти» и дожидание хвостов). */
  async idle(ms: number): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (!this.background) await this.pollOnce();
      await Bun.sleep(MANUAL_POLL_PAUSE_MS);
    }
  }

  /** События всех ботов подтверждены offset (очередь портала пуста). */
  queuesEmpty(): boolean {
    return this.bots.every((bot) => this.portal.pendingEvents(bot.key) === 0);
  }

  /** Сколько раз служба записала в журнал событие с таким именем. */
  logCount(event: string): number {
    return this.logs.filter((line) => line === event || line.startsWith(`${event} `)).length;
  }

  /** Ответ `/ready` службы: код и тело (для проверки автосоздания ботов). */
  async ready(): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`http://127.0.0.1:${this.service.healthPort()}/ready`);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  /** Штатная остановка (опрос -> служба): незавершённые ходы возвращаются в очередь. */
  async stop(): Promise<StopReport> {
    const report = await this.lifecycle.stop();
    await this.closeApp();
    return report;
  }

  /** Сколько исходящих запросов к порталу отклонено уже после `crash()`. */
  get refusedAfterCrash(): number {
    return this.network.refused;
  }

  /**
   * Имитация внезапной смерти процесса: штатной остановки (дренаж ходов, возврат задач,
   * ответы «перезапускается», записи `interrupted` в аудит) нет.
   *
   * Порядок: сеть «умирает» (ни одного запроса к порталу, журнал молчит) -> опрос канала
   * прекращается -> соединения с БД закрываются -> служба останавливается, чтобы не крутились
   * таймер воркера и насос, но без ожидания: ядро не принимает таймаут в `stop()`, а
   * `E2E_SHUTDOWN_MS` задан при сборке. Ответ `CHAT_STOPPING_TEXT` и аудит `interrupted`
   * после этого уйти не могут: сеть и пул уже закрыты.
   *
   * Ограничение: уже идущий ход агента (например, ожидание ответа модели) отменить нельзя,
   * ядро не даёт ручки отмены без штатного дренажа. Он доживает до ответа модели, но его
   * отправки отклоняются, записи в БД не проходят, в журнал ничего не попадает.
   */
  async crash(): Promise<void> {
    this.network.sever();
    await this.channel.stop().catch(() => undefined);
    await this.closeApp();
    const stopping = this.service.stop().catch(() => undefined);
    await Promise.race([stopping, Bun.sleep(CRASH_STOP_WAIT_MS)]);
  }

  /** Убрать хвосты после теста (все ошибки гасятся); портал чужого владельца не трогаем. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.lifecycle.stop().catch(() => undefined);
    await this.closeApp();
    if (this.ownsPortal) await this.portal.stop().catch(() => undefined);
  }

  private async closeApp(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.app.close().catch(() => undefined);
  }
}

/** Завести на портале корневой отдел и по отделу на каждого руководителя (`UF_HEAD`). */
function seedDepartmentHeads(portal: Bitrix24PortalStub, heads: readonly number[]): void {
  if (heads.length === 0) return;
  portal.addDepartment({ id: ROOT_DEPARTMENT_ID, name: 'Компания' });
  heads.forEach((head, index) => {
    portal.addDepartment({
      id: FIRST_HEAD_DEPARTMENT_ID + index,
      name: `Отдел ${index + 1}`,
      parent: ROOT_DEPARTMENT_ID,
      head,
    });
  });
}

/**
 * Поднять боевую сборку на заглушке портала Bitrix24 (повторяет `core/src/main.ts`):
 * `createBitrix24Integrations` -> `composeProduction` -> `createService` ->
 * `withChannelLifecycle`. Служба запущена; опрос ручной (`background: false`).
 */
export async function startBitrixWorld(options: BitrixWorldOptions): Promise<BitrixWorld> {
  const bots = options.bots ?? DEFAULT_BOTS;
  if (options.autoRegister !== true && bots.some((bot) => bot.id === undefined)) {
    throw new Error('у бота без autoRegister должен быть числовой id');
  }
  const ownsPortal = options.portal === undefined;
  // На портале заранее есть только боты с id; остальных создаёт служба.
  const portal =
    options.portal ??
    (await startBitrix24PortalStub({
      limitPerSecond: PORTAL_LIMIT_PER_SECOND,
      bots: Object.fromEntries(
        bots.flatMap((bot) => (bot.id === undefined ? [] : [[bot.key, bot.id] as const])),
      ),
      ...(options.portalOptions ?? {}),
    }));
  if (ownsPortal) {
    seedDepartmentHeads(portal, options.departmentHeads ?? []);
  } else if (options.departmentHeads !== undefined) {
    throw new Error('departmentHeads работает только с собственным порталом мира');
  }
  const logs = options.logs ?? [];
  const network = new WorldNetwork(options.anonymousDownloads === true);
  const log = (event: string, fields?: Record<string, string | number | boolean>): void => {
    // Мёртвый процесс журнал не пишет: после `crash()` общий массив не растёт.
    if (network.severed) return;
    logs.push(`${event} ${JSON.stringify(fields ?? {})}`);
  };
  const config = e2eConfig(worldEnv(portal, bots, options));
  if (config.bitrix24 === undefined) throw new Error('конфигурация без Bitrix24');
  const integrations = createBitrix24Integrations(config.bitrix24, {
    rules: config.access?.rules,
    log,
    // Реальные часы: ограничитель 2 запроса/с замедлил бы тесты в разы.
    overrides: { minRequestIntervalMs: 0, fetchFn: network.fetchFn },
  });
  const app = composeProduction(
    config,
    {
      chat: integrations.chat,
      // CRM платформы: заметки и поиск сделок; разбор заявки по сделке не перенесён (пробел).
      crm: new MemoryCrm(new Map()),
      directory: integrations.directory,
      // Как в `main.ts` платформы: сотрудников и руководителей читает тот же каталог портала.
      staff: integrations.directory,
      heads: integrations.directory,
      tasks: integrations.tasks,
      dealSearch: integrations.deals,
      ...(integrations.links === undefined ? {} : { portalLinks: integrations.links }),
      ...(options.flags?.attachments === true ? { attachments: integrations.attachments } : {}),
      ...(options.mailboxes === undefined ? {} : { mailboxes: options.mailboxes }),
      ...(options.external ?? {}),
    },
    options.db === undefined ? {} : { db: options.db },
  );
  const baseChat = unwrapChat(app.chat);
  if (!(baseChat instanceof Bitrix24ChatChannel)) {
    throw new Error('сборка вернула не канал Bitrix24');
  }
  const channel = baseChat;
  const clock = options.clock;
  const serviceApp =
    clock === undefined ? app : { ...app, agentDeps: withClock(app.agentDeps, clock) };
  const service = createService({
    app: serviceApp,
    chat: app.chat,
    access: app.access,
    clock: clock ?? new SystemClock(),
    ids: new SystemIdGenerator(),
    healthPort: 0,
    chatAgentId: config.service.chatAgentId,
    chatBots: config.service.chatBots,
    chatGreetingEnabled: config.service.chatGreetingEnabled,
    chatTurnTimeoutMs: config.service.chatTurnTimeoutMs,
    chatTurnJournalEnabled: config.service.chatTurnJournalEnabled,
    workerIntervalMs: options.workerIntervalMs ?? E2E_WORKER_INTERVAL_MS,
    shutdownTimeoutMs: E2E_SHUTDOWN_MS,
    botsStatus: () => channel.botStatus(),
    log,
  });
  const lifecycle = withChannelLifecycle(service, channel);
  options.beforeStart?.(channel);
  const background = options.background === true;
  // Ручной опрос: служба стартует без опроса канала, насос уже подписан на события. Боты
  // определяются до службы в обоих режимах (как в `withChannelLifecycle`).
  if (background) {
    await lifecycle.start();
  } else {
    await channel.ensureBots();
    await service.start();
  }
  return new BitrixWorld({
    portal,
    app,
    config,
    service,
    lifecycle,
    channel,
    logs,
    clock,
    mailboxes: options.mailboxes,
    bots,
    background,
    ownsPortal,
    network,
  });
}
