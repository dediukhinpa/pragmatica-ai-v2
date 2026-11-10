import type { DealDocument } from '../../kit/domain/models';
import type { DocumentsDeps } from './deps';

/** Длина даты `ГГГГ-ММ-ДД` в ISO-строке момента. */
const ISO_DAY_LENGTH = 10;

/** Сегодняшняя дата `ГГГГ-ММ-ДД` по часам зависимостей, а не по системным. */
export function todayIso(deps: Pick<DocumentsDeps, 'clock'>): string {
  const now = deps.clock?.now() ?? new Date();
  return now.toISOString().slice(0, ISO_DAY_LENGTH);
}

/**
 * Документ с датой выпуска: пустая дата (сотрудник её не назвал) заменяется сегодняшней.
 * Исключение - договор: дату договора агент не присваивает (решение владельца, этап 152),
 * в файле на её месте маркер «[ЗАПОЛНИТЬ: дата договора]». Названную дату не трогает, даже
 * некорректную: её ловит проверка `bad_date`.
 */
export function withIssueDate(doc: DealDocument, deps: Pick<DocumentsDeps, 'clock'>): DealDocument {
  if (doc.kind === 'contract') return doc;
  return doc.issuedAt.trim() !== '' ? doc : { ...doc, issuedAt: todayIso(deps) };
}
