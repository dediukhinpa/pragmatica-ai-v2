import { describe, expect, test } from 'bun:test';
import { WebSearchLimiter } from '@business-ai/core';
import {
  DISCOVERY_PAGE_SIZE,
  buildEvidence,
  categoryConfirmed,
  deriveDiscoveredFacts,
  findSuppliersForBase,
  isCorporateRoleMailbox,
} from '../../src/supplier-discovery';
import {
  DISCOVERY_SEARCHES_MAX,
  SUPPLIER_DISCOVERY_NAMESPACE,
  loadDiscoveryState,
} from '../../src/supplier-discovery-state';
import type { SupplierCard } from '../../src/kit/domain/supplier-card';
import {
  EMPLOYEE,
  INN_ALPHA,
  THREAD,
  buildDiscoveryWorld,
  companyPage,
  employeeContext,
  hit,
  schedulerContext,
  sentTexts,
  sitePages,
  type DiscoveryWorld,
} from './supplier-discovery-support';

/**
 * Пополнение базы: поиск кандидатов (этап 8z, раздел B). Данные синтетические: домены `.test`,
 * названия выдуманные, ИНН - с верной контрольной суммой.
 */

const QUERY = 'ёлочные игрушки';
const DIGIT_SERIES = /\d{10,}/;
const PHONE_ELKA = '+7 843 555-01-02';

const ELKA = 'elka-opt.test';
const SHAR = 'shar-market.test';
const SNEG = 'snegurka.test';
const DELTA = 'delta-toys.test';

/** Страница компании «Ёлка-Опт»: всё, что можно подтвердить, плюс ПДн сотрудников. */
const ELKA_TEXT = companyPage({
  legal: 'ООО «Ёлка-Опт»',
  city: 'Казань',
  phone: PHONE_ELKA,
  mailbox: `info@${ELKA}`,
  inn: INN_ALPHA,
  extra: `Директор Руководов Иван Петрович, личная почта ivanov@${ELKA}, моб. +7 917 000-11-22.`,
});

function card(id: string, name: string, patch: Partial<SupplierCard> = {}): SupplierCard {
  return {
    id,
    name,
    status: 'new',
    contacts: [],
    supplies: { categories: [], brands: [], regions: [] },
    terms: {},
    notes: [],
    ...patch,
  };
}

async function findAll(world: DiscoveryWorld, query = QUERY, count?: number) {
  return findSuppliersForBase.execute(
    { query, ...(count === undefined ? {} : { count }) },
    world.deps,
    employeeContext(),
  );
}

