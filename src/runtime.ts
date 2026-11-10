import type { Clock, WorkflowStateStore } from '@business-ai/core';
import type { OrderCalcDeps } from './agents/order-calc';
import type { PricesDeps } from './agents/prices';
import type { SupplierCardButtons } from './agents/suppliers/card-approval';
import type { SupplierCardsDeps } from './agents/suppliers/deps';
import type { SupplierMailProposalsOptions } from './agents/suppliers/mail-proposals';
import type { SupplierMailProposalsDeps } from './agents/suppliers/mail-proposal-store';
import type { ExportedFile } from '@business-ai/core';

/** Обязанность «обзор почты»: запуск и блок состояния хода. */
export interface MailProposalsRuntime {
  deps: SupplierMailProposalsDeps;
  options: SupplierMailProposalsOptions;
}

/** Карточки поставщиков: сервис нажатий, зависимости и загрузчик файла-шаблона. */
export interface SupplierCardsRuntime {
  deps: SupplierCardsDeps;
  buttons: SupplierCardButtons;
  loadTemplate: () => Promise<ExportedFile>;
}

/**
 * Состояние собранного приложения, которое нужно обработчикам кнопок, файлов и плановым задачам
 * манифеста. Манифест статичен и строится до конфигурации, поэтому всё, что зависит от
 * окружения, появляется здесь при сборке агентов (`agents(ctx)`).
 */
export interface PragmatikaRuntime {
  clock: Clock;
  state: WorkflowStateStore;
  orderCalc: OrderCalcDeps;
  prices: PricesDeps;
  /** Часовой пояс бизнеса (`BUSINESS_TIMEZONE`). */
  timezone: string;
  /** Предел возраста открытого заказа в сводке (`ORDER_DIGEST_OPEN_MAX_DAYS`). */
  orderDigestOpenMaxDays: number;
  /** Плановый мониторинг включён (`MONITORING_ENABLED`). */
  monitoringEnabled: boolean;
  priceDiskSyncEnabled: boolean;
  priceDiskInitialImportEnabled: boolean;
  supplierCards?: SupplierCardsRuntime | undefined;
  mailProposals?: MailProposalsRuntime | undefined;
}

/** Один процесс - одно приложение: последняя сборка и есть действующая. */
let current: PragmatikaRuntime | undefined;

/** Запомнить состояние собранного приложения (вызывает только сборка агентов). */
export function setPragmatikaRuntime(runtime: PragmatikaRuntime): void {
  current = runtime;
}

/** Состояние приложения; `undefined`, пока агенты не собраны (кнопки тогда «не действуют»). */
export function pragmatikaRuntime(): PragmatikaRuntime | undefined {
  return current;
}

/** Сбросить состояние приложения (для тестов: процесс тестов общий на все файлы). */
export function clearPragmatikaRuntime(): void {
  current = undefined;
}
