import { z } from 'zod';
import { DAY_MS } from '../../kit/domain/time';
import { localDateKey } from '@business-ai/core';
import { normalizeSupplierName } from '../../kit/domain/shortlist';
import type {
  AccessPolicy,
  AuditRepository,
  ChatChannel,
  Clock,
  MailboxDirectory,
  SystemContextBlock,
  WorkflowStateStore,
} from '@business-ai/core';
import type { SupplierMailClassifier } from '../../kit/ports/supplier-mail-classifier';
import type { SupplierRepository } from '../../kit/ports/repositories.owned';
import { readState, stableHash, writeState } from '@business-ai/core';
import type { SupplierCardsDeps } from './deps';
import type { SenderTrustPolicy } from './sender-trust';

/**
 * Хранилище и общие части обзора почты сотрудников (этап 222): пространства состояния, схемы
 * записей, ключи отметок и тексты сообщений. Обзор (`mail-proposals.ts`) пишет предложения, ответ
 * сотрудника (`mail-proposal-decision.ts`) закрывает их. Адреса, ИНН, домены и названия в
 * ключах состояния не лежат: только хэши.
 */

/** Предложения сотруднику (ключ - тред и id) и указатель на последнее (ключ - тред и `last`). */
export const SUPPLIER_MAIL_PROPOSAL_NAMESPACE = 'suppliers:mail-proposal.v1';
/**
 * Отметки «этого поставщика уже предлагали этому сотруднику» (ключ - хэш сотрудника и признака
 * поставщика: ИНН, домен или название). НЕ чистится по сроку: отклонённое не предлагается
 * повторно никогда. В записи только статус и время; объём - число предложенных поставщиков.
 */
export const SUPPLIER_MAIL_PROPOSAL_SEEN_NAMESPACE = 'suppliers:mail-proposal-seen.v1';
/** Отметки «письмо ящика уже разобрано» (ключ - хэш сотрудника и id письма). */
export const SUPPLIER_MAIL_PROPOSAL_MSG_NAMESPACE = 'suppliers:mail-proposal-msg.v1';
/** Кандидаты сотрудника, ещё не предложенные (набор прохода и остаток сверх предела). */
export const SUPPLIER_MAIL_PROPOSAL_DRAFT_NAMESPACE = 'suppliers:mail-proposal-draft.v1';
/** Курсор чтения ящика сотрудника (ключ - сотрудник). */
export const SUPPLIER_MAIL_PROPOSAL_CURSOR_NAMESPACE = 'suppliers:mail-proposal-cursor.v1';
/** Суточный счётчик оценок моделью (ключ - дата по поясу бизнеса). */
export const SUPPLIER_MAIL_PROPOSAL_QUOTA_NAMESPACE = 'suppliers:mail-proposal-quota.v1';
/**
 * С какого сотрудника начинать следующий обход (одна запись, ключ `start`): суточная квота
 * общая, и без ротации её каждый день первыми выбирали бы одни и те же сотрудники.
 */
export const SUPPLIER_MAIL_PROPOSAL_ROTATION_NAMESPACE = 'suppliers:mail-proposal-rotation.v1';
/** Ключ единственной записи ротации. */
export const ROTATION_KEY = 'start';
export const rotationSchema = z.object({ userId: z.string().min(1) });

/** Не больше пунктов в одном сообщении; остаток предлагается в следующий раз. */
export const SUPPLIER_MAIL_PROPOSAL_MAX_ITEMS = 10;
/** Идентификатор системного блока хода с открытым предложением. */
const SUPPLIER_MAIL_PROPOSAL_BLOCK_ID = 'supplier_mail_proposal';
/** Сколько суток открытое предложение ещё напоминается модели системным блоком хода. */
const BLOCK_MAX_AGE_DAYS = 14;
/** Ключ указателя на последнее предложение треда. */
const LAST_KEY_SUFFIX = 'last';
/** Предел подписи пункта (название или домен) и темы в сообщении. */
const LABEL_MAX_CHARS = 120;
const SUBJECT_MAX_CHARS = 120;
/** Управляющие символы и разделители строк: в сообщение не попадают. */
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
const EMPTY_SUBJECT_LABEL = '(без темы)';

/** Состояние отметки о поставщике. */
const SEEN_STATUSES = ['proposed', 'declined', 'created', 'known'] as const;
const seenSupplierSchema = z.object({
  at: z.string().min(1),
  status: z.enum(SEEN_STATUSES),
  proposalId: z.string().optional(),
});
export type SeenSupplier = z.infer<typeof seenSupplierSchema>;

