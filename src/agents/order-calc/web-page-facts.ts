import { z } from 'zod';

import { textHasContacts, textHasPrice, type WebPageFacts } from '../../kit/domain/web-candidate';
import type { WebCatalogHint, WebPage, WebSiteLink } from '@business-ai/core';
import type { ToolContext } from '@business-ai/core';
import { runAuditedWebPageRead, runAuditedWebUrlRead } from '@business-ai/core';
import type { OrderCalcDeps } from './deps';
import { codeOf, withTimeout } from './web-enrichment';

/** Пометка источника: модель-извлекатель отличает текст страницы сайта от сниппетов поиска. */
const PAGE_TEXT_LABEL = 'Страница сайта поставщика';

/** Хост из адреса ссылки кандидата; не адрес http(s) - пустая строка. */
export function siteHostOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
      ? parsed.hostname.toLowerCase()
      : '';
  } catch {
    return '';
  }
}

/**
 * Прочитать сайт кандидата и вернуть тексты страниц для `webEnricher.extract`.
 *
 * Хост берётся из самой ссылки кандидата (а не из склейки по домену в другой дорожке), чтобы
 * модуль не зависел от её кода. Пустой массив - при отсутствии читателя, невалидном хосте,
 * исчерпанном лимите, сбое чтения и сбое транспорта: обогащение тогда идёт по-старому, а
 * кандидата сбой не убирает. Тексты нужны ТОЛЬКО для extract: в основную модель агента и в
 * вывод инструментов они не попадают (вызывающий код кладёт их лишь в `texts` извлечения).
 * `catalog` - слова позиций и адрес из выдачи: если на главной и контактах цен нет, читатель
 * добавит до двух страниц каталога (чтений больше, вызовов модели столько же).
 */
export async function readCandidatePageTexts(
  deps: OrderCalcDeps,
  context: ToolContext,
  url: string,
  catalog?: WebCatalogHint,
): Promise<string[]> {
  if (deps.webPageReader === undefined) return [];
  const host = siteHostOf(url);
  if (host === '') return [];
  try {
    const outcome = await runAuditedWebPageRead(deps, context, host, {
      findContacts: true,
      ...(catalog === undefined ? {} : { catalog }),
    });
    if (outcome.status !== 'ok') {
      deps.log?.('web_page_read_failed', { code: outcome.failureCode ?? 'unknown' });
      return [];
    }
    const pages = [...outcome.pages];
    await addPickedPages(deps, context, host, pages, outcome.siteLinks ?? [], catalog);
    return pages
      .filter((page) => page.text.trim() !== '')
      .map((page) => `${PAGE_TEXT_LABEL} ${page.url}:\n${page.text}`);
  } catch (error) {
    // Отмена хода - не сбой чтения: её нельзя глотать, иначе обогащение продолжит платные
    // шаги (второй поиск, extract) после отмены. Внешняя обёртка поиска уже умеет отмену.
    if (context.signal?.aborted === true) throw error;
    // Шлюз недоступен и т.п.: чтение страницы - улучшение, не условие обогащения.
    const code = error instanceof Error ? error.name : 'unexpected';
    deps.log?.('web_page_read_failed', { code });
    return [];
  }
}

/**
 * Хватает ли сведений со страницы, чтобы не тратить платное поисковое уточнение: ключевые
 * поля - город и контакты (по ним сотрудник выбирает, кому писать). Цена и срок на главной
 * бывают редко, их отсутствие не повод платить за поиск.
 */
export function pageFactsCoverKeyFields(facts: WebPageFacts): boolean {
  const hasContact =
    facts.phone !== undefined || facts.email !== undefined || facts.site !== undefined;
  return facts.city !== undefined && hasContact;
}

/** Сколько страниц, выбранных моделью по ссылкам главной, дочитывается. */
export const PICKED_PAGES_MAX = 2;

const pickedPagesSchema = z.object({ urls: z.array(z.string()) });

/**
 * Трудный случай: на прочитанных страницах код не нашёл телефона и почты (или цен, когда они
 * нужны). Модель по подписям и адресам ссылок главной выбирает до двух страниц, код читает
 * только адреса из присланного списка. Так находятся контакты без слова «контакты» в меню и с
 * нестандартным адресом (29.10). Сбой модели или чтения - остаются прежние страницы.
 */
async function addPickedPages(
  deps: OrderCalcDeps,
  context: ToolContext,
  site: string,
  pages: WebPage[],
  links: readonly WebSiteLink[],
  catalog: WebCatalogHint | undefined,
): Promise<void> {
  const picker = deps.sitePagePicker;
  if (picker === undefined) return;
  const read = new Set(pages.map((page) => page.url));
  const offered = links.filter((link) => !read.has(link.url));
  if (offered.length === 0) return;
  const needContacts = !pages.some((page) => textHasContacts(page.text));
  const needPrices = catalog !== undefined && !pages.some((page) => textHasPrice(page.text));
  if (!needContacts && !needPrices) return;
  let urls: string[];
  try {
    const raw = await withTimeout(
      (signal) =>
        picker.pickPages(
          {
            site,
            need: { contacts: needContacts, prices: needPrices },
            items: needPrices ? [...(catalog?.words ?? [])] : [],
            links: offered,
          },
          { signal },
        ),
      context.signal,
    );
    const parsed = pickedPagesSchema.safeParse(raw);
    const allowed = new Set(offered.map((link) => link.url));
    // Только адреса из присланного списка: выдуманный моделью адрес не читается
    urls = parsed.success
      ? [...new Set(parsed.data.urls.filter((url) => allowed.has(url)))].slice(0, PICKED_PAGES_MAX)
      : [];
  } catch (error) {
    if (context.signal?.aborted === true) throw error;
    deps.log?.('site_pages_pick_failed', { code: codeOf(error) });
    return;
  }
  let added = 0;
  for (const url of urls) {
    // Лимит чтений не тратится, как у обогащения карточек (решение владельца 28.10); аудит есть
    let page: WebPage | undefined;
    try {
      const outcome = await runAuditedWebUrlRead(deps, context, url, { charge: false });
      page = outcome.status === 'ok' ? outcome.pages[0] : undefined;
    } catch (error) {
      // Сбой транспорта на дочитывании не должен терять уже прочитанные страницы
      if (context.signal?.aborted === true) throw error;
      deps.log?.('site_pages_read_failed', { code: codeOf(error) });
      continue;
    }
    if (page === undefined || read.has(page.url)) continue;
    read.add(page.url);
    // Разметка в извлечение не идёт: модели нужен только текст
    const title = page.title === undefined ? {} : { title: page.title };
    pages.push({ url: page.url, text: page.text, ...title });
    added += 1;
  }
  deps.log?.('site_pages_picked', {
    offered: offered.length,
    picked: urls.length,
    read: added,
    contactsFound: pages.some((page) => textHasContacts(page.text)),
  });
}
