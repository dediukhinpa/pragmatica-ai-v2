import { beforeEach, describe, expect, test } from 'bun:test';
import { MemoryPriceRepository } from '../../src/kit/adapters/memory/repositories.owned';
import {
  askManagerToChoose,
  buildChoiceMessage,
} from '../../src/agents/order-calc/ask-manager-to-choose';
import { buildShortlist } from '../../src/agents/order-calc/build-shortlist';
import { findDigitSeries } from '@business-ai/core';
import { loadProposal } from '../../src/agents/order-calc/state';
import { searchKnowledgeSuppliers, searchWeb } from '../../src/agents/order-calc/search-sources';
import type { ShortlistProposal } from '../../src/kit/domain/shortlist';
import { marketView } from '../../src/agents/order-calc/shortlist-message';
import { CTX } from './support';
import { REQUEST_ID, buildOrderDeps, type OrderTestDeps } from './order-support';

/** Телефон и город основного контакта: в сообщение менеджеру попадают, в модель - нет. */
/** Дата прайса в тестах. */
const CREATED_AT = '2026-01-01T00:00:00.000Z';
const PHONE = '+79990001122';
const CITY = 'Казань';

let deps: OrderTestDeps;

beforeEach(async () => {
  deps = await buildOrderDeps();
});

async function addPricedSupplier(id: string, name: string, price: number): Promise<void> {
  await deps.suppliers.upsert({ id, name });
  await deps.prices.saveImport(
    id,
    [{ supplierId: id, productName: 'Арматура 12 мм', price, currency: 'RUB', date: CREATED_AT }],
    `seed-${id}`,
  );
}

async function rateFirstSupplier(): Promise<void> {
  await deps.suppliers.saveCard({
    id: 's1',
    name: 'МеталлТорг',
    status: 'active',
    contacts: [
      { fullName: 'Петров Пётр', phone: PHONE, email: 'sales@metall.test', isPrimary: true },
    ],
    supplies: { categories: [], brands: [], regions: [] },
    terms: { leadTime: '3-5 дней' },
    notes: [],
    productionCity: CITY,
    address: 'ул. Складская, 5',
    defectRatePercent: 2,
  });
}

async function build(): Promise<{ version: string; proposal: ShortlistProposal }> {
  const input = { requestId: REQUEST_ID };
  await searchKnowledgeSuppliers.execute(input, deps, CTX);
  await searchWeb.execute(input, deps, CTX);
  const out = await buildShortlist.execute(input, deps, CTX);
  const proposal = await loadProposal(deps, REQUEST_ID);
  if (proposal === null) throw new Error('шорт-лист не сохранён');
  return { version: out.version, proposal };
}

const lines = (text: string): string[] => text.split('\n');

