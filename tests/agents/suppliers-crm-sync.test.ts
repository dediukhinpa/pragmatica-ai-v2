import { beforeEach, describe, expect, test } from 'bun:test';
import {
  SUPPLIER_CRM_LINK_NAMESPACE,
  runSupplierCrmPass,
} from '../../src/agents/suppliers/crm-sync';
import { DAY_MS } from '../../src/kit/domain/time';
import { ExternalAccessDeniedError } from '@business-ai/core';
import type { CrmSuppliers, CrmSuppliersCursor } from '../../src/kit/ports/crm-suppliers';
import { INN_ALPHA, INN_BETA } from './suppliers-support';
import {
  OPTIONS,
  OUR_INN,
  OUR_PHONE,
  allCards,
  build,
  company,
  seed,
  type World,
} from './suppliers-crm-sync-support';

/**
 * Синхронизация карточек поставщиков с компаниями CRM (этап 221). Данные синтетические; CRM -
 * заглушка в памяти. Без Postgres.
 */

let world: World;
beforeEach(() => {
  world = build();
});

describe('новая компания', () => {
  test('создаёт непроверенную карточку с полями CRM и заметкой об источнике', async () => {
    world.crm.set(
      company(10, 1, {
        title: 'ООО «Вега Трейд»',
        inn: INN_ALPHA,
        kpp: '770701001',
        legalAddress: 'г. Москва, ул. Образцовая, д. 1',
        websites: ['https://vega-trade.test'],
        emails: ['office@vega-trade.test'],
        phones: ['+7 495 111-22-33'],
        contacts: [
          { fullName: 'Петров Пётр Петрович', position: 'Менеджер', email: 'p@vega-trade.test' },
        ],
      }),
    );
    const result = await runSupplierCrmPass(world.deps, OPTIONS);
    expect(result).toMatchObject({ stoppedBy: 'none', scanned: 1, created: 1 });
    const [card] = await allCards(world);
    expect(card?.name).toBe('ООО «Вега Трейд»');
    expect(card).not.toHaveProperty('isDraft');
    expect(card?.inn).toBe(INN_ALPHA);
    expect(card?.website).toContain('vega-trade.test');
    expect(card?.contacts.some((c) => c.fullName === 'Петров Пётр Петрович')).toBe(true);
    expect(card?.contacts.some((c) => c.email === 'office@vega-trade.test')).toBe(true);
    expect(card?.notes.some((n) => n.text.includes('Создано из CRM'))).toBe(true);
    // Название и ФИО в подпись источника не попадают: заметку видят все.
    expect(card?.notes.every((n) => !n.text.includes('Вега') && !n.text.includes('Петров'))).toBe(
      true,
    );
  });

  test('неверный ИНН отбрасывается, карточка заводится по названию', async () => {
    world.crm.set(company(10, 1, { title: 'ООО «Вега Трейд»', inn: '1234567890' }));
    const result = await runSupplierCrmPass(world.deps, OPTIONS);
    expect(result.created).toBe(1);
    expect((await allCards(world))[0]?.inn).toBeUndefined();
  });

  test('без названия карточка не заводится', async () => {
    world.crm.set(company(10, 1, { title: '', inn: INN_ALPHA }));
    const result = await runSupplierCrmPass(world.deps, OPTIONS);
    expect(result).toMatchObject({ created: 0, noName: 1 });
    expect(await allCards(world)).toEqual([]);
  });

  test('отклонённая репозиторием компания не роняет проход', async () => {
    world.crm.set(company(10, 1, { title: 'x'.repeat(5000) }));
    world.crm.set(company(11, 2, { title: 'ООО «Вега Трейд»' }));
    const result = await runSupplierCrmPass(world.deps, OPTIONS);
    expect(result.scanned).toBe(2);
    expect((await allCards(world)).some((card) => card.name === 'ООО «Вега Трейд»')).toBe(true);
  });
});

