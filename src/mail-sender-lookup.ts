import { PostgresSupplierRepository } from './kit/adapters/postgres/supplier-repository';
import { findSuppliersByAddress } from './agents/shared/supplier-email-index';
import type { SupplierRepository } from './kit/ports/repositories.owned';
import type { PgClient } from '@business-ai/adapters';

/** Проверка адреса отправителя (тип платформы `SenderLookup` из пакета не экспортируется). */
export type SenderLookup = (address: string) => Promise<boolean>;

/**
 * Допуск отправителей почты по базе поставщиков, как в прежнем коде: тело и вложения скачиваются
 * только у тех, чей адрес совпал с адресом поставщика или любого его контакта. Решение берётся
 * запросом к базе по адресу (поставщик не выпадает в «хвосте» большой базы); кэш решений и отказ
 * при сбое базы (fail closed) обеспечивает платформа вокруг этой проверки.
 */
export function supplierSenderLookup(suppliers: SupplierRepository): SenderLookup {
  return async (address) => {
    const key = address.trim();
    if (key === '') return false;
    return (await findSuppliersByAddress(suppliers, key)).length > 0;
  };
}

/** Проверка отправителей манифеста: репозиторий поставщиков на клиенте БД сборки. */
export function senderAllowlistOf(env: { db: PgClient }): SenderLookup {
  return supplierSenderLookup(new PostgresSupplierRepository(env.db));
}
