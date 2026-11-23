import { isSenderVerified, type InboxMessage } from '@business-ai/core';
import { failureName, joinKey, stableHash } from '@business-ai/core';
import {
  DomainIndex,
  enrichOrCreateSupplier,
  type EnrichmentFields,
  type EnrichmentOutcome,
} from './card-enrichment';
import type { SupplierCardFields } from './card-fields';
import { SUPPLIER_AUDIT_ENRICH } from './deps';
import type { SupplierMailProposalsDeps } from './mail-proposal-store';

/**
 * Автообогащение СУЩЕСТВУЮЩИХ карточек по письмам из ящиков сотрудников (обзор почты, этап 222),
 * без вопросов человеку (решение владельца 10.11.2026; флаг
 * `SUPPLIER_MAIL_PROPOSALS_AUTO_ENRICH_ENABLED`, по умолчанию выключен). Модель только оценивает
 * письмо; значения проверяет и пишет код теми же
 * правилами, что и дополнение карточки из письма: пишутся лишь ПУСТЫЕ поля, заполненное не
 * перезаписывается (расхождение - `conflicts`, без записи), отправитель должен быть доверенным
 * (`by_trust`: DKIM, адрес или домен карточки), контакты чужого отправителя не пишутся.
 *
 * Жёсткое ограничение безопасности: платёжные и юридические реквизиты письмом не применяются
 * никогда. Подмена реквизитов письмом - типовая схема мошенничества, поэтому на запись
 * допускается только белый список нефинансовых полей {@link AUTO_ENRICH_FIELDS}; всё остальное
 * (ИНН, КПП, ОГРН, адреса юрлица, банковские реквизиты, директор/подписант, условия оплаты,
 * статус, оценки) отбрасывается кодом, а реквизиты при этом получают прежнюю пометку
 * «Реквизиты изменились» на карточке (правка с подтверждением человеком).
 */

/** Автор записей и аудита автообогащения: отдельная метка, не сотрудник. */
export const SUPPLIER_MAIL_AUTO_ENRICH_AUTHOR = 'supplier-mail-auto-enrich';
/** Агент в записи аудита. */
const AUDIT_AGENT = 'supplier-mail-proposals';

/** Поля карточки верхнего уровня, которые письмо вправе заполнить само (нефинансовые). */
export const AUTO_ENRICH_FIELDS = [
  'website',
  'contacts',
  'categories',
  'brands',
  'regions',
  'productionCity',
] as const;
/** Условия поставки, допустимые для автозаписи; условия оплаты и скидки - нет. */
export const AUTO_ENRICH_TERMS = ['delivery', 'minBatch', 'leadTime'] as const;

/** Белый список: только допустимые поля; число отброшенных непустых полей пишет `onWithheld`. */
export function autoEnrichFilter(
  fields: SupplierCardFields,
  onWithheld: (count: number) => void,
): SupplierCardFields {
  const allowed: ReadonlySet<string> = new Set(AUTO_ENRICH_FIELDS);
  const kept: Record<string, unknown> = {};
  let withheld = 0;
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || key === 'name') continue;
    if (allowed.has(key)) kept[key] = value;
    else if (key !== 'terms') withheld += 1;
  }
  if (fields.terms !== undefined) {
    const terms: Record<string, string> = {};
    for (const [key, value] of Object.entries(fields.terms)) {
      if (value === undefined) continue;
      if ((AUTO_ENRICH_TERMS as readonly string[]).includes(key)) terms[key] = value;
      else withheld += 1;
    }
    if (Object.keys(terms).length > 0) kept.terms = terms;
  }
  onWithheld(withheld);
  return kept as SupplierCardFields;
}

/** Итог автообогащения одного письма: только числа. */
export interface AutoEnrichResult {
  kind: EnrichmentOutcome['kind'];
  /** Сколько полей карточки заполнено. */
  added: number;
  conflicts: number;
  /** Сколько заполненных в письме полей отброшено белым списком (реквизиты и прочее). */
  withheld: number;
  /** Карточка найдена, но отправитель не доверенный. */
  untrusted: boolean;
}

/** Запись аудита: кто, какая карточка, сколько полей; значений нет. Сбой аудита не роняет. */
async function auditWrite(
  deps: SupplierMailProposalsDeps,
  messageKey: string,
  outcome: EnrichmentOutcome,
): Promise<void> {
  if (deps.audit === undefined) return;
  const supplierId = outcome.supplierId ?? '';
  try {
    await deps.audit.append(
      {
        at: deps.clock.now().toISOString(),
        actor: SUPPLIER_MAIL_AUTO_ENRICH_AUTHOR,
        agent: AUDIT_AGENT,
        action: SUPPLIER_AUDIT_ENRICH,
        details:
          `supplier=${supplierId} fields=${outcome.addedFields.length} ` +
          `conflicts=${outcome.conflicts.length} mode=auto`,
        result: 'ok',
      },
      joinKey('suppliers-mail-auto-enrich', messageKey, supplierId),
    );
  } catch (error) {
    deps.log?.('supplier_mail_auto_enrich_audit_failed', { code: failureName(error) });
  }
}

/**
 * Дополнить существующую карточку по письму. `message` - письмо целиком (с DKIM), `fields` -
 * поля, уже проверенные кодом по тексту письма. `supplierId` - карточка, найденная по адресу или
 * домену отправителя (одна); нет - карточку ищет общий узел сопоставления, неоднозначность
 * ничего не пишет. Создания карточек здесь нет.
 */
export async function autoEnrichExisting(
  deps: SupplierMailProposalsDeps,
  userId: string,
  message: InboxMessage,
  fields: EnrichmentFields,
  supplierId: string | undefined,
): Promise<AutoEnrichResult> {
  const sender = message.from.toLowerCase();
  const messageKey = stableHash([userId, message.id]);
  let withheld = 0;
  const outcome = await enrichOrCreateSupplier(
    { suppliers: deps.suppliers, clock: deps.clock, domains: new DomainIndex(deps.suppliers) },
    {
      key: messageKey,
      label: '',
      senderKeys: [sender],
      ...(supplierId === undefined ? {} : { supplierId }),
      receivedAt: message.receivedAt,
    },
    fields,
    {
      createIfMissing: false,
      origin: 'email',
      author: SUPPLIER_MAIL_AUTO_ENRICH_AUTHOR,
      // Доверие к отправителю - как в ответе на предложение: с моделью доверия (этап 233) по DKIM
      // письма и данным карточки, без неё - только собственная подпись DKIM.
      ...(deps.senderTrust === undefined
        ? { existingCards: isSenderVerified(message) ? ('enrich' as const) : ('review' as const) }
        : {
            existingCards: 'by_trust' as const,
            trust: {
              policy: deps.senderTrust.policy,
              evidence: async () => ({
                dkimAligned: message.dkim === 'aligned',
                replyToOurs: message.inReplyTo !== undefined,
              }),
            },
          }),
      contactDomainGuard: true,
      // Реквизиты письмо не пишет ни при каком доверии, остальное режет белый список.
      provenRequisites: new Set<string>(),
      writableFilter: (safe) =>
        autoEnrichFilter(safe, (count) => {
          withheld = count;
        }),
    },
  );
  if (outcome.kind === 'enriched') await auditWrite(deps, messageKey, outcome);
  return {
    kind: outcome.kind,
    added: outcome.addedFields.length,
    conflicts: outcome.conflicts.length,
    withheld: withheld + outcome.requisiteChanges.length,
    untrusted: outcome.reason === 'untrusted_source',
  };
}
