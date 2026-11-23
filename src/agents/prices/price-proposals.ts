import { z } from 'zod';
import { PRICE_QUALIFIERS, type PriceItem, type PriceQualifier } from '../../kit/domain/models';
import { formatPriceBounds } from '../../kit/domain/market-price';
import type { WorkflowStateStore } from '@business-ai/core';
import { stateEntries } from '@business-ai/core';
import { readState, requirePort, toStoredJson } from '@business-ai/core';
import { PRICE_PROPOSAL_NAMESPACE, type PricesDeps } from './deps';
import type { PriceSourceKind } from './price-state';

/**
 * Неподтверждённые предложения цен (решение владельца 26.10.2026): сетевой диск - источник
 * правды, база цен хранит только данные с диска. Цены из чата, письма и со слов сотрудника
 * сохраняются здесь как предложение: сотрудник получает файл изменений и вносит их на диск,
 * другие агенты показывают их только справкой рядом с ценой с диска, в расчёты не берут.
 */

/** Не-дисковые источники: только они дают предложения. */
const PROPOSAL_SOURCES = ['intake', 'mail', 'employee'] as const;
export type ProposalSource = (typeof PROPOSAL_SOURCES)[number];

const proposalItemSchema = z.object({
  productName: z.string(),
  sku: z.string().optional(),
  price: z.number(),
  /** Цена «от»/диапазон: price - нижняя граница (старые записи без признака - точные). */
  priceQualifier: z.enum(PRICE_QUALIFIERS).optional(),
  priceMax: z.number().optional(),
  currency: z.string(),
});

export const priceProposalSchema = z.object({
  supplierId: z.string(),
  importId: z.string(),
  source: z.enum(PROPOSAL_SOURCES),
  /** Дата данных: дата письма или момент получения от сотрудника (ISO). */
  sourceDate: z.string(),
  /** Для письма: отправитель подтверждён SPF/DKIM/DMARC. */
  senderVerified: z.boolean().optional(),
  createdAt: z.string(),
  items: z.array(proposalItemSchema),
});
export type PriceProposal = z.infer<typeof priceProposalSchema>;

/** Записей за одно обращение к хранилищу при чтении предложений поставщика. */
const PROPOSAL_PAGE = 50;
/** Предел страниц на поставщика: предложений обычно единицы. */
const PROPOSAL_MAX_PAGES = 20;
/** Длина даты `YYYY-MM-DD` в ISO-строке. */
const ISO_DAY_LENGTH = 10;

const proposalPrefix = (supplierId: string): string => `${supplierId}:`;
const proposalKey = (supplierId: string, importId: string): string =>
  `${proposalPrefix(supplierId)}${importId}`;

/** Источник импорта даёт предложение, а не запись в базу. */
export function isProposalSource(source: PriceSourceKind): source is ProposalSource {
  return (PROPOSAL_SOURCES as readonly string[]).includes(source);
}

/** Данные предложения, кроме полей, которые задаёт код при записи. */
export interface ProposalInput {
  supplierId: string;
  importId: string;
  source: ProposalSource;
  sourceDate?: string | undefined;
  senderVerified?: boolean | undefined;
  items: readonly PriceItem[];
}

/** Сохранить (перезаписать) предложение по импорту. Возвращает число позиций. */
export async function savePriceProposal(deps: PricesDeps, input: ProposalInput): Promise<number> {
  const state = requirePort(deps.state, 'состояние сценариев');
  const now = deps.clock.now().toISOString();
  const proposal: PriceProposal = {
    supplierId: input.supplierId,
    importId: input.importId,
    source: input.source,
    sourceDate: input.sourceDate ?? now,
    ...(input.senderVerified === undefined ? {} : { senderVerified: input.senderVerified }),
    createdAt: now,
    items: input.items.map((item) => ({
      productName: item.productName,
      ...(item.sku === undefined ? {} : { sku: item.sku }),
      price: item.price,
      ...(item.priceQualifier === undefined ? {} : { priceQualifier: item.priceQualifier }),
      ...(item.priceMax === undefined ? {} : { priceMax: item.priceMax }),
      currency: item.currency,
    })),
  };
  await state.put(
    PRICE_PROPOSAL_NAMESPACE,
    proposalKey(input.supplierId, input.importId),
    toStoredJson(proposal),
  );
  return proposal.items.length;
}

/** Предложение по импорту; null, если его нет. */
export async function loadPriceProposal(
  state: WorkflowStateStore,
  supplierId: string,
  importId: string,
): Promise<PriceProposal | null> {
  return readState(
    state,
    PRICE_PROPOSAL_NAMESPACE,
    proposalKey(supplierId, importId),
    priceProposalSchema,
  );
}

