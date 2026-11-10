import { isDomainError, type ValidationIssue } from '@business-ai/core';
import { validateSupplierCard, type SupplierCard } from '../../kit/domain/supplier-card';
import { pairKeyOf } from './pair-notes';
import { sanitizeSupplierCard } from './card-sanitize';
import { checkApprovalPress, joinKey, readState, toStoredJson } from '@business-ai/core';
import {
  applySupplierBatch,
  isRetryableBatchCode,
  type BatchRetryRows,
  type BatchRowResult,
} from './batch-apply';
import {
  applyFieldsToCard,
  innWouldChange,
  cardFromFields,
  newCardId,
  type CardBuildContext,
} from './card-fields';
import {
  BATCH_REQUEST_SPEC,
  CARD_REQUEST_SPEC,
  batchRequestSchema,
  cardRequestSchema,
  type SupplierBatchRequest,
  type SupplierCardAction,
  type SupplierCardRequest,
  type SupplierRequestStatus,
} from './card-request';
import {
  SUPPLIER_AUDIT_BATCH,
  SUPPLIER_AUDIT_CANCEL,
  SUPPLIER_AUDIT_EDIT,
  SUPPLIER_AUDIT_NOTE,
  SUPPLIER_AUDIT_PAIR_NOTE,
  SUPPLIER_AUDIT_SAVE,
  SUPPLIER_BATCH_NAMESPACE,
  SUPPLIER_BATCH_TTL_MS,
  SUPPLIER_CARD_REQUEST_NAMESPACE,
  SUPPLIER_CARD_REQUEST_TTL_MS,
  type SupplierCardsDeps,
} from './deps';

/**
 * Исполнитель нажатий кнопок карточки поставщика и пачки. ЗАПИСЬ в общую базу выполняет
 * только `press` (код после нажатия сотрудником): у модели инструмента записи нет, она лишь
 * готовит запрос (`prepareSupplierCard`, `prepareSupplierCardEdit`, `addSupplierNote`). Порядок
 * проверок (fail closed): личность, известный запрос, тред, владелец, срок; затем повторная
 * проверка карточки и поиск дублей на момент нажатия (база могла измениться после показа).
 */

/** Нажатие кнопки действия: личность и тред берутся из события канала, не от модели. */
export interface SupplierCardPress {
  token: string;
  userId: string;
  threadId: string;
  action: Exclude<SupplierCardAction, 'cancel'>;
}

/** Нажатие «Отмена». */
export interface SupplierCardCancel {
  token: string;
  userId: string;
  threadId: string;
}

/** Прежние виды запросов (до этапа 240): читаются, но не исполняются. */
type LegacyDraftKind = 'draft_merge' | 'draft_confirm';

/** Данные запроса для маршрутизации кнопки насосом (без прав и без содержимого). */
export interface SupplierCardRef {
  token: string;
  kind: 'card' | 'note' | 'pair_note' | LegacyDraftKind | 'batch';
  /** Агент-владелец сценария: чужой бот кнопку не принимает. */
  agentId: string;
  ownerUserId: string;
  threadId: string;
}

/** Итог нажатия: тексты ответа сотруднику строит `supplierCardOutcomeText`. */
export type SupplierCardOutcome =
  | { kind: 'saved'; mode: 'created' | 'updated'; warnings?: string[] }
  | { kind: 'note_added' }
  | { kind: 'pair_note_saved' }
  | { kind: 'pair_note_full' }
  | {
      kind: 'batch_done';
      created: number;
      updated: number;
      skipped: BatchRowResult[];
      failed: BatchRowResult[];
      /** Что очищено или обрезано в строках (этап 177); пусто - без замечаний. */
      warnings?: string[];
    }
  | { kind: 'edit_requested' }
  | { kind: 'cancelled' }
  | { kind: 'invalid'; issues: ValidationIssue[] }
  | { kind: 'duplicate_appeared' }
  | { kind: 'card_changed' }
  | { kind: 'target_missing' }
  | { kind: 'wrong_action' }
  | { kind: 'failed'; code: string }
  | { kind: 'already_done' }
  | { kind: 'expired' }
  | { kind: 'wrong_owner' }
  | { kind: 'wrong_thread' }
  | { kind: 'unknown_request' }
  | { kind: 'no_identity' };