describe('сообщение менеджеру: две средние', () => {
  test('две цены - среднее считается (порога нет), подписано число поставщиков', async () => {
    const { proposal } = await build();
    expect(proposal.market).toMatchObject({ status: 'ok', found: 2 });
    const text = buildChoiceMessage(proposal).text;
    expect(text).toContain('[B]Средняя цена по нашей базе:[/B] Арматура — 50 ₽ (2 поставщика)');
    expect(text).not.toContain('Недостаточно цен');
    expect(text).not.toContain('среднее арифметическое');
  });

  test('цен достаточно - среднее считает код, подписан разброс', async () => {
    await addPricedSupplier('s4', 'Третий', 40);
    await addPricedSupplier('s5', 'Четвёртый', 60);
    const { proposal } = await build();
    expect(proposal.market).toMatchObject({ status: 'ok', found: 4 });
    const text = buildChoiceMessage(proposal).text;
    expect(text).toContain(
      '[B]Средняя цена по нашей базе:[/B] Арматура — 50 ₽ (4 поставщика, от 40 до 60 ₽)',
    );
  });

  test('по интернету нет цен - «нет данных», по базе при этом считается', async () => {
    const { proposal } = await build();
    expect(proposal.webMarket).toEqual({ status: 'none' });
    const text = buildChoiceMessage(proposal).text;
    expect(text).toContain('[B]Средняя цена по интернету:[/B] нет данных');
  });

  test('цен базы нет вовсе - «нет данных»', async () => {
    deps.prices = new MemoryPriceRepository();
    const { proposal } = await build();
    expect(proposal.market).toEqual({ status: 'none' });
    expect(buildChoiceMessage(proposal).text).toContain(
      '[B]Средняя цена по нашей базе:[/B] нет данных',
    );
  });

  test('несколько позиций - заголовок и по строке на позицию, одна позиция - одной строкой', () => {
    const view = marketView(
      {
        status: 'ok',
        found: 18,
        groups: [
          { item: 'мёд', currency: 'RUB', n: 10, average: 396.66, min: 122.4, max: 905 },
          { item: 'орехи', currency: 'RUB', n: 8, average: 1431.9, min: 290.36, max: 6121.36 },
        ],
      },
      { status: 'none' },
    );
    expect(view.base).toEqual([
      '[B]Средняя цена по нашей базе[/B]',
      '• мёд — 396,66 ₽ (10 поставщиков, от 122,40 до 905 ₽)',
      '• орехи — 1 431,90 ₽ (8 поставщиков, от 290,36 до 6 121,36 ₽)',
    ]);
    expect(view.web).toEqual(['[B]Средняя цена по интернету:[/B] нет данных']);
  });

  test('по интернету: одна цена - одна строка; разные валюты - отдельные строки списка', () => {
    const view = marketView(
      { status: 'none' },
      {
        status: 'ok',
        found: 3,
        groups: [
          { currency: 'RUB', unit: 'шт', n: 1, average: 120, min: 120, max: 120 },
          { currency: 'USD', unit: 'шт', n: 2, average: 3, min: 2, max: 4 },
        ],
      },
    );
    expect(view.web).toEqual([
      '[B]Средняя цена по интернету[/B]',
      '• 120 ₽/шт (1 поставщик) (ИЗ ИНТЕРНЕТА)',
      '• 3 USD/шт (2 поставщика, от 2 до 4 USD/шт) (ИЗ ИНТЕРНЕТА)',
    ]);
  });

  test('без BB-кодов (таблица Excel): тот же текст без [B]', () => {
    const view = marketView({ status: 'none' }, { status: 'none' }, 0, false, false, true);
    expect(view.base).toEqual(['Средняя цена по нашей базе: нет данных']);
  });

  test('по интернету при нескольких позициях: нет данных по позициям, а не смесь', () => {
    const view = marketView({ status: 'none' }, { status: 'none' }, 2);
    expect(view.web[0]).toContain('[B]Средняя цена по интернету:[/B] нет данных (несколько');
  });

  test('пометка оценки снизу - короткой строкой под средними, только если применима', () => {
    const lower = marketView(
      {
        status: 'ok',
        found: 1,
        groups: [{ currency: 'RUB', n: 1, average: 10, min: 10, max: 10, lowerBound: true }],
      },
      { status: 'none' },
    );
    expect(lower.note).toBe('Оценка снизу: учтены только цены «от» и диапазоны.');
    expect(marketView({ status: 'none' }, { status: 'none' }).note).toBe('');
  });

  test('обе средние стоят перед списком поставщиков, шапка с названием заявки', async () => {
    const { proposal } = await build();
    const all = lines(buildChoiceMessage(proposal).text);
    expect(all[0]).toBe('[B]Шорт-лист поставщиков[/B]');
    expect(all[1]).toBe('Заявка: [B]заявка[/B]');
    const base = all.findIndex((line) => line.startsWith('[B]Средняя цена по нашей базе'));
    const web = all.findIndex((line) => line.startsWith('[B]Средняя цена по интернету'));
    const first = all.findIndex((line) => line.includes('Поставщик:'));
    expect(base).toBeGreaterThanOrEqual(0);
    expect(web).toBeGreaterThan(base);
    expect(web).toBeLessThan(first);
  });

  test('запись без поля market - «не рассчитывалась», а не «нет данных»', async () => {
    const { proposal } = await build();
    const { market: _ignored, ...old } = proposal;
    const text = buildChoiceMessage(old).text;
    expect(text).toContain('[B]Средняя цена по нашей базе:[/B] не рассчитывалась');
  });
});

