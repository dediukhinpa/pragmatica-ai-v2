import { beforeEach, describe, expect, test } from 'bun:test';
import { MemoryContractAmender } from '../../src/kit/adapters/memory/contract-amender';
import {
  MemoryOwnLegalEntityRepository,
} from '../../src/kit/adapters/memory/own-legal-entity-repository';
import {
  OWN_SIGNATORY_NAME_KEY,
  OWN_SIGNATORY_POSITION_KEY,
  applyOwnSignatory,
  ownSignatoryOverrideOf,
} from '../../src/agents/documents/own-signatory';
import { isEmployeeFieldKey } from '../../src/agents/documents/template-fields';
import { noteEmployeeMessage } from '../../src/agents/documents/employee-messages';
import { ownRequisitesFromRepository } from '../../src/agents/documents/own-requisites';
import { type DocumentsDeps } from '../../src/agents/documents/deps';
import {
  ownEntityRequisiteLines,
  type OwnLegalEntityData,
} from '../../src/kit/domain/own-legal-entity';
import type { SignatoryInflector } from '../../src/kit/ports/signatory-inflector';
import { SYNTH_MASTER_GIFTS, SYNTH_PRAGMATIKA } from '../kit/support/own-entity-fixtures';
import { buildDocumentsDeps } from '../agents/support';

/**
 * Подписант НАШЕЙ стороны «только в этом договоре» (этап 8y): команда «замени директора <наше
 * юрлицо> на <ФИО>» меняет подписанта в собираемом документе, запись `own_legal_entities` остаётся
 * прежней. Данные синтетические, ФИО вымышленные.
 */

const THREAD = 'documents/u-override';
const PR_TEMPLATE = 'Шаблон_ПР_Договора_на_поставку_готовой_продукции.docx';
const AT = '2026-11-10T10:00:00.000Z';
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes);

/** Запись юрлица: прежний директор в базе; сотрудник просит заменить его в одном договоре. */
const RECORD_PR: OwnLegalEntityData = {
  ...SYNTH_PRAGMATIKA,
  signatoryName: 'Зотов Иван Петрович',
};
const NEW_NAME = 'Пехтышева Виктория Юрьевна';

function contract(entity: OwnLegalEntityData): string {
  return [
    `Договор. ${entity.shortName}, именуемое «Заказчик», в лице генерального директора ` +
      'Зотова Ивана Петровича, действующего на основании Устава, и {{seller}}.',
    'Заказчик:',
    entity.shortName,
    ...ownEntityRequisiteLines(entity).filter((line) => !line.startsWith('в ')),
    `в ${entity.bankName}`,
    'Генеральный директор\tЗотов И.П.\tМ.П.',
    'Приложение. Заказчик в лице генерального директора Зотова И.П., действующего на основании.',
    'Генеральный директор ______/Зотов И.П.',
    '______/И.П. Зотов',
  ].join('\n');
}

const TABLE: Record<string, string> = {
  [NEW_NAME]: 'генерального директора Пехтышевой Виктории Юрьевны',
  'Зотов Иван Петрович': 'генерального директора Зотова Ивана Петровича',
};

interface World {
  repo: MemoryOwnLegalEntityRepository;
  host: DocumentsDeps;
  positions: string[];
  events: Array<{ event: string; fields: Record<string, unknown> }>;
}
let world: World;

const template = () => ({ path: PR_TEMPLATE, content: encode(contract(RECORD_PR)) });
const withOverride = (name: string, position?: string) => ({
  templateFields: {
    [OWN_SIGNATORY_NAME_KEY]: name,
    ...(position === undefined ? {} : { [OWN_SIGNATORY_POSITION_KEY]: position }),
  },
});

