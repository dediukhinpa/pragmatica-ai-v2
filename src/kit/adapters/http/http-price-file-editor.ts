import { z } from 'zod';
import { DomainError } from '@business-ai/core';
import {
  PriceFileTooLargeError,
  UnsupportedPriceFormatError,
  type PriceFileTooLargeReason,
} from '../../domain/errors.owned';
import { base64Of } from '@business-ai/core';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import type {
  EditedPriceDiskFile,
  EditedPriceFile,
  EditPricesFileRequest,
  EditPricesRequest,
  PriceFileEditor,
  SkippedPriceEdit,
} from '../../ports/price-file-editor';
import type { Telemetry, TempDiskFile } from '@business-ai/core';
import { blobOf, bytesOf } from '../buffer-view.owned';
import type { DocumentsResultVolume } from '@business-ai/adapters';
import { FileSpool } from '@business-ai/adapters';
import { readBase64FileResponse } from '@business-ai/adapters';
import { isLegacyMultipartRefusal } from '@business-ai/adapters';
import { streamMultipart } from '@business-ai/adapters';
import {
  parseResponse,
  requestJson,
  trimBaseUrl,
  type FetchFn,
  type JsonRequest,
} from '@business-ai/adapters';
import { httpTrace, type HttpTrace } from '@business-ai/adapters';

const SERVICE = 'документов (правка цен)';
/** Таймаут правки цен по умолчанию, мс. */
const DEFAULT_EDIT_TIMEOUT_MS = 60_000;
const STATUS_UNPROCESSABLE = 422;
const STATUS_TOO_LARGE = 413;
const BYTES_PER_MIB = 1024 * 1024;
/**
 * Самый большой файл, который повторяется JSON-ом (base64 раздувает на треть, а предел
 * JSON-тела сервиса - 8 МиБ): 5 МиБ -> около 6,7 МиБ base64 и запас под правки.
 */
const LEGACY_JSON_MAX_FILE_BYTES = 5 * BYTES_PER_MIB;
/** Код отказа сервиса: формат не правится на месте. */
const UNSUPPORTED_FORMAT_CODE = 'unsupported_format';

const skippedResponse = z.object({
  sheet: z.string().nullish(),
  table: z.number().int().nullish(),
  row: z.number().int(),
  col: z.number().int(),
  reason: z.string(),
});

/** Ответ сервиса без самого файла: имя, тип, число правок и пропуски. */
const metaResponse = z.object({
  file_name: z.string().min(1),
  mime_type: z.string().min(1),
  changed: z.number().int().nonnegative(),
  skipped: z.array(skippedResponse),
});

/** Прежний ответ: файл base64 внутри JSON. */
const editResponse = metaResponse.extend({ content_base64: z.string() });

/** Ответ с результатом на общем томе: вместо файла его имя, размер и хэш. */
const volumeResponse = metaResponse.extend({
  result: z.object({
    name: z.string().min(1),
    size: z.number().int().nonnegative(),
    sha256: z.string().min(1),
  }),
});

const errorBody = z.object({
  code: z.string().optional(),
  detail: z
    .union([
      z.string(),
      z.object({
        code: z.string().optional(),
        error: z.string().optional(),
        reason: z.string().optional(),
      }),
    ])
    .optional(),
});

/** Причина 413 сервиса (код предела) -> класс причины для совета сотруднику. */
const TOO_LARGE_REASONS: Readonly<Record<string, PriceFileTooLargeReason>> = {
  file_size: 'file_size',
  body_size: 'edits',
  edits_size: 'edits',
  cells: 'structure',
  nodes: 'structure',
  xml: 'structure',
  rows: 'structure',
  text: 'structure',
  entries: 'structure',
  uncompressed: 'uncompressed',
  ratio: 'uncompressed',
  timeout: 'temporary',
  repair_space_busy: 'temporary',
};

/** Причина 413 из тела ответа; старый сервис (строка в `detail`) причину не называет. */
function tooLargeReason(body: unknown): PriceFileTooLargeReason {
  const parsed = errorBody.safeParse(body);
  const detail = parsed.success ? parsed.data.detail : undefined;
  const reason = typeof detail === 'object' ? detail.reason : undefined;
  return (reason === undefined ? undefined : TOO_LARGE_REASONS[reason]) ?? 'unknown';
}

