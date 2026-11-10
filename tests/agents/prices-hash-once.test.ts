import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { commitPriceImport } from "../../src/agents/prices/commit-price-import";
import { previewPriceChanges } from "../../src/agents/prices/price-changes";
import * as employeeUpdates from "../../src/agents/prices/employee-updates";
import { CTX, SUPPLIER_ID } from "./support";
import { buildFullPricesDeps, skuItem, stageDiskCsv, type FullPricesDeps } from "./prices-support";

let base: FullPricesDeps;
let reads: number;
let hashSpy: ReturnType<typeof spyOn>;

/** Новая цена позиции со скачком (x4 от базы). */
const JUMP_PRICE = 40;

/** Порт цен с подсчётом чтений прайса поставщика; остальное делегируется настоящему порту. */
function countingDeps(): FullPricesDeps {
  const prices = Object.create(base.prices) as FullPricesDeps["prices"];
  prices.listBySupplier = async (supplierId: string) => {
    reads += 1;
    return base.prices.listBySupplier(supplierId);
  };
  return { ...base, prices };
}

beforeEach(async () => {
  base = await buildFullPricesDeps();
  await base.prices.saveImport(
    SUPPLIER_ID,
    [skuItem("Болт", 10, "B1"), skuItem("Гайка", 5, "G1")],
    "seed",
    { sourceFile: "price.csv" },
  );
  reads = 0;
  hashSpy = spyOn(employeeUpdates, "priceListHash");
});

afterEach(() => {
  hashSpy.mockRestore();
});

describe("прайс читается и хэшируется один раз", () => {
  test("commitPriceImport.execute: одно чтение, два хэша (проверка и запись)", async () => {
    const { fileHash } = await stageDiskCsv(base, [
      ["Болт", 10, "B1"],
      ["Гайка", 6, "G1"],
    ]);
    const deps = countingDeps();
    reads = 0;
    hashSpy.mockClear();
    const result = await commitPriceImport.execute(
      { supplierId: SUPPLIER_ID, fileHash },
      deps,
      CTX,
    );
    expect(result.changed).toBe(1);
    expect(reads).toBe(1);
    // Хэш основы (checkImport) и сверка основы под блокировкой в saveImport (isExpectedBase).
    expect(hashSpy).toHaveBeenCalledTimes(2);
  });

  test("previewPriceChanges.execute: одно чтение и один хэш", async () => {
    const { fileHash } = await stageDiskCsv(base, [
      ["Болт", JUMP_PRICE, "B1"],
      ["Гайка", 5, "G1"],
    ]);
    const deps = countingDeps();
    reads = 0;
    hashSpy.mockClear();
    const preview = await previewPriceChanges.execute(
      { supplierId: SUPPLIER_ID, fileHash },
      deps,
      CTX,
    );
    expect(preview.counts.jumps).toBe(1);
    expect(reads).toBe(1);
    expect(hashSpy).toHaveBeenCalledTimes(1);
  });
});
