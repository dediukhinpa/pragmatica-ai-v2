import { z } from 'zod';
import type { WorkflowStateStore } from '@business-ai/core';
import { stateEntries } from '@business-ai/core';
import { readState, writeState } from '@business-ai/core';
import {
  MAIL_INDEX_BACKFILL_NAMESPACE,
  STATE_SCAN_PAGE,
  UNASSIGNED_MAIL_NAMESPACE,
  type OrderCalcDeps,
} from './deps';
import { mailEntries } from './reply-store';

/**
 * Вторичные ключи писем в `UNASSIGNED_MAIL_NAMESPACE`. Основные записи лежат под `m:<письмо>`
 * (на разнесении) и `h:<письмо>` (ждут записи запроса или содержимого); все остальные ключи -
 * указатели на них, чтобы не читать пространство целиком (тела писем, разбор zod):
 * - `t:<отпечаток письма>` - письмо на разнесении по кнопке;
 * - `r:<заявка>:<письмо>` - письмо на разнесении по заявке-кандидату;
 * - `hr:<заявка>:<письмо>` - ожидающее письмо с причиной «содержимое не получено» по заявке.
 * Указатель пишется после основной записи; сбой между записями чинит повтор (`holdForManager`
 * повторно вносит запись), а записи без указателей подбирает однократное внесение в индекс.
 */
const TOKEN_KEY_PREFIX = 't:';
const REQUEST_KEY_PREFIX = 'r:';
const HELD_REQUEST_KEY_PREFIX = 'hr:';
const HELD_KEY_PREFIX = 'h:';
/**
 * Размер страницы при чтении указателей: страница читается целиком и за последним указателем
 * захватывает соседние записи (тела писем), поэтому она небольшая.
 */
const POINTER_PAGE = 20;
/** Ключ и значение отметки однократного внесения в индекс. */
const BACKFILL_MARKER_KEY = 'v1';
const backfillMarkerSchema = z.object({ doneAt: z.string() });

const pointerSchema = z.object({ messageId: z.string() });
/** Часть записи письма на разнесении, нужная для индекса. */
const indexedUnassignedSchema = z.object({
  messageId: z.string(),
  token: z.string(),
  candidates: z.array(z.object({ requestId: z.string() })),
  assignedRequestId: z.string().optional(),
});
/** Часть записи ожидающего письма, нужная для индекса. */
const indexedHeldSchema = z.object({
  messageId: z.string(),
  candidates: z.array(z.object({ requestId: z.string() })),
  contentOmitted: z.string().optional(),
  closedAt: z.string().optional(),
});

/** Письмо, которое вносится в индекс или снимается с него. */
interface IndexedMail {
  messageId: string;
  candidates: ReadonlyArray<{ requestId: string }>;
}

const tokenKey = (token: string): string => `${TOKEN_KEY_PREFIX}${token}`;
const requestKeyPrefix = (requestId: string): string => `${REQUEST_KEY_PREFIX}${requestId}:`;
const heldRequestKeyPrefix = (requestId: string): string =>
  `${HELD_REQUEST_KEY_PREFIX}${requestId}:`;

const requestIdsOf = (mail: IndexedMail): string[] => [
  ...new Set(mail.candidates.map((candidate) => candidate.requestId)),
];

/** Внести письмо на разнесении в индекс (по отпечатку и по заявкам-кандидатам). */
export async function indexUnassignedMail(
  store: WorkflowStateStore,
  mail: IndexedMail & { token: string },
): Promise<void> {
  const pointer = { messageId: mail.messageId };
  await writeState(store, UNASSIGNED_MAIL_NAMESPACE, tokenKey(mail.token), pointer);
  for (const requestId of requestIdsOf(mail)) {
    const key = `${requestKeyPrefix(requestId)}${mail.messageId}`;
    await writeState(store, UNASSIGNED_MAIL_NAMESPACE, key, pointer);
  }
}

/**
 * Письмо разнесено: из списков по заявкам оно уходит, указатель по отпечатку остаётся (по нему
 * повторное нажатие кнопки получает «уже разнесено») и помечается `done` вместе с самим письмом.
 */
export async function closeUnassignedIndex(
  store: WorkflowStateStore,
  mail: IndexedMail & { token: string },
): Promise<void> {
  for (const requestId of requestIdsOf(mail)) {
    const key = `${requestKeyPrefix(requestId)}${mail.messageId}`;
    await store.delete(UNASSIGNED_MAIL_NAMESPACE, key);
  }
  const pointer = { messageId: mail.messageId };
  await store.put(UNASSIGNED_MAIL_NAMESPACE, tokenKey(mail.token), pointer, { done: true });
}

