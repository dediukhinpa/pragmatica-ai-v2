import { beforeEach, describe, expect, test } from 'bun:test';
import { MemoryContractAmender } from '../../src/kit/adapters/memory/contract-amender';
import { amendCounterpartyContract } from '../../src/agents/documents/amend-counterparty-contract';
import { noteEmployeeMessage } from '../../src/agents/documents/employee-messages';
import { type DocumentsDeps } from '../../src/agents/documents/deps';
import { noteAttachmentText } from '../../src/agents/suppliers/document-source-text';
import { createToolContext } from '@business-ai/core';
import type {
  AmendContractRequest,
  AmendedContract,
  ContractAmender,
} from '../../src/kit/ports/contract-amender';
import { buildDocumentsDeps } from '../agents/support';

/**
 * Дополнение присланного договора (этап 8y): допись и замена номера по просьбе, реквизиты из
 * присланного файла с проверкой источника, перечисление ненайденного. Данные синтетические.
 */

const THREAD = 'documents/u-amend-8y';
const MG_TEMPLATE = '2026_МГ_Шаблон_Договора_на_поставку_контрактной_продукции.docx';
const CONTRACT = ['ДОГОВОР № 103/11-26 от 05.11.2026', 'Исполнитель:', '', 'Заказчик:', ''].join(
  '\n',
);
const FILE_LINES = ['ООО «Поставка-Тест»', 'ИНН 7701001238 КПП 770101001'];
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

interface World {
  deps: Awaited<ReturnType<typeof buildDocumentsDeps>>;
  requests: AmendContractRequest[];
  host: DocumentsDeps;
}

let world: World;

/** Заглушка сервиса: запоминает запрос и отвечает так, как отвечает сервис по контракту 8y. */
function recordingAmender(requests: AmendContractRequest[], reply: Partial<AmendedContract>) {
  const base = new MemoryContractAmender();
  const amender: ContractAmender = {
    // Вид договора решает сервис; здесь он всегда отвечает «договор поставщика».
    classify: async () => ({ verdict: 'supplier', reasons: [], convertedFrom: null }),
    readPartyBlock: (request) => base.readPartyBlock(request),
    replaceSignatory: (request) => base.replaceSignatory(request),
    amend: async (request) => {
      requests.push(request);
      return {
        fileName: request.fileName,
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        bytes: request.bytes,
        convertedFrom: null,
        preambleFilled: false,
        customerBlockFilled: false,
        placeholdersFilled: 0,
        linesAdded: 0,
        unfilledPlaceholders: 0,
        notes: [],
        ...reply,
      };
    },
  };
  return amender;
}

function withFile(host: DocumentsDeps): DocumentsDeps {
  return {
    ...host,
    botFiles: {
      recent: () => [{ botId: 1, fileId: 1, name: 'Договор.docx' }],
      remember: () => undefined,
    },
    attachments: {
      fetchAttachments: async () => ({
        attachments: [
          {
            name: 'Договор.docx',
            mime: 'application/octet-stream',
            bytes: encode(CONTRACT),
            source: 'bot' as const,
          },
        ],
        errors: [],
      }),
    },
  };
}

async function setup(reply: Partial<AmendedContract>, said: string): Promise<void> {
  const deps = await buildDocumentsDeps();
  (deps.files as unknown as { put(p: string, c: Uint8Array, m: number): void }).put(
    MG_TEMPLATE,
    encode('Заказчик:\nООО «Ромашка-Тест»\nИНН 7701001238 КПП 770101001\n\nИсполнитель:\n'),
    1,
  );
  const requests: AmendContractRequest[] = [];
  world = {
    deps,
    requests,
    host: withFile({ ...deps, contractAmender: recordingAmender(requests, reply) }),
  };
  await noteEmployeeMessage(deps.state, THREAD, said);
}

const ctx = () =>
  createToolContext({
    threadId: THREAD,
    agentId: 'documents',
    operationId: 'op-amend-8y',
    turnNumber: 1,
    initiator: { kind: 'user', userId: 'u-amend-8y' },
  });

const run = (input: Record<string, unknown>) =>
  amendCounterpartyContract.execute(
    amendCounterpartyContract.inputSchema.parse(input) as never,
    world.host,
    ctx(),
  );

