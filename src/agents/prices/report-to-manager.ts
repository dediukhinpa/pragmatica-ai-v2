import { z } from 'zod';
import { intakeFileName, isIntakePath } from '@business-ai/core';
import { defineTool } from '@business-ai/core';
import { baseName, mailboxThreadScope, recordWorkOwner } from '@business-ai/core';
import { workSubject } from '../shared/work-owner.owned';
import { workRecipient, type PricesDeps } from './deps';
import { recordDiskSyncOutcome } from './disk-sync-outcome';
import { isFileRef } from './file-ref';
import { DISK_SYNC_THREAD_PREFIX } from './price-disk-sync';
import { isUnattendedDiskRun } from './unattended-run';
import { resolveFileRefPath } from './price-sources';
import { loadMail, parseMailPath, saveMail, type MailAccess } from './price-state';

/** Что случилось с файлом: от этого зависит текст сообщения. */
const REPORT_KINDS = [
  'import_done',
  'needs_review',
  'scan_skipped',
  'structure_changed',
  /** Прайс из письма неподтверждённого отправителя отклонён сотрудником. */
  'price_rejected',
  /** Письмо с прайсом от отправителя, которого нет среди поставщиков: не обработано. */
  'unknown_sender',
] as const;
type ReportKind = (typeof REPORT_KINDS)[number];

interface ReportInput {
  kind: ReportKind;
  path: string;
  fileHash: string;
  updated: number;
  needsReview: number;
  issueCodes: string[];
  /** Подпись файла для текста (имя вложения письма, файла от сотрудника); берёт код. */
  fileLabel?: string | undefined;
  /** Письмо пришло от неподтверждённого отправителя; берёт код из записи письма. */
  senderUnverified?: boolean | undefined;
}

/** Пометка менеджеру: адрес в письме мог быть подделан. */
const UNVERIFIED_SENDER_REPORT_NOTE =
  ' Отправитель не подтверждён (нет SPF/DKIM/DMARC): проверьте цены у поставщика.';

/** Пометка менеджеру: разбор скриптом пробовали, он не помог. */
const SCRIPT_DID_NOT_HELP_NOTE = ' Разбор скриптом пробовали: скрипт не помог.';
/** Код причины пропуска в сводке импорта: скрипт пробовали, он не помог. */
export const SCRIPT_DID_NOT_HELP_CODE = 'script_did_not_help';

/** Текст сообщения собирается кодом из шаблона и чисел: свободного текста модели в нём нет. */
function buildReportText(input: ReportInput, scriptFailed = false): string {
  const note = input.senderUnverified === true ? UNVERIFIED_SENDER_REPORT_NOTE : '';
  return `${reportBody(input)}${note}${scriptFailed ? SCRIPT_DID_NOT_HELP_NOTE : ''}`;
}

function reportBody(input: ReportInput): string {
  const file = input.fileLabel ?? baseName(input.path);
  switch (input.kind) {
    case 'import_done':
      return `Прайс «${file}»: обновил ${input.updated} позиций, ${input.needsReview} на проверку.`;
    case 'needs_review':
      return `Прайс «${file}» не загружен, нужна проверка (${input.issueCodes.join(', ')}).`;
    case 'scan_skipped':
      return (
        `Файл «${file}» — скан, в нём нет текста. Пришлите Excel или Word, ` +
        'либо внесите позиции вручную. Файл пропущен.'
      );
    case 'structure_changed':
      return (
        `В прайсе «${file}» изменилась структура таблицы, позиции не загружены. ` +
        'Нужно посмотреть файл.'
      );
    case 'unknown_sender':
      // Ящик личный: адрес и тема неопознанного письма менеджеру не показываются.
      return (
        'Письмо с прайсом от отправителя вне базы поставщиков не обработано. ' +
        'Добавьте поставщика в базу или укажите, к кому относится письмо.'
      );
    case 'price_rejected':
      return `Прайс «${file}» из письма неподтверждённого отправителя отклонён и не сохранён.`;
  }
}

/** Сообщить менеджеру итог обработки файла. */
export const reportToManager = defineTool<
  ReportInput,
  { delivered: boolean; inSummary?: boolean | undefined },
  PricesDeps