describe('сообщение менеджеру: строки поставщиков', () => {
  test('все колонки ТЗ показаны всегда, пустое - «нет данных»', async () => {
    const { proposal } = await build();
    const all = lines(buildChoiceMessage(proposal).text);
    const start = all.findIndex((line) => line.includes('Поставщик: Болтик'));
    const labels = all.slice(start + 1, start + 6).map((line) => line.trim().split(':')[0]);
    expect(labels).toEqual(['Стоимость', 'Срок', 'Рейтинг', 'Город', 'Контакты']);
    // Подпись цены - товар из прайса поставщика, а не позиция заявки
    expect(all[start + 1]).toContain('Арматура 12 мм: 50 ₽');
    expect(all[start + 2]).toContain('Срок: нет данных');
    expect(all[start + 3]).toContain('Рейтинг: нет данных');
    expect(all[start + 4]).toContain('Город: нет данных');
    expect(all[start + 5]).toContain('info@boltik.test');
    expect(buildChoiceMessage(proposal).text).not.toContain('не указано');
  });

  test('данные карточки: город, контакты, срок, рейтинг считается кодом', async () => {
    await rateFirstSupplier();
    const { proposal } = await build();
    const text = buildChoiceMessage(proposal).text;
    expect(text).toContain(`Город: ${CITY} (ул. Складская, 5)`);
    expect(text).toContain(`Контакты: Петров Пётр, ${PHONE}, sales@metall.test`);
    expect(text).toContain('Срок: 3-5 дней');
    // Действующий (4) + брак 2% (0) + полнота: контакт, место, срок (+0,5).
    expect(text).toContain('Рейтинг: 4,5 из 5 (по правилу)');
  });

  test('веб-кандидат без сведений: пять строк «нет данных» и ссылка на сайт', async () => {
    const { proposal } = await build();
    const web = lines(buildChoiceMessage(proposal).text);
    const at = web.findIndex((line) => line.includes('Поставщик: Арматура-Центр'));
    expect(web[at]).toContain('(ИЗ ИНТЕРНЕТА)');
    expect(web.slice(at + 1, at + 6)).toEqual([
      '   Стоимость: нет данных',
      '   Срок: нет данных',
      '   Рейтинг: нет данных',
      '   Город: нет данных',
      '   Контакты: нет данных',
    ]);
    expect(web[at + 6]).toMatch(/Сайт: https?:\/\//u);
  });

  test('список нумерован, без кнопок, подсказка ответа жирным', async () => {
    await rateFirstSupplier();
    const { version, proposal } = await build();
    const message = buildChoiceMessage(proposal);
    expect(message.buttons).toBeUndefined();
    const numbered = lines(message.text).filter((line) => /^\d+\. Поставщик: /u.test(line));
    expect(numbered).toHaveLength(proposal.entries.length);
    expect(message.text).toContain('«берём 1 и 3»');
    const ask = await askManagerToChoose.execute({ requestId: REQUEST_ID, version }, deps, CTX);
    expect(ask).toEqual({ asked: true });
    // После сообщения уходит файл Excel: проверяем само сообщение, а не последнюю запись.
    const sent = deps.chat.outbox.filter((record) => record.message !== undefined);
    expect(JSON.stringify(sent[0])).toContain(PHONE);
    // Вопрос выбора - отдельным последним сообщением (этап 171).
    expect(sent[1]?.message?.text).toContain('[B]Кому готовить запросы?[/B]');
  });
});

describe('ПДн: в модель контакты и цены не уходят', () => {
  test('результат buildShortlist - агрегаты и флаги', async () => {
    await rateFirstSupplier();
    await addPricedSupplier('s4', 'Третий', 40);
    const input = { requestId: REQUEST_ID };
    await searchKnowledgeSuppliers.execute(input, deps, CTX);
    await searchWeb.execute(input, deps, CTX);
    const out = await buildShortlist.execute(input, deps, CTX);
    const json = JSON.stringify(out);
    for (const secret of [PHONE, CITY, 'sales@metall.test', 'Петров', '3-5 дней', '4,5']) {
      expect(json).not.toContain(secret);
    }
    // `version` - шестнадцатеричный отпечаток: он меняется от состава строк, и в нём бывают
    // десять цифр подряд случайно (после поля webFields так и вышло). Это не число из данных.
    expect(findDigitSeries(JSON.stringify({ ...out, version: '' }))).toEqual([]);
    expect(out.marketStatus).toBe('ok');
    expect(out.pricesFound).toBe(3);
    const metall = out.entries.find((entry) => entry.supplierId === 's1');
    expect(metall).toMatchObject({ hasEmail: true, hasPrice: true, hasRating: true });
    const web = out.entries.find((entry) => entry.supplierId.startsWith('ext-'));
    expect(web).toMatchObject({ hasPrice: false, hasRating: false });
  });

  test('дробное среднее не попадает в вывод для модели', async () => {
    await addPricedSupplier('s4', 'Третий', 33.333333);
    const input = { requestId: REQUEST_ID };
    await searchKnowledgeSuppliers.execute(input, deps, CTX);
    const out = await buildShortlist.execute(input, deps, CTX);
    expect(JSON.stringify(out)).not.toMatch(/\d\.\d{3,}/);
  });
});

describe('сообщение менеджеру: тиражи', () => {
  const TIERS = [
    { minQuantity: 50, price: 120 },
    { minQuantity: 100, price: 100 },
  ];

  test('цены по тиражам видны в строке поставщика, средняя по минимальному тиражу подписана', async () => {
    await deps.prices.saveImport(
      's1',
      [
        {
          supplierId: 's1',
          productName: 'Арматура 12 мм',
          price: 120,
          currency: 'RUB',
          date: CREATED_AT,
          priceTiers: TIERS,
        },
      ],
      'seed-tiers-s1',
    );
    const { proposal } = await build();
    const text = buildChoiceMessage(proposal).text;
    expect(text).toContain('от 50 шт — 120 ₽, от 100 — 100 ₽');
    expect(text).toContain('Для позиций с тиражами взята цена минимального тиража.');
    // В среднее идёт цена минимального тиража (120), а не меньшая цена большого тиража.
    expect(text).toMatch(/Арматура — [^\n]*\(2 поставщика/);
  });

  test('без тиражей подписи про тиражи нет', async () => {
    const { proposal } = await build();
    const text = buildChoiceMessage(proposal).text;
    expect(text).not.toContain('тираж');
  });
});

describe('сообщение менеджеру: тиражи от суммы заказа', () => {
  const SUM_TIERS = [
    { minQuantity: 62000, price: 1200 },
    { minQuantity: 102000, price: 1100 },
  ];

  test('порог показан суммой заказа, не штуками; скидка по сумме не применяется', async () => {
    await deps.prices.saveImport(
      's1',
      [
        {
          supplierId: 's1',
          productName: 'Арматура 12 мм',
          price: 1200,
          currency: 'RUB',
          date: CREATED_AT,
          priceTiers: SUM_TIERS,
          priceTierBasis: 'order_sum',
        },
      ],
      'seed-sum-s1',
    );
    const { proposal } = await build();
    const text = buildChoiceMessage(proposal).text;
    expect(text).toContain('от заказа на 62 000 \u20BD \u2014 1 200 \u20BD');
    expect(text).toContain('от заказа на 102 000 \u20BD \u2014 1 100 \u20BD');
    expect(text).not.toContain('62000 шт');
    expect(text).not.toContain('от 62 000 шт');
    expect(text).toContain('Скидки от суммы заказа в среднюю не входят.');
  });
});

describe('сообщение менеджеру: цена словами и тираж из ячейки', () => {
  const save = (key: string, extra: Record<string, unknown>) =>
    deps.prices.saveImport(
      's1',
      [
        {
          supplierId: 's1',
          productName: 'Арматура 12 мм',
          price: 120,
          currency: 'RUB',
          date: CREATED_AT,
          ...extra,
        },
      ],
      key,
    );

  test('«от» и диапазон видны в строке поставщика, но в среднюю не входят', async () => {
    await save('seed-from-s1', { priceQualifier: 'from' });
    const { proposal } = await build();
    const text = buildChoiceMessage(proposal).text;
    expect(text).toContain('от 120 ₽');
    await save('seed-range-s1', { priceQualifier: 'range', priceMax: 150 });
    const range = buildChoiceMessage((await build()).proposal).text;
    expect(range).toContain('120–150 ₽');
  });

  test('один тираж из ячейки показан как «от 100 шт — 45 ₽»', async () => {
    await save('seed-one-tier-s1', { price: 45, priceTiers: [{ minQuantity: 100, price: 45 }] });
    const text = buildChoiceMessage((await build()).proposal).text;
    expect(text).toContain('от 100 шт — 45 ₽');
    expect(text).not.toContain('45 ₽ (от 100 шт');
  });
});
