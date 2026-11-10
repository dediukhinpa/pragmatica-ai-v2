import { z } from 'zod';
import { defineTool } from '@business-ai/core';
import { recordWorkOwner } from '@business-ai/core';
import { workSubject } from '../shared/work-owner.owned';
import { exportReportRecipient, type SiteExportDeps } from './deps';

/** Что случилось с выгрузкой: от этого зависит текст сообщения. */
const EXPORT_REPORT_KINDS = ['blocked', 'needs_review'] as const;
type ExportReportKind = (typeof EXPORT_REPORT_KINDS)[number];

interface ReportInput {
  kind: ExportReportKind;
  exportId: string;
  total: number;
  issueCodes: string[];
}

/** Текст собирается кодом из шаблона и чисел: свободного текста модели в нём нет. */
export function buildExportReportText(input: ReportInput): string {
  switch (input.kind) {
    case 'blocked':
      return (
        `Выгрузка ${input.exportId} не принята: проверка нашла замечания ` +
        `(${input.issueCodes.join(', ')}). Нужно исправить карточки.`
      );
    case 'needs_review':
      return `Выгрузка ${input.exportId}: нужна проверка (${input.issueCodes.join(', ')}).`;
  }
}

function reportKey(input: ReportInput): string {
  const codes = [...input.issueCodes].sort().join(',');
  return `site-export-report:${input.kind}:${input.exportId}:${codes}`;
}

/** Сообщить менеджеру итог выгрузки. */
export const reportExportToManager = defineTool<
  ReportInput,
  { delivered: boolean },
  SiteExportDeps
>({
  name: 'reportToManager',
  description:
    'Отправить менеджеру итог выгрузки: kind (blocked, needs_review), exportId, ' +
    'число total, коды замечаний issueCodes. Свободный текст не передаётся.',
  sideEffect: true,
  inputSchema: z.object({
    kind: z.enum(EXPORT_REPORT_KINDS),
    exportId: z.string().min(1),
    total: z.number().int().nonnegative().default(0),
    issueCodes: z.array(z.string().regex(/^[a-z_]+$/)).default([]),
  }),
  outputSchema: z.object({ delivered: z.boolean() }),
  idempotencyKey: reportKey,
  async execute(input, deps, context) {
    const message = { text: buildExportReportText(input) };
    // Набор мог прийти без шага шаблона: тогда владельца фиксирует отчёт (первый побеждает).
    await recordWorkOwner(deps.state, workSubject.export(input.exportId), context);
    const threadId = await exportReportRecipient(deps, input.exportId);
    await deps.chat.reply(threadId, message, reportKey(input));
    return { delivered: true };
  },
});