/** Сервис нажатий. */
export interface SupplierCardService {
  /** Данные запроса по токену для маршрутизации; null - запроса нет. */
  lookup(token: string): Promise<SupplierCardRef | null>;
  /** «Сохранить», «Создать новую», «Обновить существующую», «Изменить». */
  press(press: SupplierCardPress): Promise<SupplierCardOutcome>;
  /** «Отмена»: данные запроса стёрты, в базу ничего не пишется. */
  cancel(press: SupplierCardCancel): Promise<SupplierCardOutcome>;
}

/** Что нужно насосу: структурный тип (по образцу `EmailDraftButtons`). */
export type SupplierCardButtons = Pick<SupplierCardService, 'lookup' | 'press' | 'cancel'>;

type Loaded =
  | { kind: 'card'; request: SupplierCardRequest }
  | { kind: 'batch'; request: SupplierBatchRequest };

type Guarded = { kind: 'ok'; loaded: Loaded } | { kind: 'rejected'; outcome: SupplierCardOutcome };

interface PressIdentity {
  token: string;
  userId: string;
  threadId: string;
}

function codeOf(error: unknown): string {
  return isDomainError(error) ? error.code : 'unexpected';
}

/** Допустимые для кода аудита символы: остальное сводится к `unexpected`. */
const AUDIT_CODE_RE = /^[a-z0-9_]{1,40}$/;
function auditCode(code: string): string {
  return AUDIT_CODE_RE.test(code) ? code : 'unexpected';
}

/** Один и тот же момент (форматы записи могут различаться); пустое значение - не совпало. */
function sameInstant(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  const left = Date.parse(a);
  return !Number.isNaN(left) && left === Date.parse(b);
}

/** Идентификаторы дублей входят в `allowed`: на нажатии допустимы только они. */
function isSubset(current: readonly string[], allowed: readonly string[]): boolean {
  return current.every((id) => allowed.includes(id));
}

class SupplierCardServiceImpl implements SupplierCardService {
  constructor(private readonly deps: SupplierCardsDeps) {}

  async lookup(token: string): Promise<SupplierCardRef | null> {
    const loaded = await this.load(token);
    if (loaded === null) return null;
    const { request } = loaded;
    return {
      token: request.token,
      kind: loaded.kind === 'batch' ? 'batch' : loaded.request.kind,
      agentId: request.agentId,
      ownerUserId: request.ownerUserId,
      threadId: request.threadId,
    };
  }

  async press(press: SupplierCardPress): Promise<SupplierCardOutcome> {
    const guarded = await this.guard(press);
    if (guarded.kind === 'rejected') return guarded.outcome;
    const { loaded } = guarded;
    if (loaded.kind === 'batch') return this.pressBatch(loaded.request, press);
    if (press.action === 'edit') return this.requestEdit(loaded.request);
    if (loaded.request.kind === 'pair_note') return this.pressPairNote(loaded.request, press);
    // Этап 240: черновиков нет. Запрос прежнего вида, показанный до обновления, закрываем без
    // записи (повторное «да» ничего не меняет).
    if (loaded.request.kind === 'draft_merge' || loaded.request.kind === 'draft_confirm') {
      await this.close(loaded, 'blocked');
      return { kind: 'unknown_request' };
    }
    return loaded.request.kind === 'note'
      ? this.pressNote(loaded.request, press)
      : this.pressCard(loaded.request, press);
  }

  async cancel(press: SupplierCardCancel): Promise<SupplierCardOutcome> {
    const guarded = await this.guard(press);
    if (guarded.kind === 'rejected') return guarded.outcome;
    const { request } = guarded.loaded;
    await this.close(guarded.loaded, 'cancelled');
    await this.audit(request, SUPPLIER_AUDIT_CANCEL, 'ok', 'kind=' + guarded.loaded.kind);
    return { kind: 'cancelled' };
  }

  private async load(token: string): Promise<Loaded | null> {
    const { state } = this.deps;
    const card = await readState(state, SUPPLIER_CARD_REQUEST_NAMESPACE, token, cardRequestSchema);
    if (card !== null) return { kind: 'card', request: card };
    const batch = await readState(state, SUPPLIER_BATCH_NAMESPACE, token, batchRequestSchema);
    return batch === null ? null : { kind: 'batch', request: batch };
  }

