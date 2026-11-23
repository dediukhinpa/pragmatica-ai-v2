import { CancelledError } from '@business-ai/core';

/**
 * Подписант нашей стороны в косвенном падеже («замени директора на Смирнову Елену Викторовну»).
 * Сервис склонения понимает только именительный и на винительном отдаёт `null`. Здесь ФИО
 * приводится к именительному падежу ОСТОРОЖНО: правила знают только однозначные формы
 * (ед. ч., мужской и женский род), род берётся по отчеству, а результат принимается лишь когда
 * (1) наша парадигма склоняет полученное имя обратно ровно в исходную форму в одном падеже и
 * (2) родительный падеж от сервиса совпадает с родительным нашей парадигмы по каждому слову.
 * При любом сомнении (неизвестное окончание, несколько подходящих чтений, расхождение с сервисом)
 * результата нет, а вызывающий код отказывает, как и раньше.
 */

/** Сколько слов в ФИО подписанта: «Фамилия Имя Отчество». */
const FULL_NAME_WORDS = 3;
/** Сколько вариантов именительного падежа максимум пробуем у сервиса (защита от перебора). */
const MAX_CANDIDATES = 6;
/** Минимальная длина основы слова при обратном разборе окончания. */
const MIN_BASE_LENGTH = 2;
/** Самое длинное снимаемое окончание косвенного падежа. */
const MAX_SUFFIX_LENGTH = 3;

const VOWELS = 'аеёиоуыэюя';
/** После этих букв родительный падеж слов на -а пишется с «и», а не с «ы». */
const VELAR_OR_SIBILANT = 'гкхжшчщ';
/** После шипящих и «ц» творительный падеж с «е» («Гришей», «Борисовичем» не здесь). */
const SIBILANTS = 'жшчщц';

/** Падежи, по которым ищется согласованная форма (именительный не нужен: он и есть цель). */
const CASES = ['acc', 'gen', 'dat', 'instr', 'prep'] as const;
type CaseName = (typeof CASES)[number];
type Paradigm = Partial<Record<CaseName, string>>;

/** Род подписанта: определяется по отчеству. */
export type SignatoryGender = 'masculine' | 'feminine';
type WordRole = 'surname' | 'first' | 'patronymic';

/** Окончания отчества во всех косвенных падежах: женский род. */
const FEMININE_PATRONYMIC_ENDINGS = [
  'вна', 'вны', 'вне', 'вну', 'вной', 'чна', 'чны', 'чне', 'чну', 'чной',
] as const;
/** То же для мужского рода. */
const MASCULINE_PATRONYMIC_ENDINGS = ['ич', 'ича', 'ичу', 'ичем', 'иче'] as const;

/** Окончания косвенных падежей, которые снимаются при обратном разборе (пустое - без снятия). */
const OBLIQUE_SUFFIXES = [
  '', 'а', 'я', 'у', 'ю', 'е', 'ы', 'и', 'ой', 'ей', 'ом', 'ем', 'ым', 'им', 'ого', 'ому', 'ую',
] as const;
/** Окончания именительного, которые приставляются к основе. */
const NOMINATIVE_ENDINGS = ['', 'а', 'я', 'ь', 'й', 'ая', 'ий', 'ый', 'ой'] as const;

/** Мужские имена с беглой гласной («Павла» - «Павел»): по основе их не восстановить. */
const FLEETING_FIRST_NAMES = ['павл', 'павел', 'петр', 'пётр', 'льв', 'лев'] as const;
/** Беглая гласная в мужских фамилиях («Кравца», «Волоска»): основа на к/ц после согласной. */
/** Мужские фамилии на -ец, -ек, -ок теряют гласную при склонении (Кравец - Кравца). */
const FLEETING_SURNAME_SUFFIXES = ['ец', 'ек', 'ёк', 'ок'] as const;
/** Окончания притяжательных фамилий: Смирнов-а, Ильин-а. */
const POSSESSIVE_ENDINGS = ['ов', 'ев', 'ёв', 'ин', 'ын'] as const;
/** Окончания, по которым слово похоже на косвенную форму, а не на именительный падеж. */
const INFLECTED_LOOKING_ENDINGS = ['ой', 'ей', 'ый', 'ий', 'ом', 'ем', 'ым', 'им'] as const;
const FLEETING_SURNAME_ENDING = /[бвгджзклмнпрстфхцчшщ][кц]$/u;

const lower = (word: string): string => word.toLowerCase();
const endsWith = (word: string, endings: readonly string[]): boolean =>
  endings.some((ending) => lower(word).endsWith(ending));
