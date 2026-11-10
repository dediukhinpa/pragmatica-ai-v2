import { DomainError } from '@business-ai/core';

/** Префиксы номеров по юрлицу заказчика (ключ - id юрлица из реестра шаблонов). */
const CONTRACT_NUMBER_PREFIXES: Readonly<Record<string, string>> = {
  mg: 'МГ',
  pr: 'ПР',
};

/** Ширина порядкового номера в договоре: «0007». */
const SEQUENCE_WIDTH = 4;

/** Префикс номера юрлица; неизвестное юрлицо - ошибка, номер без префикса не выдаётся. */
function contractNumberPrefix(legalEntity: string): string {
  const prefix = Object.hasOwn(CONTRACT_NUMBER_PREFIXES, legalEntity)
    ? CONTRACT_NUMBER_PREFIXES[legalEntity]
    : undefined;
  if (prefix === undefined) {
    throw new DomainError('validation_failed', `Неизвестное юрлицо для номера: ${legalEntity}.`);
  }
  return prefix;
}

/** Номер договора: `<ПРЕФИКС ЮРЛИЦА>-<ГОД>-<NNNN>`, например `МГ-2026-0007`. */
export function formatContractNumber(
  legalEntity: string,
  year: number,
  sequence: number,
): string {
  const padded = String(sequence).padStart(SEQUENCE_WIDTH, '0');
  return `${contractNumberPrefix(legalEntity)}-${year}-${padded}`;
}
