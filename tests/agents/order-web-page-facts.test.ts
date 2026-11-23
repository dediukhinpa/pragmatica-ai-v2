import { describe, expect, test } from 'bun:test';
import { MemorySitePagePicker } from '../../src/kit/adapters/memory/web-candidate-model';
import { MemoryWebPageReader } from '@business-ai/adapters';
import { DomainError } from '@business-ai/core';
import {
  pageFactsCoverKeyFields,
  readCandidatePageTexts,
  siteHostOf,
} from '../../src/agents/order-calc/web-page-facts';
import { CTX } from './support';
import { buildOrderDeps } from './order-support';

const PAGES = { 'armatura.test': [{ url: 'https://armatura.test/', text: 'Казань, тел. 1' }] };

describe('siteHostOf', () => {
  test('хост из ссылки; не http(s) и мусор - пусто', () => {
    expect(siteHostOf('https://Shop.Armatura.test/catalog?a=1')).toBe('shop.armatura.test');
    expect(siteHostOf('ftp://armatura.test')).toBe('');
    expect(siteHostOf('не адрес')).toBe('');
  });
});

describe('readCandidatePageTexts', () => {
  test('читатель отсутствует - пусто, не бросает', async () => {
    const deps = await buildOrderDeps();
    expect(await readCandidatePageTexts(deps, CTX, 'https://armatura.test')).toEqual([]);
  });

  test('успех: тексты с пометкой источника', async () => {
    const deps = await buildOrderDeps();
    const reader = new MemoryWebPageReader(PAGES);
    deps.webPageReader = reader;
    const texts = await readCandidatePageTexts(deps, CTX, 'https://armatura.test/x');
    expect(texts).toEqual(['Страница сайта поставщика https://armatura.test/:\nКазань, тел. 1']);
    expect(reader.calls).toEqual([{ host: 'armatura.test', findContacts: true }]);
  });

  test('подсказка каталога доходит до читателя вместе с findContacts', async () => {
    const deps = await buildOrderDeps();
    const reader = new MemoryWebPageReader(PAGES);
    deps.webPageReader = reader;
    const catalog = { words: ['мёд'], hintUrl: 'https://armatura.test/id/1' };
    await readCandidatePageTexts(deps, CTX, 'https://armatura.test/id/1', catalog);
    expect(reader.calls).toEqual([{ host: 'armatura.test', findContacts: true, catalog }]);
  });

  test('невалидный адрес - пусто без обращения к читателю', async () => {
    const deps = await buildOrderDeps();
    const reader = new MemoryWebPageReader(PAGES);
    deps.webPageReader = reader;
    expect(await readCandidatePageTexts(deps, CTX, 'мусор')).toEqual([]);
    expect(reader.calls).toHaveLength(0);
  });

  test('сбой чтения и сбой транспорта - пусто', async () => {
    const deps = await buildOrderDeps();
    const reader = new MemoryWebPageReader({});
    deps.webPageReader = reader;
    expect(await readCandidatePageTexts(deps, CTX, 'https://armatura.test')).toEqual([]);
    reader.failWith(new DomainError('external_failure', 'down'));
    expect(await readCandidatePageTexts(deps, CTX, 'https://armatura.test')).toEqual([]);
  });
});

