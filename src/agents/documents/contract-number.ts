import { z } from 'zod';
import { DomainError } from '@business-ai/core';
import { type ChecklistItem } from '../../kit/domain/supplier-document';
import { type DealDocument } from '../../kit/domain/models';
import { defineTool } from '@business-ai/core';
import { joinKey, requirePort } from '@business-ai/core';
import type { TurnInitiator } from '@business-ai/core';
import type { DocumentsDeps } from './deps';
import { CONTRACT_NUMBER_KEY_PREFIX, withPartyData } from './party-data';
import { documentFingerprint } from './fingerprint';
import { withContractDefaults } from './contract-defaults';
import { isoDay, parseDocumentDate, type RenderOptions } from './render-data';
import { todayIso, withIssueDate } from './issue-date';
import { withSignatory } from './signatory';
import { withTemplateBuyer } from './template-buyer';
import { withWorkingDayTerms } from './working-day-terms';
import { contractTemplateByPath, type ContractTemplate } from './template-registry';

/** Как получить номер: выдать новый или только найти уже выданный (без траты номера). */
export type ContractNumberMode = 'issue' | 'peek';

/** Что нужно для ключа операции: документ без номера, которым распоряжается модель. */
type NumberedDocument = Pick<
  DealDocument,
  'kind' | 'issuedAt' | 'supplierId' | 'seller' | 'requestId'
> &
  Partial<DealDocument>;

/** Номер выдаётся договору на поставку (готовая и контрактная продукция), не NDA. */
function needsSystemNumber(template: ContractTemplate | undefined): template is ContractTemplate {
  return template !== undefined && template.variant !== 'nda';
}

/** Метка года в ключе инструмента для нераспознанной даты. */
const UNDATED_KEY_YEAR = 'today';

/** Допустимое отклонение года номера от года часов (в годах): текущий ±1. */
const YEAR_TOLERANCE = 1;

/** Год номера и признак того, что дата документа не распознана и взята сегодняшняя. */
interface NumberYear {
  year: number;
  /** true: дата не распознана, год и дата номера - сегодняшние по часам. */
  fromToday: boolean;
}

/**
 * Год номера: год разобранной даты документа. Нераспознанная дата не блокирует выдачу номера
 * (принцип «не мешать сотруднику»): берётся сегодняшняя по часам, а пометка уходит в чек-лист.
 * Год распознанной даты вне диапазона «год часов ±1» - по-прежнему ошибка: это опечатка в годе,
 * а не пропуск, и номер чужого года испортил бы сквозную нумерацию.
 */
function numberYear(issuedAt: string, now: Date): NumberYear {
  const date = parseDocumentDate(issuedAt);
  const currentYear = now.getUTCFullYear();
  if (date === undefined) return { year: currentYear, fromToday: true };
  if (Math.abs(date.year - currentYear) > YEAR_TOLERANCE) {
    throw new DomainError(
      'validation_failed',
      `Год даты документа (${date.year}) вне допустимого диапазона для номера договора.`,
    );
  }
  return { year: date.year, fromToday: false };
}

/**
 * Ключ операции выдачи: поставщик, заявка (без заявки - дата документа), шаблон и год. Номер
 * в ключ не входит: модель не влияет на него, повтор того же заполнения даёт тот же номер.
 * Шаблон представлен своим id, а не путём: ключ не зависит от каталога шаблонов.
 */
