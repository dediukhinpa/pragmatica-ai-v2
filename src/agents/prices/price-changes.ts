import { z } from 'zod';
import {
  DEFAULT_JUMP_THRESHOLD,
  PRICE_REVIEW_REASONS,
  diffPricesSteps,
  type PriceChange,
  type PriceDiff,
  type PriceReviewReason,
} from '../../kit/domain/price-diff';
import { DomainError } from '@business-ai/core';
import { PRICE_QUALIFIERS, priceItemSchema } from '../../kit/domain/models';
import { shownPrice } from '../../kit/domain/market-price';
import type { TableCell, TableSheet } from '@business-ai/core';
import { defineTool } from '@business-ai/core';
import { readState, requirePort, stableHash, toStoredJson, writeState } from '@business-ai/core';
import { workSubject } from '../shared/work-owner.owned';
import { chatThreadOf } from '@business-ai/core';
import { sendExportedFile } from '@business-ai/core';
import {
  CHANGES_FILE_FORMAT,
  PREVIEW_EXAMPLES_LIMIT,
  PREVIEW_NAMESPACE,
  changeFileRecipient,
  type PricesDeps,
} from './deps';
import { loadConfirmedPrices } from './confirmed-prices';
import { confirmedInScope, sourceScopeOf } from './source-scope';
import { loadSupplierDiskFiles } from './supplier-file-history';
import { priceListHash } from './employee-updates';
import { jumpFingerprint } from './jump-fingerprint';
import { importMetaSchema, loadImportMeta, requireState, type ImportMeta } from './price-state';
import { runPriceStepsYielding, yieldToEventLoop } from './price-steps';
import { loadPriceProposal, russianDate, type PriceProposal } from './price-proposals';
import { isUnattendedDiskRun } from './unattended-run';
import { stagingImportId } from './staging-source';

/** Длина даты в ISO-строке (гггг-мм-дд) и перевод доли в проценты. */
const ISO_DATE_LENGTH = 10;
const PERCENT = 100;

const changeSchema = z.object({
  key: z.string(),
  productName: z.string(),
  sku: z.string().optional(),
  oldPrice: z.number(),
  newPrice: z.number(),
  oldQualifier: z.enum(PRICE_QUALIFIERS).optional(),
  oldMax: z.number().optional(),
  newQualifier: z.enum(PRICE_QUALIFIERS).optional(),
  newMax: z.number().optional(),
  currency: z.string(),
  oldCurrency: z.string(),
  changePct: z.number(),
  confirmedPrice: z.number().optional(),
  confirmedCurrency: z.string().optional(),
  removed: z.boolean().optional(),
  newItem: z.boolean().optional(),
});
const reviewSchema = z.object({
  key: z.string(),
  productName: z.string(),
  sku: z.string().optional(),
  reason: z.enum(PRICE_REVIEW_REASONS),
});
const diffSchema = z.object({
  added: z.array(priceItemSchema),
  removed: z.array(priceItemSchema),
  changed: z.array(changeSchema),
  jumps: z.array(changeSchema),
  review: z.array(reviewSchema),
  unchanged: z.number().int(),
});

/** Сохранённый результат сравнения: из него собирается файл и после фиксации. */
const previewSchema = z.object({
  importId: z.string(),
  supplierId: z.string(),
  supplierName: z.string(),
  fileHash: z.string(),
  createdAt: z.string(),
  diffHash: z.string(),
  jumpHash: z.string(),
  meta: importMetaSchema.nullable(),
  diff: diffSchema,
});
type Preview = z.infer<typeof previewSchema>;

const countsSchema = z.object({
  added: z.number().int(),
  removed: z.number().int(),
  changed: z.number().int(),
  jumps: z.number().int(),
  review: z.number().int(),
  unchanged: z.number().int(),
});

function counts(diff: PriceDiff): z.infer<typeof countsSchema> {
  return {
    added: diff.added.length,
    removed: diff.removed.length,
    changed: diff.changed.length,
    jumps: diff.jumps.length,
    review: diff.review.length,
    unchanged: diff.unchanged,
  };
}

