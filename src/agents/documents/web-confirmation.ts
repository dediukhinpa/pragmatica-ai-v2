import { z } from 'zod';
import { DAY_MS } from '../../kit/domain/time';
import {
  checkWebConfirmation,
  describeFieldPath,
  normalizeForWebMatch,
  webFieldPaths,
  webMatchedPaths,
  webValuesSignature,
} from '../../kit/domain/document-sources';
import { dealDocumentSchema, type DealDocument } from '../../kit/domain/models';
import { type ValidationIssue } from '@business-ai/core';
import type { ChatMessage, Clock, WorkflowStateStore } from '@business-ai/core';
import { defineTool } from '@business-ai/core';
import { assertEmployeeChatTurn } from '@business-ai/core';
import {
  checkApprovalPress,
  parseApprovalButton,
  readState,
  requirePort,
  stableHash,
  writeState,
  type ApprovalButtonSpec,
} from '@business-ai/core';
import type { DocumentsDeps } from './deps';
import { documentFingerprint } from './fingerprint';

/**
 * Подтверждение полей из интернета сотрудником кнопкой (вне модели). Документ с веб-полями не
 * собирается, пока сотрудник не нажал кнопку; нажатие пишет только обработчик кнопки
 * (`recordWebConfirmation`), запись привязана к треду и к отпечатку значений веб-полей: смена
 * значения делает подтверждение недействительным. Поля, чьи значения пришли из веб-поиска
 * этого треда, считаются веб-полями независимо от отметки модели.
 */

/** Пространства состояния: запрос, решение, текст результатов веб-поиска треда. */
export const WEB_REQUEST_NAMESPACE = 'documents:web-request';
export const WEB_DECISION_NAMESPACE = 'documents:web-decision';
export const WEB_TEXT_NAMESPACE = 'documents:web-text';

/** Префикс id кнопок: `dwebc:<ok|no>:<токен запроса>`. */
const WEB_BUTTON_PREFIX = 'dwebc';
const CONFIRM_ACTION = 'ok';
const REJECT_ACTION = 'no';
/** Примеры ответа в вопросе: образцы, а не единственно допустимые слова (этап 164). */
const WEB_ANSWER_EXAMPLES = '«подтверждаю», «да», «не подтверждаю», «нет»';
/** Сколько полей перечисляем в вопросе сотруднику. */
const MESSAGE_FIELDS = 15;
/** Сколько знаков текста веб-выдачи треда храним для сверки (хвост самый свежий). */
const WEB_TEXT_MAX_CHARS = 40_000;
/** Срок подтверждения: сутки, как у решений по публикации и скачкам цен. */
const WEB_DECISION_TTL_MS = DAY_MS;

export type WebDecisionKind = 'confirmed' | 'rejected';

/** Что модель может передать в recordWebFieldsDecision: unclear - ответ неясен, не решение. */
const MODEL_DECISIONS = ['confirmed', 'rejected', 'unclear'] as const;
const WEB_UNCLEAR_QUESTION =
  'Ответ неясен. Один раз коротко повтори вопрос: подтверждаете ли данные из интернета ' +
  '(например: «подтверждаю» или «не подтверждаю»).';

const WEB_BUTTON_SPEC: ApprovalButtonSpec<WebDecisionKind> = {
  prefix: WEB_BUTTON_PREFIX,
  actions: { [CONFIRM_ACTION]: 'confirmed', [REJECT_ACTION]: 'rejected' },
};

const requestSchema = z.object({
  token: z.string(),
  threadId: z.string(),
  valuesHash: z.string(),
  requestedAt: z.string(),
  closedAt: z.string().optional(),
});

const decisionSchema = z.object({
  valuesHash: z.string(),
  decision: z.enum(['confirmed', 'rejected']),
  decidedBy: z.string(),
  decidedAt: z.string(),
});
type WebDecision = z.infer<typeof decisionSchema>;

