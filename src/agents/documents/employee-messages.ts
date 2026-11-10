import { z } from 'zod';
import { appendEmployeeText } from '../../kit/domain/employee-text';
import type { WorkflowStateStore } from '@business-ai/core';
import { readState, writeState } from '@business-ai/core';

/**
 * Текст сообщений сотрудника по треду агента «Подготовка документов». По нему код решает, что
 * реквизит прислал сам сотрудник (отметка `fieldSources: employee` ставится моделью и не
 * доверяется). Пишет только обработчик входящих сообщений чата: ответы агента и результаты
 * веб-поиска сюда не попадают. Значения здесь реальные (до псевдонимизации).
 */

/** Пространство состояния: накопленный нормализованный текст сообщений сотрудника треда. */
export const EMPLOYEE_TEXT_NAMESPACE = 'documents:employee-text';

/** Сколько знаков текста сообщений треда храним для сверки (хвост самый свежий). */
const EMPLOYEE_TEXT_MAX_CHARS = 40_000;

const employeeTextSchema = z.object({ text: z.string() });

/** Запомнить сообщение сотрудника в треде. Пустой текст и отсутствие хранилища - без записи. */
export async function noteEmployeeMessage(
  state: WorkflowStateStore | undefined,
  threadId: string,
  text: string,
): Promise<void> {
  if (state === undefined || threadId === '' || text.trim() === '') return;
  const known = await readState(state, EMPLOYEE_TEXT_NAMESPACE, threadId, employeeTextSchema);
  const next = appendEmployeeText(known?.text ?? '', text, EMPLOYEE_TEXT_MAX_CHARS);
  if (next === (known?.text ?? '')) return;
  await writeState(state, EMPLOYEE_TEXT_NAMESPACE, threadId, { text: next });
}

/**
 * Последние сообщения сотрудника треда (нормализованные), от старых к новым. Сообщения в
 * накопленном тексте разделены переводом строки. Нужны там, где сверка по всему треду слишком
 * щедра: число договора называют в ближайших репликах, а не где-то в разговоре.
 */
export async function readRecentEmployeeMessages(
  state: WorkflowStateStore | undefined,
  threadId: string | undefined,
  count: number,
): Promise<string[]> {
  const text = await readEmployeeText(state, threadId);
  return text === '' ? [] : text.split('\n').slice(-count);
}

/** Нормализованный текст сообщений сотрудника этого треда; пусто, если треда или записи нет. */
export async function readEmployeeText(
  state: WorkflowStateStore | undefined,
  threadId: string | undefined,
): Promise<string> {
  if (state === undefined || threadId === undefined) return '';
  const stored = await readState(state, EMPLOYEE_TEXT_NAMESPACE, threadId, employeeTextSchema);
  return stored?.text ?? '';
}
