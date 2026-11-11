import { createRunDataScriptTool, openIntakeDataSource } from '@business-ai/core';
import { LEGACY_RUN_DATA_SCRIPT_PRESENTATION } from '../shared/common-tools.owned';
import { priceItemsSummaryKind } from '../shared/price-items-kind.owned';
import type { SiteExportDeps } from './deps';

/**
 * `runDataScript` этого агента. Файлов с данными у него нет (шаблоны и каталог шаблонов - не
 * данные), поэтому источник один: вложение текущего диалога из хранилища приёма (оно читается
 * только в пределах треда вызова). Без вложения инструмент отвечает отказом «данных нет».
 */
export const runDataScript = createRunDataScriptTool<SiteExportDeps>(openIntakeDataSource, {
  resultKinds: [priceItemsSummaryKind<SiteExportDeps>()],
  presentation: LEGACY_RUN_DATA_SCRIPT_PRESENTATION,
});
