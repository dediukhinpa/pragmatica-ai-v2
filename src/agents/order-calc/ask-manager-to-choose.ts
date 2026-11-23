import { z } from 'zod';
import { DomainError } from '@business-ai/core';
import { findMissingFields } from '../../kit/domain/request-forms';
import { type ShortlistProposal, type SourceStatus } from '../../kit/domain/shortlist';
import type { ChatBlock, ChatMessage } from '@business-ai/core';
import { defineTool } from '@business-ai/core';
import { predecessorOf, recordWorkOwner } from '@business-ai/core';
import { workSubject } from '../shared/work-owner.owned';
import { assertEmployeeChatTurn } from '@business-ai/core';
import type { OrderCalcDeps } from './deps';
import { assertOrderOwner } from './order-access';
import {
  loadChoiceConfirmation,
  loadOpenChoiceAsks,
  noteUnclearChoiceAnswer,
  recordChoicePicks,
  saveChoiceAsk,
  type OutsidePickMatch,
} from './choice-confirmation';
import { findCard } from './named-suppliers';
import {
  CARD_CREATE_DENIED_NOTE,
  cardCreateVerdict,
  lookupNameOfPick,
  registerCardOffer,
} from './supplier-card-offer';
import { requestLabel } from './request-title';
import {
  entryCardBlocks,
  entryLines,
  missingReminderLine,
  shortlistHeaderLines,
  shortlistTitleLines,
  sourceLabel,
} from './shortlist-message';
import { sendShortlistXlsx } from './shortlist-xlsx';
import { markPhotoHintShown, photoHintLine } from './photo-hint';
import { loadCompleteness, loadProposal } from './state';

interface AskInput {
  requestId: string;
  version: string;
}

/** Причина недоступности веба при исчерпанной квоте Яндекса (задаётся search-sources). */
const WEB_QUOTA_REASON = 'quota_exhausted';
/** Одна строка для сотрудника, когда веб-поиск закончил лимит: остальная работа идёт без него. */
export const WEB_SEARCH_QUOTA_NOTE =
  'Поиск в интернете временно недоступен (исчерпан лимит), использую только базу.';

function unavailableNote(sources: readonly SourceStatus[]): string[] {
  const lines = sources
    .filter((item) => item.status !== 'ok')
    .map((item) => {
      // Квота вместо общего «недоступен»: одна понятная строка, без дубля про тот же источник.
      if (item.status === 'unavailable' && item.reason === WEB_QUOTA_REASON) {
        return WEB_SEARCH_QUOTA_NOTE;
      }
      // Единая подпись источника, как в строках шорт-листа (там «веб» - «ИЗ ИНТЕРНЕТА»).
      const label = sourceLabel(item.source);
      return item.status === 'unavailable'
        ? `Источник «${label}» недоступен.`
        : `Источник «${label}» не проверялся.`;
    });
  // Строка про квоту ровно одна на ответ, даже если источников с такой причиной несколько.
  return lines.filter((line, index) => lines.indexOf(line) === index);
}

/** Призыв выбрать поставщиков: один раз внизу и текста, и карточек. */
const CHOICE_PROMPT =
  '[B]Кому готовить запросы?[/B] Можно ответить своими словами, например: ' +
  '«берём 1 и 3», «возьми Ромашку».';
/** Короткий повтор вопроса при неясном ответе (один раз, этап 164). */
const CHOICE_REPEAT_QUESTION =
  'Кому готовить запросы? Назовите поставщиков из списка (номером или названием) ' +
  'или скажите, что пока не нужно.';
/** Что сказать сотруднику, когда он отложил выбор: заказ остаётся открытым. */
const CHOICE_DECLINED_NOTE =
  'Выбор отложен, заказ остаётся открытым: когда определитесь, назовите поставщиков из списка.';
/** Разделитель между шапкой и списком поставщиков в текстовом откате. */
const CARDS_SEPARATOR = '──── карточки поставщиков ────';

