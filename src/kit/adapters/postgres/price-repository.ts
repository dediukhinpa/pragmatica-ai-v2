import { createHash } from 'node:crypto';
import {
  MIN_STEM_WORD_LENGTH,
  WORD_START_SEPARATORS,
  productSearchTokens,
  rankedSearchTokens,
  DISK_PRICE_SOURCE_PREFIX,
  DISK_SOURCE_RANK,
  OTHER_SOURCE_RANK,
  wordStartPattern,
} from '../../domain/product-search';
import { NewerPriceVersionError, PriceBaseChangedError } from '../../domain/errors.owned';
import { fileImportKeyPrefix, planSourceReplacement } from '../../domain/price-file-stream';
import { priceItemKey, normalizeSku, normalizeProductName } from '../../domain/price-diff';
import {
  PRICE_VAT_VALUES,
  type PriceItem,
  type PriceTier,
  type PriceVat,
} from '../../domain/models';
import type { Embedder, IdempotencyKey } from '@business-ai/core';
import type {
  PriceRepository,
  SaveImportOptions,
  SupplierProductSearchOptions,
} from '../../ports/repositories.owned';
import { toVectorLiteral, type PgClient, type PgParam, type PgRow } from '@business-ai/adapters';
import {
  assertDimensions,
  assertQueryText,
  toQueryEmbedder,
  type QueryEmbedder,
} from '@business-ai/adapters';
import { fillPriceEmbeddings, type PriceEmbedLog } from './price-embeddings';
import { parseRows } from '@business-ai/adapters';
import { priceRow } from './rows.owned';

/** Область ключей идемпотентности импорта прайсов. */
const IMPORT_SCOPE = 'price_import';
/**
 * Префикс ключа advisory-блокировки записи прайса поставщика (R9-A5-02). Пространство ключей
 * общее у всего проекта: прочие текстовые ключи - `pair-notes:` и `supplier-card:`
 * (`hashtextextended`), у db/migrate.sh числовой ключ; префикс не пересекается с ними.
 */
const IMPORT_LOCK_PREFIX = 'price-import:';

/**
 * НДС, %, по которому цена «без НДС» приводится к цене «с НДС» только для СРАВНЕНИЯ поставщиков
 * (порядок в поиске): иначе цена без НДС системно выигрывает у такой же цены с НДС. Показываемая
 * цена не меняется. Ставка РФ с 2026-01-01 - 22 %.
 */
const COMPARISON_VAT_PERCENT = 22;

/** Цена для сравнения: строки без НДС ('excluded') дорожают на ставку, остальные как есть. */
const COMPARABLE_PRICE_SQL =
  `(price * CASE WHEN price_vat = 'excluded' THEN ${1 + COMPARISON_VAT_PERCENT / 100} ELSE 1 END)`;

const COLUMNS =
  'supplier_id, product_name, sku, price, currency, price_date, price_tiers, ' +
  'price_qualifier, price_max, price_tier_basis, source_file';
/** Колонки для запросов, где нужен признак НДС (порядок по цене для сравнения). */
const COLUMNS_WITH_VAT = `${COLUMNS}, price_vat`;

/**
 * Минимальная длина токена (в символах Unicode), с которой `hay LIKE '%t%'` разумно отдавать
 * trgm-индексу: триграмма - 3 символа. Для более коротких токенов индекс бесполезен.
 */
const TRGM_MIN_TOKEN_LENGTH = 3;

/**
 * Условие совпадения позиции с токенами запроса по сгенерированным столбцам `hay` и `words`
 * (миграция 016): нормализация (NFKC, тире, регистр, «ё») посчитана при записи строки, как
 * `normalizeProductName`, поэтому запрос идёт по GIN-индексам, а не по полному скану (R5-DB-1).
 * Токен подходит как подстрока `hay` либо как продолжение целого слова длиной от
 * `MIN_STEM_WORD_LENGTH` (слово названия - префикс токена). Результат тот же, что у прежнего
 * `position(token in hay) = 0 AND NOT EXISTS (слово - префикс токена)` по каждой строке.
 */
function matchedCte(
  query: string,
  wordStart = false,
): { sql: string; params: PgParam[]; limitParam: string } {
  const params: PgParam[] = [];
  const conditions = tokenConditions(productSearchTokens(query), wordStart, params);
  params.push(0);
  return {
    sql: `WITH matched AS (
  SELECT id, created_at, ${COLUMNS_WITH_VAT} FROM price_items
  WHERE ${conditions.join(' AND ')}
)`,
    params,
    limitParam: `$${params.length}::int`,
  };
}

/**
 * Условия «токен есть в названии» по одному на токен; параметры дописываются в `params`
 * (номера в тексте условий сквозные). Общий для прежнего поиска подстрокой и для ветки
 * «начало слова» гибридного поиска.
 */
