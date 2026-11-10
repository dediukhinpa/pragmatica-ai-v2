import { z } from 'zod';
import {
  CONTRACT_AMEND_REFUSALS,
  ContractAmendRefusedError,
  OWN_SIGNATORY_REFUSALS,
  OwnSignatoryRefusedError,
  type ContractAmendRefusal,
  type OwnSignatoryRefusal,
} from '../../domain/errors.owned';
import { DomainError } from '@business-ai/core';
import { base64Of } from '@business-ai/core';
import {
  CONTRACT_VERDICTS,
  type AmendContractRequest,
  type AmendedContract,
  type ClassifyContractRequest,
  type ContractAmender,
  type ContractKindResult,
  type OwnRequisites,
  type OwnSignatoryForms,
  type ReplaceSignatoryResult,
} from '../../ports/contract-amender';
import { type Telemetry } from '@business-ai/core';
import { bytesOf } from '../buffer-view.owned';
import { postDocumentsFile } from '@business-ai/adapters';
import { parseResponse, trimBaseUrl, type FetchFn } from '@business-ai/adapters';
import { httpTrace, type HttpTrace } from '@business-ai/adapters';

const SERVICE = 'документов (дополнение договора)';
/**
 * Таймаут договорного запроса (classify, party-block, amend) по умолчанию, мс. Он включает
 * ожидание единственного договорного места сервиса (`DOCUMENTS_CONTRACT_CONCURRENCY=1`), а не
 * только саму работу: при расчётном пике «10 пользователей одному агенту» (этап 239d) десятый
 * договор ждёт девять предыдущих. Расчёт: конвертация .doc общая для ручек (одна на договор),
 * типичный договор 6 с + разбор и правка 1-2 с, тяжёлый .doc (10-15 МБ текста) 17 с + 8 с;
 * десять тяжёлых подряд - около 250 с; впереди в очереди может оказаться договор со
 * спецификацией (потолок конвертации documents 180 с): 430 с, запас 40% даёт 600 с - это и
 * срок хода сотрудника (CHAT_TURN_TIMEOUT_MS), дольше запрос всё равно не живёт. Меньший срок
 * превращал ожидание в отказ (решение владельца 9: ожидание не отказ).
 */
export const DEFAULT_CONTRACT_TIMEOUT_MS = 600_000;
const STATUS_UNPROCESSABLE = 422;
const STATUS_TOO_LARGE = 413;
const STATUS_NOT_FOUND = 404;
const STATUS_UNAVAILABLE = 503;
/** Имя файла в форме при чтении блока сторон: формат сервис определяет по содержимому. */
const PARTY_BLOCK_FILE_NAME = 'contract.docx';

/** Из какого формата сервис привёл файл к docx (`null` - файл уже был docx). */
const convertedFrom = z.enum(['doc', 'rtf']).nullable();

// Номерных полей в ответе нет: номер договора поставщика не меняется. Лишние поля старого
// сервиса при выкатке по частям zod отбрасывает сам.
const amendResponse = z.object({
  file_name: z.string().min(1),
  mime_type: z.string().min(1),
  content_base64: z.string(),
  // Поле появилось с поддержкой .doc/RTF: старый сервис при выкатке по частям его не присылает.
  converted_from: convertedFrom.optional(),
  preamble_filled: z.boolean(),
  customer_block_filled: z.boolean(),
  placeholders_filled: z.number().int().nonnegative(),
  lines_added: z.number().int().nonnegative(),
  unfilled_placeholders: z.number().int().nonnegative(),
  notes: z.array(z.string()),
});

const partyBlockResponse = z.object({ name: z.string(), lines: z.array(z.string()) });

const replaceSignatoryResponse = z.object({
  content_base64: z.string(),
  found: z.number().int().nonnegative(),
  replaced: z.number().int().nonnegative(),
  unchanged: z.boolean(),
});

const classifyResponse = z.object({
  verdict: z.enum(CONTRACT_VERDICTS),
  reasons: z.array(z.string()),
  converted_from: convertedFrom.optional(),
});

const errorBody = z.object({
  detail: z.union([z.string(), z.object({ error: z.string().optional() })]).optional(),
});

