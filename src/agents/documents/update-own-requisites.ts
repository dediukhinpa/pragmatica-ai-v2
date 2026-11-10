import { z } from 'zod';
import { ACTION_UPDATE_OWN_REQUISITES } from '../../kit/domain/access.owned';
import { DomainError, employeeOfThread, isDomainError } from '@business-ai/core';
import {
  OWN_ENTITY_CODE_BY_ALIAS,
  OWN_ENTITY_FIELDS,
  OWN_ENTITY_FIELD_LABELS,
  OWN_ENTITY_TITLES,
  applyOwnEntityPatch,
  changedOwnEntityFields,
  ownLegalEntityPatchSchema,
  type OwnEntityCode,
  type OwnEntityField,
  type OwnLegalEntity,
  type OwnLegalEntityPatch,
} from '../../kit/domain/own-legal-entity';
import { HOUR_MS } from '../../kit/domain/time';
import { valueInEmployeeText } from '../../kit/domain/employee-text';
import { defineTool, type ToolContext } from '@business-ai/core';
import { assertEmployeeChatTurn } from '@business-ai/core';
import { failureName } from '@business-ai/core';
import { readState, requirePort, stableHash, writeState } from '@business-ai/core';
import { DOCUMENTS_AGENT_ID, type DocumentsDeps } from './deps';
import { readEmployeeText, readRecentEmployeeMessages } from './employee-messages';
import { entityNamedIn } from './template-registry';

/**
 * Изменение наших реквизитов по указанию сотрудника (этап 230). Два шага, как у подтверждения
 * веб-данных: `proposeOwnRequisitesUpdate` проверяет правку и показывает сотруднику «было -> станет»,
 * `confirmOwnRequisitesUpdate` записывает её после ответа сотрудника. Запись делает код по сохранённой
 * правке, а не по аргументам модели: между предложением и «да» значения подменить нельзя.
 */

/** Запросы подтверждения: ключ - тред, в треде ждёт ответа не больше одного предложения. */
export const OWN_REQUISITES_REQUEST_NAMESPACE = 'documents:own-requisites-request';
/** Действие в журнале аудита. */
const AUDIT_ACTION = 'documents.own_requisites_update';
/** Срок ответа сотрудника: реквизиты не должны уходить в запись по вчерашнему «да». */
const REQUEST_TTL_MS = HOUR_MS;
/** Сколько последних сообщений сотрудника просматривается при сверке юрлица. */
const RECENT_EMPLOYEE_MESSAGES = 6;

const MODEL_DECISIONS = ['confirmed', 'rejected', 'unclear'] as const;
const ANSWER_EXAMPLES = '«подтверждаю», «да», «отмена», «нет»';

const requestSchema = z.object({
  token: z.string(),
  threadId: z.string(),
  userId: z.string(),
  entity: z.enum(['pragmatika', 'master_gifts']),
  /** Правка, как её проверил код. После решения стирается: значения в состоянии не копятся. */
  patch: ownLegalEntityPatchSchema.or(z.object({}).strict()),
  /** `updatedAt` записи, по которой собрана правка; изменилась - правка устарела. */
  baseUpdatedAt: z.string(),
  requestedAt: z.string(),
  closedAt: z.string().optional(),
  /**
   * Отпечаток «тред + юрлицо + правка + запись»: одинаковый у повторного предложения того же,
   * поэтому открытый запрос переиспользуется и вопрос не задваивается. Токен (он и ключ вопроса)
   * строится ещё и от предыдущего запроса треда: после отмены, устаревания или записи та же правка
   * получает новый токен, и вопрос уходит снова.
   */
  basis: z.string().optional(),
  /** Какие поля покажет вопрос (названия, не значения): для ответа, если закрытие не удалось. */
  fields: z.array(z.enum(OWN_ENTITY_FIELDS)).optional(),
});
type Request = z.infer<typeof requestSchema>;

