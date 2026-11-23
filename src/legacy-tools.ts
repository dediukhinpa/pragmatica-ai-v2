import {
  DATA_SCRIPT_PROMPT,
  FILE_TOOL_PROMPT,
  RECORD_FEEDBACK_TOOL,
  RUN_DATA_SCRIPT_TOOL,
  SCRIPT_REQUIRED_MESSAGE,
  withFeedbackTool,
  type AgentDeclaration,
  type AgentValidator,
  type AnyToolDefinition,
  type ValidationIssue,
} from '@business-ai/core';
import { z } from 'zod';
import { scriptAttemptValidator } from './agents/prices/script-attempt-check';
import {
  LEGACY_DATA_SCRIPT_PROMPT,
  LEGACY_EMPLOYEE_LANGUAGE_PROMPT,
  LEGACY_FILE_TOOL_PROMPT,
  LEGACY_REPLY_FORMAT_PROMPT,
  LEGACY_SCRIPT_REQUIRED_MESSAGE,
} from './legacy-tool-texts';

/**
 * Возврат `createFile` и общих блоков промпта к виду прежней сборки Прагматики. Описания,
 * перечень видов и подсказки `runDataScript`, описания поиска по истории и поиска в интернете
 * задаются штатно (параметр `presentation` фабрик платформы,
 * `agents/shared/common-tools.owned.ts`), внутренние тексты платформы - полем `prompts`
 * манифеста. Здесь остаётся то, чего платформа не настраивает: порядок полей ввода
 * `runDataScript`, ключ отправки `createFile` (вход плюс тред вместо предшественника хода),
 * конец хода после файла, подмена платформенных блоков промпта и подсказка валидатора скрипта.
 */

/** Имя инструмента, чья ключевая отправка файла зависит от прежнего ключа. */
const CREATE_FILE_TOOL = 'createFile';

/** Заголовки блоков оформления, по которым они находятся в тексте платформы. */
const EMPLOYEE_LANGUAGE_HEADING = '\n\nКак писать сотруднику:';
const REPLY_FORMAT_HEADING = '\n\nОформление ответа:';

/** Параметры возврата прежнего вида. */
export interface LegacyToolsOptions {
  /**
   * Включён ли блок «предупреждения вместо отказов» (`FEEDBACK_LIMIT_WARNINGS`). Нужен, потому
   * что инструмент оценки и его блоки промпта проект добавляет сам (см. `restoreLegacyTools`).
   */
  limitWarnings?: boolean;
}

/** Самый длинный код скрипта, символов (как в схеме платформы и прежней сборки). */
const SCRIPT_CODE_MAX_CHARS = 30_000;
/** Самая длинная ссылка на данные, символов. */
const FILE_REF_MAX_CHARS = 600;
/** Самый длинный идентификатор поставщика, символов. */
const SUPPLIER_ID_MAX_CHARS = 100;
/** Виды результата скрипта в прежнем порядке (совпадает с `presentation.resultKindNames`). */
const LEGACY_RESULT_KINDS = ['price_items', 'table', 'value'] as const;

/**
 * Схема ввода `runDataScript` прежней сборки. Платформа ставит `resultKind` последним полем, а
 * прежняя схема держала его третьим; порядок полей входит в отпечаток запроса записей eval и
 * в то, что видит модель, поэтому порядок возвращается (содержимое полей то же, что даёт
 * `presentation` у фабрики).
 */
const legacyRunDataScriptInput = z.object({
  code: z.string().min(1).max(SCRIPT_CODE_MAX_CHARS),
  fileRef: z.string().trim().min(1).max(FILE_REF_MAX_CHARS).optional(),
  resultKind: z.enum(LEGACY_RESULT_KINDS),
  /** `price_items`: поставщик, чей прайс разбирается (позиции идут в staging его импорта). */
  supplierId: z.string().trim().min(1).max(SUPPLIER_ID_MAX_CHARS).optional(),
  /** `price_items`: скрипт переписан по просьбе сотрудника, нужна разница «было/стало». */
  onEmployeeRequest: z.boolean().optional(),
});

/** `runDataScript`: описание, виды и подсказки заданы `presentation`, здесь лишь порядок полей. */
function legacyRunDataScript(tool: AnyToolDefinition): AnyToolDefinition {
  return { ...tool, inputSchema: legacyRunDataScriptInput };
}

/**
 * `createFile` прежней сборки: ход после файла не заканчивается сам (модель коротко сообщает,
 * что отправила), у инструмента нет предшественника ключа. Ключ отправки в чат - как раньше:
 * вход плюс тред. Платформа берёт для него идентификатор операции, который теперь без
 * предшественника не знает треда, поэтому подставляется прежний ключ.
 */
function legacyCreateFile(tool: AnyToolDefinition): AnyToolDefinition {
  const {
    endsTurn: _endsTurn,
    endsTurnWhen: _endsTurnWhen,
    idempotencyPredecessor: _idempotencyPredecessor,
    ...rest
  } = tool;
  return {
    ...rest,
    async execute(input, deps, context) {
      const key = tool.idempotencyKey?.(input);
      if (key === undefined) throw new Error(`${CREATE_FILE_TOOL}: у инструмента нет ключа`);
      return tool.execute(input, deps, { ...context, operationId: `${key}:${context.threadId}` });
    },
  };
}

const TOOL_RESTORERS: Readonly<Record<string, (tool: AnyToolDefinition) => AnyToolDefinition>> = {
  [CREATE_FILE_TOOL]: legacyCreateFile,
  [RUN_DATA_SCRIPT_TOOL]: legacyRunDataScript,
};

