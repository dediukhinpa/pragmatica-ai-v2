import { z } from 'zod';
import { defineTool } from '@business-ai/core';
import { predecessorOf, readState, writeState } from '@business-ai/core';
import { assertEmployeeChatTurn } from '@business-ai/core';
import {
  CONFIRM_CARD_DENIED_TEXT,
  CONFIRM_CARD_UNAVAILABLE_TEXT,
  confirmCardVerdict,
  type ConfirmCardVerdict,
} from '../suppliers/confirm-card-right';
import { createAutoSupplierCard } from '../suppliers/draft-card';
import { addConfirmedSuppliers, loadOpenChoiceAsks } from './choice-confirmation';
import { SUPPLIER_CARD_OFFER_NAMESPACE, type OrderCalcDeps } from './deps';
import { assertOrderOwner } from './order-access';
import { NAMED_SUPPLIER_MAX_LENGTH } from './named-suppliers';
import { enrichFromSite } from './supplier-enrich';
import { siteHostOf } from './web-page-facts';

/**
 * Поставщик назван сотрудником, но карточки в базе нет (этап 163, решение владельца 03.11).
 * Вместо отказа и повторного шорт-листа код запоминает предложение «создать карточку по данным
 * с сайта и подготовить письмо» и отдаёт модели готовый вопрос. Карточку код заводит только
 * после `recordSupplierCardDecision` с decision=create в ходе сотрудника: по молчанию или по
 * ответу про другое карточка не создаётся, а смысл ответа определяет модель (свободная форма).
 */

/** Пункт предложения: название и сайт, если сотрудник дал ссылку. */
const offerItemSchema = z.object({
  name: z.string().min(1),
  website: z.string().min(1).optional(),
});
export type CardOfferItem = z.infer<typeof offerItemSchema>;

const offerSchema = z.object({
  requestId: z.string().min(1),
  threadId: z.string().min(1),
  askedAt: z.string(),
  items: z.array(offerItemSchema).min(1),
  status: z.enum(['open', 'created', 'declined']),
  /** Сколько раз ответ сотрудника был неясен: вопрос повторяется один раз, не чаще. */
  unclear: z.number().int().default(0),
  /** Заведённые карточки: повторное create возвращает их, а не плодит дубли. */
  cards: z.array(z.object({ supplierId: z.string(), name: z.string() })).default([]),
});
type CardOffer = z.infer<typeof offerSchema>;

/** Сколько пунктов хранится в одном предложении (остальное - ошибка вызова, не поставщики). */
const OFFER_ITEMS_MAX = 5;
/** Основание в заметке карточки: значения с сайта нельзя считать подтверждёнными. */
const CARD_BASIS =
  'создана по просьбе сотрудника по данным сайта; значения из интернета, подтвердите';

const FIELD_LABELS = { city: 'город', phone: 'телефон', email: 'почта' } as const;