/**
 * Сообщение менеджеру: шапка (заголовок, название заявки, две средние, сколько
 * сравнено), нумерованный список и один призыв ответить текстом (кнопок нет, решение владельца
 * 26.10.2026) либо вопрос, если выдача пуста. `text` - полный текстовый откат; при `attach`
 * к нему добавлены карточки поставщиков (`blocks`), а шапка идёт обычным текстом над ними
 * (`blocksLead`). `missing` - чего не хватает в заявке: из него код сам собирает строку
 * «можно добавить» над призывом (функция остаётся чистой, загрузка - в `askManagerToChoose`).
 */
export function buildChoiceMessage(
  proposal: ShortlistProposal,
  attach = true,
  label?: string,
  missing: readonly { label: string }[] = [],
  photoHint?: string,
): ChatMessage {
  return buildChoiceParts(proposal, attach, label, missing, photoHint).full;
}

/** Части итоговой выдачи: карточки, закрывающий абзац и полный текст (для откатов и тестов). */
interface ChoiceParts {
  /** Шапка и карточки; без напоминания и вопроса. */
  cards: ChatMessage;
  /** Примечания, напоминание и вопрос выбора: отдельное обычное сообщение чата. */
  closing?: string | undefined;
  /** Всё одним текстом. */
  full: ChatMessage;
}

function buildChoiceParts(
  proposal: ShortlistProposal,
  attach: boolean,
  label: string | undefined,
  missing: readonly { label: string }[],
  photoHint?: string,
): ChoiceParts {
  const notes = unavailableNote(proposal.sources);
  if (proposal.entries.length === 0) {
    const empty: ChatMessage = {
      text: [
        ...shortlistTitleLines(label),
        'Подходящих поставщиков не нашлось.',
        ...notes,
        'Уточните запрос (другие названия или артикулы) или пришлите поставщиков для запроса.',
      ].join('\n'),
    };
    return { cards: empty, full: empty };
  }
  const header = shortlistHeaderLines(proposal, label);
  const lines = proposal.entries.flatMap(entryLines);
  const reminder = missingReminderLine(missing);
  // Напоминание и вопрос - отдельным абзацем чата: внутри вложения портал рисует их как часть
  // таблицы последней карточки, и главный вопрос сотрудника терялся (этап 171).
  // Фраза о непрочитанных фото - отдельной строкой между напоминанием и вопросом (этап 189).
  const closing = [
    ...notes,
    ...(reminder === undefined ? [] : [reminder]),
    ...(photoHint === undefined ? [] : [photoHint]),
    CHOICE_PROMPT,
  ].join('\n\n');
  const cardsText = [...header, CARDS_SEPARATOR, ...lines].join('\n');
  const full: ChatMessage = { text: `${cardsText}\n\n${closing}` };
  if (!attach) return { cards: { text: cardsText }, closing, full };
  const blocks: ChatBlock[] = proposal.entries.flatMap((entry, index): ChatBlock[] => [
    ...entryCardBlocks(entry, index),
    { kind: 'delimiter' },
  ]);
  const cards: ChatMessage = { text: cardsText, blocks, blocksLead: header.join('\n') };
  return { cards, closing, full: { ...full, blocks, blocksLead: cards.blocksLead } };
}

/**
 * Спросить менеджера по закупу, кого выбрать из шорт-листа. Ход не приостанавливается: модель
 * заканчивает ход, а ответ сотрудника («берём первого и третьего») записывает
 * `recordManagerChoice`.
 */
