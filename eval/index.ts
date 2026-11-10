import {
  registerEvalProject,
  type EvalCase,
  type EvalEnvironment,
  type EvalProjectSpec,
} from '@business-ai/eval';
import { HANDOFF_TO_PRICES_TOOL } from '../src/agents/order-calc/handoff-to-prices';
import { pragmatikaProject } from '../src';
import {
  toDocumentsCase,
  toOrderCalcCase,
  toPricesCase,
  toSiteExportCase,
} from './cases';
import { buildDocumentsEnvironment } from './environments/documents';
import { buildHandoffEnvironment } from './environments/handoff';
import { buildOrderCalcEnvironment } from './environments/order-calc';
import { buildPricesEnvironment } from './environments/prices';
import { buildSiteExportEnvironment } from './environments/site-export';
import {
  documentsStateSchema,
  orderCalcStateSchema,
  pricesStateSchema,
  siteExportStateSchema,
} from './state';

export * from './cases';
export * from './constants';
export * from './state';
export * from './synthetic';

/** Описание eval из манифеста проекта: агенты и имена замеров берутся оттуда. */
const manifestEval = pragmatikaProject.eval;
if (manifestEval === undefined) throw new Error('В манифесте Прагматики нет описания eval');

/**
 * Агент набора по передачам - первый в `agentIds` (правило раннера платформы), а набор Прагматики
 * гоняет «Поиск поставщика»: он ставится первым, остальные идут в порядке манифеста.
 */
const HANDOFF_AGENT_ID = 'order-calc';
const agentIds = [
  HANDOFF_AGENT_ID,
  ...manifestEval.agentIds.filter((id) => id !== HANDOFF_AGENT_ID),
];

/** Окружение кейса по агенту: заглушки в памяти с начальным состоянием. */
function buildEnvironment(testCase: EvalCase, model: string): Promise<EvalEnvironment> {
  switch (testCase.agent) {
    case 'prices':
      return buildPricesEnvironment(toPricesCase(testCase), model);
    case 'documents':
      return buildDocumentsEnvironment(toDocumentsCase(testCase), model);
    case 'order-calc':
      return buildOrderCalcEnvironment(toOrderCalcCase(testCase), model);
    case 'site-export':
      return buildSiteExportEnvironment(toSiteExportCase(testCase), model);
    default:
      throw new Error(`Кейс ${testCase.id}: неизвестный агент «${testCase.agent}»`);
  }
}

/** Описание проекта для раннера eval (каталог данных - этот каталог). */
export const pragmatikaEvalSpec: EvalProjectSpec = {
  rootDir: import.meta.dir,
  agentIds,
  probeNames: manifestEval.probeNames,
  stateSchemas: {
    prices: pricesStateSchema,
    documents: documentsStateSchema,
    'order-calc': orderCalcStateSchema,
    'site-export': siteExportStateSchema,
  },
  buildEnvironment,
  buildHandoffEnvironment,
  // Набор по передачам гоняет передачу агенту прайсов, а не нейтральное имя платформы.
  handoffToolName: HANDOFF_TO_PRICES_TOOL,
};

/** Зарегистрировать Прагматику в раннере eval (вызывают точки запуска и preload тестов). */
export function registerPragmatikaEval(): void {
  registerEvalProject(pragmatikaEvalSpec);
}