describe('сопоставление с существующими карточками', () => {
  test('по ИНН: пустые поля дополняются, второй карточки нет', async () => {
    const existing = await seed(world, { name: 'Вега Трейд', inn: INN_ALPHA });
    world.crm.set(
      company(10, 1, {
        title: 'ООО «Вега Трейд»',
        inn: INN_ALPHA,
        websites: ['https://vega-trade.test'],
      }),
    );
    const result = await runSupplierCrmPass(world.deps, OPTIONS);
    expect(result).toMatchObject({ enriched: 1, created: 0 });
    const cards = await allCards(world);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.id).toBe(existing.id);
    expect(cards[0]?.website).toContain('vega-trade.test');
    expect(cards[0]).not.toHaveProperty('isDraft');
  });

  test('по названию без ИНН в CRM: дополняет, не дублирует', async () => {
    await seed(world, { name: 'Вега Трейд', inn: INN_ALPHA });
    world.crm.set(
      company(10, 1, { title: 'Вега Трейд', phones: ['+7 495 111-22-33'], emails: ['a@vega.test'] }),
    );
    const result = await runSupplierCrmPass(world.deps, OPTIONS);
    expect(result).toMatchObject({ enriched: 1, created: 0 });
    expect(await allCards(world)).toHaveLength(1);
  });

  test('по домену почты и названию: одна карточка', async () => {
    await seed(world, {
      name: 'Вега Трейд',
      contacts: [{ email: 'office@vega-trade.test', isPrimary: true }],
    });
    world.crm.set(
      company(10, 1, {
        title: 'ООО «Вега Трейд»',
        websites: ['https://vega-trade.test'],
        emails: ['sales@vega-trade.test'],
      }),
    );
    const result = await runSupplierCrmPass(world.deps, OPTIONS);
    expect(result).toMatchObject({ enriched: 1, created: 0 });
    expect(await allCards(world)).toHaveLength(1);
  });

  test('заполненные поля не перезаписываются: расхождения считаются', async () => {
    const existing = await seed(world, {
      name: 'Вега Трейд',
      inn: INN_ALPHA,
      website: 'https://vega-old.test',
      legalAddress: 'г. Казань, ул. Старая, 1',
    });
    world.crm.set(
      company(10, 1, {
        title: 'Вега Трейд',
        inn: INN_ALPHA,
        legalAddress: 'г. Москва, ул. Новая, 2',
        websites: ['https://vega-new.test'],
        emails: ['office@vega-new.test'],
      }),
    );
    const result = await runSupplierCrmPass(world.deps, OPTIONS);
    expect(result.conflicts).toBeGreaterThanOrEqual(2);
    const card = (await allCards(world)).find((item) => item.id === existing.id);
    expect(card?.website).toBe('https://vega-old.test');
    expect(card?.legalAddress).toBe('г. Казань, ул. Старая, 1');
    // Значения расхождений в журнал и аудит не попадают.
    const dump = JSON.stringify([world.logs, await world.audit.list()]);
    expect(dump).not.toContain('vega-new');
    expect(dump).not.toContain('Новая');
  });

  test('двусмысленное совпадение (общий домен двух карточек): ничего не пишется', async () => {
    await seed(world, { name: 'Холдинг А', contacts: [{ email: 'a@holding.test', isPrimary: true }] });
    await seed(world, { name: 'Холдинг Б', contacts: [{ email: 'b@holding.test', isPrimary: true }] });
    world.crm.set(
      company(10, 1, { title: 'Холдинг Сервис', emails: ['sales@holding.test'] }),
    );
    const result = await runSupplierCrmPass(world.deps, OPTIONS);
    expect(result).toMatchObject({ ambiguous: 1, created: 0, enriched: 0 });
    expect(await allCards(world)).toHaveLength(2);
  });

  test('другой ИНН при том же названии: ни дополнения, ни дубля', async () => {
    await seed(world, { name: 'Вега Трейд', inn: INN_ALPHA });
    world.crm.set(company(10, 1, { title: 'Вега Трейд', inn: INN_BETA }));
    const result = await runSupplierCrmPass(world.deps, OPTIONS);
    expect(result).toMatchObject({ created: 0, enriched: 0 });
    expect(await allCards(world)).toHaveLength(1);
  });
});

