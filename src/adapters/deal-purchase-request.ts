import { DomainError, ExternalAccessDeniedError, isDomainError } from '@business-ai/core';
import type { Bitrix24PortalClient } from '@business-ai/adapters';
import { z } from 'zod';
import { parseIsoDeadline } from '../kit/domain/iso-datetime';
import type { PurchaseRequest } from '../kit/domain/models';
import {
  DEFAULT_DEAL_UNIT,
  dealFieldMapSchema,
  itemFrom,
  scanLineItems,
  type DealFieldMap,
  type ParsedDealItems,
} from './deal-field-map';

/** Приставка id заявки: детерминирована от сделки, повторное чтение даёт ту же заявку. */
const REQUEST_ID_PREFIX = 'bx24-deal-';
/** Приоритет чтения по запросу сотрудника (как у прочих чтений инструментов агента). */
const PRIORITY = 'send';
/** Сколько номеров нераспознанных строк назвать в тексте отказа (остальные - «и ещё N»). */
const MAX_LISTED_ROWS = 20;
/** Название сервиса в текстах отказов. */
const DEAL_WHAT = 'CRM Bitrix24 (сделка)';
const ROWS_WHAT = 'CRM Bitrix24 (товарные строки)';

const dealSchema = z.record(z.unknown());
const rowsSchema = z.array(z.unknown());
const productRowSchema = z.object({
  PRODUCT_NAME: z.string(),
  QUANTITY: z.union([z.number(), z.string()]),
  MEASURE_NAME: z.string().nullable().optional(),
});

/** Журнал: короткие события и скалярные поля, без названий позиций. */
export type DealRequestLogger = (event: string, fields: Record<string, string | number>) => void;

/** Настройки чтения заявки по сделке. */
export interface DealPurchaseRequestOptions {
  /** Общий клиент портала платформы (один ограничитель частоты на приложение). */
  portal: Bitrix24PortalClient;
  /** Карта полей; валидируется, пустая - товарные строки. */
  fieldMap?: z.input<typeof dealFieldMapSchema> | undefined;
  logger?: DealRequestLogger | undefined;
}

