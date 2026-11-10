import type { ExportTemplate } from '../../kit/domain/site-export';

/**
 * Временный шаблон выгрузки: реального формата заказчика нет. Это конфигурация, а не логика:
 * заменяется передачей другого `ExportTemplate` в `SiteExportDeps.template`.
 */
export const PLACEHOLDER_EXPORT_TEMPLATE: ExportTemplate = {
  name: 'временный шаблон (формат заказчика не получен)',
  fields: [
    { name: 'sku', type: 'string', required: true },
    { name: 'name', type: 'string', required: true },
    { name: 'price', type: 'number', required: true },
    { name: 'currency', type: 'string', required: true },
    { name: 'description', type: 'string', required: false },
  ],
  skuField: 'sku',
  priceField: 'price',
  descriptionField: 'description',
};