export const askManagerToChoose = defineTool<AskInput, { asked: boolean }, OrderCalcDeps>({
  name: 'askManagerToChoose',
  description:
    'Показать менеджеру по закупу нумерованный шорт-лист и спросить текстом, кому готовить ' +
    'запросы (при пустом списке — вопрос, что уточнить). asked: вопрос отправлен — закончи ' +
    'ход и дождись ответа менеджера, затем вызови recordManagerChoice. Передай requestId и ' +
    'version из buildShortlist.',
  sideEffect: true,
  // Шорт-лист, вопрос выбора и закрывающее сообщение отправляет код: у сообщения один автор,
  // шаг модели с итогом после этого вызова не нужен (этап 179).
  endsTurn: true,
  endsTurnWhen: (output) => output.asked,
  inputSchema: z.object({ requestId: z.string().min(1), version: z.string().min(1) }),
  outputSchema: z.object({ asked: z.boolean() }),
  idempotencyKey: (input) => askKey(input),
  async execute(input, deps, context) {
    const proposal = await loadProposal(deps, input.requestId);
    if (proposal === null) {
      throw new DomainError('not_found', `Шорт-лист заявки ${input.requestId} не собран.`);
    }
    if (proposal.version !== input.version) {
      throw new DomainError(
        'conflict',
        'Шорт-лист пересобран после этого вызова: возьмите актуальный version из buildShortlist.',
      );
    }
    // Менеджер, которого спросили в чате, ведёт заявку (первый владелец сохраняется).
    await recordWorkOwner(deps.state, workSubject.order(input.requestId), context);
    // Вопрос запоминаем кодом до отправки: по нему ответ сотрудника сопоставляется с этим
    // шорт-листом (номера и названия), а выбор вне списка не записать.
    await saveChoiceAsk(deps.state, deps.clock, context.threadId, proposal);
    // Фраза о фото, которые не прочитались, - один раз на заявку; повторный показ её не несёт.
    const photoHint = await photoHintLine(deps.state, context.threadId, input.requestId);
    const parts = buildChoiceParts(
      proposal,
      deps.shortlistAttachEnabled !== false,
      await requestLabel(deps, input.requestId),
      await missingOfRequest(deps, input.requestId),
      photoHint,
    );
    await deps.chat.reply(context.threadId, parts.cards, askKey(input));
    // Что увидел сотрудник, то и пишется в историю хода (рантайм не делает шага модели).
    context.noteShown?.(parts.cards.text);
    // Свой ключ повторной отправки: повтор шага не задваивает вопрос.
    if (parts.closing !== undefined) {
      await deps.chat.reply(context.threadId, { text: parts.closing }, closingKey(input));
      context.noteShown?.(parts.closing);
      // Отмечаем после отправки: сбой отправки не «съедает» фразу, повтор шага её покажет.
      if (photoHint !== undefined) await markPhotoHintShown(deps.state, input.requestId);
    }
    // Файл Excel - дополнение к шорт-листу: его сбой ход не роняет (ловится и пишется в журнал).
    await sendShortlistXlsx(deps, context.threadId, proposal, askKey(input));
    return { asked: true };
  },
});

/**
 * Чего не хватает в заявке по сохранённой проверке полноты. Проверку не вызывали - пусто
 * (напоминать не о чем); сбой чтения шорт-лист не роняет.
 */
async function missingOfRequest(
  deps: OrderCalcDeps,
  requestId: string,
): Promise<readonly { label: string }[]> {
  const stored = await loadCompleteness(deps, requestId).catch(() => null);
  if (stored === null) return [];
  return findMissingFields(stored.kind, stored.values, stored.deferred);
}

function closingKey(input: AskInput): string {
  return `order-ask-closing:${input.requestId}:${input.version}`;
}

function askKey(input: AskInput): string {
  return `order-ask:${input.requestId}:${input.version}`;
}

/** Решение сотрудника по вопросу «кому готовить запросы» (смысл ответа читает модель). */
const CHOICE_DECISIONS = ['picked', 'decline', 'unclear'] as const;
type ChoiceDecision = (typeof CHOICE_DECISIONS)[number];

