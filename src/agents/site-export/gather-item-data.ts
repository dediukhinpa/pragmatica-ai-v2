import { z } from 'zod';
import { DomainError, redactTextRisks } from '@business-ai/core';
import { PRICE_QUALIFIERS, type PriceItem } from '../../kit/domain/models';
import { formatPriceWithQualifier } from '../../kit/domain/market-price';
import { itemKeyOf, type ItemValue } from '../../kit/domain/item-data';
import type { InboxMessage, InboxSource } from '@business-ai/core';
import type { SupplierRepository } from '../../kit/ports/repositories.owned';
import { unconfirmedLookup } from '../prices/price-proposals';
import { defineTool, type ToolContext } from '@business-ai/core';
import {
  assertExternalQuery,
  externalQueryProblem,
  webSearchLimitReason,
  resolveDelegationInitiator,
  runAuditedWebSearch,
} from '@business-ai/core';
import { buildSupplierEmailIndex, suppliersByAddress } from '../shared/supplier-email-index';
import {
  GATHER_EXCERPT_CHARS,
  GATHER_INBOX_MAX_PAGES,
  GATHER_INBOX_PAGE_SIZE,
  GATHER_LIMIT,
  GATHER_MIN_WORD_LENGTH,
  GATHER_SUBJECT_MAX_CHARS,
  type SiteExportDeps,
} from './deps';
import { conflictSchema, loadConflicts, saveItemValues } from './item-notes';

interface GatherInput {
  exportId: string;
  query: string;
}

const outputSchema = z.object({
  exportId: z.string(),
  query: z.string(),
  items: z.array(z.object({ itemKey: z.string(), name: z.string(), sku: z.string().optional() })),
  prices: z.array(
    z.object({
      itemKey: z.string(),
      source: z.string(),
      supplierId: z.string(),
      /** Для «от»/диапазона - нижняя граница; признак ниже, молча точной ценой она не считается. */
      price: z.number(),
      priceQualifier: z.enum(PRICE_QUALIFIERS).optional(),
      priceMax: z.number().optional(),
      currency: z.string(),
      updatedAt: z.string(),
      /**
       * Справка: свежая неподтверждённая цена не с диска. В карточки сайта и расчёты не идёт.
       */
      unconfirmed: z.string().optional(),
    }),
  ),
  knowledge: z.array(z.object({ source: z.string(), documentId: z.string(), snippet: z.string() })),
  web: z.array(
    z.object({ source: z.string(), title: z.string(), url: z.string(), snippet: z.string() }),
  ),
  emails: z.array(
    z.object({
      source: z.string(),
      from: z.string(),
      subject: z.string(),
      excerpt: z.string(),
      attachmentNames: z.array(z.string()),
    }),
  ),
  /** Расхождения между источниками: помечены, не усреднены. */
  conflicts: z.array(conflictSchema),
  unavailableSources: z.array(z.object({ source: z.string(), reason: z.string() })),
});
type GatherOutput = z.infer<typeof outputSchema>;

/** Подпись источника для людей и для колонки «Источники». */
const sourceLabel = {
  price: (supplierId: string): string => `прайс ${supplierId}`,
  knowledge: (documentId: string): string => `база знаний ${documentId}`,
  web: (url: string): string => `сайт ${url}`,
  email: (messageId: string): string => `письмо ${messageId}`,
};

/**
 * Чтение ящика без отправки: тип ящика с `send` в прикладном слое называет только черновик
 * (архитектурный тест), поэтому здесь только нужные для чтения методы.
 */
type ReadableInbox = InboxSource & { getMessage(id: string): Promise<InboxMessage | null> };

/** Адрес из поля «от кого»: `Имя <a@b.ru>` и `a@b.ru` дают `a@b.ru` в нижнем регистре. */
function senderAddress(from: string): string {
  const angled = /<([^<>]+)>/.exec(from);
  return (angled?.[1] ?? from).trim().toLowerCase();
}

/** Поставщики позиции: те, у кого она есть в прайсе (письма берутся только от них). */
function priceSupplierIds(hits: readonly PriceItem[]): Set<string> {
  return new Set(hits.map((hit) => hit.supplierId));
}

/**
 * Почта, в которой ищутся письма: ящик сотрудника, чей ход идёт (письма другого сотрудника в
 * карточки не попадают). Плановый и неизвестный инициатор (нет сотрудника, чей ящик искать)
 * или выключенные ящики дают «почта не подключена», а не чужую почту.
 * @throws DomainError('not_configured') - у сотрудника ящик не подключён.
 */
