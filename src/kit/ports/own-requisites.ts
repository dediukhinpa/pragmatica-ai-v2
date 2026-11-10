import type { OwnRequisites } from './contract-amender';

/** Наше юрлицо, от имени которого заключается договор. */
export type OwnEntity = 'mg' | 'pr';

/**
 * Источник наших реквизитов для договоров. Сейчас реализация читает блок «Заказчик» из
 * шаблона договора юрлица (как и сборка по шаблону); этап 230 заменит её записями в БД, не
 * трогая инструмент дополнения договора.
 */
export interface OwnRequisitesSource {
  /** Наши реквизиты юрлица; undefined - источник их не знает. */
  forEntity(entity: OwnEntity, signal?: AbortSignal): Promise<OwnRequisites | undefined>;
}
