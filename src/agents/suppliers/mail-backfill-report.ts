import { z } from 'zod';
import type { SupplierCard } from '../../kit/domain/supplier-card';
import { stableHash } from '@business-ai/core';
import { enrichCard, type BuildContext } from './card-enrichment';
import { isProtectedRequisite } from './card-requisites-guard';
import type { EnrichmentConflict } from './card-enrichment-conflicts';
import { supplierCardFieldsSchema, type SupplierCardFields } from './card-fields';

/**
 * Отчёт разового прохода по общему ящику (этап 220b): предлагаемые изменения СУЩЕСТВУЮЩИХ
 * карточек поставщиков. Проход их не пишет (отправитель письма не подтверждён), человек
 * просматривает отчёт, ставит `approved: true` у нужных пунктов, и отдельный режим применяет
 * только их (`mail-backfill-apply.ts`).
 *
 * Отчёт предназначен владельцу и лежит вне репозитория (права 600): в значениях пунктов есть
 * ПДн (контакты, ФИО) - но только поля карточки, которые предлагается изменить, и ссылка на
 * письмо (id в ящике и дата). Текст письма и адрес отправителя целиком в отчёт не попадают.
 * Журнал и вывод команды отчёт не цитируют.
 */

/** Версия формата файла: чужая версия отклоняется, а не угадывается. */
const BACKFILL_REPORT_VERSION = 1;
/** Предел значения в читаемом виде отчёта (в JSON значения полные). */
const SHOWN_VALUE_MAX_CHARS = 240;
/** Длина идентификатора пункта: хватает, чтобы назвать пункт в разговоре, и не раздувает файл. */
const ITEM_ID_LENGTH = 10;
/** Поля карточки, которые не являются «содержимым» и в предложениях не участвуют. */
const SERVICE_KEYS: ReadonlySet<string> = new Set(['updatedAt', 'updatedBy', 'notes', 'source']);

/**
 * Служебный «номер карточки» пунктов без карточки (письмо не разобрано): группировка и номер
 * пункта строятся от него.
 */
export const UNPARSED_SUPPLIER_ID = 'unparsed';
/** Единственное поле пункта «не разобрано»; значение пункта - причина (код). */
const UNPARSED_FIELD = 'letter';
/** Причины, по которым письмо не удалось разобрать (коды без текста письма). */
export type UnparsedReason =
  | 'invalid_answer'
  | 'timeout'
  | 'contradictory_answer'
  | 'gateway_failure';

/**
 * Что записывает `patch` при применении: ровно одно поле обогащения. Служебные поля
 * (`status`, `note`, `clear`, `remove*`) и любые лишние ключи схема отвергает: подтверждает
 * человек одну строку «поле: было -> предлагается», и записано должно быть только оно.
 */
const patchSchema = supplierCardFieldsSchema
  .omit({
    status: true,
    note: true,
    clear: true,
    removeContacts: true,
    removeCategories: true,
    removeBrands: true,
    removeRegions: true,
  })
  .strict()
  .refine((patch) => Object.keys(patch).length === 1);

/** Письмо-основание пункта: id в ящике и дата получения. Текста нет. */
const letterRefSchema = z.object({ id: z.string().min(1), receivedAt: z.string() });

/** Статус пункта: `pending` - ждёт применения, `applied` - применён, `skipped` - пропущен. */
const itemStatusSchema = z.enum(['pending', 'applied', 'skipped']);

