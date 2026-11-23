import { beforeEach, describe, expect, test } from 'bun:test';
import { MemoryAccessPolicy, MemoryAuditRepository } from '@business-ai/adapters';
import {
  MemoryOwnLegalEntityRepository,
} from '../../src/kit/adapters/memory/own-legal-entity-repository';
import {
  confirmOwnRequisitesUpdate,
  proposeOwnRequisitesUpdate,
} from '../../src/agents/documents/update-own-requisites';
import { createDocumentsAgent } from '../../src/agents/documents/declaration';
import { createToolContext } from '@business-ai/core';
import { noteEmployeeMessage } from '../../src/agents/documents/employee-messages';
import { ownRequisitesFromRepository } from '../../src/agents/documents/own-requisites';
import { type DocumentsDeps } from '../../src/agents/documents/deps';
import { ACTION_UPDATE_OWN_REQUISITES } from '../../src/kit/domain/access.owned';
import { SYNTH_MASTER_GIFTS, SYNTH_PRAGMATIKA } from '../kit/support/own-entity-fixtures';
import { buildDocumentsDeps } from './support';

/**
 * Этап 230: изменение наших реквизитов по указанию сотрудника. Два шага: предложение (код
 * показывает было/станет) и подтверждение сотрудником; запись - только после подтверждения, под
 * отдельным правом, с журналом «кто/когда/какие поля» без значений.
 */

const USER = 'u-boss';
const OTHER = 'u-clerk';
const THREAD = 'documents/u-boss';
const AT = '2026-11-08T10:00:00.000Z';
const NEW_PHONE = '(900) 777-88-99';
const SAY = `Обнови телефон Прагматики: ${NEW_PHONE}`;

interface World {
  deps: Awaited<ReturnType<typeof buildDocumentsDeps>>;
  repo: MemoryOwnLegalEntityRepository;
  access: MemoryAccessPolicy;
  audit: MemoryAuditRepository;
  host: DocumentsDeps;
  events: Array<{ event: string; fields: Record<string, unknown> }>;
}
let world: World;

beforeEach(async () => {
  const deps = await buildDocumentsDeps();
  const repo = new MemoryOwnLegalEntityRepository();
  await repo.save('pragmatika', SYNTH_PRAGMATIKA, { updatedBy: 'seed', at: AT });
  await repo.save('master_gifts', SYNTH_MASTER_GIFTS, { updatedBy: 'seed', at: AT });
  const access = new MemoryAccessPolicy();
  access.allow({ userId: USER, botId: 'documents', action: ACTION_UPDATE_OWN_REQUISITES });
  const audit = new MemoryAuditRepository();
  const events: World['events'] = [];
  world = {
    deps,
    repo,
    access,
    audit,
    events,
    host: {
      ...deps,
      ownEntities: repo,
      ownRequisites: ownRequisitesFromRepository(repo),
      access,
      audit,
      log: (event, fields) => void events.push({ event, fields: fields ?? {} }),
    },
  };
  await noteEmployeeMessage(deps.state, THREAD, SAY);
});

const ctx = (userId = USER, kind: 'user' | 'schedule' = 'user') =>
  createToolContext({
    threadId: THREAD,
    agentId: 'documents',
    operationId: `op-${userId}-${Math.random()}`,
    initiator: kind === 'user' ? { kind: 'user', userId } : { kind: 'unknown' },
  });

const propose = (
  changes: Record<string, string | null> = { phone: NEW_PHONE },
  entity: 'mg' | 'pr' = 'pr',
  host: DocumentsDeps = world.host,
  userId = USER,
) =>
  proposeOwnRequisitesUpdate.execute(
    proposeOwnRequisitesUpdate.inputSchema.parse({ entity, changes }),
    host,
    ctx(userId),
  );
const confirm = (
  decision: 'confirmed' | 'rejected' | 'unclear' = 'confirmed',
  host: DocumentsDeps = world.host,
  userId = USER,
) => confirmOwnRequisitesUpdate.execute({ decision }, host, ctx(userId));
const stored = async () => {
  const record = await world.repo.get('pragmatika');
  if (record === null) throw new Error('записи нет');
  return record;
};
const clean = (value: unknown): string => JSON.stringify(value);

