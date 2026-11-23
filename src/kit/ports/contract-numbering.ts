/**
 * Общий ключ счётчика: нумерация сквозная по всем юрлицам (решение владельца 01.11), поэтому
 * счётчик не зависит от юрлица. Реальное юрлицо хранится в выданном номере и в `contract_numbers`.
 */
export const SHARED_COUNTER_KEY = 'ALL';

/** Запрос номера договора: одна операция заполнения договора = один ключ. */
export interface ContractNumberRequest {
  /** Ключ операции: повтор того же ключа возвращает тот же номер, без нового. */
  operationKey: string;
  /** Юрлицо заказчика (`mg`, `pr`): префикс номера; счётчик общий (`SHARED_COUNTER_KEY`). */
  legalEntity: string;
  /** Год документа: счётчик начинается заново каждый год. */
  year: number;
  /** Дата договора (`ГГГГ-ММ-ДД`): хранится рядом с номером для поиска основного договора. */
  documentDate?: string | undefined;
}

/** Выданный номер договора. */
export interface IssuedContractNumber {
  operationKey: string;
  legalEntity: string;
  year: number;
  /** Сквозной порядковый номер в рамках года, с единицы. */
  sequence: number;
  /** Готовый номер `<ПРЕФИКС>-<ГОД>-<NNNN>`. */
  number: string;
}

/** Последний выданный номер поставщика и дата его договора. */
export interface LatestContractNumber extends IssuedContractNumber {
  /** Дата договора `ГГГГ-ММ-ДД`; у старых записей без неё - дата выдачи номера. */
  documentDate: string;
}

/**
 * Нумерация договоров: номер присваивает система. Сквозной счётчик по году (общий для юрлиц)
 * растёт атомарно, параллельные вызовы не получают один номер; повтор операции с тем же ключом возвращает уже
 * выданный номер (повтор шага после сбоя не плодит номера).
 */
export interface ContractNumbering {
  /** Выдать номер операции либо вернуть ранее выданный по тому же ключу. */
  issue(request: ContractNumberRequest): Promise<IssuedContractNumber>;
  /** Выданный номер операции либо `null`; счётчик не двигает. */
  find(operationKey: string): Promise<IssuedContractNumber | null>;
  /**
   * Последний (по времени выдачи) номер юрлица среди операций, ключ которых начинается с
   * `operationKeyPrefix` (ключи договоров поставщика). `null` - номеров нет. Счётчик не двигает.
   */
  findLatest(
    operationKeyPrefix: string,
    legalEntity: string,
  ): Promise<LatestContractNumber | null>;
}
