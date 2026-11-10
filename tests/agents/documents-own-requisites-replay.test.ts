import { beforeEach, describe, expect, test } from 'bun:test';
import {
  MemoryAccessPolicy,
  MemoryAuditRepository,
  MemoryIdempotencyStore,
} from '@business-ai/adapters';
import {
  MemoryOwnLegalEntityRepository,
} from '../../src/kit/adapters/memory/own-legal-entity-repository';
import { executeTool } from '@business-ai/adapters';
import {
  OWN_REQUISITES_REQUEST_NAMESPACE,
  confirmOwnRequisitesUpdate,
  proposeOwnRequisitesUpdate,
} from '../../src/agents/documents/update-own-requisites';
import { createToolContext, type AnyToolDefinition } from '@business-ai/core';
import { noteEmployeeMessage } from '../../src/agents/documents/employee-messages';
import { ownRequisitesFromRepository } from '../../src/agents/documents/own-requisites';
import { type DocumentsDeps } from '../../src/agents/documents/deps';
import { ACTION_UPDATE_OWN_REQUISITES } from '../../src/kit/domain/access.owned';
import type { WorkflowStateStore } from '@business-ai/core';
import { SYNTH_MASTER_GIFTS, SYNTH_PRAGMATIKA } from '../kit/support/own-entity-fixtures';
import { buildDocumentsDeps } from './support';

/**
 * Этап 230, повтор через рантайм идемпотентности: после отказа, отмены или устаревания та же
 * правка должна исполняться заново (новый вопрос сотруднику), а не отвечать из кэша. Тесты идут
 * через `executeTool` с настоящим хранилищем ключей: прямой вызов `execute` кэш обходит.
 */

const USER = 'u-boss';
const THREAD = 'documents/u-boss';
const AT = '2026-11-08T10:00:00.000Z';
const NEW_PHONE = '(900) 777-88-99';
const OLD_PHONE = SYNTH_PRAGMATIKA.phone ?? '';
const HOUR_MS = 3_600_000;

type Built = Awaited<ReturnType<typeof buildDocumentsDeps>>;
interface World {
  deps: Built;
  repo: MemoryOwnLegalEntityRepository;
  access: MemoryAccessPolicy;
  audit: MemoryAuditRepository;
  host: DocumentsDeps;
  idempotency: MemoryIdempotencyStore;
}
let world: World;

function buildHost(deps: Built, repo: MemoryOwnLegalEntityRepository) {
  const access = new MemoryAccessPolicy();
  access.allow({ userId: USER, botId: 'documents', action: ACTION_UPDATE_OWN_REQUISITES });
  const audit = new MemoryAuditRepository();
  const host: DocumentsDeps = {
    ...deps,
    ownEntities: repo,
    ownRequisites: ownRequisitesFromRepository(repo),
    access,
    audit,
  };
  return { access, audit, host };
}

beforeEach(async () => {
  const deps = await buildDocumentsDeps();
  const repo = new MemoryOwnLegalEntityRepository();
  await repo.save('pragmatika', SYNTH_PRAGMATIKA, { updatedBy: 'seed', at: AT });
  await repo.save('master_gifts', SYNTH_MASTER_GIFTS, { updatedBy: 'seed', at: AT });
  const built = buildHost(deps, repo);
  world = { deps, repo, ...built, idempotency: new MemoryIdempotencyStore() };
  await noteEmployeeMessage(deps.state, THREAD, `Обнови телефон Прагматики: ${NEW_PHONE}`);
});

/** Вызов инструмента так, как его делает рантайм: ключ операции, кэш результатов, резервы. */
async function call(tool: AnyToolDefinition, input: unknown, host: DocumentsDeps = world.host) {
  const turn = createToolContext({
    threadId: THREAD,
    agentId: 'documents',
    operationId: 'op',
    initiator: { kind: 'user', userId: USER },
  });
  const { operationId: _unused, ...scope } = turn;
  const runtime = {
    agentId: 'documents',
    deps: host,
    validators: [],
    idempotency: world.idempotency,
    inFlight: new Map(),
  };
  return executeTool(runtime, tool, input, { turn: scope });
}
const propose = (changes: Record<string, string | null> = { phone: NEW_PHONE }, entity = 'pr') =>
  call(proposeOwnRequisitesUpdate, { entity, changes });
type Decision = 'confirmed' | 'rejected' | 'unclear';
const confirm = (decision: Decision = 'confirmed', host?: DocumentsDeps) =>
  call(confirmOwnRequisitesUpdate, { decision }, host);
const questions = () =>
  world.deps.chat.outbox.filter((r) => (r.message?.text ?? '').includes('Подтверждаете'));
const status = (value: unknown): unknown => (value as { status?: unknown }).status;
const phone = async () => (await world.repo.get('pragmatika'))?.phone;

