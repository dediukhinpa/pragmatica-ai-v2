import { mkdir, rm } from 'node:fs/promises';
import { expect } from 'bun:test';
import type { PgClient } from '@business-ai/adapters';
import { PostgresPriceRepository } from '../../src/kit/adapters/postgres/price-repository';
import { e2eEnv, requireEnv } from './project-env';
import {
  blocksOf,
  isRecord,
  lastResult,
  type StubReply,
  type StubScript,
  userTexts,
} from '@business-ai/testing/e2e';
import type { ExpectedItem, PriceForm } from './script-forms';

/** Поставщик с готовой карточкой (кроме сценария нового поставщика). */
export const SCRIPT_SUPPLIER_PREFIX = 'sup-e2e-s111-';
/** Таймаут/сокет песочницы приходят из run.sh. */
export function sandboxOverrides(pricesRoot: string): Record<string, string> {
  return {
    AGENT_SANDBOX_ENABLED: '1',
    SANDBOX_SOCKET: requireEnv('E2E_SANDBOX_SOCKET'),
    PRICES_FILES_ROOT: pricesRoot,
  };
}

/** Каталог прайсов сценария внутри корня documents (сервис читает файлы оттуда). */
export async function makePricesRoot(name: string): Promise<string> {
  const root = `${e2eEnv().work}/files/${name}`;
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  return root;
}

/** Имя файла без папок: подстрока для `listPriceFiles.query`. */
export function baseNameOf(fileName: string): string {
  return fileName.split('/').at(-1) ?? fileName;
}

/** Имена вызванных инструментов во всей истории запроса. */
export function toolNames(body: Record<string, unknown>): string[] {
  const messages = Array.isArray(body['messages']) ? body['messages'] : [];
  const names: string[] = [];
  for (const message of messages) {
    for (const block of blocksOf(message)) {
      if (isRecord(block) && block['type'] === 'tool_use') names.push(String(block['name']));
    }
  }
  return names;
}

/** Все вызовы инструментов, которые «модель» делала за сценарий (по последнему запросу). */
export function allToolNames(bodies: readonly string[]): string[] {
  const last = bodies.at(-1);
  return last === undefined ? [] : toolNames(JSON.parse(last) as Record<string, unknown>);
}

function stepPath(body: Record<string, unknown>): string {
  const files = lastResult(body, 'listPriceFiles')['files'];
  const path = (Array.isArray(files) ? files[0] : undefined) as { path?: string } | undefined;
  if (path?.path === undefined) throw new Error('listPriceFiles не вернул файл формы');
  return path.path;
}

/** Идентификатор поставщика из строки поручения `supplierId=...` (его определил код тика). */
function supplierFromAssignment(body: Record<string, unknown>): string {
  const text = userTexts(body).at(-1) ?? '';
  const match = /supplierId=(\S+?)\.?(?:\s|$)/.exec(text);
  if (match?.[1] === undefined) throw new Error('в поручении нет supplierId');
  return match[1];
}

/**
 * Ход «модели» на форму: список файлов -> чтение -> скрипт -> фиксация. Скрипт - детерминированный
 * код формы. Позиции модель не видит: придёт сводка. Поставщик - либо заданный, либо из строки
 * поручения `supplierId=...`: карточку нового поставщика заводит код тика, а не модель.
 */
export function formScript(
  form: PriceForm,
  supplier: { id: string } | { fromAssignment: true },
  doneText: string,
): StubScript {
  return ({ index, body }): StubReply => {
    const supplierOf = (): string =>
      'fromAssignment' in supplier ? supplierFromAssignment(body) : supplier.id;
    switch (index) {
      case 0:
        return {
          kind: 'tool',
          name: 'listPriceFiles',
          input: { query: baseNameOf(form.fileName) },
        };
      case 1:
        return { kind: 'tool', name: 'readPriceFile', input: { path: stepPath(body) } };
      case 2:
        return {
          kind: 'tool',
          name: 'runDataScript',
          input: {
            code: form.script,
            fileRef: stepPath(body),
            resultKind: 'price_items',
            supplierId: supplierOf(),
          },
        };
      case 3: {
        const run = lastResult(body, 'runDataScript');
        const summary = run['summary'];
        if (!isRecord(summary) || run['ok'] !== true) {
          throw new Error(`скрипт формы ${form.code} не принят: ${JSON.stringify(run)}`);
        }
        return {
          kind: 'tool',
          name: 'commitPriceImport',
          input: { supplierId: supplierOf(), fileHash: summary['fileHash'] },
        };
      }
      default:
        return { kind: 'text', text: doneText };
    }
  };
}

/** Позиции поставщика в базе по названию. */
export async function itemsByName(db: PgClient, supplierId: string) {
  const items = await new PostgresPriceRepository(db).listBySupplier(supplierId);
  return new Map(items.map((item) => [item.productName, item]));
}

/** Утверждение: позиции в базе - ровно ожидаемые, с ценами, тиражами и основанием тиража. */
export async function expectItemsInDb(
  db: PgClient,
  supplierId: string,
  expected: readonly ExpectedItem[],
  basis: 'quantity' | 'order_sum',
): Promise<void> {
  const byName = await itemsByName(db, supplierId);
  expect([...byName.keys()].sort()).toEqual(expected.map((e) => e.name).sort());
  for (const want of expected) {
    const got = byName.get(want.name);
    expect(got?.price).toBe(want.price);
    const tiers = (got?.priceTiers ?? []).map((t) => [t.minQuantity, t.price]);
    expect(tiers).toEqual(want.tiers.map((t) => [...t]));
    if (want.tiers.length > 0) {
      expect(got?.priceTierBasis ?? 'quantity').toBe(basis);
    }
  }
}