describe('связь компании с карточкой', () => {
  test('переименованная в CRM компания дополняет ту же карточку, а не создаёт вторую', async () => {
    world.crm.set(company(10, 1, { title: 'ООО «Вега Трейд»', phones: ['+7 495 000-11-22'] }));
    await runSupplierCrmPass(world.deps, OPTIONS);
    const [first] = await allCards(world);
    // Название сменилось, ИНН в CRM нет: без связи сопоставление дало бы вторую карточку.
    world.crm.set(
      company(10, 5, {
        title: 'Совсем Другое Название',
        emails: ['b@vega.test'],
      }),
    );
    world.clock.advance(4 * DAY_MS);
    const result = await runSupplierCrmPass(world.deps, OPTIONS);
    expect(result).toMatchObject({ created: 0 });
    const cards = await allCards(world);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.id).toBe(first?.id);
    expect(cards[0]?.contacts.some((c) => c.email === 'b@vega.test')).toBe(true);
  });

  test('связь хранится по id компании и не входит в удаляемое по сроку состояние', async () => {
    world.crm.set(company(10, 1, { title: 'ООО «Вега Трейд»' }));
    await runSupplierCrmPass(world.deps, OPTIONS);
    const link = await world.state.get(SUPPLIER_CRM_LINK_NAMESPACE, '10');
    expect(link).toMatchObject({ supplierId: (await allCards(world))[0]?.id });
  });

  test('карточка по связи удалена: связь снята, компания сопоставлена заново', async () => {
    await world.state.put(SUPPLIER_CRM_LINK_NAMESPACE, '10', {
      supplierId: 'нет-такой',
      at: '2026-10-01T00:00:00.000Z',
    });
    world.crm.set(company(10, 1, { title: 'ООО «Вега Трейд»' }));
    const result = await runSupplierCrmPass(world.deps, OPTIONS);
    expect(result).toMatchObject({ created: 1, linkReset: 1 });
    expect(await allCards(world)).toHaveLength(1);
  });

  test('связанная карточка с другим ИНН: не дополняется, счётчик расхождения', async () => {
    const existing = await seed(world, { name: 'Вега Трейд', inn: INN_ALPHA });
    await world.state.put(SUPPLIER_CRM_LINK_NAMESPACE, '10', {
      supplierId: existing.id,
      at: '2026-10-01T00:00:00.000Z',
    });
    world.crm.set(
      company(10, 1, { title: 'Вега Трейд', inn: INN_BETA, emails: ['a@vega.test'] }),
    );
    const result = await runSupplierCrmPass(world.deps, OPTIONS);
    expect(result).toMatchObject({ linkMismatch: 1, created: 0, enriched: 0 });
    expect((await allCards(world))[0]?.contacts).toEqual(existing.contacts);
  });
});

describe('наша компания и повтор', () => {
  test('компания с нашим ИНН или названием пропускается целиком', async () => {
    world.crm.set(
      company(10, 1, { title: 'ООО «Вега Трейд»', inn: OUR_INN, emails: ['a@vega.test'] }),
    );
    world.crm.set(company(11, 2, { title: 'ООО «Наша Компания»', websites: ['https://our.test'] }));
    const result = await runSupplierCrmPass(world.deps, OPTIONS);
    expect(result).toMatchObject({ scanned: 2, skippedOwn: 2, created: 0 });
    expect(await allCards(world)).toEqual([]);
  });

  test('наш телефон и почта из контактов компании не попадают в карточку', async () => {
    world.crm.set(
      company(10, 1, {
        title: 'ООО «Вега Трейд»',
        emails: ['zakupki@company.test', 'office@vega-trade.test'],
        phones: [OUR_PHONE, '+7 495 111-22-33'],
      }),
    );
    await runSupplierCrmPass(world.deps, OPTIONS);
    const [card] = await allCards(world);
    expect(card?.contacts.some((c) => c.email === 'zakupki@company.test')).toBe(false);
    expect(card?.contacts.some((c) => c.phone?.includes('900'))).toBe(false);
    expect(card?.contacts.some((c) => c.email === 'office@vega-trade.test')).toBe(true);
  });

  test('реквизиты нашей компании не заданы: контакты и ИНН не пишутся (fail closed)', async () => {
    const closed = build({ ownCompanyRequisites: [] });
    closed.crm.set(
      company(10, 1, { title: 'ООО «Вега Трейд»', inn: INN_ALPHA, emails: ['a@vega.test'] }),
    );
    await runSupplierCrmPass(closed.deps, OPTIONS);
    const [card] = await allCards(closed);
    expect(card?.inn).toBeUndefined();
    expect(card?.contacts ?? []).toEqual([]);
  });

  test('повторный проход без правок в CRM ничего не меняет и не задваивает заметку', async () => {
    world.crm.set(company(10, 1, { title: 'ООО «Вега Трейд»', inn: INN_ALPHA }));
    await runSupplierCrmPass(world.deps, OPTIONS);
    const before = await allCards(world);
    world.clock.advance(4 * DAY_MS);
    const second = await runSupplierCrmPass(world.deps, OPTIONS);
    // Курсор живёт только в запуске: компания читается снова, но записывать нечего.
    expect(second).toMatchObject({ scanned: 1, created: 0, enriched: 0, unchanged: 1 });
    expect(await allCards(world)).toEqual(before);
  });
});

