import { ContractAmendRefusedError, OwnSignatoryRefusedError } from '../../domain/errors.owned';
import type {
  AmendContractRequest,
  AmendedContract,
  ClassifyContractRequest,
  ContractAmender,
  ContractKindResult,
  ConvertedFrom,
  OwnRequisites,
  OwnSignatoryForms,
  ReplaceSignatoryResult,
} from '../../ports/contract-amender';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
/** Заголовок блока нашей стороны в тексте заглушки. */
const CUSTOMER_HEADING = 'Заказчик:';
/** Заголовок блока исполнителя в тексте заглушки. */
const EXECUTOR_HEADING = 'Исполнитель:';
/** Метка собранного нами документа в тексте заглушки (в сервисе - свойство файла). */
export const MEMORY_OWN_DOCUMENT_MARKER = '[наш документ]';
/** Расширения, которые сервис конвертирует в docx, и формат-источник для ответа. */
const CONVERTED_EXTENSIONS: Readonly<Record<string, ConvertedFrom>> = {
  '.doc': 'doc',
  '.rtf': 'rtf',
};
/** Доли совпадения с шаблоном, как в сервисе: «наш документ» и «частично сходный». */
const OWN_COVERAGE = 0.6;
const PARTIAL_COVERAGE = 0.25;
/** Строки короче не считаются отпечатком шаблона. */
const MIN_FINGERPRINT_CHARS = 20;

const CAP = '[А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?';
const INIT = '[А-ЯЁ]\\.\\s?[А-ЯЁ]\\.';
const SHORT = `${CAP}\\s+${INIT}`;
const FULL = `${CAP}\\s+${CAP}\\s+${CAP}`;
/** Якоря подписанта в тексте заглушки (те же, что в сервисе документов). */
const GENITIVE_ANCHOR = new RegExp(`в\\s+лице\\s+(?:[а-яё]+\\s+){1,4}(${FULL}|${SHORT})\\s*,?\\s*действующ`, 'gu');
const SIGNATURE_ANCHOR = new RegExp(`(?:[Гг]енеральный\\s+директор|[Дд]иректор)[\\s_/]*(${SHORT})`, 'gu');
const REVERSED = new RegExp(`(${INIT}\\s*${CAP})`, 'gu');
const MIN_STEM = 3;
const STEM_TAIL = 2;

interface SignatoryHit {
  start: number;
  end: number;
  kind: keyof OwnSignatoryForms;
  surname: string;
  initials: string;
}

function surnameAndInitials(name: string): { surname: string; initials: string } {
  const words = name.match(/[А-ЯЁа-яё][А-ЯЁа-яё-]*/gu) ?? [];
  const long = words.filter((word) => word.length > 1);
  const singles = words.filter((word) => word.length === 1).join('');
  const surname = long[0] ?? '';
  if (long.length >= 3) return { surname, initials: long.slice(1, 3).map((w) => w[0]).join('') };
  return { surname, initials: singles };
}

function samePerson(
  left: { surname: string; initials: string },
  right: { surname: string; initials: string },
): boolean {
  if (left.initials !== right.initials) return false;
  const a = left.surname.toLowerCase();
  const b = right.surname.toLowerCase();
  let common = 0;
  while (common < Math.min(a.length, b.length) && a[common] === b[common]) common += 1;
  return common >= Math.max(MIN_STEM, Math.min(a.length, b.length) - STEM_TAIL);
}

const squash = (text: string): string => text.replace(/\s+/gu, '');

function extensionOf(fileName: string): string {
  const index = fileName.lastIndexOf('.');
  return index < 0 ? '' : fileName.slice(index).toLowerCase();
}

function convertedFromName(fileName: string): ConvertedFrom | null {
  return CONVERTED_EXTENSIONS[extensionOf(fileName)] ?? null;
}

function linesOf(bytes: Uint8Array): string[] {
  return new TextDecoder().decode(bytes).split('\n');
}

