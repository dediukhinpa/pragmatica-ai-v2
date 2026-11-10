import {
  recordScripted,
  type EvalCase,
  type Recording,
  type SyntheticModel,
} from '@business-ai/eval';
import { SCENARIOS } from './scenarios';

export * from './scenarios';

/**
 * Записать синтетический сценарий через ту же дорожку, что и live (прогон агента с журналом
 * вызовов): так записи совпадают по формату с настоящими. Задержка подставляется выдуманная.
 */
export function recordSynthetic(testCase: EvalCase, model: SyntheticModel): Promise<Recording> {
  const script = SCENARIOS[testCase.id]?.[model];
  if (script === undefined) {
    return Promise.reject(new Error(`Нет синтетического сценария для ${testCase.id}`));
  }
  return recordScripted(testCase, model, script);
}
