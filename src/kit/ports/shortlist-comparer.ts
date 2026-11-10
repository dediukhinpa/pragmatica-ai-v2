import type { ShortlistCompareFacts } from '../domain/shortlist-compare';

/** Параметры сравнения. */
export interface ShortlistCompareOptions {
  /** Сигнал отмены: срабатывает по таймауту, ответ после него уже не ждут. */
  signal: AbortSignal;
}

/**
 * Сравнение кандидатов шорт-листа моделью (решение владельца 28.10: срок, затем стоимость,
 * затем рейтинг). Вход - только факты сравнения под короткими кодами (`c1`, `p1`): ни названий,
 * ни ФИО, телефонов и почты. Реализация, отправляющая факты внешней модели, обязана идти через
 * `PseudonymizingModelGateway`. Ответ - сырой объект `{order: [...]}`: проверяет вызывающий код
 * (`applyModelOrder`), порту верить нельзя. Ошибка - обычное исключение: порядок строит правило.
 */
export interface ShortlistComparer {
  compare(facts: ShortlistCompareFacts, options: ShortlistCompareOptions): Promise<unknown>;
}
