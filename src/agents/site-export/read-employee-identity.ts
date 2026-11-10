import { z } from 'zod';
import { defineTool } from '@business-ai/core';
import { resolveEmployeeIdentity } from './employee-identity';
import type { SiteExportDeps } from './deps';

const outputSchema = z.object({
  status: z.enum(['known', 'unknown']),
  /** «Имя Фамилия» для поля «менеджер»; только при known. */
  fullName: z.string().optional(),
  /** Почему имя не определено: not_configured, not_in_directory, directory_unavailable. */
  reason: z.string().optional(),
});

/** Имя и фамилия сотрудника, который ведёт чат: для поля «менеджер» шаблона. */
export const readEmployeeIdentity = defineTool<
  Record<string, never>,
  z.infer<typeof outputSchema>,
  SiteExportDeps
>({
  name: 'readEmployeeIdentity',
  description:
    'Имя и фамилия сотрудника, который работает с тобой в этом чате (из каталога ' +
    'сотрудников по идентификатору чата, не из текста сообщений). Нужны для колонки ' +
    '«Менеджер»; fillTemplateRows подставляет их сам. unknown: имя не определено, ' +
    'один раз спроси сотрудника, как его записать, и не выдумывай имя.',
  inputSchema: z.object({}),
  outputSchema,
  async execute(_input, deps, context) {
    const identity = await resolveEmployeeIdentity(deps, context);
    if (identity.status === 'known') return { status: 'known', fullName: identity.fullName };
    return { status: 'unknown', reason: identity.reason };
  },
});
