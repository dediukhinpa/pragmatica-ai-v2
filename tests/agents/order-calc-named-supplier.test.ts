import { beforeEach, describe, expect, test } from 'bun:test';
import { askManagerToChoose } from '../../src/agents/order-calc/ask-manager-to-choose';
import { buildShortlist } from '../../src/agents/order-calc/build-shortlist';
import { loadProposal } from '../../src/agents/order-calc/state';
import {
  prepareSupplierRequestText,
} from '../../src/agents/order-calc/prepare-supplier-request-text';
import { recordChoiceButton } from '../../src/agents/order-calc/choice-confirmation';
import { recordSelection } from '../../src/agents/order-calc/record-selection';
import { searchKnowledgeSuppliers, searchWeb } from '../../src/agents/order-calc/search-sources';
import { SHORTLIST_MAX_SIZE } from '../../src/kit/domain/shortlist';
import { CTX } from './support';
import {
  REQUEST_ID,
  buildOrderDeps,
  employeeToolContext,
  pickTarget,
  pressDone,
  type OrderTestDeps,
} from './order-support';

/** Поставщик, которого назвал сотрудник (как в бою 29.10): дороже всех остальных. */
const NAMED_ID = 'sup-test-1029-a';
const NAMED_NAME = 'ТЕСТ Поставщик А';
const NAMED_EMAIL = 'a@test-supplier.test';
const NAMED_PRICE = 310;
/** Дешёвых поставщиков больше, чем мест в шорт-листе: названный вытесняется ранжированием. */
const CHEAP_COUNT = SHORTLIST_MAX_SIZE + 2;
const CHEAP_BASE_PRICE = 10;
/** Дешевле всех: «не работаем» попадает в результаты поиска и исключается автоотбором. */
const INACTIVE_PRICE = 1;
const CREATED_AT = '2026-01-01T00:00:00.000Z';

let deps: OrderTestDeps;
let events: Array<{ event: string; fields?: Record<string, string | number | boolean> }>;

/** Карточка с прайсом на арматуру. */
async function addSupplier(
  id: string,
  name: string,
  price: number,
  options: { email?: string; status?: 'active' | 'inactive' } = {},
): Promise<void> {
  await deps.suppliers.saveCard({
    id,
    name,
    status: options.status ?? 'active',
    contacts: options.email === undefined ? [] : [{ email: options.email, isPrimary: true }],
    supplies: { categories: [], brands: [], regions: [] },
    terms: {},
    notes: [],
  });
  await deps.prices.saveImport(
    id,
    [{ supplierId: id, productName: 'Арматура 12 мм', price, currency: 'RUB', date: CREATED_AT }],
    `seed-${id}`,
  );
}

beforeEach(async () => {
  deps = await buildOrderDeps();
  events = [];
  deps.log = (event, fields) => {
    events.push({ event, ...(fields === undefined ? {} : { fields }) });
  };
  for (let index = 0; index < CHEAP_COUNT; index += 1) {
    await addSupplier(`cheap-${index}`, `Дешёвый ${index}`, CHEAP_BASE_PRICE + index);
  }
  await addSupplier(NAMED_ID, NAMED_NAME, NAMED_PRICE, { email: NAMED_EMAIL });
});

async function build(namedSuppliers?: string[]) {
  const input = { requestId: REQUEST_ID };
  await searchKnowledgeSuppliers.execute(input, deps, CTX);
  await searchWeb.execute(input, deps, CTX);
  return buildShortlist.execute(
    { ...input, ...(namedSuppliers === undefined ? {} : { namedSuppliers }) },
    deps,
    CTX,
  );
}

const ids = (entries: ReadonlyArray<{ supplierId: string }>): string[] =>
  entries.map((entry) => entry.supplierId);

