import type { AgentDeclaration, AnyToolDefinition } from '@business-ai/core';
import { PRICES_AGENT_ID } from '../agents/prices/deps';
import { PRICE_EDIT_DIRECT_TOOL, PRICE_ROUNDING_NOTE } from '../price-edit-direct';
import { resendLastPriceFile } from '../price-last-file';
import { createPriceFileCopy } from './price-file-copy';

/**
 * Подключение xlsx-копии прайса к агенту «Актуализация прайса» (этап 9t). Файлы агентов
 * (`src/agents/**`) генерируются из платформенной сборки, поэтому инструмент и совет скрипту
 * добавляются здесь, при сборке манифеста, а не правкой декларации.
 */

/** Название инструмента скрипта над таблицей. */
const RUN_DATA_SCRIPT_NAME = 'runDataScript';
/** Код отказа платформы: результат скрипта больше предела ответа модели. */
const RESULT_TOO_LARGE_CODE = 'result_too_large';
/** Название инструмента, которым собирается копия большого прайса. */
export const COPY_TOOL_NAME = createPriceFileCopy.name;
/** Название инструмента повторной отправки последнего файла правки (этап 9u). */
export const RESEND_TOOL_NAME = resendLastPriceFile.name;

/**
 * Совет модели, когда вывод скрипта не поместился в ответ. Платформа говорит лишь «верни
 * меньше», и модель снова гоняла скрипты, пытаясь вытащить всю таблицу, а потом переписать её в
 * `createFile`: большой прайс (сотни строк) через ответ модели не проходит, ход заканчивался
 * без текста. Скрипт хорош для разбора и сводок, а файл собирает код.
 */
export const OVERSIZE_ADVICE =
  'Таблицу целиком модель не получит: ответ не поместил её. Не пытайся передать все строки ' +
  'через скрипт и не переписывай их в createFile. Если сотруднику нужна xlsx-копия прайса ' +
  `(в том числе с новыми ценами), вызови ${COPY_TOOL_NAME}: он соберёт файл сам. Для разбора ` +
  'верни агрегаты, первые строки или нужные поля. Не получается - скажи сотруднику прямо, ' +
  'что файл слишком большой для разбора скриптом.';

/** Ответ скрипта в той части, которую смотрит совет (остальные поля не трогаются). */
interface ScriptAnswerShape {
  ok: boolean;
  truncated?: boolean | undefined;
  scriptDidNotHelp?: boolean | undefined;
  error?: { code: string } | undefined;
  message?: string | undefined;
}

/** Похоже ли значение на ответ `runDataScript`. */
function isScriptAnswer(value: unknown): value is ScriptAnswerShape {
  if (typeof value !== 'object' || value === null) return false;
  return typeof (value as { ok?: unknown }).ok === 'boolean';
}

/**
 * Дописать совет к ответу, в котором вывод скрипта обрезан или отклонён по размеру. Повторный
 * вызов совет не удваивает; серия исчерпанных попыток сохраняет сообщение платформы.
 */
export function withOversizeAdvice<T>(answer: T): T {
  if (!isScriptAnswer(answer) || answer.scriptDidNotHelp === true) return answer;
  const tooLarge = !answer.ok && answer.error?.code === RESULT_TOO_LARGE_CODE;
  const cut = answer.ok && answer.truncated === true;
  if (!tooLarge && !cut) return answer;
  if (answer.message?.includes(COPY_TOOL_NAME) === true) return answer;
  const message = answer.message === undefined ? '' : `${answer.message} `;
  return { ...answer, message: `${message}${OVERSIZE_ADVICE}` };
}

/** Инструмент скрипта с советом при слишком большом выводе. */
function adviseScriptTool(tool: AnyToolDefinition): AnyToolDefinition {
  return {
    ...tool,
    async execute(input, deps, context) {
      return withOversizeAdvice(await tool.execute(input, deps, context));
    },
  };
}

/** Описание правки цены с правилом округления; повторное применение фразу не удваивает. */
function withRoundingNote(tool: AnyToolDefinition): AnyToolDefinition {
  if (tool.description.endsWith(PRICE_ROUNDING_NOTE)) return tool;
  return { ...tool, description: `${tool.description}${PRICE_ROUNDING_NOTE}` };
}

/** Параметры подключения. */
export interface PriceCopyToolsOptions {
  /** Добавлять ли `createPriceFileCopy`: вместе с `PRICE_EDIT_FIRST_ENABLED`. */
  copy: boolean;
  /**
   * Добавлять ли `resendLastPriceFile` (этап 9u, `PRICE_FILE_ONCE_PER_TURN_ENABLED`) и дописывать
   * к описанию правки цены правило округления. Нет поля или false - набор прежний.
   */
  resend?: boolean;
}

/**
 * Декларация агента прайсов с инструментом xlsx-копии и советом скрипту; остальные агенты
 * возвращаются как есть. Повторное применение декларацию не меняет.
 */
export function withPriceCopyTools(
  declaration: AgentDeclaration,
  options: PriceCopyToolsOptions,
): AgentDeclaration {
  if (declaration.id !== PRICES_AGENT_ID) return declaration;
  const tools = declaration.tools.map((tool) => {
    if (tool.name === RUN_DATA_SCRIPT_NAME) return adviseScriptTool(tool);
    return options.resend === true && tool.name === PRICE_EDIT_DIRECT_TOOL
      ? withRoundingNote(tool)
      : tool;
  });
  const present = tools.some((tool) => tool.name === COPY_TOOL_NAME);
  if (options.copy && !present) tools.push(createPriceFileCopy as unknown as AnyToolDefinition);
  const resendPresent = tools.some((tool) => tool.name === RESEND_TOOL_NAME);
  if (options.resend === true && !resendPresent) {
    tools.push(resendLastPriceFile as unknown as AnyToolDefinition);
  }
  return { ...declaration, tools };
}
