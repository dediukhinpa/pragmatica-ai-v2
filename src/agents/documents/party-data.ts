import { primaryContact, supplierFromCard } from '../../kit/domain/supplier-card';
import { type ChecklistItem } from '../../kit/domain/supplier-document';
import { type DealDocument } from '../../kit/domain/models';
import type { TurnInitiator } from '@business-ai/core';
import { findBuyerContact, type BuyerContactSource } from './buyer-contact';
import type { DocumentsDeps } from './deps';
import { isoDay, parseDocumentDate } from './render-data';
import type { ContractTemplate } from './template-registry';
import { joinKey } from '@business-ai/core';

/** Префикс ключей номеров договоров (см. `contractNumberOperationKey`). */
export const CONTRACT_NUMBER_KEY_PREFIX = 'contract-number';

const SELLER_NAME_LABEL = 'seller_contactName';
const SELLER_PHONE_LABEL = 'seller_phone';
const SELLER_EMAIL_LABEL = 'seller_email';
const NDA_NUMBER_LABEL = 'contract_number';
const NDA_DATE_LABEL = 'contract_date';
const SELLER_CONTACT_LABELS = [SELLER_NAME_LABEL, SELLER_PHONE_LABEL, SELLER_EMAIL_LABEL];
const BUYER_CONTACT_LABELS = ['buyer_contact_name', 'buyer_contact_phone', 'buyer_contact_email'];

const SOURCE_SUPPLIER_CARD = 'карточка поставщика в базе';
const BUYER_SOURCES: Readonly<Record<BuyerContactSource, string>> = {
  deal_manager: 'менеджер сделки по заявке (портал); сверьте, что это нужный человек',
  requester: 'профиль сотрудника, запросившего документ (портал); менеджера сделки нет',
};
const NDA_SOURCE =
  'последний договор, который система выдала этому поставщику (номер и дата); ' +
  'проверьте, что соглашение относится именно к нему';

/** Что нужно знать о том, кто и где просит документ. */
export interface PartyLookup {
  /** Инициатор хода: автор запроса; плановые и системные ходы запасного пути не имеют. */
  initiator?: TurnInitiator | undefined;
}

/** Результат: документ с подставленными полями, контакт менеджера и пункты чек-листа. */
export interface PartyData {
  document: DealDocument;
  /** Контакт менеджера сделки: значение кода главнее слов сотрудника (как раньше). */
  buyerContact?: Readonly<Record<string, string>> | undefined;
  notes: ChecklistItem[];
}

/** Поле шаблона не названо сотрудником. */
function isBlank(doc: DealDocument, label: string): boolean {
  return (doc.templateFields?.[label] ?? '').trim() === '';
}

/** Добавить в документ поля шаблона с отметкой источника «система». */
function withFields(doc: DealDocument, added: Readonly<Record<string, string>>): DealDocument {
  if (Object.keys(added).length === 0) return doc;
  const marks = Object.fromEntries(
    Object.keys(added).map((label) => [`templateFields.${label}`, 'knowledge' as const]),
  );
  return {
    ...doc,
    templateFields: { ...doc.templateFields, ...added },
    fieldSources: { ...doc.fieldSources, ...marks },
  };
}

/** Человеческий список подставленных полей контакта (без значений: это персональные данные). */
function contactFieldsText(labels: readonly string[], found: readonly string[]): string {
  const names: Record<string, string> = {
    [SELLER_NAME_LABEL]: 'ФИО',
    [SELLER_PHONE_LABEL]: 'телефон',
    [SELLER_EMAIL_LABEL]: 'e-mail',
    buyer_contact_name: 'ФИО',
    buyer_contact_phone: 'телефон',
    buyer_contact_email: 'e-mail',
  };
  return labels
    .filter((label) => found.includes(label))
    .map((label) => names[label] ?? label)
    .join(', ');
}

/**
 * Контакт «От Исполнителя/Поставщика» из карточки поставщика документа: основной контакт
 * карточки, а при его отсутствии - прежняя запись поставщика. Только найденные поля.
 */
