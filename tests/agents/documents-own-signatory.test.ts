import { beforeEach, describe, expect, test } from 'bun:test';
import { MemoryContractAmender } from '../../src/kit/adapters/memory/contract-amender';
import {
  MemoryOwnLegalEntityRepository,
} from '../../src/kit/adapters/memory/own-legal-entity-repository';
import { applyOwnSignatory } from '../../src/agents/documents/own-signatory';
import { createToolContext } from '@business-ai/core';
import { fillTemplate } from '../../src/agents/documents/fill-template';
import { noteEmployeeMessage } from '../../src/agents/documents/employee-messages';
import { ownRequisitesFromRepository } from '../../src/agents/documents/own-requisites';
import { saveDocument } from '../../src/agents/documents/save-document';
import { type DocumentsDeps } from '../../src/agents/documents/deps';
import {
  ownEntityRequisiteLines,
  type OwnLegalEntityData,
} from '../../src/kit/domain/own-legal-entity';
import type { SignatoryInflector } from '../../src/kit/ports/signatory-inflector';
import { SYNTH_MASTER_GIFTS, SYNTH_PRAGMATIKA } from '../kit/support/own-entity-fixtures';
import { buildDocument, buildDocumentsDeps } from './support';

/**
 * Подстановка подписанта нашей стороны в договоры из записи БД: пять мест шаблона (ФИО полностью и
 * «Фамилия И.О.» / «И.О. Фамилия», родительный и именительный), женский подписант, совпадающая
 * запись, отказы (склонение, остаточный прежний подписант), флаг источника выключен. Данные
 * синтетические; прежний подписант в тестах вымышленный.
 */

const THREAD = 'documents/u-signatory';
const PR_TEMPLATE = 'Шаблон_ПР_Договора_на_поставку_готовой_продукции.docx';
const MG_TEMPLATE = '2026_МГ_Шаблон_Договора_на_поставку_контрактной_продукции.docx';
const NDA_TEMPLATE = 'МГ Соглашение NDA.docx';
const AT = '2026-11-10T10:00:00.000Z';
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes);

const NEW_PR: OwnLegalEntityData = { ...SYNTH_PRAGMATIKA, signatoryName: 'Пехтышева Виктория Юрьевна' };

interface Old {
  genFull: string;
  genShort: string;
  nomShort: string;
  reversed: string;
}
const OLD_PR: Old = {
  genFull: 'Зотова Ивана Петровича',
  genShort: 'Зотова И.П.',
  nomShort: 'Зотов И.П.',
  reversed: 'И.П. Зотов',
};

/** Договор: пять мест с подписантом нашей стороны, сторона поставщика - метки шаблона. */
function contract(entity: OwnLegalEntityData, old: Old, extra: string[] = []): string {
  return [
    `Договор. ${entity.shortName}, именуемое «Заказчик», в лице генерального директора ` +
      `${old.genFull}, действующего на основании Устава, и {{seller}}, в лице ` +
      '{{seller_position}} {{seller_representative}}.',
    'Заказчик:',
    entity.shortName,
    ...ownEntityRequisiteLines(entity).filter((line) => !line.startsWith('в ')),
    `в ${entity.bankName}`,
    `Генеральный директор\t${old.nomShort}\tМ.П.`,
    '',
    'Исполнитель:',
    '{{seller}}',
    `Приложение. Заказчик в лице генерального директора ${old.genShort}, действующего на ` +
      'основании Устава.',
    `Генеральный директор ______/${old.nomShort}`,
    `______/${old.reversed}`,
    ...extra,
  ].join('\n');
}

/** Склонение сервиса: просклоняет ФИО по таблице; `buggy` - как словарь с «Пехтышевы». */
function inflector(table: Record<string, string>): SignatoryInflector & { calls: number } {
  return {
    calls: 0,
    async signatoryGenitive(_position, fullName) {
      this.calls += 1;
      return table[fullName] ?? null;
    },
  };
}
const TABLE = {
  'Пехтышева Виктория Юрьевна': 'генерального директора Пехтышевой Виктории Юрьевны',
  'Петрова Анна Ивановна': 'генерального директора Петровой Анны Ивановны',
  'Иванов Пётр Сергеевич': 'генерального директора Иванова Петра Сергеевича',
};

interface World {
  deps: Awaited<ReturnType<typeof buildDocumentsDeps>>;
  repo: MemoryOwnLegalEntityRepository;
  host: DocumentsDeps;
  events: Array<{ event: string; fields: Record<string, unknown> }>;
}
let world: World;

