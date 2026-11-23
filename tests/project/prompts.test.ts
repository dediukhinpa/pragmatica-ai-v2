import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { pragmatikaProject } from '../../src';

/** Предел инструкции чтения страниц на шлюзе, байт. */
const GATEWAY_INSTRUCTION_MAX_BYTES = 1024;
/** Предел сводки, символов: значение, при котором снят отпечаток прежнего текста. */
const SUMMARY_MAX_CHARS = 1000;

/** sha256 текста (как в инвентаре промптов этапа 0: `stage-0/baseline/behavior/prompts.tsv`). */
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** Отпечатки внутренних текстов прежней сборки (эталон `prompts.tsv`, значения без изменений). */
const BASELINE_SHA = {
  visionSystem: '1d065b3537733d000954ea65e3f903dcad38d42aa5ab48f22c8d02b7a87524f5',
  visionTable: '8a684947ef16be37aaa2f5f2e5e635a96e596072724c467a23a6229a6435f3fb',
  visionProduct: '2b5ec9b6f064c67db2e8dfaf2a9bc8a745e2a7bcc631347953e95a99ff01b09d',
  webFetchHome: '11056068ec62c365e5ab6eeb27de1b6db6d3e90fe75542ba423ee1884691019d',
  webFetchContacts: '5e536adcdd9189092df18eea59458ad777714e6b5452ceab776cad69497120dc',
  scriptErrorHint: 'b28ddf017fa8e6725ab9ef02189149396d62caebeec6b1bae286d8523bb5c196',
  sessionSummary: 'ef1c2ccf0174fbfd3deabaa2fdbd4ee10c4a19dfd5c40cabc73bc5772424ba93',
} as const;

function promptsOf() {
  const prompts = pragmatikaProject.prompts;
  if (prompts === undefined) throw new Error('В манифесте нет prompts');
  return prompts;
}

describe('внутренние тексты платформы в манифесте (G-20)', () => {
  test('инструкции чтения страниц равны прежним', () => {
    const { webFetch } = promptsOf();
    expect(sha256(webFetch?.home ?? '')).toBe(BASELINE_SHA.webFetchHome);
    expect(sha256(webFetch?.contacts ?? '')).toBe(BASELINE_SHA.webFetchContacts);
  });

  test('тексты зрения равны прежним, фото читается прежней инструкцией товара', () => {
    const { vision } = promptsOf();
    expect(sha256(vision?.system ?? '')).toBe(BASELINE_SHA.visionSystem);
    expect(sha256(vision?.table ?? '')).toBe(BASELINE_SHA.visionTable);
    // Прежний режим `product` был единственным не табличным: `photo` читается им же.
    expect(sha256(vision?.product ?? '')).toBe(BASELINE_SHA.visionProduct);
    expect(vision?.photo).toBe(vision?.product);
  });

  test('подсказка после ошибки скрипта и промпт сводки сессий равны прежним', () => {
    const prompts = promptsOf();
    expect(sha256(prompts.scriptErrorHint ?? '')).toBe(BASELINE_SHA.scriptErrorHint);
    expect(sha256(prompts.sessionSummary?.(SUMMARY_MAX_CHARS) ?? '')).toBe(
      BASELINE_SHA.sessionSummary,
    );
  });

  test('инструкции чтения страниц проходят форму запроса шлюза', () => {
    const { webFetch } = promptsOf();
    for (const text of [webFetch?.home ?? '', webFetch?.contacts ?? '']) {
      // Шлюз: инструкция до 1024 байт, без адресов и доменоподобных слов.
      const bytes = new TextEncoder().encode(text).length;
      expect(bytes).toBeLessThanOrEqual(GATEWAY_INSTRUCTION_MAX_BYTES);
      expect(text).not.toMatch(/:\/\/|\w\.\w/u);
    }
  });
});