  private reject(outcome: SupplierCardOutcome): Guarded {
    return { kind: 'rejected', outcome };
  }

  /** Общие проверки: личность, известный открытый запрос, тред, владелец, срок. */
  private async guard(press: PressIdentity): Promise<Guarded> {
    if (press.userId.trim() === '') return this.reject({ kind: 'no_identity' });
    const loaded = await this.load(press.token);
    if (loaded === null) return this.reject({ kind: 'unknown_request' });
    const { state, clock } = this.deps;
    const checked =
      loaded.kind === 'batch'
        ? await checkApprovalPress(state, BATCH_REQUEST_SPEC, press)
        : await checkApprovalPress(state, CARD_REQUEST_SPEC, press);
    if (checked.kind === 'wrong_thread') return this.reject({ kind: 'wrong_thread' });
    if (checked.kind === 'no_identity') return this.reject({ kind: 'no_identity' });
    if (checked.kind === 'unknown_request') {
      // Закрытый запрос из своего треда: повторное нажатие, а не неизвестная кнопка.
      const repeated =
        loaded.request.closedAt !== undefined && loaded.request.threadId === press.threadId;
      return this.reject({ kind: repeated ? 'already_done' : 'unknown_request' });
    }
    const { request } = loaded;
    if (request.ownerUserId !== press.userId) return this.reject({ kind: 'wrong_owner' });
    const ttl = loaded.kind === 'batch' ? SUPPLIER_BATCH_TTL_MS : SUPPLIER_CARD_REQUEST_TTL_MS;
    const age = clock.now().getTime() - Date.parse(request.requestedAt);
    if (Number.isNaN(age) || age > ttl) {
      await this.close(loaded, 'expired');
      return this.reject({ kind: 'expired' });
    }
    return { kind: 'ok', loaded };
  }

  /** Терминальный статус: данные с ПДн стёрты, запись помечена `done`. */
  private async close(loaded: Loaded, status: SupplierRequestStatus): Promise<void> {
    const closedAt = this.deps.clock.now().toISOString();
    if (loaded.kind === 'batch') {
      const closed: SupplierBatchRequest = {
        ...loaded.request,
        status,
        closedAt,
        rows: [],
        duplicates: [],
      };
      await this.deps.state.put(SUPPLIER_BATCH_NAMESPACE, closed.token, toStoredJson(closed), {
        done: true,
      });
      return;
    }
    const { fields: _fields, noteText: _noteText, ...rest } = loaded.request;
    const closed: SupplierCardRequest = { ...rest, status, closedAt };
    await this.deps.state.put(
      SUPPLIER_CARD_REQUEST_NAMESPACE,
      closed.token,
      toStoredJson(closed),
      { done: true },
    );
  }

  private context(userId: string, request: SupplierCardRequest): CardBuildContext {
    return { userId, nowIso: this.deps.clock.now().toISOString(), source: request.source };
  }

  private async requestEdit(request: SupplierCardRequest): Promise<SupplierCardOutcome> {
    // «Изменить» есть только у карточки без выбора дубля; у заметки и пачки его нет.
    const choosingDuplicate = request.mode === 'create' && request.duplicateIds.length > 0;
    if (request.kind !== 'card' || choosingDuplicate) return { kind: 'wrong_action' };
    const loaded: Loaded = { kind: 'card', request };
    await this.close(loaded, 'edit_requested');
    await this.audit(request, SUPPLIER_AUDIT_EDIT, 'ok', 'kind=card');
    return { kind: 'edit_requested' };
  }