const webTextSchema = z.object({ text: z.string() });

/** Токен запроса и решения: тред и отпечаток значений (другое значение - другой токен). */
export function webRequestToken(threadId: string, valuesHash: string): string {
  return stableHash([threadId, valuesHash]);
}

/** Разобрать id кнопки; null, если это не она. */
export function parseWebConfirmButton(
  buttonId: string,
): { decision: WebDecisionKind; token: string } | null {
  const parsed = parseApprovalButton(WEB_BUTTON_SPEC, buttonId);
  return parsed === null ? null : { decision: parsed.action, token: parsed.token };
}

/** Запомнить текст результатов веб-поиска треда: по нему код опознаёт значения из веба. */
export async function noteWebSearchText(
  state: WorkflowStateStore | undefined,
  threadId: string,
  hits: ReadonlyArray<{ title: string; snippet: string; url: string }>,
): Promise<void> {
  if (state === undefined || hits.length === 0) return;
  const known = await readState(state, WEB_TEXT_NAMESPACE, threadId, webTextSchema);
  const added = hits.map((hit) => normalizeForWebMatch(`${hit.title} ${hit.snippet}`));
  const text = [known?.text ?? '', ...added].join('\n').slice(-WEB_TEXT_MAX_CHARS);
  await writeState(state, WEB_TEXT_NAMESPACE, threadId, { text });
}

/** Итог проверки веб-полей документа. */
export interface WebFieldsStatus {
  /** Веб-поля документа (отмеченные моделью и опознанные кодом). */
  paths: string[];
  status: 'not_required' | 'confirmed' | 'rejected' | 'unconfirmed';
  /** Отпечаток значений веб-полей. */
  valuesHash: string;
}

/** Решение по токену, если оно ещё действует. */
function liveDecision(decision: WebDecision | null, clock: Clock | undefined): WebDecision | null {
  if (decision === null || clock === undefined) return decision;
  const age = clock.now().getTime() - Date.parse(decision.decidedAt);
  return Number.isNaN(age) || age > WEB_DECISION_TTL_MS ? null : decision;
}

/**
 * Состояние подтверждения веб-полей документа в треде. Без треда или хранилища подтвердить
 * нельзя: веб-поля остаются неподтверждёнными.
 */
export async function webFieldsStatus(
  doc: DealDocument,
  deps: DocumentsDeps,
  threadId: string | undefined,
): Promise<WebFieldsStatus> {
  const state = deps.state;
  let matched: string[] = [];
  if (state !== undefined && threadId !== undefined) {
    const stored = await readState(state, WEB_TEXT_NAMESPACE, threadId, webTextSchema);
    matched = webMatchedPaths(doc, stored?.text ?? '');
  }
  const paths = webFieldPaths(doc, new Set(matched));
  const valuesHash = stableHash(webValuesSignature(doc, paths));
  if (paths.length === 0) return { paths, status: 'not_required', valuesHash };
  if (state === undefined || threadId === undefined) {
    return { paths, status: 'unconfirmed', valuesHash };
  }
  const token = webRequestToken(threadId, valuesHash);
  const stored = await readState(state, WEB_DECISION_NAMESPACE, token, decisionSchema);
  const decision = liveDecision(stored, deps.clock);
  if (decision === null || decision.valuesHash !== valuesHash) {
    return { paths, status: 'unconfirmed', valuesHash };
  }
  return { paths, status: decision.decision, valuesHash };
}

/** Замечания по веб-полям: источники из интернета без нажатия кнопки. */
export async function webConfirmationIssues(
  doc: DealDocument,
  deps: DocumentsDeps,
  threadId: string | undefined,
): Promise<ValidationIssue[]> {
  const status = await webFieldsStatus(doc, deps, threadId);
  if (status.status === 'not_required') return [];
  return checkWebConfirmation(status.paths, status.status);
}

