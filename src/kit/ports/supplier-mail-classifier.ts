import { DomainError } from '@business-ai/core';

/** Все виды письма (для проверки данных извне и контрактных тестов). */
export const SUPPLIER_MAIL_KINDS = ['supplier', 'newsletter', 'customer', 'other'] as const;

/**
 * Вид письма: `supplier` - письмо поставщика (предложение, прайс, знакомство, условия);
 * `newsletter` - массовая рассылка и реклама; `customer` - письмо клиента или покупателя;
 * `other` - всё прочее (служебное, личное, непонятное).
 */
export type SupplierMailKind = (typeof SUPPLIER_MAIL_KINDS)[number];

/** Сколько категорий продукции модель может назвать по одному письму. */
export const SUPPLIER_MAIL_MAX_CATEGORIES = 5;

/**
 * Что отдаётся на классификацию. Адреса отправителя и получателей сюда не входят (только
 * домен отправителя). Тема, текст и имена вложений - недоверенный текст: ответ влияет только на
 * решение «разбирать ли письмо дальше», инструментов у модели нет, а каждое значение из ответа
 * код всё равно проверяет по тексту письма. Реализация, которая отправляет эти тексты внешней
 * модели, обязана пропускать их через псевдонимизацию (обёртка `PseudonymizingModelGateway`), а
 * сами тексты не писать в журналы, аудит и очередь задач.
 */
export interface SupplierMailClassificationInput {
  subject: string;
  /** Начало текста письма (код ограничивает длину). */
  body: string;
  /** Имена вложений. */
  attachmentNames: readonly string[];
  /** Домен отправителя (не адрес): пустой, если домена нет. */
  senderDomain: string;
}

/**
 * Результат классификации. Название и категории - слова из самого письма (код проверит их по
 * тексту дословно); пересказа и пояснений в ответе нет, чтобы в журнал и состояние не попало
 * ничего лишнего.
 */
export interface SupplierMailClassification {
  kind: SupplierMailKind;
  /**
   * В письме есть сведения о поставщике (название, реквизиты, контакты, ассортимент, условия).
   * Истинно только при `kind=supplier`.
   */
  hasSupplierInfo: boolean;
  /** Название организации-поставщика как в письме; нет - модель его не назвала. */
  companyName?: string;
  /** Категории продукции словами письма, не больше `SUPPLIER_MAIL_MAX_CATEGORIES`. */
  categories: readonly string[];
}

/** Параметры вызова классификации. */
export interface SupplierMailClassifyOptions {
  /** Сигнал отмены: срабатывает по таймауту классификации. */
  signal: AbortSignal;
}

/**
 * Классификатор входящих писем: «от поставщика ли письмо и есть ли в нём сведения о
 * поставщике». Общий порт для разбора почты: ящик info@ (этап 220) и обзор почты сотрудников
 * (этап 222). Ошибка и недоступность классификатора - обычные исключения: вызывающий код
 * пропускает письмо без записи.
 */
export interface SupplierMailClassifier {
  /**
   * Классифицировать письмо. Реализация обязана прервать работу (и запрос к модели) при
   * `options.signal`: по таймауту вызывающий код отменяет сигнал и ответ не ждёт.
   */
  classify(
    input: SupplierMailClassificationInput,
    options: SupplierMailClassifyOptions,
  ): Promise<SupplierMailClassification>;
}

/**
 * Неразборчивый, не по схеме или противоречивый ответ модели. Это сбой оценки конкретного
 * письма, а не отказ шлюза: вызывающий код повторяет оценку в следующий проход, но ограниченное
 * число раз (письмо, на котором модель стабильно ошибается, не должно держать ящик вечно).
 * Текст письма и ответа в сообщение не попадает.
 */
export class SupplierMailInvalidAnswerError extends DomainError {
  constructor(message = 'supplier_mail_classify_invalid_answer') {
    super('external_failure', message, { retryable: true });
    this.name = 'SupplierMailInvalidAnswerError';
  }
}
