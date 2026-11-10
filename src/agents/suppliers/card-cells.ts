import {
  DOCUMENT_FLOW_LABELS,
  PACKAGING_KIND_LABELS,
  PACKAGING_PRICING_LABELS,
  SUPPLIER_KIND_LABELS,
  TRAINING_FORMAT_LABELS,
  type MaterialKind,
} from '../../kit/domain/supplier-card-full';
import { SUPPLIER_STATUS_LABELS, type SupplierCard } from '../../kit/domain/supplier-card';
import { VAT_MODE_LABELS } from '../../kit/domain/supplier-card-values';
import type { TableCell } from '@business-ai/core';
import type { SupplierColumnKey } from './supplier-template';

/**
 * Значение колонки шаблона по карточке (этап 215): обратное к разбору файла-шаблона. Формат
 * ячеек тот же, что принимает загрузка пачкой (`parseExtraRowFields`), поэтому выгруженный файл
 * можно загрузить обратно. Пустое значение - `null` (пустая ячейка).
 */

/** Разделитель пунктов в ячейке-перечне: тот же, что разбирает загрузка. */
const ITEM_SEPARATOR = '; ';
const YES_TEXT = 'да';
const NO_TEXT = 'нет';
/** Предел Excel на длину текста в ячейке: длиннее файл не откроется. */
const EXCEL_CELL_MAX_CHARS = 32_000;

type CellReader = (card: SupplierCard) => TableCell;

/** Текст или пусто: пустая строка тоже «не указано». */
function text(value: string | undefined): TableCell {
  return value === undefined || value.trim() === '' ? null : value;
}

function list(values: readonly string[] | undefined): TableCell {
  const items = (values ?? []).filter((item) => item.trim() !== '');
  return items.length === 0 ? null : items.join(ITEM_SEPARATOR);
}

function yesNo(value: boolean | undefined): TableCell {
  if (value === undefined) return null;
  return value ? YES_TEXT : NO_TEXT;
}

function label<K extends string>(
  labels: Readonly<Record<K, string>>,
  value: K | undefined,
): TableCell {
  return value === undefined ? null : labels[value];
}

/** Основной контакт: помеченный, иначе первый (одна строка файла - один контакт). */
function primaryContact(card: SupplierCard): SupplierCard['contacts'][number] | undefined {
  return card.contacts.find((contact) => contact.isPrimary) ?? card.contacts[0];
}

function materialRefs(card: SupplierCard, kind: MaterialKind): TableCell {
  return list((card.materials ?? []).filter((item) => item.kind === kind).map((item) => item.ref));
}

/** НДС как в шаблоне: ставка числом, «без НДС» или «с НДС», если ставка не названа. */
function vatCell(card: SupplierCard): TableCell {
  if (card.vatMode === undefined) return null;
  if (card.vatMode === 'no_vat') return VAT_MODE_LABELS.no_vat;
  return card.vatRatePercent ?? VAT_MODE_LABELS.with_vat;
}

/** Оборот как в шаблоне: «год: сумма» через «;», либо одна сумма без года. */
function turnoverCell(card: SupplierCard): TableCell {
  const years = card.turnoverByYear ?? [];
  if (years.length > 0) {
    return years.map((item) => `${item.year}: ${item.rub}`).join(ITEM_SEPARATOR);
  }
  return card.turnoverRub ?? null;
}

function legalEntitiesCell(card: SupplierCard): TableCell {
  return list(
    (card.legalEntities ?? []).map((entity) =>
      entity.inn === undefined ? entity.name : `${entity.name} ${entity.inn}`,
    ),
  );
}