const PROPOSE_STATUSES = [
  'asked',
  'access_denied',
  'entity_not_confirmed',
  'values_not_confirmed',
  'invalid',
  'no_record',
  'no_change',
  'not_configured',
] as const;

const proposeInput = z.object({
  /** Наше юрлицо: pr - «Прагматика», mg - «Мастер Гифтс». */
  entity: z.enum(['pr', 'mg']),
  /** Только те поля, которые сотрудник назвал; `null` убирает необязательное поле. */
  changes: ownLegalEntityPatchSchema,
});
type ProposeInput = z.infer<typeof proposeInput>;

interface ProposeOutput {
  status: (typeof PROPOSE_STATUSES)[number];
  /** Названия полей (не значения): что показано сотруднику или что не принято. */
  fields?: string[] | undefined;
  message: string;
}

const proposeOutput = z.object({
  status: z.enum(PROPOSE_STATUSES),
  fields: z.array(z.string()).optional(),
  message: z.string(),
});

const ACCESS_DENIED_TEXT =
  'У сотрудника нет права менять реквизиты наших юрлиц. Скажи об этом и ничего не записывай; ' +
  'доступ выдаёт владелец.';

/** Имена полей по-русски, через запятую: значений нет. */
function fieldNames(fields: readonly OwnEntityField[]): string {
  return fields.map((field) => OWN_ENTITY_FIELD_LABELS[field]).join(', ');
}

/** Поля правки в порядке схемы. */
function patchFields(patch: OwnLegalEntityPatch): OwnEntityField[] {
  return (Object.keys(OWN_ENTITY_FIELD_LABELS) as OwnEntityField[]).filter(
    (field) => patch[field] !== undefined,
  );
}

/** Право менять реквизиты: нет политики или права - нельзя (fail closed). */
async function mayUpdate(deps: DocumentsDeps, userId: string, agentId: string): Promise<boolean> {
  if (deps.access === undefined) return false;
  return deps.access.isAllowed({ userId, botId: agentId, action: ACTION_UPDATE_OWN_REQUISITES });
}

/** Показ сотруднику: что было и что станет. Значения здесь только в чате сотрудника. */
function askText(
  code: OwnEntityCode,
  rows: ReadonlyArray<{ field: OwnEntityField; before: string; after: string }>,
): string {
  return [
    `Изменить реквизиты юрлица «${OWN_ENTITY_TITLES[code]}»:`,
    ...rows.map(
      (row) => `- ${OWN_ENTITY_FIELD_LABELS[row.field]}: было «${row.before}», станет «${row.after}»`,
    ),
    'Эти реквизиты попадают в договоры. Подтверждаете изменение?',
    `Например: ${ANSWER_EXAMPLES}.`,
  ].join('\n');
}

/** Запрос ещё ждёт ответа: не закрыт и не просрочен. */
function isRequestLive(request: Request | null, now: Date): request is Request {
  if (request === null || request.closedAt !== undefined) return false;
  return now.getTime() - Date.parse(request.requestedAt) <= REQUEST_TTL_MS;
}

/**
 * Отпечаток состояния, от которого зависит исход предложения: запись юрлица, запрос треда,
 * сообщения сотрудника и право. Входит в ключ идемпотентности: иначе любой отказ
 * (значения не названы, юрлицо не названо, нет права, отмена, устарело) навсегда отвечал бы из
 * кэша, а повтор «дословно» не доходил бы до проверки. Одно и то же состояние - тот же ключ, то
 * есть настоящий повтор (в том же ходе) по-прежнему не задваивает вопрос.
 */
async function proposalStateFingerprint(
  input: ProposeInput,
  deps: DocumentsDeps,
  threadId: string,
): Promise<string> {
  try {
    const code = OWN_ENTITY_CODE_BY_ALIAS[input.entity];
    const record = (await deps.ownEntities?.get(code)) ?? null;
    const request =
      deps.state === undefined
        ? null
        : await readState(deps.state, OWN_REQUISITES_REQUEST_NAMESPACE, threadId, requestSchema);
    const employee = employeeOfThread(threadId);
    return stableHash({
      record: record?.updatedAt ?? null,
      request: request === null ? null : [request.token, request.closedAt ?? null],
      text: stableHash(await readEmployeeText(deps.state, threadId)),
      allowed: employee === null ? null : await mayUpdate(deps, employee, DOCUMENTS_AGENT_ID),
    });
  } catch {
    // Чтение не удалось: исход определит сам `execute` (он упадёт на том же чтении).
    return 'unreadable';
  }
}

