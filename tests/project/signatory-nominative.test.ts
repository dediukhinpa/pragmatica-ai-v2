import { describe, expect, test } from 'bun:test';
import { CancelledError } from '@business-ai/core';
import {
  declineWord,
  genderByPatronymic,
  genitiveByRules,
  nominativeCandidates,
  resolveNominativeSignatory,
  type InflectFn,
} from '../../src/signatory-nominative';

/**
 * Приведение ФИО подписанта из косвенного падежа к именительному («замени директора на Смирнову
 * Елену Викторовну»). Сервис склонения подменён словарём: знает только именительный падеж и на
 * остальное отвечает `null`. Данные синтетические.
 */

const POSITION = 'генеральный директор';

/** Словарь сервиса: ФИО в именительном падеже -> ФИО в родительном (с должностью в ответе). */
function dictionary(entries: Record<string, string>): { fn: InflectFn; calls: string[] } {
  const calls: string[] = [];
  const fn: InflectFn = async (_position, fullName) => {
    calls.push(fullName);
    const genitive = entries[fullName];
    return genitive === undefined ? null : `генерального директора ${genitive}`;
  };
  return { fn, calls };
}

const NEVER_ABORTED = (): boolean => false;
const resolve = (fn: InflectFn, name: string) =>
  resolveNominativeSignatory(fn, POSITION, name.split(' '), NEVER_ABORTED);

describe('род по отчеству', () => {
  test('женские и мужские отчества во всех падежах', () => {
    for (const word of ['Викторовна', 'Викторовны', 'Викторовне', 'Викторовну', 'Викторовной']) {
      expect(genderByPatronymic(word)).toBe('feminine');
    }
    for (const word of ['Ильинична', 'Ильиничну']) {
      expect(genderByPatronymic(word)).toBe('feminine');
    }
    for (const word of ['Петрович', 'Петровича', 'Петровичу', 'Петровичем', 'Петровиче']) {
      expect(genderByPatronymic(word)).toBe('masculine');
    }
    expect(genderByPatronymic('Ильич')).toBe('masculine');
  });

  test('не отчество: род не угадывается', () => {
    expect(genderByPatronymic('Сун')).toBeNull();
    expect(genderByPatronymic('Иванов')).toBeNull();
  });
});

describe('склонение слова по правилам', () => {
  test('женское имя: твёрдое и мягкое склонение', () => {
    expect(declineWord('Елена', 'first', 'feminine', 'acc')).toBe('Елену');
    expect(declineWord('Ольга', 'first', 'feminine', 'gen')).toBe('Ольги');
    expect(declineWord('Мария', 'first', 'feminine', 'dat')).toBe('Марии');
    expect(declineWord('Наталья', 'first', 'feminine', 'acc')).toBe('Наталью');
    expect(declineWord('Таня', 'first', 'feminine', 'instr')).toBe('Таней');
  });

  test('слов вне правил нет: имя и фамилия на -а у мужчины, беглая гласная, дефис', () => {
    expect(declineWord('Никита', 'first', 'masculine', 'gen')).toBeNull();
    expect(declineWord('Сорока', 'surname', 'masculine', 'gen')).toBeNull();
    expect(declineWord('Павел', 'first', 'masculine', 'gen')).toBeNull();
    expect(declineWord('Кравец', 'surname', 'masculine', 'gen')).toBeNull();
    expect(declineWord('Смирнов-Петров', 'surname', 'masculine', 'gen')).toBeNull();
  });

  test('родительный падеж ФИО по правилам', () => {
    expect(genitiveByRules(['Смирнова', 'Елена', 'Викторовна'])).toEqual([
      'Смирновой',
      'Елены',
      'Викторовны',
    ]);
    expect(genitiveByRules(['Шевчук', 'Елена', 'Викторовна'])?.[0]).toBe('Шевчук');
    expect(genitiveByRules(['Смирнов', 'Иван'])).toBeNull();
    expect(genitiveByRules(['Смирнов', 'Иван', 'Сун'])).toBeNull();
  });
});

