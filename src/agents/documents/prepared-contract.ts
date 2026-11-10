import { z } from 'zod';
import type { WorkflowStateStore } from '@business-ai/core';
import { readState, writeState } from '@business-ai/core';

/**
 * Договоры, собранные в треде `prepareSupplierDocument` (этап 219): по какому поставщику в этом
 * треде собирали документ вида `contract`. Дополнение карточки из договора разрешено только
 * для такого поставщика. Раньше вид документа (`documentKind`) называла сама модель, и
 * поддельное значение открывало запись в карточку; теперь решает запись кода о сборке. Хранятся
 * только id поставщиков, текстов и реквизитов нет.
 */

/** Пространство состояния: поставщики, по которым в треде собран договор. */
export const PREPARED_CONTRACT_NAMESPACE = 'documents:prepared-contract';

/** Сколько поставщиков помним на тред: договоров за один разговор больше не бывает. */
const PREPARED_CONTRACT_MAX_SUPPLIERS = 50;

const preparedSchema = z.object({ supplierIds: z.array(z.string()) });

/** Запомнить, что в треде собран договор с поставщиком. Нет хранилища или треда - без записи. */
export async function notePreparedContract(
  state: WorkflowStateStore | undefined,
  threadId: string,
  supplierId: string,
): Promise<void> {
  if (state === undefined || threadId === '') return;
  const known = await readState(state, PREPARED_CONTRACT_NAMESPACE, threadId, preparedSchema);
  const ids = known?.supplierIds ?? [];
  if (ids.includes(supplierId)) return;
  const supplierIds = [...ids, supplierId].slice(-PREPARED_CONTRACT_MAX_SUPPLIERS);
  await writeState(state, PREPARED_CONTRACT_NAMESPACE, threadId, { supplierIds });
}

/** Поставщики, по которым в треде собран договор; пусто, если не собирали. */
export async function preparedContractSuppliers(
  state: WorkflowStateStore | undefined,
  threadId: string | undefined,
): Promise<string[]> {
  if (state === undefined || threadId === undefined) return [];
  const stored = await readState(state, PREPARED_CONTRACT_NAMESPACE, threadId, preparedSchema);
  return stored?.supplierIds ?? [];
}