async function sellerContact(
  doc: DealDocument,
  deps: DocumentsDeps,
): Promise<Record<string, string>> {
  if (doc.supplierId === undefined) return {};
  const card = await deps.suppliers.getCard(doc.supplierId);
  const supplier = card === null ? await deps.suppliers.get(doc.supplierId) : supplierFromCard(card);
  const main = card === null ? undefined : primaryContact(card.contacts);
  const name = main?.fullName ?? supplier?.contactName;
  const email = main?.email ?? supplier?.email;
  const phone = main?.phone;
  const clean = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    return trimmed === undefined || trimmed === '' ? undefined : trimmed;
  };
  const values: Record<string, string | undefined> = {
    [SELLER_NAME_LABEL]: clean(name),
    [SELLER_PHONE_LABEL]: clean(phone),
    [SELLER_EMAIL_LABEL]: clean(email),
  };
  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

/** Префикс ключей номеров договоров поставщика. */
export function supplierNumberKeyPrefix(supplierId: string): string {
  return `${joinKey(CONTRACT_NUMBER_KEY_PREFIX, supplierId)}:`;
}

/** Читаемая дата `ДД.ММ.ГГГГ` для чек-листа; нераспознанная возвращается как есть. */
function ruDate(iso: string): string {
  const date = parseDocumentDate(iso);
  if (date === undefined) return iso;
  const [year, month, day] = isoDay(date).split('-');
  return `${day}.${month}.${year}`;
}

/** NDA: номер и дата основного договора из последнего номера, выданного поставщику. */
async function ndaMainContract(
  doc: DealDocument,
  deps: DocumentsDeps,
  template: ContractTemplate,
): Promise<PartyData | undefined> {
  if (deps.contractNumbering === undefined || doc.supplierId === undefined) return undefined;
  // Только когда сотрудник не назвал ни номер, ни дату: смешивать нельзя - разные договоры.
  if (!isBlank(doc, NDA_NUMBER_LABEL) || !isBlank(doc, NDA_DATE_LABEL)) return undefined;
  const latest = await deps.contractNumbering.findLatest(
    supplierNumberKeyPrefix(doc.supplierId),
    template.entity,
  );
  if (latest === null) return undefined;
  return {
    document: withFields(doc, {
      [NDA_NUMBER_LABEL]: latest.number,
      [NDA_DATE_LABEL]: latest.documentDate,
    }),
    notes: [
      {
        topic: 'terms',
        label: 'Основной договор для NDA',
        value: `${latest.number} от ${ruDate(latest.documentDate)}`,
        source: NDA_SOURCE,
      },
    ],
  };
}

/**
 * Стороны и основной договор из данных системы: «От Исполнителя» - карточка поставщика,
 * «От Заказчика» - менеджер сделки, затем автор запроса; NDA - последний выданный поставщику
 * номер договора. Слова сотрудника главнее (подставляется только пустое), за исключением
 * менеджера сделки (его значение код ставил главнее и раньше). Чего нет - спросят у сотрудника.
 */
export async function withPartyData(
  input: DealDocument,
  deps: DocumentsDeps,
  template: ContractTemplate | undefined,
  lookup: PartyLookup,
): Promise<PartyData> {
  if (input.kind !== 'contract' || template === undefined) return { document: input, notes: [] };
  if (template.variant === 'nda') {
    return (await ndaMainContract(input, deps, template)) ?? { document: input, notes: [] };
  }
  const notes: ChecklistItem[] = [];
  const seller = await sellerContact(input, deps);
  const sellerAdded = Object.fromEntries(
    Object.entries(seller).filter(([label]) => isBlank(input, label)),
  );
  let doc = withFields(input, sellerAdded);
  const sellerFound = Object.keys(sellerAdded);
  if (sellerFound.length > 0) {
    notes.push({
      topic: 'requisites',
      label: 'Контакт «От Исполнителя/Поставщика»',
      value: contactFieldsText(SELLER_CONTACT_LABELS, sellerFound),
      source: SOURCE_SUPPLIER_CARD,
    });
  }
  const buyer = await findBuyerContact(input, deps, lookup.initiator);
  if (buyer === undefined) return { document: doc, notes };
  const found = Object.keys(buyer.values);
  notes.push({
    topic: 'requisites',
    label: 'Контакт «От Заказчика»',
    value: contactFieldsText(BUYER_CONTACT_LABELS, found),
    source: BUYER_SOURCES[buyer.source],
  });
  if (buyer.source === 'deal_manager') return { document: doc, buyerContact: buyer.values, notes };
  // Автор запроса - запасной путь: слова сотрудника его перекрывают
  doc = withFields(
    doc,
    Object.fromEntries(Object.entries(buyer.values).filter(([label]) => isBlank(doc, label))),
  );
  return { document: doc, notes };
}
