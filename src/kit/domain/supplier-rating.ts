import type { SupplierCard, SupplierStatus } from './supplier-card';
import type { SupplierRatingFacts } from './supplier-rating-facts';

/**
 * Рейтинг поставщика (ТЗ, разд. 4: «общая оценка на основании информации о поставщике в базе
 * знаний»). Формулы у заказчика нет, поэтому рейтинг считается вместе с моделью по фактам
 * карточки (`supplier-rating-facts.ts`). Это правило - запасной путь: оно работает, когда
 * модель отключена, недоступна или ответила неверно, и в тестовой сборке. Описание - в
 * docs/ARCHITECTURE.md («Шорт-лист»). Нет ни одного оценочного сведения - «нет оценки», а не
 * ноль, и модель для этого не вызывается.
 *
 * Оценочные поля карточки (разд. 10.9 ТЗ): сильные и слабые стороны, процент брака; тип
 * поставщика (разд. 10.1) - статус. Остальные сведения 10.9 (рекламации, преимущества,
 * заказчики, оборот, ОКВЭД, численность) справочные: их тексты код не разбирает, на рейтинг
 * они не влияют. Полнота считается по четырём группам: контакт, место, срок, условия.
 */

/** Шкала рейтинга. */
export const RATING_MIN = 1;
export const RATING_MAX = 5;
/** Базовая оценка, от которой отсчитываются прибавки и вычеты, когда сведения есть. */
export const RATING_BASE = 3;

/** Поправка к оценке за статус: «действующий» - работали, «не работаем» - нет. */
const RATING_STATUS_DELTA = { active: 1, new: 0, inactive: -1 } as const;

/** Поправка за сильные стороны (указаны) и слабые (указаны). */
const RATING_STRENGTHS_DELTA = 0.5;
const RATING_WEAKNESSES_DELTA = -0.5;

/** Поправка за полноту сведений и сколько из четырёх групп сведений для неё нужно. */
const RATING_COMPLETENESS_DELTA = 0.5;
const RATING_COMPLETENESS_MIN_FILLED = 3;

/**
 * Поправки за процент брака: первая строка, у которой брак не больше `upTo`. Брак выше
 * последнего порога даёт `RATING_DEFECT_WORST_DELTA`.
 */
const RATING_DEFECT_STEPS: ReadonlyArray<{ upTo: number; delta: number }> = [
  { upTo: 1, delta: 0.5 },
  { upTo: 3, delta: 0 },
  { upTo: 5, delta: -0.5 },
  { upTo: 10, delta: -1 },
];
const RATING_DEFECT_WORST_DELTA = -2;

/** Результат: оценка от 1 до 5 (кратна 0,5) либо «нет данных» (не ноль). */
export type SupplierRating = { status: 'rated'; value: number } | { status: 'no_data' };

function defectDelta(percent: number): number {
  const step = RATING_DEFECT_STEPS.find((item) => percent <= item.upTo);
  return step === undefined ? RATING_DEFECT_WORST_DELTA : step.delta;
}

/** Сколько из четырёх групп сведений заполнено: контакт, место, срок, условия. */
export function filledCardGroups(card: SupplierCard): number {
  const hasContact = card.contacts.some(
    (contact) => contact.email !== undefined || contact.phone !== undefined,
  );
  const hasPlace = card.productionCity !== undefined || card.address !== undefined;
  const hasLeadTime = card.terms.leadTime !== undefined;
  const hasTerms = card.terms.payment !== undefined || card.terms.delivery !== undefined;
  return [hasContact, hasPlace, hasLeadTime, hasTerms].filter(Boolean).length;
}

/**
 * Есть ли в карточке хоть одно оценочное сведение: статус не «новый» (он ставится по умолчанию
 * и ничего не говорит), процент брака, сильные или слабые стороны. Нет - оценивать нечего:
 * «нет оценки», и модель для этого не вызывается.
 */
function hasRatingSignals(card: SupplierCard): boolean {
  return (
    card.status !== 'new' ||
    card.defectRatePercent !== undefined ||
    card.strengths !== undefined ||
    card.weaknesses !== undefined
  );
}

/** Сведения, на которых считается правило: общие для карточки и для фактов. */
interface RuleInputs {
  status: SupplierStatus;
  defectRatePercent: number | undefined;
  hasStrengths: boolean;
  hasWeaknesses: boolean;
  filledGroups: number;
}

/** Правило рейтинга по сведениям (без проверки наличия оценочных сигналов). */
function ruleValue(inputs: RuleInputs): number {
  let value = RATING_BASE + RATING_STATUS_DELTA[inputs.status];
  if (inputs.defectRatePercent !== undefined && Number.isFinite(inputs.defectRatePercent)) {
    value += defectDelta(inputs.defectRatePercent);
  }
  if (inputs.hasStrengths) value += RATING_STRENGTHS_DELTA;
  if (inputs.hasWeaknesses) value += RATING_WEAKNESSES_DELTA;
  if (inputs.filledGroups >= RATING_COMPLETENESS_MIN_FILLED) value += RATING_COMPLETENESS_DELTA;
  return Math.min(RATING_MAX, Math.max(RATING_MIN, value));
}

/**
 * Рейтинг по карточке (запасное правило). Оценочные сведения: статус «действующий» или «не
 * работаем» (статус «новый» ставится по умолчанию и ничего не говорит), процент брака, сильные
 * и слабые стороны. Ни одного - `no_data`. Иначе: база 3, плюс поправки за статус, брак,
 * сильные и слабые стороны и полноту карточки; итог ограничен шкалой 1..5.
 */
export function computeSupplierRating(card: SupplierCard): SupplierRating {
  if (!hasRatingSignals(card)) return { status: 'no_data' };
  return {
    status: 'rated',
    value: ruleValue({
      status: card.status,
      defectRatePercent: card.defectRatePercent,
      hasStrengths: card.strengths !== undefined,
      hasWeaknesses: card.weaknesses !== undefined,
      filledGroups: filledCardGroups(card),
    }),
  };
}

/**
 * То же правило по фактам карточки (для заглушки оценщика и запасного пути, когда карточки
 * под рукой нет). Результат совпадает с `computeSupplierRating` той же карточки.
 */
export function computeSupplierRatingFromFacts(facts: SupplierRatingFacts): SupplierRating {
  const hasSignal =
    facts.status !== 'new' ||
    facts.defectRatePercent !== undefined ||
    facts.strengths !== undefined ||
    facts.weaknesses !== undefined;
  if (!hasSignal) return { status: 'no_data' };
  return {
    status: 'rated',
    value: ruleValue({
      status: facts.status,
      defectRatePercent: facts.defectRatePercent,
      hasStrengths: facts.strengths !== undefined,
      hasWeaknesses: facts.weaknesses !== undefined,
      filledGroups: facts.completeness,
    }),
  };
}

/** Текст для людей: «4 из 5» либо «нет оценки». */
export function formatSupplierRating(rating: number | null | undefined): string {
  if (rating === null || rating === undefined) return 'нет оценки';
  return `${String(rating).replace('.', ',')} из ${RATING_MAX}`;
}