function tokenConditions(
  tokens: readonly string[],
  wordStart: boolean,
  params: PgParam[],
): string[] {
  const conditions: string[] = [];
  for (const token of tokens) {
    const short = Array.from(token).length < TRGM_MIN_TOKEN_LENGTH;
    // Короткий токен (м8, а2, 40) даёт `LIKE '%t%'` без триграмм: планировщик всё равно берёт
    // `price_items_hay_trgm_idx` и сканирует его целиком (на 500 тыс. строк 586 мс против 92 мс).
    // `strpos` индексом не обслуживается, поэтому такой токен проверяется фильтром по строкам,
    // уже отобранным остальными условиями. Подстрока ищется буквально, экранировать не нужно.
    params.push(short ? token : `%${escapeLike(token)}%`, textArrayLiteral(tokenPrefixes(token)));
    const value = `$${params.length - 1}::text`;
    const prefixes = `$${params.length}::text[]`;
    const substring = short ? `strpos(hay, ${value}) > 0` : `hay LIKE ${value}`;
    if (wordStart) {
      // Подстрока остаётся предфильтром (триграммы), а начало слова проверяется по тексту с
      // единым пробелом между словами. Зачем: ослабленный поиск по «мед» не должен находить
      // «медаль» и «медный»; шаблон тот же, что у `wordStartShare` в коде.
      params.push(wordStartPattern(token));
      const pattern = `$${params.length}::text`;
      const spaced = `(' ' || regexp_replace(hay, '${WORD_START_SEPARATORS}', ' ', 'g') || ' ')`;
      conditions.push(`((${substring} AND ${spaced} ~ ${pattern}) OR words && ${prefixes})`);
      continue;
    }
    // Пустой массив префиксов (токен короче слова от 4 символов) `&&` не совпадает: верно.
    conditions.push(`(${substring} OR words && ${prefixes})`);
  }
  return conditions;
}