describe('findSuppliersForBase: список кандидатов', () => {
  test('сотруднику уходит список с источниками, модели - номера и названия', async () => {
    const world = await buildDiscoveryWorld({
      hitsBySearch: [
        [
          hit(ELKA, 'Ёлка-Опт', 'Ёлочные игрушки', '/catalog'),
          hit(SHAR, 'Шар-Маркет', 'Ёлочные игрушки оптом'),
        ],
      ],
      pages: sitePages({
        [ELKA]: ELKA_TEXT,
        [SHAR]: companyPage({ legal: 'ООО «Шар-Маркет»', city: 'Пермь' }),
      }),
    });
    const out = await findAll(world);
    expect(out.status).toBe('found');
    expect(out.shown.map((item) => item.number)).toEqual([1, 2]);
    expect(out.shown[0]?.name).toBe('ООО «Ёлка-Опт»');
    expect(out.shown[0]?.nameConfirmed).toBe(true);
    // Модель не получает ни контактов, ни адресов страниц, ни серий цифр.
    const forModel = JSON.stringify(out);
    expect(DIGIT_SERIES.test(forModel)).toBe(false);
    expect(forModel).not.toContain('@');
    expect(forModel).not.toContain('/catalog');
    // Сотрудник видит список: источник каждого и что именно нашлось на странице.
    const [list] = sentTexts(world.deps);
    expect(list).toContain('1. ООО «Ёлка-Опт» - https://elka-opt.test, г. Казань');
    expect(list).toContain('Источник: https://elka-opt.test/catalog');
    expect(list).toContain('На странице есть: телефон, почта, ИНН');
    expect(list).toContain('2. ООО «Шар-Маркет» - https://shar-market.test, г. Пермь');
    expect(list).toContain('заведи 1, 3, 5');
    // Значения контактов в списке не печатаются: они видны на карточке.
    expect(list).not.toContain(PHONE_ELKA);
    expect(list).not.toContain(INN_ALPHA);
    expect(world.searches[0]).toBe(QUERY);
  });

  test('тексты страниц и ПДн сотрудников в состоянии не хранятся', async () => {
    const world = await buildDiscoveryWorld({
      hitsBySearch: [[hit(ELKA, 'Ёлка-Опт', 'Ёлочные игрушки')]],
      pages: sitePages({ [ELKA]: ELKA_TEXT }),
    });
    await findAll(world);
    const raw = JSON.stringify(await world.deps.state.get(SUPPLIER_DISCOVERY_NAMESPACE, THREAD));
    expect(raw).toContain('info@elka-opt.test');
    for (const secret of ['Руководов', 'ivanov@', '917', 'ул. Тестовая']) {
      expect(raw).not.toContain(secret);
    }
  });

  test('известные базе отсеиваются: по ИНН, домену сайта, домену почты и названию', async () => {
    const world = await buildDiscoveryWorld({
      hitsBySearch: [
        [
          hit('by-inn.test', 'Совсем другое имя'),
          hit('beta-known.test', 'Бета'),
          hit('corp-known.test', 'Корп'),
          hit('gamma-opt.test', 'Гамма'),
          hit(DELTA, 'Дельта'),
          hit(SNEG, 'Снегурка'),
        ],
      ],
      pages: sitePages({
        'by-inn.test': companyPage({ legal: 'ООО «Иное название»', inn: INN_ALPHA }),
        'beta-known.test': companyPage({ legal: 'ООО «Бета»' }),
        'corp-known.test': companyPage({ legal: 'ООО «Корп»' }),
        'gamma-opt.test': companyPage({ legal: 'ООО «Гамма-Опт»' }),
        [DELTA]: companyPage({ legal: 'ООО «Дельта-Игрушки»' }),
        [SNEG]: companyPage({ legal: 'ООО «Снегурка»' }),
      }),
    });
    const { suppliers } = world.deps;
    await suppliers.upsert({ id: 'k-inn', name: 'Давно в базе', inn: INN_ALPHA });
    await suppliers.saveCard(
      card('k-site', 'Бета-карточка', { website: 'https://beta-known.test' }),
    );
    await suppliers.saveCard(
      card('k-mail', 'Почтовая карточка', {
        contacts: [{ email: 'sales@corp-known.test', isPrimary: true }],
      }),
    );
    await suppliers.saveCard(card('k-name', 'ООО «Гамма-Опт»'));
    const out = await findAll(world);
    expect(out.shown.map((item) => item.name)).toEqual([
      'ООО «Дельта-Игрушки»',
      'ООО «Снегурка»',
    ]);
    expect(out.skippedKnown).toBe(4);
    // Домены известных карточек платное чтение страниц не тратит.
    const hosts = world.reader.calls.map((call) => call.host);
    expect(hosts).not.toContain('beta-known.test');
    expect(hosts).not.toContain('corp-known.test');
    const [list] = sentTexts(world.deps);
    expect(list).toContain('уже известные базе или показанные: 4');
    expect(list).not.toContain('Бета');
  });

  test('«ещё» по тому же запросу даёт следующих без повторов и без нового поиска', async () => {
    const hosts = [ELKA, SHAR, SNEG, DELTA];
    const world = await buildDiscoveryWorld({
      hitsBySearch: [hosts.map((host) => hit(host, host))],
      pages: sitePages(
        Object.fromEntries(hosts.map((host) => [host, companyPage({ legal: `ООО «${host}»` })])),
      ),
    });
    const first = await findAll(world, QUERY, 2);
    const second = await findAll(world, QUERY, 2);
    expect(first.shown.map((item) => item.number)).toEqual([1, 2]);
    expect(second.shown.map((item) => item.number)).toEqual([3, 4]);
    const names = [...first.shown, ...second.shown].map((item) => item.name);
    expect(new Set(names).size).toBe(4);
    // Второй список взят из найденного, платный поиск и чтение страниц не повторялись.
    expect(world.searches).toHaveLength(1);
    expect(world.reader.calls.map((call) => call.host).sort()).toEqual([...hosts].sort());
    expect(second.remaining).toBe(0);
  });

  test('новый поиск того же запроса не возвращает показанных и меняет формулировку', async () => {
    const world = await buildDiscoveryWorld({
      hitsBySearch: [
        [hit(ELKA, 'Ёлка-Опт')],
        [hit(ELKA, 'Ёлка-Опт'), hit(DELTA, 'Дельта')],
      ],
      pages: sitePages({
        [ELKA]: companyPage({ legal: 'ООО «Ёлка-Опт»' }),
        [DELTA]: companyPage({ legal: 'ООО «Дельта-Игрушки»' }),
      }),
    });
    const out = await findAll(world);
    expect(out.shown.map((item) => item.name)).toEqual([
      'ООО «Ёлка-Опт»',
      'ООО «Дельта-Игрушки»',
    ]);
    expect(world.searches).toEqual([QUERY, `${QUERY} оптом`]);
    // Тот же сайт во второй выдаче заново не читался.
    expect(world.reader.calls.filter((call) => call.host === ELKA)).toHaveLength(1);
  });

  test('другой запрос начинает новый список, прежний сбрасывается', async () => {
    const world = await buildDiscoveryWorld({
      // Первый запрос тратит два поиска (второй пуст), третий поиск - уже новый запрос.
      hitsBySearch: [[hit(ELKA, 'Ёлка-Опт')], [], [hit(ELKA, 'Ёлка-Опт')]],
      pages: sitePages({ [ELKA]: companyPage({ legal: 'ООО «Ёлка-Опт»' }) }),
    });
    await findAll(world, QUERY);
    const other = await findAll(world, 'гирлянды');
    expect(other.shown.map((item) => item.number)).toEqual([1]);
    const state = await loadDiscoveryState(world.deps.state, THREAD, world.deps.clock.now());
    expect(state?.query).toBe('гирлянды');
  });
});

