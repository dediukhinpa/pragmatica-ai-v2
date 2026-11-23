import type { SupplierCard, SupplierStatus } from './supplier-card';
import type { DocumentFlow, SupplierKind } from './supplier-card-full';
import { filledCardGroups } from './supplier-rating';

/**
 * Факты карточки поставщика для оценки рейтинга моделью (ТЗ, разд. 4 и 10). Это компактная
 * проекция карточки, а не сама карточка: в неё не входят ФИО, должности, телефоны, email,
 * мессенджеры, реквизиты, ИНН, адреса, названия организаций, ссылки на файлы и заметки.
 * Свободный текст карточки (сильные и слабые стороны и т. п.) идёт в модель только через
 * шлюз псевдонимизации; сами факты шлюз не заменяет. Числа даны так, чтобы в запросе не
 * появлялась серия из 10 и более цифр (оборот - в миллионах рублей с одним знаком).
 */

/**
 * Версия набора фактов и промпта оценки. Входит в факты, а значит и в хэш: смена правил
 * оценки (состава фактов или инструкции модели) делает прежние записи кэша недействительными.
 */
export const SUPPLIER_RATING_FACTS_VERSION = 1;

/** Предел длины одного свободного текста в фактах (символов): остальное отрезается. */
export const RATING_FACT_TEXT_MAX_LENGTH = 400;

/** Оборот в фактах: миллионы рублей, один знак после запятой. */
const RUB_PER_MILLION = 1_000_000;
const TURNOVER_DECIMALS_FACTOR = 10;

const WHITESPACE = /\s+/g;

/** Факты для оценки. Всё, кроме `version`, `status` и `completeness`, может отсутствовать. */
export interface SupplierRatingFacts {
  version: number;
  /** Тип поставщика (разд. 10.1): действующий / потенциальный / не действующий. */
  status: SupplierStatus;
  /** Вид поставщика (разд. 10.1). */
  supplierKind?: SupplierKind | undefined;
  foundedYear?: number | undefined;
  /** Процент брака по заказам, 0-100 (разд. 10.9). 0 - «брака нет». */
  defectRatePercent?: number | undefined;
  /** Сильные и слабые стороны (разд. 10.9), свободный текст. */
  strengths?: string | undefined;
  weaknesses?: string | undefined;
  /** Работа с рекламациями, конкурентные преимущества, заказчики (разд. 10.9). */
  claimsHandling?: string | undefined;
  competitiveAdvantages?: string | undefined;
  customers?: string | undefined;
  /** Портфолио заказов в Прагматике (разд. 10.6). */
  pragmatikaPortfolio?: string | undefined;
  /** Оборот, млн руб. */
  turnoverMlnRub?: number | undefined;
  employeeCount?: number | undefined;
  /** Есть ли контроль качества (разд. 10.7). */
  hasQualityControl?: boolean | undefined;
  /** Документооборот: через ЭДО или нет (разд. 10.5). */
  documentFlow?: DocumentFlow | undefined;
  /** Записаны ли условия договора и соглашений (разд. 10.5): сам текст в факты не входит. */
  hasContractNotes?: boolean | undefined;
  samplesAvailable?: boolean | undefined;
  /** Сколько из четырёх групп сведений (контакт, место, срок, условия) заполнено, 0-4. */
  completeness: number;
}

/** Текст для фактов: единые пробелы, NFC, предел длины; пустой - отсутствует. */
function factText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const text = value.normalize('NFC').replace(WHITESPACE, ' ').trim();
  return text === '' ? undefined : text.slice(0, RATING_FACT_TEXT_MAX_LENGTH);
}

function finiteNumber(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

function turnoverMln(rub: number | undefined): number | undefined {
  const value = finiteNumber(rub);
  if (value === undefined) return undefined;
  const scaled = Math.round((value / RUB_PER_MILLION) * TURNOVER_DECIMALS_FACTOR);
  return scaled / TURNOVER_DECIMALS_FACTOR;
}

/**
 * Собрать факты по карточке. Отсутствующее в карточке остаётся `undefined` и в каноничную
 * запись не попадает (это не то же самое, что пустое значение).
 */
export function buildSupplierRatingFacts(card: SupplierCard): SupplierRatingFacts {
  return {
    version: SUPPLIER_RATING_FACTS_VERSION,
    status: card.status,
    supplierKind: card.supplierKind,
    foundedYear: finiteNumber(card.foundedYear),
    defectRatePercent: finiteNumber(card.defectRatePercent),
    strengths: factText(card.strengths),
    weaknesses: factText(card.weaknesses),
    claimsHandling: factText(card.claimsHandling),
    competitiveAdvantages: factText(card.competitiveAdvantages),
    customers: factText(card.customers),
    pragmatikaPortfolio: factText(card.pragmatikaPortfolio),
    // Оборот последнего названного года; суммы без года (прежнее поле) - запасной источник.
    turnoverMlnRub: turnoverMln(card.turnoverByYear?.[0]?.rub ?? card.turnoverRub),
    employeeCount: finiteNumber(card.employeeCount),
    hasQualityControl: card.hasQualityControl,
    documentFlow: card.documentFlow,
    hasContractNotes: card.contractNotes === undefined ? undefined : true,
    samplesAvailable: card.samplesAvailable,
    completeness: filledCardGroups(card),
  };
}

/**
 * Каноничная запись фактов: JSON без пробелов, ключи по алфавиту, отсутствующие значения
 * опущены. Не зависит от порядка ключей и пробелов в исходном объекте.
 */
export function canonicalFactsJson(facts: SupplierRatingFacts): string {
  const entries = Object.entries(facts)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(Object.fromEntries(entries));
}
