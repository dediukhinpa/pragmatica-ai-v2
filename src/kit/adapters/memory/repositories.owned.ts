import {
  cardFromParts,
  DEFAULT_SUPPLIER_STATUS,
  duplicateReasons,
  findDuplicateKeys,
  normalizeEmail,
  normalizeInn,
  parseSupplierNote,
  prepareCardForWrite,
  sortDuplicates,
  SUPPLIER_NOTES_READ_LIMIT,
  type DuplicateCandidate,
  type DuplicateMatch,
  type SupplierCard,
  type SupplierCardParts,
  type SupplierNote,
} from '../../domain/supplier-card';
import { DomainError } from '@business-ai/core';
import { normalizeSku, priceItemKey } from '../../domain/price-diff';
import { NewerPriceVersionError, PriceBaseChangedError } from '../../domain/errors.owned';
import {
  fileImportKeyPrefix,
  matchedNullRowKeys,
  planSourceReplacement,
} from '../../domain/price-file-stream';
import { latestPerLine } from '../../domain/latest-price';
import { pickFullParts } from '../../domain/supplier-card-full';
import { prepareSupplierForWrite } from '../../domain/requisites';
import {
  priceSourceRank,
  productMatchesTokens,
  wordStartMatches,
  productSearchTokens,
  rankedSearchTokens,
} from '../../domain/product-search';
import { type PriceItem, type PurchaseRequest, type Supplier } from '../../domain/models';
import type { IdempotencyKey } from '@business-ai/core';
import type {
  PriceRepository,
  PurchaseRequestRepository,
  SaveCardOptions,
  SaveImportOptions,
  SupplierCardQuery,
  SupplierProductSearchOptions,
  SupplierAddressMatch,
  SupplierRepository,
} from '../../ports/repositories.owned';

/** Запись поставщика в памяти: столбцы `suppliers` и части карточки рядом, как в БД. */
interface SupplierRecord {
  supplier: Supplier;
  parts: SupplierCardParts;
}
/** Источник текущего момента (ISO 8601); в тестах подменяется. */
type NowSource = () => string;
function emptyParts(now: string): SupplierCardParts {
  return {
    status: DEFAULT_SUPPLIER_STATUS,
    contacts: [],
    supplies: { categories: [], brands: [], regions: [] },
    terms: {},
    notes: [],
    createdAt: now,
    updatedAt: now,
  };
}
function cloneParts(parts: SupplierCardParts): SupplierCardParts {
  return {
    ...parts,
    contacts: parts.contacts.map((contact) => ({ ...contact })),
    supplies: {
      categories: [...parts.supplies.categories],
      brands: [...parts.supplies.brands],
      regions: [...parts.supplies.regions],
    },
    terms: { ...parts.terms },
    notes: parts.notes.map((note) => ({ ...note })),
    ...pickFullParts(parts),
  };
}
/** Подстрока без учёта регистра и «ё». */
function foldText(value: string): string {
  return value.toLowerCase().replaceAll('ё', 'е');
}
function listHas(values: readonly string[], needle: string, wordStart = false): boolean {
  return values.some((value) =>
    wordStart ? wordStartMatches(needle, value) : foldText(value).includes(needle),
  );
}
/** Поставщики в памяти. */
export class MemorySupplierRepository implements SupplierRepository {
  private readonly items = new Map<string, SupplierRecord>();

  constructor(private readonly now: NowSource = () => new Date().toISOString()) {}

  async upsert(input: Supplier): Promise<void> {
    // Те же правила записи реквизитов, что в Postgres-адаптере.
    const prepared = prepareSupplierForWrite(input);
    const existing = this.items.get(prepared.id);
    if (existing === undefined) {
      this.items.set(prepared.id, { supplier: prepared, parts: emptyParts(this.now()) });
      return;
    }
    const parts = cloneParts(existing.parts);
    parts.updatedAt = this.now();
    let supplier = prepared;
    const primary = parts.contacts.find((contact) => contact.isPrimary);
    if (primary !== undefined) {
      // Есть сохранённые контакты: прежние email/contactName правят основной контакт.
      const email = prepared.email === undefined ? '' : normalizeEmail(prepared.email);
      const name = prepared.contactName?.trim() ?? '';
      if (email !== '') primary.email = email;
      if (name !== '') primary.fullName = name;
      supplier = {
        ...prepared,
        ...(primary.email === undefined ? {} : { email: primary.email }),
        ...(primary.fullName === undefined ? {} : { contactName: primary.fullName }),
      };
    }
    this.items.set(prepared.id, { supplier, parts });
  }

