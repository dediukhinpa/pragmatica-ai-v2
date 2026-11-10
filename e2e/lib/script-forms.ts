import { spawnSync } from 'node:child_process';
import { requireEnv } from './project-env';
import type { PiiSet } from '@business-ai/testing/e2e';

/**
 * Синтетические копии форм прайсов из спайка этапа 111 и детерминированные скрипты разбора для
 * заглушки LLM (заглушка «вызывает» runDataScript именно с этим кодом). Настоящих данных
 * заказчика здесь нет: названия, артикулы, цены и контакты выдуманы.
 */

/** Ячейка листа: текст или число. */
export type FormCell = string | number;

/** Лист книги: строки и объединения. */
export interface FormSheet {
  title: string;
  rows: ReadonlyArray<readonly FormCell[]>;
  /** Объединения в нотации Excel, например `B3:D4`. */
  merges?: readonly string[];
}

/** Ожидаемая позиция в базе: проверяется по названию (с вариантом). */
export interface ExpectedItem {
  /** Название позиции в базе (название и вариант через пробел). */
  name: string;
  price: number;
  /** Тиражи (порог, цена); пусто - тиражей нет. */
  tiers: ReadonlyArray<readonly [number, number]>;
}

/** Форма прайса: файл, скрипт и ожидаемый итог. */
export interface PriceForm {
  /** Код формы (для имён). */
  code: string;
  /** Имя файла в корне прайсов. */
  fileName: string;
  sheets: readonly FormSheet[];
  /** Python-код скрипта: точка входа `run(tables, source)`. */
  script: string;
  /** Основание тиража позиций с тиражами. */
  tierBasis: 'quantity' | 'order_sum';
  /** Все позиции, которые должны попасть в базу. */
  expected: readonly ExpectedItem[];
}

/** Персональные данные в шапке каждого файла: ни скрипт, ни модель их видеть не должны. */
export const FORM_CONTACT_NAME = 'Кузнецова Марина Олеговна';
export const FORM_CONTACT_PHONE = '+7 (495) 777-12-34';
export const FORM_CONTACT_EMAIL = 'm.kuznetsova@forms-example.ru';
export const FORM_PII: PiiSet = {
  names: ['Кузнецова', 'Марина', 'Олеговна'],
  phones: [FORM_CONTACT_PHONE],
  emails: [FORM_CONTACT_EMAIL],
};
const CONTACT_LINE = `Менеджер ${FORM_CONTACT_NAME}, тел. ${FORM_CONTACT_PHONE}, ${FORM_CONTACT_EMAIL}`;

/** Общие помощники скриптов (каждый скрипт самодостаточен: код сохраняется целиком). */
const HELPERS = `import re

def clean(c):
    return re.sub(r"\\s+", " ", c or "").strip()

def num(c):
    m = re.match(r"^\\s*(\\d[\\d\\s]*(?:[.,]\\d+)?)\\s*(?:₽|р\\.?|руб\\.?)?\\s*$", clean(c))
    if not m:
        return None
    v = float(m.group(1).replace(" ", "").replace(",", "."))
    return v if v > 0 else None

def qty(c):
    m = re.search(r"(\\d[\\d\\s]*)", clean(c))
    return int(m.group(1).replace(" ", "")) if m else None

def item(name, pairs, basis=None, **extra):
    pairs = sorted((q, p) for q, p in pairs if p is not None and q)
    if not pairs:
        return None
    out = {"name": name, "price": pairs[0][1]}
    if len(pairs) > 1:
        out["tiers"] = [{"min_quantity": q, "price": p} for q, p in pairs]
        if basis:
            out["tier_basis"] = basis
    out.update({k: v for k, v in extra.items() if v})
    return out
`;

const SIZE_RE = 'SIZE = re.compile(r"^\\d+\\s*[xх×*]\\s*\\d+", re.I)';

/** Одеяла: товар в строке-группе, размеры строками, пороги суммы заказа в шапке. */
const BLANKETS_SCRIPT = `${HELPERS}
${SIZE_RE}

def run(tables, source):
    t = tables[0]
    hi = next(i for i, r in enumerate(t) if any("Цена от" in c for c in r))
    cols = [(i, qty(c)) for i, c in enumerate(t[hi]) if "Цена от" in c]
    # Пустые столбцы сервис разбора схлопывает: артикул ищем по шапке, а не по номеру.
    sku_col = next((i for i, c in enumerate(t[hi]) if "Артикул" in c), None)
    product = ""
    out = []
    for row in t[hi + 1:]:
        cells = [clean(c) for c in row] + [""] * 3
        filled = [c for c in cells if c]
        if not filled:
            continue
        if len(filled) == 1 and not SIZE.match(cells[0]):
            if not cells[0].isupper():
                product = cells[0]
            continue
        if SIZE.match(cells[0]) and product:
            pairs = [(q, num(row[i])) for i, q in cols if i < len(row)]
            sku = cells[sku_col] if sku_col is not None else ""
            it = item(product, pairs, basis="order_sum", variant=cells[0], sku=sku)
            if it:
                out.append(it)
    return out
`;

