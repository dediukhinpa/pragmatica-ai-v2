import {
  MONITORING_JOB,
  MONITORING_TICK_INTERVAL_MS,
  runMonitoringTick,
  signalDutyFailure,
  type DefaultJobsOptions,
  type JobHandler,
  type MonitoringDutySpec,
  type ProductionConfig,
} from '@business-ai/core/compose';
import type { ProjectSchedule } from '@business-ai/core';
import { HOUR_MS } from './kit/domain/time';
import { ORDER_CALC_AGENT_ID, type OrderCalcDeps } from './agents/order-calc';
import { runOrdersDigest } from './agents/order-calc/orders-digest';
import { PRICES_AGENT_ID, type PricesDeps } from './agents/prices';
import { runPriceRetryTick } from './agents/prices/disk-sync-retry';
import { PRICE_DISK_SYNC_INTERVAL_MS, runPriceDiskSync } from './agents/prices/price-disk-sync';
import { runPriceMailTriggers } from './agents/prices/price-mail-triggers';
import { runStalePriceFilesCheck } from './agents/prices/stale-price-files';
import { runSupplierMailProposals } from './agents/suppliers/mail-proposals';
import type { PragmatikaConfig } from './config';
import { pragmatikaRuntime } from './runtime';

/** Синхронизация цен с диска (диск - источник правды). */
export const PRICE_DISK_SYNC_JOB = 'prices.disk-sync';
/**
 * Устаревшая задача CRM-синхронизации поставщиков: расписания больше нет (разовый проход), но
 * задача могла остаться в очереди, и без обработчика она давала бы `unknown_job`.
 */
export const SUPPLIER_CRM_SYNC_JOB = 'suppliers.crm-sync';
/** Обзор почты сотрудников: предложения завести карточки поставщиков. */
export const SUPPLIER_MAIL_PROPOSALS_JOB = 'suppliers.mail-proposals';
/** Как часто тикает обзор почты: проход раз в несколько суток, тик только проверяет слот. */
export const SUPPLIER_MAIL_PROPOSALS_TICK_INTERVAL_MS = HOUR_MS;

/** Предметные переменные из общей конфигурации (в `ProductionConfig` они не типизированы). */
function projectOf(config: ProductionConfig): Partial<PragmatikaConfig> {
  return (config.project ?? {}) as Partial<PragmatikaConfig>;
}

/**
 * Зависимости агентов для задач: те, что получила служба (`options.app.agentDeps`), иначе
 * снимок из сборки. В бою это один и тот же объект; тесты подменяют часы именно в службе.
 */
function orderCalcDepsOf(options: DefaultJobsOptions, fallback: OrderCalcDeps): OrderCalcDeps {
  return (options.app.agentDeps?.[ORDER_CALC_AGENT_ID] as OrderCalcDeps | undefined) ?? fallback;
}

function pricesDepsOf(options: DefaultJobsOptions, fallback: PricesDeps): PricesDeps {
  return (options.app.agentDeps?.[PRICES_AGENT_ID] as PricesDeps | undefined) ?? fallback;
}

/** Обязанности тика мониторинга: сводка по заказам и две проверки прайсов. */
function duties(options: DefaultJobsOptions, now: Date): readonly MonitoringDutySpec[] {
  const runtime = pragmatikaRuntime();
  if (runtime === undefined) return [];
  const { timezone } = runtime;
  const orderCalc = orderCalcDepsOf(options, runtime.orderCalc);
  const prices = pricesDepsOf(options, runtime.prices);
  const log = options.log ?? ((): void => undefined);
  const alert =
    options.chat === undefined || options.operatorThreadId === undefined
      ? undefined
      : { chat: options.chat, threadId: options.operatorThreadId };
  const tick = { timezone, log, audit: options.audit, alert, telemetry: options.app.telemetry };
  return [
    {
      name: 'orders_digest',
      run: async () =>
        (
          await runOrdersDigest(orderCalc, {
            timezone,
            openMaxDays: runtime.orderDigestOpenMaxDays,
          })
        ).status,
    },
    {
      name: 'stale_price_files',
      run: async () => (await runStalePriceFilesCheck(prices, { timezone })).status,
    },
    {
      name: 'price_mail_triggers',
      run: async () => {
        const run = await runPriceMailTriggers(prices, {
          timezone,
          supplierAttachmentMaxPerRun: prices.supplierAttachmentMaxPerRun,
        });
        // Итог просмотра - всегда, даже нулевой: молчание слота должно быть видно. Только счётчики.
        if (run.status === 'done') {
          log('price_mail_scan', {
            scanned: run.scanned,
            skipped_old: run.skippedOld,
            skipped_not_supplier: run.skippedForeign,
            name_ambiguous: run.nameAmbiguous,
            no_trigger: run.noTrigger,
            assessed: run.assessed,
            not_relevant: run.assessedNotRelevant,
            assess_deferred: run.assessDeferred,
            notified: run.notified,
            notified_by_name: run.notifiedByName,
          });
        }
        if (
          run.assessedNotRelevant > 0 ||
          run.assessorFailed > 0 ||
          run.supplierAttachmentMatched > 0
        ) {
          log('price_mail_assessment', {
            not_relevant: run.assessedNotRelevant,
            failed: run.assessorFailed,
            supplier_attachment_matched: run.supplierAttachmentMatched,
            supplier_attachment_deferred: run.supplierAttachmentDeferred,
          });
        }
        // Ящик с непереносимой ошибкой (отозван пароль): слот закрыт, оператору - сигнал.
        if (run.failed > 0) {
          await signalDutyFailure(tick, 'price_mail_triggers', 'mailbox_failed', now);
        }
        return run.status;
      },
    },
  ];
}

