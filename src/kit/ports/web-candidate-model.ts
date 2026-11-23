import type { WebSiteLink } from '@business-ai/core';

/**
 * Модельные помощники веб-поиска поставщиков (ТЗ, разд. 3). Оба идут через
 * `PseudonymizingModelGateway`: тексты заявки и страниц уходят модели с токенами вместо ПДн и
 * контактов, а ответ приходит с восстановленными значениями. Ответы - сырой JSON: проверяет
 * код вызывающей стороны, портам верить нельзя. Ошибка - обычное исключение: вызывающий код
 * переходит на запасной путь (названия позиций, кандидат без обогащения).
 */

/** Позиция заявки в задаче планировщика. */
export interface WebPlanItem {
  name: string;
  /** Нет количества в заявке - поля нет, модели не подсказываем число. */
  quantity?: number | undefined;
  unit: string;
  /** Характеристики товара из задачи (без ПДн): по ним строят запросы и судят о выдаче. */
  requirements?: string | undefined;
}

/** Что известно о заявке: позиции и поля формы (ключ -> значение). */
export interface WebQueryPlanInput {
  items: WebPlanItem[];
  /** Вид запроса (код формы) либо пусто. */
  kind?: string | undefined;
  fields: Readonly<Record<string, string>>;
}

export interface WebModelOptions {
  /** Сигнал отмены: срабатывает по таймауту, ответ после него уже не ждут. */
  signal: AbortSignal;
}

/** Составляет 1-3 поисковых запроса по заявке и полям формы (сайты выбирает сам). */
export interface WebQueryPlanner {
  /** Сырой список запросов от модели; проверяет вызывающий код. */
  plan(input: WebQueryPlanInput, options: WebModelOptions): Promise<unknown>;
}

/** Страница кандидата: название, адрес и тексты, найденные поиском (недоверенные данные). */
export interface WebCandidatePage {
  name: string;
  url: string;
  texts: string[];
  /** Название искомого товара (для поиска цены на странице); данных заявки сверх него нет. */
  product?: string | undefined;
  /**
   * Позиции заявки (только названия): цена со страницы ищется по каждой отдельно. Количеств,
   * сроков и прочих данных заявки здесь нет.
   */
  items?: string[] | undefined;
  /**
   * Характеристики позиций из задачи (материал, формат, нанесение): страница, где товар
   * иной, получает цену с пометкой «похожий товар» (exact=false), а не точную.
   */
  itemRequirements?: Array<{ item: string; requirements: string }> | undefined;
}

/** Извлекает со страницы город, контакты, цену и срок. */
export interface WebCandidateEnricher {
  /** Сырой объект сведений от модели; проверяет `parseWebPageFacts`. */
  extract(page: WebCandidatePage, options: WebModelOptions): Promise<unknown>;
}

/**
 * Хит выдачи для классификации: домен, заголовок и фрагмент. Контактов здесь нет: код вырезает
 * телефоны, почту и ссылки до вызова, а токены ПДн ставит шлюз псевдонимизации.
 */
export interface WebHitDigest {
  domain: string;
  title: string;
  snippet: string;
}

/** Что классифицируем: позиции заявки и хиты выдачи, склеенные по домену. */
export interface WebHitClassifyInput {
  items: WebPlanItem[];
  hits: WebHitDigest[];
}

/** Одним вызовом отвечает по каждому домену: тот ли это товар и что за компания. */
export interface WebHitClassifier {
  /** Сырой объект `{results: [...]}` от модели; проверяет вызывающий код (Zod). */
  classify(input: WebHitClassifyInput, options: WebModelOptions): Promise<unknown>;
}

/** Вход выбора страниц сайта: что не нашлось на прочитанных и ссылки главной. */
export interface SitePagesChoiceInput {
  site: string;
  /** Чего не хватает: контактов (телефон, почта) и/или цен позиций. */
  need: { contacts: boolean; prices: boolean };
  /** Названия позиций заявки (для поиска страницы с ценами); пусто - цены не нужны. */
  items: string[];
  links: WebSiteLink[];
}

/**
 * Модель выбирает по подписям и адресам ссылок главной 1-2 страницы, где вероятнее контакты
 * или цены (страница контактов без слова «контакты» в меню, нестандартный адрес). Ответ -
 * сырой JSON: адрес обязан быть из присланного списка, это проверяет вызывающий код.
 */
export interface SitePagePicker {
  /** Сырой `{"urls":["<адрес из списка>", ...]}`; проверяет вызывающий код. */
  pickPages(input: SitePagesChoiceInput, options: WebModelOptions): Promise<unknown>;
}

/** Результат поиска для выбора сайта: заголовок, адрес, фрагмент (без контактов). */
export interface SupplierSiteHit {
  title: string;
  url: string;
  snippet: string;
}

/** Что известно о карточке поставщика базы: название, город и товары из его прайса. */
export interface SupplierNameInput {
  name: string;
  city?: string | undefined;
  /** До нескольких названий товаров из прайса поставщика: по ним видно, чем он торгует. */
  products: string[];
}

/** Вход выбора сайта: карточка и отобранные кодом результаты поиска. */
export interface SupplierSiteChoiceInput extends SupplierNameInput {
  hits: SupplierSiteHit[];
}

/**
 * Модель по названию карточки базы: 1) похоже ли оно на название компании или бренда (а не
 * категорию товара из имени файла прайса); 2) какой из результатов поиска - официальный сайт
 * этой компании. Ответы - сырой JSON: проверяет код (адрес обязан быть из присланного списка).
 */
export interface SupplierSiteChooser {
  /** Сырой `{"isCompany":true|false}`; проверяет вызывающий код. */
  checkName(input: SupplierNameInput, options: WebModelOptions): Promise<unknown>;
  /** Сырой `{"site":"<адрес из списка>"|null}`; проверяет вызывающий код. */
  chooseSite(input: SupplierSiteChoiceInput, options: WebModelOptions): Promise<unknown>;
}