describe('варианты именительного падежа', () => {
  test('винительный женский: Смирнову Елену Викторовну', () => {
    expect(nominativeCandidates(['Смирнову', 'Елену', 'Викторовну'])).toEqual([
      ['Смирнова', 'Елена', 'Викторовна'],
    ]);
  });

  test('дательный женский даёт два чтения имени (Елена или Еленя)', () => {
    const variants = nominativeCandidates(['Смирновой', 'Елене', 'Викторовне']);
    expect(variants).toContainEqual(['Смирнова', 'Елена', 'Викторовна']);
    expect(variants.length).toBe(2);
  });

  test('уже именительный и смесь падежей: вариантов нет', () => {
    expect(nominativeCandidates(['Смирнова', 'Елена', 'Викторовна'])).toEqual([]);
    expect(nominativeCandidates(['Смирнову', 'Елена', 'Викторовна'])).toEqual([]);
    expect(nominativeCandidates(['Смирнову', 'Елену', 'Викторовне'])).toEqual([]);
  });

  test('не три слова, нет отчества, дефис: вариантов нет', () => {
    expect(nominativeCandidates(['Смирнову', 'Елену'])).toEqual([]);
    expect(nominativeCandidates(['Ли', 'Вана', 'Суна'])).toEqual([]);
    expect(nominativeCandidates(['Салтыкову-Щедрину', 'Елену', 'Викторовну'])).toEqual([]);
  });

  test('беглая гласная и мужское имя на -а: вариантов нет', () => {
    expect(nominativeCandidates(['Смирнова', 'Павла', 'Ивановича'])).toEqual([]);
    expect(nominativeCandidates(['Кравца', 'Ивана', 'Петровича'])).toEqual([]);
    expect(nominativeCandidates(['Смирнова', 'Никиту', 'Ивановича'])).toEqual([]);
  });
});