/** Сервис отказал по «плохому телу»: старая версия не понимает multipart (не ошибка правок). */
class BadBodyError extends DomainError {
  constructor() {
    super('invalid_input', 'Сервис документов отклонил правку цен.');
    this.name = 'BadBodyError';
  }
}

/** Сервис documents отдаёт отказ как `detail.error`; `code` и `detail.code` — запасные. */
function refusalCode(body: unknown): string | undefined {
  const parsed = errorBody.safeParse(body);
  if (!parsed.success) return undefined;
  const { code, detail } = parsed.data;
  if (code !== undefined) return code;
  return typeof detail === 'object' ? (detail.error ?? detail.code) : undefined;
}

/** Ошибки сервиса правки: 422 (формат, тело) и 413 (файл больше предела) - предметные отказы. */
function mapEditError(
  fileName: string,
): (status: number, body: unknown) => DomainError | undefined {
  return (status, body) => {
    if (status === STATUS_TOO_LARGE) {
      return new PriceFileTooLargeError(fileName, tooLargeReason(body));
    }
    if (isLegacyMultipartRefusal(status, body)) return new BadBodyError();
    if (status !== STATUS_UNPROCESSABLE) return undefined;
    if (refusalCode(body) === UNSUPPORTED_FORMAT_CODE) {
      return new UnsupportedPriceFormatError('файл');
    }
    return new DomainError('invalid_input', 'Сервис документов отклонил правку цен.');
  };
}

/** Параметры HTTP-адаптера правки цен. */
export interface HttpPriceFileEditorOptions {
  baseUrl: string;
  timeoutMs?: number;
  fetchFn?: FetchFn;
  /** Телеметрия: спан http.client и traceparent; не задана или выключена - как раньше. */
  telemetry?: Telemetry | undefined;
  /**
   * Каталог временных файлов для результата правки файлом на диске (`editPricesFile`). Не
   * задан - подкаталог временного каталога ОС (в контейнере это память: задавайте том).
   */
  spool?: FileSpool | undefined;
  /**
   * Общий с сервисом документов том результатов. Задан - ядро просит сервис отдать результат
   * файлом на томе, а не base64 в JSON; не задан (или сервис прежний) - прежний путь.
   */
  resultVolume?: DocumentsResultVolume | undefined;
}

/** Заголовок: способ доставки результата. Сервис без поддержки его игнорирует. */
const DELIVERY_HEADER = 'x-result-delivery';
const DELIVERY_VOLUME = 'volume';
/** Запас на рост файла при правке, если размер ответа заранее неизвестен. */
const RESULT_MARGIN_BYTES = BYTES_PER_MIB;
/** Во сколько раз base64 длиннее файла: 4 символа на 3 байта. */
const BASE64_RATIO = 3 / 4;

/** Прочитанный ответ правки: файл на томе или записанный в спул. */
type EditedPayload =
  | { kind: 'volume'; meta: unknown; file: TempDiskFile }
  | { kind: 'spool'; meta: unknown; size: number };

/** Поле ответа сервиса с файлом (base64). */
const CONTENT_FIELD = 'content_base64';

/** Пропущенная правка из ответа сервиса в форму порта. */
function skippedOf(item: z.output<typeof skippedResponse>): SkippedPriceEdit {
  return {
    ...(item.sheet == null ? {} : { sheet: item.sheet }),
    ...(item.table == null ? {} : { table: item.table }),
    row: item.row,
    col: item.col,
    reason: item.reason,
  };
}

/** Имя файла без пути; пустое имя - отказ с понятной причиной (до запроса к сервису). */
function cleanFileName(raw: string): string {
  const fileName = raw.split(/[\\/]/).pop()?.trim() ?? '';
  // Имя без файла («dir/», пробелы): сервис отвечает 422 «плохое тело», по которому причину
  // не понять; называем её здесь, до запроса.
  if (fileName === '') {
    throw new DomainError(
      'invalid_input',
      'У файла прайса пустое имя файла: правка невозможна, пришлите файл заново.',
    );
  }
  return fileName;
}