function contractNumberOperationKey(
  doc: NumberedDocument,
  template: ContractTemplate,
  year: number | string,
): string {
  const date = parseDocumentDate(doc.issuedAt);
  const hasRequest = doc.requestId !== undefined && doc.requestId !== '';
  // Нераспознанная дата - метка, а не сырая строка: иначе другая формулировка того же
  // пропуска тратила бы новый номер.
  const scope = hasRequest
    ? `request:${doc.requestId}`
    : `date:${date === undefined ? UNDATED_KEY_YEAR : isoDay(date)}`;
  const hasSupplier = doc.supplierId !== undefined && doc.supplierId !== '';
  const owner = hasSupplier ? (doc.supplierId ?? '') : doc.seller;
  // Без поставщика, заявки и продавца ключ "шаблон+день" совпал бы у разных договоров и они
  // получили бы один номер. Различаем по содержимому; номер и id из отпечатка исключены, иначе
  // повтор после записи номера в документ получил бы новый. Дата тоже исключена: её
  // нормализованная форма уже в scope, а сырая формулировка пропуска ключ менять не должна.
  const needsContent = !hasSupplier && !hasRequest && owner === '' && isFullDocument(doc);
  const parts = needsContent
    ? [scope, `content:${documentFingerprint({ ...doc, number: '', issuedAt: '' })}`]
    : [scope];
  return joinKey(CONTRACT_NUMBER_KEY_PREFIX, owner, ...parts, template.id, year);
}

/** Целый документ (а не урезанные поля инструмента): отпечаток считается по всем полям. */
function isFullDocument(doc: NumberedDocument): doc is DealDocument {
  return Array.isArray(doc.lines) && typeof doc.id === 'string';
}

/** Дата договора `ГГГГ-ММ-ДД` для записи рядом с номером (нужна NDA); не дата - не пишем. */
function documentDay(issuedAt: string): string | undefined {
  const date = parseDocumentDate(issuedAt);
  return date === undefined ? undefined : isoDay(date);
}

/** Результат: параметры сборки (год, контакты) и документ с номером сотрудника как есть. */
export interface DocumentRenderContext {
  options: RenderOptions;
  document: DealDocument;
  /** Что подставила система без слов сотрудника: пункты для чек-листа на проверку. */
  notes: ChecklistItem[];
}

/** Дополнительные сведения о ходе для подстановки контактов сторон. */
export interface RenderContextExtras {
  /** Инициатор хода: автор запроса даёт запасной контакт «От Заказчика». */
  initiator?: TurnInitiator | undefined;
  /**
   * Подставлять ли контакты сторон и основной договор NDA (обращения к порталу и базе). Нужны
   * проверке полноты и сборке; выдаче одного номера - нет.
   */
  parties?: boolean | undefined;
}

/**
 * Параметры сборки документа, которые задаёт код: текущий год, подписант поставщика в
 * родительном падеже, контакты сторон. Номер и дату договора код НЕ присваивает (решение
 * владельца, этап 152): их называет сотрудник по реестру договоров, иначе в файле встанут
 * маркеры «[ЗАПОЛНИТЬ: …]». Счётчик `ContractNumbering` остаётся в порту, но агент им не
 * пользуется, поэтому `mode` сохранён только ради совместимости вызовов.
 */
export async function resolveRenderContext(
  rawInput: DealDocument,
  deps: DocumentsDeps,
  templatePath: string,
  _mode: ContractNumberMode,
  extras: RenderContextExtras = {},
): Promise<DocumentRenderContext> {
  // Дата договора без слов сотрудника остаётся пустой (маркер в файле); для прочих видов
  // документов пустая дата по-прежнему «сегодня».
  const input = withIssueDate(rawInput, deps);
  const template = contractTemplateByPath(templatePath, deps.templatesPrefix ?? '');
  // Покупатель по шаблону, подписант в родительном падеже и срок в рабочих днях задаёт код
  const signed = await withSignatory(withTemplateBuyer(input, deps, templatePath), deps);
  const timed = withWorkingDayTerms(signed, template?.id);
  // № и дата спецификации, № ТЗ и согласование гарантии: сотрудника этим не спрашиваем
  const defaults = withContractDefaults(timed, template);
  // Контакты сторон из карточки поставщика, менеджера сделки или автора запроса; номер и дата
  // основного договора NDA - из выданных поставщику номеров. Слова сотрудника главнее.
  const parties =
    extras.parties === true
      ? await withPartyData(defaults.document, deps, template, { initiator: extras.initiator })
      : { document: defaults.document, buyerContact: undefined, notes: [] };
  const doc = parties.document;
  const notes: ChecklistItem[] = [...defaults.notes, ...parties.notes];
  const buyerContact = parties.buyerContact;
  const now = deps.clock?.now() ?? new Date();
  const currentYear = now.getUTCFullYear();
  // Номер сотрудника уходит и в `number`, и в `contract_number` шаблона; пустой - маркер.
  const named = doc.number.trim();
  const contractNumber =
    doc.kind === 'contract' && needsSystemNumber(template) && named !== '' ? named : undefined;
  return { options: { currentYear, contractNumber, buyerContact }, document: doc, notes };
}