describe('приведение к именительному с проверкой сервисом', () => {
  const FEMALE = dictionary({
    'Смирнова Елена Викторовна': 'Смирновой Елены Викторовны',
    'Белая Ольга Ивановна': 'Белой Ольги Ивановны',
    'Шевчук Елена Викторовна': 'Шевчук Елены Викторовны',
    'Ткаченко Анна Петровна': 'Ткаченко Анны Петровны',
    'Кузьмина Мария Ильинична': 'Кузьминой Марии Ильиничны',
  });

  test('женское ФИО в винительном: Смирнову Елену Викторовну', async () => {
    const out = await resolve(FEMALE.fn, 'Смирнову Елену Викторовну');
    expect(out?.nominative).toEqual(['Смирнова', 'Елена', 'Викторовна']);
    expect(out?.inflected).toBe('генерального директора Смирновой Елены Викторовны');
  });

  test('женское ФИО в дательном, творительном и родительном', async () => {
    for (const form of [
      'Смирновой Елене Викторовне',
      'Смирновой Еленой Викторовной',
      'Смирновой Елены Викторовны',
    ]) {
      const out = await resolve(FEMALE.fn, form);
      expect(out?.nominative).toEqual(['Смирнова', 'Елена', 'Викторовна']);
    }
  });

  test('фамилия на -ая и имя на -ия', async () => {
    const out = await resolve(FEMALE.fn, 'Белую Ольгу Ивановну');
    expect(out?.nominative).toEqual(['Белая', 'Ольга', 'Ивановна']);
    const mary = await resolve(FEMALE.fn, 'Кузьмину Марию Ильиничну');
    expect(mary?.nominative).toEqual(['Кузьмина', 'Мария', 'Ильинична']);
  });

  test('несклоняемые фамилии у женщины: Шевчук, Ткаченко', async () => {
    const first = await resolve(FEMALE.fn, 'Шевчук Елену Викторовну');
    expect(first?.nominative).toEqual(['Шевчук', 'Елена', 'Викторовна']);
    const second = await resolve(FEMALE.fn, 'Ткаченко Анну Петровну');
    expect(second?.nominative).toEqual(['Ткаченко', 'Анна', 'Петровна']);
  });

  const MALE = dictionary({
    'Смирнов Иван Петрович': 'Смирнова Ивана Петровича',
    'Кузнецов Дмитрий Сергеевич': 'Кузнецова Дмитрия Сергеевича',
    'Шевчук Иван Петрович': 'Шевчука Ивана Петровича',
    'Ткаченко Иван Петрович': 'Ткаченко Ивана Петровича',
    'Ковальский Андрей Игоревич': 'Ковальского Андрея Игоревича',
  });

  test('мужское ФИО в винительном, дательном, творительном', async () => {
    for (const form of [
      'Смирнова Ивана Петровича',
      'Смирнову Ивану Петровичу',
      'Смирновым Иваном Петровичем',
    ]) {
      const out = await resolve(MALE.fn, form);
      expect(out?.nominative).toEqual(['Смирнов', 'Иван', 'Петрович']);
      expect(out?.inflected).toBe('генерального директора Смирнова Ивана Петровича');
    }
  });

  test('мужские: имя на -ий, фамилия Шевчук, несклоняемая Ткаченко, фамилия на -ий', async () => {
    const dmitry = await resolve(MALE.fn, 'Кузнецова Дмитрия Сергеевича');
    expect(dmitry?.nominative).toEqual(['Кузнецов', 'Дмитрий', 'Сергеевич']);
    const shevchuk = await resolve(MALE.fn, 'Шевчука Ивана Петровича');
    expect(shevchuk?.nominative).toEqual(['Шевчук', 'Иван', 'Петрович']);
    const tkachenko = await resolve(MALE.fn, 'Ткаченко Ивана Петровича');
    expect(tkachenko?.nominative).toEqual(['Ткаченко', 'Иван', 'Петрович']);
    const koval = await resolve(MALE.fn, 'Ковальского Андрея Игоревича');
    expect(koval?.nominative).toEqual(['Ковальский', 'Андрей', 'Игоревич']);
  });

  test('двусмысленное чтение: сервис знает оба варианта - отказ', async () => {
    const both = dictionary({
      'Смирнова Елена Викторовна': 'Смирновой Елены Викторовны',
      'Смирнова Еленя Викторовна': 'Смирновой Елени Викторовны',
    });
    expect(await resolve(both.fn, 'Смирновой Елене Викторовне')).toBeNull();
  });

  test('сервис не знает вариант: отказ', async () => {
    const empty = dictionary({});
    expect(await resolve(empty.fn, 'Смирнову Елену Викторовну')).toBeNull();
  });

  test('родительный от сервиса расходится с правилами: отказ', async () => {
    const odd = dictionary({ 'Смирнова Елена Викторовна': 'Смирнове Елены Викторовны' });
    expect(await resolve(odd.fn, 'Смирнову Елену Викторовну')).toBeNull();
    const noun = dictionary({ 'Щербина Анна Петровна': 'Щербины Анны Петровны' });
    expect(await resolve(noun.fn, 'Щербину Анну Петровну')).toBeNull();
  });

  test('уже именительный: сервис не вызывается', async () => {
    const spy = dictionary({});
    expect(await resolve(spy.fn, 'Смирнова Елена Викторовна')).toBeNull();
    expect(spy.calls).toEqual([]);
  });

  test('неоднозначные ФИО без обращения к сервису: беглая гласная, смесь падежей', async () => {
    const spy = dictionary({ 'Смирнов Павел Иванович': 'Смирнова Павла Ивановича' });
    expect(await resolve(spy.fn, 'Смирнова Павла Ивановича')).toBeNull();
    expect(await resolve(spy.fn, 'Смирнову Павел Иванович')).toBeNull();
    expect(spy.calls).toEqual([]);
  });

  test('отмена хода прерывает работу, сбой сервиса пробрасывается', async () => {
    const calls = dictionary({});
    const aborted = resolveNominativeSignatory(
      calls.fn,
      POSITION,
      ['Смирнову', 'Елену', 'Викторовну'],
      () => true,
    );
    await expect(aborted).rejects.toBeInstanceOf(CancelledError);
    const broken: InflectFn = async () => {
      throw new Error('сервис недоступен');
    };
    await expect(resolve(broken, 'Смирнову Елену Викторовну')).rejects.toThrow('недоступен');
  });
});
