/**
 * Пересоздать синтетические записи (eval/recordings) по сценариям из src/synthetic.
 * Запуск: `bun run synthetic`. Нужен после смены агентов в core, если записи разошлись.
 */
import { registerPragmatikaEval } from '../index';

// Раннер платформы читает схемы кейсов из зарегистрированного проекта.
registerPragmatikaEval();
import { loadCases } from '@business-ai/eval';
import { DEFAULT_CASES_DIR, DEFAULT_RECORDINGS_DIR } from '../paths';
import { writeRecording } from '@business-ai/eval';
import { SCENARIOS, SYNTHETIC_MODELS } from '../synthetic/scenarios';
import { recordSynthetic } from '../synthetic';

const cases = loadCases(DEFAULT_CASES_DIR).filter((testCase) => testCase.id in SCENARIOS);
for (const testCase of cases) {
  for (const model of SYNTHETIC_MODELS) {
    const path = writeRecording(DEFAULT_RECORDINGS_DIR, await recordSynthetic(testCase, model));
    console.log(`записано: ${path}`);
  }
}