const cut = (word: string, length: number): string => word.slice(0, word.length - length);
const lastLetter = (word: string): string => lower(word).slice(-1);
const isVowel = (letter: string): boolean => VOWELS.includes(letter);
const sameWord = (a: string, b: string): boolean => lower(a) === lower(b);

/** Все падежи одной формой (несклоняемое слово). */
function invariable(word: string): Paradigm {
  return { acc: word, gen: word, dat: word, instr: word, prep: word };
}

/** Женское слово на -а (имя): Елена - Елены/Елене/Елену/Еленой. */
function feminineHardA(word: string): Paradigm {
  const base = cut(word, 1);
  const genitiveEnding = VELAR_OR_SIBILANT.includes(lastLetter(base)) ? 'и' : 'ы';
  const instrumental = SIBILANTS.includes(lastLetter(base)) ? 'ей' : 'ой';
  return {
    acc: `${base}у`, gen: `${base}${genitiveEnding}`, dat: `${base}е`, prep: `${base}е`,
    instr: `${base}${instrumental}`,
  };
}

/** Женское имя на -я, -ия, -ья: Таня, Мария, Наталья. */
function feminineSoftYa(word: string): Paradigm {
  const base = cut(word, 1);
  const lowered = lower(word);
  if (lowered.endsWith('ия')) {
    return {
      acc: `${base}ю`, gen: `${base}и`, dat: `${base}и`, prep: `${base}и`, instr: `${base}ей`,
    };
  }
  return {
    acc: `${base}ю`, gen: `${base}и`, dat: `${base}е`, prep: `${base}е`, instr: `${base}ей`,
  };
}

/** Мужское слово на мягкую согласную: Игорь, Андрей, Дмитрий. */
function masculineSoft(word: string): Paradigm | null {
  const base = cut(word, 1);
  // «ь» стоит после согласной («Игорь»), «й» после гласной («Андрей»): «Андреь» - не имя.
  const afterVowel = isVowel(lastLetter(base));
  if (afterVowel === lower(word).endsWith('ь')) return null;
  const prepositional = lower(word).endsWith('ий') ? 'и' : 'е';
  return {
    acc: `${base}я`, gen: `${base}я`, dat: `${base}ю`, instr: `${base}ем`,
    prep: `${base}${prepositional}`,
  };
}

/** Мужское слово на твёрдую согласную: Иван, Шевчук. */
function masculineHard(word: string, instrumental: string | undefined): Paradigm {
  const sibilant = SIBILANTS.includes(lastLetter(word));
  return {
    acc: `${word}а`, gen: `${word}а`, dat: `${word}у`, prep: `${word}е`,
    ...(instrumental === undefined ? {} : { instr: `${word}${sibilant ? 'ем' : instrumental}` }),
  };
}

/** Мужские прилагательные фамилии (Белый, Ковальский, Донской). */
function masculineAdjective(word: string): Paradigm | null {
  const soft = lower(word).endsWith('ий');
  const base = cut(word, 2);
  // После г, к, х и шипящих «ы» не пишется: «Ковальскый», «Большый» - не фамилии.
  const hard = lower(word).endsWith('ый');
  if (hard && VELAR_OR_SIBILANT.includes(lastLetter(base))) return null;
  return {
    acc: `${base}ого`, gen: `${base}ого`, dat: `${base}ому`, prep: `${base}ом`,
    instr: `${base}${soft ? 'им' : 'ым'}`,
  };
}

function patronymicParadigm(word: string, gender: SignatoryGender): Paradigm | null {
  if (gender === 'feminine' && endsWith(word, ['вна', 'чна'])) {
    const base = cut(word, 1);
    return {
      acc: `${base}у`, gen: `${base}ы`, dat: `${base}е`, prep: `${base}е`, instr: `${base}ой`,
    };
  }
  if (gender === 'masculine' && endsWith(word, ['ич'])) {
    return {
      acc: `${word}а`, gen: `${word}а`, dat: `${word}у`, instr: `${word}ем`, prep: `${word}е`,
    };
  }
  return null;
}

function firstNameParadigm(word: string, gender: SignatoryGender): Paradigm | null {
  const lowered = lower(word);
  if (gender === 'feminine') {
    if (lowered.endsWith('я')) return feminineSoftYa(word);
    return lowered.endsWith('а') ? feminineHardA(word) : null;
  }
  if (FLEETING_FIRST_NAMES.includes(lowered as (typeof FLEETING_FIRST_NAMES)[number])) return null;
  if (lowered.endsWith('й') || lowered.endsWith('ь')) return masculineSoft(word);
  return isVowel(lastLetter(word)) ? null : masculineHard(word, 'ом');
}