  async get(id: string): Promise<Supplier | null> {
    const found = this.items.get(id);
    return found === undefined ? null : { ...found.supplier };
  }

  async search(query: string, limit: number): Promise<Supplier[]> {
    const needle = query.toLowerCase();
    return [...this.items.values()]
      .filter((record) => record.supplier.name.toLowerCase().includes(needle))
      .slice(0, limit)
      .map((record) => ({ ...record.supplier }));
  }

  async findByAddresses(addresses: readonly string[]): Promise<SupplierAddressMatch[]> {
    const wanted = new Set(addresses.map(normalizeEmail).filter((address) => address !== ''));
    const found: SupplierAddressMatch[] = [];
    for (const record of this.items.values()) {
      // Прежний email и адреса всех контактов; одна пара на (адрес, поставщик).
      const own = findDuplicateKeys({
        name: record.supplier.name,
        email: record.supplier.email,
        contacts: record.parts.contacts,
      }).emails;
      for (const address of own) {
        if (wanted.has(address)) found.push({ address, supplier: { ...record.supplier } });
      }
    }
    return found.sort(
      (a, b) =>
        compareText(a.supplier.name, b.supplier.name) ||
        compareText(a.supplier.id, b.supplier.id) ||
        compareText(a.address, b.address),
    );
  }

  async listPage(afterId: string | null, limit: number): Promise<Supplier[]> {
    return [...this.items.values()]
      .filter((record) => afterId === null || compareText(record.supplier.id, afterId) > 0)
      .sort((a, b) => compareText(a.supplier.id, b.supplier.id))
      .slice(0, Math.max(0, limit))
      .map((record) => ({ ...record.supplier }));
  }

  async getCard(id: string): Promise<SupplierCard | null> {
    const found = this.items.get(id);
    return found === undefined ? null : this.cardOf(found);
  }

  async getCards(ids: readonly string[]): Promise<SupplierCard[]> {
    const cards: SupplierCard[] = [];
    for (const id of new Set(ids)) {
      const found = this.items.get(id);
      if (found !== undefined) cards.push(this.cardOf(found));
    }
    return cards;
  }

  async saveCard(input: SupplierCard, options: SaveCardOptions = {}): Promise<SupplierCard> {
    const { card, supplier } = prepareCardForWrite(input);
    const existing = this.items.get(card.id);
    // Те же условия, что в Postgres-адаптере; запись синхронна, гонки между ними нет.
    if (options.createOnly === true && existing !== undefined) {
      throw new DomainError('conflict', 'Карточка с таким идентификатором уже существует.');
    }
    if (options.expectedUpdatedAt !== undefined && options.createOnly !== true) {
      if (existing === undefined) {
        throw new DomainError('not_found', 'Карточка для обновления не найдена.');
      }
      const stored = Date.parse(existing.parts.updatedAt ?? '');
      if (Number.isNaN(stored) || stored !== Date.parse(options.expectedUpdatedAt)) {
        throw new DomainError('conflict', 'Карточку изменили после чтения: обновите данные.');
      }
    }
    const now = this.now();
    const notes = [...(existing?.parts.notes ?? [])];
    for (const note of card.notes) {
      const same = (other: SupplierNote): boolean =>
        other.text === note.text &&
        other.authorId === note.authorId &&
        other.createdAt === note.createdAt;
      if (!notes.some(same)) notes.push({ ...note });
    }
    const parts: SupplierCardParts = {
      status: card.status,
      contacts: card.contacts.map((contact) => ({ ...contact })),
      supplies: card.supplies,
      terms: card.terms,
      notes,
      createdBy: existing?.parts.createdBy ?? card.createdBy,
      createdAt: existing?.parts.createdAt ?? card.createdAt ?? now,
      updatedBy: card.updatedBy ?? existing?.parts.updatedBy,
      updatedAt: card.updatedAt ?? now,
      source: card.source ?? existing?.parts.source,
      ...(card.website === undefined ? {} : { website: card.website }),
      productionCity: card.productionCity,
      address: card.address,
      strengths: card.strengths,
      weaknesses: card.weaknesses,
      defectRatePercent: card.defectRatePercent,
      ...pickFullParts(card),
    };
    const record = { supplier, parts: cloneParts(parts) };
    this.items.set(card.id, record);
    return this.cardOf(record);
  }

