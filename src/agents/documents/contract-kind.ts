import { z } from 'zod';
import { CancelledError } from '@business-ai/core';
import { HOUR_MS } from '../../kit/domain/time';
import { base64Of } from '@business-ai/core';
import type { ContractKindResult } from '../../kit/ports/contract-amender';
import { sha256HexSync } from '@business-ai/core';
import { readState, stableHash, writeState } from '@business-ai/core';
import type { DocumentsDeps } from './deps';
import { readRecentEmployeeMessages } from './employee-messages';
import { readAllowedTemplate } from './template-access';
import { CONTRACT_TEMPLATES } from './template-registry';

/**
 * Признак «договор поставщика» (решение владельца 08.11.2026): решает код, а не модель.
 * Договор поставщика - файл НЕ по нашему шаблону, и в нём заполнена сторона исполнителя.
 * Файл по нашему шаблону узнаётся по метке в свойствах документа и по совпадению неизменного
 * текста с шаблонами реестра (их читает ядро с шары и присылает сервису документов).
 * Неоднозначный случай не решается молча: код записывает вопрос, агент задаёт его сотруднику, а
 * ответ принимается, только если:
 * - он дан в СЛЕДУЮЩЕЙ реплике после вопроса (`turnNumber === askedAtTurn + 1`) в том же треде,
 *   по тому же файлу и не позже часа;
 * - код сам разобрал ПОСЛЕДНЕЕ сообщение сотрудника по смыслу (`parseKindReply`) и разбор
 *   совпал с `kindAnswer`, который передала модель; неоднозначный ответ - вопрос задаётся снова.
 * Запись вопроса удаляется, как только ответ принят или прошла другая реплика.
 */

/** Пространство состояния: открытый вопрос «договор поставщика или наш шаблон?». */
export const CONTRACT_KIND_REQUEST_NAMESPACE = 'documents:contract-kind-request';
/** Срок ответа сотрудника на вопрос: час, как у остальных подтверждений. */
const KIND_REQUEST_TTL_MS = HOUR_MS;

/** Ответ сотрудника на вопрос о виде документа. */
export const KIND_ANSWERS = ['supplier', 'own_template'] as const;
export type KindAnswer = (typeof KIND_ANSWERS)[number];

/** Итог разбора реплики сотрудника: ответ или `unclear` (неоднозначно, не по теме). */
export type KindReply = KindAnswer | 'unclear';

/** Дольше этого (в словах) реплика не считается ответом на вопрос: в ней речь о другом. */
const MAX_REPLY_WORDS = 12;
/** Слова, которыми сотрудник мог подтвердить вопрос «это договор поставщика?». */
const YES_REPLY = /^(?:да|ага|угу|верно|точно|конечно|именно)(?: |$)/u;
/** Слова отрицания вопроса «это договор поставщика?» (значит, документ по нашему шаблону). */
const NO_REPLY = /^нет(?: |$)/u;
/** «Не наш», «не по нашему шаблону»: это ответ «поставщика», а не «наш». */
const NOT_OURS = /(?:^| )не (?:по |из )?наш\p{L}*(?: шаблон\p{L}*)?/u;
/** Признаки договора поставщика: он, его форма, контрагент, чужой. */
const SUPPLIER_WORDS =
  /(?:^| )(?:поставщик\p{L}*|контрагент\p{L}*|чуж\p{L}*|(?:его|их) (?:форм|договор|шаблон)\p{L}*)/u;
/** Признаки нашего документа: наш, собственный, по шаблону, мы составили. */
const OWN_WORDS =
  /(?:^| )(?:наш\p{L}*|собственн\p{L}*|по шаблону|мы (?:его |сами )?(?:сделали|составили|собрали))/u;
/** «Не поставщика», «не чужой»: отрицание признака поставщика - ответ неоднозначен. */
const NEGATED_SUPPLIER = /(?:^| )не (?:\p{L}+ ){0,2}(?:поставщик|контрагент|чуж)/u;

