import { DomainError } from '@business-ai/core';
import {
  compareQuotes,
  describeQuoteGap,
  type IncomparableReason,
  type ComparisonSupplier,
  type QuoteComparison,
} from '../../kit/domain/quotes';
import { type SupplierQuote } from '../../kit/domain/models';
import type { ChatMessage, TableCell, TableSheet } from '@business-ai/core';
import { stableHash } from '@business-ai/core';
import { SUMMARY_MAX_FLAGS, type OrderCalcDeps } from './deps';
import { CHANNEL_NAMES } from './order-progress';
import { UNVERIFIED_SENDER_NOTE } from './reply-routing';
import { loadReplies, type ReplyChannel } from './reply-store';
import { loadSelection } from './state';
import { DEFAULT_REQUEST_LABEL } from './shortlist-message';

/** Загруженные данные для сравнения и отпечаток набора КП. */
export interface LoadedComparison {
  comparison: QuoteComparison;
  quotes: SupplierQuote[];
  suppliers: ComparisonSupplier[];
  /** Отпечаток набора: КП и список неответивших. Меняется, когда пришло или поменялось КП. */
  quotesHash: string;
  /** Поставщики, чьё КП взято из письма с неподтверждённым отправителем. */
  unverifiedSupplierIds: string[];
  /**
   * Поставщики без КП, но с ответом в любом канале (почта, телефон, мессенджер): «не ответили»
   * про них говорить нельзя.
   */
  answeredWithoutQuote: AnsweredWithoutQuote[];
}

/** Поставщик, который ответил (в каком-то канале), но КП по нему ещё не записано. */
export interface AnsweredWithoutQuote {
  supplierId: string;
  channels: ReplyChannel[];
  declined: boolean;
  /** Ответы поставщика (отказ, «нет в наличии», без цены): новый ответ меняет отпечаток набора. */
  replyIds: string[];
}

/** Устойчивый вид ответов без КП для отпечатка: порядок поставщиков и ответов не важен. */
function answeredWithoutQuoteFingerprint(
  items: readonly AnsweredWithoutQuote[],
): Array<[string, boolean, string[]]> {
  return items
    .map((item): [string, boolean, string[]] => [
      item.supplierId,
      item.declined,
      [...item.replyIds].sort(),
    ])
    .sort((a, b) => a[0].localeCompare(b[0]));
}

/** Собрать сравнение по сохранённым КП выбранных поставщиков заявки. */
export async function loadComparison(
  deps: OrderCalcDeps,
  requestId: string,
): Promise<LoadedComparison> {
  const request = await deps.requests.get(requestId);
  if (request === null) throw new DomainError('not_found', `Заявка ${requestId} не найдена.`);
  const selection = await loadSelection(deps, requestId);
  if (selection === null) {
    throw new DomainError('not_found', 'Менеджер ещё не выбрал поставщиков по заявке.');
  }
  const suppliers: ComparisonSupplier[] = [];
  for (const id of selection.supplierIds) {
    suppliers.push({ id, name: (await deps.suppliers.get(id))?.name ?? id });
  }
  const quotes = (await deps.quotes.listByRequest(requestId)).filter((quote) =>
    selection.supplierIds.includes(quote.supplierId),
  );
  const comparison = compareQuotes({ request, suppliers, quotes, now: deps.clock.now() });
  const content = quotes.map(({ receivedAt: _received, ...rest }) => rest);
  const replies = await loadReplies(deps.state, requestId);
  const unverifiedSupplierIds = quotes
    .filter((quote) =>
      replies.some((reply) => reply.id === quote.sourceRef && reply.senderUnverified === true),
    )
    .map((quote) => quote.supplierId);
  const answeredWithoutQuote: AnsweredWithoutQuote[] = [];
  for (const supplierId of comparison.notRepliedSupplierIds) {
    // Письмо с неподтверждённым отправителем ответом поставщика не считается.
    const own = replies.filter(
      (reply) =>
        reply.supplierId === supplierId &&
        !(reply.channel === 'email' && reply.senderUnverified === true),
    );
    if (own.length === 0) continue;
    answeredWithoutQuote.push({
      supplierId,
      channels: [...new Set(own.map((reply) => reply.channel))],
      declined: own.some((reply) => reply.declined === true),
      replyIds: own.map((reply) => reply.id),
    });
  }
  // Ответы без КП входят в отпечаток только когда они есть (прежние отпечатки не меняются):
  // отказ поставщика без цены даёт свежую сводку, иначе её не переслали бы, а менеджер видел бы
  // устаревшее «не ответил».
  const quotesHash = stableHash({
    content,
    notReplied: comparison.notRepliedSupplierIds,
    ...(answeredWithoutQuote.length === 0
      ? {}
      : { answeredWithoutQuote: answeredWithoutQuoteFingerprint(answeredWithoutQuote) }),
  });
  return {
    comparison,
    quotes,
    suppliers,
    quotesHash,
    unverifiedSupplierIds,
    answeredWithoutQuote,
  };
}

