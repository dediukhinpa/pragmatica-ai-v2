/** Юрлицо заказчика, от имени которого составлен шаблон. */
type TemplateEntity = 'mg' | 'pr';

/** Вид шаблона: готовая продукция, контрактная продукция или соглашение о неразглашении. */
type TemplateVariant = 'ready' | 'contract' | 'nda';

/** Запись реестра шаблонов договоров и NDA. */
export interface ContractTemplate {
  /** Стабильный ключ шаблона (не зависит от имени файла). */
  id: string;
  /** Имя файла на шаре, как лежит в каталоге шаблонов (кириллица и пробелы сохранены). */
  fileName: string;
  /** Название для сотрудника. */
  title: string;
  entity: TemplateEntity;
  variant: TemplateVariant;
}

/** Реестр пяти шаблонов (юрлицо × вид, плюс NDA «Мастер Гифтс»). */
export const CONTRACT_TEMPLATES: readonly ContractTemplate[] = [
  {
    id: 'mg_ready',
    fileName: '2026_МГ_Шаблон_Договора_на_поставку_готовой_продукции.docx',
    title: 'Договор «Мастер Гифтс» на поставку готовой продукции',
    entity: 'mg',
    variant: 'ready',
  },
  {
    id: 'mg_contract',
    fileName: '2026_МГ_Шаблон_Договора_на_поставку_контрактной_продукции.docx',
    title: 'Договор «Мастер Гифтс» на поставку контрактной продукции',
    entity: 'mg',
    variant: 'contract',
  },
  {
    id: 'mg_nda',
    fileName: 'МГ Соглашение NDA.docx',
    title: 'Соглашение о неразглашении (NDA) «Мастер Гифтс»',
    entity: 'mg',
    variant: 'nda',
  },
  {
    id: 'pr_ready',
    fileName: 'Шаблон_ПР_Договора_на_поставку_готовой_продукции.docx',
    title: 'Договор «Прагматика» на поставку готовой продукции',
    entity: 'pr',
    variant: 'ready',
  },
  {
    id: 'pr_contract',
    fileName: 'Шаблон_ПР_Договора_на_поставку_контрактной_продукции.docx',
    title: 'Договор «Прагматика» на поставку контрактной продукции',
    entity: 'pr',
    variant: 'contract',
  },
];

/** Имена файлов реестра: значение для DOCUMENT_TEMPLATE_ALLOWLIST (через запятую). */
export function contractTemplateFileNames(): string[] {
  return CONTRACT_TEMPLATES.map((template) => template.fileName);
}

/**
 * Признаки фразы сотрудника. Короткие слова сверяются как целое слово («мг», «пр»), длинные
 * основы - как начало слова или фраза целиком. Вхождения написаны в нижнем регистре, «ё» → «е».
 */
const ENTITY_WORDS: Readonly<Record<TemplateEntity, readonly string[]>> = {
  mg: ['мг'],
  pr: ['пр'],
};
const ENTITY_STEMS: Readonly<Record<TemplateEntity, readonly string[]>> = {
  mg: ['мастер гифт', 'мастергифт', 'master gift'],
  pr: ['прагматик', 'pragmatik'],
};
/**
 * «Готовая продукция» только в этой форме: «готов подписать» вида не называет. Слово
 * «готов...» и следом основа «продукц...».
 */
const READY_PHRASE = /(?:^| )готов\p{L}* продукц/u;
const CONTRACT_STEMS: readonly string[] = ['контракт'];
/**
 * Соглашение о неразглашении. «NDA» и «НДА» - целые слова; «соглашение о неразглашении»
 * узнаётся по основе «неразглаш», а голое «соглашение» («дополнительное соглашение») - нет.
 */
const NDA_WORDS: readonly string[] = ['nda', 'нда'];
const NDA_STEMS: readonly string[] = ['неразглаш', 'конфиденц'];
/** Договор на поставку: исключает NDA, если вид продукции не назван. */
const SUPPLY_STEMS: readonly string[] = ['договор', 'поставк'];