describe('декларация', () => {
  const names = (opts: Parameters<typeof createDocumentsAgent>[0]) =>
    createDocumentsAgent(opts).tools.map((tool) => tool.name);

  test('инструменты и абзац промпта только с опцией ownRequisitesUpdate', () => {
    const on = createDocumentsAgent({ model: 'm', ownRequisitesUpdate: true });
    expect(on.tools.map((t) => t.name)).toContain('proposeOwnRequisitesUpdate');
    expect(on.tools.map((t) => t.name)).toContain('confirmOwnRequisitesUpdate');
    expect(on.prompt).toContain('proposeOwnRequisitesUpdate');
    expect(names({ model: 'm' })).not.toContain('proposeOwnRequisitesUpdate');
    expect(createDocumentsAgent({ model: 'm' }).prompt).not.toContain('proposeOwnRequisitesUpdate');
  });

  test('новое право известно политике и не выдаётся молча', async () => {
    expect(ACTION_UPDATE_OWN_REQUISITES).toBe('documents.update_own_requisites');
    expect(await new MemoryAccessPolicy().isAllowed({
      userId: USER,
      botId: 'documents',
      action: ACTION_UPDATE_OWN_REQUISITES,
    })).toBe(false);
  });
});

describe('предложение изменения', () => {
  test('показывает «было → станет» сотруднику; модели возвращает только названия полей', async () => {
    const out = await propose();
    expect(out.status).toBe('asked');
    expect(out.fields).toEqual(['phone']);
    const shown = world.deps.chat.outbox.map((r) => r.message?.text ?? '').join('\n');
    expect(shown).toContain(NEW_PHONE);
    expect(shown).toContain(SYNTH_PRAGMATIKA.phone ?? '');
    expect(clean(out)).not.toContain(NEW_PHONE);
    // Пока не подтверждено - запись прежняя.
    expect((await stored()).phone).toBe(SYNTH_PRAGMATIKA.phone);
  });

  test('без права действия - отказ, ничего не показано и не записано', async () => {
    const denied = { ...world.host, access: new MemoryAccessPolicy() };
    const out = await propose({ phone: NEW_PHONE }, 'pr', denied);
    expect(out.status).toBe('access_denied');
    expect(world.deps.chat.outbox).toHaveLength(0);
    const noPolicy: DocumentsDeps = { ...world.host };
    delete noPolicy.access;
    expect((await propose({ phone: NEW_PHONE }, 'pr', noPolicy)).status).toBe('access_denied');
  });

  test('плановый ход (не сотрудник) - ошибка доступа', async () => {
    await expect(
      proposeOwnRequisitesUpdate.execute(
        { entity: 'pr', changes: { phone: NEW_PHONE } },
        world.host,
        ctx(USER, 'schedule'),
      ),
    ).rejects.toMatchObject({ code: 'access_denied' });
  });

  test('юрлицо должно быть названо сотрудником в последних сообщениях', async () => {
    const out = await propose({ phone: NEW_PHONE }, 'mg');
    expect(out.status).toBe('entity_not_confirmed');
    expect(world.deps.chat.outbox).toHaveLength(0);
  });

  test('значение, которого сотрудник не называл, не принимается (названия полей без значений)', async () => {
    const out = await propose({ phone: NEW_PHONE, email: 'придумано@example.test' });
    expect(out.status).toBe('values_not_confirmed');
    expect(out.fields).toEqual(['email']);
    expect(clean(out)).not.toContain('придумано');
    expect(world.deps.chat.outbox).toHaveLength(0);
  });

  test('неверные реквизиты (контрольная сумма) отклоняются без значений', async () => {
    await noteEmployeeMessage(world.deps.state, THREAD, 'ИНН Прагматики теперь 1234567006');
    const out = await propose({ inn: '1234567006' });
    expect(out.status).toBe('invalid');
    expect(out.message).toContain('ИНН');
    expect(clean(out)).not.toContain('1234567006');
  });

  test('записи юрлица нет - отказ: создаёт её владелец скриптом', async () => {
    const empty = new MemoryOwnLegalEntityRepository();
    const out = await propose({ phone: NEW_PHONE }, 'pr', { ...world.host, ownEntities: empty });
    expect(out.status).toBe('no_record');
  });

  test('значение не меняется - no_change', async () => {
    await noteEmployeeMessage(world.deps.state, THREAD, `телефон ${SYNTH_PRAGMATIKA.phone}`);
    const out = await propose({ phone: SYNTH_PRAGMATIKA.phone ?? '' });
    expect(out.status).toBe('no_change');
  });

  test('null убирает необязательное поле', async () => {
    const out = await propose({ postalAddress: null });
    expect(out.status).toBe('asked');
    expect(out.fields).toEqual(['postalAddress']);
  });
});