/** Адрес сайта из текста: только http(s) с хостом, содержащим точку; иначе null. */
export function siteOriginOf(raw: string): string | null {
  const text = raw.trim();
  if (text === '' || /\s/u.test(text)) return null;
  try {
    const url = new URL(/^https?:\/\//iu.test(text) ? text : `https://${text}`);
    if (!url.hostname.includes('.')) return null;
    return `${url.protocol}//${url.hostname}`;
  } catch {
    return null;
  }
}

/**
 * Название и сайт из пункта ответа. Ссылка или домен («https://66print.ru/…», «66print.ru»)
 * дают сайт и название по домену без зоны («66print»); обычный текст - название как есть.
 */
export function offerItemOfPick(pick: string): CardOfferItem {
  const text = pick.trim();
  const looksLikeSite = /^https?:\/\//iu.test(text) || /^[^\s/]+\.[a-z]{2,}(\/\S*)?$/iu.test(text);
  const origin = looksLikeSite ? siteOriginOf(text) : null;
  if (origin === null) return { name: pick.trim().slice(0, NAMED_SUPPLIER_MAX_LENGTH) };
  const host = siteHostOf(origin).replace(/^www\./u, '');
  const label = host.split('.')[0] ?? host;
  return { name: label.slice(0, NAMED_SUPPLIER_MAX_LENGTH), website: origin };
}

/** Название для поиска карточки в базе: для ссылки - имя по домену, иначе пункт как есть. */
export function lookupNameOfPick(pick: string): string {
  return offerItemOfPick(pick).name;
}

/** Вопрос сотрудницы: прямо про отсутствие карточки и одно предложение. Кнопок нет. */
export function cardOfferQuestion(items: readonly CardOfferItem[]): string {
  const names = items.map((item) => `«${item.name}»`).join(', ');
  const plural = items.length > 1;
  const noSite = items.some((item) => item.website === undefined);
  const subject = plural ? 'Карточек поставщиков' : 'Карточки поставщика';
  const what = plural ? 'карточки' : 'карточку';
  const source = noSite
    ? 'сайт не назван, заведу по названию, контакты придётся дополнить'
    : 'по данным с сайта';
  return `${subject} ${names} в базе нет. Создать ${what} (${source}) и подготовить письмо?`;
}

/**
 * Право сотрудника заводить карточки в общей базе (этап 234). Политика - своя у агента заявок,
 * иначе политика модуля карточек; нет ни одной - отказ (запись без политики запрещена).
 */
export function cardCreateVerdict(
  deps: OrderCalcDeps,
  userId: string,
  agentId: string,
): Promise<ConfirmCardVerdict> {
  return confirmCardVerdict(deps.access ?? deps.supplierCards?.access, { userId, botId: agentId });
}

/** Что сказать сотруднику, когда вопрос про создание карточки не задаётся (нет права). */
export const CARD_CREATE_DENIED_NOTE =
  `${CONFIRM_CARD_DENIED_TEXT} Вопрос про создание карточки не задавай: сообщи это и продолжай ` +
  'работу с остальными поставщиками.';

function loadOffer(deps: OrderCalcDeps, threadId: string): Promise<CardOffer | null> {
  return readState(deps.state, SUPPLIER_CARD_OFFER_NAMESPACE, threadId, offerSchema);
}

/**
 * Запомнить предложение создать карточки (новое заменяет прежнее в этом треде). `siteUrl`
 * относится к единственному пункту без своей ссылки; при нескольких пунктах его не применяем -
 * угадывать, чей это сайт, нельзя.
 */
export async function registerCardOffer(
  deps: OrderCalcDeps,
  input: {
    requestId: string;
    threadId: string;
    picks: readonly string[];
    siteUrl?: string | undefined;
  },
): Promise<{ items: CardOfferItem[]; question: string }> {
  let items = input.picks.slice(0, OFFER_ITEMS_MAX).map(offerItemOfPick);
  const origin = input.siteUrl === undefined ? null : siteOriginOf(input.siteUrl);
  const [only] = items;
  if (origin !== null && items.length === 1 && only !== undefined && only.website === undefined) {
    items = [{ ...only, website: origin }];
  }
  const offer: CardOffer = {
    requestId: input.requestId,
    threadId: input.threadId,
    askedAt: deps.clock.now().toISOString(),
    items,
    status: 'open',
    unclear: 0,
    cards: [],
  };
  await writeState(deps.state, SUPPLIER_CARD_OFFER_NAMESPACE, input.threadId, offer);
  deps.log?.('supplier_card_offer', { items: items.length });
  return { items, question: cardOfferQuestion(items) };
}

const DECISIONS = ['create', 'decline', 'unclear'] as const;
type CardDecision = (typeof DECISIONS)[number];
const DECISION_STATUSES = [
  'created',
  'already_created',
  'declined',
  'unclear',
  'not_asked',
  'no_permission',
  'unavailable',
] as const;

interface DecisionInput {
  decision: CardDecision;
}
interface DecisionOutput {
  status: (typeof DECISION_STATUSES)[number];
  requestId?: string | undefined;
  /** no_permission, unavailable: что сказать сотруднику. */
  message?: string | undefined;
  /** Заведённые карточки: что взято из интернета (требует подтверждения). */
  cards?:
    | Array<{ supplierId: string; name: string; created: boolean; fromWeb: string[] }>
    | undefined;
  /** unclear: повторить вопрос (один раз) и вопрос готовым текстом. */
  repeatQuestion?: boolean | undefined;
  question?: string | undefined;
  /** declined: у заявки остался открытый выбор из шорт-листа (список повторно не слать). */
  choiceStillOpen?: boolean | undefined;
  /** created: выбор записан, можно вызывать recordSelection. */
  choiceRecorded?: boolean | undefined;
}

/**
 * Создать карточки по сайтам. Данные сайта берёт существующее обогащение
 * (`enrichFromSite`): сбой чтения сайта карточку не блокирует, она заводится по названию.
 */
async function createCards(
  deps: OrderCalcDeps,
  offer: CardOffer,
  userId: string,
  context: Parameters<typeof enrichFromSite>[1],
): Promise<NonNullable<DecisionOutput['cards']>> {
  const out: NonNullable<DecisionOutput['cards']> = [];
  for (const item of offer.items) {
    const found =
      item.website === undefined ? {} : await enrichFromSite(deps, context, item, item.website);
    const result = await createAutoSupplierCard(
      deps.suppliers,
      {
        name: item.name,
        ...(item.website === undefined ? {} : { website: item.website }),
        ...(found.city === undefined ? {} : { city: found.city }),
        ...(found.phone === undefined ? {} : { phone: found.phone }),
        ...(found.email === undefined ? {} : { email: found.email }),
      },
      {
        userId,
        nowIso: deps.clock.now().toISOString(),
        basis: CARD_BASIS,
        ...(item.website === undefined ? {} : { origin: siteHostOf(item.website) }),
      },
    );
    // Из интернета помечаем только то, что карточка действительно получила с сайта.
    const fromWeb = result.created
      ? (Object.keys(FIELD_LABELS) as Array<keyof typeof FIELD_LABELS>)
          .filter((field) => found[field] !== undefined)
          .map((field) => FIELD_LABELS[field])
      : [];
    out.push({
      supplierId: result.card.id,
      name: result.card.name,
      created: result.created,
      fromWeb,
    });
    deps.log?.('supplier_card_from_site', { created: result.created, fields: fromWeb.length });
  }
  return out;
}

/**
 * Записать ответ сотрудника на вопрос «Создать карточку и подготовить письмо?». Смысл ответа
 * определяет модель по явным словам сотрудника: create - согласие («создавай», «хорошо»,
 * «давай», «ок», «да»), decline - отказ («не надо», «нет», «пока не нужно»), unclear - ответ не
 * про вопрос или сомнение. Карточка создаётся только здесь и только после create.
 */
export const recordSupplierCardDecision = defineTool<DecisionInput, DecisionOutput, OrderCalcDeps>(
  {
    name: 'recordSupplierCardDecision',
    description:
      'Записать ответ сотрудника на вопрос «Создать карточку по данным с сайта и подготовить ' +
      'письмо?» (его задал recordManagerChoice, статус card_missing). decision: create - ' +
      'сотрудник ЯВНО согласился (например «создавай», «хорошо», «давай», «ок», «да», ' +
      '«создай»); decline - явно отказался («не надо», «не нужно», «нет», «пока нет», «пока ' +
      'не нужно»); unclear - сомнение или ответ не про этот вопрос («а какой у него срок?»), ' +
      'не выдумывай согласие. created: карточка заведена (поля fromWeb взяты из интернета и ' +
      'требуют подтверждения - скажи об этом), choiceRecorded=true - вызови recordSelection и ' +
      'prepareSupplierRequestText. already_created: повтор, карточки не дублируются, ' +
      'действуй так же. declined: вернись к выбору из шорт-листа БЕЗ повторной отправки списка. ' +
      'unclear: ответь по существу и при repeatQuestion=true один раз коротко повтори question, ' +
      'иначе ничего не спрашивай. not_asked: вопроса о карточке в этом чате нет. ' +
      'no_permission: карточку в общей базе заводит только руководитель отдела - скажи об ' +
      'этом (message), ничего не создано, письмо этому поставщику не готовь, продолжай с ' +
      'остальными. unavailable: временный сбой проверки права - скажи (message), ничего не ' +
      'создано, ответ можно повторить позже.',
    sideEffect: true,
    inputSchema: z.object({ decision: z.enum(DECISIONS) }),
    outputSchema: z.object({
      status: z.enum(DECISION_STATUSES),
      requestId: z.string().optional(),
      message: z.string().optional(),
      cards: z
        .array(
          z.object({
            supplierId: z.string(),
            name: z.string(),
            created: z.boolean(),
            fromWeb: z.array(z.string()),
          }),
        )
        .optional(),
      repeatQuestion: z.boolean().optional(),
      question: z.string().optional(),
      choiceStillOpen: z.boolean().optional(),
      choiceRecorded: z.boolean().optional(),
    }),
    idempotencyKey: (input) => `card-offer-decide:${input.decision}`,
    // Предложение меняется с каждым ответом (статус, счётчик неясных): тот же ответ после
    // изменения - новая операция, а не кэшированный итог.
    idempotencyPredecessor: async (_input, deps, threadId) => {
      const offer = await loadOffer(deps, threadId);
      return predecessorOf(
        offer === null
          ? null
          : { status: offer.status, unclear: offer.unclear, askedAt: offer.askedAt },
      );
    },
    async execute(input, deps, context) {
      const userId = assertEmployeeChatTurn(context);
      const offer = await loadOffer(deps, context.threadId);
      if (offer === null) return { status: 'not_asked' };
      await assertOrderOwner(deps, offer.requestId, context);
      const write = (next: CardOffer): Promise<void> =>
        writeState(deps.state, SUPPLIER_CARD_OFFER_NAMESPACE, context.threadId, next);
      if (offer.status === 'created') {
        // Повтор: без побочных действий, выбор уже записан тем же create.
        if (input.decision !== 'create') return { status: 'not_asked' };
        return {
          status: 'already_created',
          requestId: offer.requestId,
          cards: offer.cards.map((card) => ({ ...card, created: false, fromWeb: [] })),
          choiceRecorded: true,
        };
      }
      if (offer.status === 'declined') return { status: 'not_asked' };
      deps.log?.('supplier_card_offer_decision', { decision: input.decision });
      if (input.decision === 'unclear') {
        await write({ ...offer, unclear: offer.unclear + 1 });
        // Один повтор вопроса: если ответ неясен снова, сотрудника больше не донимаем.
        const repeat = offer.unclear === 0;
        return {
          status: 'unclear',
          requestId: offer.requestId,
          repeatQuestion: repeat,
          ...(repeat ? { question: cardOfferQuestion(offer.items) } : {}),
        };
      }
      if (input.decision === 'decline') {
        await write({ ...offer, status: 'declined' });
        const open = await loadOpenChoiceAsks(deps.state, context.threadId);
        return {
          status: 'declined',
          requestId: offer.requestId,
          choiceStillOpen: open.some((ask) => ask.requestId === offer.requestId),
        };
      }
      // Право проверяется до чтения сайтов и записи: непроверенная карточка попадает в общую
      // базу, как и при подтверждении карточки. Сбой справочника не отказ: предложение остаётся
      // открытым и повтор после восстановления пройдёт.
      const verdict = await cardCreateVerdict(deps, userId, context.agentId);
      if (verdict === 'unavailable') {
        return {
          status: 'unavailable',
          requestId: offer.requestId,
          message: CONFIRM_CARD_UNAVAILABLE_TEXT,
        };
      }
      if (verdict === 'denied') {
        return {
          status: 'no_permission',
          requestId: offer.requestId,
          message: CONFIRM_CARD_DENIED_TEXT,
        };
      }
      const cards = await createCards(deps, offer, userId, context);
      const choiceRecorded = await addConfirmedSuppliers(deps.state, deps.clock, {
        requestId: offer.requestId,
        threadId: context.threadId,
        userId,
        supplierIds: cards.map((card) => card.supplierId),
      });
      await write({
        ...offer,
        status: 'created',
        cards: cards.map(({ supplierId, name }) => ({ supplierId, name })),
      });
      return { status: 'created', requestId: offer.requestId, cards, choiceRecorded };
    },
  },
);