const put = (path: string, text: string): void =>
  (world.deps.files as unknown as { put(p: string, c: Uint8Array, m: number): void }).put(
    path,
    encode(text),
    1,
  );
const template = (text: string) => ({ path: PR_TEMPLATE, content: encode(text) });
const ctx = () =>
  createToolContext({
    threadId: THREAD,
    agentId: 'documents',
    operationId: 'op-signatory',
    initiator: { kind: 'user', userId: 'u-signatory' },
  });

beforeEach(async () => {
  const deps = await buildDocumentsDeps();
  const repo = new MemoryOwnLegalEntityRepository();
  const events: World['events'] = [];
  world = {
    deps,
    repo,
    events,
    host: {
      ...deps,
      contractAmender: new MemoryContractAmender(),
      ownRequisites: ownRequisitesFromRepository(repo),
      ownEntities: repo,
      signatoryInflector: inflector(TABLE),
      log: (event, fields) => void events.push({ event, fields: fields ?? {} }),
    },
  };
  await world.repo.save('pragmatika', NEW_PR, { updatedBy: 't', at: AT });
  await world.repo.save('master_gifts', SYNTH_MASTER_GIFTS, { updatedBy: 't', at: AT });
  await noteEmployeeMessage(deps.state, THREAD, 'Собери договор');
});

describe('подстановка подписанта в пять мест шаблона', () => {
  test('все формы: родительный полностью и с инициалами, именительный обеих видов', async () => {
    const out = await applyOwnSignatory(world.host, template(contract(NEW_PR, OLD_PR)));
    const text = decode(out.content);
    expect(text).toContain('в лице генерального директора Пехтышевой Виктории Юрьевны, действующего');
    expect(text).toContain('Генеральный директор\tПехтышева В.Ю.\tМ.П.');
    expect(text).toContain('директора Пехтышевой В.Ю., действующего');
    expect(text).toContain('Генеральный директор ______/Пехтышева В.Ю.');
    expect(text).toContain('______/В.Ю. Пехтышева');
    expect(text).not.toContain('Зотов');
    // сторона поставщика и метки шаблона не тронуты
    expect(text).toContain('{{seller_representative}}');
    expect(world.events.find((e) => e.event === 'own_signatory_substituted')?.fields).toEqual({
      entity: 'pragmatika',
      found: 5,
      replaced: 5,
    });
    expect(JSON.stringify(world.events)).not.toContain('Пехтыш');
  });

  test('склонение сервиса «Пехтышевы» исправляется по женскому отчеству', async () => {
    world.host.signatoryInflector = inflector({
      'Пехтышева Виктория Юрьевна': 'генерального директора Пехтышевы Виктории Юрьевны',
    });
    const out = await applyOwnSignatory(world.host, template(contract(NEW_PR, OLD_PR)));
    expect(decode(out.content)).toContain('Пехтышевой Виктории Юрьевны, действующего');
    expect(decode(out.content)).not.toContain('Пехтышевы ');
  });

  test('мужской подписант и второе юрлицо (Мастер Гифтс): те же места', async () => {
    await world.repo.save(
      'master_gifts',
      { ...SYNTH_MASTER_GIFTS, signatoryName: 'Иванов Пётр Сергеевич' },
      { updatedBy: 't', at: AT },
    );
    const old: Old = {
      genFull: 'Сидорова Анна Павловна',
      genShort: 'Сидоровой А.П.',
      nomShort: 'Сидорова А.П.',
      reversed: 'А.П. Сидорова',
    };
    const out = await applyOwnSignatory(world.host, {
      path: MG_TEMPLATE,
      content: encode(contract(SYNTH_MASTER_GIFTS, old)),
    });
    const text = decode(out.content);
    expect(text).toContain('Иванова Петра Сергеевича, действующего');
    expect(text).toContain('Иванов П.С.');
    expect(text).toContain('П.С. Иванов');
    expect(text).not.toContain('Сидоров');
  });

  test('запись совпадает с напечатанным: замен нет, шаблон тот же', async () => {
    const same: Old = {
      genFull: 'Пехтышевой Виктории Юрьевны',
      genShort: 'Пехтышевой В.Ю.',
      nomShort: 'Пехтышева В.Ю.',
      reversed: 'В.Ю. Пехтышева',
    };
    const source = template(contract(NEW_PR, same));
    const out = await applyOwnSignatory(world.host, source);
    expect(out).toBe(source);
    expect(world.events.find((e) => e.event === 'own_signatory_substituted')?.fields).toMatchObject({
      replaced: 0,
    });
  });
});

