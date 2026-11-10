import { CancelledError } from '@business-ai/core';
import type { ToolContext } from '@business-ai/core';
import { assertEmployeeChatTurn } from '@business-ai/core';
import type { SiteExportDeps } from './deps';

/**
 * Имя сотрудника для поля «менеджер» шаблона. Идентификатор берётся из контекста хода
 * (`initiator.userId`, его выставляет канал чата), имя - из каталога сотрудников. Текст
 * сообщения не участвует: «я Пётр Иванов» ничего не меняет.
 */

/** Почему имя не определено. */
export type EmployeeIdentityGap =
  /** Каталог сотрудников не подключён. */
  | 'not_configured'
  /** В каталоге нет такого сотрудника или у него не заполнено имя либо фамилия. */
  | 'not_in_directory'
  /** Каталог не ответил: имя не определено, ход не падает. */
  | 'directory_unavailable';

/** Результат: «Имя Фамилия» либо явное `unknown` (агент спросит сотрудника). */
export type EmployeeIdentityResult =
  | { status: 'known'; fullName: string; firstName: string; lastName: string }
  | { status: 'unknown'; reason: EmployeeIdentityGap };

/**
 * Определить сотрудника, ведущего ход. Ход должен вести сотрудник в чате (иначе
 * access_denied, как у остальных записей по решению сотрудника). Сбой каталога не бросается:
 * результат `unknown`, чтобы агент спросил имя, а не оборвал работу над файлом.
 */
export async function resolveEmployeeIdentity(
  deps: Pick<SiteExportDeps, 'employeeIdentity'>,
  context: Pick<ToolContext, 'threadId' | 'initiator' | 'depth' | 'mode'>,
): Promise<EmployeeIdentityResult> {
  const userId = assertEmployeeChatTurn(context);
  if (deps.employeeIdentity === undefined) return { status: 'unknown', reason: 'not_configured' };
  try {
    const name = await deps.employeeIdentity.nameOf(userId);
    if (name === null) return { status: 'unknown', reason: 'not_in_directory' };
    return {
      status: 'known',
      fullName: `${name.firstName} ${name.lastName}`,
      firstName: name.firstName,
      lastName: name.lastName,
    };
  } catch (error) {
    if (error instanceof CancelledError) throw error;
    return { status: 'unknown', reason: 'directory_unavailable' };
  }
}
