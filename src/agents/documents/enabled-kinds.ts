import { DOCUMENT_KINDS, type DocumentKind } from '../../kit/domain/models';
import type { DocumentsDeps } from './deps';

/** Название вида для сообщений сотруднику и приветствия (NDA - вариант шаблона договора). */
const KIND_PLURAL: Readonly<Record<DocumentKind, string>> = {
  commercial_offer: 'коммерческие предложения',
  invoice: 'счета',
  contract: 'договоры и NDA',
  closing: 'закрывающие документы',
};

/**
 * Виды документов, которые агент готовит сейчас (`DOCUMENTS_ENABLED_KINDS`). Не задано - все
 * виды, поведение прежнее. Порядок всегда как в `DOCUMENT_KINDS`, независимо от порядка в env.
 */
export function enabledKindsOf(list: readonly DocumentKind[] | undefined): readonly DocumentKind[] {
  if (list === undefined) return DOCUMENT_KINDS;
  return DOCUMENT_KINDS.filter((kind) => list.includes(kind));
}

/** Включены все виды документов: промпт и приветствие остаются прежними. */
export function allKindsEnabled(kinds: readonly DocumentKind[]): boolean {
  return DOCUMENT_KINDS.every((kind) => kinds.includes(kind));
}

/** Перечень включённых видов словами: «договоры и NDA», «счета и договоры и NDA». */
export function kindsText(kinds: readonly DocumentKind[]): string {
  return kinds.map((kind) => KIND_PLURAL[kind]).join(', ');
}

/**
 * Сообщение об отказе для выключенного вида; `undefined`, если вид включён. Проверка кодом,
 * а не схемой: схема инструмента не зависит от флага.
 */
export function disabledKindMessage(
  deps: Pick<DocumentsDeps, 'enabledKinds'>,
  kind: DocumentKind,
): string | undefined {
  const kinds = enabledKindsOf(deps.enabledKinds);
  if (kinds.includes(kind)) return undefined;
  return `Сейчас агент готовит только ${kindsText(kinds)}: этот вид документа отключён.`;
}