  async searchCards(query: SupplierCardQuery): Promise<SupplierCard[]> {
    const name = query.query === undefined ? '' : foldText(query.query.trim());
    const category = query.category === undefined ? '' : foldText(query.category.trim());
    const brand = query.brand === undefined ? '' : foldText(query.brand.trim());
    const inn = query.inn === undefined ? undefined : normalizeInn(query.inn);
    const email = query.email === undefined ? '' : normalizeEmail(query.email);
    const cards = [...this.items.values()]
      .filter((record) => {
        const { supplier, parts } = record;
        const byWord = query.wordStart === true;
        if (name !== '') {
          const nameFits = byWord
            ? wordStartMatches(name, supplier.name)
            : foldText(supplier.name).includes(name);
          if (!nameFits) return false;
        }
        if (inn !== undefined && (inn === '' || supplier.inn !== inn)) return false;
        if (email !== '') {
          const keys = findDuplicateKeys(this.cardOf(record));
          if (!keys.emails.includes(email) && normalizeEmail(supplier.email ?? '') !== email) {
            return false;
          }
        }
        if (category !== '' && !listHas(parts.supplies.categories, category, byWord)) return false;
        if (brand !== '' && !listHas(parts.supplies.brands, brand, byWord)) return false;
        return true;
      })
      .map((record) => this.cardOf(record));
    cards.sort((a, b) => compareText(a.name, b.name) || compareText(a.id, b.id));
    return cards.slice(0, Math.max(0, query.limit));
  }

  async findDuplicates(candidate: DuplicateCandidate): Promise<DuplicateMatch[]> {
    const wanted = findDuplicateKeys(candidate);
    const matches: DuplicateMatch[] = [];
    for (const [id, record] of this.items) {
      if (id === candidate.id) continue;
      const card = this.cardOf(record);
      const keys = findDuplicateKeys({ ...card, email: record.supplier.email });
      const reasons = duplicateReasons(wanted, keys);
      const [reason] = reasons;
      if (reason !== undefined) matches.push({ supplierId: id, name: card.name, reason, reasons });
    }
    return sortDuplicates(matches);
  }

  async addNote(supplierId: string, input: SupplierNote): Promise<void> {
    const note = parseSupplierNote(input);
    const record = this.items.get(supplierId);
    if (record === undefined) {
      throw new DomainError('not_found', 'Поставщик не найден: заметка не добавлена.');
    }
    // Идемпотентность: та же заметка (текст, автор, момент) повторно не добавляется.
    const same = record.parts.notes.some(
      (other) =>
        other.text === note.text &&
        other.authorId === note.authorId &&
        Date.parse(other.createdAt) === Date.parse(note.createdAt),
    );
    if (!same) record.parts.notes.push(note);
  }

  private cardOf(record: SupplierRecord): SupplierCard {
    const card = cardFromParts(record.supplier, cloneParts(record.parts));
    card.notes = card.notes.slice(-SUPPLIER_NOTES_READ_LIMIT);
    return card;
  }
}
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
/** Цены в памяти. */
export class MemoryPriceRepository implements PriceRepository {
  private readonly bySupplier = new Map<string, PriceItem[]>();
  private readonly imports = new Set<IdempotencyKey>();
  /** Ключи импортов, записавших строки без файла (аналог `import_key` в Postgres). */
  private readonly nullRowKeys = new Map<string, Set<string>>();

