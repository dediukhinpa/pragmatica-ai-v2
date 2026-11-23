import { beforeEach, describe, expect, test } from 'bun:test';
import { COMPLETENESS_PROMPT } from '../../src/agents/order-calc/check-request-completeness';
import { INTAKE_PROMPT } from '../../src/agents/order-calc/intake';
import { ORDER_CALC_MAIL_PROMPT, ORDER_CALC_PROMPT } from '../../src/agents/order-calc/prompt';
import {
  askManagerToChoose,
  buildChoiceMessage,
} from '../../src/agents/order-calc/ask-manager-to-choose';
import { buildShortlist } from '../../src/agents/order-calc/build-shortlist';
import { saveCompleteness } from '../../src/agents/order-calc/state';
import { searchKnowledgeSuppliers, searchWeb } from '../../src/agents/order-calc/search-sources';
import { missingReminderLine } from '../../src/agents/order-calc/shortlist-message';
import { loadProposal } from '../../src/agents/order-calc/state';
import { getRequestForm } from '../../src/kit/domain/request-forms';
import { type ShortlistProposal } from '../../src/kit/domain/shortlist';
import { CTX } from './support';
import { REQUEST_ID, buildOrderDeps, type OrderTestDeps } from './order-support';

const LEAD = 'Для точного письма поставщику можно добавить:';
const TAIL = 'Можно не добавлять: письмо будет по имеющимся данным; отправляете его вы.';
const CHOICE = 'Кому готовить запросы?';

/** Фразы, из-за которых итог после шорт-листа вводил в заблуждение (этап 162). */
const TRAPS = ['пойдут по тем данным', 'обычно берут', 'запросы пойдут', 'Если не хотите ничего'];

describe('промпты: нет обещаний «запросы пойдут» и выдуманных норм', () => {
  const prompts = {
    base: ORDER_CALC_PROMPT,
    mail: ORDER_CALC_MAIL_PROMPT,
    intake: INTAKE_PROMPT,
    completeness: COMPLETENESS_PROMPT,
  };

  for (const [name, prompt] of Object.entries(prompts)) {
    test(`${name}: ловушки отсутствуют`, () => {
      for (const trap of TRAPS) {
        expect(prompt).not.toContain(trap);
      }
      expect(prompt).not.toContain('картон 300');
      expect(prompt).not.toContain('что уточнить для точного расчёта');
    });
  }

  test('правило: строку собирает код, итог и повтор вопроса запрещены', () => {
    for (const prompt of [ORDER_CALC_PROMPT, ORDER_CALC_MAIL_PROMPT]) {
      expect(prompt).toContain('строку «Для точного письма поставщику можно добавить');
      expect(prompt).toContain('ход завершается сам');
      expect(prompt).toContain('письмо отправляет сам сотрудник');
      expect(prompt).toContain('Не называй');
    }
    // Фразу о непрочитанных фото пишет код (этап 189): в промпте её просьбы к модели нет.
    expect(COMPLETENESS_PROMPT).not.toContain('попроси описать');
    expect(COMPLETENESS_PROMPT).toContain('фразу о них добавляет код');
    expect(COMPLETENESS_PROMPT).toContain('paperHint');
    expect(COMPLETENESS_PROMPT).toContain('не пересказывай');
  });
});

describe('missingReminderLine', () => {
  const labels = (...items: string[]): { label: string }[] => items.map((label) => ({ label }));

  test('нет недостающего - строки нет', () => {
    expect(missingReminderLine([])).toBeUndefined();
  });

  test('один пункт', () => {
    expect(missingReminderLine(labels('Тираж'))).toBe(`${LEAD} тираж. ${TAIL}`);
  });

  test('три пункта: подписи без пояснений, аббревиатуры не трогаем', () => {
    const line = missingReminderLine(labels('Печать: цветность / пантон', 'НДС', 'Срок'));
    expect(line).toBe(`${LEAD} печать, НДС, срок. ${TAIL}`);
  });

  test('больше трёх обрезается до трёх, повторы убираются', () => {
    const line = missingReminderLine(labels('Тираж', 'Тираж', 'Размер', 'Срок', 'Упаковка'));
    expect(line).toBe(`${LEAD} тираж, размер, срок. ${TAIL}`);
  });
});