describe('amendCounterpartyContract: номер по просьбе (этап 8y)', () => {
  beforeEach(async () => {
    await setup(
      { numberStatus: 'appended', numberBefore: '103/11-26', numberAfter: '103/11-26 / 17/10' },
      'Добавь 17/10 к номеру договора, только номер, реквизиты не надо',
    );
  });

  test('допись к номеру уходит в сервис как append, а не как замена', async () => {
    const out = await run({ numberOnly: true, numberEdit: { mode: 'append', text: '17/10' } });
    expect(out.status).toBe('sent');
    expect(world.requests[0]?.numberEdit).toEqual({ mode: 'append', text: '17/10' });
    expect(world.requests[0]?.own).toBeUndefined();
    expect(out.numberStatus).toBe('appended');
    expect(out.message).toContain('103/11-26 / 17/10');
    expect(out.message).not.toContain('Номер договора не менялся');
  });

  test('номера, которого сотрудник не называл, код не принимает', async () => {
    const out = await run({ numberOnly: true, numberEdit: { mode: 'append', text: '99/99' } });
    expect(out.status).toBe('number_not_confirmed');
    expect(world.requests).toHaveLength(0);
  });

  test('numberOnly без numberEdit - нечего править', async () => {
    const out = await run({ numberOnly: true });
    expect(out.status).toBe('nothing_requested');
    expect(world.requests).toHaveLength(0);
  });
});

describe('amendCounterpartyContract: номер без просьбы не меняется', () => {
  test('обычное дополнение не шлёт правку номера и говорит, что номер не менялся', async () => {
    await setup({ customerBlockFilled: true }, 'Впиши реквизиты МГ в договор поставщика');
    const out = await run({ entity: 'mg' });
    expect(out.status).toBe('sent');
    expect(world.requests[0]?.numberEdit).toBeUndefined();
    expect(out.message).toContain('Номер договора не менялся');
  });
});

describe('amendCounterpartyContract: реквизиты из присланного файла', () => {
  beforeEach(async () => {
    await setup(
      { partyBlockFilled: true, party: 'executor', notFound: ['signature_line'] },
      'Впиши реквизиты поставщика из файла в его договор',
    );
    await noteAttachmentText(world.deps.state, THREAD, [FILE_LINES.join('\n')]);
  });

  test('строки из файла вписываются в блок исполнителя, ненайденное названо', async () => {
    const out = await run({
      party: 'executor',
      requisites: { name: FILE_LINES[0], lines: FILE_LINES },
    });
    expect(out.status).toBe('sent');
    expect(world.requests[0]?.party).toBe('executor');
    expect(world.requests[0]?.own?.name).toBe(FILE_LINES[0]);
    expect(out.message).toContain('исполнителя');
    expect(out.message).toContain('строка подписи');
  });

  test('выдуманные реквизиты (нет ни в файле, ни в словах сотрудника) не принимаются', async () => {
    const out = await run({
      party: 'executor',
      requisites: { name: 'ООО «Выдумка»', lines: ['ИНН 9999999999'] },
    });
    expect(out.status).toBe('requisites_not_grounded');
    expect(world.requests).toHaveLength(0);
  });

  test('без источника (файл не читали) присланные реквизиты тоже не принимаются', async () => {
    await setup({ partyBlockFilled: true }, 'Впиши реквизиты поставщика из файла');
    const out = await run({
      party: 'executor',
      requisites: { name: FILE_LINES[0], lines: FILE_LINES },
    });
    expect(out.status).toBe('requisites_not_grounded');
  });
});

describe('MemoryContractAmender: правка номера как в сервисе (этап 8y)', () => {
  const amender = new MemoryContractAmender();
  const edit = async (
    numberEdit: NonNullable<AmendContractRequest['numberEdit']>,
    text = CONTRACT,
  ) => {
    const out = await amender.amend({
      fileName: 'Договор.docx',
      bytes: encode(text),
      numberEdit,
    });
    return { out, text: new TextDecoder().decode(out.bytes) };
  };

  test('append: номер остаётся, допись после него', async () => {
    const { out, text } = await edit({ mode: 'append', text: '17/10' });
    expect(out.numberStatus).toBe('appended');
    expect(text).toContain('№ 103/11-26 / 17/10 от 05.11.2026');
  });

  test('повтор той же дописи номер не дублирует', async () => {
    const first = await edit({ mode: 'append', text: '17/10' });
    const again = await edit({ mode: 'append', text: '17/10' }, first.text);
    expect(again.out.numberStatus).toBe('unchanged');
    expect(again.text).toBe(first.text);
  });

  test('replace: номер заменяется целиком', async () => {
    const { out, text } = await edit({ mode: 'replace', text: '1535/10' });
    expect(out.numberStatus).toBe('replaced');
    expect(text).toContain('№ 1535/10 от 05.11.2026');
    expect(text).not.toContain('103/11-26');
  });

  test('номера в документе нет: not_found, текст не тронут', async () => {
    const { out, text } = await edit({ mode: 'append', text: '17/10' }, 'Договор без номера');
    expect(out.numberStatus).toBe('not_found');
    expect(out.notFound).toContain('number');
    expect(text).toBe('Договор без номера');
  });
});
