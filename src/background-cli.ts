import {
  MemoryChatChannel,
  MemoryCrm,
  applyIdentifierSettings,
  createPgClient,
  registerEventSeverity,
} from '@business-ai/adapters';
import { setPiiAllowedWords } from '@business-ai/core';
import { composeProduction, loadProductionConfig } from '@business-ai/core/compose';
import {
  EXIT_ERROR as BACKFILL_EXIT_ERROR,
  parseBackfillArgs,
  runBackfillCommand,
} from './background-mail-backfill';
import {
  EXIT_ERROR as CRM_EXIT_ERROR,
  parseCrmSyncArgs,
  runCrmSyncCommand,
} from './background-crm-sync';
import {
  EXIT_ERROR as SURVEY_EXIT_ERROR,
  parseSurveyArgs,
  runSurveyCommand,
} from './background-mail-survey';
import type { BackgroundCommands } from './background-wiring';
import { pragmatikaRuntime } from './runtime';

/**
 * Разовые команды владельца: `bun run src/background-cli.ts <команда> [аргументы]`.
 *
 * - `mail-info-backfill` - проход по общему ящику (`--report`, `--apply`, `--recheck`);
 * - `mail-trust-survey` - обследование доверия к отправителям почты (только чтение);
 * - `crm-suppliers-sync` - проход по компаниям CRM (нужен порт компаний CRM-поставщиков).
 *
 * В прежней сборке это три отдельные точки входа без расписания и флага включения: службе они
 * не нужны и ею не запускаются. Платформенная точка запуска такие команды не знает, поэтому они
 * живут в проекте и собирают приложение на заглушках чата и CRM (письмо сотруднику написать
 * нечем, фоновые задачи службы не стартуют). Коды выхода: 0 - сделано, 1 - ошибка, 2 -
 * остановка до конца (повторить запуск).
 */

/** Имена команд. */
export const BACKGROUND_COMMAND_NAMES = [
  'mail-info-backfill',
  'mail-trust-survey',
  'crm-suppliers-sync',
] as const;

/** Имя одной из команд. */
export type BackgroundCommandName = (typeof BACKGROUND_COMMAND_NAMES)[number];

/** Сколько записей исходящего хранит заглушка чата (команда никому не пишет). */
const STUB_CHAT_RECORDS = 10;
/** Код выхода «ошибка»: одинаков у всех команд. */
const EXIT_ERROR = BACKFILL_EXIT_ERROR;

/** Что командам нужно знать о конфигурации помимо зависимостей приложения. */
export interface BackgroundCommandEnv {
  /** Портал Bitrix24 настроен (`BITRIX24_WEBHOOK_URL`). */
  bitrix24Configured: boolean;
  /** Реквизиты наших юрлиц заданы (`OWN_COMPANY_REQUISITES`). */
  ownCompanyRequisitesConfigured: boolean;
}

const USAGE = `использование: background-cli <${BACKGROUND_COMMAND_NAMES.join('|')}> [аргументы]`;

function isCommandName(name: string): name is BackgroundCommandName {
  return (BACKGROUND_COMMAND_NAMES as readonly string[]).includes(name);
}

async function runCrmSync(
  argv: readonly string[],
  commands: BackgroundCommands,
  env: BackgroundCommandEnv,
  print: (line: string) => void,
): Promise<number> {
  const args = parseCrmSyncArgs(argv);
  if ('error' in args) {
    print(args.error);
    return CRM_EXIT_ERROR;
  }
  const missing: string[] = [];
  if (!env.bitrix24Configured) missing.push('BITRIX24_WEBHOOK_URL');
  if (!env.ownCompanyRequisitesConfigured) missing.push('OWN_COMPANY_REQUISITES');
  if (missing.length > 0) {
    // Без портала читать нечего, без реквизитов нашу фирму из CRM нечем отсеять.
    print(`не заданы переменные: ${missing.join(', ')}`);
    return CRM_EXIT_ERROR;
  }
  const pass = commands.crmPass;
  if (pass === undefined) {
    print('портал CRM-поставщиков не собран');
    return CRM_EXIT_ERROR;
  }
  return runCrmSyncCommand(args, { run: (options) => pass.run(options) }, print);
}

