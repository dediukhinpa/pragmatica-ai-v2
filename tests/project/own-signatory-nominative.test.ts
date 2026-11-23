import { beforeEach, describe, expect, test } from 'bun:test';
import { MemoryContractAmender } from '../../src/kit/adapters/memory/contract-amender';
import {
  MemoryOwnLegalEntityRepository,
} from '../../src/kit/adapters/memory/own-legal-entity-repository';
import {
  OWN_SIGNATORY_NAME_KEY,
  applyOwnSignatory,
  ownSignatoryForms,
} from '../../src/agents/documents/own-signatory';
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
 * Подписант нашей стороны назван в косвенном падеже («замени генерального директора на Смирнову
 * Елену Викторовну»): сервис склонения на такое отвечает `null`, код приводит ФИО к именительному
 * падежу и проверяет результат сервисом. Сервис подменён словарём, сети нет; ФИО вымышленные.
 */

const PR_TEMPLATE = 'Шаблон_ПР_Договора_на_поставку_готовой_продукции.docx';
const AT = '2026-11-10T10:00:00.000Z';
const POSITION = 'генеральный директор';
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes);

const RECORD_PR: OwnLegalEntityData = {
  ...SYNTH_PRAGMATIKA,
  signatoryName: 'Зотов Иван Петрович',
};

/** Словарь сервиса: только именительный падеж, как у настоящего сервиса. */
const DICTIONARY: Record<string, string> = {
  'Зотов Иван Петрович': 'генерального директора Зотова Ивана Петровича',
  'Смирнова Елена Викторовна': 'генерального директора Смирновой Елены Викторовны',
  'Смирнов Иван Петрович': 'генерального директора Смирнова Ивана Петровича',
  'Шевчук Елена Викторовна': 'генерального директора Шевчук Елены Викторовны',
  'Ткаченко Иван Петрович': 'генерального директора Ткаченко Ивана Петровича',
};

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

interface World {
  host: DocumentsDeps;
  asked: string[];
  events: Array<{ event: string; fields: Record<string, unknown> }>;
}
let world: World;

const template = () => ({ path: PR_TEMPLATE, content: encode(contract(RECORD_PR)) });
const withOverride = (name: string) => ({ templateFields: { [OWN_SIGNATORY_NAME_KEY]: name } });

beforeEach(async () => {
  const deps = await buildDocumentsDeps();
  const repo = new MemoryOwnLegalEntityRepository();
  const asked: string[] = [];
  const events: World['events'] = [];
  const inflector: SignatoryInflector = {
    async signatoryGenitive(_position, fullName) {
      asked.push(fullName);
      return DICTIONARY[fullName] ?? null;
    },
  };
  world = {
    asked,
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
});

const refusalOf = (promise: Promise<unknown>): Promise<Error | undefined> =>
  promise.then(
    () => undefined,
    (caught: unknown) => caught as Error,
  );

describe('ФИО подписанта в косвенном падеже', () => {
  test('винительный: «Смирнову Елену Викторовну» подставляется формами именительного', async () => {
    const out = await applyOwnSignatory(
      world.host,
      template(),
      undefined,
      withOverride('Смирнову Елену Викторовну'),
    );
    const text = decode(out.content);
    expect(text).toContain(
      'в лице генерального директора Смирновой Елены Викторовны, действующего',
    );
    expect(text).toContain('Смирнова Е.В.');
    expect(text).toContain('Е.В. Смирнова');
    expect(text).not.toContain('Зотов');
    expect(world.events.some((e) => e.event === 'own_signatory_refused')).toBe(false);
    expect(JSON.stringify(world.events)).not.toContain('Смирнов');
  });

  test('сначала сервису уходит названное ФИО, потом именительный вариант', async () => {
    await applyOwnSignatory(
      world.host,
      template(),
      undefined,
      withOverride('Смирнову Елену Викторовну'),
    );
    expect(world.asked).toEqual(['Смирнову Елену Викторовну', 'Смирнова Елена Викторовна']);
  });

  test('именительный падеж работает как раньше: одно обращение к сервису', async () => {
    await applyOwnSignatory(
      world.host,
      template(),
      undefined,
      withOverride('Смирнова Елена Викторовна'),
    );
    expect(world.asked).toEqual(['Смирнова Елена Викторовна']);
  });

  test('дательный женский: сервис знает только Елену - подставляется', async () => {
    const out = await applyOwnSignatory(
      world.host,
      template(),
      undefined,
      withOverride('Смирновой Елене Викторовне'),
    );
    expect(decode(out.content)).toContain('Смирнова Е.В.');
  });

  test('мужской подписант в дательном падеже', async () => {
    const out = await applyOwnSignatory(
      world.host,
      template(),
      undefined,
      withOverride('Смирнову Ивану Петровичу'),
    );
    const text = decode(out.content);
    expect(text).toContain('Смирнова Ивана Петровича');
    expect(text).toContain('Смирнов И.П.');
  });

  test('несклоняемые фамилии: Шевчук (она) и Ткаченко (он)', async () => {
    const woman = await applyOwnSignatory(
      world.host,
      template(),
      undefined,
      withOverride('Шевчук Елену Викторовну'),
    );
    expect(decode(woman.content)).toContain('Шевчук Е.В.');
    const man = await applyOwnSignatory(
      world.host,
      template(),
      undefined,
      withOverride('Ткаченко Ивана Петровича'),
    );
    expect(decode(man.content)).toContain('Ткаченко И.П.');
  });

  test('сомнительное ФИО - прежний отказ без значений в тексте и журнале', async () => {
    for (const name of [
      'Смирнову Елена Викторовна',
      'Кравца Ивана Петровича',
      'Неизвестную Елену Викторовну',
    ]) {
      const error = await refusalOf(
        applyOwnSignatory(world.host, template(), undefined, withOverride(name)),
      );
      expect(error?.message).toContain('не подставлен');
      expect(error?.message).not.toContain('Смирнов');
    }
    const refusals = world.events.filter((e) => e.event === 'own_signatory_refused');
    expect(refusals.map((e) => e.fields['reason'])).toEqual([
      'inflection_uncertain',
      'inflection_uncertain',
      'inflection_uncertain',
    ]);
  });

  test('ФИО из записи в косвенном падеже: формы строятся от именительного', async () => {
    const built = await ownSignatoryForms(
      world.host,
      { signatoryName: 'Смирнову Елену Викторовну', signatoryPosition: POSITION },
      () => false,
    );
    expect('forms' in built && built.forms).toEqual({
      nominativeShort: 'Смирнова Е.В.',
      nominativeReversed: 'Е.В. Смирнова',
      genitiveFull: 'Смирновой Елены Викторовны',
      genitiveShort: 'Смирновой Е.В.',
    });
  });

  test('сбой сервиса на проверочном вызове: отказ inflector_failed', async () => {
    let calls = 0;
    const flaky: SignatoryInflector = {
      async signatoryGenitive() {
        calls += 1;
        if (calls > 1) throw new Error('недоступен');
        return null;
      },
    };
    const built = await ownSignatoryForms(
      { ...world.host, signatoryInflector: flaky },
      { signatoryName: 'Смирнову Елену Викторовну', signatoryPosition: POSITION },
      () => false,
    );
    expect(built).toEqual({ reason: 'inflector_failed' });
  });
});