describe('аудит', () => {
  test('аудит: кто, карточка, число полей; значений нет', async () => {
    world.crm.set(
      company(10, 1, { title: 'ООО «Вега Трейд»', inn: INN_ALPHA, emails: ['a@vega.test'] }),
    );
    await runSupplierCrmPass(world.deps, OPTIONS);
    const entries = await world.audit.list();
    expect(entries.length).toBeGreaterThan(0);
    const dump = JSON.stringify(entries);
    expect(dump).toContain('supplier-crm-sync');
    for (const secret of ['Вега', INN_ALPHA, 'a@vega.test']) expect(dump).not.toContain(secret);
  });
});

const OUR_KPP = '770101001';

/** Журнал: события с данным именем. */
function events(world: World, name: string): Array<Record<string, unknown>> {
  return world.logs.filter((entry) => entry.event === name).map((entry) => entry.fields);
}

describe('ревью 221: признаки нашей компании', () => {
  test('совпавший КПП не выбрасывает чужого поставщика: КПП только не записывается', async () => {
    // КПП принадлежит филиалу и бывает общим у разных юрлиц: поставщик не наш.
    const own = build({
      ownCompanyRequisites: [`ИНН ${OUR_INN}`, `КПП ${OUR_KPP}`, OUR_PHONE, 'zakupki@company.test'],
    });
    own.crm.set(
      company(10, 1, { title: 'ООО «Вега Трейд»', inn: INN_ALPHA, kpp: OUR_KPP }),
    );
    const result = await runSupplierCrmPass(own.deps, OPTIONS);
    expect(result).toMatchObject({ created: 1, skippedOwn: 0 });
    const [card] = await allCards(own);
    expect(card?.inn).toBe(INN_ALPHA);
    expect(card?.kpp).toBeUndefined();
  });
});

