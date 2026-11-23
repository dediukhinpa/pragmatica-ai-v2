import type { ExportedFile, TableExporter } from '@business-ai/core';
import type { ServiceLog } from '@business-ai/core/compose';
import { buildSupplierTemplate, supplierTemplateFile } from '../agents/suppliers/supplier-template';

/** Код ошибки для журнала: только имя класса или код доменной ошибки, без текста. */
function errorCodeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error as { code: unknown };
    if (typeof code === 'string') return code;
  }
  return error instanceof Error ? error.name : 'unexpected';
}

/**
 * Загрузчик файла-шаблона поставщиков: готовый xlsx по пути из настройки; нет файла или он
 * пуст - шаблон собирается кодом через выгрузку таблиц. Читается при каждой просьбе: файл
 * маленький, а замена файла в образе не требует перезапуска. Путь в журнал не пишется.
 */
export function supplierTemplateLoader(
  path: string,
  tableExporter: TableExporter,
  log: ServiceLog,
): () => Promise<ExportedFile> {
  return async () => {
    try {
      const bytes = await Bun.file(path).bytes();
      if (bytes.length > 0) return supplierTemplateFile(bytes);
    } catch (error) {
      log('supplier_template_file_unavailable', { code: errorCodeOf(error) });
    }
    return buildSupplierTemplate(tableExporter);
  };
}
