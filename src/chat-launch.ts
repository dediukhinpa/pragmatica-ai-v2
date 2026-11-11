import type { ChatEvent, ChatEventHandler } from '@business-ai/core';

/**
 * Запуск хода агента из кода проекта (кнопки «Готово» и «заменить КП»). В прежнем насосе
 * обработчик кнопки сам вызывал `answer(...)` с подготовленным текстом; насос платформы после
 * проектной кнопки агента не запускает. Единственный публичный путь, который не требует правки
 * платформы, - подать насосу событие так, как это делает канал: сообщение сотрудника с этим
 * текстом в том же треде. Насос принимает его обычным порядком (доступ бота, очередь треда,
 * возобновление приостановленного треда, ответ в чат). Подключает насос мост канала
 * (`wrapChatChannel` в `chat-intake.ts`).
 */

/** Окно, в котором повторное нажатие той же кнопки не запускает ход второй раз, мс. */
export const LAUNCH_DEDUPE_WINDOW_MS = 30_000;

/** Что получилось: ход поставлен, повтор в окне, моста нет или насос событие не принял. */
export type LaunchOutcome = 'launched' | 'duplicate' | 'unavailable' | 'not_accepted';

/** Запрос на запуск хода: кому, в какой тред, с каким текстом. */
export interface LaunchRequest {
  threadId: string;
  userId: string;
  botId: string | undefined;
  /** Что агент получит на вход (в истории треда это реплика сотрудника). */
  text: string;
  /** Ключ нажатия: одно и то же нажатие в окне запускает ход один раз. */
  dedupeKey: string;
}

/** Куда подаётся событие: обработчики насоса, зарегистрированные на канале. */
let dispatchToPump: ChatEventHandler | undefined;
/** Недавние запуски: ключ нажатия -> время запуска, мс. */
const recent = new Map<string, number>();

/** Подключить насос (вызывает мост канала при подписке насоса на события). */
export function setChatLauncher(dispatch: ChatEventHandler): void {
  dispatchToPump = dispatch;
}

/** Отключить мост и забыть недавние запуски (тесты: процесс общий на все файлы). */
export function clearChatLauncher(): void {
  dispatchToPump = undefined;
  recent.clear();
}

/** Убрать запуски старше окна, чтобы таблица не росла. */
function forgetExpired(nowMs: number): void {
  for (const [key, at] of recent) {
    if (nowMs - at >= LAUNCH_DEDUPE_WINDOW_MS) recent.delete(key);
  }
}

/**
 * Запустить ход агента. `unavailable` - мост не установлен (нет канала Bitrix24 или проект
 * собран без `installChatBridge`): вызывающий отвечает сотруднику прежним текстом. Событие без
 * `sourceKey`: у такой записи нет ключа повтора, поэтому защиту от двойного нажатия держит
 * `dedupeKey`.
 */
export async function launchAgentTurn(
  request: LaunchRequest,
  nowMs: number,
): Promise<LaunchOutcome> {
  const dispatch = dispatchToPump;
  if (dispatch === undefined) return 'unavailable';
  forgetExpired(nowMs);
  if (recent.has(request.dedupeKey)) return 'duplicate';
  recent.set(request.dedupeKey, nowMs);
  const event: ChatEvent = {
    kind: 'message',
    threadId: request.threadId,
    userId: request.userId,
    ...(request.botId === undefined ? {} : { botId: request.botId }),
    text: request.text,
  };
  try {
    await dispatch(event);
    return 'launched';
  } catch {
    // Насос событие не принял (очередь полна, служба останавливается, журнал недоступен) или
    // упал: ход не начат, нажатие не засчитано, повтор разрешён. За «запущено» это не прячем:
    // вызывающий скажет сотруднику, что делать.
    recent.delete(request.dedupeKey);
    return 'not_accepted';
  }
}