/** Внести ожидающее письмо с причиной «содержимое не получено» в индекс по заявкам. */
export async function indexHeldMail(store: WorkflowStateStore, mail: IndexedMail): Promise<void> {
  for (const requestId of requestIdsOf(mail)) {
    const key = `${heldRequestKeyPrefix(requestId)}${mail.messageId}`;
    await writeState(store, UNASSIGNED_MAIL_NAMESPACE, key, { messageId: mail.messageId });
  }
}

/** Ожидающее письмо закрыто: снять его указатели по заявкам. */
export async function unindexHeldMail(store: WorkflowStateStore, mail: IndexedMail): Promise<void> {
  for (const requestId of requestIdsOf(mail)) {
    await store.delete(
      UNASSIGNED_MAIL_NAMESPACE,
      `${heldRequestKeyPrefix(requestId)}${mail.messageId}`,
    );
  }
}

/** Идентификаторы писем по указателям с префиксом (постранично, не читая сами письма). */
async function* pointedMessageIds(
  store: WorkflowStateStore,
  prefix: string,
): AsyncGenerator<string> {
  const entries = stateEntries(store, UNASSIGNED_MAIL_NAMESPACE, {
    pageSize: POINTER_PAGE,
    after: prefix,
    prefix,
  });
  for await (const entry of entries) {
    const parsed = pointerSchema.safeParse(entry.value);
    if (parsed.success) yield parsed.data.messageId;
  }
}

/** Письма на разнесении, где заявка среди кандидатов: идентификаторы по указателям `r:`. */
export function unassignedMessageIdsFor(
  store: WorkflowStateStore,
  requestId: string,
): AsyncGenerator<string> {
  return pointedMessageIds(store, requestKeyPrefix(requestId));
}

/** Ожидающие письма с причиной «содержимое не получено» по заявке: указатели `hr:`. */
export function heldMessageIdsFor(
  store: WorkflowStateStore,
  requestId: string,
): AsyncGenerator<string> {
  return pointedMessageIds(store, heldRequestKeyPrefix(requestId));
}

/** Идентификатор письма на разнесении по отпечатку (указатель `t:`); null - указателя нет. */
export async function unassignedMessageIdByToken(
  store: WorkflowStateStore,
  token: string,
): Promise<string | null> {
  const pointer = await readState(store, UNASSIGNED_MAIL_NAMESPACE, tokenKey(token), pointerSchema);
  return pointer?.messageId ?? null;
}

/**
 * Один раз внести в индекс письма, записанные до его появления (запасной путь для старых
 * записей). Обход потоковый, без накопления: основные записи читаются по префиксам `m:` и
 * `h:`, всё остальное пропускается. Отметка ставится после полного обхода: сбой посередине даёт
 * повтор, а не пропуск; повторная запись указателей безвредна.
 */
export async function ensureMailIndex(
  store: WorkflowStateStore,
  now: Date,
  log?: OrderCalcDeps['log'],
): Promise<void> {
  const marker = await readState(
    store,
    MAIL_INDEX_BACKFILL_NAMESPACE,
    BACKFILL_MARKER_KEY,
    backfillMarkerSchema,
  );
  if (marker !== null) return;
  let unassigned = 0;
  let held = 0;
  for await (const entry of mailEntries(store, UNASSIGNED_MAIL_NAMESPACE, STATE_SCAN_PAGE)) {
    const parsed = indexedUnassignedSchema.safeParse(entry.value);
    if (!parsed.success) continue;
    if (parsed.data.assignedRequestId === undefined) {
      await indexUnassignedMail(store, parsed.data);
    } else {
      // Письмо уже разнесено: нужен только указатель по отпечатку для «уже разнесено».
      const pointer = { messageId: parsed.data.messageId };
      await store.put(UNASSIGNED_MAIL_NAMESPACE, tokenKey(parsed.data.token), pointer, {
        done: true,
      });
    }
    unassigned += 1;
  }
  const heldEntries = stateEntries(store, UNASSIGNED_MAIL_NAMESPACE, {
    pageSize: STATE_SCAN_PAGE,
    after: HELD_KEY_PREFIX,
    prefix: HELD_KEY_PREFIX,
  });
  for await (const entry of heldEntries) {
    const parsed = indexedHeldSchema.safeParse(entry.value);
    if (!parsed.success || parsed.data.closedAt !== undefined) continue;
    if (parsed.data.contentOmitted === undefined) continue;
    await indexHeldMail(store, parsed.data);
    held += 1;
  }
  await writeState(store, MAIL_INDEX_BACKFILL_NAMESPACE, BACKFILL_MARKER_KEY, {
    doneAt: now.toISOString(),
  });
  if (unassigned + held > 0) log?.('order_mail_index_backfilled', { unassigned, held });
}
