import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { buildChoiceMessage } from '../../src/agents/order-calc/ask-manager-to-choose';
import { ORDER_CALC_MAIL_PROMPT, ORDER_CALC_PROMPT } from '../../src/agents/order-calc/prompt';
import { comparedLine } from '../../src/agents/order-calc/shortlist-message';
import type { ShortlistProposal } from '../../src/kit/domain/shortlist';

type Entry = ShortlistProposal['entries'][number];

/** Файл снимка JSON карточек; пересоздаётся запуском с `UPDATE_SNAPSHOTS=1`. */
const SNAPSHOT_PATH = new URL('../kit/fixtures/shortlist-cards-10.json', import.meta.url);
const SUPPLIERS_TOTAL = 10;
const CARD_PRICES_SHOWN = 3;

function price(amount: number, item?: string): NonNullable<Entry['prices']>[number] {
  return { amount, currency: 'RUB', unit: 'т', ...(item === undefined ? {} : { item }) };
}

/** Десять поставщиков: база с полной карточкой и без цен, веб с ценой и без сведений, черновики. */
function tenEntries(): Entry[] {
  const base = (n: number, extra: Partial<Entry>): Entry => ({
    supplierId: `s${n}`,
    name: `Поставщик ${n}`,
    sources: ['knowledge'],
    score: 1,
    references: [],
    ...extra,
  });
  return [
    base(1, {
      city: 'Казань',
      address: 'ул. Складская, 5',
      contacts: 'Иванов Иван, +70000000001, sales@one.test',
      prices: [price(60000, 'Арматура'), price(61000, 'Уголок'), price(62000, 'Швеллер')],
      leadTime: '3-5 дней',
      rating: 4.5,
      ratingSource: 'model',
      ratingRationale: 'давно работаем',
    }),
    base(2, {
      city: 'Тверь',
      prices: [price(1), price(2), price(3), price(4), price(5)],
      rating: 3.5,
    }),
    base(3, { contacts: 'info@three.test', leadTime: '7 дней' }),
    {
      ...base(4, {
        sources: ['web'],
        references: ['https://four.test/price'],
        // Происхождение хранится по полю: город, контакты и сайт взяты со страницы.
        webFields: ['city', 'contacts', 'site'],
      }),
      city: 'Пермь',
      contacts: 'тел. +70000000004',
      webPrice: { amount: 61800, currency: 'RUB', unit: 'т' },
    },
    base(5, { sources: ['web'], references: ['https://five.test/'], webFields: ['site'] }),
    base(6, {
      sources: ['knowledge', 'web'],
      references: ['https://six.test/'],
      city: 'Омск',
      // Город из карточки базы, ссылка на сайт - из интернета.
      webFields: ['site'],
    }),
    base(7, { noContacts: true, city: 'Уфа' }),
    base(8, { contacts: 'info@eight.test' }),
    base(9, {}),
    base(10, { name: 'ООО [B]Хитрый[/B]', sources: ['web'], references: ['not-a-url'] }),
  ];
}

/** Сколько кандидатов сравнивалось в тестовом предложении (в списке из десяти). */
const COMPARED = 20;

function proposalOf(entries: Entry[], truncated = 0, compared = COMPARED): ShortlistProposal {
  return {
    requestId: 'REQ-1',
    version: 'v1',
    createdAt: '2026-10-28T00:00:00.000Z',
    managerThreadId: 'mgr',
    entries,
    truncated,
    compared,
    sources: [
      { source: 'knowledge', status: 'ok' },
      { source: 'web', status: 'ok' },
    ],
    market: {
      status: 'ok',
      found: 2,
      groups: [{ currency: 'RUB', unit: 'т', n: 2, average: 60500, min: 60000, max: 61000 }],
    },
    webMarket: { status: 'none' },
  };
}