const reportItemSchema = z.object({
  /** Стабильный номер пункта: хэш (карточка, вид, поле, предложение). */
  id: z.string().min(1),
  supplierId: z.string().min(1),
  /**
   * `fill` - пустое поле карточки или новый элемент списка (можно применить);
   * `conflict` - значение письма расходится с записанным либо отправитель не из доменов
   * карточки: только для просмотра, автоматически не применяется;
   * `unparsed` - письмо не удалось оценить (модель дала неразборчивый ответ или не успела):
   * его нужно прочитать глазами, карточки у пункта нет.
   */
  kind: z.enum(['fill', 'conflict', 'unparsed']),
  field: z.string().min(1),
  was: z.string().nullable(),
  proposed: z.string(),
  /**
   * Пункт меняет реквизиты (ИНН/КПП, адрес, банковские): письмо их не применяет ни при каком
   * доверии, только человек. В читаемом виде помечен «реквизиты изменились» (этап 233).
   */
  requisites: z.boolean().optional(),
  /** Что записывается при применении (только `fill`); те же поля, что у инструмента карточки. */
  patch: patchSchema.optional(),
  /**
   * Версия карточки на момент отчёта (`updatedAt`). При применении иная версия не закрывает
   * пункт сразу: он применяется, если его поле в карточке прежнее (`was`), иначе - `card_changed`
   * (вернуть такой пункт на подтверждение можно режимом `--recheck`).
   */
  cardVersion: z.string(),
  letters: z.array(letterRefSchema).min(1),
  /** Подтверждение человека: ставится вручную в файле. */
  approved: z.boolean().default(false),
  status: itemStatusSchema.default('pending'),
  /** Причина пропуска (код) при `status: skipped`. */
  reason: z.string().optional(),
  resolvedAt: z.string().optional(),
});
export type BackfillReportItem = z.infer<typeof reportItemSchema>;

/** Чем закончился последний запуск: по этому разделу видно, откуда продолжить. */
const runSchema = z.object({
  at: z.string(),
  dryRun: z.boolean(),
  // `create_cap` больше не выдаётся (предел созданий снят), но остаётся для чтения прежних отчётов.
  stoppedBy: z.enum(['none', 'model_limit', 'create_cap', 'classifier_outage']),
  scanned: z.number().int().min(0),
  modelCalls: z.number().int().min(0),
});

const reportSchema = z.object({
  version: z.literal(BACKFILL_REPORT_VERSION),
  /** Служебное имя ящика-источника. */
  mailbox: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
  run: runSchema.optional(),
  items: z.array(reportItemSchema),
});
export type BackfillReport = z.infer<typeof reportSchema>;

/** Пустой отчёт для ящика. */
export function emptyBackfillReport(mailbox: string, nowIso: string): BackfillReport {
  return {
    version: BACKFILL_REPORT_VERSION,
    mailbox,
    createdAt: nowIso,
    updatedAt: nowIso,
    items: [],
  };
}

/**
 * Разобрать файл отчёта. Ошибка не цитирует содержимое: в файле ПДн, а текст ошибки Zod
 * повторяет значения.
 * @throws Error `backfill_report_invalid`.
 */
export function parseBackfillReport(text: string): BackfillReport {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('backfill_report_invalid');
  }
  const parsed = reportSchema.safeParse(raw);
  if (!parsed.success) throw new Error('backfill_report_invalid');
  return parsed.data;
}

/** Предложение по карточке до внесения в отчёт. */
export interface BackfillProposal {
  kind: 'fill' | 'conflict' | 'unparsed';
  field: string;
  was: string | null;
  proposed: string;
  patch?: SupplierCardFields;
  /** Поле - реквизит (см. `reportItemSchema`). */
  requisites?: boolean;
}

/** Значение поля для показа: строка как есть, пустое - `null`, структура - JSON. */
function shown(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value === '' ? null : value;
  if (Array.isArray(value) && value.length === 0) return null;
  return JSON.stringify(value);
}

/** Плоский вид карточки: вложенные `supplies` и `terms` разворачиваются в `supplies.categories`. */
function flatten(card: SupplierCard): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const [key, value] of Object.entries(card)) {
    if (SERVICE_KEYS.has(key)) continue;
    if ((key === 'supplies' || key === 'terms') && typeof value === 'object' && value !== null) {
      for (const [inner, innerValue] of Object.entries(value)) {
        out.set(`${key}.${inner}`, innerValue);
      }
    } else {
      out.set(key, value);
    }
  }
  return out;
}