describe('buildShortlist: поставщик, названный сотрудником', () => {
  test('без названия дорогой поставщик вытеснен ранжированием (исходная проблема)', async () => {
    const out = await build();
    expect(ids(out.entries)).not.toContain(NAMED_ID);
    expect(out.namedSuppliers).toBeUndefined();
  });

  test('по названию - первым вне лимита, с ценой и пометкой; остальные не меняются', async () => {
    const before = ids((await build()).entries);
    const out = await build([NAMED_NAME]);
    expect(ids(out.entries)).toEqual([NAMED_ID, ...before]);
    expect(out.entries[0]).toMatchObject({ hasEmail: true, hasPrice: true });
    expect(out.namedSuppliers).toEqual([
      { name: NAMED_NAME, status: 'added', supplierId: NAMED_ID },
    ]);
    const proposal = await loadProposal(deps, REQUEST_ID);
    const entry = proposal?.entries[0];
    expect(entry?.namedByManager).toBe(true);
    expect(entry?.prices?.map((price) => price.amount)).toEqual([NAMED_PRICE]);
    // Строка добавлена сверх найденных: не показанных столько же, сколько без названия.
    expect(out.truncated).toBe((await build()).truncated);
    expect(events.find((item) => item.event === 'shortlist_named_suppliers')?.fields).toEqual({
      requested: 1,
      added: 1,
      outsideResults: 1,
      notFound: 0,
      ambiguous: 0,
      inactive: 0,
    });
  });

  test('найден без цены (по категории карточки) - цена берётся из его прайса', async () => {
    // Бой 29.10: «ТЕСТ Поставщик А» пришёл через базу знаний без цены, в шорт-листе - «нет данных»
    const card = await deps.suppliers.getCard(NAMED_ID);
    if (card === null) throw new Error('нет карточки');
    await deps.suppliers.saveCard({
      ...card,
      supplies: { ...card.supplies, categories: ['Арматура'] },
    });
    const out = await build([NAMED_NAME]);
    expect(out.entries[0]).toMatchObject({ supplierId: NAMED_ID, hasPrice: true });
    const proposal = await loadProposal(deps, REQUEST_ID);
    expect(proposal?.entries[0]?.prices?.map((price) => price.amount)).toEqual([NAMED_PRICE]);
  });

  test('по id и в другом регистре с юр. формой - та же карточка, без повтора', async () => {
    const out = await build([NAMED_ID, `ООО «${NAMED_NAME.toLowerCase()}»`]);
    expect(ids(out.entries).filter((id) => id === NAMED_ID)).toHaveLength(1);
    expect(out.namedSuppliers?.map((item) => item.status)).toEqual(['added', 'added']);
  });

  test('уже показанный поставщик переносится в начало без повтора', async () => {
    const out = await build(['Дешёвый 1']);
    expect(ids(out.entries)[0]).toBe('cheap-1');
    expect(ids(out.entries).filter((id) => id === 'cheap-1')).toHaveLength(1);
    expect(out.entries).toHaveLength(SHORTLIST_MAX_SIZE);
  });

  test('неоднозначное название - не угадываем, отдаём карточки для уточнения', async () => {
    await addSupplier('sup-b1', 'ТЕСТ Поставщик Б1', NAMED_PRICE);
    await addSupplier('sup-b2', 'ТЕСТ Поставщик Б2', NAMED_PRICE);
    const out = await build(['ТЕСТ Поставщик Б']);
    expect(ids(out.entries)).not.toContain('sup-b1');
    expect(ids(out.entries)).not.toContain('sup-b2');
    expect(out.namedSuppliers).toEqual([
      {
        name: 'ТЕСТ Поставщик Б',
        status: 'ambiguous',
        candidates: [
          { supplierId: 'sup-b1', name: 'ТЕСТ Поставщик Б1' },
          { supplierId: 'sup-b2', name: 'ТЕСТ Поставщик Б2' },
        ],
      },
    ]);
  });

  test('нет карточки - not_found, как раньше', async () => {
    const out = await build(['Несуществующий']);
    expect(out.namedSuppliers).toEqual([{ name: 'Несуществующий', status: 'not_found' }]);
  });

  test('«не работаем» не назван - исключён и посчитан в excludedInactive', async () => {
    await addSupplier('sup-off', 'Закрытый Поставщик', INACTIVE_PRICE, { status: 'inactive' });
    const out = await build();
    expect(ids(out.entries)).not.toContain('sup-off');
    expect(out.excludedInactive).toBe(1);
  });

  test('«не работаем» назван вручную - в списке с пометкой, не в excludedInactive', async () => {
    await addSupplier('sup-off', 'Закрытый Поставщик', INACTIVE_PRICE, {
      status: 'inactive',
      email: 'off@test-supplier.test',
    });
    await addSupplier('sup-off2', 'Закрытый Второй', INACTIVE_PRICE, { status: 'inactive' });
    const out = await build(['Закрытый Поставщик']);
    expect(ids(out.entries)[0]).toBe('sup-off');
    expect(out.entries[0]).toMatchObject({ hasEmail: true, hasPrice: true });
    expect(out.namedSuppliers).toEqual([
      { name: 'Закрытый Поставщик', status: 'added', supplierId: 'sup-off', inactive: true },
    ]);
    // Автоматически исключён только второй, названного в счётчике нет.
    expect(out.excludedInactive).toBe(1);
    const proposal = await loadProposal(deps, REQUEST_ID);
    expect(proposal?.entries[0]).toMatchObject({ namedByManager: true, namedInactive: true });
    await askManagerToChoose.execute({ requestId: REQUEST_ID, version: out.version }, deps, CTX);
    const shown = deps.chat.outbox.map((record) => record.message?.text ?? '').join('\n');
    expect(shown).toContain('карточка: не работаем, добавлен по вашему указанию');
  });

  test('«не работаем» назван вручную - письмо ему готовится как всем', async () => {
    await addSupplier('sup-off', 'Закрытый Поставщик', INACTIVE_PRICE, {
      status: 'inactive',
      email: 'off@test-supplier.test',
    });
    const out = await build(['Закрытый Поставщик']);
    await askManagerToChoose.execute({ requestId: REQUEST_ID, version: out.version }, deps, CTX);
    const target = await pickTarget(deps.state, CTX.threadId, 'sup-off');
    const press = { supplierId: target, userId: 'manager', threadId: CTX.threadId };
    await recordChoiceButton(deps.state, deps.clock, press);
    await pressDone(deps, CTX.threadId);
    await recordSelection.execute({ requestId: REQUEST_ID, supplierIds: ['sup-off'] }, deps, CTX);
    const text = await prepareSupplierRequestText.execute(
      { requestId: REQUEST_ID },
      deps,
      employeeToolContext('u1', CTX.threadId),
    );
    expect(text.shownSupplierIds).toEqual(['sup-off']);
    expect(text.withoutContact).toEqual([]);
  });

  test('названного можно выбрать и подготовить ему текст запроса', async () => {
    const out = await build([NAMED_NAME]);
    await askManagerToChoose.execute({ requestId: REQUEST_ID, version: out.version }, deps, CTX);
    const shown = deps.chat.outbox.map((record) => record.message?.text ?? '').join('\n');
    expect(shown).toContain('вы указали');
    const target = await pickTarget(deps.state, CTX.threadId, NAMED_ID);
    const press = { supplierId: target, userId: 'manager', threadId: CTX.threadId };
    await recordChoiceButton(deps.state, deps.clock, press);
    await pressDone(deps, CTX.threadId);
    const selection = await recordSelection.execute(
      { requestId: REQUEST_ID, supplierIds: [NAMED_ID] },
      deps,
      CTX,
    );
    expect(selection).toMatchObject({ selected: 1, withoutContact: [] });
    const text = await prepareSupplierRequestText.execute(
      { requestId: REQUEST_ID },
      deps,
      // Заявку ведёт тред, собравший шорт-лист: текст готовит тот же сотрудник.
      employeeToolContext('u1', CTX.threadId),
    );
    expect(text.shownSupplierIds).toEqual([NAMED_ID]);
    expect(text.withoutContact).toEqual([]);
  });
});
