import type { HandoffCase } from '@business-ai/eval';
import { toOrderCalcCase } from '../cases';
import { buildOrderCalcEnvironment } from './order-calc';
import type { EvalEnvironment } from '@business-ai/eval';

/**
 * Окружение набора по передачам: «Поиск поставщика (ИИ агент)» с подключённой передачей агенту
 * «Актуализация прайса (ИИ агент)» (флаг
 * включён, зависимости передачи в памяти). Права сотрудника на бота «Актуализация прайса (ИИ
 * агент)» задаёт кейс.
 */
export function buildHandoffEnvironment(
  handoffCase: HandoffCase,
  model: string,
): Promise<EvalEnvironment> {
  return buildOrderCalcEnvironment(toOrderCalcCase(handoffCase.evalCase), model, {
    allowPrices: handoffCase.access === 'allowed',
  });
}