/** Коробки: секции с тиражами в шапке секции, цены в вертикально объединённых ячейках. */
const BOXES_SCRIPT = `${HELPERS}

def run(tables, source):
    out = []
    section = ""
    cols = []
    last = None
    for row in tables[0]:
        cells = [clean(c) for c in row]
        if len(cells) > 1 and cells[1].endswith("шт"):
            section = cells[0].capitalize()
            cols = [(i, qty(c)) for i, c in enumerate(cells) if c.endswith("шт")]
            last = None
            continue
        if not section or not cells[0]:
            continue
        prices = [num(cells[i]) if i < len(cells) else None for i, _ in cols]
        if all(p is None for p in prices):
            if last is None:
                continue
            prices = last
        last = prices
        it = item(section, [(q, p) for (_, q), p in zip(cols, prices)], variant=cells[0])
        if it:
            out.append(it)
    return out
`;

/** Пакеты: блок = строка-описание, шапка «Тираж | форматы», строки тиражей; справочник не берём. */
const BAGS_SCRIPT = `${HELPERS}

def run(tables, source):
    out = []
    spec = ""
    fmts = []
    acc = {}

    def flush():
        for fmt, pairs in acc.items():
            it = item("Пакет бумажный " + fmt, pairs, variant=spec[:120])
            if it:
                out.append(it)
        acc.clear()

    for row in tables[0]:
        cells = [clean(c) for c in row]
        if any("ГОТОВЫМ ФОРМАМ" in c for c in cells):
            break
        if cells and cells[0] == "Тираж":
            flush()
            fmts = [(i, c) for i, c in enumerate(cells) if i > 0 and c]
            continue
        filled = [c for c in cells if c]
        if len(filled) == 1 and len(filled[0]) > 40:
            flush()
            spec = filled[0]
            fmts = []
            continue
        if fmts and cells and "шт" in cells[0] and qty(cells[0]):
            for i, fmt in fmts:
                acc.setdefault(fmt, []).append((qty(cells[0]), num(cells[i]) if i < len(cells) else None))
    flush()
    return out
`;

/** Чехлы: материал в строке, тиражи строками для двух размеров; вторая таблица - упаковка. */
const COVERS_SCRIPT = `${HELPERS}

def run(tables, source):
    out = []
    t = tables[0]
    hi = next(i for i, r in enumerate(t) if any(clean(c).startswith("Тираж (") for c in r))
    head = [clean(c) for c in t[hi]]
    # Столбцы тиража и цены каждого размера - по шапке (пустые столбцы разбор схлопывает).
    sizes = []
    for i, h in enumerate(head):
        if h.startswith("Тираж ("):
            size = h[h.index("(") + 1:h.index(")")]
            sizes.append((i, head.index("Цена (" + size + ")"), size))
    material_col = head.index("Материал")
    material = ""
    by_size = {}

    def flush():
        for size, pairs in by_size.items():
            it = item(material, pairs, variant="размер " + size)
            if it:
                out.append(it)
        by_size.clear()

    for row in t[hi + 1:]:
        c = [clean(x) for x in row] + [""] * len(head)
        if len(c[material_col]) > 20:
            flush()
            material = "Чехол на чемодан " + " ".join(c[material_col].split()[:2])
        if not material:
            continue
        for qty_col, price_col, size in sizes:
            if c[qty_col].startswith("от"):
                by_size.setdefault(size, []).append((qty(c[qty_col]), num(c[price_col])))
    flush()
    if len(tables) > 1:
        pack = tables[1]
        pi = next(i for i, r in enumerate(pack) if any(clean(c) == "Размер" for c in r))
        phead = [clean(x) for x in pack[pi]]
        size_col = phead.index("Размер")
        cols = [(i, qty(h)) for i, h in enumerate(phead) if h.startswith("от")]
        for row in pack[pi + 1:]:
            c = [clean(x) for x in row] + [""] * len(phead)
            it = item(c[0], [(q, num(c[i])) for i, q in cols], variant=c[size_col])
            if it:
                out.append(it)
    return out
`;