describe('readCandidatePageTexts: страницы по выбору модели', () => {
  const HOST = 'taiga.test';
  const NO_CONTACTS = { [HOST]: [{ url: 'https://taiga.test/', text: 'Мёд и орехи из тайги' }] };
  const LINKS = {
    [HOST]: [
      { text: 'Про нас', url: 'https://taiga.test/about' },
      { text: 'Где купить', url: 'https://taiga.test/gde-kupit.html' },
    ],
  };
  const BY_URL = {
    'https://taiga.test/gde-kupit.html': {
      url: 'https://taiga.test/gde-kupit.html',
      text: 'Красноярск, mail@taiga.test',
      html: '<p>Красноярск</p>',
    },
  };

  test('контактов нет: модель выбирает страницу из ссылок главной, код её дочитывает', async () => {
    const deps = await buildOrderDeps();
    const reader = new MemoryWebPageReader(NO_CONTACTS, BY_URL, LINKS);
    deps.webPageReader = reader;
    const picker = new MemorySitePagePicker(() => ({
      urls: ['https://taiga.test/gde-kupit.html'],
    }));
    deps.sitePagePicker = picker;
    const texts = await readCandidatePageTexts(deps, CTX, 'https://taiga.test/');
    expect(texts).toHaveLength(2);
    expect(texts[1]).toContain('mail@taiga.test');
    expect(texts[1]).not.toContain('<p>');
    expect(picker.seen[0]?.need).toEqual({ contacts: true, prices: false });
    expect(picker.seen[0]?.links).toHaveLength(2);
  });

  test('адрес не из списка не читается', async () => {
    const deps = await buildOrderDeps();
    const reader = new MemoryWebPageReader(NO_CONTACTS, BY_URL, LINKS);
    deps.webPageReader = reader;
    deps.sitePagePicker = new MemorySitePagePicker(() => ({
      urls: ['https://evil.test/contacts', 'https://taiga.test/kontakty'],
    }));
    const texts = await readCandidatePageTexts(deps, CTX, 'https://taiga.test/');
    expect(texts).toHaveLength(1);
    expect(reader.urlCalls).toEqual([]);
  });

  test('контакты уже есть - модель не вызывается', async () => {
    const deps = await buildOrderDeps();
    const pages = { [HOST]: [{ url: 'https://taiga.test/', text: 'тел. +7 908 202-58-01' }] };
    deps.webPageReader = new MemoryWebPageReader(pages, BY_URL, LINKS);
    const picker = new MemorySitePagePicker(() => ({ urls: [] }));
    deps.sitePagePicker = picker;
    await readCandidatePageTexts(deps, CTX, 'https://taiga.test/');
    expect(picker.seen).toHaveLength(0);
  });

  test('нужны цены: модель получает позиции, даже если контакты есть', async () => {
    const deps = await buildOrderDeps();
    const pages = { [HOST]: [{ url: 'https://taiga.test/', text: 'тел. +7 908 202-58-01' }] };
    deps.webPageReader = new MemoryWebPageReader(pages, BY_URL, LINKS);
    const picker = new MemorySitePagePicker(() => ({ urls: [] }));
    deps.sitePagePicker = picker;
    await readCandidatePageTexts(deps, CTX, 'https://taiga.test/', { words: ['мёд с орехами'] });
    expect(picker.seen[0]?.need).toEqual({ contacts: false, prices: true });
    expect(picker.seen[0]?.items).toEqual(['мёд с орехами']);
  });

  test('сбой модели - остаются прочитанные страницы', async () => {
    const deps = await buildOrderDeps();
    deps.webPageReader = new MemoryWebPageReader(NO_CONTACTS, BY_URL, LINKS);
    deps.sitePagePicker = new MemorySitePagePicker(() => {
      throw new Error('down');
    });
    const texts = await readCandidatePageTexts(deps, CTX, 'https://taiga.test/');
    expect(texts).toHaveLength(1);
  });
});

describe('readCandidatePageTexts: отмена хода', () => {
  test('отменённый signal - AbortError пробрасывается, а не глотается', async () => {
    const deps = await buildOrderDeps();
    const reader = new MemoryWebPageReader(PAGES);
    deps.webPageReader = reader;
    const controller = new AbortController();
    const abortError = new DOMException('отменено', 'AbortError');
    reader.readSite = async () => {
      controller.abort(abortError);
      throw abortError;
    };
    const context = { ...CTX, signal: controller.signal };
    await expect(readCandidatePageTexts(deps, context, 'https://armatura.test')).rejects.toBe(
      abortError,
    );
  });

  test('AbortError без отменённого signal - прежний откат на пустой список', async () => {
    const deps = await buildOrderDeps();
    const reader = new MemoryWebPageReader(PAGES);
    deps.webPageReader = reader;
    reader.readSite = async () => {
      throw new DOMException('внутренний таймаут', 'AbortError');
    };
    const context = { ...CTX, signal: new AbortController().signal };
    expect(await readCandidatePageTexts(deps, context, 'https://armatura.test')).toEqual([]);
  });
});

describe('pageFactsCoverKeyFields', () => {
  test('нужны город и хотя бы один контакт', () => {
    expect(pageFactsCoverKeyFields({ city: 'Казань', phone: '+7 1' })).toBe(true);
    expect(pageFactsCoverKeyFields({ city: 'Казань' })).toBe(false);
    expect(pageFactsCoverKeyFields({ email: 'a@b.test' })).toBe(false);
  });
});