  /** Заметка к общей карточке: запись после кнопки, автор - нажавший. */
  private async pressNote(
    request: SupplierCardRequest,
    press: SupplierCardPress,
  ): Promise<SupplierCardOutcome> {
    const loaded: Loaded = { kind: 'card', request };
    if (press.action !== 'save') return { kind: 'wrong_action' };
    const text = request.noteText;
    if (request.targetId === undefined || text === undefined) return { kind: 'unknown_request' };
    try {
      const existing = await this.deps.suppliers.getCard(request.targetId);
      if (existing === null) {
        await this.close(loaded, 'blocked');
        return { kind: 'target_missing' };
      }
      // Момент заметки - момент запроса, а не нажатия: повтор после сбоя несёт те же
      // (текст, автор, момент), и `addNote` его не дублирует (R6-01-05, R6-07-07).
      await this.deps.suppliers.addNote(request.targetId, {
        text,
        authorId: press.userId,
        createdAt: request.requestedAt,
      });
    } catch (error) {
      return this.failure(loaded, request, SUPPLIER_AUDIT_NOTE, error);
    }
    try {
      await this.close(loaded, 'saved');
    } catch (error) {
      // Заметка уже записана: сбой закрытия не выдаём за неудачу записи. Запрос остаётся
      // открытым, повторное нажатие заметку не продублирует (запись идемпотентна).
      this.deps.log?.('note_close_failed', { code: codeOf(error) });
    }
    await this.audit(request, SUPPLIER_AUDIT_NOTE, 'ok', 'kind=note');
    return { kind: 'note_added' };
  }

  /**
   * Личная заметка связки «сотрудник + агент»: запись после «Да». Связка строится из события
   * канала (сотрудник) и треда запроса, а не из данных модели; общей базе поставщиков запись не
   * касается. Момент записи - момент запроса: повтор нажатия (в том числе параллельный или
   * после сбоя закрытия) приходит к той же записи, хранилище её не дублирует.
   */
  private async pressPairNote(
    request: SupplierCardRequest,
    press: SupplierCardPress,
  ): Promise<SupplierCardOutcome> {
    const loaded: Loaded = { kind: 'card', request };
    if (press.action !== 'save') return { kind: 'wrong_action' };
    const text = request.noteText;
    if (text === undefined) return { kind: 'unknown_request' };
    try {
      await this.deps.pairNotes.add(pairKeyOf(request.threadId, request.agentId, press.userId), {
        kind: request.pairNoteKind ?? 'note',
        text,
        createdAt: request.requestedAt,
      });
    } catch (error) {
      if (codeOf(error) === 'conflict') {
        // Записей уже предельное число: запрос закрыт, текст стёрт.
        await this.close(loaded, 'blocked');
        await this.audit(request, SUPPLIER_AUDIT_PAIR_NOTE, 'blocked', 'reason=full');
        return { kind: 'pair_note_full' };
      }
      const code = codeOf(error);
      const result = `error:${auditCode(code)}`;
      await this.audit(request, SUPPLIER_AUDIT_PAIR_NOTE, result, 'kind=pair_note');
      return { kind: 'failed', code };
    }
    try {
      await this.close(loaded, 'saved');
    } catch (error) {
      // Запись уже есть; повторное нажатие её не продублирует (хранилище идемпотентно).
      this.deps.log?.('pair_note_close_failed', { code: codeOf(error) });
    }
    await this.audit(request, SUPPLIER_AUDIT_PAIR_NOTE, 'ok', 'kind=pair_note');
    return { kind: 'pair_note_saved' };
  }

  /** Ошибка записи: неверные данные закрывают запрос, сбой хранилища оставляет повтор. */
  private async failure(
    loaded: Loaded,
    request: SupplierCardRequest,
    action: string,
    error: unknown,
  ): Promise<SupplierCardOutcome> {
    const code = codeOf(error);
    if (code === 'invalid_input') await this.close(loaded, 'blocked');
    await this.audit(request, action, `error:${auditCode(code)}`, 'kind=card');
    return { kind: 'failed', code };
  }

