import { beforeEach, describe, expect, test } from 'bun:test';
import { MemoryContractAmender } from '../../src/kit/adapters/memory/contract-amender';
import {
  MemoryOwnLegalEntityRepository,
} from '../../src/kit/adapters/memory/own-legal-entity-repository';
import { amendCounterpartyContract } from '../../src/agents/documents/amend-counterparty-contract';
import {
  assertTemplateOwnSideMatches,
  ownRequisitesFromRepository,
  resolveOwnRequisites,
} from '../../src/agents/documents/own-requisites';
import { createToolContext } from '@business-ai/core';
import { fillTemplate } from '../../src/agents/documents/fill-template';
import { noteEmployeeMessage } from '../../src/agents/documents/employee-messages';
import { saveDocument } from '../../src/agents/documents/save-document';
import { type DocumentsDeps } from '../../src/agents/documents/deps';
import {
  ownEntityRequisiteLines,
  type OwnLegalEntityData,
} from '../../src/kit/domain/own-legal-entity';
import { SYNTH_MASTER_GIFTS, SYNTH_PRAGMATIKA } from '../kit/support/own-entity-fixtures';
import { buildDocument, buildDocumentsDeps } from './support';

/**
 * Этап 230: наши реквизиты для договоров берутся из записи БД юрлица. Нет записи - отказ
 * (fail closed), шаблонный текст не подставляется молча; печатный блок шаблона сверяется с записью.
 */

const THREAD = 'documents/u-own-db';
const MG_TEMPLATE = '2026_МГ_Шаблон_Договора_на_поставку_контрактной_продукции.docx';
const NDA_TEMPLATE = 'МГ Соглашение NDA.docx';
const PR_TEMPLATE = 'Шаблон_ПР_Договора_на_поставку_готовой_продукции.docx';
const OTHER_TEMPLATE = 'Шаблон_КП.docx';
const AT = '2026-11-08T10:00:00.000Z';
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes);

/** Блок «Заказчик» шаблона, напечатанный по записи (как в боевых шаблонах: текстом). */
function printedTemplate(entity: OwnLegalEntityData): string {
  return [
    'Заказчик:',
    entity.shortName,
    ...ownEntityRequisiteLines(entity).filter((line) => !line.startsWith('в ')),
    `в ${entity.bankName}`,
    '',
    'Исполнитель:',
    '{{seller}}',
  ].join('\n');
}

const CONTRACT = ['ДОГОВОР № 1/ТЕСТ-26 от 05.11.2026', 'Исполнитель:', 'ООО «Исп»', 'Заказчик:', ''].join(
  '\n',
);

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
      log: (event, fields) => void events.push({ event, fields: fields ?? {} }),
    },
  };
  // Печатный блок шаблонов совпадает с записями.
  put(MG_TEMPLATE, printedTemplate(SYNTH_MASTER_GIFTS));
  put(NDA_TEMPLATE, 'Соглашение о неразглашении');
  put(PR_TEMPLATE, printedTemplate(SYNTH_PRAGMATIKA));
  put(OTHER_TEMPLATE, 'Коммерческое предложение');
  await noteEmployeeMessage(deps.state, THREAD, 'Добавь реквизиты МГ, наш номер 17/10');
});

const ctx = () =>
  createToolContext({
    threadId: THREAD,
    agentId: 'documents',
    operationId: 'op-own-db',
    initiator: { kind: 'user', userId: 'u-own-db' },
  });

describe('источник наших реквизитов из БД', () => {
  test('forEntity отдаёт краткое наименование и строки реквизитов записи', async () => {
    await world.repo.save('master_gifts', SYNTH_MASTER_GIFTS, { updatedBy: 't', at: AT });
    const own = await ownRequisitesFromRepository(world.repo).forEntity('mg');
    expect(own?.name).toBe(SYNTH_MASTER_GIFTS.shortName);
    expect(own?.lines).toEqual(ownEntityRequisiteLines(SYNTH_MASTER_GIFTS));
  });

  test('нет записи юрлица - undefined, чужая запись не подставляется', async () => {
    await world.repo.save('pragmatika', SYNTH_PRAGMATIKA, { updatedBy: 't', at: AT });
    expect(await ownRequisitesFromRepository(world.repo).forEntity('mg')).toBeUndefined();
  });

  test('resolveOwnRequisites при источнике БД не читает шаблон', async () => {
    // В шаблоне напечатаны реквизиты МГ, но записи в БД нет: шаблонный текст не берётся.
    expect(await resolveOwnRequisites(world.host, 'mg')).toBeUndefined();
    await world.repo.save('master_gifts', SYNTH_MASTER_GIFTS, { updatedBy: 't', at: AT });
    expect((await resolveOwnRequisites(world.host, 'mg'))?.name).toBe(
      SYNTH_MASTER_GIFTS.shortName,
    );
  });
});

