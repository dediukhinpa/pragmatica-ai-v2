import { describe, expect, test } from 'bun:test';
import { runSupplierCrmPass } from '../../src/agents/suppliers/crm-sync';
import { DAY_MS } from '../../src/kit/domain/time';
import type {
  CrmSuppliers,
  CrmSuppliersCursor,
  CrmSuppliersPage,
} from '../../src/kit/ports/crm-suppliers';
import { OPTIONS, allCards, build, company, type World } from './suppliers-crm-sync-support';

/**
 * Поставщики CRM = объединение двух признаков (этап 221): воронка «Поставщики» ИЛИ тип компании.
 * Два прохода чтения, курсор каждого живёт только в запуске; компания из обоих множеств разбирается один раз.
 * CRM - заглушка в памяти (состав по проходам задаёт тест).
 */

const CATEGORY = 'category-8';
const TYPE = 'companyType-SUPPLIER';
const BOTH = [CATEGORY, TYPE];
/** Минута, с которой компании заведомо старше запаса по времени перед курсором. */
const FAR_MINUTE = 120;

const title = (id: number): string => `ООО «Компания ${String.fromCharCode(1040 + id)}»`;

function union(): World {
  return build({}, undefined, BOTH);
}

/** Журнал: события с данным именем. */
function events(world: World, name: string): Array<Record<string, unknown>> {
  return world.logs.filter((entry) => entry.event === name).map((entry) => entry.fields);
}

describe('оба признака', () => {
  test('компании из обоих множеств попадают в базу, пересечение - один раз', async () => {
    const w = union();
    w.crm.set(company(1, 1, { title: title(1) }), [TYPE]);
    w.crm.set(company(2, 2, { title: title(2) }), [CATEGORY]);
    w.crm.set(company(3, 3, { title: title(3) }), [CATEGORY, TYPE]);
    const result = await runSupplierCrmPass(w.deps, OPTIONS);
    expect(result).toMatchObject({
      stoppedBy: 'none',
      scanned: 3,
      created: 3,
      duplicates: 0,
      passes: `${CATEGORY}+${TYPE}`,
    });
    expect(await allCards(w)).toHaveLength(3);
  });

  test('одна компания у обоих проходов: разобрана один раз', async () => {
    const shared = company(5, 1, { title: title(5) });
    const only = company(6, 2, { title: title(6) });
    const reads: string[] = [];
    const crm: CrmSuppliers = {
      passes: BOTH,
      listSupplierCompanies: async (query) => {
        reads.push(query.pass ?? '');
        const rows = query.pass === CATEGORY ? [shared] : [shared, only];
        const last = rows[rows.length - 1];
        return {
          companies: rows.map((row) => ({ ...row })),
          hasMore: false,
          viewedUntil: last === undefined ? null : { modifiedAt: last.modifiedAt, id: last.id },
          markerMismatch: 0,
        } satisfies CrmSuppliersPage;
      },
    };
    const w = build({ crm });
    const result = await runSupplierCrmPass(w.deps, OPTIONS);
    expect(reads).toEqual(BOTH);
    expect(result).toMatchObject({ scanned: 2, created: 2, duplicates: 1 });
    expect(await allCards(w)).toHaveLength(2);
  });

  test('--max-companies общий на оба признака; повтор дочитывает без дублей', async () => {
    const w = union();
    w.crm.set(company(1, 1, { title: title(1) }), [CATEGORY]);
    w.crm.set(company(2, 2, { title: title(2) }), [CATEGORY]);
    w.crm.set(company(3, 3, { title: title(3) }), [TYPE]);
    w.crm.set(company(4, 4, { title: title(4) }), [TYPE]);
    const first = await runSupplierCrmPass(w.deps, { ...OPTIONS, maxCompanies: 2 });
    expect(first).toMatchObject({ stoppedBy: 'limit', scanned: 2, created: 2 });
    const second = await runSupplierCrmPass(w.deps, OPTIONS);
    expect(second).toMatchObject({ stoppedBy: 'none', scanned: 4, created: 2, unchanged: 2 });
    expect(await allCards(w)).toHaveLength(4);
  });

  test('каждый проход начинает чтение с начала списка', async () => {
    const afters = new Map<string, CrmSuppliersCursor | null>();
    const crm: CrmSuppliers = {
      passes: BOTH,
      listSupplierCompanies: async (query) => {
        afters.set(query.pass ?? '', query.after);
        return { companies: [], hasMore: false, viewedUntil: null, markerMismatch: 0 };
      },
    };
    const w = build({ crm });
    await runSupplierCrmPass(w.deps, OPTIONS);
    expect(afters.get(CATEGORY)).toBeNull();
    expect(afters.get(TYPE)).toBeNull();
  });
});

/**
 * Порт с правкой состава CRM между проходами: `afterRead` вызывается сразу после чтения данного
 * прохода (сотрудник правит CRM, пока идёт разбор прочитанного).
 */
function editingCrm(world: World, pass: string, afterRead: () => void): CrmSuppliers {
  const inner = world.crm;
  return {
    passes: inner.passes,
    listSupplierCompanies: async (query) => {
      const page = await inner.listSupplierCompanies(query);
      if (query.pass === pass) afterRead();
      return page;
    },
  };
}