/**
 * Заменить в тексте платформенный блок прежним ровно один раз. Нет блока платформы, но уже
 * стоит прежний (повторный вызов) - текст остаётся. Иначе - ошибка сборки: молчаливая потеря
 * подмены вернула бы модели нейтральные формулировки.
 */
function replaceBlock(text: string, platform: string, legacy: string, label: string): string {
  const parts = text.split(platform);
  if (parts.length === 2) return parts.join(legacy);
  if (parts.length === 1 && text.split(legacy).length === 2) return text;
  throw new Error(`Промпт агента: блок ${label} платформы найден ${parts.length - 1} раз`);
}

/**
 * Блоки оформления ответа и языка для сотрудника в той редакции, которую платформа добавляет
 * сама. Константы платформа не экспортирует, поэтому блоки берутся из её же результата для
 * пустого промпта: порядок там фиксирован (оценка, язык, оформление).
 */
function platformFeedbackBlocks(): { employeeLanguage: string; replyFormat: string } {
  const probe: AgentDeclaration = {
    id: 'probe',
    prompt: '',
    tools: [],
    validators: [],
    model: 'probe',
  };
  const tail = withFeedbackTool(probe, { limitWarnings: false }).prompt;
  const employeeAt = tail.indexOf(EMPLOYEE_LANGUAGE_HEADING);
  const replyAt = tail.indexOf(REPLY_FORMAT_HEADING);
  if (employeeAt < 0 || replyAt < employeeAt) {
    throw new Error('Блоки инструмента оценки платформы изменились: обновите legacy-tools');
  }
  return { employeeLanguage: tail.slice(employeeAt, replyAt), replyFormat: tail.slice(replyAt) };
}

/**
 * Декларация вместе с инструментом оценки. Его и блоки промпта платформа добавляет сама при
 * регистрации, уже после деклараций проекта, но повторно не добавляет (`withFeedbackTool`
 * видит `recordFeedback`). Поэтому проект применяет его здесь, чтобы подменить блоки в
 * результате; для декларации, где оценка уже есть, ничего не меняется.
 */
function withFeedback(
  declaration: AgentDeclaration,
  options: LegacyToolsOptions,
): AgentDeclaration {
  const hasFeedback = declaration.tools.some((tool) => tool.name === RECORD_FEEDBACK_TOOL);
  if (hasFeedback) return declaration;
  return withFeedbackTool(declaration, { limitWarnings: options.limitWarnings === true });
}

/** Промпт агента (вместе с блоками оценки) с прежними общими блоками. */
function restorePrompt(declaration: AgentDeclaration): string {
  const withDataScript = declaration.tools.some((tool) => tool.name === RUN_DATA_SCRIPT_TOOL);
  const feedback = platformFeedbackBlocks();
  let prompt = declaration.prompt;
  const replace = (platform: string, legacy: string, label: string): void => {
    prompt = replaceBlock(prompt, platform, legacy, label);
  };
  replace(FILE_TOOL_PROMPT, LEGACY_FILE_TOOL_PROMPT, 'FILE_TOOL_PROMPT');
  if (withDataScript) replace(DATA_SCRIPT_PROMPT, LEGACY_DATA_SCRIPT_PROMPT, 'DATA_SCRIPT_PROMPT');
  replace(feedback.employeeLanguage, LEGACY_EMPLOYEE_LANGUAGE_PROMPT, 'EMPLOYEE_LANGUAGE_PROMPT');
  replace(feedback.replyFormat, LEGACY_REPLY_FORMAT_PROMPT, 'REPLY_FORMAT_PROMPT');
  return prompt;
}

/** Замечания валидатора с прежним текстом служебной подсказки о скрипте. */
function legacyIssues(issues: ValidationIssue[]): ValidationIssue[] {
  return issues.map((issue) =>
    issue.message === SCRIPT_REQUIRED_MESSAGE
      ? { ...issue, message: LEGACY_SCRIPT_REQUIRED_MESSAGE }
      : issue,
  );
}

/** Проверка обязательной попытки скрипта: замечание с прежним текстом подсказки. */
function legacyValidator(validator: AgentValidator): AgentValidator {
  if (validator.name !== scriptAttemptValidator.name) return validator;
  return {
    ...validator,
    validate(input, deps, context) {
      const issues = validator.validate(input, deps, context);
      return Array.isArray(issues) ? legacyIssues(issues) : issues.then(legacyIssues);
    },
  };
}

/**
 * Декларации агентов с инструментами и общими блоками промпта прежней сборки. Возвращает новые
 * объекты (поля `tools`, `prompt`, `validators`), входные не меняет. Подключается в конце
 * `declarationsOf`; повторный вызов безопасен.
 *
 * @param declarations декларации агентов проекта
 * @param options флаги окружения, от которых зависит промпт
 * @returns декларации с прежними описаниями, схемами и текстами
 */
export function restoreLegacyTools(
  declarations: readonly AgentDeclaration[],
  options: LegacyToolsOptions = {},
): AgentDeclaration[] {
  return declarations.map((source) => {
    const declaration = withFeedback(source, options);
    return {
      ...declaration,
      prompt: restorePrompt(declaration),
      tools: declaration.tools.map((tool) => TOOL_RESTORERS[tool.name]?.(tool) ?? tool),
      validators: declaration.validators.map(legacyValidator),
    };
  });
}