/**
 * Разбор ответа сотрудника на вопрос «договор поставщика (в его форме) или наш шаблон?» по
 * смыслу, кодом. Текст - нормализованное сообщение сотрудника (`normalizeEmployeeText`).
 * Принимает: «да» (поставщика), «нет» (наш), «поставщика», «его форма», «не наш шаблон», «наш»,
 * «по нашему шаблону». Всё остальное - `unclear`: пустое, длинное (речь о другом), без
 * признаков, противоречивое («да, наш»), с отрицанием («не поставщика»).
 */
export function parseKindReply(text: string): KindReply {
  const words = text.replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (words === '' || words.split(' ').length > MAX_REPLY_WORDS) return 'unclear';
  if (NEGATED_SUPPLIER.test(words)) return 'unclear';
  const notOurs = NOT_OURS.test(words);
  // «Не наш шаблон» - не признак нашего документа, хотя содержит слово «наш».
  const rest = words.replace(NOT_OURS, ' ');
  const supplier = notOurs || SUPPLIER_WORDS.test(rest) || YES_REPLY.test(words);
  const own = OWN_WORDS.test(rest) || NO_REPLY.test(words);
  if (supplier === own) return 'unclear';
  return supplier ? 'supplier' : 'own_template';
}

const requestSchema = z.object({
  threadId: z.string(),
  /** Отпечаток файла: вопрос относится к этому файлу, а не к любому в треде. */
  fileHash: z.string(),
  /** Реплика сотрудника, на которой задан вопрос: ответ принимается только в более поздней. */
  askedAtTurn: z.number().int(),
  askedAt: z.string(),
});
type KindRequest = z.infer<typeof requestSchema>;

/** Ключ вопроса: тред и файл. */
function requestKey(threadId: string, fileHash: string): string {
  return stableHash([threadId, fileHash]);
}

/** Отпечаток содержимого файла (не имя: имя сотрудник может переиначить). */
export function contractFileHash(bytes: Uint8Array): string {
  return sha256HexSync(base64Of(bytes));
}

/** Диск шаблона: каталог шаблонов плюс имя файла из реестра. */
function templateDiskPath(deps: DocumentsDeps, fileName: string): string {
  const prefix = (deps.templatesPrefix ?? '').replace(/\/+$/u, '');
  return prefix === '' ? fileName : `${prefix}/${fileName}`;
}

/**
 * Байты наших шаблонов договоров из реестра, которые удалось прочитать с шары. Не прочитался
 * шаблон (нет на диске, нет в перечне, сбой шары) - он пропускается: код тогда может лишь
 * спросить сотрудника, а не объявить файл «чужим». Отмена хода пробрасывается.
 */
export async function readOwnTemplates(
  deps: DocumentsDeps,
  signal: AbortSignal | undefined,
): Promise<Uint8Array[]> {
  const found: Uint8Array[] = [];
  for (const template of CONTRACT_TEMPLATES) {
    if (signal?.aborted === true) throw new CancelledError('Чтение шаблонов отменено.');
    try {
      const file = await readAllowedTemplate(deps, templateDiskPath(deps, template.fileName));
      found.push(file.content);
    } catch (error) {
      if (error instanceof CancelledError) throw error;
      deps.log?.('contract_kind_template_unreadable', { id: template.id });
    }
  }
  return found;
}

/** ИНН из строки реквизитов (`OWN_COMPANY_REQUISITES`): ровно 10 или 12 цифр подряд. */
const INN_IN_TEXT = /(?<!\d)\d{10}(?:\d{2})?(?!\d)/gu;

/** Наши ИНН и наименования: записи юрлиц из БД и настройки `OWN_COMPANY_*`. */
export async function ownIdentity(
  deps: DocumentsDeps,
): Promise<{ inns: string[]; names: string[] }> {
  const names = new Set(deps.ownCompanyNames);
  const inns = new Set<string>();
  for (const line of deps.ownCompanyRequisites ?? []) {
    for (const match of line.match(INN_IN_TEXT) ?? []) inns.add(match);
  }
  for (const record of (await deps.ownEntities?.list()) ?? []) {
    inns.add(record.inn.replace(/\D+/gu, ''));
    names.add(record.shortName);
    names.add(record.fullName);
  }
  return { inns: [...inns].filter((inn) => inn !== ''), names: [...names] };
}

