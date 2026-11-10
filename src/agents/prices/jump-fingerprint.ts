import type { PriceChange } from '../../kit/domain/price-diff';
import { stableHash } from '@business-ai/core';
import type { PricesDeps } from './deps';
import { priceListHash } from './employee-updates';

/*
 * Отпечаток набора скачков цен (`jumpHash` в previewPriceChanges). Подтверждение скачков и
 * прайса из письма неподтверждённого отправителя снято (решения владельца 26.10.2026): в базу
 * цен пишутся только прайсы с диска, остальное уходит сотруднику предложением в файле
 * изменений. Отпечаток остался как короткая сводка того, какие скачки видела модель.
 */

/**
 * Отпечаток набора скачков: все поля, от которых зависит смысл скачка (старая и подтверждённая
 * цена, валюты, снятие), и отпечаток всего прайса поставщика в базе (`baseHash`).
 */
function jumpSetHash(jumps: readonly PriceChange[], baseHash = ''): string {
  const rows = jumps
    .map((jump) => [
      jump.key,
      jump.oldPrice,
      jump.newPrice,
      jump.oldQualifier ?? null,
      jump.oldMax ?? null,
      jump.newQualifier ?? null,
      jump.newMax ?? null,
      jump.currency,
      jump.oldCurrency,
      jump.removed === true,
      jump.confirmedPrice ?? null,
      jump.confirmedCurrency ?? null,
    ])
    .sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0));
  return stableHash([rows, baseHash]);
}

/**
 * Отпечаток набора скачков вместе с текущим состоянием прайса поставщика в базе. `baseHash` -
 * готовый `priceListHash` прайса, если вызывающий его уже считал (прайс тогда не читается).
 */
export async function jumpFingerprint(
  deps: PricesDeps,
  supplierId: string,
  jumps: readonly PriceChange[],
  baseHash?: string,
): Promise<string> {
  return jumpSetHash(
    jumps,
    baseHash ?? priceListHash(await deps.prices.listBySupplier(supplierId)),
  );
}