/** Исход обработки письма; `retry` - письмо ждёт повтора оценки и разобранным не считается. */
export const msgSchema = z.object({
  at: z.string().min(1),
  outcome: z.enum(['candidate', 'skipped', 'not_supplier', 'known', 'duplicate_supplier', 'retry']),
  attempts: z.number().int().min(1).optional(),
});

/** Кандидат: письмо о поставщике, который ещё не предложен. */
const proposalCandidateSchema = z.object({
  messageId: z.string().min(1),
  /** Название поставщика из письма (для показа сотруднику); после закрытия предложения пусто. */
  label: z.string(),
  /** Тема письма (для показа); после закрытия предложения пусто. */
  subject: z.string(),
  receivedAt: z.string().min(1),
  /** Категории словами письма (проверены по тексту при оценке). */
  categories: z.array(z.string()).default([]),
  /** Хэши признаков поставщика (ИНН, домен, название) для отметок. */
  keys: z.array(z.string()).min(1),
  /**
   * Адрес отправителя, корпоративный домен и ИНН письма: нужны, чтобы перед отправкой остатка
   * черновика ещё раз сверить поставщика с базой (он мог появиться за время ожидания). После
   * закрытия предложения стираются вместе с названием.
   */
  sender: z.string().optional(),
  domain: z.string().optional(),
  inn: z.string().optional(),
});
export type Candidate = z.infer<typeof proposalCandidateSchema>;

export const draftSchema = z.object({
  items: z.array(proposalCandidateSchema).default([]),
  /** Предложение, записанное, но ещё не доставленное: повтор доставит его же. */
  taken: z
    .object({
      id: z.string().min(1),
      threadId: z.string().min(1),
      /** Прежнее неотвеченное предложение, чьи открытые пункты перенесены в это. */
      supersedes: z.string().min(1).optional(),
    })
    .optional(),
  /** Дата прохода (по поясу бизнеса), в который предложение последний раз ушло. */
  lastProposedOn: z.string().optional(),
});
export type Draft = z.infer<typeof draftSchema>;

/** Состояния пункта предложения. */
const ITEM_STATUSES = [
  'open',
  'created',
  'exists',
  'declined',
  'skipped',
  /** Предложение заменено новым: открытый пункт перенесён в него. */
  'superseded',
] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

const itemSchema = proposalCandidateSchema.extend({
  /** Номер пункта в сообщении сотруднику (с единицы). */
  number: z.number().int().min(1),
  status: z.enum(ITEM_STATUSES),
  supplierId: z.string().optional(),
});
export type ProposalItem = z.infer<typeof itemSchema>;

export const proposalSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  threadId: z.string().min(1),
  createdAt: z.string().min(1),
  /** Сообщение сотруднику доставлено. */
  sentAt: z.string().optional(),
  /** Сколько раз ответ сотрудника был неясен: вопрос повторяется один раз. */
  unclear: z.number().int().default(0),
  /** Сколько раз «да» не удалось исполнить из-за временной недоступности письма. */
  unavailable: z.number().int().default(0),
  /** Сколько кандидатов не поместилось в сообщение (предложатся в следующий раз). */
  more: z.number().int().default(0),
  items: z.array(itemSchema),
});
export type Proposal = z.infer<typeof proposalSchema>;

const pointerSchema = z.object({ id: z.string().min(1) });

/** Зависимости обзора и ответа сотрудника. */
export interface SupplierMailProposalsDeps {
  suppliers: SupplierRepository;
  state: WorkflowStateStore;
  clock: Clock;
  /** Классификатор писем (порт этапа 220; модель только через обёртку псевдонимизации). */
  classifier: SupplierMailClassifier;
  /** Каталог ящиков сотрудников (только чтение писем). */
  mailboxes: MailboxDirectory;
  /** Канал чата: предложение уходит в тред сотрудника с ботом-адресатом. */
  chat: ChatChannel;
  /** Права сотрудников: чат с агентом (права `suppliers.confirm_card` для предложений не нужно). Нет политики - допущены все. */
  access?: AccessPolicy | undefined;
  /** Агент-адресат (бот «Поиск поставщика»): по нему проверяются права и реестр обращений. */
  addresseeAgentId: string;
  /** Ключ бота-адресата для треда сотрудника, не писавшего боту; нет - только по реестру. */
  botId?: string | undefined;
  /** Названия наших юрлиц (`OWN_COMPANY_NAMES`). */
  ownCompanyNames: readonly string[];
  /** Реквизиты наших юрлиц (`OWN_COMPANY_REQUISITES`); не заданы - fail closed. */
  ownCompanyRequisites: readonly string[];
  /** Аудит записей карточек (без значений); не задан - не пишется. */
  audit?: AuditRepository | undefined;
  /** Журнал событий: только коды и числа. */
  log?: ((event: string, fields?: Record<string, string | number | boolean>) => void) | undefined;
  /**
   * Уровень доверия отправителям (этап 233, `MAIL_SENDER_TRUST_ENABLED`). Не задан - как
   * раньше: существующую карточку дополняет только письмо с собственной подписью DKIM,
   * выровненной с отправителем (ответ почтового сервера доверия не даёт).
   */
  senderTrust?: { policy: SenderTrustPolicy } | undefined;
  /**
   * Автообогащение существующих карточек по письмам без вопросов человеку (решение владельца
   * 10.11.2026, `SUPPLIER_MAIL_PROPOSALS_AUTO_ENRICH_ENABLED`). Не задан или false - письма
   * известных поставщиков закрываются без записи, как раньше.
   */
  autoEnrich?: boolean | undefined;
}