/** Прежнее JSON-тело сервиса: файл base64 внутри (только для малых файлов). */
function legacyBody(
  fileName: string,
  bytes: Uint8Array,
  edits: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return { file_name: fileName, content_base64: base64Of(bytes), edits };
}

/** Правки в форме тела сервиса. */
function serviceEdits(edits: EditPricesRequest['edits']): Array<Record<string, unknown>> {
  return edits.map((edit) => ({
    sheet: edit.sheet ?? null,
    table: edit.table ?? null,
    row: edit.row,
    col: edit.col,
    value: edit.value,
    expected: edit.expected ?? null,
  }));
}

/** Адаптер порта PriceFileEditor к HTTP-сервису services/documents (`POST /edit-prices`). */
export class HttpPriceFileEditor implements PriceFileEditor {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: FetchFn;
  private readonly trace: HttpTrace | undefined;
  private readonly spool: FileSpool;
  private readonly resultVolume: DocumentsResultVolume | undefined;

  constructor(options: HttpPriceFileEditorOptions) {
    this.spool = options.spool ?? new FileSpool({ dir: join(tmpdir(), 'pragmatika-edit-spool') });
    this.resultVolume = options.resultVolume;
    this.baseUrl = trimBaseUrl(options.baseUrl);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_EDIT_TIMEOUT_MS;
    this.fetchFn = options.fetchFn ?? fetch;
    this.trace = httpTrace(options.telemetry, 'documents', true);
  }

  async editPrices(request: EditPricesRequest): Promise<EditedPriceFile> {
    const fileName = cleanFileName(request.fileName);
    const edits = serviceEdits(request.edits);
    const url = `${this.baseUrl}/edit-prices`;
    const call = (extra: Pick<JsonRequest, 'form' | 'body'>): Promise<unknown> =>
      requestJson({
        fetchFn: this.fetchFn,
        trace: this.trace,
        service: SERVICE,
        url,
        method: 'POST',
        timeoutMs: this.timeoutMs,
        mapError: mapEditError(fileName),
        // Ожидание очереди documents срок хода не тратит (этап 239g).
        holdTurnClock: true,
        ...extra,
      });
    let data: unknown;
    try {
      // Файл идёт multipart (часть `file`), а не base64 внутри JSON: у JSON-тела сервиса предел
      // 8 МиБ, и прайс с картинками (17 МБ и больше) получал 413. Multipart режется общим
      // пределом загрузки сервиса и в память целиком не читается.
      const form = new FormData();
      form.append('file', blobOf(request.bytes), fileName);
      form.append('edits', JSON.stringify(edits));
      data = await call({ form });
    } catch (error) {
      // Порядок выкатки: новое ядро может встретить прежний сервис, который multipart не
      // понимает (422/415 «плохое тело»). Малый файл тогда идёт прежним JSON-ом, а большой
      // отдаём как есть: в JSON-тело он не поместится.
      const tooBigForJson = request.bytes.byteLength > LEGACY_JSON_MAX_FILE_BYTES;
      if (!(error instanceof BadBodyError) || tooBigForJson) throw error;
      data = await call({ body: legacyBody(fileName, request.bytes, edits) });
    }
    const parsed = parseResponse(SERVICE, editResponse, data);
    return {
      fileName: parsed.file_name,
      mimeType: parsed.mime_type,
      bytes: bytesOf(Buffer.from(parsed.content_base64, 'base64')),
      changed: parsed.changed,
      skipped: parsed.skipped.map(skippedOf),
    };
  }

