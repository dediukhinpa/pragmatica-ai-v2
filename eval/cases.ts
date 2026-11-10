import type { EvalCase } from '@business-ai/eval';
import type { z } from 'zod';
import type {
  documentsStateSchema,
  orderCalcStateSchema,
  pricesStateSchema,
  siteExportStateSchema,
} from './state';

/** Предложение шорт-листа, которое агент «Поиск поставщика» сохранил в состоянии. */
export interface ProposalView {
  /** id поставщиков в порядке ранжирования. */
  supplierIds: string[];
}

/** Кейс агента прайсов: общий кейс платформы с типизированным состоянием. */
export interface PricesCase extends EvalCase {
  agent: 'prices';
  state: z.output<typeof pricesStateSchema>;
}

/** Кейс агента документов. */
export interface DocumentsCase extends EvalCase {
  agent: 'documents';
  state: z.output<typeof documentsStateSchema>;
}

/** Кейс агента «Поиск поставщика». */
export interface OrderCalcCase extends EvalCase {
  agent: 'order-calc';
  state: z.output<typeof orderCalcStateSchema>;
}

/** Кейс агента выгрузки на сайт. */
export interface SiteExportCase extends EvalCase {
  agent: 'site-export';
  state: z.output<typeof siteExportStateSchema>;
}

/** Привести общий кейс к кейсу агента: чужой агент - ошибка, состояние уже разобрано схемой. */
function narrow<T extends EvalCase>(testCase: EvalCase, agent: T['agent']): T {
  if (testCase.agent !== agent) {
    throw new Error(`Кейс ${testCase.id}: агент «${testCase.agent}», ожидался ${agent}`);
  }
  return testCase as T;
}

export const toPricesCase = (testCase: EvalCase): PricesCase => narrow(testCase, 'prices');
export const toDocumentsCase = (testCase: EvalCase): DocumentsCase =>
  narrow(testCase, 'documents');
export const toOrderCalcCase = (testCase: EvalCase): OrderCalcCase =>
  narrow(testCase, 'order-calc');
export const toSiteExportCase = (testCase: EvalCase): SiteExportCase =>
  narrow(testCase, 'site-export');
