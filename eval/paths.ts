import { join } from 'node:path';
import { pragmatikaEval } from '../src/eval';

/**
 * Пути данных и список агентов в прежнем виде (константы старого eval). Раннер платформы берёт
 * то же самое из зарегистрированного проекта функциями `defaultCasesDir()` и др.; константы
 * нужны скриптам записи и тестам, которые не регистрируют проект до импорта.
 */
export const EVAL_ROOT = import.meta.dir;
/** Переменная окружения: корень данных (cases, recordings); нужна синхронизации для пересъёмки. */
export const EVAL_DATA_ROOT_ENV = 'EVAL_DATA_ROOT';
const DATA_ROOT = process.env[EVAL_DATA_ROOT_ENV] ?? EVAL_ROOT;
export const AGENT_IDS = pragmatikaEval.agentIds;
export const DEFAULT_CASES_DIR = join(DATA_ROOT, 'cases');
export const DEFAULT_RECORDINGS_DIR = join(DATA_ROOT, 'recordings');
/** Набор по передачам задач между агентами: свой каталог кейсов и записей. */
export const DEFAULT_HANDOFF_CASES_DIR = join(DEFAULT_CASES_DIR, 'handoff');
export const DEFAULT_HANDOFF_RECORDINGS_DIR = join(DEFAULT_RECORDINGS_DIR, 'handoff');