/**
 * Предложить изменение наших реквизитов: проверить право, юрлицо, происхождение значений,
 * формат и контрольные суммы и показать сотруднику «было -> станет». Запись не делается.
 */
export const proposeOwnRequisitesUpdate = defineTool<ProposeInput, ProposeOutput, DocumentsDeps>({
  name: 'proposeOwnRequisitesUpdate',
  description:
    'Предложить изменить НАШИ реквизиты (юрлицо pr - «Прагматика» или mg - «Мастер Гифтс»), ' +
    'когда сотрудник просит их обновить. changes - только названные сотрудником поля ' +
    '(fullName, shortName, inn, kpp, ogrn, legalAddress, postalAddress, actualAddress, ' +
    'bankName, bik, settlementAccount, correspondentAccount, signatoryPosition, ' +
    'signatoryName, signatoryBasis, phone, email); значения дословно как он назвал, ' +
    'необязательное поле убирает null. Не придумывай и не бери значения из договоров или ' +
    'из интернета. Код сам покажет сотруднику «было -> станет» и спросит подтверждение: asked ' +
    '- закончи ход и дождись ответа, затем confirmOwnRequisitesUpdate. Другой status - ' +
    'перескажи message, ничего не записано.',
  sideEffect: true,
  inputSchema: proposeInput,
  outputSchema: proposeOutput,
  // Одно предложение в треде: вопрос уходит по токену правки, повтор не задваивает сообщение.
  // Состояние-предшественник - чтобы повтор после отказа, отмены или устаревания исполнялся.
  idempotencyKey: (input) => `documents-own-req-propose:${input.entity}:${stableHash(input.changes)}`,
  idempotencyPredecessor: async (input, deps, threadId) =>
    `${threadId}:${await proposalStateFingerprint(input, deps, threadId)}`,
  async execute(input, deps, context): Promise<ProposeOutput> {
    const userId = assertEmployeeChatTurn(context);
    const repository = deps.ownEntities;
    const state = deps.state;
    const clock = deps.clock;
    if (repository === undefined || state === undefined || clock === undefined) {
      return {
        status: 'not_configured',
        message: 'Изменение реквизитов не подключено. Скажи сотруднику, что это делает владелец.',
      };
    }
    if (!(await mayUpdate(deps, userId, context.agentId))) {
      return { status: 'access_denied', message: ACCESS_DENIED_TEXT };
    }
    const code = OWN_ENTITY_CODE_BY_ALIAS[input.entity];
    // Юрлицо называет сотрудник: правка чужих реквизитов - ошибка, которую не видно.
    const recent = await readRecentEmployeeMessages(state, context.threadId, RECENT_EMPLOYEE_MESSAGES);
    if (!recent.some((text) => entityNamedIn(text, input.entity))) {
      return {
        status: 'entity_not_confirmed',
        message:
          'Не ясно, чьи реквизиты менять: в последних сообщениях сотрудника юрлицо не названо. ' +
          'Спроси одним вопросом (Мастер Гифтс или Прагматика) и повтори с тем, что он назвал.',
      };
    }
    const record = await repository.get(code);
    if (record === null) {
      return {
        status: 'no_record',
        message:
          `Записи реквизитов «${OWN_ENTITY_TITLES[code]}» в базе нет: сначала её заполняет ` +
          'владелец (скрипт заполнения). Скажи об этом сотруднику.',
      };
    }
    // Значения называет сотрудник: придуманное моделью в реквизиты не попадает.
    const employeeText = await readEmployeeText(state, context.threadId);
    const ungrounded = patchFields(input.changes).filter((field) => {
      const value = input.changes[field];
      return typeof value === 'string' && !valueInEmployeeText(field, value, employeeText);
    });
    if (ungrounded.length > 0) {
      return {
        status: 'values_not_confirmed',
        fields: ungrounded,
        message:
          `Значения полей (${fieldNames(ungrounded)}) не найдены в сообщениях сотрудника. ` +
          'Попроси прислать их текстом и повтори дословно; не придумывай значения.',
      };
    }
    let merged;
    try {
      merged = applyOwnEntityPatch(record, input.changes);
    } catch (error) {
      if (!isDomainError(error) || error.code !== 'invalid_input') throw error;
      return { status: 'invalid', message: `${error.message} Ничего не записано.` };
    }
    const changed = changedOwnEntityFields(record, merged);
    if (changed.length === 0) {
      return { status: 'no_change', message: 'Эти значения уже записаны, менять нечего.' };
    }
    const basis = stableHash([context.threadId, code, input.changes, record.updatedAt]);
    const previous = await readState(
      state,
      OWN_REQUISITES_REQUEST_NAMESPACE,
      context.threadId,
      requestSchema,
    );
    const now = clock.now();
    // Тот же вопрос ещё ждёт ответа: токен прежний, вопрос по ключу не задваивается. Иначе запрос
    // новый, а токен зависит от предыдущего: после отмены или устаревания вопрос уходит заново.
    const reusable =
      isRequestLive(previous, now) && previous.basis === basis && previous.userId === userId;
    const token = reusable
      ? previous.token
      : stableHash([basis, previous?.token ?? '', now.toISOString()]);
    if (!reusable) {
      const request: Request = {
        token,
        threadId: context.threadId,
        userId,
        entity: code,
        patch: input.changes,
        baseUpdatedAt: record.updatedAt,
        requestedAt: now.toISOString(),
        basis,
        fields: changed,
      };
      await writeState(state, OWN_REQUISITES_REQUEST_NAMESPACE, context.threadId, request);
    }
    await deps.chat.reply(
      context.threadId,
      {
        text: askText(
          code,
          changed.map((field) => ({
            field,
            before: record[field] ?? 'не задано',
            after: merged[field] ?? 'не задано',
          })),
        ),
      },
      `documents-own-req-ask:${token}`,
    );
    return {
      status: 'asked',
      fields: changed,
      message:
        'Вопрос сотруднику отправлен. Закончи ход и дождись его ответа, затем вызови ' +
        'confirmOwnRequisitesUpdate.',
    };
  },
});