/** Обработчик тика мониторинга; регистрируется всегда, при выключенном флаге ничего не делает. */
function monitoringHandler(options: DefaultJobsOptions): JobHandler {
  return async (_task, now) => {
    const runtime = pragmatikaRuntime();
    if (runtime === undefined || !runtime.monitoringEnabled) return;
    const log = options.log ?? ((): void => undefined);
    const alert =
      options.chat === undefined || options.operatorThreadId === undefined
        ? undefined
        : { chat: options.chat, threadId: options.operatorThreadId };
    await runMonitoringTick(
      {
        timezone: runtime.timezone,
        log,
        audit: options.audit,
        alert,
        telemetry: options.app.telemetry,
      },
      duties(options, now),
      now,
    );
  };
}

/** Синхронизация цен с диска: новые и изменённые прайсы ставятся агенту прайсов на импорт. */
function priceDiskSyncHandler(options: DefaultJobsOptions): JobHandler {
  return async () => {
    const runtime = pragmatikaRuntime();
    if (runtime === undefined || !runtime.priceDiskSyncEnabled) return;
    const prices = pricesDepsOf(options, runtime.prices);
    if (prices.state === undefined) return;
    // Запуски на файлы - обычные `agent.run`; итог файла закрывают хуки манифеста (G-8).
    const { scheduler } = options.app;
    const result = await runPriceDiskSync(prices, scheduler, {
      initialImport: runtime.priceDiskInitialImportEnabled,
    });
    // Догрузка отложенных файлов (если владелец её запустил): своя очередь и свой лимит за тик.
    const retry = await runPriceRetryTick(prices, scheduler);
    options.log?.('price_disk_sync', {
      ...(retry.enqueued + retry.skippedWritten + retry.remaining === 0 && !retry.summarySent
        ? {}
        : { retryEnqueued: retry.enqueued, retryRemaining: retry.remaining }),
      status: result.status,
      enqueued: result.enqueued,
      deferred: result.deferred,
      // Только числа: названия поставщиков и файлов в журнал не идут.
      suppliersCreated: result.suppliersCreated ?? 0,
      suppliersAsked: result.suppliersAsked ?? 0,
      ...(result.initialImport === undefined ? {} : { initialImport: result.initialImport }),
    });
  };
}

/** Обзор почты: без собранной обязанности (флаг выключен) ничего не делает и не пишет в журнал. */
function mailProposalsHandler(options: DefaultJobsOptions): JobHandler {
  return async () => {
    const proposals = pragmatikaRuntime()?.mailProposals;
    if (proposals === undefined) return;
    const result = await runSupplierMailProposals(proposals.deps, proposals.options);
    // Тик идёт раз в час, а проход - раз в несколько суток: «не время» в журнал не пишем.
    if (result.status !== 'done') return;
    options.log?.('supplier_mail_proposals', { ...result });
  };
}

/**
 * Плановые задачи Прагматики. Обработчики регистрируются всегда (задача в очереди переживает
 * выключение флага), повторяющаяся постановка - только при включённом флаге (`enabled`).
 */
export const PROJECT_SCHEDULES: readonly ProjectSchedule[] = [
  {
    name: MONITORING_JOB,
    handler: monitoringHandler,
    repeat: { everyMs: MONITORING_TICK_INTERVAL_MS },
    enabled: (config) => config.agents.monitoringEnabled,
  },
  {
    name: PRICE_DISK_SYNC_JOB,
    handler: priceDiskSyncHandler,
    repeat: { everyMs: PRICE_DISK_SYNC_INTERVAL_MS },
    enabled: (config) => projectOf(config).PRICE_DISK_SYNC_ENABLED === 'true',
  },
  {
    name: SUPPLIER_MAIL_PROPOSALS_JOB,
    handler: mailProposalsHandler,
    repeat: { everyMs: SUPPLIER_MAIL_PROPOSALS_TICK_INTERVAL_MS },
    enabled: (config) => projectOf(config).SUPPLIER_MAIL_PROPOSALS_ENABLED === 'true',
  },
  { name: SUPPLIER_CRM_SYNC_JOB, handler: () => async () => undefined },
];