interface PreviewInput {
  supplierId: string;
  fileHash: string;
}
interface PreviewOutput {
  importId: string;
  diffHash: string;
  jumpHash: string;
  thresholdPct: number;
  counts: z.infer<typeof countsSchema>;
  /** Строк файла, признанных «не позиция» (группы, итоги, «по запросу», шапка). */
  skippedRowCount: number;
  /** Файл прочитан не целиком: фиксация будет заблокирована. */
  truncated: boolean;
  changedExamples: PriceChange[];
  jumpExamples: PriceChange[];
}

/**
 * Сравнить накопленный в staging прайс с текущим прайсом поставщика ДО фиксации и сохранить
 * результат: по нему собирается файл изменений для ответственного.
 */
export const previewPriceChanges = defineTool<PreviewInput, PreviewOutput, PricesDeps>({
  name: 'previewPriceChanges',
  description:
    'Сравнить прайс в staging с текущим прайсом поставщика до фиксации: новые позиции, ' +
    'снятые, изменения цен (в %), скачки сверх порога, позиции без артикула и ' +
    'неоднозначные. Возвращает числа и примеры (полный результат сохраняется для файла ' +
    'изменений), diffHash и jumpHash. Скачки фиксацию не блокируют, подтверждения не ' +
    'требуют и попадают в файл изменений.',
  inputSchema: z.object({ supplierId: z.string().min(1), fileHash: z.string().min(1) }),
  outputSchema: z.object({
    importId: z.string(),
    diffHash: z.string(),
    jumpHash: z.string(),
    thresholdPct: z.number(),
    counts: countsSchema,
    skippedRowCount: z.number().int(),
    truncated: z.boolean(),
    changedExamples: z.array(changeSchema),
    jumpExamples: z.array(changeSchema),
  }),
  async execute(input, deps) {
    const state = requireState(deps);
    const importId = stagingImportId(input.supplierId, input.fileHash);
    const staged = await deps.staging.load(importId);
    if (staged === null) {
      throw new DomainError('not_found', 'Нет добавленных позиций для этого файла.');
    }
    const supplier = await deps.suppliers.get(input.supplierId);
    const all = await deps.prices.listBySupplier(input.supplierId);
    // Несколько прайс-файлов у поставщика: «снятые» и изменения - только в пределах файла.
    const meta = await loadImportMeta(deps, importId);
    const previewFile = meta?.source === 'disk' ? meta.fileName : undefined;
    const history =
      previewFile === undefined
        ? undefined
        : await loadSupplierDiskFiles(
            deps.state,
            input.supplierId,
            all.flatMap((item) => (item.sourceFile === undefined ? [] : [item.sourceFile])),
          );
    const fileHashMatch =
      previewFile !== undefined && (await deps.prices.hasNullRowsFromFile(input.supplierId, input.fileHash));
    const scope = sourceScopeOf(all, previewFile, history, staged.items, fileHashMatch);
    const existing = scope.replaced;
    // Скачки считаются так же, как при фиксации: от базы и от ранее принятых цен.
    const confirmed = confirmedInScope(await loadConfirmedPrices(deps, input.supplierId), scope);
    // По шагам, с уступками циклу событий: прайс бывает в 100 тыс. позиций (R9-A1-01).
    const diff = await runPriceStepsYielding(
      diffPricesSteps(existing, staged.items, DEFAULT_JUMP_THRESHOLD, confirmed),
    );
    const diffHash = stableHash(diff);
    // Отпечаток большого diff и отпечаток базы - два синхронных куска по сотням мс на 100 тыс.
    // позиций: между ними цикл событий получает управление (R9-A1-01).
    await yieldToEventLoop();
    // Отпечаток базы считается один раз по уже прочитанному прайсу: повторное чтение прайса
    // означало бы ещё один полный разбор.
    const baseHash = priceListHash(all);
    const jumpHash = await jumpFingerprint(deps, input.supplierId, diff.jumps, baseHash);
    const preview: Preview = {
      importId,
      supplierId: input.supplierId,
      supplierName: supplier?.name ?? input.supplierId,
      fileHash: input.fileHash,
      createdAt: deps.clock.now().toISOString(),
      diffHash,
      jumpHash,
      meta,
      diff,
    };
    await writeState(state, PREVIEW_NAMESPACE, importId, preview);
    return {
      importId,
      diffHash,
      jumpHash,
      thresholdPct: DEFAULT_JUMP_THRESHOLD * PERCENT,
      counts: counts(diff),
      skippedRowCount: staged.skippedRowCount,
      truncated: staged.truncated,
      changedExamples: diff.changed.slice(0, PREVIEW_EXAMPLES_LIMIT),
      jumpExamples: diff.jumps.slice(0, PREVIEW_EXAMPLES_LIMIT),
    };
  },
});