const REASON_TEXT: Record<IncomparableReason, string> = {
  // Слова про НДС в сводке не пишем (решение владельца 09.11), отсылки к шорт-листу тоже нет:
  // там НДС прайса, а не этого КП.
  vat_mixed: 'условия цены различаются',
  pack_size: 'количество не кратно фасовке',
  min_order: 'минимальная партия больше запрошенного',
};

const fmt = (value: number | undefined): string => (value === undefined ? '—' : String(value));

function namesOf(comparison: QuoteComparison, ids: readonly string[]): string {
  const names = ids.map((id) => comparison.suppliers.find((s) => s.supplierId === id)?.name ?? id);
  return names.join(', ');
}

/** Текст сводки менеджеру: кто ответил, кто нет, минимумы, предупреждения. Без рекомендаций. */
export function buildQuoteSummaryText(
  comparison: QuoteComparison,
  unverifiedSupplierIds: readonly string[] = [],
  answeredWithoutQuote: readonly AnsweredWithoutQuote[] = [],
  label = DEFAULT_REQUEST_LABEL,
): ChatMessage {
  const answered = comparison.suppliers.filter((s) => s.replied);
  const lines: string[] = [
    `Заявка «${label}»: сводка по КП поставщиков. Выбор поставщика за вами.`,
    `Ответили (${answered.length} из ${comparison.suppliers.length}): ` +
      `${answered.map((s) => s.name).join(', ') || 'никто'}.`,
  ];
  // Ответ мог прийти по телефону или в мессенджере: такие поставщики не «не ответили».
  const answeredIds = new Set(answeredWithoutQuote.map((item) => item.supplierId));
  const silentIds = comparison.notRepliedSupplierIds.filter((id) => !answeredIds.has(id));
  if (silentIds.length > 0) lines.push(`Не ответили: ${namesOf(comparison, silentIds)}.`);
  const declinedIds = answeredWithoutQuote.filter((item) => item.declined).map((i) => i.supplierId);
  if (declinedIds.length > 0) {
    lines.push(`Отказались давать КП: ${namesOf(comparison, declinedIds)}.`);
  }
  const noQuote = answeredWithoutQuote.filter((item) => !item.declined);
  if (noQuote.length > 0) {
    const described = noQuote.map(
      (item) =>
        `${namesOf(comparison, [item.supplierId])} (${item.channels
          .map((channel) => CHANNEL_NAMES[channel])
          .join(', ')})`,
    );
    lines.push(`Ответили, но КП ещё не записано: ${described.join(', ')}.`);
  }
  const incomparableRows = comparison.rows.filter((row) => row.incomparable === true);
  const rows = comparison.rows.filter((row) => row.minUnitPrice !== undefined);
  if (incomparableRows.length > 0) {
    lines.push(
      'НЕСОПОСТАВИМО: минимум не назван по позициям ' +
        `${incomparableRows.map((row) => `«${row.itemName}»`).join(', ')} ` +
        '(условия цены, фасовка или минимальная партия различаются, см. предупреждения).',
    );
  }
  if (rows.length > 0) {
    lines.push(`Минимальные цены за единицу (${comparison.baseCurrency}):`);
    for (const row of rows) {
      lines.push(
        `- ${row.itemName}: ${fmt(row.minUnitPrice)} ` +
          `(${namesOf(comparison, row.minSupplierIds)}), максимум ${fmt(row.maxUnitPrice)}`,
      );
    }
  }
  const totals = answered.filter((s) => s.orderTotal !== undefined);
  if (totals.length > 0) {
    lines.push('Итог по заказу у каждого:');
    for (const s of totals) {
      lines.push(
        `- ${s.name}: ${fmt(s.orderTotal)} ${s.currency} ` +
          `(цена по ${s.pricedItems} из ${s.totalItems} поз.)` +
          (s.unitMismatchItems > 0
            ? `; НЕСОПОСТАВИМО: по ${s.unitMismatchItems} поз. цена в другой единице ` +
              'и в итог не входит'
            : '') +
          (s.incomparableReasons.length > 0
            ? `; НЕСОПОСТАВИМО: ${s.incomparableReasons.map((r) => REASON_TEXT[r]).join(', ')}`
            : ''),
      );
    }
  }
  if (unverifiedSupplierIds.length > 0) {
    lines.push(
      `${UNVERIFIED_SENDER_NOTE} КП получено от: ` +
        `${namesOf(comparison, unverifiedSupplierIds)}. Проверьте цены у поставщика.`,
    );
  }
  // «Ответа на запрос нет» про ответившего (телефон, мессенджер, письмо без КП) не пишем.
  const flags = comparison.flags.filter(
    (flag) =>
      !(
        flag.code === 'no_reply' &&
        flag.supplierId !== undefined &&
        answeredIds.has(flag.supplierId)
      ),
  );
  const shown = flags.slice(0, SUMMARY_MAX_FLAGS);
  if (shown.length > 0) {
    lines.push('Предупреждения:', ...shown.map((flag) => `- ${flag.message}`));
    const rest = flags.length - shown.length;
    if (rest > 0) lines.push(`- ещё ${rest} предупреждений в файле.`);
  }
  lines.push('Подробности: файл с листами «Сравнение», «Условия», «Не ответили».');
  return { text: lines.join('\n') };
}