interface ChoiceInput {
  requestId: string;
  decision: ChoiceDecision;
  /** Только для picked: поставщики, названные сотрудником. */
  picks?: string[] | undefined;
  /** Ссылка на сайт единственного названного поставщика без карточки (если дана в сообщении). */
  siteUrl?: string | undefined;
}
const PICK_STATUSES = [
  'recorded',
  'already_recorded',
  'not_asked',
  'unmatched',
  'ambiguous',
  'inactive',
  'card_missing',
  'declined',
  'unclear',
] as const;
interface ChoiceOutput {
  status: (typeof PICK_STATUSES)[number];
  /** Названия выбранных поставщиков (recorded, already_recorded). */
  chosen?: string[] | undefined;
  /** Пункты ответа, которых нет ни в шорт-листе, ни в базе поставщиков. */
  unmatched?: string[] | undefined;
  /** Пункты, которым подходят несколько карточек базы: сотруднику нужно выбрать одну. */
  ambiguous?: Array<{ pick: string; candidates: string[] }> | undefined;
  /** Пункты, чья карточка в базе не действует (статус «не действующий»). */
  inactive?: string[] | undefined;
  /** card_missing: названия без карточки в базе (о них задан вопрос про создание). */
  missing?: string[] | undefined;
  /** card_missing: готовый вопрос сотруднику - его одним сообщением вместе с письмом. */
  question?: string | undefined;
  /** unclear: повторить вопрос (один раз) готовым текстом question. */
  repeatQuestion?: boolean | undefined;
  /** declined: что сказать сотруднику (выбор отложен, заказ открыт). */
  note?: string | undefined;
  /** Что принято не полностью (например, пунктов больше предела): включи в итог. */
  warnings?: string[] | undefined;
}

/**
 * Назван не из шорт-листа поставщик: ищем его в базе кодом. Одна подходящая действующая
 * карточка - берём (письмо готовится для неё); несколько - не угадываем; нет - переспрашиваем.
 */
async function resolveOutsideShortlist(
  deps: OrderCalcDeps,
  pick: string,
): Promise<OutsidePickMatch> {
  // Ссылка на сайт («https://66print.ru/...») ищется по имени домена, как поставщик.
  const match = await findCard(deps, lookupNameOfPick(pick));
  if (match.kind === 'none') return { kind: 'none' };
  if (match.kind === 'ambiguous') {
    return { kind: 'ambiguous', candidates: match.cards.map((card) => card.name) };
  }
  const { card } = match;
  // Не действующий поставщик исключён и из шорт-листа: письмо ему сами не готовим.
  if (card.status === 'inactive') return { kind: 'inactive', name: card.name };
  return { kind: 'card', supplierId: card.id, name: card.name };
}

/**
 * Защитный предел перечня пунктов (этап 177): схема инструмента его больше не проверяет.
 * Больше пунктов, чем размер шорт-листа с запасом, - не выбор менеджера, а сбой вызова:
 * берём первые и называем это в предупреждении, а не отказываем.
 */
const MAX_PICKS = 100;

/**
 * Отказ или неясный ответ: в состоянии выбора ничего не пишется (заказ остаётся открытым).
 * Нет открытого вопроса по заявке - not_asked. Неясный ответ считается, повтор вопроса - один.
 */
async function noPickDecision(
  deps: OrderCalcDeps,
  requestId: string,
  threadId: string,
  decision: 'decline' | 'unclear',
): Promise<ChoiceOutput> {
  const open = await loadOpenChoiceAsks(deps.state, threadId);
  if (!open.some((ask) => ask.requestId === requestId)) return { status: 'not_asked' };
  if (decision === 'decline') return { status: 'declined', note: CHOICE_DECLINED_NOTE };
  const before = await noteUnclearChoiceAnswer(deps.state, threadId, requestId);
  const repeat = before === 0;
  return {
    status: 'unclear',
    repeatQuestion: repeat,
    ...(repeat ? { question: CHOICE_REPEAT_QUESTION } : {}),
  };
}

