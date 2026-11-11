import {
  employeeOfThread,
  parseBindingThread,
  type ChatChannel,
  type ChatEvent,
  type ChatEventHandler,
  type WorkflowStateStore,
} from '@business-ai/core';
import type { ChatChannelPorts } from '@business-ai/core/compose';
import { DOCUMENTS_AGENT_ID } from './agents/documents/deps';
import { noteEmployeeMessage } from './agents/documents/employee-messages';
import { setChatLauncher } from './chat-launch';

/**
 * Мост между каналом чата и проектом. Насос чата платформы не даёт проекту ни текста входящего
 * сообщения (хук `chat.stateBlock` получает только тред и агента), ни способа запустить ход
 * агента после кнопки. Оба пробела закрывает подписка на сам канал: проект ставит перед насосом
 * свой слой в `onEvent` канала (метод на экземпляре; класс канала и проверки `instanceof`
 * платформы не меняются).
 *
 * 1. Текст сообщения сотрудника агенту «Подготовка документов» запоминается до запуска хода
 *    (`noteEmployeeMessage`): по нему код проверяет, что реквизит в документе прислал сам
 *    сотрудник. Как в прежнем насосе: реальный текст до псевдонимизации, сбой записи ход не
 *    ломает (в журнал - только код).
 * 2. Обработчики насоса запоминаются, чтобы проект мог подать насосу событие (`chat-launch.ts`).
 */

/** Таблица агентов чата: те же значения, что получает служба (`config.service`). */
export interface AgentTable {
  /** Агент по умолчанию (`CHAT_AGENT_ID` либо агент манифеста). */
  chatAgentId: string | undefined;
  /** Таблица «бот -> агент» (`CHAT_BOTS`); нет или пуста - режим одного бота. */
  chatBots?: Readonly<Record<string, string>> | undefined;
}

/** Журнал службы: только коды и идентификаторы, без текстов. */
export type IntakeLog = (event: string, fields: Record<string, string | number>) => void;

/** Что нужно перехвату: хранилище состояния сценариев, таблица агентов и журнал. */
export interface ChatIntakeDeps {
  state: WorkflowStateStore;
  agents: AgentTable;
  log?: IntakeLog | undefined;
}

/** Событие журнала при сбое записи текста сотрудника (как в прежнем насосе). */
export const EMPLOYEE_TEXT_FAILED_EVENT = 'chat_employee_text_failed';

/** Журнал по умолчанию: строка JSON на событие, как у остальных портов проекта. */
const consoleLog: IntakeLog = (event, fields) => {
  console.log(JSON.stringify({ event, ...fields }));
};

/**
 * Агент, которому насос отдаст событие; `undefined` - насос его отклонит (неизвестный бот, тред
 * чужой связки или чужого сотрудника). Повторяет `ChatPump.resolveBot`, чтобы перехват видел
 * только то, что насос принял бы.
 */
export function resolveEventAgent(event: ChatEvent, table: AgentTable): string | undefined {
  const bots = table.chatBots;
  const botIds = bots === undefined ? [] : Object.keys(bots);
  // Режим одного бота: `botId` события не учитывается.
  if (bots === undefined || botIds.length === 0) return table.chatAgentId;
  const selected =
    event.botId === undefined
      ? table.chatAgentId
      : Object.hasOwn(bots, event.botId)
        ? bots[event.botId]
        : undefined;
  if (selected === undefined) return undefined;
  const binding = parseBindingThread(event.threadId);
  if (binding !== null && binding.botId !== event.botId) return undefined;
  // Тред связки принадлежит сотруднику; пустой userId (служебное событие) не сравнивается.
  const threadEmployee = employeeOfThread(event.threadId);
  if (threadEmployee !== null && event.userId !== '' && threadEmployee !== event.userId) {
    return undefined;
  }
  // Несколько ботов, а тред не связка: насос такой тред не принимает.
  if (binding === null && event.botId !== undefined && botIds.length > 1) return undefined;
  return selected;
}

