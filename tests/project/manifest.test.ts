import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { WORKFLOW_STATE_STALE_SCOPE } from '../../src/kit/app/workflow-state-retention';
import { pragmatikaEval } from '../../src/eval';
import { pragmatikaProject } from '../../src/project';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const AGENT_IDS = ['prices', 'documents', 'order-calc', 'site-export'];

describe('манифест Прагматики', () => {
  test('проект называется pragmatika, агенты и модели совпадают', () => {
    expect(pragmatikaProject.id).toBe('pragmatika');
    expect(Object.keys(pragmatikaProject.models).sort()).toEqual([...AGENT_IDS].sort());
    expect(pragmatikaProject.models['order-calc']).toBe('ORDER_CALC_MODEL');
  });

  test('запасные модели вспомогательных запросов: поиск - «Документы», зрение - «Поиск»', () => {
    expect(pragmatikaProject.fallbackModelAgents).toEqual({
      webSearch: 'documents',
      vision: 'order-calc',
    });
  });

  test('чат: агент по умолчанию, владелец файлов, действия приветствия', () => {
    expect(AGENT_IDS).toContain(pragmatikaProject.chat.defaultAgentId);
    expect(pragmatikaProject.chat.fileOwner).toBe('prices');
    expect(Object.keys(pragmatikaProject.chat.greetingActions ?? {}).sort()).toEqual([
      'supplier-help',
      'supplier-template',
    ]);
    expect(pragmatikaProject.chat.fileHandlers).toHaveLength(1);
  });

  test('плановые задачи: мониторинг, диск, обзор почты, снятая CRM-синхронизация', () => {
    expect(pragmatikaProject.schedules.map((schedule) => schedule.name)).toEqual([
      'monitoring.tick',
      'prices.disk-sync',
      'suppliers.mail-proposals',
      'suppliers.crm-sync',
    ]);
  });

  test('каталог миграций проекта существует в репозитории', () => {
    expect(pragmatikaProject.migrationsDir).toBe('db/app');
    expect(existsSync(join(REPO_ROOT, pragmatikaProject.migrationsDir ?? ''))).toBe(true);
  });

  test('сводка при запуске: тексты для четырёх незаданных интеграций', () => {
    expect(Object.keys(pragmatikaProject.unconfiguredText).sort()).toEqual([
      'exportTemplate',
      'portalIntake',
      'priceOpenThreadBot',
      'staffDirectory',
    ]);
  });

  test('сроки хранения: общий учёт и запросы карточек', () => {
    const scopes = pragmatikaProject.staleScopes.map((item) => item.scope);
    expect(scopes).toContain(WORKFLOW_STATE_STALE_SCOPE);
    expect(scopes).toHaveLength(2);
    const withDays = pragmatikaProject.staleScopes.filter(
      (item) => item.retentionDays !== undefined,
    );
    expect(withDays).toHaveLength(1);
    expect(withDays[0]?.retentionDays).toBeGreaterThan(0);
  });

  test('снятая тема недельной проверки и слова-исключения ПДн', () => {
    expect(pragmatikaProject.retiredThreads).toHaveLength(1);
    // Реальных названий компании в коде нет: слова задаёт оператор переменной окружения.
    expect(pragmatikaProject.piiAllowedWords).toEqual([]);
    expect(pragmatikaProject.externalTextTools.length).toBeGreaterThan(0);
  });

  test('сводка конфигурации: только флаги и числа, без значений окружения', () => {
    const described = pragmatikaProject.describe?.({
      SUPPLIER_CARDS_ENABLED: 'true',
      PRICE_DISK_SYNC_ENABLED: 'false',
      SUPPLIER_MAIL_PROPOSALS_ENABLED: 'false',
      DOCUMENTS_ENABLED_KINDS: undefined,
    } as never);
    expect(described).toBeDefined();
    for (const value of Object.values(described ?? {})) {
      expect(['string', 'number', 'boolean']).toContain(typeof value);
    }
  });
});

describe('описание eval', () => {
  test('агенты eval - агенты манифеста', () => {
    expect([...pragmatikaEval.agentIds].sort()).toEqual([...AGENT_IDS].sort());
    expect(pragmatikaProject.eval).toBe(pragmatikaEval);
  });

  test('у каждого агента есть проверки состояния, без повторов', () => {
    for (const id of AGENT_IDS) {
      const names = pragmatikaEval.probeNames[id] ?? [];
      expect(names.length).toBeGreaterThan(0);
      expect(new Set(names).size).toBe(names.length);
      expect(names).toContain('chatMessages');
    }
  });

  test('число проверок совпадает с эталоном прежнего eval', () => {
    const counts = Object.fromEntries(
      AGENT_IDS.map((id) => [id, pragmatikaEval.probeNames[id]?.length ?? 0]),
    );
    expect(counts).toEqual({ prices: 4, documents: 6, 'order-calc': 20, 'site-export': 4 });
  });
});