/** Строки блока: после заголовка до пустой строки или до заголовка другой стороны. */
function blockAfter(lines: readonly string[], heading: string): string[] {
  const index = lines.findIndex((line) => line.trim() === heading);
  if (index < 0) return [];
  const block: string[] = [];
  for (const line of lines.slice(index + 1)) {
    const text = line.trim();
    if (text === '' || text === CUSTOMER_HEADING || text === EXECUTOR_HEADING) break;
    block.push(text);
  }
  return block;
}

/**
 * Заглушка дополнения договора для тестов: «договор» - обычный текст. Под строкой «Заказчик:»
 * (если после неё нет текста) добавляются наши строки; номер договора не меняется никогда.
 * Файлы .doc и RTF «конвертируются» заменой имени на .docx. Настоящая правка docx, конвертация и
 * сверка текста исполнителя - в сервисе.
 */
export class MemoryContractAmender implements ContractAmender {
  async amend(request: AmendContractRequest): Promise<AmendedContract> {
    const convertedFrom = convertedFromName(request.fileName);
    if (convertedFrom === null && extensionOf(request.fileName) !== '.docx') {
      throw new ContractAmendRefusedError('unsupported_format');
    }
    const lines = linesOf(request.bytes);
    const index = lines.findIndex((line) => line.trim() === CUSTOMER_HEADING);
    if (index < 0) throw new ContractAmendRefusedError('customer_block_not_found');
    if ((lines[index + 1] ?? '').trim() !== '') {
      throw new ContractAmendRefusedError('customer_block_filled');
    }
    const { name, lines: ownLines } = request.own;
    const own = [name, ...ownLines.filter((line) => line !== name)];
    lines.splice(index + 1, 0, ...own);
    return {
      fileName:
        convertedFrom === null
          ? request.fileName
          : `${request.fileName.slice(0, request.fileName.lastIndexOf('.'))}.docx`,
      mimeType: DOCX_MIME,
      bytes: new TextEncoder().encode(lines.join('\n')),
      convertedFrom,
      preambleFilled: false,
      customerBlockFilled: true,
      placeholdersFilled: 0,
      linesAdded: own.length,
      unfilledPlaceholders: 0,
      notes: [],
    };
  }

  /**
   * Признак «договор поставщика» в тексте заглушки. Наш документ - метка в тексте либо
   * совпадение строк с шаблонами; исполнитель заполнен - в блоке «Исполнитель:» есть строки;
   * наши данные в блоке исполнителя - наша сторона исполнитель. Шаблонов нет - неоднозначно.
   */
  async classify(request: ClassifyContractRequest): Promise<ContractKindResult> {
    const convertedFrom = convertedFromName(request.fileName);
    if (convertedFrom === null && extensionOf(request.fileName) !== '.docx') {
      throw new ContractAmendRefusedError('unsupported_format');
    }
    const lines = linesOf(request.bytes).map((line) => line.trim());
    const result = (verdict: ContractKindResult['verdict'], ...reasons: string[]) => ({
      verdict,
      reasons,
      convertedFrom,
    });
    if (lines.includes(MEMORY_OWN_DOCUMENT_MARKER)) return result('own_template', 'own_marker');
    const fingerprint = new Set(
      request.templates
        .flatMap(linesOf)
        .map((line) => line.trim())
        .filter((line) => line.length >= MIN_FINGERPRINT_CHARS),
    );
    const found = lines.filter((line) => fingerprint.has(line));
    const coverage = fingerprint.size === 0 ? undefined : new Set(found).size / fingerprint.size;
    if (coverage !== undefined && coverage >= OWN_COVERAGE) {
      return result('own_template', 'template_match');
    }
    const executor = blockAfter(lines, EXECUTOR_HEADING);
    if (request.ownInns.some((inn) => executor.some((line) => line.includes(inn)))) {
      return result('our_side_executor', 'our_data_in_executor_block');
    }
    if (coverage === undefined) return result('unclear', 'templates_unavailable');
    if (coverage >= PARTIAL_COVERAGE) return result('unclear', 'template_partial_match');
    return executor.length > 0
      ? result('supplier', 'executor_text')
      : result('unclear', 'executor_not_filled');
  }

