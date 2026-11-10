import { DomainError, type ValidationIssue } from '@business-ai/core';
import {
  countPriceUpdatesSteps,
  findPriceJumpsSteps,
  nextConfirmedPricesSteps,
  priceItemKey,
  type PriceChange,
} from '../../kit/domain/price-diff';
import { priceFreshness } from '../../kit/domain/price-schedule';
import { validatePriceImport } from '../../kit/domain/validators.owned';
import { type PriceItem } from '../../kit/domain/models';
import { priceListHash } from './employee-updates';
import { loadConfirmedPrices, saveConfirmedPrices } from './confirmed-prices';
import { PRICE_DATE_FUTURE_TOLERANCE_MS, type PricesDeps } from './deps';
import { closeProposalsBefore, isProposalSource, savePriceProposal } from './price-proposals';
import {
  loadImportMeta,
  saveImportMeta,
  loadPriceUpload,
  savePriceUpload,
  type PriceSourceKind,
} from './price-state';
import { runPriceStepsYielding } from './price-steps';
import { confirmedInScope, sourceScopeOf } from './source-scope';
import { loadSupplierDiskFiles } from './supplier-file-history';

/** Сколько замечаний показываем агенту; остальные сводятся в одно сообщение. */
export const MAX_ISSUES_LISTED = 20;

/**
 * Замечания о скачках цены и снятых позициях: фиксацию не блокируют, подтверждения не требуют
 * (они уходят в файл изменений).
 */
const JUMP_ISSUE_CODES: ReadonlySet<string> = new Set(['price_jump', 'price_mass_removal']);

/** Набор позиций, готовый к записи в базу: его собрал код из файла или staging. */
export interface ImportCandidate {
  supplierId: string;
  importId: string;
  /** Число строк данных исходника, посчитанное кодом. */
  sourceRowCount: number;
  items: readonly PriceItem[];
  /** Парсер обрезал файл по своим лимитам: набор неполный, записывать нельзя. */
  truncated?: boolean | undefined;
  /**
   * Прайс прочитан из письма неподтверждённого отправителя (малый прайс знает это сам): идёт
   * пометкой в предложение. Не задан - признак берётся из происхождения импорта (staging).
   */
  senderUnverified?: boolean | undefined;
  /**
   * Откуда набор (знает вызывающий для малого прайса). Не задан - из происхождения импорта
   * (staging), без него - диск.
   */
  source?: PriceSourceKind | undefined;
  /** Дата данных не с диска (дата письма), для справки по предложению. */
  sourceDate?: string | undefined;
  /**
   * Файл с диска (путь от корня), из которого набор: замена и сравнение идут в пределах этого
   * файла и его старых версий, другие прайс-файлы поставщика не трогаются. Нет - весь прайс.
   */
  sourceFile?: string | undefined;
}

/** Итог записи: в базу (только диск) или предложение сотруднику (остальные источники). */
export interface ImportWriteResult {
  status: 'written' | 'proposed_not_written';
  /** Новые и изменившие цену позиции относительно базы. */
  changed: number;
  /** Позиций в предложении (0 при записи с диска). */
  proposed: number;
  /**
   * Предупреждения (этап 177): для предложения замечания к данным не блокируют результат, а
   * идут сотруднику списком. Для записи с диска всегда пусто (там замечание блокирует).
   */
  warnings: string[];
}

/** Результат проверки перед записью. */
export interface ImportVerdict {
  issues: ValidationIssue[];
  /**
   * Строки базы, которые заменит этот импорт (весь прайс или только свой файл): от них считаются
   * скачки, «снятые» и число изменений.
   */
  existing: PriceItem[];
  /** `priceListHash` ВСЕГО прайса поставщика: по нему записывается сверка базы при записи. */
  baseHash: string;
  /** Подтверждённые человеком цены на момент проверки. */
  confirmed: PriceItem[];
  /** Скачки цен набора относительно базы и принятых цен (запись их не блокирует). */
  jumps: PriceChange[];
  /** История файлов поставщика, по которой считалась область замены (повторно не читается). */
  history: string[] | undefined;
}

/**
 * Замечания, которые блокируют даже предложение (не диск): чужой поставщик (чужие данные),
 * потерянное происхождение импорта (служебное состояние), другой файл по отпечатку и гонка
 * записи (нельзя применить к устаревшей базе). Всё остальное для предложения - предупреждение.
 */
const HARD_ISSUE_CODES: ReadonlySet<string> = new Set([
  'foreign_supplier_item',
  'import_origin_unknown',
  'file_hash_mismatch',
  'base_changed',
]);

/** Сколько примеров показываем в сводной строке предупреждения одного кода. */
const WARNING_EXAMPLES = 2;