/** Правило чтения для каждой колонки шаблона; новая колонка без правила не соберётся. */
const READERS: Readonly<Record<SupplierColumnKey, CellReader>> = {
  name: (card) => card.name,
  logoRef: (card) => text(card.logoRef),
  supplierKind: (card) => label(SUPPLIER_KIND_LABELS, card.supplierKind),
  status: (card) => SUPPLIER_STATUS_LABELS[card.status],
  inn: (card) => text(card.inn),
  kpp: (card) => text(card.kpp),
  ogrn: (card) => text(card.ogrn),
  legalAddress: (card) => text(card.legalAddress),
  bankName: (card) => text(card.bankName),
  bik: (card) => text(card.bik),
  settlementAccount: (card) => text(card.settlementAccount),
  correspondentAccount: (card) => text(card.correspondentAccount),
  directorName: (card) => text(card.directorName),
  foundedYear: (card) => card.foundedYear ?? null,
  website: (card) => text(card.website),
  contactName: (card) => text(primaryContact(card)?.fullName),
  contactPosition: (card) => text(primaryContact(card)?.position),
  phone: (card) => text(primaryContact(card)?.phone),
  email: (card) => text(primaryContact(card)?.email),
  messenger: (card) => text(primaryContact(card)?.messenger),
  agencyDiscount: (card) => card.agencyDiscountPercent ?? null,
  discounts: (card) => text(card.terms.discounts),
  minOrderAmount: (card) => text(card.minOrderAmount),
  minBatch: (card) => text(card.terms.minBatch),
  samplesAvailable: (card) => yesNo(card.samplesAvailable),
  samplesQuantity: (card) => card.samplesQuantity ?? null,
  samplesTerms: (card) => text(card.samplesTerms),
  payment: (card) => text(card.terms.payment),
  paymentNotes: (card) => text(card.paymentNotes),
  vat: vatCell,
  leadTime: (card) => text(card.terms.leadTime),
  delivery: (card) => text(card.terms.delivery),
  freeDelivery: (card) => text(card.freeDelivery),
  documentFlow: (card) => label(DOCUMENT_FLOW_LABELS, card.documentFlow),
  contractNotes: (card) => text(card.contractNotes),
  legalEntities: legalEntitiesCell,
  categories: (card) => list(card.supplies.categories),
  brands: (card) => list(card.supplies.brands),
  regions: (card) => list(card.supplies.regions),
  packaging: (card) => label(PACKAGING_KIND_LABELS, card.packaging),
  packagingPricing: (card) => label(PACKAGING_PRICING_LABELS, card.packagingPricing),
  technologies: (card) => list(card.technologies),
  personalizationTypes: (card) => list(card.personalizationTypes),
  presentations: (card) => materialRefs(card, 'presentation'),
  portfolioLinks: (card) => materialRefs(card, 'portfolio'),
  technicalRequirements: (card) => text(card.technicalRequirements),
  pragmatikaPortfolio: (card) => text(card.pragmatikaPortfolio),
  productionCity: (card) => text(card.productionCity),
  address: (card) => text(card.address),
  transportInfo: (card) => text(card.transportInfo),
  marketingSupport: (card) => text(card.marketingSupport),
  trainingFormats: (card) =>
    list((card.trainingFormats ?? []).map((format) => TRAINING_FORMAT_LABELS[format])),
  exclusivity: (card) => text(card.exclusivity),
  hasOwnDesigners: (card) => yesNo(card.hasOwnDesigners),
  designServices: (card) => text(card.designServices),
  hasQualityControl: (card) => yesNo(card.hasQualityControl),
  additionalServices: (card) => text(card.additionalServices),
  strengths: (card) => text(card.strengths),
  weaknesses: (card) => text(card.weaknesses),
  defectRatePercent: (card) => card.defectRatePercent ?? null,
  claimsHandling: (card) => text(card.claimsHandling),
  competitiveAdvantages: (card) => text(card.competitiveAdvantages),
  customers: (card) => text(card.customers),
  turnover: turnoverCell,
  okved: (card) => text(card.okved),
  employeeCount: (card) => card.employeeCount ?? null,
  note: (card) => list(card.notes.map((note) => note.text)),
};

/**
 * Значение колонки шаблона для карточки. Текст длиннее предела Excel обрезается, чтобы файл
 * открылся; остальное значение не меняется.
 */
export function cardCellValue(card: SupplierCard, key: SupplierColumnKey): TableCell {
  const value = READERS[key](card);
  return typeof value === 'string' ? value.slice(0, EXCEL_CELL_MAX_CHARS) : value;
}