/** Шары: строки - тиражи, столбцы - варианты печати; название товара - из имени файла. */
const BALLOONS_SCRIPT = `${HELPERS}

def run(tables, source):
    t = tables[0]
    hi = next(i for i, r in enumerate(t) if clean(r[0]) == "Тираж")
    out = []
    for i, variant in enumerate(clean(c) for c in t[hi]):
        if i == 0 or not variant:
            continue
        pairs = [(qty(r[0]), num(r[i])) for r in t[hi + 1:] if i < len(r) and "шт" in r[0]]
        it = item("Шар воздушный с печатью", pairs, variant="печать " + variant)
        if it:
            out.append(it)
    return out
`;

/** Значки: диаметры в шапке, тиражи строками («по запросу» пропускаем) и вторая таблица. */
const BADGES_SCRIPT = `${HELPERS}

def run(tables, source):
    out = []
    t0 = tables[0]
    hi = next(i for i, r in enumerate(t0) if sum("мм" in clean(c) for c in r) >= 2)
    sizes = [(i, clean(c)) for i, c in enumerate(t0[hi]) if "мм" in clean(c)]
    rows = [r for r in t0[hi + 1:] if "шт" in clean(r[0])]
    for i, size in sizes:
        pairs = [(qty(r[0]), num(r[i])) for r in rows if i < len(r)]
        it = item("Значок закатный", pairs, variant="диаметр " + size)
        if it:
            out.append(it)
    if len(tables) > 1:
        t1 = tables[1]
        size = next((clean(r[0]).split(":")[1].strip() for r in t1 if clean(r[0]).startswith("Размер изделия")), "")
        start = next(i for i, r in enumerate(t1) if clean(r[0]) == "Тираж")
        pairs = [(qty(r[0]), num(r[1])) for r in t1[start + 1:] if len(r) > 1 and "шт" in r[0]]
        it = item("Значок закатный прямоугольный", pairs, variant=size)
        if it:
            out.append(it)
    return out
`;

const contactRow = (width: number): FormCell[] => [CONTACT_LINE, ...Array(width - 1).fill('')];

const BLANKETS: PriceForm = {
  code: 'blankets',
  fileName: 'Одеяла Тепло/Прайс одеяла.xlsx',
  tierBasis: 'order_sum',
  script: BLANKETS_SCRIPT,
  sheets: [
    {
      title: 'Одеяла',
      rows: [
        ['Прайс-лист на одеяла', '', '', '', ''],
        contactRow(5),
        ['Наименование / размер', '', 'Артикул', 'Цена от 62 000', 'Цена от 102 000'],
        ['ОДЕЯЛА ФЛИСОВЫЕ', '', '', '', ''],
        ['Одеяло флисовое Тепло', '', '', '', ''],
        ['150х200', '', 'OD-150', 1200, 1100],
        ['180х220', '', 'OD-180', 1500, 1400],
        ['Одеяло шерстяное Север', '', '', '', ''],
        ['150х200', '', 'OS-150', 2200, 2000],
        ['180х220', '', 'OS-180', 2700, 2500],
      ],
    },
  ],
  expected: [
    { name: 'Одеяло флисовое Тепло 150х200', price: 1200, tiers: [[62000, 1200], [102000, 1100]] },
    { name: 'Одеяло флисовое Тепло 180х220', price: 1500, tiers: [[62000, 1500], [102000, 1400]] },
    { name: 'Одеяло шерстяное Север 150х200', price: 2200, tiers: [[62000, 2200], [102000, 2000]] },
    { name: 'Одеяло шерстяное Север 180х220', price: 2700, tiers: [[62000, 2700], [102000, 2500]] },
  ],
};

