import { z } from 'zod';
import type { AgentValidator } from '@business-ai/core';
import { SCRIPT_REQUIRED_MESSAGE, issueCodesHaveData } from '@business-ai/core';
import type { PricesDeps } from './deps';

/** Код замечания: перед итогом «нужна проверка» скрипт в этом ходе не пробовали. */
export const SCRIPT_ATTEMPT_REQUIRED_CODE = 'script_attempt_required';

/** Итоги, которыми агент отдаёт файл людям: перед ними обязательна одна попытка скрипта. */
const HANDOVER_KINDS: readonly string[] = ['needs_review', 'structure_changed'];

const reportShape = z.object({
  kind: z.string(),
  issueCodes: z.array(z.string()).optional(),
});

/**
 * Главный триггер скрипта - итог, а не шаги (этап 111, тема 3): итог `needs_review` (и
 * `structure_changed`, который в первичном импорте становится `needs_review`) без попытки
 * скрипта в этом ходе не принимается. Ядро отвечает служебной подсказкой и добавляет шаги на
 * попытку; повторный итог после попытки (или после требования) проходит как есть. Исключения:
 * причины без данных (нет таблиц, файл повреждён, только «поставщик не найден»), скан не
 * относится к итогам этого вида, и нет песочницы или счёта шагов (проверка отключена).
 */
export const scriptAttemptValidator: AgentValidator<PricesDeps> = {
  name: 'script-attempt-required',
  appliesTo: ['reportToManager'],
  validate(input, deps, context) {
    const parsed = reportShape.safeParse(input);
    const turn = context.scriptTurn;
    if (!parsed.success || turn === undefined || deps.scriptSandbox === undefined) return [];
    if (!HANDOVER_KINDS.includes(parsed.data.kind)) return [];
    if (!issueCodesHaveData(parsed.data.issueCodes ?? [])) return [];
    if (!turn.demandAttempt()) return [];
    return [{ code: SCRIPT_ATTEMPT_REQUIRED_CODE, message: SCRIPT_REQUIRED_MESSAGE }];
  },
};