describe('подтверждение сотрудником', () => {
  test('«да» записывает правку, автор и время в записи, журнал без значений', async () => {
    await propose();
    world.deps.clock.advance(60_000);
    const out = await confirm();
    expect(out.status).toBe('updated');
    expect(out.fields).toEqual(['phone']);
    const record = await stored();
    expect(record.phone).toBe(NEW_PHONE);
    expect(record.updatedBy).toBe(USER);
    expect(record.updatedAt).toBe(world.deps.clock.now().toISOString());
    // Остальные поля не тронуты.
    expect(record.inn).toBe(SYNTH_PRAGMATIKA.inn);
    const entries = await world.audit.list(USER);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.action).toBe('documents.own_requisites_update');
    expect(entries[0]?.details).toContain('pragmatika');
    expect(entries[0]?.details).toContain('phone');
    expect(clean(entries)).not.toContain(NEW_PHONE);
    const logged = world.events.find((e) => e.event === 'own_requisites_updated');
    expect(logged?.fields).toMatchObject({ entity: 'pragmatika', fields: 'phone' });
    expect(clean(world.events)).not.toContain(NEW_PHONE);
    expect(clean(out)).not.toContain(NEW_PHONE);
  });

  test('повторное «да» ничего не пишет второй раз', async () => {
    await propose();
    await confirm();
    const again = await confirm();
    expect(again.status).toBe('not_asked');
    expect(await world.audit.list(USER)).toHaveLength(1);
  });

  test('отказ закрывает запрос без записи', async () => {
    await propose();
    expect((await confirm('rejected')).status).toBe('rejected');
    expect((await stored()).phone).toBe(SYNTH_PRAGMATIKA.phone);
    expect((await confirm()).status).toBe('not_asked');
  });

  test('неясный ответ ничего не пишет и запрос остаётся открытым', async () => {
    await propose();
    const out = await confirm('unclear');
    expect(out.status).toBe('unclear');
    expect((await stored()).phone).toBe(SYNTH_PRAGMATIKA.phone);
    expect((await confirm()).status).toBe('updated');
  });

  test('без предложения подтверждать нечего', async () => {
    expect((await confirm()).status).toBe('not_asked');
  });

  test('подтвердить может только тот, кто просил; чужое «да» не записывает', async () => {
    world.access.allow({ userId: OTHER, botId: 'documents', action: ACTION_UPDATE_OWN_REQUISITES });
    await propose();
    const out = await confirm('confirmed', world.host, OTHER);
    expect(out.status).toBe('wrong_user');
    expect((await stored()).phone).toBe(SYNTH_PRAGMATIKA.phone);
  });

  test('право проверяется и при подтверждении', async () => {
    await propose();
    const out = await confirm('confirmed', { ...world.host, access: new MemoryAccessPolicy() });
    expect(out.status).toBe('access_denied');
    expect((await stored()).phone).toBe(SYNTH_PRAGMATIKA.phone);
  });

  test('запись изменилась после предложения - stale, правка не применяется', async () => {
    await propose();
    await world.repo.save(
      'pragmatika',
      { ...SYNTH_PRAGMATIKA, email: 'other@example.test' },
      { updatedBy: 'someone', at: '2026-11-08T10:30:00.000Z' },
    );
    const out = await confirm();
    expect(out.status).toBe('stale');
    expect((await stored()).phone).toBe(SYNTH_PRAGMATIKA.phone);
  });

  test('просроченный запрос не действует', async () => {
    await propose();
    world.deps.clock.advance(2 * 60 * 60 * 1000);
    expect((await confirm()).status).toBe('not_asked');
    expect((await stored()).phone).toBe(SYNTH_PRAGMATIKA.phone);
  });

  test('новое предложение заменяет прежнее: подтверждается последнее', async () => {
    await noteEmployeeMessage(world.deps.state, THREAD, 'и почта Прагматики office2@example.test');
    await propose({ phone: NEW_PHONE });
    await propose({ email: 'office2@example.test' });
    const out = await confirm();
    expect(out.fields).toEqual(['email']);
    const record = await stored();
    expect(record.email).toBe('office2@example.test');
    expect(record.phone).toBe(SYNTH_PRAGMATIKA.phone);
  });
});