  /**
   * Подстановка подписанта в тексте заглушки: те же якоря и проверки, что в сервисе документов
   * (`services/documents/documents/docx_signatory.py`), только по строкам текста.
   */
  async replaceSignatory(request: {
    bytes: Uint8Array;
    forms: OwnSignatoryForms;
    signal?: AbortSignal | undefined;
  }): Promise<ReplaceSignatoryResult> {
    const lines = linesOf(request.bytes);
    const found: Array<SignatoryHit & { line: number }> = [];
    lines.forEach((text, line) => {
      const push = (match: RegExpMatchArray, kind: keyof OwnSignatoryForms): void => {
        const name = match[1] ?? '';
        const start = (match.index ?? 0) + match[0].lastIndexOf(name);
        found.push({ line, start, end: start + name.length, kind, ...surnameAndInitials(name) });
      };
      for (const match of text.matchAll(GENITIVE_ANCHOR)) {
        push(match, /[А-ЯЁ]\./u.test(match[1] ?? '') ? 'genitiveShort' : 'genitiveFull');
      }
      for (const match of text.matchAll(SIGNATURE_ANCHOR)) push(match, 'nominativeShort');
    });
    const reference = found[0];
    if (reference === undefined) throw new OwnSignatoryRefusedError('signatory_not_found');
    if (found.some((hit) => !samePerson(hit, reference))) {
      throw new OwnSignatoryRefusedError('signatory_inconsistent');
    }
    lines.forEach((text, line) => {
      for (const match of text.matchAll(REVERSED)) {
        const name = match[1] ?? '';
        const parts = surnameAndInitials(name);
        if (!samePerson(parts, reference)) continue;
        const start = match.index ?? 0;
        found.push({ line, start, end: start + name.length, kind: 'nominativeReversed', ...parts });
      }
    });
    const changes = found.filter(
      (hit) =>
        squash((lines[hit.line] ?? '').slice(hit.start, hit.end)) !==
        squash(request.forms[hit.kind]),
    );
    if (changes.length === 0) {
      return { bytes: request.bytes, found: found.length, replaced: 0, unchanged: true };
    }
    for (const hit of [...changes].sort((a, b) => b.line - a.line || b.start - a.start)) {
      const text = lines[hit.line] ?? '';
      lines[hit.line] = text.slice(0, hit.start) + request.forms[hit.kind] + text.slice(hit.end);
    }
    const newSurname = surnameAndInitials(request.forms.nominativeShort);
    const stem = reference.surname
      .toLowerCase()
      .slice(0, Math.max(MIN_STEM, reference.surname.length - STEM_TAIL));
    if (!samePerson({ surname: reference.surname, initials: newSurname.initials }, newSurname)) {
      const left = lines.some((text) =>
        (text.match(/[А-ЯЁа-яё][А-ЯЁа-яё-]*/gu) ?? []).some((word) =>
          word.toLowerCase().startsWith(stem),
        ),
      );
      if (left) throw new OwnSignatoryRefusedError('signatory_left');
    }
    return {
      bytes: new TextEncoder().encode(lines.join('\n')),
      found: found.length,
      replaced: changes.length,
      unchanged: false,
    };
  }

  async readPartyBlock(request: {
    bytes: Uint8Array;
    role: string;
    signal?: AbortSignal | undefined;
  }): Promise<OwnRequisites> {
    const block = blockAfter(linesOf(request.bytes), `${request.role}:`);
    const [name] = block;
    if (name === undefined) throw new ContractAmendRefusedError('customer_block_not_found');
    return { name, lines: block };
  }
}
