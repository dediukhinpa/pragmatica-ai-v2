import { beforeEach, describe, expect, test } from 'bun:test';
import { MemoryWebHitClassifier } from '../../src/kit/adapters/memory/web-candidate-model';
import { buildShortlist } from '../../src/agents/order-calc/build-shortlist';
import { loadProposal, saveCompleteness } from '../../src/agents/order-calc/state';
import { parseWebHitVerdicts } from '../../src/agents/order-calc/web-hits';
import { searchKnowledgeSuppliers, searchWeb } from '../../src/agents/order-calc/search-sources';
import type { WebHitClassifyInput } from '../../src/kit/ports/web-candidate-model';
import type { WebSearchHit } from '@business-ai/core';
import { CTX } from './support';
import { REQUEST_ID, buildOrderDeps, type OrderTestDeps } from './order-support';

/** Заголовок выдачи с многоточием: в названии кандидата показываться не должен. */
const LONG_TITLE = 'Фасованный мёд оптом в Москве: цена от производителя, купить банки ...';

/** Синтетика по жалобе теста 108: один сайт тремя хитами, площадки, зарубежье, тара. */
const HITS: WebSearchHit[] = [
  { title: LONG_TITLE, url: 'https://bashkirpaseki.ru/med', snippet: 'Мёд в банках оптом' },
  { title: 'Мёд липовый', url: 'https://www.bashkirpaseki.ru/opt', snippet: 'Прайс на мёд' },
  { title: 'Контакты', url: 'https://shop.bashkirpaseki.ru/', snippet: 'Мёд, +7 999 123-45-67' },
  { title: 'Мёд и орехи оптом', url: 'https://medrossii.ru/', snippet: 'Звоните info@medrossii.ru' },
  { title: 'Каталог мёда', url: 'https://medrossii.ru/catalog', snippet: 'Мёд цветочный' },
  { title: 'Мёд на Ozon', url: 'https://www.ozon.ru/category/med', snippet: 'Мёд' },
  { title: 'Мёд на Маркете', url: 'https://market.yandex.ru/search?text=мёд', snippet: 'Мёд' },
  { title: 'Мёд оптом Київ', url: 'https://prom.ua/med', snippet: 'Мёд' },
  { title: 'Мёд оптом Алматы', url: 'https://magnumopt.kz/med', snippet: 'Мёд' },
  { title: 'Банки для мёда', url: 'https://banki-dlya-meda.ru/', snippet: 'Стеклобанки 0,5 л' },
  { title: 'Крафт-пакеты', url: 'https://kraft-pack.ru/', snippet: 'Пакеты для орехов' },
];

/** Ответ классификатора по доменам из синтетики. */
function verdicts(input: WebHitClassifyInput): unknown {
  const byDomain: Record<string, unknown> = {
    'bashkirpaseki.ru': { relevant: true, type: 'производитель', company: 'Башкирские пасеки' },
    'medrossii.ru': { relevant: true, type: 'оптовик', company: 'МедРоссии' },
    'banki-dlya-meda.ru': { relevant: true, type: 'тара', company: 'Банки для мёда' },
    'kraft-pack.ru': { relevant: false, type: 'прочее', company: null },
  };
  return {
    results: input.hits.flatMap((hit) =>
      hit.domain in byDomain ? [{ domain: hit.domain, ...(byDomain[hit.domain] as object) }] : [],
    ),
  };
}

let deps: OrderTestDeps;
let classifier: MemoryWebHitClassifier;

beforeEach(async () => {
  deps = await buildOrderDeps();
  classifier = new MemoryWebHitClassifier(verdicts);
  deps.webClassifier = classifier;
  deps.web.search = async () => HITS.map((hit) => ({ ...hit }));
});

async function webEntries(): Promise<
  Array<{ name: string; references: string[]; sources: string[]; supplierId: string }>
> {
  await searchWeb.execute({ requestId: REQUEST_ID }, deps, CTX);
  await buildShortlist.execute({ requestId: REQUEST_ID }, deps, CTX);
  return (await loadProposal(deps, REQUEST_ID))?.entries ?? [];
}