/** Что сказать о причине неоднозначности (человеческими словами, без значений документа). */
const UNCLEAR_REASON_TEXT: Readonly<Record<string, string>> = {
  templates_unavailable: 'наши шаблоны не удалось прочитать для сравнения',
  template_partial_match: 'часть текста совпадает с нашим шаблоном',
  executor_not_filled: 'сторона исполнителя в файле не заполнена',
};

/** Причины неоднозначности словами; неизвестные коды в текст не попадают. */
export function unclearReasonText(result: ContractKindResult): string {
  const known = result.reasons.flatMap((code) => UNCLEAR_REASON_TEXT[code] ?? []);
  return known.length === 0 ? 'признаки противоречивы' : known.join('; ');
}

/** Записать вопрос сотруднику (идемпотентно: тот же файл в том же треде - одна запись). */
export async function recordKindQuestion(
  deps: DocumentsDeps,
  threadId: string,
  fileHash: string,
  turnNumber: number,
): Promise<void> {
  if (deps.state === undefined) return;
  const request: KindRequest = {
    threadId,
    fileHash,
    askedAtTurn: turnNumber,
    askedAt: (deps.clock?.now() ?? new Date()).toISOString(),
  };
  await writeState(
    deps.state,
    CONTRACT_KIND_REQUEST_NAMESPACE,
    requestKey(threadId, fileHash),
    request,
  );
}

/** Итог сверки ответа: принят (ответ), не разобран (был открытый вопрос) или вопроса нет. */
export type KindResolution =
  | { status: 'accepted'; answer: KindAnswer }
  | { status: 'unreadable' }
  | { status: 'none' };

/**
 * Решить, принимается ли ответ сотрудника на вопрос кода. Принимается, только когда:
 * - вопрос по этому файлу записан кодом, не просрочен и задан в предыдущей реплике
 *   (`turnNumber === askedAtTurn + 1`); ответ в той же реплике (сама спросила - сама ответила)
 *   и в более поздней не принимается;
 * - последнее сообщение сотрудника код разобрал сам (`parseKindReply`) и оно совпало с
 *   `modelAnswer`: ответ модели без подтверждения словами сотрудника не принимается.
 * Запись вопроса удаляется после принятия ответа и когда реплика-ответ уже прошла (разобран он
 * или нет): вопрос задаётся заново и записывается в новой реплике. Без хранилища состояния
 * принять нечем.
 */
export async function resolveKindAnswer(
  deps: DocumentsDeps,
  threadId: string,
  fileHash: string,
  turnNumber: number,
  modelAnswer: KindAnswer | undefined,
): Promise<KindResolution> {
  if (deps.state === undefined) return { status: 'none' };
  const key = requestKey(threadId, fileHash);
  const request = await readState(deps.state, CONTRACT_KIND_REQUEST_NAMESPACE, key, requestSchema);
  if (request === null || request.threadId !== threadId || request.fileHash !== fileHash) {
    return { status: 'none' };
  }
  // Вопрос задан в этой же реплике: ответа ещё не было, запись остаётся.
  if (turnNumber <= request.askedAtTurn) return { status: 'none' };
  // С этой минуты вопрос исчерпан (принят, не разобран или устарел): повторно не используется.
  await deps.state.delete(CONTRACT_KIND_REQUEST_NAMESPACE, key);
  const age = (deps.clock?.now() ?? new Date()).getTime() - Date.parse(request.askedAt);
  const fresh = !Number.isNaN(age) && age <= KIND_REQUEST_TTL_MS;
  if (!fresh || turnNumber !== request.askedAtTurn + 1) return { status: 'none' };
  const [reply] = await readRecentEmployeeMessages(deps.state, threadId, 1);
  const parsed = parseKindReply(reply ?? '');
  if (parsed !== 'unclear' && parsed === modelAnswer) {
    return { status: 'accepted', answer: parsed };
  }
  return { status: 'unreadable' };
}