const CONFIRM_STATUSES = [
  'updated',
  'rejected',
  'unclear',
  'not_asked',
  'wrong_user',
  'access_denied',
  'stale',
  'invalid',
  'not_configured',
] as const;

const confirmInput = z.object({ decision: z.enum(MODEL_DECISIONS) });
type ConfirmInput = z.infer<typeof confirmInput>;

interface ConfirmOutput {
  status: (typeof CONFIRM_STATUSES)[number];
  fields?: string[] | undefined;
  message: string;
}

const confirmOutput = z.object({
  status: z.enum(CONFIRM_STATUSES),
  fields: z.array(z.string()).optional(),
  message: z.string(),
});

/** Запрос закрыт: значения правки стираются, остаётся только факт и время. */
async function closeRequest(deps: DocumentsDeps, request: Request): Promise<void> {
  const state = requirePort(deps.state, 'хранилище состояния');
  const clock = requirePort(deps.clock, 'часы');
  await writeState(state, OWN_REQUISITES_REQUEST_NAMESPACE, request.threadId, {
    ...request,
    patch: {},
    closedAt: clock.now().toISOString(),
  });
}

/** Журнал: кто, когда, какое юрлицо и какие поля; значений нет. Сбой журнала запись не откатывает. */
async function journal(
  deps: DocumentsDeps,
  parts: { actor: string; agent: string; code: OwnEntityCode; fields: readonly OwnEntityField[]; result: string; token: string },
): Promise<void> {
  const clock = requirePort(deps.clock, 'часы');
  try {
    await deps.audit?.append(
      {
        at: clock.now().toISOString(),
        actor: parts.actor,
        agent: parts.agent,
        action: AUDIT_ACTION,
        details: `entity=${parts.code} fields=${parts.fields.join(',')}`,
        result: parts.result,
      },
      `own-requisites-update:${parts.token}:${parts.result}`,
    );
  } catch (error) {
    deps.log?.('audit_failed', { code: failureName(error) });
  }
}