describe('findSuppliersForBase: пределы и защита', () => {
  test('число платных поисков на состояние ограничено, дальше «новых нет»', async () => {
    const hits = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => [hit(`${name}-toys.test`, name)]);
    const world = await buildDiscoveryWorld({
      hitsBySearch: hits,
      pages: sitePages(
        Object.fromEntries(
          ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => [
            `${name}-toys.test`,
            companyPage({ legal: `ООО «Игрушки ${name}»` }),
          ]),
        ),
      ),
    });
    const first = await findAll(world);
    const second = await findAll(world);
    const third = await findAll(world);
    expect(world.searches).toHaveLength(DISCOVERY_SEARCHES_MAX);
    expect(first.shown.length + second.shown.length).toBe(DISCOVERY_SEARCHES_MAX);
    expect(third.status).toBe('none');
    expect(third.exhausted).toBe(true);
    expect(third.message).toContain('Новых подходящих поставщиков');
    // Пятого поиска не было: «нет новых» отвечено без платного обращения.
    expect(world.searches).toHaveLength(DISCOVERY_SEARCHES_MAX);
  });

  test('пустая выдача: честное «новых нет», состояние исчерпано', async () => {
    const world = await buildDiscoveryWorld({ hitsBySearch: [[]] });
    const out = await findAll(world);
    expect(out.status).toBe('none');
    expect(out.shown).toEqual([]);
    expect(out.exhausted).toBe(true);
    expect(sentTexts(world.deps)).toEqual([]);
  });

  test('запрос с ПДн отклоняется до поиска, чтения страниц и записи состояния', async () => {
    const world = await buildDiscoveryWorld({ hitsBySearch: [[hit(ELKA, 'Ёлка-Опт')]] });
    const bad = [
      'игрушки ivanov@example.test',
      'игрушки +7 495 123-45-67',
      'Иванов Иван Иванович игрушки',
      `игрушки ${INN_ALPHA}`,
    ];
    for (const query of bad) {
      await expect(findAll(world, query)).rejects.toMatchObject({ code: 'validation_failed' });
    }
    await expect(
      findSuppliersForBase.execute(
        { query: QUERY, region: 'Казань +7 495 123-45-67' },
        world.deps,
        employeeContext(),
      ),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(world.searches).toEqual([]);
    expect(world.reader.calls).toEqual([]);
    expect(await world.deps.state.get(SUPPLIER_DISCOVERY_NAMESPACE, THREAD)).toBeNull();
  });

  test('регион уходит в поиск словами и входит в ключ запроса', async () => {
    const world = await buildDiscoveryWorld({ hitsBySearch: [[hit(ELKA, 'Ёлка-Опт')]] });
    await findSuppliersForBase.execute(
      { query: QUERY, region: 'Казань' },
      world.deps,
      employeeContext(),
    );
    expect(world.searches[0]).toBe(`${QUERY} Казань`);
  });

  test('плановый запуск не сотрудник: отказ, поиска нет', async () => {
    const world = await buildDiscoveryWorld({ hitsBySearch: [[hit(ELKA, 'Ёлка-Опт')]] });
    await expect(
      findSuppliersForBase.execute({ query: QUERY }, world.deps, schedulerContext()),
    ).rejects.toMatchObject({ code: 'access_denied' });
    expect(world.searches).toEqual([]);
  });

  test('лимит поиска за ход: найденное остаётся, дальше limited без траты поиска', async () => {
    const world = await buildDiscoveryWorld({
      hitsBySearch: [[hit(ELKA, 'Ёлка-Опт')], [hit(DELTA, 'Дельта')]],
      pages: sitePages({
        [ELKA]: companyPage({ legal: 'ООО «Ёлка-Опт»' }),
        [DELTA]: companyPage({ legal: 'ООО «Дельта-Игрушки»' }),
      }),
    });
    world.deps.webSearchLimiter = new WebSearchLimiter({
      clock: world.deps.clock,
      maxPerTurn: 1,
    });
    const first = await findAll(world);
    expect(first.status).toBe('found');
    expect(first.shown).toHaveLength(1);
    const second = await findAll(world);
    expect(second.status).toBe('limited');
    expect(second.message).toContain('Лимит поиска');
    // Отказанный поиск не засчитан: после восстановления лимита он доступен.
    expect(second.searchesDone).toBe(first.searchesDone);
    expect(world.searches).toHaveLength(1);
  });

  test('порция не больше десяти, а число кандидатов не превышает запрошенное', async () => {
    const names = Array.from({ length: 12 }, (_, index) => `toy${index}.test`);
    const world = await buildDiscoveryWorld({
      hitsBySearch: [names.map((host) => hit(host, host))],
      pages: sitePages(
        Object.fromEntries(names.map((host) => [host, companyPage({ legal: `ООО «${host}»` })])),
      ),
    });
    const out = await findAll(world);
    expect(DISCOVERY_PAGE_SIZE).toBe(10);
    expect(out.shown.length).toBeLessThanOrEqual(DISCOVERY_PAGE_SIZE);
    await expect(findAll(world, QUERY, DISCOVERY_PAGE_SIZE + 1)).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });
});