describe('шорт-лист карточками', () => {
  const message = buildChoiceMessage(proposalOf(tenEntries()));

  test('снимок JSON: десять поставщиков (база, веб, черновики, без цен)', () => {
    expect(tenEntries()).toHaveLength(SUPPLIERS_TOTAL);
    const actual = { blocksLead: message.blocksLead, blocks: message.blocks };
    if (process.env.UPDATE_SNAPSHOTS === '1' || !existsSync(SNAPSHOT_PATH)) {
      writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(actual, null, 2)}\n`);
    }
    expect(JSON.parse(JSON.stringify(actual))).toEqual(
      JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')) as unknown,
    );
  });

  test('нигде нет «не указано», ни в тексте, ни в карточках', () => {
    expect(message.text).not.toContain('не указано');
    expect(JSON.stringify(message.blocks)).not.toContain('не указано');
  });

  test('сверху обе средние, а текст-откат остаётся полным', () => {
    expect(message.blocksLead).toContain('[B]Средняя цена по нашей базе:[/B] 60 500 ₽/т');
    expect(message.blocksLead).toContain('[B]Средняя цена по интернету:[/B] нет данных');
    expect(message.text).toContain('1. Поставщик: Поставщик 1');
    expect(message.text).toContain('Можно ответить своими словами');
  });

  test('карточка: жирное имя с источником, цена primary, до 3 цен и «и ещё N»', () => {
    const blocks = message.blocks ?? [];
    expect(blocks[0]).toEqual({ kind: 'message', text: '[B]1. Поставщик 1[/B] · из базы' });
    const second = blocks.filter((block) => block.kind === 'grid')[1];
    const rows = second?.kind === 'grid' ? second.rows : [];
    const row = rows.find((r) => r.name === 'Стоимость');
    expect(row?.tone).toBe('primary');
    expect(row?.value.split('; ')).toHaveLength(CARD_PRICES_SHOWN + 1);
    expect(row?.value).toContain('и ещё 2');
  });

  test('шапка: заголовок, название заявки (не id), сколько сравнено; призыв один раз внизу', () => {
    const lead = (message.blocksLead ?? '').split('\n');
    expect(lead.slice(0, 2)).toEqual([
      '[B]Шорт-лист поставщиков[/B]',
      'Заявка: [B]заявка[/B]',
    ]);
    expect(lead[2]).not.toBe('');
    expect(lead.join('\n')).not.toContain('REQ-1');
    expect(lead.at(-1)).toBe('Из 20 сравнённых кандидатов в шорт-листе — 10.');
    for (const text of [message.text, message.blocksLead ?? '']) {
      expect(text).not.toContain('до вашего ответа');
      expect(text).not.toContain('Ещё');
      expect(text).not.toContain('не показаны');
    }
    expect(message.blocksLead).not.toContain('Можно ответить своими словами');
    expect(message.text.match(/Можно ответить своими словами/g)).toHaveLength(1);
    expect(message.text).toContain('[B]Кому готовить запросы?[/B]');
  });

  test('у каждого поставщика пять строк ТЗ всегда: пустое - «нет данных»', () => {
    const grids = (message.blocks ?? []).flatMap((block) => (block.kind === 'grid' ? [block] : []));
    for (const grid of grids) {
      const names = grid.rows.map((row) => row.name);
      expect(names.slice(0, 5)).toEqual(['Стоимость', 'Срок', 'Рейтинг', 'Город', 'Контакты']);
    }
    const nine = grids[8]?.rows ?? [];
    expect(nine.map((row) => row.value)).toEqual(Array(5).fill('нет данных'));
  });

  test('строка «сколько сравнено»: склонение, пусто при равенстве и без данных', () => {
    // M > N: часть сравнённых не вошла в десятку.
    expect(comparedLine(11, 10)).toBe('Из 11 сравнённых кандидатов в шорт-листе — 10.');
    expect(comparedLine(21, 10)).toContain('Из 21 сравнённого кандидата');
    expect(comparedLine(25, 10)).toContain('Из 25 сравнённых кандидатов');
    // M < N: интернет-кандидаты и названные добавлены после сравнения.
    expect(comparedLine(9, 10)).toBe(
      'Сравнено 9 из 10 кандидатов, остальные добавлены без сравнения ' +
        '(из интернета или по названию).',
    );
    expect(comparedLine(9, 21)).toContain('Сравнено 9 из 21 кандидата,');
    expect(comparedLine(9, 22)).toContain('из 22 кандидатов,');
    // M = N и нет данных: фразы нет.
    expect(comparedLine(10, 10)).toBeUndefined();
    expect(comparedLine(undefined, 10)).toBeUndefined();
    expect(comparedLine(9, 10)).not.toContain('отобрано');
    const same = buildChoiceMessage(proposalOf(tenEntries(), 0, SUPPLIERS_TOTAL));
    expect(same.text).not.toContain('Для сравнения');
  });

  test('черновик и «нет контактов» не помечаются; сайт - ссылкой; пустых строк нет', () => {
    const grids = (message.blocks ?? []).flatMap((block) => (block.kind === 'grid' ? [block] : []));
    const alerts = grids.map((grid) => grid.rows.filter((row) => row.tone === 'alert').length);
    expect(alerts[6]).toBe(0);
    expect(alerts[7]).toBe(0);
    expect(JSON.stringify(message)).not.toContain('нет контактов');
    expect(JSON.stringify(message)).not.toContain('не проверено, создана автоматически');
    const four = grids[3]?.rows.find((row) => row.name === 'Сайт');
    expect(four?.link).toBe('https://four.test/price');
    for (const grid of grids) {
      for (const row of grid.rows) expect(row.value.trim()).not.toBe('');
      // Пометки черновика идут после реквизитов.
      const names = grid.rows.map((row) => row.name);
      const firstAlert = names.indexOf('Внимание');
      if (firstAlert !== -1) expect(names.slice(0, 5)).toContain('Контакты');
    }
    // Ссылка не http(s) (id документа) в «Сайт» не попадает.
    expect(grids[9]?.rows.some((row) => row.name === 'Сайт')).toBe(false);
  });

  test('BB-коды из названия поставщика обезврежены', () => {
    const last = (message.blocks ?? []).filter((block) => block.kind === 'message').at(-1);
    expect(last).toEqual({ kind: 'message', text: '[B]10. ООО (B)Хитрый(/B)[/B] · ИЗ ИНТЕРНЕТА' });
  });

  test('между карточками разделитель, призыва в вложении нет', () => {
    const blocks = message.blocks ?? [];
    expect(blocks.filter((block) => block.kind === 'delimiter')).toHaveLength(SUPPLIERS_TOTAL);
    // Вопрос выбора не в вложении (этап 171): последний блок - разделитель.
    expect(blocks.at(-1)?.kind).toBe('delimiter');
    expect(JSON.stringify(blocks)).not.toContain('Можно ответить своими словами');
  });

  test('флаг выключен - только текст, без блоков', () => {
    const plain = buildChoiceMessage(proposalOf(tenEntries()), false);
    expect(plain.blocks).toBeUndefined();
    expect(plain.blocksLead).toBeUndefined();
    expect(plain.text).toBe(message.text);
  });

  test('пустая выдача - без карточек, с заголовком и названием заявки', () => {
    const empty = buildChoiceMessage(proposalOf([]));
    expect(empty.blocks).toBeUndefined();
    expect(empty.text.split('\n').slice(0, 2)).toEqual([
      '[B]Шорт-лист поставщиков[/B]',
      'Заявка: [B]заявка[/B]',
    ]);
    expect(empty.text.split('\n')[2]).toBe('Подходящих поставщиков не нашлось.');
  });

  test('название заявки попадает в шапку вместо идентификатора', () => {
    const named = buildChoiceMessage(proposalOf(tenEntries()), true, 'мёд с орехами');
    expect((named.blocksLead ?? '').split('\n')[1]).toBe('Заявка: [B]мёд с орехами[/B]');
    expect(named.text).not.toContain('REQ-1');
  });
});

describe('промпт order-calc: итоговая фраза после вопроса менеджеру', () => {
  test.each([
    ['обычный', ORDER_CALC_PROMPT],
    ['с почтой', ORDER_CALC_MAIL_PROMPT],
  ])('%s: запрещена фраза про «ничего не записываю», пересказ шорт-листа и есть сохранение', (
    _name,
    source,
  ) => {
    // Промпт перенесён по строкам, поэтому сравниваем с одинарными пробелами.
    const prompt = source.replace(/\s+/g, ' ');
    expect(prompt).toContain('Не пиши фразу «Пока вы не ответите, я ничего не записываю');
    expect(prompt).toContain('не пересказывай содержимое шорт-листа целиком');
    // Этап 162: одна фраза, без повтора вопроса выбора и напоминания (их строит код).
    expect(prompt).toContain('ход завершается сам: шорт-лист, вопрос выбора');
    expect(prompt).toContain('предложи сохранить их в карточки');
  });
});
