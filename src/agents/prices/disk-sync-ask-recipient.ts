import { failureName } from '@business-ai/core';
import { responsibleThread, type PricesDeps } from './deps';
import { resolveFileRecipients } from './stale-price-recipients';

/**
 * Кому задать вопрос «чей это прайс» (этап 148): сотруднику, который положил файл или последним
 * его сохранял, - по тому же правилу, что и адресная недельная сводка (фамилия в папке, затем
 * «кем изменён» / «кем создан»). Правило не дублируется: берётся `resolveFileRecipients`.
 * Не найден, сервисы не подключены или определение упало - прежний общий адресат.
 */
export async function supplierAskThreads(deps: PricesDeps, path: string): Promise<string[]> {
  try {
    const { threadsByPath } = await resolveFileRecipients(deps, [path]);
    const personal = threadsByPath.get(path);
    if (personal !== undefined && personal.length > 0) return personal;
  } catch (error) {
    // Сбой определения автора не должен ронять тик: вопрос уходит ответственному, в журнал -
    // только код ошибки (имён и путей там нет).
    deps.log?.('price_disk_ask_recipient_failed', { error: failureName(error) });
  }
  return [responsibleThread(deps)];
}