>({
  name: 'reportToManager',
  scriptAware: true,
  description:
    'Отправить менеджеру итог по файлу прайса: kind (import_done, needs_review, ' +
    'scan_skipped, structure_changed, price_rejected, unknown_sender), path, fileHash, ' +
    'числа updated и needsReview, коды замечаний issueCodes. Для unknown_sender: ' +
    'path=mail:<messageId>, fileHash=messageId. Свободный текст не передаётся. ' +
    'import_done в плановой обработке прайса с диска не отправляется (delivered=false): ' +
    'это не ошибка, не повторяй.',
  sideEffect: true,
  inputSchema: z.object({
    kind: z.enum(REPORT_KINDS),
    path: z.string().min(1),
    fileHash: z.string().min(1),
    updated: z.number().int().nonnegative().default(0),
    needsReview: z.number().int().nonnegative().default(0),
    issueCodes: z.array(z.string().regex(/^[a-z_]+$/)).default([]),
  }),
  // inSummary: итог ушёл в сводку первичного импорта, а не отдельным сообщением. Это штатная
  // доставка; без поля агент читал delivered:false как сбой и просил передать отчёт вручную.
  outputSchema: z.object({ delivered: z.boolean(), inSummary: z.boolean().optional() }),
  idempotencyKey: (input) => reportKey(input),
  // Кэш отдаётся до проверки доступа к письму: в режиме ящиков тред входит в ключ операции.
  idempotencyPredecessor: (_input, deps, threadId) =>
    Promise.resolve(mailboxThreadScope(deps.mailboxes !== undefined, threadId)),
  async execute(input, deps, context) {
    // Файл первичного импорта: итог идёт в сводку ответственному, а не отдельным сообщением.
    // Скрипт пробовали и он не помог: пометка в итоге и в сводке первичного импорта.
    const scriptFailed = SKIP_KINDS.has(input.kind) && context.scriptTurn?.didNotHelp() === true;
    if (await recordSkipped(input, deps, context.threadId, scriptFailed)) {
      return { delivered: false, inSummary: true };
    }
    // Записанный по расписанию прайс с диска - не повод писать; сбои (не загружен) сообщаются.
    if (
      input.kind === 'import_done' &&
      (await isUnattendedDiskRun(deps, context.threadId, input.fileHash))
    ) {
      return { delivered: false };
    }
    const text = buildReportText(await withDetails(input, deps, context), scriptFailed);
    // Адресат - сотрудник, начавший работу с файлом; без владельца - менеджер. Файл мог
    // не дойти до staging (скан, неопознанное письмо): тогда владельца фиксирует отчёт.
    const subject = workSubject.import(input.fileHash);
    await recordWorkOwner(deps.state, subject, context, deps.log);
    await deps.chat.reply(await workRecipient(deps, subject), { text }, reportKey(input));
    if (input.kind === 'unknown_sender') await markUnknownReported(input, deps, context);
    return { delivered: true };
  },
});

/** Виды итога, при которых файл не записан: попадают в сводку с причиной. */
const SKIP_KINDS: ReadonlySet<ReportKind> = new Set([
  'needs_review',
  'scan_skipped',
  'structure_changed',
]);

/**
 * Файл идёт в первичном импорте (есть запись о нём): пропуск фиксируется в итогах с причиной, а
 * отдельное сообщение не шлётся (на тысячи файлов оно утопило бы чат). Возвращает true, если
 * сообщение подавлено. Записанный файл (`import_done`) тоже входит в сводку, не в сообщение.
 */
async function recordSkipped(
  input: ReportInput,
  deps: PricesDeps,
  threadId: string,
  scriptFailed: boolean,
): Promise<boolean> {
  if (!threadId.startsWith(DISK_SYNC_THREAD_PREFIX)) return false;
  const skipped = SKIP_KINDS.has(input.kind);
  // В первичном импорте прежнего прайса поставщика нет: «изменилась структура» сказать нельзя,
  // это сложная таблица. Подмена в коде, а не в промпте: модель называет так любую сложную
  // таблицу. Без записи итога (обычная синхронизация) подмены нет: patch ниже не запишется.
  const reported = input.kind === 'structure_changed' ? complexTableReport(input) : input;
  const codes = [
    ...reported.issueCodes,
    ...(scriptFailed ? [SCRIPT_DID_NOT_HELP_CODE] : []),
  ].join(',');
  const patch = skipped
    ? {
        status: 'skipped' as const,
        reason: codes === '' ? reported.kind : `${reported.kind}:${codes}`,
      }
    : {};
  const outcome = await recordDiskSyncOutcome(deps, threadId, patch);
  return outcome !== null && (skipped || input.kind === 'import_done');
}

/** Код причины для «структуры» без прежнего прайса: сложная таблица. */
export const COMPLEX_TABLE_CODE = 'complex_table';

function complexTableReport(input: ReportInput): ReportInput {
  const rest = input.issueCodes.filter((code) => code !== COMPLEX_TABLE_CODE);
  return { ...input, kind: 'needs_review', issueCodes: [COMPLEX_TABLE_CODE, ...rest] };
}

/** Подписи файла и письма берёт код из хранилищ: адрес отправителя не идёт через модель. */
async function withDetails(
  input: ReportInput,
  deps: PricesDeps,
  access: MailAccess,
): Promise<ReportInput> {
  const mail = parseMailPath(input.path);
  if (input.kind === 'unknown_sender') {
    const record = await loadMail(deps, mail?.messageId ?? input.fileHash, access);
    const senderUnverified = record.senderVerified !== true;
    return { ...input, senderUnverified };
  }
  if (mail !== null) {
    const record = await loadMail(deps, mail.messageId, access);
    const attachment = record.attachments.find((item) => item.index === mail.index);
    const base = { ...input, senderUnverified: record.senderVerified !== true };
    return attachment === undefined ? base : { ...base, fileLabel: attachment.fileName };
  }
  if (isFileRef(input.path)) {
    // Менеджеру в тексте нужно имя файла, а не служебный идентификатор.
    return { ...input, fileLabel: baseName(await resolveFileRefPath(deps, input.path)) };
  }
  return isIntakePath(input.path) ? { ...input, fileLabel: intakeFileName(input.path) } : input;
}

/** О неопознанном письме сообщили: повторно в отчёт оно не попадает. */
async function markUnknownReported(
  input: ReportInput,
  deps: PricesDeps,
  access: MailAccess,
): Promise<void> {
  const record = await loadMail(
    deps,
    parseMailPath(input.path)?.messageId ?? input.fileHash,
    access,
  );
  if (record.status === 'unknown') await saveMail(deps, { ...record, status: 'unknown_reported' });
}

function reportKey(input: ReportInput): string {
  return `prices-report:${input.kind}:${input.fileHash}:${[...input.issueCodes].sort().join(',')}`;
}