/** Код отказа сервиса (`detail.error`), если он из известного набора. */
function refusalOf(body: unknown): ContractAmendRefusal | undefined {
  const parsed = errorBody.safeParse(body);
  if (!parsed.success || typeof parsed.data.detail !== 'object') return undefined;
  const code = parsed.data.detail.error;
  return CONTRACT_AMEND_REFUSALS.find((item) => item === code);
}

function mapRefusal(status: number, body: unknown): DomainError | undefined {
  // 413: файл больше предела сервиса либо конвертация .doc/RTF не уложилась во время. Причину
  // сервис не различает в ответе, а сотруднику одно и то же: пересохранить файл в docx.
  if (status === STATUS_TOO_LARGE) return new ContractAmendRefusedError('file_too_large');
  // 503 с кодом `spool_unavailable`: том спула полон, сбой временный. 503 без этого кода (сервис
  // перегружен, перезапускается) остаётся обычным повторяемым сбоем.
  if (status === STATUS_UNAVAILABLE) {
    return refusalOf(body) === 'spool_unavailable'
      ? new ContractAmendRefusedError('spool_unavailable')
      : undefined;
  }
  if (status !== STATUS_UNPROCESSABLE) return undefined;
  const reason = refusalOf(body);
  // Остальные 422 (повреждённый файл, некорректное тело) - обычный отказ сервиса.
  return reason === undefined
    ? new DomainError('invalid_input', 'Сервис документов отклонил дополнение договора.')
    : new ContractAmendRefusedError(reason);
}

/** Код отказа подстановки подписанта (`detail.error`), если он из известного набора. */
function signatoryRefusalOf(body: unknown): OwnSignatoryRefusal | undefined {
  const parsed = errorBody.safeParse(body);
  if (!parsed.success || typeof parsed.data.detail !== 'object') return undefined;
  const code = parsed.data.detail.error;
  return OWN_SIGNATORY_REFUSALS.find((item) => item === code);
}

/**
 * Отказы `/docx/replace-signatory`. 404 - сервис документов старее ядра (маршрута нет, выкатка
 * по частям): подстановка невозможна, документ не собирается (fail closed).
 */
function mapSignatoryRefusal(status: number, body: unknown): DomainError | undefined {
  if (status === STATUS_NOT_FOUND) {
    return new DomainError(
      'not_configured',
      'Сервис документов не умеет подставлять подписанта (устарел): документ не собран.',
    );
  }
  if (status === STATUS_UNPROCESSABLE) {
    const reason = signatoryRefusalOf(body);
    if (reason !== undefined) return new OwnSignatoryRefusedError(reason);
  }
  return mapRefusal(status, body);
}

/**
 * Отказы `/docx/classify`. 404 здесь значит, что сервис документов старее ядра (маршрут появился
 * в этапе 232, а выкатка идёт по частям): сотруднику понятный отказ вместо общего сбоя, и вид
 * договора модель сама не решает. На `/docx/amend` и `/docx/party-block` 404 так не читается:
 * эти маршруты есть и в прежнем сервисе.
 */
function mapClassifyRefusal(status: number, body: unknown): DomainError | undefined {
  if (status === STATUS_NOT_FOUND) return new ContractAmendRefusedError('service_outdated');
  return mapRefusal(status, body);
}

/** Параметры HTTP-адаптера дополнения договора. */
export interface HttpContractAmenderOptions {
  baseUrl: string;
  timeoutMs?: number;
  fetchFn?: FetchFn;
  /** Телеметрия: спан http.client и traceparent; не задана или выключена - как раньше. */
  telemetry?: Telemetry | undefined;
}

/** Адаптер порта ContractAmender к HTTP-сервису services/documents (`POST /docx/amend`). */
export class HttpContractAmender implements ContractAmender {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: FetchFn;
  private readonly trace: HttpTrace | undefined;

  constructor(options: HttpContractAmenderOptions) {
    this.baseUrl = trimBaseUrl(options.baseUrl);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CONTRACT_TIMEOUT_MS;
    this.fetchFn = options.fetchFn ?? fetch;
    this.trace = httpTrace(options.telemetry, 'documents', true);
  }

