import type { SupplierRatingFacts } from '../domain/supplier-rating-facts';
import type { SupplierRatingVerdict } from '../domain/supplier-rating-verdict';

/** Параметры оценки. */
export interface SupplierRateOptions {
  /** Сигнал отмены: срабатывает по таймауту, ответ после него уже не ждут. */
  signal: AbortSignal;
}

/**
 * Оценка поставщика по фактам его карточки (ТЗ, разд. 4: рейтинг считается вместе с моделью).
 * Вход - только факты (`SupplierRatingFacts`, без ФИО, контактов и реквизитов), выход - целая
 * оценка 1..5 и короткое обоснование, уже проверенные кодом. Реализация, которая отправляет
 * факты внешней модели, обязана идти через `PseudonymizingModelGateway`, а тексты фактов не
 * писать в журналы. Ошибка (в том числе неверный ответ модели) - обычное исключение:
 * вызывающий код переходит на запасное правило.
 */
export interface SupplierRater {
  rate(facts: SupplierRatingFacts, options: SupplierRateOptions): Promise<SupplierRatingVerdict>;
}