describe('searchWeb: хиты -> компании', () => {
  test('склейка по домену: один сайт - один кандидат, ссылки копятся', async () => {
    const entries = await webEntries();
    const bashkir = entries.filter((entry) => entry.name === 'Башкирские пасеки');
    expect(bashkir).toHaveLength(1);
    expect([...(bashkir[0]?.references ?? [])].sort()).toEqual([
      'https://bashkirpaseki.ru/med',
      'https://shop.bashkirpaseki.ru/',
      'https://www.bashkirpaseki.ru/opt',
    ]);
    const med = entries.find((entry) => entry.name === 'МедРоссии');
    expect(med?.references).toHaveLength(2);
  });

  test('отсев: маркетплейсы, зарубежье, тара и не тот товар не попадают в шорт-лист', async () => {
    const entries = await webEntries();
    expect(entries.map((entry) => entry.name).sort()).toEqual(['Башкирские пасеки', 'МедРоссии']);
    // Площадки и зарубежные домены в модель не уходят вовсе.
    const sent = classifier.seen[0]?.hits.map((hit) => hit.domain) ?? [];
    expect(sent).not.toContain('ozon.ru');
    expect(sent).not.toContain('yandex.ru');
    expect(sent).not.toContain('prom.ua');
    expect(sent).not.toContain('magnumopt.kz');
    expect(new Set(sent).size).toBe(sent.length);
  });

  test('название - компания, а не обрезанный заголовок выдачи', async () => {
    const entries = await webEntries();
    for (const entry of entries) {
      expect(entry.name).not.toContain('...');
      expect(entry.name).not.toBe(LONG_TITLE);
    }
  });

  test('заявка про импорт: зарубежный домен остаётся, площадки - нет', async () => {
    await saveCompleteness(deps, {
      requestId: REQUEST_ID,
      kind: 'other',
      values: { origin: 'нужен мёд из Китая' },
      declined: false,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    await searchWeb.execute({ requestId: REQUEST_ID }, deps, CTX);
    const sent = classifier.seen[0]?.hits.map((hit) => hit.domain) ?? [];
    expect(sent).toContain('magnumopt.kz');
    expect(sent).not.toContain('ozon.ru');
    expect(sent).not.toContain('prom.ua');
  });

  test('в модель не уходят контакты и ссылки из текстов выдачи', async () => {
    await searchWeb.execute({ requestId: REQUEST_ID }, deps, CTX);
    const payload = JSON.stringify(classifier.seen[0]);
    expect(payload).not.toContain('+7 999 123-45-67');
    expect(payload).not.toContain('info@medrossii.ru');
    expect(payload).not.toContain('https://');
  });

  test('база выше веба в шорт-листе', async () => {
    await searchKnowledgeSuppliers.execute({ requestId: REQUEST_ID }, deps, CTX);
    const entries = await webEntries();
    const firstWeb = entries.findIndex((entry) => !entry.sources.includes('knowledge'));
    expect(firstWeb).toBeGreaterThan(0);
    expect(entries.slice(0, firstWeb).every((entry) => entry.sources.includes('knowledge'))).toBe(
      true,
    );
  });
});

describe('searchWeb: сбой модели - прежнее поведение', () => {
  test.each([
    [
      'исключение',
      (): unknown => {
        throw new Error('boom');
      },
    ],
    ['невалидный ответ', () => 'не json-объект'],
    ['чужая структура', () => ({ results: [{ domain: 'bashkirpaseki.ru', type: 'что-то' }] })],
  ])('%s: кандидаты остаются, название по домену, площадки отсеяны', async (_name, answer) => {
    deps.webClassifier = new MemoryWebHitClassifier(answer);
    const out = await searchWeb.execute({ requestId: REQUEST_ID }, deps, CTX);
    expect(out.status).toBe('ok');
    await buildShortlist.execute({ requestId: REQUEST_ID }, deps, CTX);
    const names = (await loadProposal(deps, REQUEST_ID))?.entries.map((entry) => entry.name) ?? [];
    expect(names).toContain('Bashkirpaseki (bashkirpaseki.ru)');
    expect(names).toContain('Medrossii (medrossii.ru)');
    expect(names.some((name) => name.toLowerCase().includes('ozon'))).toBe(false);
    expect(names.some((name) => name.includes('prom.ua'))).toBe(false);
  });

  test('без классификатора: склейка и отсев кодом, названия по домену', async () => {
    deps.webClassifier = undefined;
    const entries = await webEntries();
    expect(entries.filter((entry) => entry.name.startsWith('Bashkirpaseki'))).toHaveLength(1);
    expect(entries.map((entry) => entry.name)).not.toContain('Ozon (ozon.ru)');
  });

  test('классификатор отсеял все домены: ответ недостоверен, откат на результат кода', async () => {
    deps.webClassifier = new MemoryWebHitClassifier((input) => ({
      results: input.hits.map((hit) => ({
        domain: hit.domain,
        relevant: false,
        type: 'прочее',
        company: null,
      })),
    }));
    const names = (await webEntries()).map((entry) => entry.name);
    expect(names).toContain('Bashkirpaseki (bashkirpaseki.ru)');
    expect(names).toContain('Medrossii (medrossii.ru)');
  });

  test('отсеяно больше 80% доменов: тоже откат; ровно 80% - ответ принимается', async () => {
    const reject = (keep: number) =>
      new MemoryWebHitClassifier((input) => ({
        results: input.hits.map((hit, index) => ({
          domain: hit.domain,
          relevant: index < keep,
          type: 'производитель',
          company: `Фирма ${index}`,
        })),
      }));
    // Пять доменов: оставлен один (отсеяно 80%) - ответ принимается.
    const many: WebSearchHit[] = [1, 2, 3, 4, 5].map((n) => ({
      title: `Мёд ${n}`,
      url: `https://site${n}.ru/`,
      snippet: 'Мёд',
    }));
    deps.web.search = async () => many.map((hit) => ({ ...hit }));
    deps.webClassifier = reject(1);
    expect((await webEntries()).map((entry) => entry.name)).toEqual(['Фирма 0']);
  });

  test('отсеяно больше 80% (5 из 6): откат на результат кода', async () => {
    const six: WebSearchHit[] = [1, 2, 3, 4, 5, 6].map((n) => ({
      title: `Мёд ${n}`,
      url: `https://site${n}.ru/`,
      snippet: 'Мёд',
    }));
    deps.web.search = async () => six.map((hit) => ({ ...hit }));
    deps.webClassifier = new MemoryWebHitClassifier((input) => ({
      results: input.hits.map((hit, index) => ({
        domain: hit.domain,
        relevant: index === 0,
        type: 'производитель',
        company: `Фирма ${index}`,
      })),
    }));
    const names = (await webEntries()).map((entry) => entry.name);
    expect(names).toHaveLength(6);
    expect(names).toContain('Site2 (site2.ru)');
  });

  test('два сайта на одном хостинге не склеиваются в одного кандидата', async () => {
    deps.webClassifier = undefined;
    deps.web.search = async () => [
      { title: 'Мёд А', url: 'https://medpasek-a.ucoz.ru/', snippet: 'Мёд в банках оптом' },
      { title: 'Мёд Б', url: 'https://medpasek-b.ucoz.ru/', snippet: 'Мёд липовый оптом' },
    ];
    const entries = await webEntries();
    expect(entries.map((entry) => entry.name).sort()).toEqual([
      expect.stringContaining('medpasek-a.ucoz.ru'),
      expect.stringContaining('medpasek-b.ucoz.ru'),
    ]);
  });

  test('название с многоточием от модели не принимается: берётся имя домена', async () => {
    deps.webClassifier = new MemoryWebHitClassifier((input) => ({
      results: input.hits.map((hit) => ({
        domain: hit.domain,
        relevant: true,
        type: 'магазин',
        company: LONG_TITLE,
      })),
    }));
    const entries = await webEntries();
    expect(entries.some((entry) => entry.name.includes('...'))).toBe(false);
    expect(entries.map((entry) => entry.name)).toContain('Bashkirpaseki (bashkirpaseki.ru)');
  });
});

describe('parseWebHitVerdicts', () => {
  const known = new Set(['a.ru', 'b.ru']);

  test('принимает только известные домены и валидные записи', () => {
    const parsed = parseWebHitVerdicts(
      {
        results: [
          { domain: 'www.a.ru', relevant: 'да', type: 'магазин', company: ' Альфа  ' },
          { domain: 'b.ru', relevant: false, type: 'тара' },
          { domain: 'c.ru', relevant: true, type: 'магазин' },
          { domain: 'a.ru', relevant: true, type: 'вздор' },
          'мусор',
        ],
      },
      known,
    );
    expect([...parsed.keys()]).toEqual(['a.ru', 'b.ru']);
    expect(parsed.get('a.ru')).toEqual({ relevant: true, type: 'магазин', company: 'Альфа' });
    expect(parsed.get('b.ru')).toEqual({ relevant: false, type: 'тара' });
  });

  test('не объект и не тот ключ - пусто', () => {
    expect(parseWebHitVerdicts(null, known).size).toBe(0);
    expect(parseWebHitVerdicts([{ domain: 'a.ru' }], known).size).toBe(0);
    expect(parseWebHitVerdicts({ results: 'x' }, known).size).toBe(0);
  });
});
