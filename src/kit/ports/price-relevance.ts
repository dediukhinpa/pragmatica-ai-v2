/**
 * Проверка соответствия строк прайсов позиции заявки (этапы 121 и 135). Строки найдены поиском
 * по словам и смыслу, поэтому среди них бывает другой товар («Стеклянный медальон» на «мёд»,
 * «Сокочай ... и Мёд» на «мёд») или тот же товар не того года, объёма, ёмкости. Модель ходит
 * через шлюз псевдонимизации; в запрос уходят только позиция заявки и названия товаров - без
 * поставщиков, цен, артикулов и контактов. Ответ - сырой JSON: проверяет код вызывающей стороны.
 * Ошибка - обычное исключение: вызывающий код оставляет строки как есть.
 */

/** Оценки соответствия названия позиции заявки; промах по обязательному признаку - `wrong`. */
export const PRICE_GRADES = ['exact', 'analog', 'wrong'] as const;
export type PriceGrade = (typeof PRICE_GRADES)[number];

/** Название строки прайса с явным ключом (`p1`, `p2`...): модель отвечает по ключу, не по счёту. */
export interface PriceRelevanceName {
  key: string;
  name: string;
}

/** Позиция заявки и названия строк прайсов, найденных для неё. */
export interface PriceRelevanceItem {
  /** Номер позиции во входе; в ответе модель называет его же. */
  item: number;
  position: string;
  /**
   * Характеристики позиции из задачи (материал, формат, нанесение...). Без них название вроде
   * «шоперы» подходит любой сумке; нет требований - позиция проверяется по названию.
   */
  requirements?: string | undefined;
  names: PriceRelevanceName[];
}

export interface PriceRelevanceInput {
  items: PriceRelevanceItem[];
}

export interface PriceRelevanceOptions {
  /** Сигнал отмены: срабатывает по таймауту, ответ после него уже не ждут. */
  signal: AbortSignal;
}

/** Одним вызовом оценивает названия по каждой позиции из входа. */
export interface PriceRelevanceChecker {
  /**
   * Сырой объект `{results: [{item, grades: [{key, grade, reason?}]}]}` от модели (reason -
   * только у exact и analog); проверяет вызывающий код (Zod): неизвестные ключи отбрасываются,
   * пропущенные ключи - не проверены.
   */
  check(input: PriceRelevanceInput, options: PriceRelevanceOptions): Promise<unknown>;
}