async function searchableInbox(
  deps: SiteExportDeps,
  context: ToolContext,
): Promise<ReadableInbox | undefined> {
  if (deps.mailboxes === undefined) return undefined;
  const initiator = resolveDelegationInitiator(context.initiator);
  if (initiator.kind === 'ok' && initiator.userId !== undefined) {
    return deps.mailboxes.forEmployee(initiator.userId);
  }
  return undefined;
}

/**
 * Письма, где встречается слово запроса, только от известных поставщиков (R3-SEC-4: чужое
 * письмо не должно попасть в карточки); почта читается без пометки «обработано». Обход идёт в
 * режиме предпросмотра (тема и начало текста, без вложений): отправитель сверяется по
 * предпросмотру, и полное письмо (`getMessage`) скачивается только у письма поставщика с
 * позиции. Адрес сопоставляется с поставщиком тем же правилом, что и в остальных почтовых
 * модулях (`buildSupplierEmailIndex`: основной адрес и адреса контактов). Курсор локален
 * обходу (пустой курсор): общего сохранённого курсора у сбора данных нет, поэтому разные
 * сотрудники и другие сценарии не мешают друг другу. «С начала» - только для источников с
 * историей; ящик сотрудника (IMAP) читается с момента подключения (`readsHistory === false`),
 * об этом `gatherItemData` сообщает, если писем не нашлось (R6-01-07).
 *
 * Конец ящика - курсор не сдвинулся: страница, урезанная адаптером по байтам или по
 * `maxPerPass`, короче запрошенного размера, но это не конец (иначе обход обрывался бы).
 */
async function scanInbox(
  inbox: ReadableInbox,
  suppliers: SupplierRepository,
  supplierIds: ReadonlySet<string>,
  query: string,
): Promise<InboxMessage[]> {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length >= GATHER_MIN_WORD_LENGTH);
  const found: InboxMessage[] = [];
  let cursor = '';
  for (let page = 0; page < GATHER_INBOX_MAX_PAGES; page += 1) {
    const batch = await inbox.fetchNew(cursor, GATHER_INBOX_PAGE_SIZE, { preview: true });
    const index = await buildSupplierEmailIndex(
      suppliers,
      batch.messages.map((message) => senderAddress(message.from)),
    );
    for (const preview of batch.messages) {
      const fromSupplier = suppliersByAddress(index, senderAddress(preview.from)).some(
        (supplier) => supplierIds.has(supplier.id),
      );
      if (!fromSupplier) continue;
      // Тело в предпросмотре урезано: слово из хвоста письма видно только в полном чтении.
      const message = (await inbox.getMessage(preview.id)) ?? preview;
      const text = `${message.subject} ${message.body}`.toLowerCase();
      if (words.some((word) => text.includes(word))) found.push(message);
    }
    if (batch.nextCursor === cursor) break;
    cursor = batch.nextCursor;
  }
  return found;
}

/** Не критичный для сбора источник: недоступность фиксируем, а не роняем весь сбор. */
async function optional<T>(
  source: string,
  unavailable: Array<{ source: string; reason: string }>,
  task: () => Promise<T[]>,
): Promise<T[]> {
  try {
    return await task();
  } catch (error) {
    if (error instanceof DomainError) {
      // Исчерпанный лимит поиска - отдельная причина, без текста запроса.
      const reason = webSearchLimitReason(error) ?? error.code;
      unavailable.push({ source, reason });
      return [];
    }
    throw error;
  }
}

/**
 * Собрать данные по позиции из доступных источников: прайсы в базе, база знаний, веб-страницы
 * поставщиков, письма. У каждого значения указан источник. Одно поле с разными значениями в
 * разных источниках (цена, название) попадает в `conflicts` и не усредняется.
 */