/** Подписи причин для листа «На проверку». */
const REVIEW_REASON_LABELS: Readonly<Record<PriceReviewReason, string>> = {
  price_jump: 'Скачок цены',
  no_sku: 'Нет артикула',
  duplicate: 'Дубль в прайсе',
  same_name_different_sku: 'Одно название, разные артикулы',
  currency_changed: 'Изменилась валюта',
  sku_changed: 'Артикул изменился, позиция найдена по названию',
};

const SOURCE_LABELS: Readonly<Record<string, string>> = {
  disk: 'Файл с сетевого диска',
  intake: 'Файл от сотрудника',
  mail: 'Письмо поставщика',
  employee: 'Сообщение сотрудника',
};

function currencyText(change: PriceChange): string {
  return change.oldCurrency === change.currency
    ? change.currency
    : `${change.oldCurrency} → ${change.currency}`;
}

function jumpDetails(jump: PriceChange): string {
  const oldPrice = shownPrice(jump.oldPrice, jump.oldQualifier, jump.oldMax);
  const newPrice = shownPrice(jump.newPrice, jump.newQualifier, jump.newMax);
  if (jump.removed === true) return `снята с прайса, была ${oldPrice} ${jump.oldCurrency}`;
  const sign = jump.changePct > 0 ? '+' : '';
  if (jump.newItem === true) {
    return `новая позиция ${newPrice}, одноимённая в прайсе ${oldPrice} ` +
      `(${sign}${jump.changePct}%)`;
  }
  const confirmed =
    jump.confirmedPrice === undefined ? '' : `, ранее принятая цена ${jump.confirmedPrice}`;
  return `было ${oldPrice}, стало ${newPrice} (${sign}${jump.changePct}%)${confirmed}`;
}

/**
 * Строки листа «На проверку». Скачки не подтверждаются кнопкой: сотрудник видит их здесь и
 * сверяет перед внесением на диск (решение владельца 26.10.2026).
 */
function reviewRows(preview: Preview): TableCell[][] {
  const jumps = new Map(preview.diff.jumps.map((jump) => [jump.key, jump]));
  return preview.diff.review.map((entry): TableCell[] => {
    const jump = entry.reason === 'price_jump' ? jumps.get(entry.key) : undefined;
    const details = jump === undefined ? '' : `${jumpDetails(jump)}; проверьте перед внесением`;
    return [entry.sku ?? '', entry.productName, REVIEW_REASON_LABELS[entry.reason], details];
  });
}

function sourceRows(preview: Preview, committed: boolean): TableCell[][] {
  const meta: ImportMeta | null = preview.meta;
  const rows: TableCell[][] = [
    ['Поставщик', preview.supplierName],
    ['Источник', meta === null ? 'не определён' : (SOURCE_LABELS[meta.source] ?? meta.source)],
  ];
  if (meta?.fileName !== undefined) rows.push(['Файл', meta.fileName]);
  if (meta?.subject !== undefined) rows.push(['Тема письма', meta.subject]);
  if (meta?.sender !== undefined) {
    const mark = meta.senderVerified === true ? '' : ' (отправитель не подтверждён)';
    rows.push(['Отправитель', `${meta.sender}${mark}`]);
  }
  if (meta?.author !== undefined) rows.push(['Передал сотрудник (чат)', meta.author]);
  if (meta?.receivedAt !== undefined) rows.push(['Получено', meta.receivedAt]);
  for (const note of meta?.notes ?? []) rows.push(['Пометка сотрудника', note]);
  rows.push(
    ['Подготовлено', preview.createdAt],
    ['Состояние в базе', committed ? 'зафиксировано' : 'ожидает фиксации'],
    ['Номер импорта', preview.importId],
  );
  return rows;
}

