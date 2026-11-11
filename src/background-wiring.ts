import {
  CachingDnsTxtResolver,
  ImapSmtpMailboxDirectory,
  MemoryMailStateStore,
} from '@business-ai/adapters';
import type { ProjectContext } from '@business-ai/core';
import { LookupSenderAllowlist } from '@business-ai/core/compose';
import type { SupplierCrmSyncOptions, SupplierCrmSyncResult } from './agents/suppliers/crm-sync';
import { findSuppliersByAddress } from './agents/shared/supplier-email-index';
import type { BackfillApplyDeps } from './agents/suppliers/mail-backfill-apply';
import type { SupplierMailEnrichDeps } from './agents/suppliers/mail-enrich';
import type { MailTrustSurveyDeps } from './agents/suppliers/mail-trust-survey';
import type { PragmatikaConfig } from './config';
import { pragmatikaPortsOf } from './ports';

/**
 * Зависимости разовых команд владельца (проход по общему ящику, обследование доверия, проход по
 * CRM). В прежней сборке их отдавал `ProductionApp` (`infoMailboxBackfill`, `mailTrustSurvey`,
 * `crmSuppliersPass`); платформенный `ProductionApp` их не содержит, поэтому проект собирает их
 * сам из тех же сервисов, что и агентов. Службе они не нужны и нигде не запускаются: берёт их
 * только `src/background-cli.ts`.
 */
export interface BackgroundCommands {
  mailBackfill: {
    /** Зависимости прохода по ящику; нет - почта не подключена. */
    scanDeps?: ((address: string) => SupplierMailEnrichDeps) | undefined;
    applyDeps: BackfillApplyDeps;
    /** Адрес ящика по умолчанию (`INFO_MAILBOX_ENRICH_ADDRESS`). */
    defaultAddress: string | undefined;
    /** Предел обращений к модели по умолчанию (`INFO_MAILBOX_ENRICH_MAX_CLASSIFY_PER_RUN`). */
    maxModelCalls: number | undefined;
    /** Окно прохода по умолчанию, дней (`INFO_MAILBOX_ENRICH_WINDOW_DAYS`). */
    windowDays: number | undefined;
    ownCompanyRequisites: readonly string[];
  };
  /**
   * Зависимости обследования доверия; собираются при вызове (отдельный каталог ящиков в памяти),
   * `undefined` - почта не подключена.
   */
  mailSurvey: () => MailTrustSurveyDeps | undefined;
  /** Проход по CRM; нет - порта компаний CRM-поставщиков в сборке нет (см. G-11). */
  crmPass?: { run: (options: SupplierCrmSyncOptions) => Promise<SupplierCrmSyncResult> };
}

/** Что сборке агентов известно лучше, чем контексту. */
export interface BackgroundWiringInput {
  /** Почта сотрудников подключена (флаг и адаптер или настройка `MAIL_*`). */
  mailConnected: boolean;
  /** Классификатор писем на шлюзе модели; создаётся при вызове команды, не при старте службы. */
  classifier: () => SupplierMailEnrichDeps['classifier'];
}

type Context = ProjectContext<PragmatikaConfig>;

/** Собрать зависимости разовых команд из контекста сборки. Ничего не запускает и не читает. */
export function buildBackgroundCommands(
  ctx: Context,
  input: BackgroundWiringInput,
): BackgroundCommands {
  const { project, services } = ctx;
  const own = pragmatikaPortsOf(ctx.ports.extra);
  const ownCompanyRequisites = project.OWN_COMPANY_REQUISITES ?? [];
  const { mailboxes } = services;
  const mailReady = input.mailConnected && mailboxes !== undefined;
  const scanDeps = mailReady
    ? (sourceAddress: string): SupplierMailEnrichDeps => ({
        suppliers: own.suppliers,
        state: services.state,
        clock: services.clock,
        classifier: input.classifier(),
        mailboxes,
        sourceAddress,
        ownCompanyNames: project.OWN_COMPANY_NAMES,
        ownCompanyRequisites,
        audit: services.audit,
        log: services.log,
        senderTrust: services.mailSenderTrust,
      })
    : undefined;
  const mailConfig = ctx.config.mail;
  const surveyReady = input.mailConnected && mailConfig !== undefined;
  return {
    mailBackfill: {
      scanDeps,
      applyDeps: {
        suppliers: own.suppliers,
        clock: services.clock,
        audit: services.audit,
        log: services.log,
      },
      defaultAddress: project.INFO_MAILBOX_ENRICH_ADDRESS,
      maxModelCalls: project.INFO_MAILBOX_ENRICH_MAX_CLASSIFY_PER_RUN,
      windowDays: project.INFO_MAILBOX_ENRICH_WINDOW_DAYS,
      ownCompanyRequisites,
    },
    mailSurvey: () => {
      if (!surveyReady) return undefined;
      // Обследование только читает: состояние почты - в памяти процесса (в базу ничего не пишется),
      // проверка DKIM включена независимо от `MAIL_SENDER_TRUST_ENABLED` (ради неё и запускают).
      const directory = new ImapSmtpMailboxDirectory({
        server: mailConfig.server,
        mailboxes: mailConfig.mailboxes,
        state: new MemoryMailStateStore(),
        // Допуск отправителей - адреса из базы поставщиков, как у почты службы в прежней сборке.
        allowlist: new LookupSenderAllowlist(
          async (address) => (await findSuppliersByAddress(own.suppliers, address)).length > 0,
          services.clock,
        ),
        clock: services.clock,
        logger: services.log,
        telemetry: services.telemetry,
        dkimResolver: new CachingDnsTxtResolver(),
      });
      return {
        suppliers: own.suppliers,
        mailboxes: directory,
        clock: services.clock,
        ownCompanyRequisites,
        sourceAddress: project.INFO_MAILBOX_ENRICH_ADDRESS,
        log: services.log,
      };
    },
  };
}