  async hasNullRowsFromFile(supplierId: string, fileHash: string): Promise<boolean> {
    const prefix = fileImportKeyPrefix(supplierId, fileHash);
    const hasNull = (this.bySupplier.get(supplierId) ?? []).some((i) => i.sourceFile === undefined);
    if (!hasNull) return false;
    return [...(this.nullRowKeys.get(supplierId) ?? [])].some(
      (key) => key === prefix || key.startsWith(`${prefix}:base:`),
    );
  }

  async saveImport(
    supplierId: string,
    items: PriceItem[],
    key: IdempotencyKey,
    options: SaveImportOptions = {},
  ): Promise<void> {
    if (this.imports.has(key)) return;
    // Как в Postgres: прайс изменился после сверки - отказ без записи и без занятия ключа.
    const current = this.bySupplier.get(supplierId) ?? [];
    if (options.isExpectedBase !== undefined && !options.isExpectedBase(current)) {
      throw new PriceBaseChangedError(supplierId);
    }
    const { sourceFile } = options;
    if (sourceFile === undefined) {
      this.imports.add(key);
      this.bySupplier.set(supplierId, items.map((item) => ({ ...item })));
      this.nullRowKeys.set(supplierId, new Set([key]));
      return;
    }
    // Как в Postgres: заменяются строки этого файла и его старых версий, чужие файлы целы.
    const existing = current.map((item) => item.sourceFile ?? null);
    let plan = planSourceReplacement(existing, sourceFile, options.fileHistory);
    // Полная замена строк без файла - при доказательстве: sha256 файла в ключе прежнего импорта.
    if (!plan.replaceNull && existing.includes(null) && options.fileHash !== undefined) {
      if (await this.hasNullRowsFromFile(supplierId, options.fileHash)) {
        plan = planSourceReplacement(existing, sourceFile, options.fileHistory, true);
      }
    }
    if (plan.newerFile !== null) throw new NewerPriceVersionError(supplierId, plan.newerFile);
    this.imports.add(key);
    const replaced = new Set(plan.replaceFiles);
    // Без доказательства строки без файла заменяются построчно: уходят только те, чья позиция
    // есть во входящем наборе; остальные целы.
    const matched = plan.replaceNull
      ? new Set<string>()
      : matchedNullRowKeys(
          current.filter((item) => item.sourceFile === undefined),
          items,
        );
    const kept = current.filter((item) =>
      item.sourceFile === undefined
        ? !plan.replaceNull && !matched.has(priceItemKey(item))
        : !replaced.has(item.sourceFile),
    );
    if (plan.replaceNull) this.nullRowKeys.delete(supplierId);
    this.bySupplier.set(supplierId, [
      ...kept,
      ...items.map((item) => ({ ...item, sourceFile })),
    ]);
  }

  async listBySupplier(supplierId: string): Promise<PriceItem[]> {
    return (this.bySupplier.get(supplierId) ?? []).map((item) => ({ ...item }));
  }

  async searchProducts(query: string, limit: number): Promise<PriceItem[]> {
    const tokens = productSearchTokens(query);
    return this.matching(tokens).slice(0, limit);
  }

  async searchSuppliersByProduct(
    query: string,
    limit: number,
    options: SupplierProductSearchOptions = {},
  ): Promise<PriceItem[]> {
    const tokens = productSearchTokens(query);
    // Лучшая цена поставщика в каждой валюте; равные цены - первая по порядку прайса.
    const best = new Map<string, PriceItem>();
    // По каждой позиции поставщика - строка самого свежего прайса (этап 161), как в Postgres.
    const matched = this.matching(tokens, options.wordStart === true);
    const latest = latestPerLine(matched, (item) => item);
    for (const item of latest) {
      const key = `${item.supplierId}\u0000${item.currency}`;
      const current = best.get(key);
      if (current === undefined || item.price < current.price) best.set(key, item);
    }
    const byCurrency = new Map<string, PriceItem[]>();
    for (const item of best.values()) {
      const list = byCurrency.get(item.currency) ?? [];
      list.push(item);
      byCurrency.set(item.currency, list);
    }
    const ranked: Array<{ rank: number; item: PriceItem }> = [];
    for (const list of byCurrency.values()) {
      list.sort((a, b) => a.price - b.price || a.supplierId.localeCompare(b.supplierId));
      list.forEach((item, rank) => ranked.push({ rank, item }));
    }
    ranked.sort(
      (a, b) =>
        a.rank - b.rank ||
        a.item.currency.localeCompare(b.item.currency) ||
        a.item.supplierId.localeCompare(b.item.supplierId),
    );
    return ranked.slice(0, limit).map(({ item }) => item);
  }

