import { DomainError } from '@business-ai/core';
import {
  ownEntityData,
  parseOwnLegalEntityData,
  type OwnEntityCode,
  type OwnLegalEntity,
} from '../../domain/own-legal-entity';
import type {
  OwnLegalEntityRepository,
  SaveOwnLegalEntityItem,
  SaveOwnLegalEntityOptions,
  SaveOwnLegalEntityResult,
} from '../../ports/own-legal-entities';

/** Сравнение по кодовым точкам, как в БД (ORDER BY code COLLATE "C"). */
const byCode = (a: OwnLegalEntity, b: OwnLegalEntity): number =>
  a.code < b.code ? -1 : a.code > b.code ? 1 : 0;

/** Реквизиты наших юрлиц в памяти процесса. */
export class MemoryOwnLegalEntityRepository implements OwnLegalEntityRepository {
  private readonly items = new Map<OwnEntityCode, OwnLegalEntity>();

  async get(code: OwnEntityCode): Promise<OwnLegalEntity | null> {
    const found = this.items.get(code);
    return found === undefined ? null : structuredClone(found);
  }

  async list(): Promise<OwnLegalEntity[]> {
    return [...this.items.values()].sort(byCode).map((entity) => structuredClone(entity));
  }

  async save(
    code: OwnEntityCode,
    data: Parameters<OwnLegalEntityRepository['save']>[1],
    options: SaveOwnLegalEntityOptions,
  ): Promise<SaveOwnLegalEntityResult> {
    const [saved] = await this.saveMany([{ code, data, options }]);
    if (saved === undefined) throw new DomainError('external_failure', 'Запись не выполнена.');
    return saved;
  }

  async saveMany(items: readonly SaveOwnLegalEntityItem[]): Promise<SaveOwnLegalEntityResult[]> {
    // Сначала проверяем всё, потом пишем: ошибка любой записи оставляет память нетронутой.
    const planned = items.map((item) => {
      // Невалидное не пишется ни сюда, ни в Postgres: правила одни (доменная схема).
      const checked = parseOwnLegalEntityData(ownEntityData(item.data));
      const current = this.items.get(item.code);
      const expected = item.options.expectedUpdatedAt;
      if (expected !== undefined && (current?.updatedAt ?? null) !== expected) {
        throw new DomainError(
          'conflict',
          'Реквизиты изменились с момента подготовки правки: повторите её по актуальной записи.',
        );
      }
      const entity: OwnLegalEntity = {
        ...checked,
        code: item.code,
        updatedAt: item.options.at,
        updatedBy: item.options.updatedBy,
      };
      return { entity, created: current === undefined };
    });
    for (const { entity } of planned) this.items.set(entity.code, structuredClone(entity));
    return planned;
  }
}