/** Экранирование `\`, `%` и `_` в токене для LIKE (escape-символ по умолчанию - `\`). */
function escapeLike(token: string): string {
  return token.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Префиксы токена длиной от `MIN_STEM_WORD_LENGTH` (по символам Unicode, как `length` и
 * `left` в PostgreSQL), включая сам токен: слово названия подходит, если равно одному из них.
 */
function tokenPrefixes(token: string): string[] {
  const chars = Array.from(token);
  const prefixes: string[] = [];
  for (let length = MIN_STEM_WORD_LENGTH; length <= chars.length; length += 1) {
    prefixes.push(chars.slice(0, length).join(''));
  }
  return prefixes;
}

/** Литерал массива `text[]` ('{"a","b"}') для параметра с приведением `::text[]`. */
function textArrayLiteral(values: readonly string[]): string {
  const quoted = values.map((value) => `"${value.replace(/[\\"]/g, (char) => `\\${char}`)}"`);
  return `{${quoted.join(',')}}`;
}

/**
 * Нормализация артикула в SQL, как `normalizeSku` (NFKC, тире, регистр). Должна совпадать с
 * выражением индекса `price_items_sku_norm_idx` (миграция 016) посимвольно: шаблон тире
 * записан литералом, а не параметром, иначе индекс не применим (R5-DB-2).
 */
const SKU_NORM_SQL = `regexp_replace(
         regexp_replace(lower(normalize(sku, NFKC)), '[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]',
                        '-', 'g'),
         '\\s*-\\s*', '-', 'g')`;

/** Сколько артикулов уходит в одном запросе `= ANY(...)`. */
const SKU_BATCH_SIZE = 500;

/** Сколько позиций вставляется одним запросом (укладывается в `statement_timeout`). */
export const PRICE_IMPORT_BATCH_ROWS = 2000;

/** Строка пакета вставки: только нужные поля (`sku` может отсутствовать). */
function toBatchRow(item: PriceItem): Record<string, unknown> {
  return {
    productName: item.productName,
    sku: item.sku ?? null,
    price: item.price,
    currency: item.currency,
    date: item.date,
    // Ключа нет у позиции с одной ценой: `e.value->'priceTiers'` даёт SQL NULL, не jsonb null.
    ...(item.priceTiers === undefined ? {} : { priceTiers: item.priceTiers }),
    ...(item.priceTierBasis === undefined ? {} : { priceTierBasis: item.priceTierBasis }),
    ...(item.priceQualifier === undefined ? {} : { priceQualifier: item.priceQualifier }),
    ...(item.priceMax === undefined ? {} : { priceMax: item.priceMax }),
    ...(item.sourceFile === undefined ? {} : { sourceFile: item.sourceFile }),
  };
}

/** Сколько прайсов поставщиков держит снимок: память ограничена и числом, и строками. */
const MAX_SNAPSHOT_SUPPLIERS = 8;
const MAX_SNAPSHOT_ROWS = 100_000;

/** Снимок прайса поставщика и версия, под которой он выгружен. */
interface PriceSnapshot {
  version: string;
  items: readonly PriceItem[];
}

/**
 * Быстрый разбор строк пакетом (R5-ADP-4): результат тот же, что у `priceRow`, но без zod на
 * каждую строку. Строка нестандартной формы (не строка/число/дата там, где ждём) отдаёт
 * весь пакет прежнему разбору: ошибка и поведение на «грязных» данных не меняются.
 */
function parsePriceRows(rows: PgRow[]): PriceItem[] {
  const items: PriceItem[] = [];
  for (const row of rows) {
    const item = fastPriceItem(row);
    if (item === undefined) return parseRows(priceRow, rows);
    items.push(item);
  }
  return items;
}

/** Строка в `PriceItem` или `undefined`, если форма не та, что даёт драйвер. */
function fastPriceItem(row: PgRow): PriceItem | undefined {
  const { supplier_id: supplierId, product_name: productName, sku, currency } = row;
  const { price: rawPrice, price_date: rawDate } = row;
  if (typeof supplierId !== 'string' || typeof productName !== 'string') return undefined;
  if (typeof currency !== 'string') return undefined;
  if (sku !== null && typeof sku !== 'string') return undefined;
  if (typeof rawPrice !== 'string' && typeof rawPrice !== 'number') return undefined;
  const price = Number(rawPrice);
  if (Number.isNaN(price)) return undefined;
  if (!(rawDate instanceof Date) && typeof rawDate !== 'string') return undefined;
  const date = new Date(rawDate);
  if (Number.isNaN(date.getTime())) return undefined;
  const priceTiers = fastTiers(row['price_tiers']);
  if (priceTiers === 'bad') return undefined;
  const qualifierFields = fastQualifier(row);
  if (qualifierFields === 'bad') return undefined;
  const sourceFile = row['source_file'];
  if (sourceFile !== null && sourceFile !== undefined && typeof sourceFile !== 'string') {
    return undefined;
  }
  const basis = row['price_tier_basis'];
  if (basis !== undefined && basis !== 'quantity' && basis !== 'order_sum') return undefined;
  const vat = row['price_vat'];
  if (vat !== null && vat !== undefined && !isPriceVat(vat)) return undefined;
  return {
    supplierId,
    productName,
    ...(sku === null ? {} : { sku }),
    price,
    currency,
    date: date.toISOString(),
    ...(priceTiers === undefined ? {} : { priceTiers }),
    // 'quantity' (по умолчанию) в позицию не попадает: хэши прежних позиций не меняются.
    ...(basis === 'order_sum' ? { priceTierBasis: 'order_sum' as const } : {}),
    ...qualifierFields,
    ...(typeof sourceFile === 'string' && sourceFile !== '' ? { sourceFile } : {}),
    ...(vat === null || vat === undefined ? {} : { priceVat: vat }),
  };
}

/** Значение столбца `price_vat` из известных (CHECK миграции 039). */
function isPriceVat(value: unknown): value is PriceVat {
  return PRICE_VAT_VALUES.some((known) => known === value);
}

/** Признак цены и верхняя граница из строки; неожиданная форма - 'bad' (разбор прежним путём). */
function fastQualifier(
  row: PgRow,
): Pick<PriceItem, 'priceQualifier' | 'priceMax'> | 'bad' {
  const qualifier = row['price_qualifier'];
  const max = row['price_max'];
  const result: Pick<PriceItem, 'priceQualifier' | 'priceMax'> = {};
  if (qualifier !== null && qualifier !== undefined) {
    if (qualifier !== 'from' && qualifier !== 'range') return 'bad';
    result.priceQualifier = qualifier;
  }
  if (max !== null && max !== undefined) {
    const value = Number(max);
    if (!Number.isFinite(value)) return 'bad';
    result.priceMax = value;
  }
  return result;
}

/** Тиражи из jsonb: нет - `undefined`; форма не та, что ждём, - 'bad' (разбор прежним путём). */
function fastTiers(raw: unknown): PriceTier[] | undefined | 'bad' {
  if (raw === null || raw === undefined) return undefined;
  if (!Array.isArray(raw)) return 'bad';
  const tiers: PriceTier[] = [];
  for (const entry of raw as unknown[]) {
    if (typeof entry !== 'object' || entry === null) return 'bad';
    const { minQuantity, price, qualifier, max } = entry as Record<string, unknown>;
    if (typeof minQuantity !== 'number' || typeof price !== 'number') return 'bad';
    // Диапазон/«от» в тираже (матрица «размер × тираж»): есть признак - разбор прежним путём.
    if (qualifier !== undefined || max !== undefined) return 'bad';
    tiers.push({ minQuantity, price });
  }
  return tiers;
}

/** Хэш содержимого импорта: фиксирует, что именно было загружено под ключом. */
function hashItems(items: readonly PriceItem[]): string {
  return createHash('sha256').update(JSON.stringify(items)).digest('hex');
}

/** Копия списка: вызывающий может менять результат, не портя снимок. */
function copyItems(items: readonly PriceItem[]): PriceItem[] {
  return items.map((item) => ({ ...item }));
}

/** Параметры гибридного поиска по прайсам и эмбеддингов строк. */
export interface PriceRepositoryOptions {
  /**
   * Сервис эмбеддингов (или функция запроса). Без него поиск идёт по FTS и началу слова, а
   * после импорта вектора строкам не считаются (их дозагружает `fillPriceEmbeddings`).
   */
  embedder?: Embedder | QueryEmbedder | undefined;
  /** Порог косинусной близости векторной ветки; по умолчанию {@link DEFAULT_PRICE_MIN_COSINE}. */
  minCosine?: number | undefined;
  /** Журнал: только коды и числа, без названий товаров. */
  log?: PriceEmbedLog | undefined;
}

/**
 * Порог близости вектора для названий товаров. Названия короткие, и у несвязанных пар близость
 * высокая: замер на боевой базе (28.10.26, ~96 тыс. строк с эмбеддингами) дал медиану 0.77 и
 * 99-й процентиль 0.81 у случайных строк против любого запроса, у настоящих совпадений
 * («мёд» - строки про мёд) медиана 0.80. При пороге 0.4 в выдачу попадали «гидрозатворы» и
 * «салатники» для позиции «вкусности»; 0.83 оставляет только заметно близкие пары. Ветки FTS и
 * начала слова порогом не ограничены, проверка релевантности моделью идёт дальше.
 */
export const DEFAULT_PRICE_MIN_COSINE = 0.83;
/** Слияние RRF: константа сглаживания, как в SQL-функциях гибридного поиска (003, 020, 030). */
const RRF_K = 60;
/** Сколько кандидатов даёт каждая ветка до слияния. */
const BRANCH_CANDIDATES = 100;
/**
 * `hnsw.ef_search` на запрос: не меньше числа кандидатов ветки, иначе индекс вернёт меньше
 * строк, чем просили (по умолчанию 40).
 */
const HNSW_EF_SEARCH = 1000;
/**
 * Сколько ближайших строк берёт векторная ветка до отсева по порогу и потолку на поставщика.
 * Зачем столько: крупные прайсы (десятки тысяч строк) забирают все 100 мест, и остальные
 * поставщики с тем же товаром не видны; замер на копии боевой базы (29.10.26) - топ-100 давал
 * 36 из 67 поставщиков, тысяча с потолком 3 строки - все 67.
 */
const VECTOR_CANDIDATES = 1000;
/** Сколько сырых строк берут ветки FTS и «начало слова» до потолка на поставщика. */
const BRANCH_RAW_CANDIDATES = 2000;
/** Потолок строк одного поставщика в каждой ветке: один прайс не вытесняет остальных. */
const BRANCH_ROWS_PER_SUPPLIER = 3;
/** Сколько строк прайса дозаполняется эмбеддингами после одного импорта. */
const IMPORT_EMBED_MAX_ROWS = 20_000;
/** События журнала. */
export const PRICE_EMBED_FILLED_EVENT = 'price_embeddings_filled';
export const PRICE_EMBED_FAILED_EVENT = 'price_embeddings_failed';
export const PRICE_SEARCH_EMBED_FAILED_EVENT = 'price_search_embed_failed';

/** Цены в PostgreSQL. */
export class PostgresPriceRepository implements PriceRepository {
  /**
   * Снимки прайсов поставщиков (R5-ADP-4): фиксация вызывает `listBySupplier` 3-4 раза подряд.
   * Версия снимка проверяется дешёвым запросом на каждый вызов, поэтому запись из другого
   * процесса устаревшее не отдаёт. Порядок вставки в `Map` = порядок вытеснения.
   */
  private readonly snapshots = new Map<string, PriceSnapshot>();
  private snapshotRows = 0;

  private readonly embedQuery: QueryEmbedder | undefined;
  private readonly passageEmbedder: Embedder | undefined;
  private readonly minCosine: number;
  private readonly log: PriceEmbedLog | undefined;
  /** Очередь фонового дозаполнения: проходы идут по одному, не нагружая сервис эмбеддингов. */
  private embedChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: PgClient,
    options: PriceRepositoryOptions = {},
  ) {
    this.embedQuery = toQueryEmbedder(options.embedder);
    const embedder = options.embedder;
    this.passageEmbedder =
      embedder === undefined || typeof embedder === 'function' ? undefined : embedder;
    this.minCosine = options.minCosine ?? DEFAULT_PRICE_MIN_COSINE;
    this.log = options.log;
  }

  /** Дождаться фонового дозаполнения эмбеддингов (тесты и остановка службы). */
  async embeddingsIdle(): Promise<void> {
    await this.embedChain;
  }

  /**
   * Дозаполнить эмбеддинги строк поставщика после импорта. Не ждёт и не бросает: вне горячего
   * пути импорта, а сбой эмбеддера оставляет строки без вектора до дозагрузки.
   */
  private scheduleEmbeddings(supplierId: string): void {
    const embedder = this.passageEmbedder;
    if (embedder === undefined) return;
    this.embedChain = this.embedChain.then(async () => {
      try {
        const done = await fillPriceEmbeddings(this.db, embedder, {
          supplierId,
          maxRows: IMPORT_EMBED_MAX_ROWS,
        });
        this.log?.(done.failed > 0 ? PRICE_EMBED_FAILED_EVENT : PRICE_EMBED_FILLED_EVENT, {
          filled: done.filled,
          failed: done.failed,
        });
      } catch {
        this.log?.(PRICE_EMBED_FAILED_EVENT, { filled: 0, failed: 0, error: 1 });
      }
    });
  }

  async saveImport(
    supplierId: string,
    items: PriceItem[],
    key: IdempotencyKey,
    options: SaveImportOptions = {},
  ): Promise<void> {
    const importHash = hashItems(items);
    this.dropSnapshot(supplierId);
    try {
      await this.saveImportInTransaction(supplierId, items, key, importHash, options);
    } finally {
      // После коммита (и после отката: состояние неизвестно) снимок выгружается заново.
      this.dropSnapshot(supplierId);
    }
    // Эмбеддинги новых строк - после коммита и вне транзакции: HTTP-вызов не должен держать
    // блокировку поставщика, а сбой сервиса не должен откатывать импорт.
    this.scheduleEmbeddings(supplierId);
  }

  private async saveImportInTransaction(
    supplierId: string,
    items: PriceItem[],
    key: IdempotencyKey,
    importHash: string,
    options: SaveImportOptions,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      // R9-A5-02: записи прайса одного поставщика идут по очереди. Без блокировки второй
      // импорт с другим ключом удалял бы только строки, видимые его снимку, и прайс
      // становился объединением двух импортов. Блокировка - первой командой транзакции.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `${IMPORT_LOCK_PREFIX}${supplierId}`,
      ]);
      // Первый запрос с ключом занимает его; повтор того же импорта (ждал блокировку) выходит.
      const claimed = await tx.query(
        `INSERT INTO idempotency_keys (scope, key) VALUES ($1, $2)
         ON CONFLICT DO NOTHING RETURNING key`,
        [IMPORT_SCOPE, key],
      );
      if (claimed.length === 0) return;
      // Сверка базы - после занятия ключа: повтор уже записанного импорта видит свою же
      // запись и должен выйти выше, а не получить «прайс изменился». Ошибка откатывает и ключ.
      if (options.isExpectedBase !== undefined) {
        const current = await tx.query(
          `SELECT ${COLUMNS} FROM price_items WHERE supplier_id = $1 ORDER BY id`,
          [supplierId],
        );
        if (!options.isExpectedBase(parsePriceRows(current))) {
          throw new PriceBaseChangedError(supplierId);
        }
      }
      await this.deleteReplaced(
        tx,
        supplierId,
        items,
        options.sourceFile,
        options.fileHistory,
        options.fileHash,
      );
      // Пакетами: одна строка на запрос - это тысячи обращений к базе на крупный прайс (R3-MEM-12).
      for (let from = 0; from < items.length; from += PRICE_IMPORT_BATCH_ROWS) {
        const batch = items.slice(from, from + PRICE_IMPORT_BATCH_ROWS);
        // Пакет одним JSON-параметром: число параметров не зависит от числа строк, порядок
        // вставки сохраняется (id растут вместе с порядком позиций).
        await tx.query(
          `INSERT INTO price_items
             (supplier_id, product_name, sku, price, currency, price_date,
              import_key, import_hash, price_tiers, price_qualifier, price_max,
              price_tier_basis, source_file)
           SELECT $1, e.value->>'productName', e.value->>'sku',
                  (e.value->>'price')::numeric, e.value->>'currency',
                  (e.value->>'date')::timestamptz, $2, $3, e.value->'priceTiers',
                  e.value->>'priceQualifier', (e.value->>'priceMax')::numeric,
                  COALESCE(e.value->>'priceTierBasis', 'quantity'),
                  COALESCE($5::text, e.value->>'sourceFile')
           FROM jsonb_array_elements($4::text::jsonb) WITH ORDINALITY AS e(value, ord)
           ORDER BY e.ord`,
          [
            supplierId,
            key,
            importHash,
            JSON.stringify(batch.map(toBatchRow)),
            options.sourceFile ?? null,
          ],
        );
      }
    });
  }

  /**
   * Удалить строки, которые заменяет импорт. Без файла - весь прайс поставщика (правка
   * сотрудника, слияние). С файлом - только этот файл и его старые версии (и строки без файла,
   * если у поставщика других файлов нет): другие прайс-линии поставщика остаются.
   */
  private async deleteReplaced(
    tx: PgClient,
    supplierId: string,
    incoming: readonly PriceItem[],
    sourceFile: string | undefined,
    fileHistory?: readonly string[],
    fileHash?: string,
  ): Promise<void> {
    if (sourceFile === undefined) {
      await tx.query('DELETE FROM price_items WHERE supplier_id = $1', [supplierId]);
      return;
    }
    const files = await tx.query(
      'SELECT DISTINCT source_file FROM price_items WHERE supplier_id = $1',
      [supplierId],
    );
    const existing = files.map((row) =>
      typeof row['source_file'] === 'string' ? row['source_file'] : null,
    );
    let plan = planSourceReplacement(existing, sourceFile, fileHistory);
    // sha256 входящего файла в import_key строк без файла - тот же файл импортировали раньше.
    if (!plan.replaceNull && existing.includes(null) && fileHash !== undefined) {
      if (await this.hasNullRowsFromFileIn(tx, supplierId, fileHash)) {
        plan = planSourceReplacement(existing, sourceFile, fileHistory, true);
      }
    }
    if (plan.newerFile !== null) throw new NewerPriceVersionError(supplierId, plan.newerFile);
    await tx.query(
      `DELETE FROM price_items
       WHERE supplier_id = $1
         AND ((source_file IS NULL AND $3::boolean) OR source_file = ANY($2::text[]))`,
      [supplierId, textArrayLiteral(plan.replaceFiles), plan.replaceNull],
    );
    if (plan.replaceNull || !existing.includes(null)) return;
    // Без доказательства строки без файла заменяются построчно: удаляются только те, чья позиция
    // есть во входящем наборе (обновление цены); остальные целы - происхождение неизвестно.
    const nullRows = await tx.query(
      'SELECT id, product_name, sku FROM price_items WHERE supplier_id = $1 AND source_file IS NULL',
      [supplierId],
    );
    const incomingKeys = new Set(incoming.map((item) => priceItemKey(item)));
    const ids = nullRows
      .filter((row) =>
        incomingKeys.has(
          priceItemKey({
            productName: String(row['product_name']),
            ...(typeof row['sku'] === 'string' ? { sku: row['sku'] } : {}),
          }),
        ),
      )
      .map((row) => String(row['id']));
    if (ids.length === 0) return;
    await tx.query('DELETE FROM price_items WHERE supplier_id = $1 AND id = ANY($2::bigint[])', [
      supplierId,
      textArrayLiteral(ids),
    ]);
  }

  async hasNullRowsFromFile(supplierId: string, fileHash: string): Promise<boolean> {
    return this.hasNullRowsFromFileIn(this.db, supplierId, fileHash);
  }

  private async hasNullRowsFromFileIn(
    db: PgClient,
    supplierId: string,
    fileHash: string,
  ): Promise<boolean> {
    // starts_with, а не LIKE: в id поставщика бывают `_` и `%`.
    const prefix = fileImportKeyPrefix(supplierId, fileHash);
    const rows = await db.query(
      `SELECT 1 FROM price_items
       WHERE supplier_id = $1 AND source_file IS NULL
         AND (import_key = $2 OR starts_with(import_key, $2 || ':base:'))
       LIMIT 1`,
      [supplierId, prefix],
    );
    return rows.length > 0;
  }

  async listBySupplier(supplierId: string): Promise<PriceItem[]> {
    const version = await this.versionOf(supplierId);
    const cached = this.snapshots.get(supplierId);
    if (cached !== undefined && cached.version === version) return copyItems(cached.items);
    // Признак НДС нужен шорт-листу (цены поставщика, названного человеком).
    const rows = await this.db.query(
      `SELECT ${COLUMNS_WITH_VAT} FROM price_items WHERE supplier_id = $1 ORDER BY id`,
      [supplierId],
    );
    const items = parsePriceRows(rows);
    // Версия до и после выгрузки совпала: между запросами прайс не менялся.
    if ((await this.versionOf(supplierId)) === version) {
      this.remember(supplierId, { version, items: copyItems(items) });
    }
    return items;
  }

  /**
   * Версия прайса поставщика: ключ и хэш импорта, число строк и последний id. Один небольшой
   * ответ вместо выгрузки всех строк; меняется при любой записи в прайс поставщика.
   */
  private async versionOf(supplierId: string): Promise<string> {
    const rows = await this.db.query(
      `SELECT import_key, import_hash, count(*)::text AS n, max(id)::text AS last_id
       FROM price_items WHERE supplier_id = $1
       GROUP BY import_key, import_hash ORDER BY import_key, import_hash`,
      [supplierId],
    );
    return JSON.stringify(rows);
  }

  private dropSnapshot(supplierId: string): void {
    const existing = this.snapshots.get(supplierId);
    if (existing === undefined) return;
    this.snapshotRows -= existing.items.length;
    this.snapshots.delete(supplierId);
  }

  private remember(supplierId: string, snapshot: PriceSnapshot): void {
    this.dropSnapshot(supplierId);
    if (snapshot.items.length > MAX_SNAPSHOT_ROWS) return;
    this.snapshots.set(supplierId, snapshot);
    this.snapshotRows += snapshot.items.length;
    for (const oldest of this.snapshots.keys()) {
      if (this.snapshots.size <= MAX_SNAPSHOT_SUPPLIERS && this.snapshotRows <= MAX_SNAPSHOT_ROWS) {
        break;
      }
      this.dropSnapshot(oldest);
    }
  }

  async searchProducts(query: string, limit: number): Promise<PriceItem[]> {
    const matched = matchedCte(query);
    matched.params[matched.params.length - 1] = limit;
    const rows = await this.db.query(
      `${matched.sql}
       SELECT ${COLUMNS} FROM matched ORDER BY ${COMPARABLE_PRICE_SQL}, id
       LIMIT ${matched.limitParam}`,
      matched.params,
    );
    return parseRows(priceRow, rows);
  }

  async searchSuppliersByProduct(
    query: string,
    limit: number,
    options: SupplierProductSearchOptions = {},
  ): Promise<PriceItem[]> {
    const matched = matchedCte(query, options.wordStart === true);
    matched.params[matched.params.length - 1] = limit;
    // Лучшая позиция поставщика в каждой валюте, затем порядок по месту внутри валюты:
    // USD и RUB по числу цены не сравниваются, лимит режет поставщиков, а не строки.
    // Сначала по каждой позиции поставщика остаётся строка самого свежего прайса (этап 161):
    // иначе старая дешёвая строка вытесняет актуальную цену той же позиции.
    const rows = await this.db.query(
      `${matched.sql},
       latest AS (
         SELECT DISTINCT ON (supplier_id, currency, lower(product_name), coalesce(sku, ''))
                id, ${COLUMNS_WITH_VAT}
         FROM matched
         ORDER BY supplier_id, currency, lower(product_name), coalesce(sku, ''),
                  price_date DESC, created_at DESC, id DESC
       ),
       best AS (
         SELECT DISTINCT ON (supplier_id, currency) ${COLUMNS_WITH_VAT}
         FROM latest ORDER BY supplier_id, currency, ${COMPARABLE_PRICE_SQL}, id
       ),
       ranked AS (
         SELECT *, row_number() OVER (
                  PARTITION BY currency ORDER BY ${COMPARABLE_PRICE_SQL}, supplier_id) AS place
         FROM best
       )
       SELECT ${COLUMNS_WITH_VAT} FROM ranked ORDER BY place, currency, supplier_id
       LIMIT ${matched.limitParam}`,
      matched.params,
    );
    return parseRows(priceRow, rows);
  }

  async searchRankedProducts(query: string, limit: number): Promise<PriceItem[]> {
    assertQueryText(query);
    const tokens = rankedSearchTokens(query);
    const vector = await this.queryVector(query);
    const params: PgParam[] = [
      normalizeProductName(query),
      vector === null ? null : toVectorLiteral(vector),
      BRANCH_CANDIDATES,
      this.minCosine,
      limit,
    ];
    // Ветка «начало слова»: все слова запроса (прежние условия, но не подстрока). Нужна, чтобы
    // «мед» находило «медовый», которого русская основа FTS не склеивает с «мед».
    const conditions = tokenConditions(tokens, true, params).join(' AND ');
    const sql = `WITH q AS (
  -- ИЛИ вместо И: у длинного названия позиции совпадения по всем словам почти не бывает,
  -- а ts_rank_cd поднимает строки с большим числом совпавших слов.
  SELECT CASE WHEN numnode(plainto_tsquery('russian', $1::text)) = 0 THEN NULL
         ELSE to_tsquery('russian', replace(plainto_tsquery('russian', $1::text)::text,
                                            '&', '|')) END AS tsq
),
fts_raw AS (
  SELECT p.id, p.supplier_id, ts_rank_cd(p.fts, q.tsq) AS r
  FROM price_items p, q
  WHERE q.tsq IS NOT NULL AND p.fts @@ q.tsq
  ORDER BY r DESC, p.id LIMIT ${BRANCH_RAW_CANDIDATES}
),
fts_hits AS (
  SELECT id, row_number() OVER (ORDER BY r DESC, id) AS rnk FROM (
    SELECT *, row_number() OVER (PARTITION BY supplier_id ORDER BY r DESC, id) AS k
    FROM fts_raw) x
  WHERE k <= ${BRANCH_ROWS_PER_SUPPLIER} ORDER BY rnk LIMIT $3::int
),
vec_raw AS (
  SELECT p.id, p.supplier_id, p.embedding <=> $2::vector AS dist
  FROM price_items p
  WHERE $2::vector IS NOT NULL AND p.embedding IS NOT NULL
  ORDER BY p.embedding <=> $2::vector LIMIT ${VECTOR_CANDIDATES}
),
vec_hits AS (
  SELECT id, row_number() OVER (ORDER BY dist, id) AS rnk FROM (
    SELECT *, row_number() OVER (PARTITION BY supplier_id ORDER BY dist, id) AS k
    FROM vec_raw WHERE 1 - dist >= $4::double precision) x
  WHERE k <= ${BRANCH_ROWS_PER_SUPPLIER} ORDER BY rnk LIMIT $3::int
),
word_raw AS (
  SELECT id, supplier_id, product_name FROM price_items WHERE ${conditions}
  ORDER BY length(product_name), id LIMIT ${BRANCH_RAW_CANDIDATES}
),
word_hits AS (
  SELECT id, row_number() OVER (ORDER BY length(product_name), id) AS rnk FROM (
    SELECT *, row_number() OVER (
             PARTITION BY supplier_id ORDER BY length(product_name), id) AS k
    FROM word_raw) x
  WHERE k <= ${BRANCH_ROWS_PER_SUPPLIER} ORDER BY rnk LIMIT $3::int
),
fused AS (
  SELECT u.id, sum(1.0 / (${RRF_K} + u.rnk))::double precision AS score
  FROM (SELECT id, rnk FROM fts_hits UNION ALL SELECT id, rnk FROM vec_hits
        UNION ALL SELECT id, rnk FROM word_hits) u
  GROUP BY u.id
),
top AS (
  SELECT p.id, f.score, p.supplier_id, p.product_name, p.sku, row_number() OVER (
           ORDER BY f.score DESC,
             -- Равная релевантность: диск выше почты; только порядок, оценка и порог не меняются.
             (CASE WHEN p.source_file LIKE '${DISK_PRICE_SOURCE_PREFIX}%' THEN ${DISK_SOURCE_RANK}
                   ELSE ${OTHER_SOURCE_RANK} END),
             p.price, p.id) AS ord
  FROM fused f JOIN price_items p ON p.id = f.id
),
picked AS (SELECT * FROM top ORDER BY ord LIMIT $5::int),
-- Та же позиция того же поставщика из других прайсов (этап 161): потолок строк на поставщика
-- в ветках мог оставить только одну из версий, а свежесть выбирается между всеми версиями.
siblings AS (
  SELECT DISTINCT ON (s.id) s.id, pk.ord FROM picked pk
  JOIN price_items s ON s.supplier_id = pk.supplier_id
   AND lower(s.product_name) = lower(pk.product_name)
   AND coalesce(s.sku, '') = coalesce(pk.sku, '')
  WHERE s.id NOT IN (SELECT id FROM picked)
  ORDER BY s.id, pk.ord
),
result AS (
  SELECT id, ord, 0 AS part FROM picked
  UNION ALL SELECT id, ord, 1 AS part FROM siblings
)
SELECT ${COLUMNS_WITH_VAT.split(', ').map((column) => `p.${column}`).join(', ')}, p.created_at
FROM result r JOIN price_items p ON p.id = r.id
ORDER BY r.part, r.ord, p.id`;
    // Поиск по HNSW берёт `ef_search` кандидатов; значение действует только внутри транзакции.
    const rows = await this.db.transaction(async (tx) => {
      await tx.query("SELECT set_config('hnsw.ef_search', $1::text, true)", [
        String(HNSW_EF_SEARCH),
      ]);
      return tx.query(sql, params);
    });
    return parseRows(priceRow, rows);
  }

  /** Вектор запроса либо null (нет эмбеддера или он недоступен): тогда ветки FTS и слова. */
  private async queryVector(query: string): Promise<readonly number[] | null> {
    if (this.embedQuery === undefined) return null;
    try {
      const vector = await this.embedQuery(query);
      assertDimensions(vector);
      return vector;
    } catch {
      this.log?.(PRICE_SEARCH_EMBED_FAILED_EVENT, { fallback: 'fts_word_start' });
      return null;
    }
  }

  async listBySku(sku: string, limit: number): Promise<PriceItem[]> {
    const wanted = normalizeSku(sku);
    if (wanted === '') return [];
    const rows = await this.db.query(
      `SELECT ${COLUMNS} FROM price_items
       WHERE sku IS NOT NULL AND ${SKU_NORM_SQL} = $1::text
       ORDER BY id LIMIT $2::int`,
      [wanted, limit],
    );
    return parseRows(priceRow, rows);
  }

  async listBySkus(
    skus: readonly string[],
    limitPerSku: number,
  ): Promise<Map<string, PriceItem[]>> {
    // Пакетом `= ANY($1)` по индексу price_items_sku_norm_idx вместо запроса на артикул
    // (R5-DB-2). Для каждого артикула результат тот же, что у `listBySku`: первые
    // `limitPerSku` строк по id среди совпавших по нормализованному ключу.
    const result = new Map<string, PriceItem[]>();
    const keyOf = new Map<string, string>();
    for (const sku of new Set(skus)) {
      const key = normalizeSku(sku);
      keyOf.set(sku, key);
      result.set(sku, []);
    }
    const keys = [...new Set([...keyOf.values()].filter((key) => key !== ''))];
    const byKey = new Map<string, PriceItem[]>();
    for (let from = 0; from < keys.length; from += SKU_BATCH_SIZE) {
      const chunk = keys.slice(from, from + SKU_BATCH_SIZE);
      const rows = await this.db.query(
        `SELECT sku_key, ${COLUMNS} FROM (
           SELECT ${SKU_NORM_SQL} AS sku_key, ${COLUMNS},
                  row_number() OVER (PARTITION BY ${SKU_NORM_SQL} ORDER BY id) AS place,
                  id
           FROM price_items
           WHERE sku IS NOT NULL AND ${SKU_NORM_SQL} = ANY($1::text[])
         ) found
         WHERE place <= $2::int
         ORDER BY sku_key, id`,
        [textArrayLiteral(chunk), limitPerSku],
      );
      for (const row of rows) {
        const key = String(row['sku_key']);
        const list = byKey.get(key) ?? [];
        list.push(...parseRows(priceRow, [row]));
        byKey.set(key, list);
      }
    }
    for (const [sku, key] of keyOf) {
      // Копия списка: два исходных артикула с одним ключом не делят массив.
      if (key !== '') result.set(sku, [...(byKey.get(key) ?? [])]);
    }
    return result;
  }
}
