import { z } from 'zod';
import { defineHandoffTool, getHandoffResult } from '@business-ai/core';
import type { OrderCalcDeps } from './deps';
import { ORDER_CALC_AGENT_ID } from './deps';
import { PRICES_AGENT_ID } from '../prices/deps';

/** Имя инструмента передачи «Поиск поставщика (ИИ агент)» -> «Актуализация прайса (ИИ агент)». */
export const HANDOFF_TO_PRICES_TOOL = 'handoffToPrices';
/**
 * Пределы собирает КОД (этап 177): схема инструмента их не проверяет, лишнее обрезается и
 * называется в тексте передачи, а не отклоняет просьбу сотрудника. Это защита размера ввода,
 * а не рабочий лимит.
 */
const HANDOFF_PRICES_MAX_POSITIONS = 200;
const HANDOFF_PRICES_MAX_POSITION_CHARS = 200;
const HANDOFF_PRICES_MAX_REQUEST_ID_CHARS = 100;

const inputSchema = z.object({
  requestId: z.string().trim().min(1),
  positions: z.array(z.string()).min(1),
});
type HandoffToPricesInput = z.infer<typeof inputSchema>;

/** Одна строка без переводов строки: название позиции не должно менять структуру ввода. */
function singleLine(text: string, limit: number): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, limit).trim();
}

/** Ввод агенту «Актуализация прайса (ИИ агент)»: текст собирает код из проверенной структуры. */
export function pricesHandoffInput(input: HandoffToPricesInput): string {
  const all = input.positions
    .map((position) => singleLine(position, HANDOFF_PRICES_MAX_POSITION_CHARS))
    .filter((position) => position !== '');
  const taken = all.slice(0, HANDOFF_PRICES_MAX_POSITIONS);
  const lines = taken.map((position) => `- ${position}`).join('\n');
  const requestId = singleLine(input.requestId, HANDOFF_PRICES_MAX_REQUEST_ID_CHARS);
  // Что не вошло - в предупреждение для получателя: он назовёт это в своём итоге.
  const cut =
    all.length > taken.length
      ? `Предупреждение: передано ${taken.length} позиций из ${all.length}, остальные не вошли.\n`
      : '';
  return (
    `Задача от помощника «Поиск поставщика (ИИ агент)» по заявке ${requestId}: ` +
    'освежить цены по позициям. Проверь актуальность цен по базе и, если цены устарели или их ' +
    'нет, запроси ' +
    'обновление прайсов у поставщиков (только поставщикам: сотрудникам и текущему чату ' +
    'запросы не пиши). Не фиксируй импорты и не подтверждай скачки цен. ' +
    'В ответе кратко по каждой позиции: актуальная цена и дата либо что запрошено.\n' +
    `${cut}Позиции:\n${lines}`
  );
}

const kit = defineHandoffTool<HandoffToPricesInput, OrderCalcDeps>({
  name: HANDOFF_TO_PRICES_TOOL,
  description:
    'Передать помощнику «Актуализация прайса (ИИ агент)» задачу освежить цены по позициям заявки ' +
    '(requestId и список ' +
    'названий позиций). Передача асинхронная: вы не ждёте итога в этом ходе, он придёт ' +
    'сотруднику сообщением, а вы прочитаете его getHandoffResult на следующем ходе. Повторите ' +
    'передачу только если прежняя завершена.',
  from: ORDER_CALC_AGENT_ID,
  target: PRICES_AGENT_ID,
  inputSchema,
  buildInput: pricesHandoffInput,
});

/** Инструмент передачи и его валидатор: подключаются в декларацию только за флагом. */
export const handoffToPrices = kit.tool;
export const handoffToPricesValidator = kit.validator;
/** Чтение итогов передач: подключается вместе с `handoffToPrices`. */
export const handoffResultTool = getHandoffResult;

/** Добавка к промпту: только при включённой передаче (без флага промпт не меняется). */
export const HANDOFF_TO_PRICES_PROMPT = `

Передача помощнику «Актуализация прайса (ИИ агент)»: если для расчёта нужно освежить цены по
позициям заявки, вызови handoffToPrices (requestId и названия позиций). Это асинхронно: итог
придёт менеджеру сообщением, а ты прочитаешь его getHandoffResult на следующем ходе. Не жди итога в
этом ходе и
не повторяй передачу, пока прежняя не завершена (queued или running).`;