/**
 * Источник набора: заданный вызывающим, иначе из происхождения импорта, иначе диск. Только
 * диск пишется в базу цен, остальное уходит предложением (в базу не попадает).
 */
export async function candidateSource(
  deps: PricesDeps,
  candidate: ImportCandidate,
): Promise<PriceSourceKind> {
  if (candidate.source !== undefined) return candidate.source;
  const meta = await loadImportMeta(deps, candidate.importId);
  return meta?.source ?? 'disk';
}

/**
 * Замечания, блокирующие результат. Для диска блокирует любое (запись в базу цен), для
 * предложения - только жёсткие (чужие данные, служебное состояние): остальное идёт
 * предупреждениями сотруднику, а не отказом.
 */
export async function blockingIssues(
  deps: PricesDeps,
  candidate: ImportCandidate,
  issues: ValidationIssue[],
): Promise<ValidationIssue[]> {
  const source = await candidateSource(deps, candidate);
  if (!isProposalSource(source)) return issues;
  return issues.filter((issue) => HARD_ISSUE_CODES.has(issue.code));
}

/**
 * Предупреждения из замечаний: по одной строке на код, с числом и двумя примерами. Лимит на
 * число замечаний не теряет тип замечания (100 дублей = одна строка, а не «ещё 80 не показано»).
 */
export function issuesToWarnings(issues: readonly ValidationIssue[]): string[] {
  const byCode = new Map<string, string[]>();
  for (const issue of issues) {
    const list = byCode.get(issue.code) ?? [];
    list.push(issue.message);
    byCode.set(issue.code, list);
  }
  return [...byCode.values()].map((messages) => {
    const first = messages[0] ?? '';
    if (messages.length === 1) return first;
    const examples = messages.slice(0, WARNING_EXAMPLES).join(' ');
    return `${first.split(':')[0] ?? first} (замечаний: ${messages.length}). ${examples}`;
  });
}

/** Не более `MAX_ISSUES_LISTED` замечаний: у большого прайса дублей могут быть тысячи. */
export function limitIssues(issues: ValidationIssue[]): ValidationIssue[] {
  if (issues.length <= MAX_ISSUES_LISTED) return issues;
  const rest = issues.length - MAX_ISSUES_LISTED;
  return [
    ...issues.slice(0, MAX_ISSUES_LISTED),
    { code: 'more_issues', message: `Ещё ${rest} замечаний не показано.` },
  ];
}

/** Позиции чужого поставщика и даты цен из будущего: такой набор в базу не пишется. */
function integrityIssues(candidate: ImportCandidate, now: Date): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const foreign = candidate.items.filter((item) => item.supplierId !== candidate.supplierId);
  if (foreign.length > 0) {
    issues.push({
      code: 'foreign_supplier_item',
      message: `Позиций другого поставщика в импорте: ${foreign.length}. Импорт не записан.`,
    });
  }
  if (candidate.truncated === true) {
    issues.push({
      code: 'file_truncated',
      message:
        'Файл прочитан не целиком (лимиты разбора): набор неполный, проверьте недостающие ' +
        'позиции.',
    });
  }
  const latest = now.getTime() + PRICE_DATE_FUTURE_TOLERANCE_MS;
  const future = candidate.items.filter((item) => !(Date.parse(item.date) <= latest));
  if (future.length > 0) {
    issues.push({
      code: 'price_date_out_of_window',
      message: `Позиций с датой цены из будущего или без даты: ${future.length}.`,
    });
  }
  return issues;
}

/**
 * Происхождение staged-импорта пропало (запись не-дискового источника ушла по сроку или
 * повреждена): такой набор не пишется, иначе письмо или чат попали бы в базу как прайс с диска.
 * Источник, заданный вызывающим (малый прайс), и работа без состояния не проверяются.
 */
async function originIssues(
  deps: PricesDeps,
  candidate: ImportCandidate,
): Promise<ValidationIssue[]> {
  if (candidate.source !== undefined || deps.state === undefined) return [];
  if ((await loadImportMeta(deps, candidate.importId)) !== null) return [];
  return [
    {
      code: 'import_origin_unknown',
      message:
        'Не найдено, откуда этот прайс (диск, письмо, чат): он не записан. Разложите файл ' +
        'заново.',
    },
  ];
}

/** История файлов поставщика для правила строк без файла; без файла у набора она не нужна. */
async function fileHistoryOf(
  deps: PricesDeps,
  candidate: ImportCandidate,
  prefetched?: readonly PriceItem[],
): Promise<string[] | undefined> {
  if (candidate.sourceFile === undefined) return undefined;
  const rows = prefetched ?? (await deps.prices.listBySupplier(candidate.supplierId));
  const rowFiles = rows.flatMap((item) => (item.sourceFile === undefined ? [] : [item.sourceFile]));
  return loadSupplierDiskFiles(deps.state, candidate.supplierId, rowFiles);
}