/** Итог нажатия кнопки. */
export type WebConfirmOutcome =
  | { kind: 'recorded'; decision: WebDecisionKind }
  | { kind: 'already_decided'; decision: WebDecisionKind }
  | { kind: 'unknown_request' }
  | { kind: 'wrong_thread' }
  | { kind: 'no_identity' };

/** Нажатие: личность и тред берутся из события канала, не из аргументов модели. */
export interface WebConfirmPress {
  token: string;
  decision: WebDecisionKind;
  userId: string;
  threadId: string;
}

/** Записать решение сотрудника. Вызывается обработчиком кнопки чата без участия агента. */
export async function recordWebConfirmation(
  state: WorkflowStateStore,
  clock: Clock,
  press: WebConfirmPress,
): Promise<WebConfirmOutcome> {
  const checked = await checkApprovalPress(
    state,
    { requestNamespace: WEB_REQUEST_NAMESPACE, requestSchema },
    press,
  );
  if (checked.kind !== 'ok') return { kind: checked.kind };
  const { request } = checked;
  const known = liveDecision(
    await readState(state, WEB_DECISION_NAMESPACE, request.token, decisionSchema),
    clock,
  );
  if (known !== null) return { kind: 'already_decided', decision: known.decision };
  const decision: WebDecision = {
    valuesHash: request.valuesHash,
    decision: press.decision,
    decidedBy: press.userId,
    decidedAt: clock.now().toISOString(),
  };
  await writeState(state, WEB_DECISION_NAMESPACE, request.token, decision);
  return { kind: 'recorded', decision: press.decision };
}

/** Вопрос сотруднику: список «взято из интернета» со значениями и подсказка ответа жирным. */
function buildMessage(doc: DealDocument, paths: readonly string[]): ChatMessage {
  const shown = paths.slice(0, MESSAGE_FIELDS).map((path) => `- ${describeFieldPath(doc, path)}`);
  const rest = paths.length - shown.length;
  return {
    text: [
      'Взято из интернета (не проверено):',
      ...shown,
      ...(rest > 0 ? [`И ещё ${rest}.`] : []),
      'Подтверждаете эти данные? Без подтверждения документ не будет собран.',
      `Например: ${WEB_ANSWER_EXAMPLES}.`,
    ].join('\n'),
  };
}

interface AskInput {
  document: DealDocument;
}
interface AskOutput {
  status: 'not_required' | 'confirmed' | 'rejected' | 'asked';
}

/**
 * Запросить у сотрудника подтверждение полей из интернета текстом (кнопок нет, решение
 * владельца 26.10.2026). Ответ сотрудника модель записывает `recordWebFieldsDecision` - только
 * в ходе, начатом его сообщением в чате.
 */
export const askToConfirmWebFields = defineTool<AskInput, AskOutput, DocumentsDeps>({
  name: 'askToConfirmWebFields',
  description:
    'Показать сотруднику список «взято из интернета» (поле = значение) и спросить ' +
    'подтверждение текстом. asked: вопрос отправлен - закончи ход и дождись ответа ' +
    'сотрудника, затем вызови recordWebFieldsDecision. Передай document как есть. Без ' +
    'подтверждения fillTemplate, saveDocument и handoffForReview документ не соберут. ' +
    'not_required: полей из интернета нет. Если значение поля изменилось, подтверждение ' +
    'нужно запросить заново.',
  sideEffect: true,
  inputSchema: z.object({ document: dealDocumentSchema }),
  outputSchema: z.object({
    status: z.enum(['not_required', 'confirmed', 'rejected', 'asked']),
  }),
  idempotencyKey: (input) => `documents-web-ask:${documentFingerprint(input.document)}`,
  // Вопрос уходит в тред диалога: тот же документ из другого треда спрашивается заново.
  idempotencyPredecessor: async (_input, _deps, threadId) => threadId,
  async execute(input, deps, context) {
    const state = requirePort(deps.state, 'хранилище статусов документов');
    const clock = requirePort(deps.clock, 'часы');
    const checked = await webFieldsStatus(input.document, deps, context.threadId);
    if (checked.status === 'not_required') return { status: 'not_required' };
    if (checked.status === 'confirmed' || checked.status === 'rejected') {
      return { status: checked.status };
    }
    const token = webRequestToken(context.threadId, checked.valuesHash);
    await writeState(state, WEB_REQUEST_NAMESPACE, token, {
      token,
      threadId: context.threadId,
      valuesHash: checked.valuesHash,
      requestedAt: clock.now().toISOString(),
    });
    await deps.chat.reply(
      context.threadId,
      buildMessage(input.document, checked.paths),
      `documents-web-ask:${token}`,
    );
    return { status: 'asked' };
  },
});

