/** Все вердикты (для проверки данных извне и контрактных тестов). */
export const PRICE_MAIL_VERDICTS = ['relevant', 'not_relevant'] as const;

/**
 * Вердикт оценки письма: «это повышение или изменение цен» - `relevant` (да) или `not_relevant`
 * (нет). Решает, уходит ли уведомление сотруднику.
 */
export type PriceMailVerdict = (typeof PRICE_MAIL_VERDICTS)[number];

/**
 * Коды причины вердикта. Только код: пояснения текстом нет, чтобы в журнал и состояние не
 * попало ничего из письма.
 *  - `price_change_announced` - поставщик сообщает об изменении цен или присылает новый прайс;
 *  - `unrelated_mention` - слова о ценах есть, но письмо о другом (счёт, ответ на вопрос);
 *  - `newsletter` - рекламная или информационная рассылка без изменения цен;
 *  - `other_company` - письмо не от названного поставщика (случайное совпадение названия);
 *  - `undetermined` - определить не удалось, письмо оставлено как значимое.
 */
export const PRICE_MAIL_ASSESSMENT_REASONS = [
  'price_change_announced',
  'unrelated_mention',
  'newsletter',
  'other_company',
  'undetermined',
] as const;

/** Код причины вердикта. */
export type PriceMailAssessmentReason = (typeof PRICE_MAIL_ASSESSMENT_REASONS)[number];

/**
 * Что отдаётся на оценку. Письмо уже прошло кодовый фильтр: поставщик определён (по адресу
 * отправителя или по названию в тексте), признак изменения цен найден. Адреса отправителя и
 * получателей сюда не входят. Тема, текст и вложения - недоверенный текст: ответ влияет только
 * на уведомление, инструментов у модели нет.
 * Реализация, которая отправляет эти тексты внешней модели, обязана пропускать их через
 * псевдонимизацию (обёртка `PseudonymizingModelGateway`), а сами тексты не писать в журналы,
 * аудит и очередь задач.
 */
export interface PriceMailAssessmentInput {
  subject: string;
  /** Начало текста письма (код ограничивает длину). */
  body: string;
  /** Имена вложений. */
  attachmentNames: readonly string[];
  /** Какие признаки нашёл кодовый фильтр (`price_increase`, `price_change`, `new_price`). */
  triggerIds: readonly string[];
  /** Название найденного поставщика из базы: модель подтверждает, что письмо от него. */
  supplierName: string;
  /** Поставщик определён по названию в тексте (адрес отправителя не из базы). */
  matchedByName: boolean;
  /**
   * Текст вложений (таблицы, pdf), извлечённый кодом и обрезанный по лимитам. Пусто, если
   * вложений нет или текст извлечь не удалось.
   */
  attachmentText: string;
}

/** Результат оценки. */
export interface PriceMailAssessment {
  verdict: PriceMailVerdict;
  reason: PriceMailAssessmentReason;
}

/**
 * Необязательная оценка письма моделью поверх кодового фильтра. Вызывается только для писем,
 * уже прошедших фильтр: `relevant` - уведомление уходит, `not_relevant` - нет. Ошибка и
 * недоступность оценки не скрывают письмо: вызывающий код уведомляет, как если бы оценки не было.
 */
export interface PriceMailAssessor {
  /**
   * Оценить письмо; ошибки - обычные исключения (код тексты из них не использует).
   * Реализация обязана прервать работу (и запрос к модели) при `options.signal`: по таймауту
   * вызывающий код отменяет сигнал и ответ уже не ждёт.
   */
  assess(
    input: PriceMailAssessmentInput,
    options: PriceMailAssessOptions,
  ): Promise<PriceMailAssessment>;
}

/** Параметры вызова оценки. */
export interface PriceMailAssessOptions {
  /** Сигнал отмены: срабатывает по таймауту оценки. */
  signal: AbortSignal;
}