  /** Карточка: «Сохранить» / «Создать новую» / «Обновить существующую» / правка по id. */
  private async pressCard(
    request: SupplierCardRequest,
    press: SupplierCardPress,
  ): Promise<SupplierCardOutcome> {
    const loaded: Loaded = { kind: 'card', request };
    const allowed = this.actionAllowed(request, press.action);
    if (!allowed || request.fields === undefined) return { kind: 'wrong_action' };
    const context = this.context(press.userId, request);
    // Создание или правка: от этого зависит, что значит конфликт записи.
    let creating = false;
    try {
      const built = await this.buildCard(request, press.action, context);
      if (built.kind === 'target_missing') {
        await this.close(loaded, 'blocked');
        return { kind: 'target_missing' };
      }
      if (built.kind === 'inn_differs') return { kind: 'wrong_action' };
      creating = built.isNew;
      if (!built.isNew && this.changedSinceShown(request, built.existing)) {
        return this.blockCardChanged(loaded, request);
      }
      // Этап 177: неверные значения очищаются до записи (репозиторий проверяет те же правила
      // и отказал бы), сотрудник получает предупреждения. Отказ остаётся без названия.
      const sanitized = sanitizeSupplierCard(built.card);
      const card = sanitized.card;
      const issues = validateSupplierCard(card);
      if (issues.length > 0) {
        await this.close(loaded, 'blocked');
        await this.audit(request, SUPPLIER_AUDIT_SAVE, 'blocked', `issues=${issues.length}`);
        return { kind: 'invalid', issues };
      }
      const conflict = await this.conflicts(request, card, built.isNew);
      if (conflict) {
        await this.close(loaded, 'blocked');
        await this.audit(request, SUPPLIER_AUDIT_SAVE, 'blocked', 'reason=duplicate_appeared');
        return { kind: 'duplicate_appeared' };
      }
      // Создание не заменяет чужую карточку, правка пишется только поверх прочитанной версии.
      const expected = built.existing?.updatedAt;
      await this.deps.suppliers.saveCard(
        card,
        built.isNew
          ? { createOnly: true }
          : expected === undefined
            ? {}
            : { expectedUpdatedAt: expected },
      );
      await this.close(loaded, 'saved');
      await this.audit(request, SUPPLIER_AUDIT_SAVE, 'ok', `new=${built.isNew}`);
      return {
        kind: 'saved',
        mode: built.isNew ? 'created' : 'updated',
        ...(sanitized.warnings.length === 0 ? {} : { warnings: sanitized.warnings }),
      };
    } catch (error) {
      if (codeOf(error) === 'conflict') {
        // Между проверкой и записью появилась такая же карточка или правку опередила другая.
        if (creating) {
          await this.close(loaded, 'blocked');
          await this.audit(request, SUPPLIER_AUDIT_SAVE, 'blocked', 'reason=duplicate_appeared');
          return { kind: 'duplicate_appeared' };
        }
        return this.blockCardChanged(loaded, request);
      }
      return this.failure(loaded, request, SUPPLIER_AUDIT_SAVE, error);
    }
  }

  /** Карточку правили после показа: версия на момент показа не совпала с текущей. */
  private changedSinceShown(request: SupplierCardRequest, existing: SupplierCard): boolean {
    if (request.baseUpdatedAt === undefined) return false;
    return !sameInstant(request.baseUpdatedAt, existing.updatedAt);
  }

  private async blockCardChanged(
    loaded: Loaded,
    request: SupplierCardRequest,
  ): Promise<SupplierCardOutcome> {
    await this.close(loaded, 'blocked');
    await this.audit(request, SUPPLIER_AUDIT_SAVE, 'blocked', 'reason=card_changed');
    return { kind: 'card_changed' };
  }

  /** Какие кнопки допустимы: с дублями - явный выбор, без дублей - «Сохранить». */
  private actionAllowed(request: SupplierCardRequest, action: SupplierCardAction): boolean {
    if (request.mode === 'edit') return action === 'save';
    if (request.duplicateIds.length > 0) return action === 'update' || action === 'create';
    return action === 'save';
  }

  private async buildCard(
    request: SupplierCardRequest,
    action: SupplierCardAction,
    context: CardBuildContext,
  ): Promise<
    | { kind: 'ok'; card: SupplierCard; isNew: true; existing?: undefined }
    | { kind: 'ok'; card: SupplierCard; isNew: false; existing: SupplierCard }
    | { kind: 'target_missing' }
    | { kind: 'inn_differs' }
  > {
    const fields = request.fields ?? {};
    if (request.mode === 'edit' || action === 'update') {
      const existing =
        request.targetId === undefined ? null : await this.deps.suppliers.getCard(request.targetId);
      if (existing === null) return { kind: 'target_missing' };
      // «Обновить» не подменяет ИНН найденного поставщика; запрос остаётся для «Создать новую».
      if (action === 'update' && innWouldChange(existing, fields)) return { kind: 'inn_differs' };
      const card = applyFieldsToCard(existing, fields, context);
      return { kind: 'ok', card, isNew: false, existing };
    }
    // Новая запись при «Создать новую» не должна затереть похожую: id получает соль-токен.
    const salt = action === 'create' ? request.token : '';
    const card = cardFromFields(fields, context, newCardId(fields, salt));
    return { kind: 'ok', card, isNew: true };
  }