/** Хозяин зависимостей инструмента ответа: deps агента-адресата с полем `mailProposals`. */
export interface SupplierMailProposalsHost {
  mailProposals?: SupplierMailProposalsDeps | undefined;
  /**
   * Модуль карточек того же агента (есть, если подключены карточки поставщиков). Нужен одному:
   * реквизиты из письма к существующей карточке показываются сотруднику правкой с
   * подтверждением. Нет модуля - правка не предлагается, остаётся пометка на карточке.
   */
  supplierCards?: SupplierCardsDeps | undefined;
}

/** Ключ предложения в пространстве предложений. */
export const proposalKey = (threadId: string, id: string): string => `${threadId}:${id}`;
/** Ключ указателя на последнее предложение треда. */
export const pointerKey = (threadId: string): string => `${threadId}:${LAST_KEY_SUFFIX}`;

/** Текст без управляющих символов, одной строкой, не длиннее `maxChars`. */
function plainText(text: string, maxChars: number): string {
  return text.replace(CONTROL_CHARS_RE, ' ').replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

/** Подпись пункта и темы для показа: чистая строка ограниченной длины. */
export function displayLabel(text: string): string {
  return plainText(text, LABEL_MAX_CHARS);
}
export function displaySubject(text: string): string {
  return plainText(text, SUBJECT_MAX_CHARS);
}

/** Признаки поставщика, по которым ему ищется отметка (хэши, ПДн в ключах нет). */
export function supplierKeysOf(
  userId: string,
  traits: { inn?: string | undefined; domain?: string | undefined; name?: string | undefined },
): string[] {
  const keys: string[] = [];
  if (traits.inn !== undefined && traits.inn !== '') {
    keys.push(stableHash([userId, 'inn', traits.inn]));
  }
  if (traits.domain !== undefined && traits.domain !== '') {
    keys.push(stableHash([userId, 'domain', traits.domain.toLowerCase()]));
  }
  const name = traits.name === undefined ? '' : normalizeSupplierName(traits.name);
  if (name !== '') keys.push(stableHash([userId, 'name', name]));
  return keys;
}

/** Отметка о поставщике по хэшу признака. */
export function readSeenSupplier(
  state: WorkflowStateStore,
  key: string,
): Promise<SeenSupplier | null> {
  return readState(state, SUPPLIER_MAIL_PROPOSAL_SEEN_NAMESPACE, key, seenSupplierSchema);
}

/** Записать статус всем признакам поставщика. */
export async function markSupplierKeys(
  state: WorkflowStateStore,
  keys: readonly string[],
  status: SeenSupplier['status'],
  at: Date,
  proposalId?: string,
): Promise<void> {
  for (const key of keys) {
    await writeState(state, SUPPLIER_MAIL_PROPOSAL_SEEN_NAMESPACE, key, {
      at: at.toISOString(),
      status,
      ...(proposalId === undefined ? {} : { proposalId }),
    });
  }
}

/**
 * Снять отметку «предлагался» с признаков поставщика, пункт которого не удалось исполнить
 * (письмо исчезло): будущее письмо этого поставщика предложится снова. Отметки с другим
 * статусом (отклонён, заведён, в базе) остаются.
 */
export async function releaseSupplierKeys(
  state: WorkflowStateStore,
  keys: readonly string[],
): Promise<void> {
  for (const key of keys) {
    const seen = await readSeenSupplier(state, key);
    if (seen?.status === 'proposed') {
      await state.delete(SUPPLIER_MAIL_PROPOSAL_SEEN_NAMESPACE, key);
    }
  }
}

/** Пункт без текстов и адресов письма. */
function withoutLetterData(item: ProposalItem): ProposalItem {
  const { sender: _sender, domain: _domain, inn: _inn, ...rest } = item;
  return { ...rest, label: '', subject: '' };
}

/** Запись предложения без текстов: после закрытия названия, темы и адреса не нужны. */
export function redactedProposal(proposal: Proposal): Proposal {
  const closed = proposal.items.every((item) => item.status !== 'open');
  if (!closed) return proposal;
  return { ...proposal, items: proposal.items.map(withoutLetterData) };
}

/**
 * Закрыть прежнее неотвеченное предложение: открытые пункты перенесены в новое. Тексты
 * стираются. Повтор безопасен (нет открытых пунктов - запись только дозачищается).
 */
export async function closeSupersededProposal(
  state: WorkflowStateStore,
  threadId: string,
  id: string,
): Promise<void> {
  const key = proposalKey(threadId, id);
  const old = await readState(state, SUPPLIER_MAIL_PROPOSAL_NAMESPACE, key, proposalSchema);
  if (old === null) return;
  const items = old.items.map((item) =>
    item.status === 'open' ? { ...item, status: 'superseded' as const } : item,
  );
  await writeState(
    state,
    SUPPLIER_MAIL_PROPOSAL_NAMESPACE,
    key,
    redactedProposal({ ...old, items }),
  );
}

/** Дата `дд.мм` письма по поясу бизнеса. */
function shortDate(iso: string, timezone: string): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return '';
  const [, month = '', day = ''] = localDateKey(new Date(parsed), timezone).split('-');
  return `${day}.${month}`;
}

