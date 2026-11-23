import { describe, expect, test } from 'bun:test';
import { CONFIRM_CARD_DENIED_TEXT } from '../../src/agents/suppliers/confirm-card-right';
import { confirmSupplierRequest } from '../../src/agents/suppliers/card-decision';
import {
  cardRequestSchema,
  type SupplierCardRequest,
} from '../../src/agents/suppliers/card-request';
import { SUPPLIER_CARD_REQUEST_NAMESPACE } from '../../src/agents/suppliers/deps';
import {
  DISCOVERY_PREPARE_MAX,
  findSuppliersForBase,
  prepareDiscoveredSupplierCards,
} from '../../src/supplier-discovery';
import {
  SUPPLIER_DISCOVERY_NAMESPACE,
  loadDiscoveryState,
  saveDiscoveryState,
} from '../../src/supplier-discovery-state';
import {
  INN_ALPHA,
  INN_BETA,
  INN_BROKEN,
  THREAD,
  buildDiscoveryWorld,
  companyPage,
  employeeContext,
  hit,
  requestCount,
  schedulerContext,
  shownCards,
  sitePages,
  type DiscoveryWorld,
} from './supplier-discovery-support';

/**
 * Пополнение базы: «заведи 1, 3, 5» (этап 8z, раздел B). Карточка показывается существующим
 * путём `prepareSupplierCard`, поля - только из подтверждённого страницей. Данные синтетические.
 */

const QUERY = 'ёлочные игрушки';
const ELKA = 'elka-opt.test';
const SHAR = 'shar-market.test';
const SNEG = 'snegurka.test';
const PHONE = '+7 843 555-01-02';
const ELKA_URL = `https://${ELKA}/catalog`;
/** Двенадцатизначный ИНН физлица с верной суммой (из тестов инварианта цифр). */
const INN_PERSON = '500100732259';

const ELKA_TEXT = companyPage({
  legal: 'ООО «Ёлка-Опт»',
  city: 'Казань',
  phone: PHONE,
  mailbox: `info@${ELKA}`,
  inn: INN_ALPHA,
  extra: `Директор Руководов Иван Петрович, личная почта ivanov@${ELKA}, моб. +7 917 000-11-22.`,
});

/** Мир с найденными кандидатами: Ёлка-Опт (полная страница), Шар-Маркет и Снегурка (бедные). */
async function worldWithList(extra: Record<string, string> = {}): Promise<DiscoveryWorld> {
  const world = await buildDiscoveryWorld({
    hitsBySearch: [
      [
        hit(ELKA, 'Ёлка-Опт', 'Ёлочные игрушки', '/catalog'),
        hit(SHAR, 'Шар-Маркет'),
        hit(SNEG, 'Снегурка'),
      ],
    ],
    pages: sitePages({
      [ELKA]: ELKA_TEXT,
      [SHAR]: 'ООО «Шар-Маркет». Контакты уточняйте по запросу.',
      [SNEG]: companyPage({ legal: 'ООО «Снегурка»', city: 'Пермь' }),
      ...extra,
    }),
  });
  await findSuppliersForBase.execute({ query: QUERY }, world.deps, employeeContext());
  return world;
}

async function requestOf(world: DiscoveryWorld, requestId: string): Promise<SupplierCardRequest> {
  const raw = await world.deps.state.get(SUPPLIER_CARD_REQUEST_NAMESPACE, requestId);
  return cardRequestSchema.parse(raw);
}

async function prepare(world: DiscoveryWorld, numbers: number[]) {
  return prepareDiscoveredSupplierCards.execute({ numbers }, world.deps, employeeContext());
}