describe('повтор той же правки после исхода без записи', () => {
  test('отмена: та же правка предлагается заново, вопрос уходит второй раз', async () => {
    expect(status(await propose())).toBe('asked');
    expect(status(await confirm('rejected'))).toBe('rejected');
    expect(status(await propose())).toBe('asked');
    expect(questions()).toHaveLength(2);
    // Новый запрос подтверждается и пишется: цикл «not_asked» разорван.
    expect(status(await confirm())).toBe('updated');
    expect(await phone()).toBe(NEW_PHONE);
  });

  test('значения не названы: после текста от сотрудника тот же вызов исполняется', async () => {
    const email = 'office2@example.test';
    expect(status(await propose({ email }))).toBe('values_not_confirmed');
    await noteEmployeeMessage(world.deps.state, THREAD, `почта Прагматики ${email}`);
    expect(status(await propose({ email }))).toBe('asked');
    expect(questions()).toHaveLength(1);
  });

  test('юрлицо не названо: после уточнения сотрудника тот же вызов исполняется', async () => {
    expect(status(await propose({ phone: NEW_PHONE }, 'mg'))).toBe('entity_not_confirmed');
    await noteEmployeeMessage(world.deps.state, THREAD, 'Это для Мастер Гифтс');
    expect(status(await propose({ phone: NEW_PHONE }, 'mg'))).toBe('asked');
  });

  test('нет права: после выдачи права та же правка предлагается', async () => {
    const policy = new MemoryAccessPolicy();
    const noRight: DocumentsDeps = { ...world.host, access: policy };
    const input = { entity: 'pr', changes: { phone: NEW_PHONE } };
    expect(status(await call(proposeOwnRequisitesUpdate, input, noRight))).toBe('access_denied');
    policy.allow({ userId: USER, botId: 'documents', action: ACTION_UPDATE_OWN_REQUISITES });
    expect(status(await call(proposeOwnRequisitesUpdate, input, noRight))).toBe('asked');
  });

  test('устарело (запись изменили): новое предложение даёт новый вопрос', async () => {
    await propose();
    await world.repo.save(
      'pragmatika',
      { ...SYNTH_PRAGMATIKA, email: 'other@example.test' },
      { updatedBy: 'someone', at: '2026-11-08T10:30:00.000Z' },
    );
    expect(status(await confirm())).toBe('stale');
    expect(status(await propose())).toBe('asked');
    expect(questions()).toHaveLength(2);
    expect(status(await confirm())).toBe('updated');
  });

  test('просрочено (час): повторное предложение даёт новый вопрос', async () => {
    await propose();
    world.deps.clock.advance(2 * HOUR_MS);
    expect(status(await confirm())).toBe('not_asked');
    expect(status(await propose())).toBe('asked');
    expect(questions()).toHaveLength(2);
    expect(status(await confirm())).toBe('updated');
  });

  test('A -> B -> A: вернуть прежнее значение той же правкой можно', async () => {
    await propose();
    await confirm();
    await noteEmployeeMessage(world.deps.state, THREAD, `Прагматика, верни телефон ${OLD_PHONE}`);
    await propose({ phone: OLD_PHONE });
    await confirm();
    expect(await phone()).toBe(OLD_PHONE);
    await propose();
    expect(status(await confirm())).toBe('updated');
    expect(await phone()).toBe(NEW_PHONE);
  });
});

describe('настоящий повтор остаётся повтором', () => {
  test('то же предложение при открытом запросе не задваивает вопрос', async () => {
    await propose();
    expect(status(await propose())).toBe('asked');
    expect(questions()).toHaveLength(1);
  });

  test('повтор «да» после записи не пишет второй раз', async () => {
    await propose();
    await confirm();
    await confirm();
    expect(await world.audit.list(USER)).toHaveLength(1);
  });
});

describe('запись прошла, закрытие запроса упало', () => {
  /** Хранилище состояния, которое один раз отказывает в закрытии запроса (patch стёрт). */
  function flaky(base: WorkflowStateStore): { store: WorkflowStateStore; failures: () => number } {
    let failed = 0;
    const put: WorkflowStateStore['put'] = async (ns, key, value, options) => {
      const closing =
        ns === OWN_REQUISITES_REQUEST_NAMESPACE &&
        typeof value === 'object' &&
        value !== null &&
        'closedAt' in value;
      if (closing && failed === 0) {
        failed += 1;
        throw new Error('state_unavailable');
      }
      return base.put(ns, key, value, options);
    };
    // Остальные методы - прямо в хранилище; подмена только записи закрытия запроса.
    const store = new Proxy(base, {
      get(target, prop) {
        if (prop === 'put') return put;
        const member: unknown = Reflect.get(target, prop);
        return typeof member === 'function' ? member.bind(target) : member;
      },
    });
    return { store, failures: () => failed };
  }

  test('через рантайм: ответ «записано», журнал один, повтор из кэша тоже «записано»', async () => {
    const { store, failures } = flaky(world.deps.state);
    const events: string[] = [];
    const log = (event: string) => void events.push(event);
    const host: DocumentsDeps = { ...world.host, state: store, log };
    await propose();
    expect(status(await confirm('confirmed', host))).toBe('updated');
    expect(failures()).toBe(1);
    expect(events).toContain('own_requisites_close_failed');
    expect(await phone()).toBe(NEW_PHONE);
    expect(await world.audit.list(USER)).toHaveLength(1);
    expect(status(await confirm('confirmed', host))).toBe('updated');
    expect(await world.audit.list(USER)).toHaveLength(1);
  });

  test('падение до сохранения результата: повтор отвечает «записано» и закрывает запрос', async () => {
    const { store } = flaky(world.deps.state);
    const host: DocumentsDeps = { ...world.host, state: store };
    await propose();
    const turn = createToolContext({
      threadId: THREAD,
      agentId: 'documents',
      operationId: 'op-direct',
      initiator: { kind: 'user', userId: USER },
    });
    // Прямой вызов обходит кэш ключей: так выглядит повтор после падения процесса.
    const first = await confirmOwnRequisitesUpdate.execute({ decision: 'confirmed' }, host, turn);
    expect(first.status).toBe('updated');
    const retry = await confirmOwnRequisitesUpdate.execute({ decision: 'confirmed' }, host, turn);
    expect(retry.status).toBe('updated');
    expect(retry.fields).toEqual(['phone']);
    expect(JSON.stringify(retry)).not.toContain(NEW_PHONE);
    expect(await world.audit.list(USER)).toHaveLength(1);
    const after = await confirmOwnRequisitesUpdate.execute({ decision: 'confirmed' }, host, turn);
    expect(after.status).toBe('not_asked');
    expect(await world.audit.list(USER)).toHaveLength(1);
  });
});
