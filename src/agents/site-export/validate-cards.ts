import { z } from 'zod';
import { validateExportCards } from '../../kit/domain/site-export';
import { defineTool } from '@business-ai/core';
import { limitExportIssues, loadAllCards, setHashOf } from './cards';
import type { SiteExportDeps } from './deps';

interface ValidateInput {
  exportId: string;
}
interface ValidateOutput {
  ok: boolean;
  total: number;
  /** Отпечаток проверенного набора. */
  setHash: string;
  issues: Array<{ code: string; message: string }>;
}

/** Проверка набора карточек по шаблону (для отчёта о замечаниях). */
export const validateCards = defineTool<ValidateInput, ValidateOutput, SiteExportDeps>({
  name: 'validateCards',
  description:
    'Проверить набор карточек exportId по шаблону: обязательные поля, типы, дубли артикулов, ' +
    'пустые цены. Возвращает замечания и setHash набора; пустой список = замечаний нет.',
  inputSchema: z.object({ exportId: z.string().min(1) }),
  outputSchema: z.object({
    ok: z.boolean(),
    total: z.number().int(),
    setHash: z.string(),
    issues: z.array(z.object({ code: z.string(), message: z.string() })),
  }),
  async execute(input, deps) {
    const stored = await loadAllCards(deps, input.exportId);
    const issues = validateExportCards(
      stored.map((item) => item.card),
      deps.template,
    );
    return {
      ok: issues.length === 0,
      total: stored.length,
      setHash: setHashOf(stored),
      issues: limitExportIssues(issues),
    };
  },
});
