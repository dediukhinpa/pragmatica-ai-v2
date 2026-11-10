import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  CHAT_FEEDBACK_PROMPT,
  E2E_MODELS,
  MANAGER_THREAD,
  OWN_COMPANY,
  e2eConfig,
  e2eEnv,
} from '../../e2e/lib/project-env';

/** Значения окружения, которые в бою выставляет e2e/run.sh. */
const RUN_ENV: Record<string, string> = {
  E2E_WORK: '/tmp/e2e-work',
  DATABASE_URL: 'postgres://postgres@127.0.0.1:20600/agentplatform',
  E2E_PSEUDO_PORT: '20610',
  E2E_DOCS_PORT: '20611',
  E2E_EMBED_PORT: '20612',
  E2E_GUARD_PORT: '20613',
  E2E_LLM_PORT: '20614',
  E2E_VISION_PORT: '20615',
  PSEUDONYMIZER_API_TOKEN: 'тестовый-токен',
};

describe('e2e/lib/project-env: окружение и конфигурация сценариев', () => {
  const saved = new Map<string, string | undefined>();

  beforeAll(() => {
    for (const [name, value] of Object.entries(RUN_ENV)) {
      saved.set(name, process.env[name]);
      process.env[name] = value;
    }
  });

  afterAll(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  test('корни прайсов и шаблонов лежат внутри каталога файлов платформы', () => {
    const env = e2eEnv();
    expect(env.filesRoot).toBe('/tmp/e2e-work/files');
    expect(env.pricesRoot).toBe('/tmp/e2e-work/files/prices');
    expect(env.templatesRoot).toBe('/tmp/e2e-work/files/templates');
    expect(env.documentsUrl).toBe('http://127.0.0.1:20611');
  });

  test('конфигурация собирается из окружения run.sh, переопределения сильнее', () => {
    const config = e2eConfig();
    expect(config.database.url).toBe(RUN_ENV['DATABASE_URL'] ?? '');
    const changed = e2eConfig({ DATABASE_URL: 'postgres://postgres@127.0.0.1:1/x' });
    expect(changed.database.url).toBe('postgres://postgres@127.0.0.1:1/x');
  });

  test('модели агентов различимы заглушкой, тред менеджера и юрлицо заданы', () => {
    const aliases = Object.values(E2E_MODELS);
    expect(new Set(aliases).size).toBe(aliases.length);
    expect(MANAGER_THREAD).toBe('e2e-manager');
    expect(OWN_COMPANY.length).toBeGreaterThan(0);
    expect(CHAT_FEEDBACK_PROMPT.length).toBeGreaterThan(0);
  });

  test('без окружения run.sh сценарий падает с понятной ошибкой', () => {
    const work = process.env['E2E_WORK'];
    delete process.env['E2E_WORK'];
    try {
      expect(() => e2eEnv()).toThrow('E2E_WORK');
    } finally {
      if (work !== undefined) process.env['E2E_WORK'] = work;
    }
  });
});
