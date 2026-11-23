import { describe, expect, test } from 'bun:test';
import {
  PLATFORM_ACCESS_ACTIONS,
  createAccessRulesSchema,
  evaluateAccess,
  type AccessPolicy,
} from '@business-ai/core';
import {
  ACTION_CONFIRM_SUPPLIER_CARD,
  ACTION_MANAGE_SUPPLIER_CARDS,
  PROJECT_ACCESS_ACTIONS,
  PROJECT_ACCESS_RESTRICTIONS,
} from '../../src/access-actions';
import { confirmCardVerdict } from '../../src/agents/suppliers/confirm-card-right';

/**
 * Запись карточек поставщиков (этап 8y): руководители отделов - как и прежде; менеджеры закупок
 * (отдел и личный список) - по явному правилу `suppliers.manage_cards`, без него закрыто.
 */

const BOT = 'documents';
const KNOWN = [...PLATFORM_ACCESS_ACTIONS, ...PROJECT_ACCESS_ACTIONS];
const schema = createAccessRulesSchema(KNOWN);
const PURCHASING_DEPARTMENT = '22';

/** Правила: бот открыт отделам 12 и 22 и одному сотруднику; менеджерам - правило действия. */
function rules(withManagerRule: boolean) {
  return schema.parse({
    version: 1,
    bots: {
      [BOT]: {
        allow: { departments: ['12', PURCHASING_DEPARTMENT], users: ['u-personal'] },
        actions: withManagerRule
          ? {
              [ACTION_MANAGE_SUPPLIER_CARDS]: {
                allow: { departments: [PURCHASING_DEPARTMENT], users: ['u-personal'] },
              },
            }
          : {},
      },
    },
  });
}

interface Subject {
  userId: string;
  groups: string[];
  isDepartmentHead?: boolean;
}

/** Политика на чистом решении платформы: те же правила и ограничения проекта. */
function policy(subject: Subject, withManagerRule: boolean): AccessPolicy {
  const decide = async (request: { userId: string; botId: string; action: string }) =>
    evaluateAccess(
      rules(withManagerRule),
      subject,
      request.botId,
      request.action,
      KNOWN,
      PROJECT_ACCESS_RESTRICTIONS,
    );
  return {
    decide,
    isAllowed: async (request: { userId: string; botId: string; action: string }) =>
      (await decide(request)).allowed,
  } as unknown as AccessPolicy;
}

const DEPT_22 = 'department:22';
const verdict = (subject: Subject, withManagerRule: boolean) =>
  confirmCardVerdict(policy(subject, withManagerRule), { userId: subject.userId, botId: BOT });

describe('запись карточек поставщиков: руководители и менеджеры закупок', () => {
  test('руководитель отдела проходит и без правила менеджеров (как раньше)', async () => {
    const head = { userId: 'u-head', groups: ['department:12'], isDepartmentHead: true };
    expect(await verdict(head, false)).toBe('allowed');
    expect(await verdict(head, true)).toBe('allowed');
  });

  test('менеджер отдела 22 не руководитель: без правила закрыто, с правилом открыто', async () => {
    const manager = { userId: 'u-manager', groups: [DEPT_22], isDepartmentHead: false };
    expect(await verdict(manager, false)).toBe('denied');
    expect(await verdict(manager, true)).toBe('allowed');
  });

  test('сотрудник из личного списка доступа проходит с правилом', async () => {
    const personal = { userId: 'u-personal', groups: [], isDepartmentHead: false };
    expect(await verdict(personal, false)).toBe('denied');
    expect(await verdict(personal, true)).toBe('allowed');
  });

  test('сотрудник другого отдела без руководства закрыт даже с правилом менеджеров', async () => {
    const other = { userId: 'u-other', groups: ['department:12'], isDepartmentHead: false };
    expect(await verdict(other, true)).toBe('denied');
  });

  test('сбой справочника не открывает доступ: unavailable, не allowed', async () => {
    const broken = {
      isAllowed: async () => {
        throw new Error('directory down');
      },
    } as unknown as AccessPolicy;
    expect(await confirmCardVerdict(broken, { userId: 'u', botId: BOT })).toBe('unavailable');
  });

  test('нет политики - запись запрещена', async () => {
    expect(await confirmCardVerdict(undefined, { userId: 'u', botId: BOT })).toBe('denied');
  });

  test('действие менеджеров объявлено и требует явного правила (fail closed)', () => {
    expect(PROJECT_ACCESS_ACTIONS).toContain(ACTION_MANAGE_SUPPLIER_CARDS);
    expect(PROJECT_ACCESS_RESTRICTIONS.ruleRequiredActions).toContain(ACTION_MANAGE_SUPPLIER_CARDS);
    expect(PROJECT_ACCESS_RESTRICTIONS.headOnlyActions).toContain(ACTION_CONFIRM_SUPPLIER_CARD);
  });
});