/** Значение поля карточки в том виде, в каком оно записано в пункте отчёта (`was`). */
export function cardFieldShown(card: SupplierCard, field: string): string | null {
  return shown(flatten(card).get(field));
}

/** Что изменилось между версиями карточки: поле, было, стало. */
export function cardChanges(
  before: SupplierCard,
  after: SupplierCard,
): Array<{ field: string; was: string | null; proposed: string }> {
  const was = flatten(before);
  const now = flatten(after);
  const changes: Array<{ field: string; was: string | null; proposed: string }> = [];
  for (const [field, value] of now) {
    const next = shown(value);
    const prev = shown(was.get(field));
    if (next !== prev && next !== null) changes.push({ field, was: prev, proposed: next });
  }
  return changes.sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0));
}

/**
 * Патч пункта сводится к одному полю: условия поставки (`terms`) разворачиваются в несколько
 * полей отчёта, и подтверждённый пункт не должен записывать соседние, которых человек не
 * подтверждал (при применении запись сверяется с пунктом).
 */
function narrowPatch(
  patch: SupplierCardFields,
  key: keyof SupplierCardFields,
  field: string,
): SupplierCardFields {
  const prefix = 'terms.';
  if (key !== 'terms' || patch.terms === undefined || !field.startsWith(prefix)) return patch;
  const name = field.slice(prefix.length);
  const picked = Object.entries(patch.terms).filter(([termName]) => termName === name);
  return { terms: Object.fromEntries(picked) };
}

/**
 * Предложения по существующей карточке из полей письма. Каждое поле письма проверяется
 * отдельно: пункт получается только у того, что действительно меняет карточку (пустое поле,
 * новый контакт или элемент списка), и несёт собственный `patch` - подтверждать можно по одному.
 * Расхождения со значениями карточки идут пунктами `conflict` (только для просмотра).
 */
export function proposalsFor(
  current: SupplierCard,
  fields: SupplierCardFields,
  conflicts: readonly EnrichmentConflict[],
  context: BuildContext,
): BackfillProposal[] {
  const proposals: BackfillProposal[] = [];
  for (const key of Object.keys(fields) as Array<keyof SupplierCardFields>) {
    const patch: SupplierCardFields = { [key]: fields[key] };
    const test = enrichCard(current, patch, context);
    if (!test.changed) continue;
    for (const change of cardChanges(current, test.card)) {
      proposals.push({
        kind: 'fill',
        ...change,
        patch: narrowPatch(patch, key, change.field),
        ...(isProtectedRequisite(change.field) ? { requisites: true } : {}),
      });
    }
  }
  for (const item of conflicts) {
    proposals.push({
      kind: 'conflict',
      field: item.field,
      was: shown(item.current),
      proposed: item.proposed,
      ...(isProtectedRequisite(item.field) ? { requisites: true } : {}),
    });
  }
  return proposals;
}

/** Номер пункта: одно и то же предложение по одной карточке - один пункт на любые письма. */
export function reportItemId(
  supplierId: string,
  kind: string,
  field: string,
  proposed: string,
): string {
  return stableHash([supplierId, kind, field, proposed]).slice(0, ITEM_ID_LENGTH);
}

/** Предложение «письмо не разобрано»: одна причина - один пункт на все такие письма. */
export function unparsedProposal(reason: UnparsedReason): BackfillProposal {
  return { kind: 'unparsed', field: UNPARSED_FIELD, was: null, proposed: reason };
}

function itemId(supplierId: string, proposal: BackfillProposal): string {
  return reportItemId(supplierId, proposal.kind, proposal.field, proposal.proposed);
}

/** Итог внесения предложений: новые пункты и новые ссылки на письма у прежних. */
export interface AddedProposals {
  items: number;
  references: number;
}

/**
 * Внести предложения в отчёт без дублей: такой же пункт (по номеру) получает только ссылку на
 * новое письмо. Непринятый пункт обновляет версию карточки и значения (карточку могли
 * поправить после прошлого запуска); принятый человеком остаётся как был - решение принято
 * по тому, что он видел.
 */