describe('prepareDiscoveredSupplierCards: поля только из подтверждённого', () => {
  test('карточка из страницы: сайт, контакты, ИНН, город, категория, URL источника', async () => {
    const world = await worldWithList();
    const out = await prepare(world, [1]);
    expect(out.status).toBe('shown');
    const [result] = out.results;
    expect(result?.status).toBe('shown');
    const request = await requestOf(world, result?.requestId ?? '');
    const fields = request.fields;
    expect(fields?.name).toBe('ООО «Ёлка-Опт»');
    expect(fields?.website).toBe(`https://${ELKA}`);
    expect(fields?.inn).toBe(INN_ALPHA);
    expect(fields?.productionCity).toBe('Казань');
    expect(fields?.categories).toEqual([QUERY]);
    expect(fields?.contacts?.[0]?.email).toBe(`info@${ELKA}`);
    expect(fields?.contacts?.[0]?.phone).toContain('843');
    // Адрес источника - в заметке карточки; записать её можно только по ответу сотрудника.
    expect(fields?.note).toContain(ELKA_URL);
    expect(request.source).toBe('chat');
    expect(request.status).toBe('shown');
    const [card] = shownCards(world.deps);
    expect(card).toContain('Название: ООО «Ёлка-Опт»');
    expect(card).toContain(`ИНН: ${INN_ALPHA}`);
    expect(card).toContain(`Заметка: Найден в интернете по запросу «${QUERY}»`);
    expect(card).toContain(ELKA_URL);
    // В базе пока ничего нет: запись только после «да».
    expect(await world.deps.suppliers.searchCards({ query: 'Ёлка', limit: 5 })).toEqual([]);
  });

  test('ПДн сотрудников не попадают в карточку: ФИО, должность, личная почта, моб.', async () => {
    const world = await worldWithList();
    const out = await prepare(world, [1]);
    const request = await requestOf(world, out.results[0]?.requestId ?? '');
    const dump = JSON.stringify(request) + shownCards(world.deps).join('\n');
    for (const secret of ['Руководов', 'Директор', 'ivanov@', '917', 'личная']) {
      expect(dump).not.toContain(secret);
    }
    // Модели - статусы и предупреждения без значений: серий цифр и адресов нет.
    const forModel = JSON.stringify(out);
    expect(/\d{10,}/.test(forModel)).toBe(false);
    expect(forModel).not.toContain('@');
  });

  test('ИНН с неверной контрольной суммой не попадает в карточку', async () => {
    const world = await buildDiscoveryWorld({
      hitsBySearch: [[hit(SHAR, 'Шар-Маркет', 'Ёлочные игрушки')]],
      pages: sitePages({
        [SHAR]: companyPage({ legal: 'ООО «Шар-Маркет»', phone: PHONE, inn: INN_BROKEN }),
      }),
    });
    await findSuppliersForBase.execute({ query: QUERY }, world.deps, employeeContext());
    const out = await prepare(world, [1]);
    const request = await requestOf(world, out.results[0]?.requestId ?? '');
    expect(request.fields?.inn).toBeUndefined();
    expect(request.fields?.contacts?.[0]?.phone).toContain('843');
    const dump = JSON.stringify(request) + shownCards(world.deps).join('\n');
    expect(dump).not.toContain(INN_BROKEN);
    expect(shownCards(world.deps)[0]).not.toContain('ИНН:');
  });

  test('ИНН физлица (12 цифр) и название ИП в карточку не идут', async () => {
    const world = await buildDiscoveryWorld({
      hitsBySearch: [[hit(SHAR, 'ИП Петров Пётр', 'Ёлочные игрушки')]],
      pages: sitePages({
        [SHAR]: `ИП Петров Пётр Петрович. ИНН ${INN_PERSON}. Тел. ${PHONE}. Ёлочные игрушки.`,
      }),
    });
    await findSuppliersForBase.execute({ query: QUERY }, world.deps, employeeContext());
    const out = await prepare(world, [1]);
    const request = await requestOf(world, out.results[0]?.requestId ?? '');
    expect(request.fields?.inn).toBeUndefined();
    expect(request.fields?.name).toBe('Shar market (shar-market.test)');
    const dump = JSON.stringify(request) + shownCards(world.deps).join('\n');
    expect(dump).not.toContain('Петров');
    expect(dump).not.toContain(INN_PERSON);
  });

  test('поле без подтверждения текстом пусто: нет страницы - только название и сайт', async () => {
    const world = await worldWithList();
    const out = await prepare(world, [2]);
    const request = await requestOf(world, out.results[0]?.requestId ?? '');
    const fields = request.fields;
    expect(fields?.name).toBe('ООО «Шар-Маркет»');
    expect(fields?.website).toBe(`https://${SHAR}`);
    for (const empty of ['inn', 'contacts', 'productionCity', 'categories'] as const) {
      expect(fields?.[empty]).toBeUndefined();
    }
    // Предупреждения напоминают, чего нет: ИНН и контактов.
    expect(out.results[0]?.warnings.join(' ')).toContain('ИНН не указан');
  });

  test('значение, которого нет в выжимке источника, отбрасывается при записи', async () => {
    const world = await worldWithList();
    const now = world.deps.clock.now();
    const state = await loadDiscoveryState(world.deps.state, THREAD, now);
    const shar = state?.candidates.find((item) => item.name === 'ООО «Шар-Маркет»');
    if (state === null || shar === undefined) throw new Error('нет состояния');
    // Порча состояния: факты, не подтверждённые выжимкой (ИНН с верной суммой и телефон).
    shar.inn = INN_BETA;
    shar.phones = ['+7 495 000-11-22'];
    await saveDiscoveryState(world.deps.state, THREAD, state);
    const out = await prepare(world, [shar.number]);
    const request = await requestOf(world, out.results[0]?.requestId ?? '');
    expect(request.fields?.inn).toBeUndefined();
    expect(request.fields?.contacts).toBeUndefined();
    expect(out.results[0]?.warnings.join(' ')).toContain('value_not_in_source');
  });
});

