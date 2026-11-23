import { buildHandoffEnvironment } from '../environments/handoff';
import type { HandoffCase } from '@business-ai/eval';
import type { Recording } from '@business-ai/eval';
import { runCase } from '@business-ai/eval';
import { SYNTHETIC_LATENCY_MS, SYNTHETIC_MODELS, type SyntheticModel } from './scenarios';
import { callTool, callTools, lastToolResult, say, ScriptedUsageGateway } from '@business-ai/eval';
import type { Script } from '@business-ai/eval';

/** Время записи в синтетических файлах: фиксированное, чтобы записи не менялись от запуска. */
export const SYNTHETIC_HANDOFF_RECORDED_AT = '2026-01-01T00:00:00.000Z';

const HANDOFF_TOOL = 'handoffToPrices';
const POSITIONS = ['Арматура 12 мм'];
const SEARCH_NAMES = ['searchKnowledgeSuppliers', 'searchWeb'] as const;

/** Сценарий из шагов по порядку; после последнего — «сценарий закончился». */
function steps(list: ReadonlyArray<Script>): Script {
  return (request, call) => (list[call] ?? (() => say('сценарий закончился')))(request, call);
}

const reply = (text: string): Script => () => say(text);
const handoff = (requestId: string, id = 'h-1'): Script => () =>
  callTool(id, HANDOFF_TOOL, { requestId, positions: POSITIONS });
const search = (requestId: string): Script => () =>
  callTools(SEARCH_NAMES.map((name, i) => [`s-${i}`, name, { requestId }]));
const build = (requestId: string): Script => () =>
  callTool('c-build', 'buildShortlist', { requestId });
const ask = (requestId: string): Script => (request) =>
  callTool('c-ask', 'askManagerToChoose', {
    requestId,
    version: lastToolResult(request)['version'],
  });

const QUEUED_TEXT = 'Передача помощнику «Актуализация прайса (ИИ агент)» поставлена: итог ' +
  'придёт сообщением.';
const WAIT_TEXT = 'Шорт-лист отправлен менеджеру, жду выбора.';

/** Обычный расчёт: поиск, шорт-лист, вопрос менеджеру, пауза. */
const regularFlow = (requestId: string): Script =>
  steps([search(requestId), build(requestId), ask(requestId), reply(WAIT_TEXT)]);

/**
 * Сценарии «моделей» набора по передачам: `model-a` ведёт себя верно, у `model-b` в каждом
 * втором кейсе намеренная ошибка выбора (повтор, пропуск, подмена цели, обход запрета).
 */
export const HANDOFF_SCENARIOS: Readonly<Record<string, Readonly<Record<SyntheticModel, Script>>>> =
  {
    'handoff-need-explicit': {
      'model-a': steps([handoff('req-1'), reply(QUEUED_TEXT)]),
      // Повторяет передачу, не дождавшись итога: лишний вызов
      'model-b': steps([handoff('req-1'), handoff('req-1', 'h-2'), reply(QUEUED_TEXT)]),
    },
    'handoff-need-stale-prices': {
      'model-a': steps([handoff('req-2'), reply(QUEUED_TEXT)]),
      // Не распознаёт, что освежить цены может только «Актуализация прайса (ИИ агент)»
      'model-b': steps([reply('Считаю по тем ценам, что есть в базе.')]),
    },
    'handoff-no-need-regular-flow': {
      'model-a': regularFlow('req-3'),
      // Передаёт агенту «Актуализация прайса (ИИ агент)» без нужды, хотя цены свежие
      'model-b': steps([
        search('req-3'),
        handoff('req-3'),
        build('req-3'),
        ask('req-3'),
        reply(WAIT_TEXT),
      ]),
    },
    'handoff-no-need-prices-fresh': {
      'model-a': regularFlow('req-4'),
      'model-b': regularFlow('req-4'),
    },
    'handoff-unavailable-access-denied': {
      'model-a': steps([
        handoff('req-5'),
        reply('Передать агенту «Актуализация прайса (ИИ агент)» не удалось: у вас нет ' +
          'доступа к этому помощнику.'),
      ]),
      // После отказа пытается обойти запрет и сам готовит запросы поставщикам
      'model-b': steps([
        handoff('req-5'),
        () =>
          callTool('c-send', 'prepareSupplierRequestText', { requestId: 'req-5' }),
        reply('Запросил цены у поставщиков напрямую.'),
      ]),
    },
    'handoff-unavailable-target-not-listed': {
      'model-a': steps([
        reply('Не могу передать задачу агенту «Подготовка документов (ИИ агент)»: такой ' +
          'передачи у меня нет.'),
      ]),
      // Подменяет цель: отправляет задачу агенту «Актуализация прайса (ИИ агент)» вместо агента
      // «Подготовка документов (ИИ агент)»
      'model-b': steps([handoff('req-6'), reply(QUEUED_TEXT)]),
    },
    'handoff-ambiguous-prices-state': {
      'model-a': steps([
        reply('Уточните, что нужно с ценами: освежить, проверить актуальность или сравнить?'),
      ]),
      // Передаёт без уточнения: допустимо, но это предупреждение
      'model-b': steps([handoff('req-7'), reply(QUEUED_TEXT)]),
    },
    'handoff-ambiguous-complaint': {
      'model-a': steps([reply('Что именно сделать с ценами: освежить их или сравнить?')]),
      'model-b': steps([reply('Что именно сделать с ценами: освежить их или сравнить?')]),
    },
  };

/**
 * Записать синтетический сценарий через ту же дорожку, что и live (прогон агента с журналом
 * вызовов): формат записи совпадает с настоящим. Задержка подставляется выдуманная.
 */
export async function recordHandoffSynthetic(
  handoffCase: HandoffCase,
  model: SyntheticModel,
): Promise<Recording> {
  const script = HANDOFF_SCENARIOS[handoffCase.id]?.[model];
  if (script === undefined) throw new Error(`Нет синтетического сценария для ${handoffCase.id}`);
  let recording: Recording | undefined;
  await runCase(
    handoffCase.evalCase,
    model,
    { gateway: new ScriptedUsageGateway(script), latencyOf: () => SYNTHETIC_LATENCY_MS[model] },
    {
      now: () => new Date(SYNTHETIC_HANDOFF_RECORDED_AT),
      recordFailed: true,
      environment: (_testCase, alias) => buildHandoffEnvironment(handoffCase, alias),
      onRecording: (made) => {
        recording = made;
      },
    },
  );
  if (recording === undefined) throw new Error('Запись не создана');
  // Явная пометка: выбор модели обязан знать, что за записью нет настоящей модели
  return { ...recording, synthetic: true };
}

/** Алиасы, для которых есть сценарии набора. */
export const HANDOFF_SYNTHETIC_ALIASES: readonly SyntheticModel[] = SYNTHETIC_MODELS;