export function addProposals(
  report: BackfillReport,
  supplierId: string,
  cardVersion: string,
  proposals: readonly BackfillProposal[],
  letter: { id: string; receivedAt: string },
): AddedProposals {
  const added: AddedProposals = { items: 0, references: 0 };
  for (const proposal of proposals) {
    const id = itemId(supplierId, proposal);
    const known = report.items.find((item) => item.id === id);
    if (known === undefined) {
      report.items.push({
        id,
        supplierId,
        kind: proposal.kind,
        field: proposal.field,
        was: proposal.was,
        proposed: proposal.proposed,
        ...(proposal.patch === undefined ? {} : { patch: proposal.patch }),
        ...(proposal.requisites === true ? { requisites: true } : {}),
        cardVersion,
        letters: [letter],
        approved: false,
        status: 'pending',
      });
      added.items += 1;
      continue;
    }
    if (!known.letters.some((ref) => ref.id === letter.id)) {
      known.letters.push(letter);
      added.references += 1;
    }
    if (!known.approved && known.status === 'pending') {
      known.cardVersion = cardVersion;
      known.was = proposal.was;
    }
  }
  return added;
}

/** Версия карточки для сверки при применении. */
export function cardVersionOf(card: SupplierCard): string {
  return card.updatedAt ?? '';
}

function clip(value: string): string {
  return value.length > SHOWN_VALUE_MAX_CHARS
    ? `${value.slice(0, SHOWN_VALUE_MAX_CHARS)}...`
    : value;
}

/** Читаемый вид отчёта: по карточкам, пункт - одна строка «было -> предлагается». */
export function renderBackfillReport(report: BackfillReport): string {
  const lines: string[] = [
    `Отчёт разового прохода по ящику «${report.mailbox}»`,
    `Обновлён: ${report.updatedAt}`,
  ];
  if (report.run !== undefined) {
    lines.push(
      `Последний запуск: ${report.run.at}${report.run.dryRun ? ' (пробный)' : ''}, ` +
        `остановка: ${report.run.stoppedBy}, писем просмотрено: ${report.run.scanned}, ` +
        `обращений к модели: ${report.run.modelCalls}`,
    );
  }
  lines.push(
    'Чтобы применить пункт, поставьте в JSON-файле "approved": true и запустите --apply.',
    'Пункты вида conflict и unparsed только для просмотра: они не применяются.',
    'Пункт unparsed - письма, которые модель не смогла оценить: прочитайте их в ящике сами.',
    '',
  );
  const bySupplier = new Map<string, BackfillReportItem[]>();
  for (const item of report.items) {
    bySupplier.set(item.supplierId, [...(bySupplier.get(item.supplierId) ?? []), item]);
  }
  for (const [supplierId, items] of [...bySupplier].sort(([a], [b]) => (a < b ? -1 : 1))) {
    lines.push(
      supplierId === UNPARSED_SUPPLIER_ID ? 'Письма без разбора' : `Карточка ${supplierId}`,
    );
    for (const item of items) {
      const mark = item.approved ? 'x' : ' ';
      const why = item.reason === undefined ? '' : `: ${item.reason}`;
      const status = item.status === 'pending' ? '' : ` [${item.status}${why}]`;
      const marked = item.requisites === true ? ' [реквизиты изменились]' : '';
      const refs = item.letters.map((ref) => `${ref.id} от ${ref.receivedAt.slice(0, 10)}`);
      lines.push(
        `  [${mark}] ${item.id} ${item.kind} ${item.field}: ` +
          `было ${item.was === null ? '(пусто)' : clip(item.was)} -> ` +
          `предлагается ${clip(item.proposed)}${marked}${status}; письма: ${refs.join(', ')}`,
      );
    }
    lines.push('');
  }
  if (report.items.length === 0) lines.push('Предложений по существующим карточкам нет.');
  return `${lines.join('\n')}\n`;
}