describe('prepareDiscoveredSupplierCards: права, номера, записи', () => {
  test('без права записи - отказ прежним текстом ДО показа карточек; поиск доступен', async () => {
    const world = await worldWithList();
    world.deps.access.mode = 'deny';
    await expect(prepare(world, [1, 2])).rejects.toMatchObject({
      code: 'access_denied',
      message: CONFIRM_CARD_DENIED_TEXT,
    });
    expect(shownCards(world.deps)).toEqual([]);
    expect(await requestCount(world.deps)).toBe(0);
    // Сбой справочника руководителей - временный отказ, а не «вы не руководитель».
    world.deps.access.mode = 'down';
    await expect(prepare(world, [1])).rejects.toMatchObject({ code: 'access_denied' });
    expect(await requestCount(world.deps)).toBe(0);
    // Искать кандидатов может любой сотрудник, в том числе без права записи.
    world.deps.access.mode = 'deny';
    const found = await findSuppliersForBase.execute(
      { query: 'гирлянды' },
      world.deps,
      employeeContext(),
    );
    expect(found.status).toBe('none');
  });

  test('без политики прав запись запрещена: карточки не показываются', async () => {
    const world = await worldWithList();
    if (world.deps.supplierCards !== undefined) world.deps.supplierCards.access = undefined;
    await expect(prepare(world, [1])).rejects.toMatchObject({ code: 'access_denied' });
    expect(await requestCount(world.deps)).toBe(0);
  });

  test('номер вне списка или не показанный: ничего не показывается, даже верные', async () => {
    const world = await worldWithList();
    const outside = await prepare(world, [1, 9]);
    expect(outside.status).toBe('invalid_numbers');
    expect(outside.message).toContain('9');
    expect(outside.results).toEqual([]);
    expect(shownCards(world.deps)).toEqual([]);
    // Найденный, но не показанный кандидат тоже не номер из списка.
    const state = await loadDiscoveryState(world.deps.state, THREAD, world.deps.clock.now());
    const last = state?.candidates.at(-1);
    if (state === null || last === undefined) throw new Error('нет состояния');
    last.shown = false;
    await saveDiscoveryState(world.deps.state, THREAD, state);
    const hidden = await prepare(world, [last.number]);
    expect(hidden.status).toBe('invalid_numbers');
    expect(await requestCount(world.deps)).toBe(0);
  });

  test('списка нет или он устарел: «сначала найдите поставщиков»', async () => {
    const world = await buildDiscoveryWorld({ hitsBySearch: [] });
    const none = await prepare(world, [1]);
    expect(none.status).toBe('no_list');
    const listed = await worldWithList();
    listed.deps.clock.advance(7 * 3_600_000);
    expect((await prepare(listed, [1])).status).toBe('no_list');
    expect(shownCards(listed.deps)).toEqual([]);
  });

  test('плановый запуск и лишние номера отклоняются', async () => {
    const world = await worldWithList();
    await expect(
      prepareDiscoveredSupplierCards.execute({ numbers: [1] }, world.deps, schedulerContext()),
    ).rejects.toMatchObject({ code: 'access_denied' });
    const tooMany = Array.from({ length: DISCOVERY_PREPARE_MAX + 1 }, (_, index) => index + 1);
    await expect(prepare(world, tooMany)).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(prepare(world, [])).rejects.toMatchObject({ code: 'invalid_input' });
  });

  test('несколько номеров: свой requestId у каждой карточки, повтор номера схлопнут', async () => {
    const world = await worldWithList();
    const out = await prepare(world, [3, 1, 3]);
    expect(out.results.map((item) => item.number)).toEqual([3, 1]);
    const ids = out.results.map((item) => item.requestId);
    expect(new Set(ids).size).toBe(2);
    expect(shownCards(world.deps)).toHaveLength(2);
    expect(await requestCount(world.deps)).toBe(2);
    expect(out.message).toContain('confirmSupplierRequest');
  });

  test('запись по ответу сотрудника, а заведённый поставщик больше не предлагается', async () => {
    const world = await worldWithList();
    const out = await prepare(world, [1, 3]);
    for (const result of out.results) {
      const saved = await confirmSupplierRequest.execute(
        { decision: 'save', requestId: result.requestId ?? '' },
        world.deps,
        employeeContext('op-confirm'),
      );
      expect(saved.status).toBe('saved');
    }
    const cards = await world.deps.suppliers.searchCards({ category: QUERY, limit: 10 });
    const elka = cards.find((item) => item.name === 'ООО «Ёлка-Опт»');
    expect(cards.map((item) => item.name).sort()).toEqual(['ООО «Ёлка-Опт»', 'ООО «Снегурка»']);
    expect(elka?.website).toBe(`https://${ELKA}`);
    expect(elka?.inn).toBe(INN_ALPHA);
    expect(elka?.status).toBe('new');
    expect(elka?.notes[0]?.text).toContain(ELKA_URL);
    // Новый запрос: те же сайты теперь известны базе и отсеиваются до чтения страниц.
    const again = await buildDiscoveryWorld({
      hitsBySearch: [[hit(ELKA, 'Ёлка-Опт'), hit(SNEG, 'Снегурка'), hit(SHAR, 'Шар-Маркет')]],
      pages: sitePages({ [SHAR]: 'ООО «Шар-Маркет». Контакты по запросу.' }),
    });
    for (const card of cards) await again.deps.suppliers.saveCard(card);
    const next = await findSuppliersForBase.execute(
      { query: 'гирлянды' },
      again.deps,
      employeeContext(),
    );
    expect(next.shown.map((item) => item.name)).toEqual(['ООО «Шар-Маркет»']);
    expect(again.reader.calls.map((call) => call.host)).toEqual([SHAR]);
  });

  test('состояние записано в своё пространство имён и помечено done', async () => {
    const world = await worldWithList();
    const open = await world.deps.state.list(SUPPLIER_DISCOVERY_NAMESPACE, null, 10, {
      openOnly: true,
    });
    expect(open).toEqual([]);
    expect(await world.deps.state.get(SUPPLIER_DISCOVERY_NAMESPACE, THREAD)).not.toBeNull();
  });
});