const BOXES: PriceForm = {
  code: 'boxes',
  fileName: 'Коробки Эра/Прайс коробки.xlsx',
  tierBasis: 'quantity',
  script: BOXES_SCRIPT,
  sheets: [
    {
      title: 'Коробки',
      rows: [
        contactRow(4),
        ['КОНСТРУКЦИЯ ПОДАРОЧНАЯ', '50 шт', '100 шт', '300 шт'],
        ['200х150х50', 120, 100, 90],
        ['250х200х80', '', '', ''],
        ['300х250х90', 150, 130, 110],
        ['КОНСТРУКЦИЯ САМОСБОРНАЯ', '50 шт', '100 шт', '300 шт'],
        ['180х120х40', 80, 70, 60],
        ['220х160х60', 95, 85, 75],
      ],
      // Цены первых двух размеров общие: вертикальное объединение.
      merges: ['B3:B4', 'C3:C4', 'D3:D4'],
    },
  ],
  expected: [
    { name: 'Конструкция подарочная 200х150х50', price: 120, tiers: [[50, 120], [100, 100], [300, 90]] },
    { name: 'Конструкция подарочная 250х200х80', price: 120, tiers: [[50, 120], [100, 100], [300, 90]] },
    { name: 'Конструкция подарочная 300х250х90', price: 150, tiers: [[50, 150], [100, 130], [300, 110]] },
    { name: 'Конструкция самосборная 180х120х40', price: 80, tiers: [[50, 80], [100, 70], [300, 60]] },
    { name: 'Конструкция самосборная 220х160х60', price: 95, tiers: [[50, 95], [100, 85], [300, 75]] },
  ],
};

const BAG_SPEC_ONE = 'Пакет бумажный крафт с кручёными ручками, плотность 120 г/м2, печать 1+0';
const BAG_SPEC_TWO = 'Пакет бумажный белый с плоскими ручками, плотность 140 г/м2, печать 4+0';
const BAGS: PriceForm = {
  code: 'bags',
  fileName: 'Пакеты АЕ/Прайс пакеты бумажные.xlsx',
  tierBasis: 'quantity',
  script: BAGS_SCRIPT,
  sheets: [
    {
      title: 'Пакеты',
      rows: [
        contactRow(4),
        [BAG_SPEC_ONE, '', '', ''],
        ['Тираж', '22х10х27', '32х11х42', '40х15х50'],
        ['500 шт', 31, 38, 52],
        ['1000 шт', 27, 33, 45],
        ['3000 шт', 22, 28, 39],
        [BAG_SPEC_TWO, '', '', ''],
        ['Тираж', '22х10х27', '32х11х42', ''],
        ['500 шт', 36, 44, ''],
        ['1000 шт', 31, 38, ''],
        ['ЦЕНЫ ПО ГОТОВЫМ ФОРМАМ', '', '', ''],
        ['Ручка бумажная', 'стандарт', 3, ''],
      ],
    },
  ],
  expected: [
    { name: `Пакет бумажный 22х10х27 ${BAG_SPEC_ONE}`, price: 31, tiers: [[500, 31], [1000, 27], [3000, 22]] },
    { name: `Пакет бумажный 32х11х42 ${BAG_SPEC_ONE}`, price: 38, tiers: [[500, 38], [1000, 33], [3000, 28]] },
    { name: `Пакет бумажный 40х15х50 ${BAG_SPEC_ONE}`, price: 52, tiers: [[500, 52], [1000, 45], [3000, 39]] },
    { name: `Пакет бумажный 22х10х27 ${BAG_SPEC_TWO}`, price: 36, tiers: [[500, 36], [1000, 31]] },
    { name: `Пакет бумажный 32х11х42 ${BAG_SPEC_TWO}`, price: 44, tiers: [[500, 44], [1000, 38]] },
  ],
};

const COVERS: PriceForm = {
  code: 'covers',
  fileName: 'Чехлы/Прайс чехлы на чемодан.xlsx',
  tierBasis: 'quantity',
  script: COVERS_SCRIPT,
  sheets: [
    {
      title: 'Чехлы',
      rows: [
        contactRow(7),
        ['Артикул', 'Материал', 'Тираж (M)', 'Цена (M)', '', 'Тираж (M/L)', 'Цена (M/L)'],
        ['CH-1', 'Неопрен 3 мм, мягкий материал для ручной клади', 'от 50-100', 410, '', 'от 50-100', 450],
        ['', '', 'от 101-250', 380, '', 'от 101-250', 420],
        ['', '', 'от 251-500', 350, '', 'от 251-500', 390],
        ['CH-2', 'Лайкра 2 мм, растяжимая ткань для чемоданов', 'от 50-100', 360, '', 'от 50-100', 400],
        ['', '', 'от 101-250', 330, '', 'от 101-250', 370],
        ['', '', 'от 251-500', 300, '', 'от 251-500', 340],
      ],
    },
    {
      title: 'Упаковка',
      rows: [
        ['Упаковка чехлов', '', '', '', ''],
        ['Упаковка', '', 'Размер', 'от 50', 'от 200'],
        ['Пакет зип-лок', '', '40х60', 12, 10],
        ['Коробка картонная', '', '45х65', 25, 21],
      ],
    },
  ],
  expected: [
    { name: 'Чехол на чемодан Неопрен 3 размер M', price: 410, tiers: [[50, 410], [101, 380], [251, 350]] },
    { name: 'Чехол на чемодан Неопрен 3 размер M/L', price: 450, tiers: [[50, 450], [101, 420], [251, 390]] },
    { name: 'Чехол на чемодан Лайкра 2 размер M', price: 360, tiers: [[50, 360], [101, 330], [251, 300]] },
    { name: 'Чехол на чемодан Лайкра 2 размер M/L', price: 400, tiers: [[50, 400], [101, 370], [251, 340]] },
    { name: 'Пакет зип-лок 40х60', price: 12, tiers: [[50, 12], [200, 10]] },
    { name: 'Коробка картонная 45х65', price: 25, tiers: [[50, 25], [200, 21]] },
  ],
};

