import { z } from 'zod';
import { readState, writeState } from '@business-ai/core';
import type { ToolContext, ToolDefinition, WorkflowStateStore } from '@business-ai/core';

/**
 * Учёт отправленных файлов правки за один ход сотрудника. Агент мог вызвать правку файла дважды
 * за ход (сначала не все места, потом полный набор): сотрудник получал два файла с одним
 * именем, первый неполный. Отправленный файл не вернуть, поэтому здесь два правила: правки
 * хода накапливаются (итоговый файл собирается из всех мест хода), а повторная отправка идёт
 * с другим именем и явной пометкой «обновлённая версия».
 */

/** Пространство состояния; ключ записи - тред, номер хода и что правится (файл или импорт). */
export const PRICE_EDIT_TURN_NAMESPACE = 'prices:edit-turn';

/** Пометка новой версии в имени файла (перед расширением). */
export const UPDATED_VERSION_MARK = 'обновлённая_версия';

/** Начало пояснения агенту, когда отправлена обновлённая версия файла. */
export const UPDATED_VERSION_PREFIX = 'Это ОБНОВЛЁННАЯ ВЕРСИЯ файла: ';

/** Продолжение: что сказать сотруднику про два файла (правки хода собраны в последнем). */
export const UPDATED_VERSION_NOTE =
  'в этом ходе сотруднику уже ушёл файл, этот отправлен заново с новым именем. В итоговом ' +
  'ответе скажи, что актуален только этот файл (обновлённая версия), а прежний использовать не ' +
  'нужно.';

/**
 * Начало ответа инструмента, когда файл отправляется один раз в конце хода (этап 9u): сам файл
 * уходит после ответа модели, поэтому ни «отправлен», ни «заново» про него говорить нельзя.
 */
export const ONCE_AT_END_PREFIX =
  'Файл подготовлен и уйдёт сотруднику ОДНИМ файлом в конце хода, после твоего ответа или ' +
  'вместе с ним.';

/** Правила нескольких правок за ход при отправке одним файлом в конце хода. */
export const ONCE_AT_END_NOTE =
  'Если правок несколько, вызывай инструмент по очереди: каждый следующий вызов включает все ' +
  'правки хода и заменяет предыдущий файл, останется один файл со всеми правками (поэтому в ' +
  'changes видны ВСЕ правки хода). В итоговом тексте говори об одном файле.';

/** Файл, уже отправленный за этот ход: ключ отправки (для узнавания повтора) и имя. */
const sendSchema = z.object({ key: z.string(), name: z.string() });

/** Правка, которую несёт итоговый файл хода: ключ места и исходное указание сотрудника. */
const carriedSchema = z.object({
  place: z.string(),
  spec: z.record(z.string(), z.unknown()),
});

const recordSchema = z.object({
  sends: z.array(sendSchema),
  carried: z.array(carriedSchema),
});
export type TurnRecord = z.infer<typeof recordSchema>;
export type CarriedEdit = z.infer<typeof carriedSchema>;

/** Пустая запись: в этом ходе файл по этому объекту ещё не отправлялся. */
export function emptyTurnRecord(): TurnRecord {
  return { sends: [], carried: [] };
}

/** Ключ записи: тред, номер реплики человека (ход) и объект правки. */
export function turnRecordKey(context: ToolContext, subject: string): string {
  return `${context.threadId}/${context.turnNumber}/${subject}`;
}

/** Прочитать запись хода; нет записи или нет хранилища состояния - пустая. */
export async function loadTurnRecord(
  state: WorkflowStateStore | undefined,
  key: string,
): Promise<TurnRecord> {
  if (state === undefined) return emptyTurnRecord();
  const stored = await readState(state, PRICE_EDIT_TURN_NAMESPACE, key, recordSchema);
  return stored ?? emptyTurnRecord();
}

/** Записать запись хода (`done`: её уберёт ретенция состояния по сроку). */
export async function saveTurnRecord(
  state: WorkflowStateStore | undefined,
  key: string,
  record: TurnRecord,
): Promise<void> {
  if (state === undefined) return;
  await writeState(state, PRICE_EDIT_TURN_NAMESPACE, key, record, { done: true });
}

/** Повтор уже выполненной отправки (повтор шага после сбоя): тот же ключ отправки. */
export function isReplay(record: TurnRecord, sendKey: string): boolean {
  return record.sends.some((send) => send.key === sendKey);
}

/** Это отправка обновлённой версии: в этом ходе файл уже уходил, а это не повтор. */
export function isUpdatedVersion(record: TurnRecord, sendKey: string): boolean {
  return record.sends.length > 0 && !isReplay(record, sendKey);
}

/**
 * Имя файла для отправки. Первая отправка хода и повтор - как есть (у повтора - прежнее имя);
 * следующая - с пометкой перед расширением, начиная со второй версии с номером.
 */
export function versionedFileName(name: string, record: TurnRecord, sendKey: string): string {
  const same = record.sends.find((send) => send.key === sendKey);
  if (same !== undefined) return same.name;
  if (record.sends.length === 0) return name;
  const slash = name.lastIndexOf('/');
  const dot = name.lastIndexOf('.');
  const stemEnd = dot > slash + 1 ? dot : name.length;
  const number = record.sends.length > 1 ? `_${record.sends.length}` : '';
  return `${name.slice(0, stemEnd)}_${UPDATED_VERSION_MARK}${number}${name.slice(stemEnd)}`;
}

/** Очереди по ключу хода: вызовы одного хода идут по очереди, а не вперемешку. */
const queues = new Map<string, Promise<unknown>>();

/** Выполнить `work` после всех ранее поставленных работ с тем же ключом. */
export async function withTurnQueue<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const run = previous.then(work, work);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  queues.set(key, tail);
  try {
    return await run;
  } finally {
    if (queues.get(key) === tail) queues.delete(key);
  }
}

/**
 * Инструмент правки, чьи вызовы одного хода идут строго по очереди: параллельные вызовы
 * иначе прочитали бы одну и ту же запись хода и отправили бы файлы с одним именем.
 */
export function serializedPerTurn<O, D>(
  tool: ToolDefinition<unknown, O, D>,
): ToolDefinition<unknown, O, D> {
  return {
    ...tool,
    execute: (input, deps, context) =>
      withTurnQueue(`${context.threadId}/${context.turnNumber}`, () =>
        tool.execute(input, deps, context),
      ),
  };
}