describe('amendCounterpartyContract берёт реквизиты из БД', () => {
  const files = (host: DocumentsDeps): DocumentsDeps => ({
    ...host,
    botFiles: { recent: () => [{ botId: 1, fileId: 1, name: 'Договор.docx' }], remember: () => undefined },
    attachments: {
      fetchAttachments: async () => ({
        attachments: [
          { name: 'Договор.docx', mime: 'application/octet-stream', bytes: encode(CONTRACT), source: 'bot' as const },
        ],
        errors: [],
      }),
    },
  });

  test('в договор попадают значения записи, а не печатный текст шаблона', async () => {
    // Запись отличается от шаблона (телефон): договор должен получить запись.
    await world.repo.save(
      'master_gifts',
      { ...SYNTH_MASTER_GIFTS, phone: '(900) 777-88-99' },
      { updatedBy: 't', at: AT },
    );
    const out = await amendCounterpartyContract.execute(
      { entity: 'mg' } as never,
      files(world.host),
      ctx(),
    );
    expect(out.status).toBe('sent');
    const sent = decode(world.deps.chat.outbox[0]?.file?.content);
    expect(sent).toContain('(900) 777-88-99');
    expect(sent).not.toContain(SYNTH_MASTER_GIFTS.phone);
    expect(sent).toContain(`ИНН ${SYNTH_MASTER_GIFTS.inn}`);
  });

  test('записи нет: отказ с понятным текстом, файл не отправлен, шаблон не подставлен', async () => {
    const out = await amendCounterpartyContract.execute(
      { entity: 'mg' } as never,
      files(world.host),
      ctx(),
    );
    expect(out.status).toBe('own_requisites_missing');
    expect(out.message).toContain('В базе нет записи');
    expect(out.message).toContain('Мастер Гифтс');
    expect(world.deps.chat.outbox).toHaveLength(0);
    expect(world.events.some((e) => e.event === 'own_requisites_not_filled')).toBe(true);
  });
});

describe('сверка печатного блока шаблона с записью', () => {
  const template = async (path: string) => ({
    path,
    content: encode(await Promise.resolve(decode(await world.deps.files.read(path)))),
  });

  test('совпадает - молча проходит', async () => {
    await world.repo.save('master_gifts', SYNTH_MASTER_GIFTS, { updatedBy: 't', at: AT });
    await assertTemplateOwnSideMatches(world.host, await template(MG_TEMPLATE));
    await world.repo.save('pragmatika', SYNTH_PRAGMATIKA, { updatedBy: 't', at: AT });
    await assertTemplateOwnSideMatches(world.host, await template(PR_TEMPLATE));
  });

  test('записи нет - отказ, шаблон не печатается молча', async () => {
    await expect(
      assertTemplateOwnSideMatches(world.host, await template(MG_TEMPLATE)),
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(world.events.some((e) => e.event === 'own_requisites_not_filled')).toBe(true);
  });

  test('расхождение: отказ с названиями полей, без значений', async () => {
    const changed: OwnLegalEntityData = {
      ...SYNTH_MASTER_GIFTS,
      bik: SYNTH_PRAGMATIKA.bik,
      settlementAccount: '40702810000000000000',
      correspondentAccount: '30101810000000000009',
    };
    await world.repo.save('master_gifts', changed, { updatedBy: 't', at: AT });
    const error = await assertTemplateOwnSideMatches(world.host, await template(MG_TEMPLATE)).then(
      () => undefined,
      (e: unknown) => e as Error & { code?: string },
    );
    expect(error?.code).toBe('conflict');
    expect(error?.message).toContain('БИК');
    for (const secret of [changed.bik, SYNTH_MASTER_GIFTS.bik, changed.settlementAccount]) {
      expect(error?.message).not.toContain(secret);
    }
    const logged = world.events.find((e) => e.event === 'own_requisites_template_mismatch');
    expect(String(logged?.fields['fields'])).toContain('bik');
    expect(JSON.stringify(logged)).not.toContain(SYNTH_MASTER_GIFTS.bik);
  });

  test('лишнее число в шаблоне (убранный из записи ОГРН) тоже расхождение', async () => {
    await world.repo.save('master_gifts', SYNTH_MASTER_GIFTS, { updatedBy: 't', at: AT });
    const printed = decode(await world.deps.files.read(MG_TEMPLATE)).replace(
      'Р/счет',
      'ОГРН 1027700132195\nР/счет',
    );
    await expect(
      assertTemplateOwnSideMatches(world.host, { path: MG_TEMPLATE, content: encode(printed) }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  test('NDA: только наличие записи; не из реестра и без источника БД - не проверяется', async () => {
    await expect(
      assertTemplateOwnSideMatches(world.host, await template(NDA_TEMPLATE)),
    ).rejects.toMatchObject({ code: 'not_found' });
    await world.repo.save('master_gifts', SYNTH_MASTER_GIFTS, { updatedBy: 't', at: AT });
    await assertTemplateOwnSideMatches(world.host, await template(NDA_TEMPLATE));
    await assertTemplateOwnSideMatches(world.host, await template(OTHER_TEMPLATE));
    const flagOff: DocumentsDeps = { ...world.host };
    delete flagOff.ownRequisites;
    await assertTemplateOwnSideMatches(flagOff, await template(PR_TEMPLATE));
  });

  test('fillTemplate и saveDocument отказывают при расхождении', async () => {
    await world.repo.save(
      'master_gifts',
      { ...SYNTH_MASTER_GIFTS, legalAddress: '300001, г. Новый, ул. Другая, д. 9' },
      { updatedBy: 't', at: AT },
    );
    const document = buildDocument();
    await expect(
      fillTemplate.execute({ templatePath: MG_TEMPLATE, document }, world.host, ctx()),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      saveDocument.execute({ templatePath: MG_TEMPLATE, document }, world.host, ctx()),
    ).rejects.toMatchObject({ code: 'conflict' });
    // Без источника БД (флаг выключен) сборка идёт как раньше.
    const flagOff: DocumentsDeps = { ...world.host };
    delete flagOff.ownRequisites;
    const out = await fillTemplate.execute({ templatePath: MG_TEMPLATE, document }, flagOff, ctx());
    expect(out.fileName).toBeTruthy();
  });
});