/** sha256 файла набора: `importId` собран как `<поставщик>:<отпечаток файла>` (`stagingImportId`). */
export function candidateFileHash(candidate: ImportCandidate): string | undefined {
  const prefix = `${candidate.supplierId}:`;
  return candidate.importId.startsWith(prefix) ? candidate.importId.slice(prefix.length) : undefined;
}

/**
 * Запомнить файл записанного импорта в истории поставщика. Путей записи несколько (малый
 * прайс, staging, скрипт), import-meta с `fileName` писал не каждый, и правило строк без файла
 * видело пустую историю; запись здесь, в общей точке, закрывает все пути сразу. Уже
 * сохранённое происхождение (скрипт, письмо) дополняется, а не заменяется.
 */
async function recordImportFile(deps: PricesDeps, candidate: ImportCandidate): Promise<void> {
  if (deps.state === undefined || candidate.sourceFile === undefined) return;
  const meta = await loadImportMeta(deps, candidate.importId);
  if (meta?.fileName !== undefined) return;
  await saveImportMeta(deps, candidate.importId, {
    notes: [],
    ...meta,
    source: meta?.source ?? 'disk',
    fileName: candidate.sourceFile,
  });
}

/**
 * Все проверки перед записью прайса в базу, общие для малого и большого прайса. Считаются от
 * состояния БАЗЫ в момент вызова (а не от того, что видела модель): число строк исходника,
 * дубли, чужой поставщик, даты, скачки от базы и от принятых цен. Скачки не блокируют запись.
 * Отправитель письма здесь не проверяется: не-дисковый прайс в базу не пишется вовсе, а уходит
 * предложением с пометкой «отправитель не подтверждён».
 */
export async function checkImport(
  deps: PricesDeps,
  candidate: ImportCandidate,
): Promise<ImportVerdict> {
  const all = await deps.prices.listBySupplier(candidate.supplierId);
  // Несколько прайс-файлов у поставщика: сравниваем только с тем, что этот импорт заменит.
  const history = await fileHistoryOf(deps, candidate, all);
  const fileHash = candidateFileHash(candidate);
  // Строки без файла от импорта этого же файла (sha256 в import_key) - своя прежняя версия.
  const fileHashMatch =
    candidate.sourceFile !== undefined &&
    fileHash !== undefined &&
    (await deps.prices.hasNullRowsFromFile(candidate.supplierId, fileHash));
  const scope = sourceScopeOf(all, candidate.sourceFile, history, candidate.items, fileHashMatch);
  const existing = scope.replaced;
  const confirmed = await loadConfirmedPrices(deps, candidate.supplierId);
  const scopedConfirmed = confirmedInScope(confirmed, scope);
  const items = [...candidate.items];
  // Скачки считаются один раз: их же использует проверка импорта (порог по умолчанию). По
  // шагам, с уступками циклу событий: прайс бывает в 100 тыс. позиций (R9-A1-01).
  const jumps = await runPriceStepsYielding(
    findPriceJumpsSteps(items, existing, undefined, scopedConfirmed),
  );
  const issues = validatePriceImport({
    sourceRowCount: candidate.sourceRowCount,
    imported: items,
    existing,
    confirmed: scopedConfirmed,
    jumps,
  });
  if (scope.newerFile !== null) {
    issues.push({
      code: 'older_price_version',
      message:
        `В базе уже более новая версия этого прайса (${scope.newerFile}): файл с более ` +
        'старой датой в базу цен не пишется.',
    });
  }
  const baseHash = priceListHash(all);
  // Скачки и массовое снятие не замечания к записи: иначе модель увидит в отказе «скачок» и
  // станет просить подтверждение, которого больше нет.
  const rest = issues.filter((issue) => !JUMP_ISSUE_CODES.has(issue.code));
  return {
    issues: [
      ...integrityIssues(candidate, deps.clock.now()),
      ...(await originIssues(deps, candidate)),
      ...rest,
    ],
    existing,
    baseHash,
    confirmed,
    jumps,
    history,
  };
}

/**
 * Свежесть прайса (R4-ALG-11): загрузка файла двигает дату загрузки поставщика, правка
 * словами сотрудника - нет. Если даты загрузки ещё нет, перед первой правкой словами она
 * фиксируется по прайсу до неё, иначе правка сама «освежила» бы поставщика.
 */
async function recordFreshness(
  deps: PricesDeps,
  candidate: ImportCandidate,
  before: readonly PriceItem[],
): Promise<void> {
  if (deps.state === undefined) return;
  const meta = await loadImportMeta(deps, candidate.importId);
  if (meta?.source !== 'employee') {
    await savePriceUpload(deps, candidate.supplierId, deps.clock.now().toISOString());
    return;
  }
  if ((await loadPriceUpload(deps, candidate.supplierId)) !== null) return;
  const previous = priceFreshness(null, before);
  if (previous !== null) await savePriceUpload(deps, candidate.supplierId, previous);
}