  async editPricesFile(request: EditPricesFileRequest): Promise<EditedPriceDiskFile> {
    const fileName = cleanFileName(request.fileName);
    const edits = serviceEdits(request.edits);
    const url = `${this.baseUrl}/edit-prices`;
    // Место в спуле занимается лениво: при результате на томе спул не нужен вовсе, а при
    // base64 резерв берётся по размеру ответа (этап 231: общий предел FILE_SPOOL_MAX_BYTES).
    let target: string | undefined;
    const claim = async (expectedBytes: number): Promise<string> => {
      target ??= await this.spool.allocate(expectedBytes);
      return target;
    };
    const release = async (): Promise<void> => {
      if (target === undefined) return;
      const path = target;
      target = undefined;
      await this.spool.discard(path);
    };
    try {
      // Файл уходит потоком с диска, ответ пишется на диск по мере прихода: ни файл, ни его
      // base64 в памяти целиком не лежат.
      const multipart = streamMultipart(
        { edits: JSON.stringify(edits) },
        { field: 'file', fileName, file: request.file },
      );
      const data = (await requestJson({
        fetchFn: this.fetchFn,
        trace: this.trace,
        service: SERVICE,
        url,
        method: 'POST',
        timeoutMs: this.timeoutMs,
        mapError: mapEditError(fileName),
        // Правка большого прайса с диска - самая тяжёлая очередь documents; срок хода не тратит.
        holdTurnClock: true,
        streamBody: multipart.body,
        streamLifecycle: multipart,
        headers: {
          ...multipart.headers,
          ...(this.resultVolume === undefined ? {} : { [DELIVERY_HEADER]: DELIVERY_VOLUME }),
        },
        readOk: (response) => this.readEdited(response, request.file.size, claim),
      }).catch(async (error: unknown) => {
        await release();
        // Порядок выкатки: прежний сервис не понимает multipart. Малый файл идёт старым
        // путём (JSON из памяти), большой отдаём как есть: в JSON-тело он не поместится.
        if (!(error instanceof BadBodyError) || request.file.size > LEGACY_JSON_MAX_FILE_BYTES) {
          throw error;
        }
        return this.legacyFile(request, fileName, claim);
      })) as EditedPayload;
      const parsed = parseResponse(SERVICE, metaResponse, data.meta);
      let file: TempDiskFile;
      if (data.kind === 'volume') file = data.file;
      else if (target === undefined) throw new Error('результат правки без файла');
      else file = this.spool.wrap({ path: target, size: data.size });
      return {
        fileName: parsed.file_name,
        mimeType: parsed.mime_type,
        file,
        changed: parsed.changed,
        skipped: parsed.skipped.map(skippedOf),
      };
    } catch (error) {
      await release();
      throw error;
    }
  }

  /** Читает успешный ответ: результат на томе (по заголовку) или файл base64 в JSON. */
  private async readEdited(
    response: Response,
    sourceSize: number,
    claim: (expectedBytes: number) => Promise<string>,
  ): Promise<EditedPayload> {
    if (
      this.resultVolume !== undefined &&
      response.headers.get(DELIVERY_HEADER) === DELIVERY_VOLUME
    ) {
      const parsed = parseResponse(SERVICE, volumeResponse, await response.json());
      const file = await this.resultVolume.take(parsed.result);
      return { kind: 'volume', meta: parsed, file };
    }
    const length = Number(response.headers.get('content-length'));
    const expected =
      Number.isFinite(length) && length > 0
        ? Math.ceil(length * BASE64_RATIO)
        : sourceSize + RESULT_MARGIN_BYTES;
    const path = await claim(expected);
    const { meta, size } = await readBase64FileResponse(response, CONTENT_FIELD, path);
    return { kind: 'spool', meta, size };
  }

  /** Малый файл прежним JSON-входом (сервис без multipart): результат на диск. */
  private async legacyFile(
    request: EditPricesFileRequest,
    fileName: string,
    claim: (expectedBytes: number) => Promise<string>,
  ): Promise<EditedPayload> {
    const bytes = new Uint8Array(await readFile(request.file.path));
    const data = await requestJson({
      fetchFn: this.fetchFn,
      trace: this.trace,
      service: SERVICE,
      url: `${this.baseUrl}/edit-prices`,
      method: 'POST',
      timeoutMs: this.timeoutMs,
      mapError: mapEditError(fileName),
      holdTurnClock: true,
      body: legacyBody(fileName, bytes, serviceEdits(request.edits)),
    });
    const parsed = parseResponse(SERVICE, editResponse, data);
    const content = Buffer.from(parsed.content_base64, 'base64');
    const target = await claim(content.length);
    await writeFile(target, content, { mode: 0o600 });
    return { kind: 'spool', meta: parsed, size: content.length };
  }
}