interface IssueNumberInput {
  templatePath: string;
  supplierId: string;
  requestId?: string | undefined;
  issuedAt: string;
}
interface IssueNumberOutput {
  /** Номер договора `<ПРЕФИКС>-<ГОД>-<NNNN>`: впиши его в document.number. */
  number: string;
}

const issueNumberSchema = z.object({
  templatePath: z.string().min(1),
  supplierId: z.string().min(1),
  requestId: z.string().min(1).optional(),
  issuedAt: z.string().min(1),
});

/**
 * Шаблон по имени файла, без привязки к каталогу: ключ не знает `templatesPrefix`, а допуск
 * пути с каталогом проверяет `execute`. Не найден - ошибка валидации, а не усечённый ключ.
 */
function templateForKey(templatePath: string): ContractTemplate {
  const fileName = templatePath.replaceAll('\\', '/').split('/').pop() ?? '';
  const template = contractTemplateByPath(fileName);
  if (template === undefined) {
    throw new DomainError('validation_failed', 'Шаблон договора не найден в реестре.');
  }
  return template;
}

/** Ключ идемпотентности инструмента совпадает с ключом операции выдачи. */
function issueKey(input: IssueNumberInput): string {
  const date = parseDocumentDate(input.issuedAt);
  // Год нераспознанной даты ключ не знает (часов у него нет): метка вместо года, повтор в
  // том же треде всё равно даст тот же номер, а счётчик защищён ключом операции порта.
  return contractNumberOperationKey(
    { kind: 'contract', seller: '', ...input },
    templateForKey(input.templatePath),
    date === undefined ? UNDATED_KEY_YEAR : date.year,
  );
}

/**
 * Выдать номер договора из счётчика. С этапа 152 в набор инструментов агента не входит (номер
 * называет сотрудник по реестру договоров); оставлен вместе с портом и миграцией 040.
 */
export const issueContractNumber = defineTool<IssueNumberInput, IssueNumberOutput, DocumentsDeps>({
  name: 'issueContractNumber',
  description:
    'Получить номер договора от системы (формат МГ-2026-0007 или ПР-2026-0007). Номер ' +
    'присваивает система по сквозному счётчику года для обоих юрлиц; не спрашивай его у сотрудника и не ' +
    'придумывай. Повтор для той же заявки, поставщика и шаблона вернёт тот же номер. ' +
    'Впиши результат в document.number; при сборке система подставит номер сама.',
  sideEffect: true,
  // Повтор с любой формулировкой вернёт тот же номер: ключ операции не зависит от модели.
  replay: 'safe',
  inputSchema: issueNumberSchema,
  outputSchema: z.object({ number: z.string() }),
  idempotencyKey: issueKey,
  async execute(input, deps) {
    const template = contractTemplateByPath(input.templatePath, deps.templatesPrefix ?? '');
    if (!needsSystemNumber(template)) {
      throw new DomainError(
        'validation_failed',
        'Номер системы выдаётся только договорам на поставку; для этого шаблона его нет.',
      );
    }
    if ((await deps.suppliers.get(input.supplierId)) === null) {
      throw new DomainError('validation_failed', 'Поставщик не найден: номер не выдан.');
    }
    const now = deps.clock?.now() ?? new Date();
    const { year } = numberYear(input.issuedAt, now);
    const issued = await requirePort(deps.contractNumbering, 'нумерация договоров').issue({
      operationKey: contractNumberOperationKey(
        { kind: 'contract', seller: '', ...input },
        template,
        year,
      ),
      legalEntity: template.entity,
      year,
      documentDate: documentDay(input.issuedAt) ?? todayIso(deps),
    });
    return { number: issued.number };
  },
});