describe('разовый проход: порции, предел, пробный запуск', () => {
  function seedMany(target: World, count: number): void {
    for (let id = 1; id <= count; id += 1) {
      const title = `ООО «Компания ${String.fromCharCode(1040 + id)}»`;
      target.crm.set(company(id, id, { title }));
    }
  }

  test('без предела читает все компании порциями и ждёт между порциями', async () => {
    seedMany(world, 5);
    const pauses: number[] = [];
    world.deps.sleep = async (ms) => {
      pauses.push(ms);
    };
    const result = await runSupplierCrmPass(world.deps, { pageSize: 2, pauseMs: 700 });
    expect(result).toMatchObject({ stoppedBy: 'none', scanned: 5, created: 5 });
    expect(await allCards(world)).toHaveLength(5);
    // Порции 2 + 2 + 1: пауза только между порциями, после последней её нет.
    expect(world.crm.calls).toBe(3);
    expect(pauses).toEqual([700, 700]);
  });

  test('--max-companies: останавливается на пределе, повтор не задваивает карточки', async () => {
    seedMany(world, 5);
    const first = await runSupplierCrmPass(world.deps, { ...OPTIONS, maxCompanies: 2, pageSize: 10 });
    expect(first).toMatchObject({ stoppedBy: 'limit', scanned: 2, created: 2 });
    // Курсор живёт только в запуске: повтор читает с начала, уже заведённые - без изменений.
    const second = await runSupplierCrmPass(world.deps, OPTIONS);
    expect(second).toMatchObject({ stoppedBy: 'none', scanned: 5, created: 3, unchanged: 2 });
    expect(await allCards(world)).toHaveLength(5);
    const third = await runSupplierCrmPass(world.deps, OPTIONS);
    expect(third).toMatchObject({ scanned: 5, created: 0, enriched: 0, unchanged: 5 });
    expect(await allCards(world)).toHaveLength(5);
  });

  test('предел кратен порции: лишнего запроса к порталу нет', async () => {
    seedMany(world, 4);
    const result = await runSupplierCrmPass(world.deps, { ...OPTIONS, maxCompanies: 2, pageSize: 2 });
    expect(result).toMatchObject({ stoppedBy: 'limit', scanned: 2 });
    expect(world.crm.calls).toBe(1);
  });

  test('--dry-run: ничего не пишет (карточки, связи, заметки, аудит), считает «было бы»', async () => {
    world.crm.set(company(10, 1, { title: 'ООО «Вега Трейд»', inn: INN_ALPHA }));
    const existing = await seed(world, { name: 'Альфа Опт', inn: INN_BETA });
    world.crm.set(company(11, 2, { title: 'Альфа Опт', inn: INN_BETA, emails: ['a@alfa.test'] }));
    const before = await allCards(world);
    const result = await runSupplierCrmPass(world.deps, { ...OPTIONS, dryRun: true });
    expect(result).toMatchObject({ dryRun: true, scanned: 2, created: 1, enriched: 1 });
    expect(await allCards(world)).toEqual(before);
    expect((await allCards(world))[0]?.id).toBe(existing.id);
    expect(await world.state.get(SUPPLIER_CRM_LINK_NAMESPACE, '10')).toBeNull();
    expect(await world.state.get(SUPPLIER_CRM_LINK_NAMESPACE, '11')).toBeNull();
    expect(await world.audit.list()).toHaveLength(0);
    // Тот же прогон с записью даёт тот же итог: пробный запуск не врёт.
    const real = await runSupplierCrmPass(world.deps, OPTIONS);
    expect(real).toMatchObject({ dryRun: false, created: 1, enriched: 1 });
  });

  test('needsReview: id компаний с двусмысленным совпадением и расхождением связи', async () => {
    const existing = await seed(world, { name: 'Вега Трейд', inn: INN_ALPHA });
    await world.state.put(SUPPLIER_CRM_LINK_NAMESPACE, '10', {
      supplierId: existing.id,
      at: '2026-10-01T00:00:00.000Z',
    });
    world.crm.set(company(10, 1, { title: 'Вега Трейд', inn: INN_BETA }));
    world.crm.set(company(11, 2, { title: 'ООО «Новая»' }));
    const result = await runSupplierCrmPass(world.deps, OPTIONS);
    expect(result.needsReview).toEqual(['10']);
  });

  test('нет прав вебхука на CRM: остановка access_denied, одна строка в журнале', async () => {
    const denied: CrmSuppliers = {
      passes: ['default'],
      listSupplierCompanies: async (): Promise<never> => {
        throw new ExternalAccessDeniedError('нет прав');
      },
    };
    const blocked = build({ crm: denied });
    const result = await runSupplierCrmPass(blocked.deps, OPTIONS);
    expect(result).toMatchObject({ stoppedBy: 'access_denied', scanned: 0 });
    expect(events(blocked, 'supplier_crm_sync_access_denied')).toHaveLength(1);
  });

  test('временный сбой портала пробрасывается, повтор после сбоя дочитывает', async () => {
    world.crm.failing = true;
    await expect(runSupplierCrmPass(world.deps, OPTIONS)).rejects.toThrow();
    world.crm.failing = false;
    world.crm.set(company(10, 1, { title: 'ООО «Вега Трейд»' }));
    expect((await runSupplierCrmPass(world.deps, OPTIONS)).created).toBe(1);
  });

  test('ошибка записи посреди прохода: повтор дозавершает без дублей', async () => {
    seedMany(world, 3);
    const original = world.suppliers.saveCard.bind(world.suppliers);
    let saves = 0;
    world.suppliers.saveCard = async (...args) => {
      saves += 1;
      if (saves === 3) throw new Error('база недоступна');
      return original(...args);
    };
    await expect(runSupplierCrmPass(world.deps, OPTIONS)).rejects.toThrow('база недоступна');
    world.suppliers.saveCard = original;
    const result = await runSupplierCrmPass(world.deps, OPTIONS);
    expect(result).toMatchObject({ scanned: 3 });
    expect(await allCards(world)).toHaveLength(3);
  });

  test('чтение не сдвинулось при hasMore: остановка budget, а не бесконечный цикл', async () => {
    let calls = 0;
    const stuck: CrmSuppliers = {
      passes: ['default'],
      listSupplierCompanies: async () => {
        calls += 1;
        return { companies: [], hasMore: true, viewedUntil: null, markerMismatch: 0 };
      },
    };
    const w = build({ crm: stuck });
    const result = await runSupplierCrmPass(w.deps, OPTIONS);
    expect(result.stoppedBy).toBe('budget');
    expect(calls).toBe(1);
  });

  test('курсор просмотра передаётся в следующую порцию того же запуска', async () => {
    const viewed: CrmSuppliersCursor = { modifiedAt: '2026-10-01T10:50:00.000Z', id: '77' };
    const afters: Array<CrmSuppliersCursor | null> = [];
    const crm: CrmSuppliers = {
      passes: ['default'],
      listSupplierCompanies: async (query) => {
        afters.push(query.after);
        const first = afters.length === 1;
        return {
          companies: [],
          hasMore: first,
          viewedUntil: viewed,
          markerMismatch: first ? 4 : 0,
        };
      },
    };
    const w = build({ crm });
    await runSupplierCrmPass(w.deps, OPTIONS);
    expect(afters).toEqual([null, viewed]);
    // Портал, скорее всего, проигнорировал фильтр: об этом сообщается числом, без значений.
    expect(events(w, 'supplier_crm_sync_filter_suspect')).toEqual([
      { reason: 'marker_mismatch', count: 4, pass: 'default' },
    ]);
  });

  test('пустой первый запрос: предупреждение о фильтре', async () => {
    const w = build();
    const result = await runSupplierCrmPass(w.deps, OPTIONS);
    expect(result).toMatchObject({ stoppedBy: 'none', scanned: 0 });
    expect(events(w, 'supplier_crm_sync_filter_suspect')).toEqual([
      { reason: 'empty_first_pass', count: 0, pass: 'default' },
    ]);
  });
});