interface DecideInput {
  document: DealDocument;
  decision: (typeof MODEL_DECISIONS)[number];
}
interface DecideOutput {
  status: 'recorded' | 'already_decided' | 'not_asked' | 'not_required' | 'unclear';
  decision?: WebDecisionKind | undefined;
  /** unclear: короткая подсказка повторить вопрос один раз. */
  question?: string | undefined;
}

/**
 * Записать ответ сотрудника на вопрос о полях из интернета: то же решение, что писала кнопка,
 * привязанное к отпечатку значений. Только в ходе сотрудника в чате (не плановый, не передача).
 */
export const recordWebFieldsDecision = defineTool<DecideInput, DecideOutput, DocumentsDeps>({
  name: 'recordWebFieldsDecision',
  description:
    'Записать ответ сотрудника на вопрос askToConfirmWebFields (свободная форма, смысл читаешь ' +
    'ты). decision confirmed - явное согласие сразу в ответ на этот вопрос («подтверждаю», ' +
    '«да», «хорошо», «давай», «ок»); rejected - явный отказ («не подтверждаю», «нет», «не ' +
    'надо», «пока нет»); unclear - ответ неоднозначен или не про вопрос («ок» вне ответа на ' +
    'вопрос, «а откуда эти данные?»): ничего не записывается, ответь по существу и один раз ' +
    'коротко повтори вопрос. Не выдумывай согласие. Передай тот же document. not_asked: ' +
    'вопрос по этим значениям не задавался - сначала askToConfirmWebFields.',
  sideEffect: true,
  inputSchema: z.object({
    document: dealDocumentSchema,
    decision: z.enum(MODEL_DECISIONS),
  }),
  outputSchema: z.object({
    status: z.enum(['recorded', 'already_decided', 'not_asked', 'not_required', 'unclear']),
    decision: z.enum(['confirmed', 'rejected']).optional(),
    question: z.string().optional(),
  }),
  idempotencyKey: (input) =>
    `documents-web-decide:${documentFingerprint(input.document)}:${input.decision}`,
  idempotencyPredecessor: async (_input, _deps, threadId) => threadId,
  async execute(input, deps, context) {
    const userId = assertEmployeeChatTurn(context);
    // Неясный ответ ничего не пишет и решение не тратит: подтверждение остаётся открытым.
    if (input.decision === 'unclear') {
      return { status: 'unclear', question: WEB_UNCLEAR_QUESTION };
    }
    const state = requirePort(deps.state, 'хранилище статусов документов');
    const clock = requirePort(deps.clock, 'часы');
    const checked = await webFieldsStatus(input.document, deps, context.threadId);
    if (checked.status === 'not_required') return { status: 'not_required' };
    const token = webRequestToken(context.threadId, checked.valuesHash);
    const outcome = await recordWebConfirmation(state, clock, {
      token,
      decision: input.decision,
      userId,
      threadId: context.threadId,
    });
    if (outcome.kind === 'recorded' || outcome.kind === 'already_decided') {
      return { status: outcome.kind, decision: outcome.decision };
    }
    return { status: 'not_asked' };
  },
});
