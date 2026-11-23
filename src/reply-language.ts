import type { ChatBlock, ChatChannel, ChatMessage } from '@business-ai/core';

/**
 * Язык ответов сотруднику: слова «токен», «метка», «условное обозначение» в ответах не
 * используются (сотрудник не должен знать о служебных знаках). Слово «маркер» разрешено: это
 * наше «[ЗАПОЛНИТЬ: ...]». Слова «пометка», «отметка» тоже разрешены: ловятся только слова,
 * начинающиеся на «метк»/«токен» (по границам слов), и условное обозначение.
 */

/** Основы запрещённых слов (для документации и проверок; поиск идёт по `FORBIDDEN_PATTERN`). */
export const FORBIDDEN_REPLY_STEMS: readonly string[] = ['токен', 'метк', 'условное обозначение'];

/** Слово, на которое заменяются запрещённые. */
const REPLACEMENT_WORD = 'значение';

/** Левая граница слова: перед ним нет буквы, цифры или подчёркивания. */
const WORD_START = '(?<![\\p{L}\\p{N}_])';
/** Правая граница слова. */
const WORD_END = '(?![\\p{L}\\p{N}_])';

/** Формы «токен» (в том числе множественное число). */
const TOKEN_FORMS = 'токен(?:а|у|ом|е|ы|ов|ам|ами|ах)?';
/** Формы «метка». */
const MARK_FORMS = 'метк(?:а|и|е|у|ой|ою|ам|ами|ах)|меток';
/** Формы «условное обозначение»: прилагательное любого падежа + любая форма существительного. */
const CONVENTIONAL_FORMS =
  'условн(?:ое|ого|ому|ым|ом|ые|ых|ыми)\\s+обозначени(?:е|я|ю|ем|и|й|ям|ями|ях)';

/** Запрещённое слово или словосочетание (без учёта регистра, по границам слов). */
const FORBIDDEN_PATTERN = new RegExp(
  `${WORD_START}(?:${CONVENTIONAL_FORMS}|${TOKEN_FORMS}|${MARK_FORMS})${WORD_END}`,
  'giu',
);

/** Окончание слова -> то же окончание слова «значение». */
const ENDING_TO_VALUE_FORM: Readonly<Record<string, string>> = {
  // Единственное число: именительный, родительный, дательный, творительный, предложный.
  токен: 'значение',
  токена: 'значения',
  токену: 'значению',
  токеном: 'значением',
  токене: 'значении',
  метка: 'значение',
  метки: 'значения',
  метке: 'значению',
  меткой: 'значением',
  меткою: 'значением',
  метку: 'значение',
  // Множественное число.
  токены: 'значения',
  токенов: 'значений',
  токенам: 'значениям',
  токенами: 'значениями',
  токенах: 'значениях',
  меток: 'значений',
  меткам: 'значениям',
  метками: 'значениями',
  метках: 'значениях',
  // Существительное из «условное обозначение».
  обозначение: 'значение',
  обозначения: 'значения',
  обозначению: 'значению',
  обозначением: 'значением',
  обозначении: 'значении',
  обозначений: 'значений',
  обозначениям: 'значениям',
  обозначениями: 'значениями',
  обозначениях: 'значениях',
};

/** Предлог перед словом: тогда «метке» - это предложный падеж («в значении»), не дательный. */
const PREPOSITIONAL_PREFIX = /(?:^|[^\p{L}\p{N}_])(?:в|во|на|о|об|обо|при)\s+$/iu;
/** Формы, у которых дательный и предложный падеж различаются в слове «значение». */
const DATIVE_OR_PREPOSITIONAL = 'метке';

