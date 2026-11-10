import { beforeEach, describe, expect, test } from 'bun:test';
import { FixedClock, type MemoryFileSource } from '@business-ai/adapters';
import {
  IMPORT_META_NAMESPACE,
  MAIL_NAMESPACE,
  type PricesDeps,
} from '../../src/agents/prices/deps';
import { mailKey, savePriceUpload } from '../../src/agents/prices/price-state';
import { joinKey } from '@business-ai/core';
import { listStalePriceSuppliers } from '../../src/agents/prices/stale-price-suppliers';
import { readPriceMail } from '../../src/agents/prices/price-mail';
import { runStalePriceFilesCheck } from '../../src/agents/prices/stale-price-files';
import { DAY_MS } from '../../src/kit/domain/time';

/** Дней без обновления: заведомо больше трёх календарных месяцев. */
const STALE_DAYS_AGO = 100;
import { CTX } from './support';
import {
  SUPPLIER_EMAIL,
  USER_1,
  USER_THREAD_1,
  buildFullPricesDeps,
  buildMailboxPricesDeps,
  employeeContext,
  encode,
  mailMessage,
  skuCsv,
  type FullPricesDeps,
  type MailboxPricesDeps,
} from './prices-support';

/** Поставщиков больше прежнего предела выборки в 2000 записей. */
const MANY = 2_100;
const CSV = skuCsv([['Болт', 10, 'B1']]);
const attach = (fileName: string) => ({
  fileName,
  mimeType: 'text/csv',
  bytes: encode(CSV),
});

/** Заполнить базу поставщиками, названия которых идут раньше «Ярус». */
async function fillSuppliers(deps: FullPricesDeps): Promise<void> {
  for (let i = 0; i < MANY; i += 1) {
    const num = String(i).padStart(5, '0');
    await deps.suppliers.upsert({ id: `fill${num}`, name: `Поставщик ${num}` });
  }
}

describe('R6-10-02: один адрес у двух поставщиков', () => {
  test('ящик сотрудника: письмо не привязывается ни к одному из двух', async () => {
    const deps: MailboxPricesDeps = await buildMailboxPricesDeps();
    await deps.suppliers.upsert({ id: 's-twin', name: 'Двойник', email: SUPPLIER_EMAIL });
    deps.mailboxes.deliver(USER_1, mailMessage({ id: 'm1', attachments: [attach('a.csv')] }));
    const out = await readPriceMail.execute({ senderQuery: '@' }, deps, employeeContext(USER_1, USER_THREAD_1));
    // По просьбе сотрудника письмо читается, но к поставщику не привязано.
    expect(out.mails).toHaveLength(1);
    expect(out.mails[0]).toMatchObject({ known: false, senderNotInBase: true });
    expect(out.ignoredPersonal).toBe(0);
  });

  test('адрес второго контакта карточки привязывает письмо к поставщику', async () => {
    const deps = await buildFullPricesDeps();
    await deps.suppliers.saveCard({
      id: 's-card',
      name: 'Карточный',
      status: 'new',
      contacts: [
        { email: 'main@card.example', isPrimary: true },
        { email: 'Buyer@Card.example', isPrimary: false },
      ],
      supplies: { categories: [], brands: [], regions: [] },
      terms: {},
      notes: [],
    });
    deps.mailboxes.deliver(USER_1,
      mailMessage({ id: 'm1', from: 'buyer@card.example', attachments: [attach('a.csv')] }),
    );
    const out = await readPriceMail.execute({}, deps, employeeContext(USER_1, USER_THREAD_1));
    expect(out.mails[0]).toMatchObject({ known: true, supplierId: 's-card' });
  });
});

