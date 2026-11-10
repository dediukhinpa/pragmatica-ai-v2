import { describe, expect, test } from "bun:test";
import { buildShortlist } from "../../src/agents/order-calc/build-shortlist";
import { searchKnowledgeSuppliers } from "../../src/agents/order-calc/search-sources";
import { CTX } from "./support";
import { ORDER_REQUEST, REQUEST_ID, buildOrderDeps } from "./order-support";

/** Этап 108: buildShortlist отдаёт модели числа по базе, без названий и контактов. */
describe("buildShortlist: числа по базе", () => {
  test("поставщик с ценой считается, пустая база даёт нули", async () => {
    const deps = await buildOrderDeps({
      request: {
        ...ORDER_REQUEST,
        items: [{ name: "Мёд липовый", quantity: 30, unit: "шт" }],
      },
    });
    await deps.suppliers.saveCard({
      id: "honey",
      name: "Пасека Липовая",
      status: "new",
      contacts: [],
      supplies: { categories: [], brands: [], regions: [] },
      terms: {},
      notes: [],
    });
    await deps.prices.saveImport(
      "honey",
      [
        {
          supplierId: "honey",
          productName: "Мёд липовый",
          price: 400,
          currency: "RUB",
          date: "2026-01-01",
        },
      ],
      "seed-honey",
    );
    await searchKnowledgeSuppliers.execute(
      { requestId: REQUEST_ID },
      deps,
      CTX,
    );
    const out = await buildShortlist.execute(
      { requestId: REQUEST_ID, limit: 10 },
      deps,
      CTX,
    );
    expect(out.baseSuppliersShown).toBe(1);
    expect(out.baseSuppliersWithPrice).toBe(1);
    expect(out.documentHints).toBe(0);
  });
});