/**
 * Записать выбор менеджера по его ответу в чате: номера из списка или названия. Пишет то же
 * подтверждение, что кнопки с «Готово», только в ходе сотрудника в чате (не плановый запуск,
 * не передача, не вызов другим агентом). Поставщик, названный
 * не из шорт-листа, ищется в базе: один найденный записывается, неизвестный или неоднозначный
 * не угадывается - сотрудника переспрашивают.
 */
export const recordManagerChoice = defineTool<ChoiceInput, ChoiceOutput, OrderCalcDeps>({
  name: 'recordManagerChoice',
  description:
    'Записать ответ менеджера на вопрос askManagerToChoose «кому готовить запросы». Ответ ' +
    'свободный: прочитай смысл сам. decision: picked - менеджер назвал поставщиков (номерами, ' +
    'названиями, «берём первого и третьего», «возьми Ромашку», «ок, давай 1»); тогда picks — ' +
    'номера из списка («1», «3») или названия ровно так, как их назвал менеджер. decline - ' +
    'явно отложил или отказался («не надо», «нет», «пока не нужно», «пока нет»): ничего не ' +
    'пишется. unclear - ответ неоднозначен или не про этот вопрос («ок», «да» без названных ' +
    'поставщиков, «а какой у них срок?»): ничего не пишется, не выбирай поставщика сам. ' +
    'Поставщика не из списка, но названного менеджером (есть в базе), код найдёт сам: ' +
    'передай его название в picks, шорт-лист заново не собирай. recorded: выбор записан — ' +
    'вызови recordSelection. declined: выбор отложен, заказ остаётся открытым; скажи это ' +
    '(note), шорт-лист не присылай. unclear: ответь по существу и при repeatQuestion=true один ' +
    'раз коротко повтори question дословно, иначе не переспрашивай. unmatched: часть ответа ' +
    'не найдена ни в списке, ни в базе — переспроси менеджера. ambiguous: названию подходят ' +
    'несколько карточек (candidates) — спроси, какая нужна, не выбирай сам. inactive: ' +
    'поставщик не действует — скажи об этом. card_missing: названного поставщика нет ни в ' +
    'списке, ни в базе (missing); chosen — найденные, они уже записаны. Если есть chosen, ' +
    'сразу recordSelection и prepareSupplierRequestText для них; в ОДНОМ сообщении ' +
    'сотруднику: письмо (если готовилось) и вопрос question дословно, без шорт-листа и ' +
    'других вопросов; затем ждёшь ответ и вызываешь recordSupplierCardDecision. Если question ' +
    'нет, а есть note, вопрос про создание не задавай (карточку в общей базе заводит только ' +
    'руководитель отдела): скажи note, письмо для chosen подготовь как обычно. Если в ' +
    'сообщении сотрудника есть ссылка на сайт одного такого поставщика, передай её в siteUrl. ' +
    'not_asked: вопроса по заявке в этом чате нет — сначала askManagerToChoose.',
  sideEffect: true,
  inputSchema: z.object({
    requestId: z.string().min(1),
    decision: z.enum(CHOICE_DECISIONS),
    picks: z.array(z.string().min(1)).min(1).optional(),
    siteUrl: z.string().min(1).optional(),
  }),
  outputSchema: z.object({
    status: z.enum(PICK_STATUSES),
    chosen: z.array(z.string()).optional(),
    unmatched: z.array(z.string()).optional(),
    ambiguous: z.array(z.object({ pick: z.string(), candidates: z.array(z.string()) })).optional(),
    inactive: z.array(z.string()).optional(),
    missing: z.array(z.string()).optional(),
    question: z.string().optional(),
    repeatQuestion: z.boolean().optional(),
    note: z.string().optional(),
    warnings: z.array(z.string()).optional(),
  }),
  idempotencyKey: (input) =>
    `order-choice:${input.requestId}:${input.decision}:${(input.picks ?? []).join('|')}`,
  // Тред и записанный выбор: смена решения A -> B -> A записывается заново.
  idempotencyPredecessor: async (input, deps, threadId) => {
    const known = await loadChoiceConfirmation(deps.state, input.requestId);
    // Счётчик неясных ответов: второй unclear - новая операция, а не кэшированный итог.
    const ask = (await loadOpenChoiceAsks(deps.state, threadId)).find(
      (item) => item.requestId === input.requestId,
    );
    return predecessorOf({
      threadId,
      confirmed: known === null ? null : [...known.supplierIds].sort(),
      version: known?.version ?? null,
      unclear: ask?.unclear ?? null,
    });
  },
  async execute(input, deps, context) {
    const userId = assertEmployeeChatTurn(context);
    await assertOrderOwner(deps, input.requestId, context);
    if (input.decision !== 'picked') {
      return noPickDecision(deps, input.requestId, context.threadId, input.decision);
    }
    if (input.picks === undefined) {
      throw new DomainError(
        'invalid_input',
        'decision=picked требует picks. Если менеджер никого не назвал, вызови decision=unclear.',
      );
    }
    const picks = input.picks.slice(0, MAX_PICKS);
    const warnings =
      picks.length < input.picks.length
        ? [`учтены первые ${picks.length} пунктов выбора из ${input.picks.length}`]
        : [];
    const outcome = await recordChoicePicks(deps.state, deps.clock, {
      requestId: input.requestId,
      picks,
      userId,
      threadId: context.threadId,
      resolveOutside: (pick) => resolveOutsideShortlist(deps, pick),
    });
    switch (outcome.kind) {
      case 'recorded':
      case 'already_recorded':
        return {
          status: outcome.kind,
          chosen: outcome.names,
          ...(warnings.length === 0 ? {} : { warnings }),
        };
      case 'unmatched': {
        // Неоднозначное важнее неизвестного: сотруднику сначала нужно выбрать из кандидатов.
        const status =
          outcome.ambiguous.length > 0
            ? 'ambiguous'
            : outcome.inactive.length > 0
              ? 'inactive'
              : 'unmatched';
        return {
          status,
          ...(outcome.picks.length > 0 ? { unmatched: outcome.picks } : {}),
          ...(outcome.ambiguous.length > 0 ? { ambiguous: outcome.ambiguous } : {}),
          ...(outcome.inactive.length > 0 ? { inactive: outcome.inactive } : {}),
        };
      }
      case 'card_missing': {
        // Вопрос про карточку задаёт модель (письмо и вопрос одним сообщением): её текст нужен,
        // поэтому показ письма кодом ход не заканчивает.
        context.holdTurn?.();
        // Не руководитель карточку в общей базе завести не вправе: вопрос «создать?» ему не
        // задаётся (ответ «да» всё равно закончился бы отказом). Найденные поставщики уже
        // записаны, письмо для них готовится как обычно. Сбой справочника (право неизвестно)
        // вопроса не отменяет: решение перепроверяется при ответе.
        if ((await cardCreateVerdict(deps, userId, context.agentId)) === 'denied') {
          return {
            status: 'card_missing',
            ...(outcome.names.length > 0 ? { chosen: outcome.names } : {}),
            missing: outcome.missing.map(lookupNameOfPick),
            note: CARD_CREATE_DENIED_NOTE,
          };
        }
        // Карточки нет: запоминаем предложение, вопрос отдаём модели готовым текстом. Найденные
        // поставщики уже записаны, письмо для них не блокируется.
        const offer = await registerCardOffer(deps, {
          requestId: input.requestId,
          threadId: context.threadId,
          picks: outcome.missing,
          siteUrl: input.siteUrl,
        });
        return {
          status: 'card_missing',
          ...(outcome.names.length > 0 ? { chosen: outcome.names } : {}),
          missing: offer.items.map((item) => item.name),
          question: offer.question,
        };
      }
      case 'no_open_ask':
      case 'no_identity':
        return { status: 'not_asked' };
    }
  },
});