/** Код причины сбоя для журнала: имя ошибки, без текста (в тексте могут быть данные). */
function codeOf(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

/**
 * Перехват входящего события: сообщение сотрудника агенту документов запоминается в состоянии
 * треда. Не бросает: ход агента важнее записи.
 */
export async function interceptEmployeeMessage(
  event: ChatEvent,
  deps: ChatIntakeDeps,
): Promise<void> {
  if (event.kind !== 'message' || event.userId === '') return;
  if (resolveEventAgent(event, deps.agents) !== DOCUMENTS_AGENT_ID) return;
  try {
    await noteEmployeeMessage(deps.state, event.threadId, event.text);
  } catch (error) {
    (deps.log ?? consoleLog)(EMPLOYEE_TEXT_FAILED_EVENT, { code: codeOf(error) });
  }
}

/** Каналы, на которых мост уже стоит (повторная установка ничего не удваивает). */
const bridged = new WeakSet<object>();

/**
 * Поставить мост на канал: каждое событие сначала проходит перехват, затем получает насос.
 * Отказ насоса принять событие (`ChatEventNotAcceptedError`) доходит до канала как есть, чтобы
 * тот выдал событие повторно. Возвращает тот же экземпляр канала.
 */
export function wrapChatChannel<C extends Pick<ChatChannel, 'onEvent'>>(
  channel: C,
  deps: ChatIntakeDeps,
): C {
  if (bridged.has(channel)) return channel;
  bridged.add(channel);
  const original = channel.onEvent.bind(channel);
  const pumpHandlers: ChatEventHandler[] = [];
  // Событие для запуска хода идёт мимо перехвата: это системный запрос, не текст сотрудника.
  const toPump: ChatEventHandler = async (event) => {
    for (const handler of pumpHandlers) await handler(event);
  };
  (channel as Pick<ChatChannel, 'onEvent'>).onEvent = (handler) => {
    pumpHandlers.push(handler);
    setChatLauncher(toPump);
    original(async (event) => {
      await interceptEmployeeMessage(event, deps);
      await handler(event);
    });
  };
  return channel;
}

/** Что нужно установке моста в интеграциях портала: таблица агентов и журнал. */
export interface ChatBridgeOptions {
  agents: AgentTable;
  log?: IntakeLog | undefined;
}

/** Помечает интеграции, в которых фабрика канала уже подменена. */
const installed = new WeakSet<object>();

/**
 * Подменить фабрику канала чата в интеграциях портала (`ports(env)` манифеста, до сборки).
 * Фабрика платформы вызывается как раньше, затем на созданный канал ставится мост с хранилищем
 * состояния из портов сборки (`ChatChannelPorts.state`).
 */
export function installChatBridge<C extends ChatChannel>(
  portal: { chat: (ports: ChatChannelPorts) => C },
  options: ChatBridgeOptions,
): void {
  if (installed.has(portal)) return;
  installed.add(portal);
  const factory = portal.chat;
  portal.chat = (ports) =>
    wrapChatChannel(factory(ports), {
      state: ports.state,
      agents: options.agents,
      log: options.log,
    });
}

/** Часть окружения `ports(env)` манифеста, нужная мосту: портал и таблица агентов чата. */
export interface ChatBridgePortsEnv {
  /** Интеграции Bitrix24; `undefined` - портал не настроен (чат-заглушка), моста нет. */
  portal: { chat: (ports: ChatChannelPorts) => ChatChannel } | undefined;
  config: {
    service: {
      chatAgentId: string | undefined;
      chatBots?: Readonly<Record<string, string>> | undefined;
    };
  };
}

/**
 * Установка моста из `ports(env)`: агенты чата берутся из той же конфигурации службы, по
 * которой платформа строит таблицу ботов насоса (`CHAT_AGENT_ID`, `CHAT_BOTS`). Без портала
 * ничего не делает.
 */
export function bridgeChatFromPorts(env: ChatBridgePortsEnv): void {
  if (env.portal === undefined) return;
  const { chatAgentId, chatBots } = env.config.service;
  installChatBridge(env.portal, { agents: { chatAgentId, chatBots } });
}