/**
 * Записать изменение реквизитов по ответу сотрудника. Правку берёт из сохранённого предложения;
 * писать может только тот, кто просил, и только при праве; запись, изменённая после предложения,
 * не перезаписывается (stale).
 */
export const confirmOwnRequisitesUpdate = defineTool<ConfirmInput, ConfirmOutput, DocumentsDeps>({
  name: 'confirmOwnRequisitesUpdate',
  description:
    'Записать ответ сотрудника на вопрос proposeOwnRequisitesUpdate (свободная форма, смысл ' +
    'читаешь ты). confirmed - явное согласие сразу в ответ на этот вопрос («подтверждаю», ' +
    '«да», «хорошо», «давай»); rejected - явный отказ («отмена», «нет», «не надо»); unclear - ' +
    'ответ неоднозначен или не про вопрос: ничего не записывается, ответь по существу и один ' +
    'раз коротко повтори вопрос. Не выдумывай согласие. Значения не передавай: код пишет ' +
    'то, что показал сотруднику. not_asked: вопроса нет или он устарел (час) - сначала ' +
    'proposeOwnRequisitesUpdate.',
  sideEffect: true,
  inputSchema: confirmInput,
  outputSchema: confirmOutput,
  idempotencyKey: (input) => `documents-own-req-confirm:${input.decision}`,
  // Другое предложение в том же треде - другая операция; повтор того же остаётся повтором.
  idempotencyPredecessor: async (_input, deps, threadId) => {
    if (deps.state === undefined) return '';
    const request = await readState(
      deps.state,
      OWN_REQUISITES_REQUEST_NAMESPACE,
      threadId,
      requestSchema,
    );
    if (request === null) return '';
    // Право входит в ключ: отказ из-за права не должен жить в кэше после его выдачи.
    const employee = employeeOfThread(threadId);
    const allowed =
      employee === null ? '' : String(await mayUpdate(deps, employee, DOCUMENTS_AGENT_ID));
    return `${request.token}${request.closedAt === undefined ? '' : ':closed'}:${allowed}`;
  },
  async execute(input, deps, context): Promise<ConfirmOutput> {
    const userId = assertEmployeeChatTurn(context);
    if (input.decision === 'unclear') {
      return {
        status: 'unclear',
        message: `Ответ неясен. Один раз коротко повтори вопрос (например: ${ANSWER_EXAMPLES}).`,
      };
    }
    const repository = deps.ownEntities;
    const state = deps.state;
    const clock = deps.clock;
    if (repository === undefined || state === undefined || clock === undefined) {
      return { status: 'not_configured', message: 'Изменение реквизитов не подключено.' };
    }
    const request = await readState(
      state,
      OWN_REQUISITES_REQUEST_NAMESPACE,
      context.threadId,
      requestSchema,
    );
    const age = request === null ? 0 : clock.now().getTime() - Date.parse(request.requestedAt);
    if (request === null || request.closedAt !== undefined || !(age <= REQUEST_TTL_MS)) {
      return {
        status: 'not_asked',
        message: 'Вопроса об изменении реквизитов нет или он устарел: ничего не записано.',
      };
    }
    if (request.userId !== userId) {
      return {
        status: 'wrong_user',
        message: 'Изменение подтверждает тот сотрудник, который его просил. Ничего не записано.',
      };
    }
    if (input.decision === 'rejected') {
      await closeRequest(deps, request);
      return { status: 'rejected', message: 'Изменение реквизитов отменено, ничего не записано.' };
    }
    if (!(await mayUpdate(deps, userId, context.agentId))) {
      return { status: 'access_denied', message: ACCESS_DENIED_TEXT };
    }
    const record = await repository.get(request.entity);
    // Запись прошла, а закрыть запрос не удалось (сбой или падение процесса между ними): повтор
    // не должен отвечать «ничего не записано». Правка уже в записи, сделана этим же
    // сотрудником после предложения - отвечаем «записано» и закрываем запрос; журнал идемпотентен.
    if (record !== null && patchAlreadyApplied(record, request, userId)) {
      return finishUpdate(deps, context, request, userId, requestFields(request));
    }
    if (record === null || record.updatedAt !== request.baseUpdatedAt) {
      await closeRequest(deps, request);
      return {
        status: 'stale',
        message:
          'Реквизиты изменились после предложения: ничего не записано. Если правка ещё нужна, ' +
          'предложи её заново.',
      };
    }
    let merged;
    try {
      merged = applyOwnEntityPatch(record, request.patch as OwnLegalEntityPatch);
    } catch (error) {
      if (!isDomainError(error) || error.code !== 'invalid_input') throw error;
      await closeRequest(deps, request);
      return { status: 'invalid', message: `${error.message} Ничего не записано.` };
    }
    const fields = changedOwnEntityFields(record, merged);
    try {
      await repository.save(request.entity, merged, {
        updatedBy: userId,
        at: clock.now().toISOString(),
        expectedUpdatedAt: record.updatedAt,
      });
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== 'conflict') throw error;
      await closeRequest(deps, request);
      return { status: 'stale', message: error.message };
    }
    deps.log?.('own_requisites_updated', { entity: request.entity, fields: fields.join(',') });
    return finishUpdate(deps, context, request, userId, fields);
  },
});