/** Подгоняет регистр замены под исходное слово: ВЕРХНИЙ, С заглавной, строчный. */
function matchCase(source: string, replacement: string): string {
  const letters = [...source].filter((char) => char.toLowerCase() !== char.toUpperCase());
  const allUpper = letters.length > 1 && letters.every((char) => char === char.toUpperCase());
  if (allUpper) return replacement.toUpperCase();
  const first = source.charAt(0);
  if (first !== first.toLowerCase()) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

/** Замена одного найденного слова на «значение» в том же падеже. */
function replacementFor(found: string, before: string): string {
  // Для «условного обозначения» падеж определяет последнее слово.
  const lower = found.toLowerCase();
  const key = lower.split(/\s+/u).pop() ?? lower;
  let form = ENDING_TO_VALUE_FORM[key] ?? REPLACEMENT_WORD;
  if (key === DATIVE_OR_PREPOSITIONAL && PREPOSITIONAL_PREFIX.test(before)) form = 'значении';
  return matchCase(found, form);
}

/** Результат переписывания текста. */
interface Rewritten {
  text: string;
  /** Сколько слов заменено. */
  count: number;
}

/** Переписывает текст и считает замены. Текст без запрещённых слов возвращается как есть. */
function rewriteCounting(text: string): Rewritten {
  let count = 0;
  const result = text.replace(FORBIDDEN_PATTERN, (found: string, offset: number) => {
    count += 1;
    return replacementFor(found, text.slice(0, offset));
  });
  return { text: count === 0 ? text : result, count };
}

/**
 * Запрещённые слова, найденные в тексте, в той форме, как они написаны (в порядке появления).
 * Регистр не учитывается, ловятся только целые слова: «пометка» и «отметка» разрешены.
 */
export function findForbiddenReplyWords(text: string): string[] {
  return text.match(FORBIDDEN_PATTERN) ?? [];
}

/**
 * Безопасная замена запрещённых слов на «значение» в том же падеже («токеном» -> «значением»,
 * «метки» -> «значения»), чтобы текст оставался читаемым. Идемпотентна; текст без запрещённых
 * слов возвращается без изменений. Согласование прилагательных («эта метка») не правится.
 */
export function rewriteForbiddenReplyWords(text: string): string {
  return rewriteCounting(text).text;
}

/**
 * Абзац для промпта агентов: как говорить со служебными значениями, не называя их служебными.
 */
export const REPLY_LANGUAGE_PROMPT_RULE: string =
  'Не называй значения «токеном», «меткой» или «условным обозначением»: сотруднику эти слова ' +
  'ничего не говорят. Если значение не удалось получить, скажи простыми словами, чего не ' +
  'хватает: «нужно название организации», «нужен телефон контактного лица». Если в данных ' +
  'остался служебный знак вида [ORG_1], не показывай его сотруднику и не вставляй в файлы и ' +
  'письма, а попроси прислать значение текстом.';

/** Сообщение с переписанными текстами и число замен; без замен - то же самое сообщение. */
function rewriteMessage(message: ChatMessage): { message: ChatMessage; count: number } {
  let count = 0;
  const apply = (text: string): string => {
    const rewritten = rewriteCounting(text);
    count += rewritten.count;
    return rewritten.text;
  };
  const text = apply(message.text);
  const blocksLead = message.blocksLead === undefined ? undefined : apply(message.blocksLead);
  const blocks = message.blocks?.map((block): ChatBlock => rewriteBlock(block, apply));
  if (count === 0) return { message, count };
  const copy: ChatMessage = { ...message, text };
  if (blocksLead !== undefined) copy.blocksLead = blocksLead;
  if (blocks !== undefined) copy.blocks = blocks;
  return { message: copy, count };
}

/** Переписывает тексты блока (кнопки и ссылки-адреса не трогает). */
function rewriteBlock(block: ChatBlock, apply: (text: string) => string): ChatBlock {
  switch (block.kind) {
    case 'message':
      return { ...block, text: apply(block.text) };
    case 'grid':
      return {
        ...block,
        rows: block.rows.map((row) => ({ ...row, name: apply(row.name), value: apply(row.value) })),
      };
    case 'link':
      return { ...block, name: apply(block.name) };
    default:
      return block;
  }
}

/**
 * Декоратор канала: `reply` и `updateMessage` переписывают запрещённые слова в тексте, коротком
 * тексте над блоками и текстах блоков (кнопки не трогаются). Сообщение без запрещённых слов
 * уходит тем же объектом. Остальные члены канала делегируются как есть с сохранением `this`;
 * необязательные методы, которых нет у исходного канала, в обёртке тоже отсутствуют (прокси).
 *
 * @param chat Исходный канал.
 * @param onRewritten Необязательный обратный вызов с числом замен (для журнала).
 * @param options `observeOnly`: тексты не меняются, число найденных слов только уходит в журнал
 *   (слово «метка» бывает и в названии товара: подмена текста там исказила бы данные).
 */
export function guardReplyLanguage(
  chat: ChatChannel,
  onRewritten?: (replaced: number) => void,
  options: { observeOnly?: boolean } = {},
): ChatChannel {
  /** Сообщение для отправки; число замен уходит в журнал, его сбой отправку не ломает. */
  const prepare = (message: ChatMessage): ChatMessage => {
    const result = rewriteMessage(message);
    if (result.count > 0 && onRewritten !== undefined) {
      try {
        onRewritten(result.count);
      } catch {
        // Журнал не должен ломать ответ.
      }
    }
    return options.observeOnly === true ? message : result.message;
  };
  return new Proxy(chat, {
    get(target, property): unknown {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (property === 'reply') {
        return (threadId: string, message: ChatMessage, key: string): unknown =>
          Reflect.apply(value, target, [threadId, prepare(message), key]);
      }
      if (property === 'updateMessage') {
        return (
          threadId: string,
          draftId: string,
          message: ChatMessage,
          ...rest: unknown[]
        ): unknown => Reflect.apply(value, target, [threadId, draftId, prepare(message), ...rest]);
      }
      return (...args: unknown[]): unknown => Reflect.apply(value, target, args);
    },
  });
}