/** Идентификатор портала: цифры, безопасное целое; иначе null. */
function numericRef(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/** Поля ошибки портала, нужные проекту (класс `Bitrix24Error` платформа не экспортирует). */
interface PortalErrorShape {
  name: string;
  reason: string | null;
  kind: string;
  status?: number | undefined;
}

function portalErrorOf(error: unknown): PortalErrorShape | null {
  if (!(error instanceof Error) || error.name !== 'Bitrix24Error') return null;
  const shaped = error as Error & Partial<PortalErrorShape>;
  return {
    name: shaped.name,
    reason: typeof shaped.reason === 'string' ? shaped.reason : null,
    kind: typeof shaped.kind === 'string' ? shaped.kind : '',
    status: typeof shaped.status === 'number' ? shaped.status : undefined,
  };
}

/** Отказ портала с заданным смыслом (`not_found`, `access_denied`, `permission`). */
function hasReason(error: unknown, ...reasons: string[]): boolean {
  const shaped = portalErrorOf(error);
  return shaped !== null && shaped.reason !== null && reasons.includes(shaped.reason);
}

/**
 * Привести сбой портала к `DomainError` без деталей (адрес вебхука и тела ответов в текст не
 * попадают). Нехватка прав вебхука не повторяема, прочие сбои повторяемы.
 */
function portalFailure(error: unknown, what: string): DomainError {
  const shaped = portalErrorOf(error);
  if (shaped !== null) {
    if (shaped.kind === 'cancelled' && error instanceof DomainError) return error;
    if (hasReason(error, 'permission', 'access_denied')) {
      return new ExternalAccessDeniedError(`${what}: у вебхука портала нет нужных прав.`);
    }
    return new DomainError('external_failure', `${what}: портал недоступен или ответил ошибкой.`, {
      retryable: true,
    });
  }
  if (isDomainError(error)) return error;
  return new DomainError('external_failure', `${what}: сбой обращения к порталу.`, {
    retryable: true,
  });
}

/** Отказ «в сделке есть нераспознанные строки»: только номера строк, без текстов. */
function droppedRowsFailure(rows: readonly number[]): DomainError {
  const listed = rows.slice(0, MAX_LISTED_ROWS).join(', ');
  const rest = rows.length - MAX_LISTED_ROWS;
  const tail = rest > 0 ? ` и ещё ${rest}` : '';
  return new DomainError(
    'validation_failed',
    `В сделке ${rows.length} строк не распознаны (строки: ${listed}${tail}); ` +
      'исправьте сделку или пришлите заявку текстом.',
  );
}

/**
 * Разбор заявки закупа по сделке Bitrix24: позиции из товарных строк либо из пользовательского
 * поля по карте `BITRIX24_DEAL_FIELD_MAP`. Портал только читается, поля сделки не меняются.
 * Платформенный порт CRM разбора заявки не умеет, поэтому он живёт в проекте и работает на
 * клиенте портала платформы (общий ограничитель частоты).
 */
export class DealPurchaseRequestReader {
  private readonly portal: Bitrix24PortalClient;
  private readonly map: DealFieldMap;
  private readonly logger: DealRequestLogger;
  private readonly unit: string;

  constructor(options: DealPurchaseRequestOptions) {
    this.portal = options.portal;
    this.map = dealFieldMapSchema.parse(options.fieldMap ?? {});
    this.logger = options.logger ?? (() => undefined);
    this.unit = this.map.defaultUnit ?? DEFAULT_DEAL_UNIT;
  }

  /**
   * Заявка по ссылке на сделку. Нечисловая ссылка, нет сделки или нет прав на неё, нет
   * позиций - `null`. Нераспознанные строки - отказ с номерами строк (частичную заявку молча
   * не отдаём: расчёт ушёл бы с меньшим перечнем). Сбой портала - `DomainError`.
   */
  async getPurchaseRequest(dealRef: string): Promise<PurchaseRequest | null> {
    const dealId = numericRef(dealRef);
    if (dealId === null) return null;
    const deal = await this.readDeal(dealId);
    if (deal === null) return null;
    const createdMs = this.createdAtOf(deal);
    const parsed =
      this.map.items.source === 'productRows'
        ? await this.itemsFromRows(dealId)
        : this.itemsFromField(deal, this.map.items.field);
    this.logger('bitrix24_crm_items', {
      items: parsed.items.length,
      dropped: parsed.droppedRows.length,
    });
    if (parsed.droppedRows.length > 0) throw droppedRowsFailure(parsed.droppedRows);
    if (parsed.items.length === 0) return null;
    return {
      id: `${REQUEST_ID_PREFIX}${dealId}`,
      dealRef: String(dealId),
      items: parsed.items,
      createdAt: new Date(createdMs).toISOString(),
    };
  }

  /** Сделка; нет сделки или нет прав на неё - null (существование не раскрываем). */
  private async readDeal(dealId: number): Promise<Record<string, unknown> | null> {
    try {
      return await this.portal.client.callMethod('crm.deal.get', { id: dealId }, dealSchema, {
        priority: PRIORITY,
        retryUnknown: true,
      });
    } catch (error) {
      if (hasReason(error, 'not_found', 'access_denied')) {
        this.logger('bitrix24_crm_deal_unavailable', { status: portalErrorOf(error)?.status ?? 0 });
        return null;
      }
      throw portalFailure(error, DEAL_WHAT);
    }
  }

  private createdAtOf(deal: Record<string, unknown>): number {
    const raw = deal['DATE_CREATE'];
    const ms = typeof raw === 'string' ? parseIsoDeadline(raw) : undefined;
    // Время создания нельзя подменять «сейчас»: заявка живёт по времени сделки.
    if (ms === undefined) {
      throw new DomainError(
        'external_failure',
        'CRM Bitrix24: у сделки нет читаемой даты создания.',
        { retryable: false },
      );
    }
    return ms;
  }

  private async itemsFromRows(dealId: number): Promise<ParsedDealItems> {
    let rows: unknown[];
    try {
      rows = await this.portal.client.callMethod(
        'crm.deal.productrows.get',
        { id: dealId },
        rowsSchema,
        { priority: PRIORITY, retryUnknown: true },
      );
    } catch (error) {
      throw portalFailure(error, ROWS_WHAT);
    }
    const parsed: ParsedDealItems = { items: [], droppedRows: [] };
    for (const [index, raw] of rows.entries()) {
      const row = productRowSchema.safeParse(raw);
      const unit = row.success ? (row.data.MEASURE_NAME ?? '').trim() : '';
      const item = row.success
        ? itemFrom(row.data.PRODUCT_NAME, row.data.QUANTITY, unit === '' ? this.unit : unit)
        : null;
      if (item === null) parsed.droppedRows.push(index + 1);
      else parsed.items.push(item);
    }
    return parsed;
  }

  private itemsFromField(deal: Record<string, unknown>, field: string): ParsedDealItems {
    const raw = deal[field];
    // Множественное поле приходит массивом строк.
    const text = Array.isArray(raw)
      ? raw.filter((part): part is string => typeof part === 'string').join('\n')
      : raw;
    if (typeof text !== 'string') return { items: [], droppedRows: [] };
    return scanLineItems(text, this.unit);
  }
}