describe('сообщение выбора с недостающим', () => {
  let deps: OrderTestDeps;
  /** Тексты, которые инструмент записал как показанные сотруднику (идут в историю хода). */
  let shown: string[];
  beforeEach(async () => {
    deps = await buildOrderDeps();
    shown = [];
  });

  async function ask(): Promise<string> {
    const input = { requestId: REQUEST_ID };
    await searchKnowledgeSuppliers.execute(input, deps, CTX);
    await searchWeb.execute(input, deps, CTX);
    const { version } = await buildShortlist.execute(input, deps, CTX);
    await askManagerToChoose.execute({ requestId: REQUEST_ID, version }, deps, {
      ...CTX,
      noteShown: (text) => shown.push(text),
    });
    // Вторая запись - отдельное закрывающее сообщение (напоминание и вопрос), этап 171.
    return deps.chat.outbox[1]?.message?.text ?? '';
  }

  /** Сохранённая полнота: все поля формы заполнены, кроме перечисленных ключей. */
  async function storeExcept(missingKeys: string[]): Promise<void> {
    const form = getRequestForm('print_leaflet');
    const values = Object.fromEntries(
      form.fields.filter((f) => !missingKeys.includes(f.key)).map((f) => [f.key, 'есть']),
    );
    await saveCompleteness(deps, {
      requestId: REQUEST_ID,
      kind: 'print_leaflet',
      values,
      declined: false,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  }

  test('итог: карточки, затем ОДНО отдельное сообщение, вопрос выбора последний', async () => {
    await storeExcept(['quantity']);
    await ask();
    const texts = deps.chat.outbox.flatMap((r) => (r.message === undefined ? [] : [r.message]));
    expect(texts).toHaveLength(2);
    const [cards, closing] = texts;
    expect(cards?.text).not.toContain(CHOICE);
    expect(JSON.stringify(cards?.blocks ?? [])).not.toContain(CHOICE);
    expect(JSON.stringify(cards?.blocks ?? [])).not.toContain(LEAD);
    expect(closing?.blocks).toBeUndefined();
    const paragraphs = (closing?.text ?? '').split('\n\n');
    expect(paragraphs.at(-1)).toContain(`[B]${CHOICE}[/B]`);
    expect(paragraphs.at(-2)).toBe(`${LEAD} тираж. ${TAIL}`);
  });

  test('заявка полная: отдельное сообщение - только вопрос', async () => {
    await storeExcept([]);
    expect(await ask()).toMatch(/^\[B\]Кому готовить запросы\?\[\/B\]/u);
  });

  test('текстовый откат: напоминание и вопрос последним абзацем через пустую строку', async () => {
    await storeExcept(['quantity']);
    deps.shortlistAttachEnabled = false;
    await ask();
    const texts = deps.chat.outbox.flatMap((r) => (r.message === undefined ? [] : [r.message]));
    expect(texts).toHaveLength(2);
    expect(texts[0]?.blocks).toBeUndefined();
    const full = `${texts[0]?.text}\n\n${texts[1]?.text}`;
    const tail = full.split('\n\n').slice(-2);
    expect(tail[0]).toBe(`${LEAD} тираж. ${TAIL}`);
    expect(tail[1]).toContain(`[B]${CHOICE}[/B]`);
    // Полный текст (откат одним куском) тоже кончается отдельным абзацем.
    const proposalText = buildChoiceMessage(
      (await loadProposal(deps, REQUEST_ID)) as ShortlistProposal,
      false,
      undefined,
      [{ label: 'Тираж' }],
    ).text;
    expect(proposalText.split('\n\n').at(-2)).toBe(`${LEAD} тираж. ${TAIL}`);
  });

  test('этап 173: ровно два текстовых сообщения и файл, вопрос в конце второго', async () => {
    await storeExcept(['quantity']);
    await ask();
    const records = deps.chat.outbox;
    const texts = records.flatMap((r) => (r.message === undefined ? [] : [r.message.text]));
    // Шорт-лист и «всё остальное»; никакой отдельной фразы «шорт-лист готов».
    expect(texts).toHaveLength(2);
    expect(texts.join('\n')).not.toContain('готов, Москва');
    expect(texts[1]?.split('\n\n').at(-1)).toContain(`[B]${CHOICE}[/B]`);
    expect(texts[0]).not.toContain(CHOICE);
    // Файл - вложение, не текст; в историю хода идёт ровно то, что увидел сотрудник.
    expect(records.filter((r) => r.file !== undefined)).toHaveLength(1);
    expect(shown).toEqual(texts);
    expect(askManagerToChoose.endsTurn).toBe(true);
  });

  test('этап 173: повтор шага не задваивает ни текст, ни файл', async () => {
    await storeExcept(['quantity']);
    const input = { requestId: REQUEST_ID };
    await searchKnowledgeSuppliers.execute(input, deps, CTX);
    await searchWeb.execute(input, deps, CTX);
    const { version } = await buildShortlist.execute(input, deps, CTX);
    await askManagerToChoose.execute({ requestId: REQUEST_ID, version }, deps, CTX);
    await askManagerToChoose.execute({ requestId: REQUEST_ID, version }, deps, CTX);
    expect(deps.chat.outbox.filter((r) => r.message !== undefined)).toHaveLength(2);
    expect(deps.chat.outbox.filter((r) => r.file !== undefined)).toHaveLength(1);
  });

  test('повтор шага не даёт второго вопроса', async () => {
    const input = { requestId: REQUEST_ID };
    await searchKnowledgeSuppliers.execute(input, deps, CTX);
    await searchWeb.execute(input, deps, CTX);
    const { version } = await buildShortlist.execute(input, deps, CTX);
    await askManagerToChoose.execute({ requestId: REQUEST_ID, version }, deps, CTX);
    await askManagerToChoose.execute({ requestId: REQUEST_ID, version }, deps, CTX);
    const asks = deps.chat.outbox.filter((r) => r.message?.text.includes(CHOICE) === true);
    expect(asks).toHaveLength(1);
  });

  test('нет сохранённой полноты: строки нет, призыв выбрать на месте', async () => {
    const text = await ask();
    expect(text).not.toContain(LEAD);
    expect(text).toContain(CHOICE);
  });

  test('полнота без недостающего: строки нет', async () => {
    await storeExcept([]);
    expect(await ask()).not.toContain(LEAD);
  });

  test('одно недостающее: точная строка прямо над вопросом выбора', async () => {
    await storeExcept(['quantity']);
    const lines = (await ask()).split('\n');
    const at = lines.findIndex((line) => line.includes(CHOICE));
    // Между напоминанием и вопросом пустая строка.
    expect(lines[at - 1]).toBe('');
    expect(lines[at - 2]).toBe(`${LEAD} тираж. ${TAIL}`);
    expect(lines.filter((line) => line.includes(CHOICE))).toHaveLength(1);
  });

  test('недостающих больше трёх: в строке ровно три', async () => {
    await storeExcept(['name', 'quantity', 'size', 'print', 'options']);
    const line = (await ask()).split('\n').find((item) => item.startsWith(LEAD));
    expect(line).toBe(`${LEAD} наименование, тираж, размер. ${TAIL}`);
  });
});

describe('регрессия сообщения шорт-листа', () => {
  const proposal: ShortlistProposal = {
    requestId: REQUEST_ID,
    version: 'v1',
    createdAt: '2026-10-28T00:00:00.000Z',
    managerThreadId: 'mgr',
    entries: [],
    truncated: 0,
    sources: [],
  };

  test('пустая выдача: строки о недостающем нет даже при missing', () => {
    const text = buildChoiceMessage(proposal, true, undefined, [{ label: 'Тираж' }]).text;
    expect(text).not.toContain(LEAD);
  });
});