function buildSheets(preview: Preview, committed: boolean): TableSheet[] {
  const { diff } = preview;
  return [
    {
      name: 'Изменения',
      columns: ['Артикул', 'Позиция', 'Было', 'Стало', 'Изменение, %', 'Валюта'],
      rows: diff.changed.map((item): TableCell[] => [
        item.sku ?? '',
        item.productName,
        shownPrice(item.oldPrice, item.oldQualifier, item.oldMax),
        shownPrice(item.newPrice, item.newQualifier, item.newMax),
        item.changePct,
        currencyText(item),
      ]),
    },
    {
      name: 'Новые',
      columns: ['Артикул', 'Позиция', 'Цена', 'Валюта'],
      rows: diff.added.map((item): TableCell[] => [
        item.sku ?? '',
        item.productName,
        shownPrice(item.price, item.priceQualifier, item.priceMax),
        item.currency,
      ]),
    },
    {
      name: 'Снятые',
      columns: ['Артикул', 'Позиция', 'Последняя цена', 'Валюта'],
      rows: diff.removed.map((item): TableCell[] => [
        item.sku ?? '',
        item.productName,
        shownPrice(item.price, item.priceQualifier, item.priceMax),
        item.currency,
      ]),
    },
    {
      name: 'На проверку',
      columns: ['Артикул', 'Позиция', 'Причина', 'Подробности'],
      rows: reviewRows(preview),
    },
    { name: 'Источник', columns: ['Параметр', 'Значение'], rows: sourceRows(preview, committed) },
  ];
}

/** Символы, недопустимые в имени файла (Windows/почтовые клиенты), и управляющие коды. */
const FORBIDDEN_FILE_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;

/**
 * Имя файла после изменения цен: `Прайс_<поставщик>_<ДД.ММ.ГГГГ>.<расширение>`. Недопустимые
 * символы в названии поставщика заменяются на «_», чтобы файл открывался у любого получателя.
 */
export function priceChangeFileName(supplierName: string, isoDate: string): string {
  const supplier = supplierName.replace(FORBIDDEN_FILE_NAME_CHARS, '_').trim();
  return `Прайс_${supplier}_${russianDate(isoDate)}.${CHANGES_FILE_FORMAT}`;
}

interface SendInput {
  supplierId: string;
  fileHash: string;
  diffHash: string;
}
interface SendOutput {
  delivered: boolean;
  /** Не отправлен: плановая обработка прайса с диска, файл уже на диске и записан в базу. */
  skipped?: 'scheduled_disk_run' | undefined;
  fileName: string;
  counts: z.infer<typeof countsSchema>;
}

function sendKey(input: SendInput): string {
  const importId = stagingImportId(input.supplierId, input.fileHash);
  return `prices-changes-file:${importId}:${input.diffHash}`;
}

/** Текст сотруднику: собирается кодом из шаблона и чисел. */
function buildChangesText(
  preview: Preview,
  committed: boolean,
  proposal: PriceProposal | null,
): string {
  const c = counts(preview.diff);
  const sender =
    proposal?.source === 'mail' && proposal.senderVerified !== true
      ? ' Отправитель письма не подтверждён.'
      : '';
  const state = proposal !== null
    ? 'Это неподтверждённые цены не с диска: в базу агента они попадут, только когда вы ' +
      `внесёте их на диск.${sender}`
    : committed
      ? 'Данные уже записаны в базу агента.'
      : 'В базу агента данные ещё не записаны, ждут фиксации.';
  return (
    `Прайс «${preview.supplierName}»: подготовлено для внесения в корпоративный диск, ` +
    `проверьте и внесите. Изменений цен: ${c.changed}, новых позиций: ${c.added}, снято: ` +
    `${c.removed}, на проверку: ${c.review}. ${state} Файл с изменениями ниже.`
  );
}