describe('разбор страницы: только подтверждённое текстом', () => {
  const facts = (text: string, name = 'Ёлка-Опт') =>
    deriveDiscoveredFacts({ texts: [text], candidateName: name, domain: ELKA, query: QUERY });

  test('значения со страницы: юрлицо, ИНН, телефон, ролевая почта, город, категория', () => {
    const found = facts(ELKA_TEXT);
    expect(found.name).toBe('ООО «Ёлка-Опт»');
    expect(found.nameConfirmed).toBe(true);
    expect(found.inn).toBe(INN_ALPHA);
    expect(found.phones.join(' ')).toContain('843');
    expect(found.emails).toEqual([`info@${ELKA}`]);
    expect(found.city).toBe('Казань');
    expect(found.categories).toEqual([QUERY]);
  });

  test('ИНН с неверной контрольной суммой и ИНН из 12 цифр отбрасываются', () => {
    const broken = `${INN_ALPHA.slice(0, 9)}0`;
    expect(facts(companyPage({ legal: 'ООО «Тест»', inn: broken })).inn).toBeUndefined();
    expect(facts(companyPage({ legal: 'ООО «Тест»', inn: '500100732259' })).inn).toBeUndefined();
    expect(facts(companyPage({ legal: 'ООО «Тест»' })).inn).toBeUndefined();
  });

  test('нет в тексте - нет в факте: город, телефон, почта, категория пусты', () => {
    const found = facts('ООО «Тест-Поставщик». Контакты уточняйте по запросу.');
    expect(found.city).toBeUndefined();
    expect(found.phones).toEqual([]);
    expect(found.emails).toEqual([]);
    expect(found.categories).toEqual([]);
  });

  test('название ИП с ФИО не берётся: название по домену, ФИО не извлекается', () => {
    const found = facts('ИП Петров Пётр Петрович. Тел. +7 843 555-01-02.', 'ИП Петров Пётр');
    expect(found.name).toBe('Elka opt (elka-opt.test)');
    expect(found.nameConfirmed).toBe(false);
    expect(JSON.stringify(found)).not.toContain('Петров');
  });

  test('заголовок выдачи берётся названием, только если он есть в тексте', () => {
    expect(facts('Игрушки на «Ёлка-Опт»: контакты.', 'Ёлка-Опт').nameConfirmed).toBe(true);
    expect(facts('Контакты уточняйте.', 'Ёлка-Опт').nameConfirmed).toBe(false);
  });

  test('личные и бесплатные почты не берутся, ролевые корпоративные - берутся', () => {
    expect(isCorporateRoleMailbox('info@elka-opt.test')).toBe(true);
    expect(isCorporateRoleMailbox('Sales.Opt@elka-opt.test')).toBe(true);
    expect(isCorporateRoleMailbox('zakaz2@elka-opt.test')).toBe(true);
    expect(isCorporateRoleMailbox('ivanov@elka-opt.test')).toBe(false);
    expect(isCorporateRoleMailbox('i.ivanov@elka-opt.test')).toBe(false);
    expect(isCorporateRoleMailbox('info@gmail.com')).toBe(false);
    expect(isCorporateRoleMailbox('info@mail.ru')).toBe(false);
  });

  test('категория: все слова запроса по основе, окончания не важны', () => {
    expect(categoryConfirmed(QUERY, 'Продаём ёлочных игрушек оптом')).toBe(true);
    expect(categoryConfirmed(QUERY, 'Продаём игрушки')).toBe(false);
    expect(categoryConfirmed('', 'любой текст')).toBe(false);
  });

  test('выжимка для записи содержит только подтверждённые факты строками', () => {
    const found = facts(ELKA_TEXT);
    const evidence = buildEvidence({
      facts: found,
      website: `https://${ELKA}`,
      sourceUrl: `https://${ELKA}/catalog`,
    });
    expect(evidence).toContain('ООО «Ёлка-Опт»');
    expect(evidence).toContain(`ИНН ${INN_ALPHA}`);
    expect(evidence).toContain(`Почта: info@${ELKA}`);
    expect(evidence).toContain('г. Казань');
    for (const secret of ['Руководов', 'ivanov@', '917']) expect(evidence).not.toContain(secret);
  });
});

test('идентификатор сотрудника в тестовой сборке задан', () => {
  expect(EMPLOYEE.length).toBeGreaterThan(0);
});
