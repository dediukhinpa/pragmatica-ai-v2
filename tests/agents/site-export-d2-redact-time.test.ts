import { beforeEach, describe, expect, test } from "bun:test";
import { gatherItemData } from "../../src/agents/site-export/gather-item-data";
import { findTextRisks, redactTextRisks } from "@business-ai/core";
import {
  MAIL_USER_1,
  buildMailboxes,
  buildSiteDeps,
  employeeContext,
  type SiteTestDeps,
} from "./site-support";
import { CREATED_AT } from "./support";

/**
 * R8-D2-02: тема письма и поля карточки из длинной цепочки «a.a.a.» не должны давать
 * квадратичный откат ветки домена в LINK_PATTERN.
 */

/** Предел времени, мс. */
const TIME_LIMIT_MS = 100;
const REPEATS = 5000;
/** Метка длиннее 63 знаков, цепочка длиннее 16 меток, предел ячейки таблицы. */
const LONG_LABEL = 70;
const MANY_LABELS = 20;
const CELL_LIMIT = 32_767;

let deps: SiteTestDeps;
beforeEach(async () => {
  deps = await buildSiteDeps();
});

function elapsedMs(run: () => void): number {
  const started = performance.now();
  run();
  return performance.now() - started;
}

describe("R8-D2-02: длинные входы text-risks", () => {
  test("gatherItemData: тема из 10 000 знаков «a.a.a.» обрабатывается быстро", async () => {
    const mailboxes = buildMailboxes();
    mailboxes.deliver(MAIL_USER_1, {
      id: "long1",
      from: "sales@s1.test",
      subject: `Болт 1 ${"a.".repeat(REPEATS)}`,
      body: "Болт 1: цена 11",
      receivedAt: CREATED_AT,
      attachments: [],
    });
    // Прогрев: первый вызов дороже из-за холодного старта (zod, JIT), к regex не относится.
    const warm = buildMailboxes();
    warm.deliver(MAIL_USER_1, {
      id: "warm1",
      from: "sales@s1.test",
      subject: "Болт 1",
      body: "Болт 1: цена 11",
      receivedAt: CREATED_AT,
      attachments: [],
    });
    await gatherItemData.execute(
      { exportId: "exp-warm", query: "Болт 1" },
      { ...deps, mailboxes: warm },
      employeeContext(MAIL_USER_1),
    );
    const started = performance.now();
    const out = await gatherItemData.execute(
      { exportId: "exp-long", query: "Болт 1" },
      { ...deps, mailboxes },
      employeeContext(MAIL_USER_1),
    );
    const time = performance.now() - started;
    expect(out.emails.length).toBe(1);
    expect(time).toBeLessThan(TIME_LIMIT_MS);
  });

  test("redactTextRisks / findTextRisks на «a.»*5000 и «12-»*5000", () => {
    for (const unit of ["a.", "12-"]) {
      const text = unit.repeat(REPEATS);
      expect(elapsedMs(() => redactTextRisks(text))).toBeLessThan(
        TIME_LIMIT_MS,
      );
      expect(elapsedMs(() => findTextRisks(text))).toBeLessThan(TIME_LIMIT_MS);
    }
  });

  test("обычные тексты: результат прежний", () => {
    expect(
      redactTextRisks(
        "см. www.example.com и shop.example.ru/a, https://x.io/p",
      ),
    ).toBe("см. [ссылка удалена] и [ссылка удалена]/a, [ссылка удалена]");
    expect(redactTextRisks("сайт my-shop.ru работает")).toBe(
      "сайт [ссылка удалена] работает",
    );
    expect(redactTextRisks("Болт 1.5 мм")).toBe("Болт 1.5 мм");
    expect(findTextRisks("a.b.c.ru")).toContain("link");
  });

  test("домены с длинной меткой и многими метками вырезаются целиком", () => {
    const cases = [
      `${"x".repeat(LONG_LABEL)}.ru`,
      `ivan-${"p".repeat(LONG_LABEL + 1)}.com`,
      `i${"a.".repeat(MANY_LABELS)}ru`,
    ];
    for (const domain of cases) {
      expect(redactTextRisks(`см. ${domain} там`)).toBe(
        "см. [ссылка удалена] там",
      );
      expect(findTextRisks(domain)).toContain("link");
    }
  });

  test("«a.a.a.…» на 10 000 знаков и ячейка 32 767: время малое, ссылка вырезана", () => {
    const text = `${"a.".repeat(REPEATS)}ru`;
    expect(elapsedMs(() => redactTextRisks(text))).toBeLessThan(TIME_LIMIT_MS);
    expect(redactTextRisks(text)).toBe("[ссылка удалена]");
    const cell = `${"a.".repeat(CELL_LIMIT / 2)}`;
    expect(elapsedMs(() => redactTextRisks(cell))).toBeLessThan(TIME_LIMIT_MS);
    expect(elapsedMs(() => findTextRisks(cell))).toBeLessThan(TIME_LIMIT_MS);
  });
});