/** Открытые предложения поставщика (повреждённые записи пропускаются). */
export async function listProposals(
  state: WorkflowStateStore,
  supplierId: string,
): Promise<PriceProposal[]> {
  const prefix = proposalPrefix(supplierId);
  const result: PriceProposal[] = [];
  const entries = stateEntries(state, PRICE_PROPOSAL_NAMESPACE, {
    pageSize: PROPOSAL_PAGE,
    maxPages: PROPOSAL_MAX_PAGES,
    after: prefix,
    prefix,
  });
  for await (const entry of entries) {
    const parsed = priceProposalSchema.safeParse(entry.value);
    if (parsed.success) result.push(parsed.data);
  }
  return result;
}

/**
 * Закрыть предложения поставщика, созданные раньше импорта с диска: данные диска новее, справка
 * больше не нужна. Возвращает число удалённых.
 */
export async function closeProposalsBefore(
  state: WorkflowStateStore,
  supplierId: string,
  importedAt: Date,
): Promise<number> {
  const stale = (await listProposals(state, supplierId)).filter(
    (proposal) => Date.parse(proposal.createdAt) <= importedAt.getTime(),
  );
  for (const proposal of stale) {
    await state.delete(PRICE_PROPOSAL_NAMESPACE, proposalKey(supplierId, proposal.importId));
  }
  return stale.length;
}

/** Справка о неподтверждённой цене позиции: только для показа, не для расчётов. */
export interface UnconfirmedPrice {
  price: number;
  priceQualifier?: PriceQualifier | undefined;
  priceMax?: number | undefined;
  currency: string;
  source: ProposalSource;
  sourceDate: string;
  senderVerified?: boolean | undefined;
}

const normalizeName = (name: string): string => name.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Свежая неподтверждённая цена позиции: по артикулу, иначе по названию, из самого нового
 * предложения. null, если предложений по позиции нет.
 */
export function findUnconfirmedPrice(
  proposals: readonly PriceProposal[],
  query: { sku?: string | undefined; productName: string },
): UnconfirmedPrice | null {
  const sorted = [...proposals].sort((a, b) => b.sourceDate.localeCompare(a.sourceDate));
  const name = normalizeName(query.productName);
  for (const proposal of sorted) {
    const item = proposal.items.find((candidate) =>
      query.sku !== undefined && candidate.sku !== undefined
        ? candidate.sku === query.sku
        : normalizeName(candidate.productName) === name,
    );
    if (item === undefined) continue;
    return {
      price: item.price,
      ...(item.priceQualifier === undefined ? {} : { priceQualifier: item.priceQualifier }),
      ...(item.priceMax === undefined ? {} : { priceMax: item.priceMax }),
      currency: item.currency,
      source: proposal.source,
      sourceDate: proposal.sourceDate,
      ...(proposal.senderVerified === undefined ? {} : { senderVerified: proposal.senderVerified }),
    };
  }
  return null;
}

const SOURCE_LABELS: Record<ProposalSource, string> = {
  intake: 'файл из чата',
  mail: 'письмо',
  employee: 'со слов сотрудника',
};

/** `YYYY-MM-DD...` -> `DD.MM.YYYY`. */
export function russianDate(iso: string): string {
  const [year, month, day] = iso.slice(0, ISO_DAY_LENGTH).split('-');
  return `${day ?? ''}.${month ?? ''}.${year ?? ''}`;
}

/** Текст справки: «свежая неподтверждённая цена 12 RUB (письмо от 24.10.2026, ...)». */
export function formatUnconfirmedPrice(ref: UnconfirmedPrice): string {
  const sender = ref.source === 'mail' && ref.senderVerified !== true
    ? ', отправитель не подтверждён'
    : '';
  const priceText =
    ref.priceQualifier === undefined
      ? ref.price
      : formatPriceBounds(ref.price, ref.priceQualifier, ref.priceMax);
  return (
    `свежая неподтверждённая цена ${priceText} ${ref.currency} ` +
    `(${SOURCE_LABELS[ref.source]} от ${russianDate(ref.sourceDate)}${sender}, ` +
    'на диск не внесена)'
  );
}

/**
 * Поиск справки о неподтверждённой цене с кэшем предложений по поставщику (на один вызов
 * инструмента): предложения поставщика читаются один раз.
 */
export function unconfirmedLookup(
  state: WorkflowStateStore,
): (item: PriceItem) => Promise<string | undefined> {
  const cache = new Map<string, Promise<PriceProposal[]>>();
  return async (item) => {
    let proposals = cache.get(item.supplierId);
    if (proposals === undefined) {
      proposals = listProposals(state, item.supplierId);
      cache.set(item.supplierId, proposals);
    }
    const ref = findUnconfirmedPrice(await proposals, item);
    return ref === null ? undefined : formatUnconfirmedPrice(ref);
  };
}
