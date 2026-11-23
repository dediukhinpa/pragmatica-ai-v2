/**
 * Пересоздать синтетические записи набора по передачам (eval/recordings/handoff) по сценариям
 * из src/synthetic/handoff-scenarios.ts. Запуск: `bun run synthetic:handoff`. Модель не
 * вызывается: ответы даёт скриптованная заглушка.
 */
import { registerPragmatikaEval } from '../index';

// Раннер платформы читает схемы кейсов из зарегистрированного проекта.
registerPragmatikaEval();
import { DEFAULT_HANDOFF_CASES_DIR, DEFAULT_HANDOFF_RECORDINGS_DIR } from '../paths';
import { loadHandoffCases } from '@business-ai/eval';
import { writeRecording } from '@business-ai/eval';
import {
  HANDOFF_SCENARIOS,
  HANDOFF_SYNTHETIC_ALIASES,
  recordHandoffSynthetic,
} from '../synthetic/handoff-scenarios';

const cases = loadHandoffCases(DEFAULT_HANDOFF_CASES_DIR).filter(
  (handoffCase) => handoffCase.id in HANDOFF_SCENARIOS,
);
for (const handoffCase of cases) {
  for (const model of HANDOFF_SYNTHETIC_ALIASES) {
    const recording = await recordHandoffSynthetic(handoffCase, model);
    console.log(`записано: ${writeRecording(DEFAULT_HANDOFF_RECORDINGS_DIR, recording)}`);
  }
}