describe('ревью 221: бюджет времени', () => {
  const READ_MS = 6 * 60_000;
  const WRITE_MS = 3 * 60_000;

  test('долгое чтение портала не съедает бюджет обработки', async () => {
    const slow = build();
    slow.crm.set(company(10, 1, { title: 'ООО «Вега Трейд»' }));
    slow.deps.crm = {
      passes: ['default'],
      listSupplierCompanies: async (query) => {
        const page = await slow.crm.listSupplierCompanies(query);
        slow.clock.advance(READ_MS);
        return page;
      },
    };
    const result = await runSupplierCrmPass(slow.deps, OPTIONS);
    expect(result).toMatchObject({ stoppedBy: 'none', scanned: 1, created: 1 });
  });

  test('бюджет обработки: проход останавливается, повтор дозавершает без дублей', async () => {
    const slow = build();
    for (let id = 1; id <= 3; id += 1) {
      slow.crm.set(company(id, id, { title: `ООО «Компания ${String.fromCharCode(1040 + id)}»` }));
    }
    const original = slow.suppliers.saveCard.bind(slow.suppliers);
    slow.suppliers.saveCard = async (...args) => {
      slow.clock.advance(WRITE_MS);
      return original(...args);
    };
    const first = await runSupplierCrmPass(slow.deps, OPTIONS);
    expect(first).toMatchObject({ stoppedBy: 'budget', scanned: 1, created: 1 });
    slow.suppliers.saveCard = original;
    const second = await runSupplierCrmPass(slow.deps, OPTIONS);
    expect(second).toMatchObject({ stoppedBy: 'none', created: 2, unchanged: 1 });
    expect(await allCards(slow)).toHaveLength(3);
  });
});