  async searchRankedProducts(query: string, limit: number): Promise<PriceItem[]> {
    // Без FTS и векторов: все слова запроса по началу слова, ближе - короче название.
    const tokens = rankedSearchTokens(query);
    return this.matching(tokens, true)
      .sort(
        (a, b) =>
          a.productName.length - b.productName.length ||
          // Равные по близости: диск выше почты (порядок, а не состав выдачи).
          priceSourceRank(a.sourceFile) - priceSourceRank(b.sourceFile) ||
          a.price - b.price,
      )
      .slice(0, limit);
  }

  async listBySku(sku: string, limit: number): Promise<PriceItem[]> {
    const wanted = normalizeSku(sku);
    if (wanted === '') return [];
    const found: PriceItem[] = [];
    for (const items of this.bySupplier.values()) {
      for (const item of items) {
        if (item.sku !== undefined && normalizeSku(item.sku) === wanted) found.push({ ...item });
      }
    }
    return found.slice(0, limit);
  }

  async listBySkus(
    skus: readonly string[],
    limitPerSku: number,
  ): Promise<Map<string, PriceItem[]>> {
    const wanted = new Map<string, string>();
    for (const sku of skus) wanted.set(sku, normalizeSku(sku));
    const needed = new Set([...wanted.values()].filter((sku) => sku !== ''));
    // Один проход по всем прайсам; порядок выдачи на артикул - как у listBySku.
    const byNormalized = new Map<string, PriceItem[]>();
    for (const items of this.bySupplier.values()) {
      for (const item of items) {
        if (item.sku === undefined) continue;
        const normalized = normalizeSku(item.sku);
        if (!needed.has(normalized)) continue;
        const list = byNormalized.get(normalized) ?? [];
        list.push(item);
        byNormalized.set(normalized, list);
      }
    }
    const result = new Map<string, PriceItem[]>();
    for (const [sku, normalized] of wanted) {
      const found = byNormalized.get(normalized) ?? [];
      result.set(
        sku,
        found.slice(0, limitPerSku).map((item) => ({ ...item })),
      );
    }
    return result;
  }

  private matching(tokens: readonly string[], wordStart = false): PriceItem[] {
    const found: PriceItem[] = [];
    for (const items of this.bySupplier.values()) {
      for (const item of items) {
        const fits = wordStart
          ? tokens.every((token) => wordStartMatches(token, item.productName, item.sku))
          : productMatchesTokens(tokens, item.productName, item.sku);
        if (fits) found.push({ ...item });
      }
    }
    return found.sort((a, b) => a.price - b.price);
  }
}
/** Заявки на расчёт в памяти. */
export class MemoryPurchaseRequestRepository implements PurchaseRequestRepository {
  private readonly items = new Map<string, PurchaseRequest>();

  async save(request: PurchaseRequest): Promise<void> {
    if (!this.items.has(request.id)) this.items.set(request.id, structuredClone(request));
  }

  async get(id: string): Promise<PurchaseRequest | null> {
    const found = this.items.get(id);
    return found === undefined ? null : structuredClone(found);
  }

  async listByDeal(dealRef: string): Promise<PurchaseRequest[]> {
    return [...this.items.values()]
      .filter((r) => r.dealRef === dealRef)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id))
      .map((r) => structuredClone(r));
  }
}