function feminineSurnameParadigm(word: string): Paradigm | null {
  if (endsWith(word, ['ова', 'ева', 'ёва', 'ина', 'ына'])) {
    const base = cut(word, 1);
    return {
      acc: `${base}у`, gen: `${base}ой`, dat: `${base}ой`, prep: `${base}ой`, instr: `${base}ой`,
    };
  }
  if (endsWith(word, ['ая'])) {
    const base = cut(word, 2);
    // «Смирновая» - не фамилия: притяжательные формы идут по правилу выше.
    if (endsWith(base, POSSESSIVE_ENDINGS)) return null;
    return {
      acc: `${base}ую`, gen: `${base}ой`, dat: `${base}ой`, prep: `${base}ой`, instr: `${base}ой`,
    };
  }
  // Женская фамилия на согласную или -о не склоняется (Шевчук, Ткаченко); окончания
  // косвенных падежей (-ой, -ом, ...) за несклоняемую фамилию не принимаются.
  if (endsWith(word, INFLECTED_LOOKING_ENDINGS) || endsWith(word, ['ого', 'его'])) return null;
  return !isVowel(lastLetter(word)) || lower(word).endsWith('о') ? invariable(word) : null;
}

function masculineSurnameParadigm(word: string): Paradigm | null {
  const lowered = lower(word);
  if (endsWith(word, ['ого', 'его'])) return null;
  if (endsWith(word, ['о', 'ых', 'их'])) return invariable(word);
  if (endsWith(word, ['ий', 'ый', 'ой'])) return masculineAdjective(word);
  if (FLEETING_SURNAME_ENDING.test(lowered) || endsWith(word, FLEETING_SURNAME_SUFFIXES)) {
    return null;
  }
  // «ин» склоняется то как притяжательная (Пушкиным), то как обычная (Берлином): творительный
  // для него не определяем.
  if (endsWith(word, ['ов', 'ев', 'ёв', 'ын'])) return masculineHard(word, 'ым');
  if (endsWith(word, ['ин'])) return masculineHard(word, undefined);
  if (lowered.endsWith('й') || lowered.endsWith('ь')) return masculineSoft(word);
  return isVowel(lastLetter(word)) ? null : masculineHard(word, 'ом');
}

/** Падежи слова, заданного именительным падежом; `null` - слово вне осторожных правил. */
function paradigmOf(word: string, role: WordRole, gender: SignatoryGender): Paradigm | null {
  if (word === '' || word.includes('-')) return null;
  if (role === 'patronymic') return patronymicParadigm(word, gender);
  if (role === 'first') return firstNameParadigm(word, gender);
  return gender === 'feminine' ? feminineSurnameParadigm(word) : masculineSurnameParadigm(word);
}

/**
 * Род по отчеству в любом косвенном падеже; `null` - отчество не распознано (иностранное имя,
 * не отчество): тогда род не угадывается.
 */
export function genderByPatronymic(patronymic: string): SignatoryGender | null {
  if (endsWith(patronymic, FEMININE_PATRONYMIC_ENDINGS)) return 'feminine';
  return endsWith(patronymic, MASCULINE_PATRONYMIC_ENDINGS) ? 'masculine' : null;
}

/** Падежная форма слова по правилам; `null` - слова или падежа нет в осторожных правилах. */
export function declineWord(
  nominative: string,
  role: WordRole,
  gender: SignatoryGender,
  grammaticalCase: CaseName,
): string | null {
  return paradigmOf(nominative, role, gender)?.[grammaticalCase] ?? null;
}

/** Чтение одного слова: возможный именительный и падежи, в которых он даёт исходную форму. */
interface WordReading {
  nominative: string;
  cases: ReadonlySet<CaseName>;
}

/** Возможные именительные для слова в косвенной форме с падежами, которые они объясняют. */
function readingsOf(word: string, role: WordRole, gender: SignatoryGender): WordReading[] {
  const found = new Map<string, WordReading>();
  for (const suffix of OBLIQUE_SUFFIXES) {
    const baseLength = word.length - suffix.length;
    if (suffix.length > MAX_SUFFIX_LENGTH || baseLength < MIN_BASE_LENGTH) continue;
    if (!lower(word).endsWith(suffix)) continue;
    const base = cut(word, suffix.length);
    for (const ending of NOMINATIVE_ENDINGS) {
      const nominative = `${base}${ending}`;
      const paradigm = paradigmOf(nominative, role, gender);
      if (paradigm === null || found.has(lower(nominative))) continue;
      const cases = CASES.filter((name) => {
        const form = paradigm[name];
        return form !== undefined && sameWord(form, word);
      });
      if (cases.length > 0) found.set(lower(nominative), { nominative, cases: new Set(cases) });
    }
  }
  return [...found.values()];
}