/**
 * Сообщение сотруднику: нумерованный список «поставщик, тема, дата» и как ответить. Кнопок нет:
 * ответ свободным текстом разбирает модель агента-адресата и записывает инструментом.
 */
export function proposalText(proposal: Proposal, timezone: string): string {
  const lines = proposal.items.map((item) => {
    const subject = item.subject === '' ? EMPTY_SUBJECT_LABEL : item.subject;
    const date = shortDate(item.receivedAt, timezone);
    const when = date === '' ? '' : ` от ${date}`;
    return `${item.number}. «${item.label}» — письмо${when}, тема «${subject}»`;
  });
  const more =
    proposal.more > 0
      ? [`Ещё писем о новых поставщиках: ${proposal.more} — предложу в следующий раз.`]
      : [];
  return [
    'В вашей почте за последние дни есть письма от компаний, которых нет в базе поставщиков:',
    ...lines,
    ...more,
    'Завести карточки? Ответьте «да», «нет» или номера, например «только 1 и 3». ' +
      'Карточки заведу по письмам, вопросов по форме не будет.',
  ].join('\n');
}

/** Последнее предложение треда, если оно есть и доставлено. */
export async function lastProposal(
  state: WorkflowStateStore,
  threadId: string,
): Promise<Proposal | null> {
  const pointer = await readState(
    state,
    SUPPLIER_MAIL_PROPOSAL_NAMESPACE,
    pointerKey(threadId),
    pointerSchema,
  );
  if (pointer === null) return null;
  return readState(
    state,
    SUPPLIER_MAIL_PROPOSAL_NAMESPACE,
    proposalKey(threadId, pointer.id),
    proposalSchema,
  );
}

/**
 * Системный блок хода с открытым предложением треда: модель не видит сообщения кода в истории,
 * и без блока короткое «да» осталось бы без контекста. Нет открытого доставленного предложения
 * (или оно старше двух недель) - null.
 */
export async function openMailProposalBlock(
  deps: Pick<SupplierMailProposalsDeps, 'state' | 'clock'>,
  threadId: string,
): Promise<SystemContextBlock | null> {
  const proposal = await lastProposal(deps.state, threadId);
  if (proposal?.sentAt === undefined) return null;
  const age = deps.clock.now().getTime() - Date.parse(proposal.createdAt);
  if (Number.isNaN(age) || age > BLOCK_MAX_AGE_DAYS * DAY_MS) return null;
  const open = proposal.items.filter((item) => item.status === 'open');
  if (open.length === 0) return null;
  const lines = [
    '[Справка системы: сотруднику отправлено предложение завести карточки поставщиков по его ' +
      'письмам; оно ждёт ответа. Это не просьба сотрудника.]',
    ...open.map((item) => `${item.number}. «${item.label}»`),
    'Если сотрудник отвечает на это предложение («да», «нет», «только 1 и 3»), запиши ответ ' +
      'инструментом recordMailSupplierProposalDecision и не задавай вопросов по форме карточки.',
  ];
  return { id: SUPPLIER_MAIL_PROPOSAL_BLOCK_ID, text: lines.join('\n') };
}