/**
 * Записать проверенный набор в базу. Проверки повторяются здесь, прямо перед записью: запись
 * не зависит от того, запускались ли валидаторы декларации, и от аргументов модели. После
 * записи обновляются подтверждённые цены. Возвращает число новых и изменивших цену позиций.
 * `checked` - вердикт, который вызывающий уже получил от `checkImport` по этому набору: тогда
 * прайс и его хэш (до 400 мс на 100 тыс. позиций) не читаются и не считаются второй раз.
 */
export async function writeImport(
  deps: PricesDeps,
  candidate: ImportCandidate,
  key: string,
  extraIssues: readonly ValidationIssue[] = [],
  checked?: ImportVerdict,
): Promise<ImportWriteResult> {
  const verdict = checked ?? (await checkImport(deps, candidate));
  const issues = [...extraIssues, ...verdict.issues];
  const meta = await loadImportMeta(deps, candidate.importId);
  const source = candidate.source ?? meta?.source ?? 'disk';
  // Этап 177: для предложения (не диск) в базу ничего не пишется, поэтому сомнение в данных
  // (число строк, дубли, даты, усечение, нераспознанные строки) не отказ, а предупреждение.
  // Для диска замечание по-прежнему блокирует: это запись в базу цен.
  const proposal = isProposalSource(source);
  const blocking = proposal ? issues.filter((i) => HARD_ISSUE_CODES.has(i.code)) : issues;
  if (blocking.length > 0) {
    const codes = [...new Set(blocking.map((issue) => issue.code))].join(', ');
    throw new DomainError('validation_failed', `Прайс не записан, замечания: ${codes}.`);
  }
  const warnings = issuesToWarnings(issues);
  // Дубль с другой ценой не выбираем сами (две цены - выбор за сотрудником): первое вхождение
  // остаётся, остальные в предложение не попадают, о них сказано в предупреждении.
  const seenKeys = new Set<string>();
  const items = [...candidate.items].filter((item) => {
    if (!proposal) return true;
    const key = priceItemKey(item);
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    return true;
  });
  // Диск - источник правды (решение владельца 26.10.2026): не-дисковые цены в базу не пишутся,
  // а сохраняются предложением; сотрудник вносит их на диск по файлу изменений.
  if (proposal && isProposalSource(source)) {
    const senderVerified = source === 'mail'
      ? candidate.senderUnverified === undefined
        ? meta?.senderVerified === true
        : !candidate.senderUnverified
      : undefined;
    const proposed = await savePriceProposal(deps, {
      supplierId: candidate.supplierId,
      importId: candidate.importId,
      source,
      sourceDate: candidate.sourceDate ?? meta?.receivedAt,
      senderVerified,
      items,
    });
    const changed = await runPriceStepsYielding(countPriceUpdatesSteps(verdict.existing, items));
    return { status: 'proposed_not_written', changed, proposed, warnings };
  }
  // Ключ базы включает прайс до записи: возврат A -> B -> A - новая запись, а не повтор A,
  // повтор той же записи (тот же прайс до неё) по-прежнему отбрасывается.
  const dbKey = `${key}:base:${verdict.baseHash}`;
  // R9-A5-02: под блокировкой по поставщику база сверяется с той, от которой считались
  // проверки выше; параллельный импорт успел записать другой прайс - отказ без записи.
  await deps.prices.saveImport(candidate.supplierId, items, dbKey, {
    isExpectedBase: (current) => priceListHash(current) === verdict.baseHash,
    sourceFile: candidate.sourceFile,
    fileHistory: verdict.history,
    fileHash: candidateFileHash(candidate),
  });
  await recordImportFile(deps, candidate);
  await recordFreshness(deps, candidate, verdict.existing);
  // Прайс с диска новее предложений поставщика: справка о них больше не показывается.
  if (deps.state !== undefined) {
    await closeProposalsBefore(deps.state, candidate.supplierId, deps.clock.now());
  }
  // Прайс с диска - источник правды: его скачки принимаются как подтверждённые цены.
  const approved = new Set(verdict.jumps.map((jump) => jump.key));
  const nextConfirmed = await runPriceStepsYielding(
    nextConfirmedPricesSteps(verdict.confirmed, verdict.existing, items, approved),
  );
  await saveConfirmedPrices(deps, candidate.supplierId, verdict.confirmed, nextConfirmed);
  // Нужен только счётчик: полный diff (скачки, «на проверку», снятые) здесь не строится.
  const changed = await runPriceStepsYielding(countPriceUpdatesSteps(verdict.existing, items));
  return { status: 'written', changed, proposed: 0, warnings: [] };
}
