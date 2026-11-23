import { bindingThreadId, isValidBotId } from '@business-ai/core';
import { listEmployees } from '@business-ai/core';
import { PRICES_AGENT_ID, type PricesDeps } from './deps';

/**
 * Действие политики доступа, по которому сотрудник допущен к диалогу с агентом «Актуализация прайса
 * (ИИ агент)».
 */
const CHAT_ACCESS_ACTION = 'chat.message';

/** Вердикт доступа сотрудника к агенту. */
export type EmployeeAccessVerdict = 'allowed' | 'denied' | 'unavailable';

/**
 * Решение политики для сотрудника. Нет политики - допущен (прежнее поведение). Сбой каталога
 * (`directory_unavailable`) или самой политики закрывает уведомление, но не считается отказом:
 * слот остаётся открытым, и следующий тик проверит снова.
 */
export async function employeeAccessVerdict(
  deps: PricesDeps,
  userId: string,
): Promise<EmployeeAccessVerdict> {
  const { access } = deps;
  if (access === undefined) return 'allowed';
  const request = { userId, botId: PRICES_AGENT_ID, action: CHAT_ACCESS_ACTION };
  try {
    if (access.decide === undefined) {
      return (await access.isAllowed(request)) ? 'allowed' : 'denied';
    }
    const decision = await access.decide(request);
    if (decision.allowed) return 'allowed';
    return decision.reason === 'directory_unavailable' ? 'unavailable' : 'denied';
  } catch {
    return 'unavailable';
  }
}

/**
 * Личные треды сотрудников агента из реестра обращений: сотрудник -> его самый свежий тред.
 * Реестр хранит только идентификаторы. Без `state` реестра нет - пустая карта.
 */
export async function latestEmployeeThreads(deps: PricesDeps): Promise<Map<string, string>> {
  const threads = new Map<string, { threadId: string; lastSeenAt: string }>();
  if (deps.state === undefined) return new Map();
  for (const contact of await listEmployees(deps.state, PRICES_AGENT_ID)) {
    const known = threads.get(contact.userId);
    // Один сотрудник в нескольких тредах: адресат - самый свежий.
    if (known === undefined || known.lastSeenAt < contact.lastSeenAt) {
      threads.set(contact.userId, { threadId: contact.threadId, lastSeenAt: contact.lastSeenAt });
    }
  }
  return new Map([...threads].map(([userId, { threadId }]) => [userId, threadId]));
}

/**
 * Тред связки `<бот>/<id Bitrix24>` для сотрудника, который боту ещё не писал (этап 217): бот
 * может написать пользователю по его id. Строится только при включённом
 * `recipientOpenThread`, заданном корректном ключе бота и подключённой политике доступа; иначе
 * null (прежнее поведение).
 */
export function openedEmployeeThread(deps: PricesDeps, userId: string): string | null {
  if (deps.recipientOpenThread !== true) return null;
  // Без политики доступа `employeeAccessVerdict` допускает всех (прежнее поведение для реестра
  // обращений), а бот, пишущий первым кому угодно, недопустим: нет политики - нет построенного
  // треда.
  if (deps.access === undefined) return null;
  if (deps.botId === undefined || !isValidBotId(deps.botId) || userId === '') return null;
  return bindingThreadId({ botId: deps.botId, userId });
}