/** Листы файла-сводки: «Сравнение», «Условия», «Не ответили». */
export function buildQuoteSheets(
  comparison: QuoteComparison,
  answeredWithoutQuote: readonly AnsweredWithoutQuote[] = [],
): TableSheet[] {
  const suppliers = comparison.suppliers;
  const compareColumns = [
    'Позиция',
    'Ед.',
    'Кол-во в заявке',
    ...suppliers.flatMap((s) => [`${s.name}: цена`, `${s.name}: сумма`, `${s.name}: срок, дн.`]),
    `Мин. цена (${comparison.baseCurrency})`,
    'Где минимум',
    `Макс. цена (${comparison.baseCurrency})`,
  ];
  const cellOf = (value: number | undefined): TableCell => value ?? null;
  const compareRows: TableCell[][] = comparison.rows.map((row) => [
    row.itemName,
    row.unit,
    row.requestQuantity ?? null,
    ...row.cells.flatMap((cell): TableCell[] => [
      cell.state === 'priced'
        ? cellOf(cell.unitPrice)
        : cell.state === 'no_price'
          ? 'нет цены'
          : 'нет ответа',
      cellOf(cell.lineTotal),
      cellOf(cell.deliveryDays),
    ]),
    row.incomparable === true ? 'несопоставимо' : cellOf(row.minUnitPrice),
    namesOf(comparison, row.minSupplierIds),
    row.incomparable === true ? 'несопоставимо' : cellOf(row.maxUnitPrice),
  ]);
  compareRows.push([
    'Итого по заказу',
    '',
    null,
    ...suppliers.flatMap((s): TableCell[] => [null, cellOf(s.orderTotal), null]),
    null,
    '',
    null,
  ]);
  const flagsOf = (id: string): string =>
    [
      ...comparison.flags.filter((f) => f.supplierId === id).map((f) => f.message),
    ].join('; ');
  const terms: TableCell[][] = suppliers
    .filter((s) => s.replied)
    .map((s) => [
      s.name,
      s.currency ?? null,
      cellOf(s.orderTotal),
      `${s.pricedItems} из ${s.totalItems}`,
      cellOf(s.deliveryDays),
      s.paymentTerms ?? null,
      s.validUntil ?? null,
      s.expired ? 'да' : 'нет',
      s.replacements.map((r) => r.productName).join('; '),
      s.notes ?? null,
      s.gaps.map(describeQuoteGap).join('; '),
      flagsOf(s.supplierId),
    ]);
  const answeredIds = new Set(answeredWithoutQuote.map((item) => item.supplierId));
  const silent: TableCell[][] = comparison.notRepliedSupplierIds
    .filter((id) => !answeredIds.has(id))
    .map((id) => [
    namesOf(comparison, [id]),
    id,
  ]);
  return [
    { name: 'Сравнение', columns: compareColumns, rows: compareRows },
    {
      name: 'Условия',
      columns: [
        'Поставщик',
        'Валюта',
        'Итог по заказу',
        'Позиций с ценой',
        'Срок поставки, дн.',
        'Условия оплаты',
        'Действует до',
        'Просрочено',
        'Замены',
        'Примечания',
        'Чего не хватает',
        'Предупреждения',
      ],
      rows: terms,
    },
    { name: 'Не ответили', columns: ['Поставщик', 'Код поставщика'], rows: silent },
  ];
}
