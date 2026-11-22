import {
  MemoryAuditRepository,
  MemoryPairNoteStore,
  MemoryWebPageReader,
} from '@business-ai/adapters';
import { createToolContext } from '@business-ai/core';
import type { ToolContext, WebPage, WebSearchHit } from '@business-ai/core';
import { SUPPLIER_CARD_REQUEST_NAMESPACE } from '../../src/agents/suppliers/deps';
import { buildOrderDeps, type OrderTestDeps } from '../agents/order-support';
import { INN_ALPHA, INN_BETA, INN_BROKEN } from '../agents/suppliers-support';

/**
 * Общая сборка для тестов пополнения базы (этап 8z): агент «Поиск поставщика» с карточками
 * поставщиков на заглушках в памяти. Данные только синтетические (домены `.test`, названия
 * выдуманные, ИНН с верной контрольной суммой).
 */

export const EMPLOYEE = 'u-discovery';
export const AGENT_ID = 'order-calc';
/** Тред связки «бот + сотрудник»: в нём идёт ход и показываются карточки. */
export const THREAD = `${AGENT_ID}/${EMPLOYEE}`;
export { INN_ALPHA, INN_BETA, INN_BROKEN };

/** Ход сотрудника в чате. */
export function employeeContext(operation = 'op-discovery'): ToolContext {
  return createToolContext({
    threadId: THREAD,
    agentId: AGENT_ID,
    operationId: operation,
    initiator: { kind: 'user', userId: EMPLOYEE },
  });
}

/** Плановый запуск: не сотрудник. */
export function schedulerContext(): ToolContext {
  return createToolContext({
    threadId: 'order-calc-weekly',
    agentId: AGENT_ID,
    operationId: 'op-scheduler',
    initiator: { kind: 'scheduler' },
  });
}

/** Хит поиска: страница сайта `host` (путь по умолчанию - главная). */
export function hit(host: string, title: string, snippet = '', path = '/'): WebSearchHit {
  return { title, url: `https://${host}${path}`, snippet };
}

/** Страницы сайтов для читателя: текст «главной» хоста. */
export function sitePages(entries: Record<string, string>): Record<string, WebPage[]> {
  return Object.fromEntries(
    Object.entries(entries).map(([host, text]) => [host, [{ url: `https://${host}/`, text }]]),
  );
}

/** Мир теста: зависимости агента и журнал платных обращений. */
export interface DiscoveryWorld {
  deps: OrderTestDeps;
  /** Тексты платных поисков в интернете по порядку. */
  searches: string[];
  reader: MemoryWebPageReader;
}

/**
 * Собрать зависимости. `hitsBySearch[i]` - выдача i-го поиска (после последней - пустая).
 * Читатель сайтов отдаёт `pages` по хосту; право записи у сотрудника есть (`deps.access`).
 */
export async function buildDiscoveryWorld(options: {
  hitsBySearch: readonly (readonly WebSearchHit[])[];
  pages?: Record<string, WebPage[]>;
}): Promise<DiscoveryWorld> {
  const deps = await buildOrderDeps({ request: null });
  const searches: string[] = [];
  deps.web.search = async (query) => {
    const index = searches.length;
    searches.push(query);
    return (options.hitsBySearch[index] ?? []).map((item) => ({ ...item }));
  };
  const reader = new MemoryWebPageReader(options.pages ?? {});
  deps.webPageReader = reader;
  deps.supplierCards = {
    suppliers: deps.suppliers,
    chat: deps.chat,
    clock: deps.clock,
    state: deps.state,
    pairNotes: new MemoryPairNoteStore(),
    audit: new MemoryAuditRepository(),
    access: deps.access,
  };
  return { deps, searches, reader };
}

/** Тексты сообщений, отправленных сотруднику в тред. */
export function sentTexts(deps: OrderTestDeps): string[] {
  return deps.chat
    .outboxOf(THREAD)
    .flatMap((item) => (item.message === undefined ? [] : [item.message.text]));
}

/** Показанные карточки (сообщения с подсказкой ответа). */
export function shownCards(deps: OrderTestDeps): string[] {
  return sentTexts(deps).filter((text) => text.includes('Например:'));
}

/** Сколько запросов подтверждения карточек записано в состояние. */
export async function requestCount(deps: OrderTestDeps): Promise<number> {
  const entries = await deps.state.list(SUPPLIER_CARD_REQUEST_NAMESPACE, null, 100);
  return entries.length;
}

/** Страница компании: юрлицо, город, телефон, ролевая почта, ИНН, директор с личной почтой. */
export function companyPage(options: {
  legal: string;
  city?: string;
  phone?: string;
  mailbox?: string;
  inn?: string;
  extra?: string;
}): string {
  return [
    `${options.legal}. Ёлочные игрушки оптом от производителя.`,
    options.city === undefined ? '' : `г. ${options.city}, ул. Тестовая, д. 1.`,
    options.phone === undefined ? '' : `Тел. ${options.phone}.`,
    options.mailbox === undefined ? '' : `Почта: ${options.mailbox}.`,
    options.inn === undefined ? '' : `ИНН ${options.inn}.`,
    options.extra ?? '',
  ]
    .filter((part) => part !== '')
    .join(' ');
}