/** Отдать сотруднику файл изменений и короткое сообщение; сам агент ничего не утверждает. */
export const sendPriceChangeFile = defineTool<SendInput, SendOutput, PricesDeps>({
  name: 'sendPriceChangeFile',
  description:
    'Отправить тому, кто просил в этом чате, файл изменений прайса (листы «Изменения», ' +
    '«Новые», «Снятые», «На проверку», «Источник») с сообщением «подготовлено для внесения в ' +
    'корпоративный диск, проверьте и внесите». Можно после commitPriceImport или до него по ' +
    'запросу. Передайте supplierId, fileHash и diffHash из previewPriceChanges; один набор ' +
    'изменений отправляется один раз. В плановой обработке прайса с диска после фиксации ' +
    'файл не отправляется (skipped=scheduled_disk_run): это не ошибка, сообщать не нужно.',
  sideEffect: true,
  inputSchema: z.object({
    supplierId: z.string().min(1),
    fileHash: z.string().min(1),
    diffHash: z.string().min(1),
  }),
  outputSchema: z.object({
    delivered: z.boolean(),
    skipped: z.literal('scheduled_disk_run').optional(),
    fileName: z.string(),
    counts: countsSchema,
  }),
  idempotencyKey: sendKey,
  async execute(input, deps, context) {
    const exporter = requirePort(deps.tableExporter, 'выгрузка таблиц');
    const importId = stagingImportId(input.supplierId, input.fileHash);
    const preview = await readState(requireState(deps), PREVIEW_NAMESPACE, importId, previewSchema);
    if (preview === null) {
      throw new DomainError('not_found', 'Изменения не сравнивались: сначала previewPriceChanges.');
    }
    if (preview.diffHash !== input.diffHash) {
      throw new DomainError(
        'conflict',
        'Сравнение изменилось: вызовите previewPriceChanges и возьмите актуальный diffHash.',
      );
    }
    // Staging очищается при фиксации: его отсутствие означает, что прайс уже записан.
    const proposal = await loadPriceProposal(requireState(deps), input.supplierId, importId);
    // Предложение (не диск) в базу не записано, даже когда staging уже очищен фиксацией.
    const committed = proposal === null && !(await deps.staging.exists(importId));
    const day = preview.createdAt.slice(0, ISO_DATE_LENGTH);
    if (committed && (await isUnattendedDiskRun(deps, context.threadId, input.fileHash))) {
      // Прайс с диска, обработанный по расписанию, уже лежит на диске и записан в базу: «внесите
      // в корпоративный диск» тут не к чему, а по сообщению на файл заваливало ответственного
      // (в ТЗ, раздел 7, таких сообщений нет). Итог по файлу - в сводке синхронизации.
      await requireState(deps).put(PREVIEW_NAMESPACE, importId, toStoredJson(preview), {
        done: true,
      });
      const fileName = priceChangeFileName(preview.supplierName, day);
      return {
        delivered: false,
        skipped: 'scheduled_disk_run' as const,
        fileName,
        counts: counts(preview.diff),
      };
    }
    const file = await exporter.export(
      buildSheets(preview, committed),
      CHANGES_FILE_FORMAT,
      priceChangeFileName(preview.supplierName, day),
    );
    const message = { text: buildChangesText(preview, committed, proposal) };
    // Файл получает тот, кто просил в этом ходе (его тред); владельца работы не уведомляем.
    // Без чата человека (плановый запуск, вызов другим агентом) - прежний адресат.
    const requesterThread =
      deps.state === undefined ? null : await chatThreadOf(deps.state, context);
    const threadId =
      requesterThread ??
      (await changeFileRecipient(deps, workSubject.import(input.fileHash)));
    try {
      await sendExportedFile(deps.chat, threadId, message, file, sendKey(input));
    } catch (error) {
      // Слово «отправил» агент вправе сказать только после успеха: текст ошибки его не содержит.
      const reason = error instanceof Error ? error.message : 'неизвестная причина';
      throw new DomainError(
        'external_failure',
        `Файл изменений не доставлен: ${reason}. Сообщи сотруднику причину; файл не доставлен.`,
        { retryable: true },
      );
    }
    // Прайс записан и файл отдан: сравнение больше не нужно, ретенция может его удалить.
    if (committed) {
      await requireState(deps).put(PREVIEW_NAMESPACE, importId, toStoredJson(preview), {
        done: true,
      });
    }
    return { delivered: true, fileName: file.fileName, counts: counts(preview.diff) };
  },
});
