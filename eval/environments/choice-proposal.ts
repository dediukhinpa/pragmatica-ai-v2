import type { EvalEnvironment } from '@business-ai/eval';
import { loadProposal } from '../../src/agents/order-calc/state';
import type { OrderCalcCase } from '../cases';

/** Зависимости, из которых читается сохранённый шорт-лист (состояние агента). */
type ProposalDeps = Parameters<typeof loadProposal>[0];

/** Зависимости инструментов окружения «Поиск поставщика» несут хранилище состояния. */
function isProposalDeps(value: unknown): value is ProposalDeps {
  return typeof value === 'object' && value !== null && 'state' in value;
}

/**
 * Дополнить окружение «Поиска поставщика» предложением для метрики выбора менеджера платформы:
 * кандидаты - id поставщиков из шорт-листа, который агент сохранил в состоянии, по порядку
 * ранжирования. Заявка кейса - первая в начальном состоянии (как в замерах окружения).
 */
export function withShortlistProposal(
  env: EvalEnvironment,
  testCase: OrderCalcCase,
): EvalEnvironment {
  const requestId = testCase.state.requests[0]?.id ?? '';
  return {
    ...env,
    proposal: async () => {
      if (!isProposalDeps(env.toolDeps)) return null;
      const saved = await loadProposal(env.toolDeps, requestId);
      return saved === null ? null : { candidateIds: saved.entries.map((e) => e.supplierId) };
    },
  };
}