/** Результат выбора шаблона по фразе сотрудника. */
export type TemplateMatch =
  | {
      status: 'unique';
      template: ContractTemplate;
      /** Шаблон выбран по словам, а не по названию файла: агент подтверждает его у сотрудника. */
      needsConfirmation: boolean;
    }
  | { status: 'ambiguous'; candidates: ContractTemplate[] }
  | { status: 'not_found' };

/** Нижний регистр, «ё» → «е», нормализация Юникода: одно написание для сравнения. */
function normalizeText(text: string): string {
  return text.normalize('NFC').toLowerCase().replaceAll('ё', 'е');
}

/** Слова фразы: буквы и цифры, остальное - разделители (подчёркивание тоже разделитель). */
function tokenize(text: string): string[] {
  return normalizeText(text).split(/[^\p{L}\p{N}]+/u).filter((word) => word !== '');
}

/**
 * Слова фразы с дефисом внутри слова («пр-метал» - одно слово): так «ПР-Метал» не принимается
 * за юрлицо «ПР». Дефис между пробелами разделителем остаётся.
 */
function tokenizeKeepingHyphens(text: string): string[] {
  return normalizeText(text)
    .split(/[^\p{L}\p{N}-]+/u)
    .map((word) => word.replace(/^-+|-+$/g, ''))
    .filter((word) => word !== '');
}

/** Разобранная фраза: слова и строка из них для поиска основ из нескольких слов. */
interface Phrase {
  tokens: string[];
  /** Слова с внутренними дефисами: для коротких названий юрлиц («мг», «пр»). */
  hyphenTokens: string[];
  joined: string;
}

function parsePhrase(text: string): Phrase {
  const tokens = tokenize(text);
  return { tokens, hyphenTokens: tokenizeKeepingHyphens(text), joined: ` ${tokens.join(' ')}` };
}

function hasWord(phrase: Phrase, words: readonly string[]): boolean {
  return phrase.tokens.some((token) => words.includes(token));
}

/** Целое слово без дефисной склейки («пр» - да, «пр-метал» - нет). */
function hasStandaloneWord(phrase: Phrase, words: readonly string[]): boolean {
  return phrase.hyphenTokens.some((token) => words.includes(token));
}

/** Основа - начало слова во фразе («готов» в «готовой»; «мастер гифт» в «мастер гифтс»). */
function hasStem(phrase: Phrase, stems: readonly string[]): boolean {
  return stems.some((stem) => phrase.joined.includes(` ${stem}`));
}

/** Фраза содержит имя файла шаблона без расширения (сотрудник вставил название файла). */
function namesFile(phrase: Phrase, template: ContractTemplate): boolean {
  const stem = template.fileName.replace(/\.[^.]+$/u, '');
  return phrase.joined.trim() !== '' && phrase.joined.includes(` ${tokenize(stem).join(' ')}`);
}

/** Какие юрлица названы во фразе (оба названы - ограничения по юрлицу нет). */
function mentionedEntities(phrase: Phrase): TemplateEntity[] {
  const entities: TemplateEntity[] = ['mg', 'pr'];
  return entities.filter(
    (entity) =>
      hasStandaloneWord(phrase, ENTITY_WORDS[entity]) || hasStem(phrase, ENTITY_STEMS[entity]),
  );
}

/**
 * Юрлицо названо в тексте сообщений сотрудника: «МГ»/«ПР» целым словом, «Мастер Гифтс» и
 * «Прагматика» (в том числе в падеже) по основе. «ПР-Метал» юрлицом «ПР» не считается.
 */
export function entityNamedIn(text: string, entity: 'mg' | 'pr'): boolean {
  return mentionedEntities(parsePhrase(text)).includes(entity);
}

/** Какие виды названы во фразе. Договор на поставку без вида продукции NDA не включает. */
function mentionedVariants(phrase: Phrase): TemplateVariant[] {
  const variants: TemplateVariant[] = [];
  if (READY_PHRASE.test(phrase.joined)) variants.push('ready');
  if (hasStem(phrase, CONTRACT_STEMS)) variants.push('contract');
  if (hasWord(phrase, NDA_WORDS) || hasStem(phrase, NDA_STEMS)) variants.push('nda');
  if (variants.length === 0 && hasStem(phrase, SUPPLY_STEMS)) variants.push('ready', 'contract');
  return variants;
}

