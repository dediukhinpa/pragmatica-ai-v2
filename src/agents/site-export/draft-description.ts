import { z } from 'zod';
import {
  DEFAULT_DESCRIPTION_RULES,
  validateDescription,
  type ExportCard,
} from '../../kit/domain/site-export';
import { DomainError } from '@business-ai/core';
import { toStoredJson } from '@business-ai/core';
import { defineTool } from '@business-ai/core';
import { findCardsBySku } from './cards';
import { exportNamespace, type SiteExportDeps } from './deps';

/** Код замечания ПДн/ссылки: единственный, при котором описание не сохраняется. */
const PII_ISSUE_CODE = 'description_has_pii_or_link';

interface DraftInput {
  exportId: string;
  sku: string;
  text: string;
}
interface DraftOutput {
  saved: boolean;
  length: number;
  issues: Array<{ code: string; message: string }>;
}

/**
 * Сохранить описание карточки. Текст пишет сама модель; инструмент только проверяет длину и
 * запрещённые шаблонные фразы и, если всё в порядке, кладёт описание в карточку набора.
 */
export const draftDescription = defineTool<DraftInput, DraftOutput, SiteExportDeps>({
  name: 'draftDescription',
  description:
    'Сохранить в карточку набора exportId (по артикулу sku) описание text, которое ты написал ' +
    'по данным карточки и подсказкам. Длина и запрещённые шаблонные фразы - предупреждения: ' +
    'описание сохраняется (saved=true), issues вынеси в предупреждения. Описание с ПДн или ' +
    'ссылкой (description_has_pii_or_link) не сохраняется (saved=false): убери их.',
  inputSchema: z.object({
    exportId: z.string().min(1),
    sku: z.string().min(1),
    text: z.string().min(1),
  }),
  outputSchema: z.object({
    saved: z.boolean(),
    length: z.number().int(),
    issues: z.array(z.object({ code: z.string(), message: z.string() })),
  }),
  async execute(input, deps) {
    const field = deps.template.descriptionField;
    if (field === undefined) {
      throw new DomainError('validation_failed', 'Шаблон выгрузки не предусматривает описаний.');
    }
    const text = input.text.trim();
    const rules = deps.template.description ?? DEFAULT_DESCRIPTION_RULES;
    const issues = validateDescription(text, rules);
    // Контур ПДн остаётся блоком; длина и шаблонные фразы - только предупреждения (этап 177).
    if (issues.some((issue) => issue.code === PII_ISSUE_CODE)) {
      return { saved: false, length: text.length, issues };
    }
    const wanted = input.sku.trim().toLowerCase();
    // По индексу артикулов, а не по всему набору: иначе N описаний читают набор N раз (R5-CORE-6).
    const matches = await findCardsBySku(deps, input.exportId, wanted);
    if (matches.length === 0) {
      throw new DomainError('not_found', `Карточка с артикулом ${input.sku} в наборе не найдена.`);
    }
    if (matches.length > 1) {
      throw new DomainError('conflict', `Артикул ${input.sku} повторяется: исправьте дубли.`);
    }
    const match = matches[0];
    if (match === undefined) throw new DomainError('not_found', 'Карточка не найдена.');
    const card: ExportCard = { ...match.card, [field]: text };
    await deps.state.put(exportNamespace(input.exportId), match.key, toStoredJson(card));
    return { saved: true, length: text.length, issues };
  },
});