describe('ревью 221: журнал и индекс', () => {
  test('расхождение связи: предупреждение с id карточки и компании, без значений', async () => {
    const existing = await seed(world, { name: 'Вега Трейд', inn: INN_ALPHA });
    await world.state.put(SUPPLIER_CRM_LINK_NAMESPACE, '10', {
      supplierId: existing.id,
      at: '2026-10-01T00:00:00.000Z',
    });
    world.crm.set(company(10, 1, { title: 'Вега Трейд', inn: INN_BETA }));
    await runSupplierCrmPass(world.deps, OPTIONS);
    expect(events(world, 'supplier_crm_sync_link_mismatch')).toEqual([
      { supplierId: existing.id, companyId: '10' },
    ]);
    expect(JSON.stringify(world.logs)).not.toContain(INN_BETA);
  });

  test('индекс доменов строится один раз и видит только что созданные карточки', async () => {
    let pages = 0;
    const original = world.suppliers.listPage.bind(world.suppliers);
    world.suppliers.listPage = async (...args) => {
      pages += 1;
      return original(...args);
    };
    for (let id = 1; id <= 4; id += 1) {
      world.crm.set(
        company(id, id, {
          title: `ООО «Компания ${String.fromCharCode(1040 + id)}»`,
          emails: [`office@kompaniya${id}.test`],
        }),
      );
    }
    // Тот же корпоративный домен, что у первой созданной карточки, но другое название.
    world.crm.set(company(5, 5, { title: 'Совсем Другая', emails: ['sales@kompaniya1.test'] }));
    const result = await runSupplierCrmPass(world.deps, OPTIONS);
    expect(result).toMatchObject({ created: 4, ambiguous: 1 });
    expect(pages).toBeLessThanOrEqual(2);
  });
});

describe('ревью 221: контакты', () => {
  test('почта нашего домена не попадает в карточку, такой контакт отбрасывается', async () => {
    world.crm.set(
      company(10, 1, {
        title: 'ООО «Вега Трейд»',
        emails: ['info@company.test', 'office@vega-trade.test'],
        contacts: [
          { fullName: 'Сотрудников Семён', email: 'semen@company.test' },
          { fullName: 'Петров Пётр', email: 'p@vega-trade.test' },
        ],
      }),
    );
    await runSupplierCrmPass(world.deps, OPTIONS);
    const [card] = await allCards(world);
    const addresses = card?.contacts.map((c) => c.email) ?? [];
    expect(addresses.some((email) => email?.endsWith('@company.test'))).toBe(false);
    expect(addresses).toContain('office@vega-trade.test');
    expect(addresses).toContain('p@vega-trade.test');
    expect(card?.contacts.some((c) => c.fullName?.includes('Сотрудников'))).toBe(false);
  });

  test('соцсети и мессенджеры не пишутся в сайт: берётся первый настоящий сайт', async () => {
    world.crm.set(
      company(10, 1, {
        title: 'ООО «Вега Трейд»',
        websites: ['https://vk.com/vegatrade', 'https://t.me/vega', 'https://www.vega-trade.test'],
      }),
    );
    world.crm.set(
      company(11, 2, {
        title: 'ООО «Альфа Опт»',
        websites: [
          'https://wa.me/79000000000',
          'https://www.instagram.com/alfa',
          'https://ok.ru/alfa',
        ],
      }),
    );
    await runSupplierCrmPass(world.deps, OPTIONS);
    const cards = await allCards(world);
    expect(cards.find((c) => c.name.includes('Вега'))?.website).toContain('vega-trade.test');
    expect(cards.find((c) => c.name.includes('Альфа'))?.website).toBeUndefined();
  });
});