export const gatherItemData = defineTool<GatherInput, GatherOutput, SiteExportDeps>({
  name: 'gatherItemData',
  description:
    'Собрать данные по позиции query (название или артикул) у поставщиков: прайсы в базе, ' +
    'база знаний, веб-страницы поставщиков, письма. Каждое значение с источником. Если ' +
    'источники расходятся (цена, название), это в conflicts: покажи расхождение сотруднику ' +
    'в ответе; запись в шаблон оно не блокирует (значение сотрудника главнее). ' +
    'Недоступные источники в unavailableSources. exportId - любая короткая метка задачи.',
  inputSchema: z.object({ exportId: z.string().min(1), query: z.string().min(1) }),
  outputSchema,
  async execute(input, deps, context) {
    // Запрос с ПДн, почтой, ссылкой или токеном не уходит никуда (R3-SEC-3).
    assertExternalQuery(input.query);
    const unavailable: Array<{ source: string; reason: string }> = [];
    const priceHits = await deps.prices.searchProducts(input.query, GATHER_LIMIT);
    const knowledge = await deps.knowledge.search(input.query, GATHER_LIMIT);
    // Во внешний веб-поиск уходит название позиции из базы, а не строка от модели.
    const webQuery = priceHits
      .map((hit) => hit.productName)
      .find((name) => externalQueryProblem(name) === null);
    const webHits = await optional('web', unavailable, async () => {
      if (deps.web === undefined) throw new DomainError('not_configured', 'веб-поиск не подключён');
      if (webQuery === undefined) {
        throw new DomainError('validation_failed', 'нет позиции в базе для безопасного запроса');
      }
      // Тот же лимитер и аудит платного поиска, что у searchInternet (без обхода порта).
      const outcome = await runAuditedWebSearch(deps, context, webQuery, { limit: GATHER_LIMIT });
      return outcome.hits;
    });
    let historyNotRead = false;
    const mails = await optional('email', unavailable, async () => {
      const inbox = await searchableInbox(deps, context);
      if (inbox === undefined) throw new DomainError('not_configured', 'почта не подключена');
      historyNotRead = inbox.readsHistory === false;
      if (deps.suppliers === undefined) {
        throw new DomainError('not_configured', 'справочник поставщиков не подключён');
      }
      return scanInbox(inbox, deps.suppliers, priceSupplierIds(priceHits), input.query);
    });
    // Ящик читается с момента подключения: «писем нет» без этой пометки читалось бы как «в
    // почте ничего не было», хотя прежняя переписка не просматривалась.
    if (mails.length === 0 && historyNotRead) {
      unavailable.push({ source: 'email_history', reason: 'history_not_read' });
    }
    const values: ItemValue[] = [];
    const items = new Map<string, { itemKey: string; name: string; sku?: string }>();
    const unconfirmedOf = unconfirmedLookup(deps.state);
    const notes = await Promise.all(priceHits.map(unconfirmedOf));
    const prices = priceHits.map((hit, index) => {
      const unconfirmed = notes[index];
      const itemKey = itemKeyOf(hit.sku, hit.productName);
      const source = sourceLabel.price(hit.supplierId);
      items.set(itemKey, {
        itemKey,
        name: hit.productName,
        ...(hit.sku === undefined ? {} : { sku: hit.sku }),
      });
      values.push(
        { itemKey, field: 'name', value: hit.productName, source },
        // Цена с признаком записывается текстом («от 500 RUB»): сверка источников не примет её
        // за точную 500 и покажет расхождение.
        {
          itemKey,
          field: 'price',
          value:
            hit.priceQualifier === undefined
              ? hit.price
              : formatPriceWithQualifier({
                  amount: hit.price,
                  currency: hit.currency,
                  qualifier: hit.priceQualifier,
                  max: hit.priceMax,
                }),
          source,
        },
        { itemKey, field: 'currency', value: hit.currency, source },
      );
      return {
        itemKey,
        source,
        supplierId: hit.supplierId,
        price: hit.price,
        ...(hit.priceQualifier === undefined ? {} : { priceQualifier: hit.priceQualifier }),
        ...(hit.priceMax === undefined ? {} : { priceMax: hit.priceMax }),
        currency: hit.currency,
        updatedAt: hit.date,
        ...(unconfirmed === undefined ? {} : { unconfirmed }),
      };
    });
    await saveItemValues(deps, input.exportId, values);
    const conflicts = await loadConflicts(deps, input.exportId, new Set(items.keys()));
    return {
      exportId: input.exportId,
      query: input.query,
      items: [...items.values()],
      prices,
      knowledge: knowledge.map((hit) => ({
        source: sourceLabel.knowledge(hit.documentId),
        documentId: hit.documentId,
        snippet: hit.snippet,
      })),
      web: webHits.map((hit) => ({
        ...hit,
        title: redactTextRisks(hit.title),
        snippet: redactTextRisks(hit.snippet),
        source: sourceLabel.web(hit.url),
      })),
      emails: mails.map((mail) => ({
        source: sourceLabel.email(mail.id),
        from: mail.from,
        // Тема режется до проверки: чужой текст не должен определять время работы regex.
        subject: redactTextRisks(mail.subject.slice(0, GATHER_SUBJECT_MAX_CHARS)),
        excerpt: redactTextRisks(mail.body.slice(0, GATHER_EXCERPT_CHARS)),
        attachmentNames: mail.attachments.map((file) => file.fileName),
      })),
      conflicts,
      unavailableSources: unavailable,
    };
  },
});