describe('fail closed', () => {
  const refusal = (promise: Promise<unknown>) =>
    promise.then(
      () => undefined,
      (error: unknown) => error as Error & { code?: string },
    );

  test('склонение невозможно (сервис вернул null): отказ без значений', async () => {
    world.host.signatoryInflector = inflector({});
    const error = await refusal(applyOwnSignatory(world.host, template(contract(NEW_PR, OLD_PR))));
    expect(error?.code).toBe('conflict');
    expect(error?.message).not.toContain('Пехтыш');
    expect(world.events.find((e) => e.event === 'own_signatory_refused')?.fields).toEqual({
      entity: 'pragmatika',
      reason: 'inflection_uncertain',
    });
  });

  test('сервис склонения не подключён или ФИО не из трёх слов: отказ', async () => {
    delete world.host.signatoryInflector;
    expect(
      (await refusal(applyOwnSignatory(world.host, template(contract(NEW_PR, OLD_PR)))))?.code,
    ).toBe('conflict');
    world.host.signatoryInflector = inflector(TABLE);
    await world.repo.save('pragmatika', { ...NEW_PR, signatoryName: 'Пехтышева В. Ю.' }, {
      updatedBy: 't',
      at: AT,
    });
    expect(
      (await refusal(applyOwnSignatory(world.host, template(contract(NEW_PR, OLD_PR)))))?.code,
    ).toBe('conflict');
  });

  test('неожиданная форма фамилии у женского подписанта: отказ', async () => {
    world.host.signatoryInflector = inflector({
      'Пехтышева Виктория Юрьевна': 'генерального директора Пехтышевым Виктории Юрьевны',
    });
    expect(
      (await refusal(applyOwnSignatory(world.host, template(contract(NEW_PR, OLD_PR)))))?.code,
    ).toBe('conflict');
  });

  test('остался прежний подписант (в тексте вне якорей): отказ', async () => {
    const source = template(contract(NEW_PR, OLD_PR, ['Копия: Зотову И.П. направить уведомление.']));
    const error = await refusal(applyOwnSignatory(world.host, source));
    expect(error?.code).toBe('conflict');
    expect(error?.message).toContain('прежний подписант');
    expect(error?.message).not.toContain('Зотов');
  });

  test('в шаблоне нет подписанта: отказ; для NDA - пропуск с событием', async () => {
    const bare = template('Договор без подписанта.');
    expect((await refusal(applyOwnSignatory(world.host, bare)))?.code).toBe('conflict');
    const nda = { path: NDA_TEMPLATE, content: encode('Соглашение о неразглашении') };
    expect(await applyOwnSignatory(world.host, nda)).toBe(nda);
    expect(world.events.some((e) => e.event === 'own_signatory_not_found')).toBe(true);
  });

  test('в шаблоне названы разные люди: отказ', async () => {
    const source = template(contract(NEW_PR, OLD_PR, ['Директор Другов А.Б.']));
    expect((await refusal(applyOwnSignatory(world.host, source)))?.code).toBe('conflict');
  });
});

describe('флаг источника БД выключен и инструменты сборки', () => {
  test('без ownRequisites шаблон не меняется и сервисы не вызываются', async () => {
    const flagOff: DocumentsDeps = { ...world.host };
    delete flagOff.ownRequisites;
    const source = template(contract(NEW_PR, OLD_PR));
    expect(await applyOwnSignatory(flagOff, source)).toBe(source);
    expect((world.host.signatoryInflector as unknown as { calls: number }).calls).toBe(0);
    expect(world.events).toEqual([]);
  });

  test('не из реестра шаблонов: не меняется', async () => {
    const other = { path: 'Шаблон_КП.docx', content: encode(contract(NEW_PR, OLD_PR)) };
    expect(await applyOwnSignatory(world.host, other)).toBe(other);
  });

  test('fillTemplate и saveDocument отказывают, если подписант не подставляется', async () => {
    put(PR_TEMPLATE, contract(NEW_PR, OLD_PR));
    world.host.signatoryInflector = inflector({});
    const document = buildDocument();
    await expect(
      fillTemplate.execute({ templatePath: PR_TEMPLATE, document }, world.host, ctx()),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      saveDocument.execute({ templatePath: PR_TEMPLATE, document }, world.host, ctx()),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  test('fillTemplate собирает документ, когда подписант подставляется', async () => {
    put(PR_TEMPLATE, contract(NEW_PR, OLD_PR));
    const out = await fillTemplate.execute(
      { templatePath: PR_TEMPLATE, document: buildDocument() },
      world.host,
      ctx(),
    );
    expect(out.fileName).toBeTruthy();
    expect(world.events.some((e) => e.event === 'own_signatory_substituted')).toBe(true);
  });
});
