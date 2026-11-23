import type {
  DuplicateCandidate,
  DuplicateMatch,
  SupplierCard,
  SupplierNote,
} from '../domain/supplier-card';
import type { PriceItem, PurchaseRequest, Supplier } from '../domain/models';
import type { IdempotencyKey } from '@business-ai/core';

/** Поставщики. */
export interface SupplierRepository {
  /** Создать или обновить поставщика. */
  upsert(supplier: Supplier): Promise<void>;
  /** Поставщик по id; null, если нет. */
  get(id: string): Promise<Supplier | null>;
  /** Поиск по подстроке названия (без учёта регистра). */
  search(query: string, limit: number): Promise<Supplier[]>;
  /**
   * Правило «адрес -> поставщик» для почты: все поставщики, у которых заданный адрес -
   * прежний `email` либо адрес ЛЮБОГО контакта (регистр и пробелы по краям не важны). Это
   * единственный способ привязать письмо к поставщику: перечень из `search` обрезан лимитом
   * и поставщиков «в хвосте» не содержит. Без усечения: поставщик найден независимо от
   * размера базы. Адреса приводятся к нижнему регистру, пустые и повторы отбрасываются;
   * ответ - пары (нормализованный адрес, поставщик), один адрес у нескольких поставщиков
   * даёт все пары (вызывающий решает, что делать с неоднозначностью). Порядок: название
   * поставщика, id, адрес. Ответ не содержит адресов, которых нет в базе.
   */
  findByAddresses(addresses: readonly string[]): Promise<SupplierAddressMatch[]>;
  /**
   * Страница полного обхода: до `limit` поставщиков с `id` строго больше `afterId`
   * (`null` - с начала), по возрастанию `id`. Обход до пустой страницы видит всех
   * поставщиков без лимита выборки (в отличие от `search`).
   */
  listPage(afterId: string | null, limit: number): Promise<Supplier[]>;
  /**
   * Карточка поставщика целиком; null, если нет. У записи без сохранённых контактов, но с
   * `email`/`contactName` основной контакт выводится из них. Заметки - последние
   * `SUPPLIER_NOTES_READ_LIMIT` в порядке добавления.
   */
  getCard(id: string): Promise<SupplierCard | null>;
  /**
   * Карточки пачкой (как `getCard`, без запроса на каждую): в порядке `ids`, повторы
   * схлопываются, отсутствующие пропускаются.
   */
  getCards(ids: readonly string[]): Promise<SupplierCard[]>;
  /**
   * Создать или заменить карточку целиком (поля, контакты) в одной транзакции. Карточка
   * нормализуется и проверяется (`validateSupplierCard`, реквизиты): замечания -
   * `invalid_input`, в хранилище ничего не попадает. Заметки только добавляются (повтор той
   * же заметки не дублируется), существующие не удаляются. `createdBy`/`createdAt` у
   * существующей карточки сохраняются, пустые `updatedAt`/`updatedBy` заполняются временем
   * записи и прежним значением. `email`/`contactName` записи становятся данными основного
   * контакта. Возвращает сохранённую карточку.
   *
   * Защита от потерянного обновления (`options`, необязательно; без них поведение прежнее -
   * замена). Запись одной карточки сериализуется по её id.
   * @throws DomainError `conflict` - `createOnly`, а карточка с таким id уже есть, либо
   *   `expectedUpdatedAt` не совпал с `updatedAt` сохранённой карточки (её изменили после
   *   чтения); `not_found` - задан `expectedUpdatedAt`, а карточки нет.
   */
  saveCard(card: SupplierCard, options?: SaveCardOptions): Promise<SupplierCard>;
  /**
   * Поиск карточек: все заданные условия действуют вместе. `query` - подстрока названия,
   * `inn` - точное совпадение (цифры), `email` - точное совпадение с адресом любого контакта
   * или прежним `email` (регистр не важен), `category` и `brand` - подстрока элемента списка.
   * Без условий - все карточки. Порядок: название, id.
   */
  searchCards(query: SupplierCardQuery): Promise<SupplierCard[]>;
  /**
   * Возможные дубли кандидата: тот же ИНН, тот же email (любой контакт или прежний) либо то
   * же нормализованное название. Запись с `candidate.id` дублем не считается. Порядок:
   * сначала совпавшие по ИНН, затем по email, затем по названию; внутри - по названию.
   */
  findDuplicates(candidate: DuplicateCandidate): Promise<DuplicateMatch[]>;
  /**
   * Добавить заметку к карточке. Идемпотентно: заметка с тем же текстом, автором и моментом
   * `createdAt` у карточки уже есть - ничего не меняется (повтор после сбоя не дублирует).
   * @throws DomainError `not_found` - нет такого поставщика; `invalid_input` - пустой или
   *   слишком длинный текст.
   */
  addNote(supplierId: string, note: SupplierNote): Promise<void>;
}
/** Совпадение адреса с поставщиком (см. `SupplierRepository.findByAddresses`). */
export interface SupplierAddressMatch {
  /** Адрес в нормализованном виде (нижний регистр, без пробелов по краям). */
  address: string;
  supplier: Supplier;
}
/** Условия записи карточки (см. `SupplierRepository.saveCard`). */
export interface SaveCardOptions {
  /** Только создание: существующую карточку с этим id не заменять. */
  createOnly?: boolean | undefined;
  /** `updatedAt` карточки, на которой построена запись (оптимистичная проверка версии). */
  expectedUpdatedAt?: string | undefined;
}
/** Режим поиска поставщиков по товару (см. `PriceRepository.searchSuppliersByProduct`). */
export interface SupplierProductSearchOptions {
  /**
   * `true` - токен ищется по началу слова (с окончанием у коротких), а не любой подстрокой:
   * «мед» не находит «медаль». Нужен ослабленному поиску по значимым словам заявки.
   */
  wordStart?: boolean | undefined;
}
/** Условия поиска карточек (см. `SupplierRepository.searchCards`). */
export interface SupplierCardQuery {
  query?: string | undefined;
  inn?: string | undefined;
  email?: string | undefined;
  category?: string | undefined;
  brand?: string | undefined;
  /**
   * `true` - `query`, `category` и `brand` ищутся по началу слова (см. `wordStartPattern`), а не
   * любой подстрокой: короткое «мед» не должно ловить «Медаль» и «медный».
   */
  wordStart?: boolean | undefined;
  limit: number;
}
/** Условия записи импорта прайса (см. `PriceRepository.saveImport`). */
export interface SaveImportOptions {
  /**
   * Проверка базы, от которой шли сверки импорта (скачки цен, подтверждения): получает прайс
   * поставщика, каким он стал к моменту записи (под блокировкой по поставщику). `false` -
   * прайс изменился после сверки (параллельный импорт или правка): запись не идёт,
   * `DomainError('conflict')` без частичной записи.
   */
  isExpectedBase?: ((current: readonly PriceItem[]) => boolean) | undefined;
  /**
   * Файл прайса (путь от корня диска), из которого идёт импорт. Задан - заменяются только строки
   * этого файла и его более старых версий (`planSourceReplacement`), строки других файлов
   * поставщика не трогаются; все вставляемые строки получают этот `source_file`. Более новая
   * версия того же потока в базе - `DomainError('conflict')`, прайс прежний. Не задан - прайс
   * поставщика заменяется целиком, строки сохраняют свой `sourceFile` (правка сотрудника,
   * слияние карточек).
   */
  sourceFile?: string | undefined;
  /**
   * Файлы, которые по истории импортов уже брались для поставщика (пути от корня диска). Нужны
   * правилу строк без файла: если история указывает на другой поток, эти строки не заменяются.
   * Не задан - истории нет.
   */
  fileHistory?: readonly string[] | undefined;
  /**
   * sha256 входящего файла. Строки без файла, записанные импортом этого же файла (sha256 -
   * третья часть их `import_key`), заменяются: это положительное доказательство происхождения.
   */
  fileHash?: string | undefined;
}
/** Цены. */
export interface PriceRepository {
  /**
   * Заменить прайс поставщика результатом импорта. Идемпотентно по ключу импорта; записи
   * одного поставщика сериализуются. Прайс изменился после сверки (`isExpectedBase`) -
   * `DomainError('conflict')`, прайс в базе прежний. С `options.sourceFile` замена идёт в
   * пределах файла, а не всего поставщика.
   */
  saveImport(
    supplierId: string,
    items: PriceItem[],
    key: IdempotencyKey,
    options?: SaveImportOptions,
  ): Promise<void>;
  /**
   * Есть ли у поставщика строки без файла, записанные импортом файла с этим sha256 (по
   * `import_key`). Нужно проверке импорта: область замены считается так же, как при записи.
   */
  hasNullRowsFromFile(supplierId: string, fileHash: string): Promise<boolean>;
  /** Цены поставщика. */
  listBySupplier(supplierId: string): Promise<PriceItem[]>;
  /** Поиск цен по подстроке названия товара или артикулу. */
  searchProducts(query: string, limit: number): Promise<PriceItem[]>;
  /**
   * Поиск поставщиков по названию товара: лучшая (самая дешёвая) позиция каждого поставщика
   * в каждой валюте. Лимит считается по поставщикам, а не по строкам: один поставщик с десятком
   * вариантов не вытесняет остальных. Цены разных валют не сравниваются: порядок задаётся
   * местом поставщика внутри своей валюты. Пустой запрос - `validation_failed`.
   */
  searchSuppliersByProduct(
    query: string,
    limit: number,
    options?: SupplierProductSearchOptions,
  ): Promise<PriceItem[]>;
  /**
   * Строки прайсов, подходящие под название товара, в порядке убывания близости (не по цене и
   * не по поставщикам: одна строка на позицию прайса, до `limit` строк). Гибридный поиск (этап
   * 121): полнотекстовый + вектор + начало слова, слитые по RRF; «мед» находит «мёд», «меда»,
   * «медовый», но не «медальон». Товары для сравнения с позицией заявки; слова упаковки
   * вызывающий код убирает из `query` заранее. Пустой запрос - `validation_failed`. Нет
   * эмбеддингов (сервис недоступен, строки не дозагружены) - работают остальные ветки.
   */
  searchRankedProducts(query: string, limit: number): Promise<PriceItem[]>;
  /**
   * Позиции с ТОЧНЫМ артикулом (сравнение по `normalizeSku`: регистр, тире, NFKC), а не поиск
   * по подстроке; цена, валюта и поставщик каждой. Пустой артикул - пустой результат.
   */
  listBySku(sku: string, limit: number): Promise<PriceItem[]>;
  /**
   * Пакетный `listBySku`: для каждого артикула из `skus` результат такой же, как у
   * `listBySku(sku, limitPerSku)`. Ключ карты - артикул как передан; повторы артикулов
   * допустимы. Один проход вместо запроса на каждый артикул.
   */
  listBySkus(skus: readonly string[], limitPerSku: number): Promise<Map<string, PriceItem[]>>;
}
/** Заявки на расчёт. */
export interface PurchaseRequestRepository {
  /** Сохранить заявку. Идемпотентно по `request.id`: повтор не меняет первую запись. */
  save(request: PurchaseRequest): Promise<void>;
  /** Заявка по id; null, если нет. */
  get(id: string): Promise<PurchaseRequest | null>;
  /** Заявки сделки в порядке создания. */
  listByDeal(dealRef: string): Promise<PurchaseRequest[]>;
}