describe('R6-06-06: поставщик за пределом 2000 по названию', () => {
  test('readPriceMail привязывает письмо к поставщику из «хвоста»', async () => {
    const deps = await buildFullPricesDeps();
    await fillSuppliers(deps);
    await deps.suppliers.upsert({ id: 'tail', name: 'Ярус', email: 'tail@yarus.example' });
    deps.mailboxes.deliver(USER_1,
      mailMessage({ id: 'm1', from: 'TAIL@yarus.example', attachments: [attach('a.csv')] }),
    );
    const out = await readPriceMail.execute({}, deps, employeeContext(USER_1, USER_THREAD_1));
    expect(out.mails[0]).toMatchObject({ known: true, supplierId: 'tail' });
  });

  test('listStalePriceSuppliers видит поставщика из «хвоста»', async () => {
    const deps = await buildFullPricesDeps();
    await fillSuppliers(deps);
    await deps.suppliers.upsert({ id: 'tail', name: 'Ярус', email: 'tail@yarus.example' });
    const old = new Date(deps.clock.now().getTime() - STALE_DAYS_AGO * DAY_MS).toISOString();
    await deps.prices.saveImport(
      'tail',
      [{ supplierId: 'tail', productName: 'Болт', price: 1, currency: 'RUB', date: old }],
      'k',
    );
    await savePriceUpload(deps, 'tail', old);
    const out = await listStalePriceSuppliers.execute({}, deps, CTX);
    expect(out.suppliers.map((item) => item.supplierId)).toContain('tail');
  });

  test('проверка залежавшихся файлов находит поставщика из «хвоста» по названию', async () => {
    const deps = await buildFullPricesDeps();
    await fillSuppliers(deps);
    await deps.suppliers.upsert({ id: 'tail', name: 'Ярус Опт' });
    const files = deps.files as MemoryFileSource;
    const now = new Date('2026-10-12T06:30:00Z');
    files.put('Склад/Ярус Опт/прайс_01.01.2026.xlsx', encode('x'), now.getTime());
    const withClock: PricesDeps = { ...deps, clock: new FixedClock(now) };
    await runStalePriceFilesCheck(withClock, { timezone: 'Europe/Moscow' });
    const text = deps.chat.outbox[0]?.message?.text ?? '';
    expect(text).toContain('Ярус Опт:\n• Склад/Ярус Опт/прайс_01.01.2026.xlsx — 01.01.2026');
  });
});

describe('R6-06-02: список писем не усечён чужими записями', () => {
  test('письма сотрудника видны при 5001 записи других ящиков с меньшим ключом', async () => {
    const deps = await buildMailboxPricesDeps();
    const FOREIGN = 5_001;
    for (let i = 0; i < FOREIGN; i += 1) {
      const id = joinKey('a-owner', `x${String(i).padStart(5, '0')}`);
      await deps.state.put(MAIL_NAMESPACE, mailKey(id), {
        id,
        from: 'x@x.example',
        subject: 'Чужое',
        receivedAt: '2026-01-01T00:00:00.000Z',
        bodyExcerpt: '',
        supplierId: 's1',
        mailboxOwnerId: 'a-owner',
        mailboxMessageId: `x${i}`,
        status: 'new',
        attachments: [],
      });
    }
    deps.mailboxes.deliver(USER_1, mailMessage({ id: 'm1', attachments: [attach('a.csv')] }));
    const out = await readPriceMail.execute({}, deps, employeeContext(USER_1, USER_THREAD_1));
    expect(out.mails.map((mail) => mail.subject)).toEqual(['Прайс']);
  });
});

describe('R6-06-01: сопоставление залежавшихся файлов не растёт как файлы × история', () => {
  test('5000 файлов, 2000 поставщиков, 5000 записей истории: секунды', async () => {
    const deps = await buildFullPricesDeps();
    for (let i = 0; i < 2_000; i += 1) {
      await deps.suppliers.upsert({ id: `p${i}`, name: `Фирма ${String(i).padStart(5, '0')}` });
    }
    const now = new Date('2026-10-12T06:30:00Z');
    const files = deps.files as MemoryFileSource;
    for (let i = 0; i < 5_000; i += 1) {
      files.put(`Архив/${i}/файл-${i} 01.01.2026.xlsx`, encode('x'), now.getTime());
    }
    for (let i = 0; i < 5_000; i += 1) {
      await deps.state.put(IMPORT_META_NAMESPACE, `p${i % 2_000}:h${i}`, {
        source: 'disk',
        fileName: `Другое/${i}.xlsx`,
        notes: [],
      });
    }
    const withClock: PricesDeps = { ...deps, clock: new FixedClock(now) };
    const started = performance.now();
    const result = await runStalePriceFilesCheck(withClock, { timezone: 'Europe/Moscow' });
    const elapsedMs = performance.now() - started;
    expect(result.status).toBe('sent');
    // Прежний перебор: каждый файл заново фильтрует всю историю и нормализует все названия.
    expect(elapsedMs).toBeLessThan(3_000);
  }, 120_000);
});