describe('компания переходит между множествами', () => {
  test('свежая версия разобранной компании разбирается заново, в счёт не идёт', async () => {
    const w = union();
    w.crm.set(company(1, 1, { title: title(1) }), [CATEGORY, TYPE]);
    // Пока шёл разбор, компанию вывели из воронки и тем же сохранением добавили почту. Позже неё
    // больше чем на запас по времени стоит другая компания типа: курсор типа уйдёт за первую.
    const edited = (): void => {
      w.crm.set(
        company(1, FAR_MINUTE, { title: title(1), emails: ['office@kompaniya-a.test'] }),
        [TYPE],
      );
      w.crm.set(company(2, 2 * FAR_MINUTE, { title: title(2) }), [TYPE]);
    };
    w.deps.crm = editingCrm(w, CATEGORY, edited);
    const first = await runSupplierCrmPass(w.deps, OPTIONS);
    expect(first).toMatchObject({ stoppedBy: 'none', created: 2, duplicates: 0 });
    // В счёт идут компания 1 (прочитанная версия) и компания 2; свежая версия компании 1 - повтор.
    expect(first.scanned).toBe(2);
    expect(first.replayed).toBe(1);
    const emails = (await allCards(w)).flatMap((card) => card.contacts.map((c) => c.email));
    expect(emails).toContain('office@kompaniya-a.test');
    // Следующий запуск ничего не теряет и не откатывает.
    w.clock.advance(4 * DAY_MS);
    await runSupplierCrmPass(w.deps, OPTIONS);
    expect(await allCards(w)).toHaveLength(2);
  });

  test('та же версия компании у второго прохода - по-прежнему повтор', async () => {
    // Порт (в отличие от адаптера портала) отдаёт ту же версию обоими проходами.
    const same = company(3, 3, { title: title(3) });
    const crm: CrmSuppliers = {
      passes: BOTH,
      listSupplierCompanies: async () => ({
        companies: [{ ...same }],
        hasMore: false,
        viewedUntil: { modifiedAt: same.modifiedAt, id: same.id },
        markerMismatch: 0,
      }),
    };
    const w = build({ crm });
    expect(await runSupplierCrmPass(w.deps, OPTIONS)).toMatchObject({
      scanned: 1,
      replayed: 0,
      duplicates: 1,
    });
  });

  test('переведена в воронку после прохода воронки: не теряется, читается на следующем запуске',
    async () => {
      const w = union();
      w.crm.set(company(1, 1, { title: title(1) }), [TYPE]);
      // После чтения воронки компанию перевели в воронку (тип остался): проход типа её уже
      // считает покрытой воронкой и пропускает.
      w.deps.crm = editingCrm(w, CATEGORY, () => {
        w.crm.set(company(1, FAR_MINUTE, { title: title(1) }), [CATEGORY, TYPE]);
      });
      const first = await runSupplierCrmPass(w.deps, OPTIONS);
      expect(first).toMatchObject({ stoppedBy: 'none', scanned: 0, created: 0 });
      expect(await allCards(w)).toHaveLength(0);
      // Следующий запуск: воронка читает компанию (курсор воронки её не пропустил).
      w.deps.crm = w.crm;
      w.clock.advance(4 * DAY_MS);
      const second = await runSupplierCrmPass(w.deps, OPTIONS);
      expect(second).toMatchObject({ scanned: 1, created: 1 });
      expect(await allCards(w)).toHaveLength(1);
    });

  test('выведена из воронки, тип остался: изменённую компанию читает проход типа', async () => {
    const w = union();
    w.crm.set(company(1, 1, { title: title(1) }), [CATEGORY, TYPE]);
    await runSupplierCrmPass(w.deps, OPTIONS);
    expect(await allCards(w)).toHaveLength(1);
    w.crm.set(
      company(1, FAR_MINUTE, { title: title(1), emails: ['office@kompaniya-a.test'] }),
      [TYPE],
    );
    w.clock.advance(4 * DAY_MS);
    const second = await runSupplierCrmPass(w.deps, OPTIONS);
    expect(second).toMatchObject({ scanned: 1, enriched: 1 });
    const emails = (await allCards(w)).flatMap((card) => card.contacts.map((c) => c.email));
    expect(emails).toContain('office@kompaniya-a.test');
  });
});

describe('один признак', () => {
  test.each([[CATEGORY], [TYPE]])('только %s: один проход', async (pass) => {
    const w = build({}, undefined, [pass]);
    w.crm.set(company(1, 1, { title: title(1) }));
    const result = await runSupplierCrmPass(w.deps, OPTIONS);
    expect(result).toMatchObject({ scanned: 1, created: 1, passes: pass });
    expect(w.crm.calls).toBe(1);
  });
});

describe('предупреждения о фильтре', () => {
  test('пустой первый проход называет проход; покрытый воронкой - без тревоги', async () => {
    const w = union();
    w.crm.set(company(1, 1, { title: title(1) }), [CATEGORY, TYPE]);
    await runSupplierCrmPass(w.deps, OPTIONS);
    // Проход типа не отдал ни одной компании, но прошёл мимо общей: фильтр не подозревается.
    expect(events(w, 'supplier_crm_sync_filter_suspect')).toEqual([]);
    const empty = union();
    await runSupplierCrmPass(empty.deps, OPTIONS);
    expect(events(empty, 'supplier_crm_sync_filter_suspect')).toEqual([
      { reason: 'empty_first_pass', count: 0, pass: CATEGORY },
      { reason: 'empty_first_pass', count: 0, pass: TYPE },
    ]);
  });
});