/**
 * Выбрать шаблон по фразе сотрудника. Однозначный - `unique`; подходят несколько - `ambiguous`
 * (агент переспрашивает по списку); ничего не названо или названного нет - `not_found`.
 * Названное юрлицо или вид сужает набор; неназванное не ограничивает. Фраза без юрлица и вида
 * шаблон не выбирает. Название файла из реестра во фразе выбирает его сразу.
 */
export function matchContractTemplate(rawPhrase: string): TemplateMatch {
  const phrase = parsePhrase(rawPhrase);
  const byFile = CONTRACT_TEMPLATES.filter((template) => namesFile(phrase, template));
  const [fileMatch] = byFile;
  if (byFile.length === 1 && fileMatch !== undefined) {
    return { status: 'unique', template: fileMatch, needsConfirmation: false };
  }
  const entities = mentionedEntities(phrase);
  const variants = mentionedVariants(phrase);
  if (entities.length === 0 && variants.length === 0) return { status: 'not_found' };
  // Оба юрлица названы: ограничения по юрлицу нет, подходят шаблоны любого из них.
  const candidates = CONTRACT_TEMPLATES.filter(
    (template) =>
      (entities.length === 0 || entities.includes(template.entity)) &&
      (variants.length === 0 || variants.includes(template.variant)),
  );
  const [only] = candidates;
  if (candidates.length === 0 || only === undefined) return { status: 'not_found' };
  // Выбор по словам, а не по названию файла: сотрудник мог иметь в виду другой договор.
  return candidates.length === 1
    ? { status: 'unique', template: only, needsConfirmation: true }
    : { status: 'ambiguous', candidates };
}

/** Путь в нормализованном Юникоде (SMB и macOS отдают кириллицу по-разному), без `./`. */
function normalizePath(path: string): string {
  return path.trim().replaceAll('\\', '/').replace(/^(\.\/)+/, '').normalize('NFC');
}

/** Имя файла в конце пути, в нормализованном Юникоде. */
export function templateBaseName(path: string): string {
  const parts = normalizePath(path).split('/');
  return parts[parts.length - 1] ?? '';
}

/**
 * Шаблон реестра по ТОЧНОМУ относительному пути: каталог шаблонов (`templatesPrefix`, может
 * быть пустым) плюс имя файла. Одноимённый файл в другом каталоге шаблоном реестра не считается.
 */
export function contractTemplateByPath(
  path: string,
  templatesPrefix = '',
): ContractTemplate | undefined {
  const prefix = normalizePath(templatesPrefix);
  const full = normalizePath(path);
  if (!full.startsWith(prefix)) return undefined;
  const rest = full.slice(prefix.length).replace(/^\//, '');
  return CONTRACT_TEMPLATES.find((template) => template.fileName.normalize('NFC') === rest);
}

/**
 * Шаблон по пути - соглашение о неразглашении (вариант `nda`). NDA не привязано к КП, позициям
 * и суммам: сверка с КП к нему не применяется.
 */
export function isNdaTemplatePath(path: string | undefined, templatesPrefix = ''): boolean {
  return path !== undefined && contractTemplateByPath(path, templatesPrefix)?.variant === 'nda';
}

/**
 * Наше юрлицо-покупатель шаблона договора: то из `OWN_COMPANY_NAMES`, в названии которого есть
 * основа юрлица шаблона («мастер гифт» для МГ, «прагматик» для ПР). undefined - не нашлось.
 */
export function templateBuyerName(
  template: ContractTemplate,
  ownCompanyNames: readonly string[],
): string | undefined {
  const stems = ENTITY_STEMS[template.entity];
  return ownCompanyNames.find((name) => {
    const normalized = name.toLowerCase().replace(/ё/g, 'е').replace(/[\s-]+/g, ' ');
    return stems.some((stem) => normalized.includes(stem));
  });
}