  /** Новые дубли после показа или занятый id: запись не делается. */
  private async conflicts(
    request: SupplierCardRequest,
    card: SupplierCard,
    isNew: boolean,
  ): Promise<boolean> {
    const candidate = {
      name: card.name,
      ...(card.inn === undefined ? {} : { inn: card.inn }),
      contacts: card.contacts,
      // У существующей карточки сама запись дублем не считается; у новой id не передаётся.
      ...(isNew ? {} : { id: card.id }),
    };
    const current = await this.deps.suppliers.findDuplicates(candidate);
    const target = request.targetId === undefined ? [] : [request.targetId];
    const known = [...request.duplicateIds, ...target];
    if (!isSubset(current.map((match) => match.supplierId), known)) return true;
    return isNew && (await this.deps.suppliers.getCard(card.id)) !== null;
  }

  /** Пачка: «Записать» (только новые) или «Записать и обновить дубли». */
  private async pressBatch(
    request: SupplierBatchRequest,
    press: SupplierCardPress,
  ): Promise<SupplierCardOutcome> {
    const loaded: Loaded = { kind: 'batch', request };
    const wantsUpdate = press.action === 'update';
    const allowed = press.action === 'save' || (wantsUpdate && request.duplicates.length > 0);
    if (!allowed) return { kind: 'wrong_action' };
    const context: CardBuildContext = {
      userId: press.userId,
      nowIso: this.deps.clock.now().toISOString(),
      source: 'file',
    };
    const retry: BatchRetryRows = {
      rows: new Set(),
      duplicates: new Set(),
      ownWritten: new Map(Object.entries(request.ownWritten ?? {})),
    };
    const result = await applySupplierBatch(
      this.deps,
      request,
      wantsUpdate ? 'update' : 'save',
      context,
      retry,
      request.requestedAt,
    );
    if (retry.rows.size + retry.duplicates.size > 0) {
      // Сбой хранилища на части строк: запрос остаётся открытым с одними неудавшимися
      // строками, повторное нажатие дописывает их (записанные строки не повторяются).
      const remaining: SupplierBatchRequest = {
        ...request,
        rows: request.rows.filter((item) => retry.rows.has(item.row)),
        duplicates: request.duplicates.filter((item) => retry.duplicates.has(item.row)),
        ownWritten: Object.fromEntries(retry.ownWritten ?? []),
      };
      await this.deps.state.put(SUPPLIER_BATCH_NAMESPACE, request.token, toStoredJson(remaining));
    } else {
      await this.close(loaded, 'saved');
    }
    await this.audit(
      request,
      SUPPLIER_AUDIT_BATCH,
      'ok',
      `created=${result.created} updated=${result.updated} skipped=${result.skipped.length} ` +
        `failed=${result.failed.length}`,
    );
    return { kind: 'batch_done', ...result };
  }

  /** Аудит: только токен, код и числа; ни названий, ни ИНН, ни адресов. */
  private async audit(
    request: { token: string; agentId: string; ownerUserId: string },
    action: string,
    result: string,
    details: string,
  ): Promise<void> {
    try {
      await this.deps.audit.append(
        {
          at: this.deps.clock.now().toISOString(),
          actor: request.ownerUserId,
          agent: request.agentId,
          action,
          details: `request=${request.token} ${details}`,
          result,
        },
        joinKey('suppliers-audit', request.token, action, result, details),
      );
    } catch (error) {
      this.deps.log?.('audit_failed', { code: codeOf(error) });
    }
  }
}

/** Создать сервис нажатий карточек и пачек. */
export function createSupplierCardService(deps: SupplierCardsDeps): SupplierCardService {
  return new SupplierCardServiceImpl(deps);
}

/** Сколько строк с ошибками перечисляем в итоге пачки. */
const BATCH_REPORT_ROWS_LIMIT = 20;