beforeEach(async () => {
  const deps = await buildDocumentsDeps();
  const repo = new MemoryOwnLegalEntityRepository();
  const positions: string[] = [];
  const events: World['events'] = [];
  const inflector: SignatoryInflector = {
    async signatoryGenitive(position, fullName) {
      positions.push(position);
      return TABLE[fullName] ?? null;
    },
  };
  world = {
    repo,
    positions,
    events,
    host: {
      ...deps,
      contractAmender: new MemoryContractAmender(),
      ownRequisites: ownRequisitesFromRepository(repo),
      ownEntities: repo,
      signatoryInflector: inflector,
      log: (event, fields) => void events.push({ event, fields: fields ?? {} }),
    },
  };
  await repo.save('pragmatika', RECORD_PR, { updatedBy: 't', at: AT });
  await repo.save('master_gifts', SYNTH_MASTER_GIFTS, { updatedBy: 't', at: AT });
  await noteEmployeeMessage(deps.state, THREAD, 'Замени директора Прагматики');
});

describe('подписант нашей стороны только в этом договоре', () => {
  test('названный ФИО подставляется во все пять мест, запись юрлица не меняется', async () => {
    const out = await applyOwnSignatory(world.host, template(), undefined, withOverride(NEW_NAME));
    const text = decode(out.content);
    expect(text).toContain(
      'в лице генерального директора Пехтышевой Виктории Юрьевны, действующего',
    );
    expect(text).toContain('Пехтышева В.Ю.');
    expect(text).toContain('В.Ю. Пехтышева');
    expect(text).not.toContain('Зотов');
    // постоянная смена только по явной просьбе: в базе прежний подписант
    expect((await world.repo.get('pragmatika'))?.signatoryName).toBe('Зотов Иван Петрович');
    expect(world.events.some((e) => e.event === 'own_signatory_override')).toBe(true);
    expect(JSON.stringify(world.events)).not.toContain('Пехтыш');
  });

  test('должность из слов сотрудника уходит в склонение, иначе берётся из записи', async () => {
    await applyOwnSignatory(
      world.host,
      template(),
      undefined,
      withOverride(NEW_NAME, 'директора по развитию'),
    );
    expect(world.positions.at(-1)).toBe('директора по развитию');
    await applyOwnSignatory(world.host, template(), undefined, withOverride(NEW_NAME));
    expect(world.positions.at(-1)).toBe(RECORD_PR.signatoryPosition);
  });

  test('без названного подписанта поведение прежнее: подставляется запись юрлица', async () => {
    const out = await applyOwnSignatory(world.host, template());
    expect(decode(out.content)).toContain('Зотов');
    expect(world.events.some((e) => e.event === 'own_signatory_override')).toBe(false);
  });

  test('ФИО не из трёх слов: отказ без значений, документ не собирается', async () => {
    const error = await applyOwnSignatory(
      world.host,
      template(),
      undefined,
      withOverride('Пехтышева В.Ю.'),
    ).then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );
    expect(error?.message).toContain('не подставлен');
    expect(error?.message).not.toContain('Пехтыш');
  });

  test('склонение не удалось: отказ, прежний подписант молча не остаётся', async () => {
    const error = await applyOwnSignatory(
      world.host,
      template(),
      undefined,
      withOverride('Кузнецов Пётр Сергеевич'),
    ).then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );
    expect(error).toBeDefined();
  });

  test('источник наших реквизитов выключен: названный подписант не теряется молча', async () => {
    const { ownRequisites: _o, ownEntities: _e, ...rest } = world.host;
    const error = await applyOwnSignatory(
      rest as DocumentsDeps,
      template(),
      undefined,
      withOverride(NEW_NAME),
    ).then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );
    expect(error?.message).toContain('не заменён');
  });

  test('ключи принимаются как поля сотрудника и читаются из документа', () => {
    expect(isEmployeeFieldKey(OWN_SIGNATORY_NAME_KEY)).toBe(true);
    expect(isEmployeeFieldKey(OWN_SIGNATORY_POSITION_KEY)).toBe(true);
    expect(ownSignatoryOverrideOf(withOverride(`  ${NEW_NAME} `, ' директор '))).toEqual({
      name: NEW_NAME,
      position: 'директор',
    });
    expect(ownSignatoryOverrideOf({ templateFields: { [OWN_SIGNATORY_NAME_KEY]: ' ' } })).toBe(
      undefined,
    );
    expect(ownSignatoryOverrideOf(undefined)).toBe(undefined);
  });
});