/**
 * Выполнить команду по имени. Зависимости команды берутся из `commands` только когда она
 * выбрана (обследование не открывает каталог ящиков, пока его не просили).
 * @returns код выхода; вывод - построчно в `print`
 */
export async function runBackgroundCommand(
  name: string,
  argv: readonly string[],
  commands: BackgroundCommands,
  env: BackgroundCommandEnv,
  print: (line: string) => void,
): Promise<number> {
  if (!isCommandName(name)) {
    print(USAGE);
    return EXIT_ERROR;
  }
  if (name === 'crm-suppliers-sync') return runCrmSync(argv, commands, env, print);
  if (name === 'mail-trust-survey') {
    const args = parseSurveyArgs(argv);
    if ('error' in args) {
      print(args.error);
      return SURVEY_EXIT_ERROR;
    }
    return runSurveyCommand(args, commands.mailSurvey(), print);
  }
  const { mailBackfill } = commands;
  const args = parseBackfillArgs(argv, mailBackfill.maxModelCalls, mailBackfill.windowDays);
  if ('error' in args) {
    print(args.error);
    return BACKFILL_EXIT_ERROR;
  }
  return runBackfillCommand(
    args,
    {
      scanDeps: mailBackfill.scanDeps,
      applyDeps: mailBackfill.applyDeps,
      defaultAddress: mailBackfill.defaultAddress,
      ownCompanyRequisites: mailBackfill.ownCompanyRequisites,
    },
    print,
  );
}

/** Собрать приложение на заглушках чата и CRM, выполнить команду, закрыть приложение. */
async function main(argv: readonly string[]): Promise<number> {
  const [name = '', ...rest] = argv;
  const print = (line: string): void => console.log(line);
  if (!isCommandName(name)) {
    print(USAGE);
    return EXIT_ERROR;
  }
  // Манифест подключается здесь, а не при загрузке модуля: тесты диспетчера его не тянут.
  const { pragmatikaProject: project } = await import('./project');
  const config = loadProductionConfig(process.env, project);
  // Постоянные идентификаторы и реестры - до сборки, как в основной точке запуска.
  applyIdentifierSettings(process.env);
  registerEventSeverity(project.eventSeverity, {
    allowOverride: project.eventSeverityOverrides,
  });
  setPiiAllowedWords([...project.piiAllowedWords, ...config.agents.piiAllowedWords]);
  const db = createPgClient({
    url: config.database.url,
    maxConnections: config.database.poolSize,
  });
  const extra = project.ports?.({ config, portal: undefined, db });
  // Прогрева ящиков нет: второй процесс не заходит в IMAP под учётками работающей службы.
  const app = composeProduction(
    config,
    {
      chat: new MemoryChatChannel({ maxRecords: STUB_CHAT_RECORDS }),
      crm: new MemoryCrm(new Map()),
      ...(extra === undefined ? {} : { extra }),
    },
    project,
    { mailWarmUp: false, db },
  );
  try {
    const commands = pragmatikaRuntime()?.background;
    if (commands === undefined) {
      print('приложение не собрано: зависимости команд недоступны');
      return EXIT_ERROR;
    }
    const env: BackgroundCommandEnv = {
      bitrix24Configured: config.bitrix24 !== undefined,
      ownCompanyRequisitesConfigured: commands.mailBackfill.ownCompanyRequisites.length > 0,
    };
    return await runBackgroundCommand(name, rest, commands, env, print);
  } finally {
    await app.close();
  }
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      // Только имя ошибки: текст мог бы нести фрагмент письма, адрес ящика или запроса к базе.
      console.error(error instanceof Error ? error.name : 'сбой разовой команды');
      process.exit(EXIT_ERROR);
    });
}
