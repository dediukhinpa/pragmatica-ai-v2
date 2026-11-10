import type { OwnEntityCode, OwnLegalEntity, OwnLegalEntityData } from '../domain/own-legal-entity';

/** Параметры записи реквизитов юрлица. */
export interface SaveOwnLegalEntityOptions {
  /** Кто записывает: id сотрудника или метка скрипта. Попадает в `updated_by`. */
  updatedBy: string;
  /** Момент записи (ISO) - часы вызывающего, чтобы запись и журнал совпадали по времени. */
  at: string;
  /**
   * Оптимистичная проверка: запись принимается, только если текущая запись не менялась с этого
   * момента (`updatedAt`); `null` - записи ещё не должно быть. Не задано - без проверки
   * (скрипт заполнения). Несовпадение - `DomainError('conflict')`: правку собирали по старой записи.
   */
  expectedUpdatedAt?: string | null | undefined;
}

/** Итог записи. */
export interface SaveOwnLegalEntityResult {
  entity: OwnLegalEntity;
  /** Записи юрлица раньше не было. */
  created: boolean;
}

/** Одна запись пакета {@link OwnLegalEntityRepository.saveMany}. */
export interface SaveOwnLegalEntityItem {
  code: OwnEntityCode;
  data: OwnLegalEntityData;
  options: SaveOwnLegalEntityOptions;
}

/**
 * Реквизиты наших юрлиц (этап 230): по одной записи на код юрлица. Запись целиком проверяется
 * доменной схемой (формат и контрольные суммы) до сохранения; невалидная не пишется.
 */
export interface OwnLegalEntityRepository {
  /** Запись юрлица; null - не заполнена. */
  get(code: OwnEntityCode): Promise<OwnLegalEntity | null>;
  /** Все записи по возрастанию кода. */
  list(): Promise<OwnLegalEntity[]>;
  /** Создать или целиком заменить запись юрлица (идемпотентно по содержимому). */
  save(
    code: OwnEntityCode,
    data: OwnLegalEntityData,
    options: SaveOwnLegalEntityOptions,
  ): Promise<SaveOwnLegalEntityResult>;
  /**
   * Записать несколько юрлиц одной транзакцией: все или ни одного. Любая ошибка (невалидные
   * данные, `conflict` по `expectedUpdatedAt`, сбой базы) откатывает весь пакет - так скрипт
   * заполнения не оставляет наполовину записанный набор.
   */
  saveMany(items: readonly SaveOwnLegalEntityItem[]): Promise<SaveOwnLegalEntityResult[]>;
}