/** Названия полей запроса: сохранённые при предложении либо все поля правки. */
function requestFields(request: Request): OwnEntityField[] {
  return request.fields ?? patchFields(request.patch as OwnLegalEntityPatch);
}

/** Сохранённая правка уже стоит в записи, и поставил её этот сотрудник после предложения. */
function patchAlreadyApplied(record: OwnLegalEntity, request: Request, userId: string): boolean {
  if (record.updatedBy !== userId || record.updatedAt === request.baseUpdatedAt) return false;
  if (!(Date.parse(record.updatedAt) >= Date.parse(request.requestedAt))) return false;
  try {
    const merged = applyOwnEntityPatch(record, request.patch as OwnLegalEntityPatch);
    return changedOwnEntityFields(record, merged).length === 0;
  } catch {
    return false;
  }
}

/**
 * После записи в БД: журнал (идемпотентен по токену запроса) и закрытие запроса. Запись уже
 * состоялась, поэтому сбой закрытия не превращается в ошибку инструмента - иначе модель
 * повторила бы шаг и услышала «ничего не записано»; запрос закроет повтор (`patchAlreadyApplied`).
 */
async function finishUpdate(
  deps: DocumentsDeps,
  context: ToolContext,
  request: Request,
  userId: string,
  fields: readonly OwnEntityField[],
): Promise<ConfirmOutput> {
  await journal(deps, {
    actor: userId,
    agent: context.agentId,
    code: request.entity,
    fields,
    result: 'ok',
    token: request.token,
  });
  try {
    await closeRequest(deps, { ...request, fields: [...fields] });
  } catch (error) {
    deps.log?.('own_requisites_close_failed', { code: failureName(error) });
  }
  return {
    status: 'updated',
    fields: [...fields],
    message:
      `Реквизиты «${OWN_ENTITY_TITLES[request.entity]}» обновлены (${fieldNames(fields)}). ` +
      'Новые договоры возьмут их из базы; шаблоны на диске при изменении банка, адреса, ' +
      'подписанта печатают прежнее - предупреди сотрудника, что шаблон нужно обновить, иначе ' +
      'сборка по нему откажет.',
  };
}