  async amend(request: AmendContractRequest): Promise<AmendedContract> {
    const data = await postDocumentsFile({
      fetchFn: this.fetchFn,
      trace: this.trace,
      service: SERVICE,
      url: `${this.baseUrl}/docx/amend`,
      timeoutMs: this.timeoutMs,
      signal: request.signal,
      mapError: mapRefusal,
      fileName: request.fileName,
      bytes: request.bytes,
      params: {
        file_name: request.fileName,
        own_requisites: { name: request.own.name, lines: [...request.own.lines] },
      },
    });
    const parsed = parseResponse(SERVICE, amendResponse, data);
    return {
      fileName: parsed.file_name,
      mimeType: parsed.mime_type,
      bytes: bytesOf(Buffer.from(parsed.content_base64, 'base64')),
      convertedFrom: parsed.converted_from ?? null,
      preambleFilled: parsed.preamble_filled,
      customerBlockFilled: parsed.customer_block_filled,
      placeholdersFilled: parsed.placeholders_filled,
      linesAdded: parsed.lines_added,
      unfilledPlaceholders: parsed.unfilled_placeholders,
      notes: parsed.notes,
    };
  }

  async classify(request: ClassifyContractRequest): Promise<ContractKindResult> {
    // Шаблоны (до 8 штук) идут в `params` формы: файл договора не ограничен 8 МиБ JSON-тела.
    const data = await postDocumentsFile({
      fetchFn: this.fetchFn,
      trace: this.trace,
      service: SERVICE,
      url: `${this.baseUrl}/docx/classify`,
      timeoutMs: this.timeoutMs,
      signal: request.signal,
      mapError: mapClassifyRefusal,
      fileName: request.fileName,
      bytes: request.bytes,
      params: {
        file_name: request.fileName,
        templates_base64: request.templates.map((bytes) => base64Of(bytes)),
        own_inns: [...request.ownInns],
        own_names: [...request.ownNames],
      },
    });
    const parsed = parseResponse(SERVICE, classifyResponse, data);
    return {
      verdict: parsed.verdict,
      reasons: parsed.reasons,
      convertedFrom: parsed.converted_from ?? null,
    };
  }

  async replaceSignatory(request: {
    bytes: Uint8Array;
    forms: OwnSignatoryForms;
    signal?: AbortSignal | undefined;
  }): Promise<ReplaceSignatoryResult> {
    const data = await postDocumentsFile({
      fetchFn: this.fetchFn,
      trace: this.trace,
      service: SERVICE,
      url: `${this.baseUrl}/docx/replace-signatory`,
      timeoutMs: this.timeoutMs,
      signal: request.signal,
      mapError: mapSignatoryRefusal,
      fileName: PARTY_BLOCK_FILE_NAME,
      bytes: request.bytes,
      params: {
        nominative_short: request.forms.nominativeShort,
        nominative_reversed: request.forms.nominativeReversed,
        genitive_full: request.forms.genitiveFull,
        genitive_short: request.forms.genitiveShort,
      },
    });
    const parsed = parseResponse(SERVICE, replaceSignatoryResponse, data);
    return {
      bytes: parsed.unchanged
        ? request.bytes
        : bytesOf(Buffer.from(parsed.content_base64, 'base64')),
      found: parsed.found,
      replaced: parsed.replaced,
      unchanged: parsed.unchanged,
    };
  }

  async readPartyBlock(request: {
    bytes: Uint8Array;
    role: string;
    signal?: AbortSignal | undefined;
  }): Promise<OwnRequisites> {
    const data = await postDocumentsFile({
      fetchFn: this.fetchFn,
      trace: this.trace,
      service: SERVICE,
      url: `${this.baseUrl}/docx/party-block`,
      timeoutMs: this.timeoutMs,
      signal: request.signal,
      mapError: mapRefusal,
      fileName: PARTY_BLOCK_FILE_NAME,
      bytes: request.bytes,
      params: { role: request.role },
    });
    const parsed = parseResponse(SERVICE, partyBlockResponse, data);
    return { name: parsed.name, lines: parsed.lines };
  }
}