/**
 * Варианты ФИО в именительном падеже для ФИО в косвенном падеже: все слова в ОДНОМ падеже,
 * каждое объяснено правилами. Само исходное ФИО (все слова уже в именительном виде) не
 * возвращается. Пустой список - ничего надёжного нет или вариантов больше допустимого.
 */
export function nominativeCandidates(words: readonly string[]): string[][] {
  if (words.length !== FULL_NAME_WORDS) return [];
  const [surname = '', first = '', patronymic = ''] = words;
  const gender = genderByPatronymic(patronymic);
  if (gender === null) return [];
  const perWord = [
    readingsOf(surname, 'surname', gender),
    readingsOf(first, 'first', gender),
    readingsOf(patronymic, 'patronymic', gender),
  ];
  const result: string[][] = [];
  for (const grammaticalCase of CASES) {
    const lists = perWord.map((readings) =>
      readings.filter((reading) => reading.cases.has(grammaticalCase)),
    );
    if (lists.some((list) => list.length === 0)) continue;
    for (const a of lists[0] ?? []) {
      for (const b of lists[1] ?? []) {
        for (const c of lists[2] ?? []) {
          const candidate = [a.nominative, b.nominative, c.nominative];
          const known = result.some((item) => item.every((w, i) => w === candidate[i]));
          if (!known) result.push(candidate);
        }
      }
    }
  }
  const unchanged = (candidate: string[]): boolean =>
    candidate.every((word, i) => sameWord(word, words[i] ?? ''));
  return result.filter((candidate) => !unchanged(candidate));
}

/**
 * Родительный падеж ФИО по нашим правилам (или `null`, если какого-то слова в правилах нет).
 * Нужен для сверки с ответом сервиса склонения.
 */
export function genitiveByRules(nominative: readonly string[]): string[] | null {
  const [surname = '', first = '', patronymic = ''] = nominative;
  const gender = genderByPatronymic(patronymic);
  if (gender === null || nominative.length !== FULL_NAME_WORDS) return null;
  const forms = [
    declineWord(surname, 'surname', gender, 'gen'),
    declineWord(first, 'first', gender, 'gen'),
    declineWord(patronymic, 'patronymic', gender, 'gen'),
  ];
  return forms.every((form): form is string => form !== null) ? forms : null;
}

/** Склонение должности и ФИО в родительный падеж; `null` - сервис не уверен. */
export type InflectFn = (position: string, fullName: string) => Promise<string | null>;

/** ФИО, приведённое к именительному падежу, и подтверждённый сервисом родительный падеж. */
export interface NominativeResolution {
  /** Фамилия, имя, отчество в именительном падеже. */
  nominative: readonly [string, string, string];
  /** Ответ сервиса: должность и ФИО в родительном падеже (как при обычном склонении). */
  inflected: string;
}

/**
 * Приводит ФИО из косвенного падежа к именительному и склоняет его сервисом.
 *
 * Каждый вариант именительного падежа отправляется в сервис; принимается тот, у которого
 * родительный падеж сервиса совпадает с нашим по каждому слову. Подходящий вариант должен быть
 * ровно один: два варианта (например, «Елене» - Елена или Еленя) - неоднозначность, результата нет.
 *
 * @param inflect Клиент сервиса склонения (в тестах подменяется).
 * @param position Должность подписанта.
 * @param words Фамилия, имя, отчество в том виде, как их назвали.
 * @param isAborted Признак отмены хода; проверяется перед каждым обращением к сервису.
 * @returns Результат либо `null`: прежний отказ. Сбой сервиса пробрасывается вызывающему.
 */
export async function resolveNominativeSignatory(
  inflect: InflectFn,
  position: string,
  words: readonly string[],
  isAborted: () => boolean,
): Promise<NominativeResolution | null> {
  const candidates = nominativeCandidates(words);
  if (candidates.length === 0 || candidates.length > MAX_CANDIDATES) return null;
  const accepted: NominativeResolution[] = [];
  for (const candidate of candidates) {
    if (isAborted()) throw new CancelledError('Подстановка подписанта отменена.');
    const expected = genitiveByRules(candidate);
    if (expected === null) continue;
    const text = await inflect(position, candidate.join(' '));
    if (text === null) continue;
    const tail = text.trim().split(/\s+/u).slice(-FULL_NAME_WORDS);
    const agrees =
      tail.length === FULL_NAME_WORDS && tail.every((w, i) => sameWord(w, expected[i] ?? ''));
    const [surname = '', first = '', patronymic = ''] = candidate;
    if (agrees) accepted.push({ nominative: [surname, first, patronymic], inflected: text });
  }
  const [only] = accepted;
  return accepted.length === 1 && only !== undefined ? only : null;
}