const ROW_CODE_TEXT: Readonly<Record<string, string>> = {
  existing: 'уже есть в базе',
  duplicate_appeared: 'в базе появился похожий поставщик',
  already_exists: 'такая карточка уже есть',
  invalid: 'не указано название поставщика',
  card_changed: 'карточку изменили во время записи, обновите её отдельно',
  target_missing: 'карточка для обновления не найдена',
};

function rowsText(rows: readonly BatchRowResult[]): string {
  const shown = rows.slice(0, BATCH_REPORT_ROWS_LIMIT).map((item) => {
    const reason = ROW_CODE_TEXT[item.code] ?? `ошибка (${item.code})`;
    return `- строка ${item.row}: ${reason}`;
  });
  const rest = rows.length - shown.length;
  return [...shown, ...(rest > 0 ? [`- и ещё ${rest}`] : [])].join('\n');
}

/** Итог с блоком предупреждений (этап 177): коротко, одним списком. */
function withWarningsText(text: string, warnings: readonly string[] | undefined): string {
  if (warnings === undefined || warnings.length === 0) return text;
  const shown = warnings.slice(0, BATCH_REPORT_ROWS_LIMIT).map((item) => `- ${item}`);
  const rest = warnings.length - shown.length;
  return [text, 'Предупреждения:', ...shown, ...(rest > 0 ? [`- и ещё ${rest}`] : [])].join('\n');
}

/** Текст ответа сотруднику по итогу нажатия (без содержимого карточки). */
export function supplierCardOutcomeText(outcome: SupplierCardOutcome): string {
  switch (outcome.kind) {
    case 'saved': {
      const done =
        outcome.mode === 'created'
          ? 'Карточка поставщика сохранена.'
          : 'Карточка поставщика обновлена.';
      return withWarningsText(done, outcome.warnings);
    }
    case 'note_added':
      return 'Заметка добавлена к карточке поставщика.';
    case 'pair_note_saved':
      return 'Запомнил.';
    case 'pair_note_full':
      return 'Личных записей уже максимум: удалите ненужные (попросите «что ты помнишь»).';
    case 'batch_done': {
      const lines = [
        `Записано новых: ${outcome.created}. Обновлено существующих: ${outcome.updated}.`,
      ];
      if (outcome.skipped.length > 0) {
        lines.push(`Пропущено: ${outcome.skipped.length}.`, rowsText(outcome.skipped));
      }
      if (outcome.failed.length > 0) {
        lines.push(`Не удалось записать: ${outcome.failed.length}.`, rowsText(outcome.failed));
        if (outcome.failed.some((item) => isRetryableBatchCode(item.code))) {
          lines.push('Это сбой хранилища: подтвердите запись ещё раз, запишутся только они.');
        }
      }
      return withWarningsText(lines.join('\n'), outcome.warnings);
    }
    case 'edit_requested':
      return 'Напишите, что изменить, одним сообщением.';
    case 'cancelled':
      return 'Отменено, в базу ничего не записано.';
    case 'invalid':
      return `Карточка не сохранена: ${outcome.issues
        .map((issue) => issue.message)
        .join(' ')} Подготовьте её заново.`;
    case 'duplicate_appeared':
      return 'Карточка не сохранена: после показа в базе появился похожий поставщик. ' +
        'Подготовьте карточку заново, чтобы выбрать, обновить существующую или создать новую.';
    case 'card_changed':
      return 'Карточка изменилась после показа: сохранение не выполнено. ' +
        'Подготовьте правку заново.';
    case 'target_missing':
      return 'Карточка для обновления не найдена: возможно, её уже удалили.';
    case 'wrong_action':
      return 'Такое решение здесь не подходит. Выберите один из вариантов последнего показа.';
    case 'failed':
      return `Не удалось сохранить (${outcome.code}). Можно подтвердить ещё раз.`;
    case 'already_done':
      return 'Этот запрос уже обработан.';
    case 'expired':
      return 'Запрос устарел. Попросите подготовить карточку заново.';
    case 'wrong_owner':
      return 'Подтвердить может только сотрудник, который готовил карточку.';
    case 'wrong_thread':
    case 'unknown_request':
      return 'Запрос не найден.';
    case 'no_identity':
      return 'Не удалось определить, кто подтверждает.';
  }
}