const BALLOONS: PriceForm = {
  code: 'balloons',
  // Название товара живёт только в имени файла: модель переносит его в скрипт.
  fileName: 'Шары/Прайс шары с печатью.xlsx',
  tierBasis: 'quantity',
  script: BALLOONS_SCRIPT,
  sheets: [
    {
      title: 'Шары',
      rows: [
        contactRow(5),
        ['Тираж', '1 цвет', '2 цвета', '3 цвета', '4 цвета'],
        ['100 шт', 30, 34, 38, 44],
        ['250 шт', 26, 29, 33, 39],
        ['500 шт', 22, 25, 28, 34],
        ['1000 шт', 19, 21, 24, 29],
        ['2500 шт', 16, 18, 21, 26],
        ['5000 шт', 14, 16, 19, 23],
      ],
    },
  ],
  expected: ['1 цвет', '2 цвета', '3 цвета', '4 цвета'].map((variant, i) => {
    const rows = [
      [30, 26, 22, 19, 16, 14],
      [34, 29, 25, 21, 18, 16],
      [38, 33, 28, 24, 21, 19],
      [44, 39, 34, 29, 26, 23],
    ][i] as number[];
    const quantities = [100, 250, 500, 1000, 2500, 5000];
    return {
      name: `Шар воздушный с печатью печать ${variant}`,
      price: rows[0] as number,
      tiers: quantities.map((q, k) => [q, rows[k] as number] as const),
    };
  }),
};

const BADGES: PriceForm = {
  code: 'badges',
  fileName: 'Значки ЕКБ/Прайс значки закатные.xlsx',
  tierBasis: 'quantity',
  script: BADGES_SCRIPT,
  sheets: [
    {
      title: 'Круглые',
      rows: [
        contactRow(4),
        ['Тираж', '25 мм', '37 мм', '56 мм'],
        ['100 шт', 14, 17, 25],
        ['300 шт', 12, 15, 22],
        ['500 шт', 10, 13, 19],
        ['1000 шт', 9, 11, 16],
        ['5000 шт', 'по запросу', 'по запросу', 'по запросу'],
      ],
    },
    {
      title: 'Прямоугольный',
      rows: [
        ['Размер изделия: 30х45 мм', ''],
        ['Тираж', 'Цена за шт'],
        ['100 шт', 30],
        ['500 шт', 24],
        ['1000 шт', 19],
      ],
    },
  ],
  expected: [
    { name: 'Значок закатный диаметр 25 мм', price: 14, tiers: [[100, 14], [300, 12], [500, 10], [1000, 9]] },
    { name: 'Значок закатный диаметр 37 мм', price: 17, tiers: [[100, 17], [300, 15], [500, 13], [1000, 11]] },
    { name: 'Значок закатный диаметр 56 мм', price: 25, tiers: [[100, 25], [300, 22], [500, 19], [1000, 16]] },
    { name: 'Значок закатный прямоугольный 30х45 мм', price: 30, tiers: [[100, 30], [500, 24], [1000, 19]] },
  ],
};

/** Все формы спайка в порядке сценариев. */
export const PRICE_FORMS: readonly PriceForm[] = [BLANKETS, BOXES, BAGS, COVERS, BALLOONS, BADGES];

/** Книга xlsx со всеми листами формы (openpyxl из окружения documents). */
export function buildFormFile(targetPath: string, sheets: readonly FormSheet[]): void {
  const python = `${requireEnv('E2E_ROOT')}/services/documents/.venv/bin/python`;
  const script = `${requireEnv('E2E_PROJECT_ROOT')}/e2e/fixtures/make_form_price.py`;
  const spec = JSON.stringify({ sheets });
  const result = spawnSync(python, ['-I', script, targetPath, spec], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`сборка прайса не удалась: ${result.stderr}`);
}
