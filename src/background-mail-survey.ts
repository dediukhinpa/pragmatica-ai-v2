import {
  MAIL_TRUST_SURVEY_WINDOW_DAYS,
  formatMailTrustSurvey,
  runMailTrustSurvey,
  type MailTrustSurveyDeps,
  type MailTrustSurveyOptions,
  type SurveyScope,
} from './agents/suppliers/mail-trust-survey';

/**
 * Разовая команда-обследование доверия к отправителям (этап 233): разбор аргументов и вывод.
 * Сборка зависимостей - в `src/background-wiring.ts`, запуск - `src/background-cli.ts`.
 * Только чтение; в stdout только агрегаты (числа и проценты), без адресов, тем и имён.
 */

/** Коды выхода: 0 - обследование выполнено, 1 - ошибка. */
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
/** Предел писем на ящик по умолчанию: с запасом на два года активной переписки. */
export const SURVEY_DEFAULT_MAX_MESSAGES = 200_000;
/** Предел времени на ящик по умолчанию, минут. */
const SURVEY_DEFAULT_MAX_MINUTES = 30;
const SCOPES: readonly SurveyScope[] = ['all', 'sources', 'employees'];

export interface SurveyArgs extends MailTrustSurveyOptions {
  /** Вывести JSON вместо читаемого текста. */
  json: boolean;
}

const USAGE =
  'использование: mail-trust-survey [--days N] [--max-messages N] [--max-minutes N] ' +
  '[--scope all|sources|employees] [--json]';

function positive(value: string, name: string): number | { error: string } {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    return { error: `${name} требует целое число больше нуля. ${USAGE}` };
  }
  return number;
}

/** Разбор аргументов; ошибка - текст для пользователя (без данных). */
export function parseSurveyArgs(argv: readonly string[]): SurveyArgs | { error: string } {
  const args: SurveyArgs = {
    windowDays: MAIL_TRUST_SURVEY_WINDOW_DAYS,
    maxMessagesPerMailbox: SURVEY_DEFAULT_MAX_MESSAGES,
    maxMinutesPerMailbox: SURVEY_DEFAULT_MAX_MINUTES,
    scope: 'all',
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === '--json') {
      args.json = true;
      continue;
    }
    if (!['--days', '--max-messages', '--max-minutes', '--scope'].includes(arg)) {
      return { error: `неизвестный аргумент: ${arg}. ${USAGE}` };
    }
    const value = argv[index + 1];
    if (value === undefined || value === '' || value.startsWith('--')) {
      return { error: `${arg} требует значение. ${USAGE}` };
    }
    index += 1;
    if (arg === '--scope') {
      const scope = SCOPES.find((item) => item === value);
      if (scope === undefined) return { error: `--scope: all, sources или employees. ${USAGE}` };
      args.scope = scope;
      continue;
    }
    const parsed = positive(value, arg);
    if (typeof parsed !== 'number') return parsed;
    if (arg === '--days') args.windowDays = parsed;
    else if (arg === '--max-messages') args.maxMessagesPerMailbox = parsed;
    else args.maxMinutesPerMailbox = parsed;
  }
  return args;
}

/**
 * Выполнить обследование и вывести агрегаты.
 * @returns код выхода
 */
export async function runSurveyCommand(
  args: SurveyArgs,
  deps: MailTrustSurveyDeps | undefined,
  print: (line: string) => void,
): Promise<number> {
  if (deps === undefined) {
    print('Почта не подключена (ящики сотрудников выключены или не настроены): читать нечего.');
    return EXIT_ERROR;
  }
  const result = await runMailTrustSurvey(deps, args);
  if (args.json) print(JSON.stringify(result, null, 2));
  else for (const line of formatMailTrustSurvey(result)) print(line);
  return EXIT_OK;
}
