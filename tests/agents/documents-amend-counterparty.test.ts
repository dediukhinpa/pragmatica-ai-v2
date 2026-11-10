import { beforeEach, describe, expect, test } from 'bun:test';
import {
  MEMORY_OWN_DOCUMENT_MARKER,
  MemoryContractAmender,
} from '../../src/kit/adapters/memory/contract-amender';
import { ServiceError } from '@business-ai/adapters';
import {
  CONTRACT_KIND_REQUEST_NAMESPACE,
  parseKindReply,
  type KindReply,
} from '../../src/agents/documents/contract-kind';
import { COUNTERPARTY_AMEND_PROMPT, buildDocumentsPrompt } from '../../src/agents/documents/prompt';
import { amendCounterpartyContract } from '../../src/agents/documents/amend-counterparty-contract';
import { createDocumentsAgent } from '../../src/agents/documents/declaration';
import { createToolContext } from '@business-ai/core';
import { noteEmployeeMessage } from '../../src/agents/documents/employee-messages';
import { resolveOwnRequisites } from '../../src/agents/documents/own-requisites';
import { type DocumentsDeps } from '../../src/agents/documents/deps';
import { CancelledError } from '@business-ai/core';
import { ContractAmendRefusedError } from '../../src/kit/domain/errors.owned';
import type { ContractAmender } from '../../src/kit/ports/contract-amender';
import type { OwnRequisitesSource } from '../../src/kit/ports/own-requisites';
import { buildDocumentsDeps } from './support';

/**
 * Агент «Подготовка документов»: дополнение присланного договора исполнителя (этапы 227, 232).
 * Номер договора поставщика не меняется никогда; «договор поставщика» определяет код, а не
 * модель. «Договор» в заглушке - текст построчно; настоящая правка docx, конвертация .doc/RTF и
 * сверка текста - в сервисе документов.
 */

const THREAD = 'documents/u-amend';
const MG_TEMPLATE = '2026_МГ_Шаблон_Договора_на_поставку_контрактной_продукции.docx';
const OUR_NAME = 'ООО «Ромашка-Тест»';
const OUR_INN_LINE = 'ИНН 7701001238 КПП 770101001';
const TEMPLATE_TEXT = [
  'Заказчик:',
  OUR_NAME,
  OUR_INN_LINE,
  'Р/счет 40702810712345678901',
  '',
  'Исполнитель:',
  '{{seller}}',
].join('\n');
const EXECUTOR_NAME = 'ООО «Исполнитель-Тест»';
const EXECUTOR_INN = 'ИНН 1111111111 КПП 222222222';
const CONTRACT_TITLE = 'ДОГОВОР № 1/ТЕСТ-26 от 05.11.2026';
const CONTRACT = [
  CONTRACT_TITLE,
  'Исполнитель:',
  EXECUTOR_NAME,
  EXECUTOR_INN,
  'Заказчик:',
  '',
].join('\n');
/** Договор, у которого сторона исполнителя не заполнена. */
const EMPTY_EXECUTOR_CONTRACT = [CONTRACT_TITLE, 'Исполнитель:', '', 'Заказчик:', ''].join('\n');
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes);

interface World {
  deps: Awaited<ReturnType<typeof buildDocumentsDeps>>;
  host: DocumentsDeps;
}

let world: World;

/** Файлы в чате: имя и содержимое «присланного» файла. */
function withChatFiles(host: DocumentsDeps, files: Array<{ name: string; text: string }>) {
  return {
    ...host,
    botFiles: {
      recent: () => files.map((file, index) => ({ botId: 1, fileId: index + 1, name: file.name })),
      remember: () => undefined,
    },
    attachments: {
      fetchAttachments: async () => ({
        attachments: files.map((file) => ({
          name: file.name,
          mime: 'application/octet-stream',
          bytes: encode(file.text),
          source: 'bot' as const,
        })),
        errors: [],
      }),
    },
  } satisfies DocumentsDeps;
}

beforeEach(async () => {
  const deps = await buildDocumentsDeps();
  (deps.files as unknown as { put(p: string, c: Uint8Array, m: number): void }).put(
    MG_TEMPLATE,
    encode(TEMPLATE_TEXT),
    1,
  );
  world = { deps, host: { ...deps, contractAmender: new MemoryContractAmender() } };
  await noteEmployeeMessage(
    deps.state,
    THREAD,
    'Добавь реквизиты МГ в договор поставщика, номер договора оставь как есть',
  );
});

/** Контекст реплики сотрудника `turn` в треде (по умолчанию первая). */
const ctx = (turn = 1, thread = THREAD) =>
  createToolContext({
    threadId: thread,
    agentId: 'documents',
    operationId: `op-amend-${turn}`,
    turnNumber: turn,
    initiator: { kind: 'user', userId: 'u-amend' },
  });

const sentText = (): string => decode(world.deps.chat.outbox[0]?.file?.content);

describe('amendCounterpartyContract: дополнение присланного договора', () => {
  test('реквизиты исполнителя и его номер на месте, наши добавлены, файл ушёл в чат', async () => {
    const host = withChatFiles(world.host, [{ name: 'Договор.docx', text: CONTRACT }]);
    const out = await amendCounterpartyContract.execute({ entity: 'mg' } as never, host, ctx());
    expect(out.status).toBe('sent');
    expect(out.customerBlockFilled).toBe(true);
    const text = sentText();
    // Данные исполнителя и его номер не тронуты: заголовок побайтно тот же.
    expect(text).toContain(EXECUTOR_NAME);
    expect(text).toContain(EXECUTOR_INN);
    expect(text.split('\n')[0]).toBe(CONTRACT_TITLE);
    // Наши реквизиты (из блока «Заказчик» шаблона) вписаны под заголовком заказчика.
    expect(text).toContain(`Заказчик:\n${OUR_NAME}\n${OUR_INN_LINE}`);
    expect(world.deps.chat.outbox).toHaveLength(1);
    expect(out.message).toContain('ожидает проверки');
    expect(out.message).toContain('Номер договора не менялся');
  });

  test('номера в контракте инструмента нет: ourNumber из старого вызова срезается', () => {
    const parsed = amendCounterpartyContract.inputSchema.parse({
      entity: 'mg',
      ourNumber: '17/10',
      addOwnRequisites: false,
    });
    expect(Object.keys(parsed as object).sort()).toEqual(['entity', 'ourRole']);
  });

  test('сотрудник просит «добавить наш номер»: номер в файл не попадает', async () => {
    await noteEmployeeMessage(world.deps.state, THREAD, 'и допиши наш номер 17/10 к номеру');
    const host = withChatFiles(world.host, [{ name: 'Договор.docx', text: CONTRACT }]);
    const out = await amendCounterpartyContract.execute(
      { entity: 'mg', ourNumber: '17/10' } as never,
      host,
      ctx(),
    );
    expect(out.status).toBe('sent');
    expect(sentText()).not.toContain('17/10');
    expect(sentText().split('\n')[0]).toBe(CONTRACT_TITLE);
  });

  test('блок заказчика уже заполнен: отказ с причиной, файл не отправлен', async () => {
    const filled = CONTRACT.replace('Заказчик:\n', 'Заказчик:\nООО «Чужой»');
    const host = withChatFiles(world.host, [{ name: 'Договор.docx', text: filled }]);
    const out = await amendCounterpartyContract.execute({ entity: 'mg' } as never, host, ctx());
    expect(out.status).toBe('refused');
    expect(out.reason).toBe('customer_block_filled');
    expect(world.deps.chat.outbox).toHaveLength(0);
  });

  test('нет файла, не договор, несколько договоров', async () => {
    const none = await amendCounterpartyContract.execute(
      { entity: 'mg' } as never,
      withChatFiles(world.host, []),
      ctx(),
    );
    expect(none.status).toBe('no_file');
    const pdf = await amendCounterpartyContract.execute(
      { entity: 'mg' } as never,
      withChatFiles(world.host, [{ name: 'Договор.pdf', text: 'x' }]),
      ctx(),
    );
    expect(pdf.status).toBe('unsupported_format');
    const two = withChatFiles(world.host, [
      { name: 'А.docx', text: CONTRACT },
      { name: 'Б.docx', text: CONTRACT },
    ]);
    const ambiguous = await amendCounterpartyContract.execute(
      { entity: 'mg' } as never,
      two,
      ctx(),
    );
    expect(ambiguous.status).toBe('ambiguous_file');
    expect(ambiguous.message).toContain('А.docx');
    const named = await amendCounterpartyContract.execute(
      { entity: 'mg', fileName: 'Б.docx' } as never,
      two,
      ctx(),
    );
    expect(named.status).toBe('sent');
    expect(world.deps.chat.outbox).toHaveLength(1);
  });

  test('нет шаблона юрлица: наших реквизитов нет, файл не изменён и не отправлен', async () => {
    const host = withChatFiles({ ...world.host, templatesPrefix: 'нет-такого-каталога/' }, [
      { name: 'Договор.docx', text: CONTRACT },
    ]);
    const out = await amendCounterpartyContract.execute({ entity: 'mg' } as never, host, ctx());
    expect(out.status).toBe('own_requisites_missing');
    expect(world.deps.chat.outbox).toHaveLength(0);
  });

  test('внедрённый источник реквизитов главнее шаблона (точка замены для этапа 230)', async () => {
    const source: OwnRequisitesSource = {
      forEntity: async () => ({ name: 'ООО «Из БД»', lines: ['ООО «Из БД»', 'ИНН 1234567890'] }),
    };
    const host = withChatFiles({ ...world.host, ownRequisites: source }, [
      { name: 'Договор.docx', text: CONTRACT },
    ]);
    const out = await amendCounterpartyContract.execute({ entity: 'mg' } as never, host, ctx());
    expect(out.status).toBe('sent');
    expect(sentText()).toContain('Заказчик:\nООО «Из БД»\nИНН 1234567890');
    expect(await resolveOwnRequisites(host, 'mg')).toEqual({
      name: 'ООО «Из БД»',
      lines: ['ООО «Из БД»', 'ИНН 1234567890'],
    });
  });

  test('ход не от сотрудника в чате: отказ', async () => {
    const host = withChatFiles(world.host, [{ name: 'Договор.docx', text: CONTRACT }]);
    const scheduled = createToolContext({
      threadId: THREAD,
      agentId: 'documents',
      operationId: 'op-sched',
      initiator: { kind: 'scheduler' },
    });
    await expect(
      amendCounterpartyContract.execute({ entity: 'mg' } as never, host, scheduled),
    ).rejects.toThrow();
  });
});

describe('amendCounterpartyContract: .doc и RTF (этап 232)', () => {
  test.each([
    ['Договор.doc', 'doc', 'Word 97-2003'],
    ['Договор.RTF', 'rtf', 'RTF'],
  ])('%s принимается, выдаётся docx, о смене формата сказано', async (name, format, label) => {
    const host = withChatFiles(world.host, [{ name, text: CONTRACT }]);
    const out = await amendCounterpartyContract.execute({ entity: 'mg' } as never, host, ctx());
    expect(out.status).toBe('sent');
    expect(out.convertedFrom as string).toBe(format);
    expect(out.fileName).toBe('Договор.docx');
    expect(world.deps.chat.outbox[0]?.file?.name).toBe('Договор.docx');
    expect(out.message).toContain('приведён к docx');
    expect(out.message).toContain(label);
    expect(out.message).toContain('по сконвертированному исходнику');
    // Номер и данные исполнителя в сконвертированном файле целы.
    expect(sentText().split('\n')[0]).toBe(CONTRACT_TITLE);
    expect(sentText()).toContain(EXECUTOR_INN);
  });

  test('обычный docx: о смене формата не говорится', async () => {
    const host = withChatFiles(world.host, [{ name: 'Договор.docx', text: CONTRACT }]);
    const out = await amendCounterpartyContract.execute({ entity: 'mg' } as never, host, ctx());
    expect(out.convertedFrom).toBeUndefined();
    expect(out.message).not.toContain('приведён к docx');
  });

  test('сервис не смог конвертировать: отказ с понятной причиной, файл не отправлен', async () => {
    const failing: ContractAmender = {
      ...new MemoryContractAmender(),
      replaceSignatory: new MemoryContractAmender().replaceSignatory,
      classify: async () => ({ verdict: 'supplier', reasons: [], convertedFrom: 'doc' }),
      amend: async () => {
        throw new ContractAmendRefusedError('conversion_failed');
      },
      readPartyBlock: async () => ({ name: OUR_NAME, lines: [OUR_NAME] }),
    };
    const host = withChatFiles({ ...world.host, contractAmender: failing }, [
      { name: 'Договор.doc', text: CONTRACT },
    ]);
    const out = await amendCounterpartyContract.execute({ entity: 'mg' } as never, host, ctx());
    expect(out.status).toBe('refused');
    expect(out.reason).toBe('conversion_failed');
    expect(out.message).toContain('пересохранить');
    // потолок памяти soffice (код 134) неотличим от других аварий: причина названа и «сложен»
    expect(out.message).toContain('слишком сложен для преобразования');
    expect(world.deps.chat.outbox).toHaveLength(0);
  });
});

describe('признак «договор поставщика» решает код', () => {
  const run = async (
    host: DocumentsDeps,
    input: Record<string, unknown> = {},
    turn = 1,
    thread = THREAD,
  ) =>
    amendCounterpartyContract.execute({ entity: 'mg', ...input } as never, host, ctx(turn, thread));
  const withFile = (text: string, host: DocumentsDeps = world.host): DocumentsDeps =>
    withChatFiles(host, [{ name: 'Договор.docx', text }]);

  test('не наш шаблон и исполнитель заполнен: режим включается без вопросов', async () => {
    const out = await run(withFile(CONTRACT));
    expect(out.status).toBe('sent');
    expect(await world.deps.state.get(CONTRACT_KIND_REQUEST_NAMESPACE, 'любой')).toBeNull();
  });

  test('метка нашего документа: режим не включается, вопрос не задаётся, это факт', async () => {
    const ours = [MEMORY_OWN_DOCUMENT_MARKER, ...CONTRACT.split('\n')].join('\n');
    const out = await run(withFile(ours));
    expect(out.status).toBe('own_template');
    expect(out.verdict).toBe('own_template');
    expect(out.message).toContain('собран по нашему шаблону');
    expect(out.message).toContain('метка');
    expect(world.deps.chat.outbox).toHaveLength(0);
  });

  test('текст совпал с нашим шаблоном: наш документ, ответ «поставщика» не меняет', async () => {
    const like = [
      'Заказчик:',
      OUR_NAME,
      OUR_INN_LINE,
      'Р/счет 40702810712345678901',
      '',
      'Исполнитель:',
      EXECUTOR_NAME,
    ].join('\n');
    const first = await run(withFile(like));
    expect(first.status).toBe('own_template');
    // Модель не может «переписать» код: ответ о виде документа здесь не принимается.
    const again = await run(withFile(like), { kindAnswer: 'supplier' }, 2);
    expect(again.status).toBe('own_template');
    expect(world.deps.chat.outbox).toHaveLength(0);
  });

  test('исполнитель не заполнен: неоднозначно, код просит спросить сотрудника', async () => {
    const out = await run(withFile(EMPTY_EXECUTOR_CONTRACT));
    expect(out.status).toBe('kind_question');
    expect(out.verdict).toBe('unclear');
    expect(out.message).toContain('Это договор поставщика');
    expect(out.message).toContain('наш шаблон');
    expect(out.message).toContain('сторона исполнителя в файле не заполнена');
    expect(out.message).toContain('Кнопок в этом чате нет');
    expect(world.deps.chat.outbox).toHaveLength(0);
  });

  test('шаблоны недоступны: «не наш шаблон» не доказано, код спрашивает', async () => {
    const files = world.deps.files as unknown as { remove?(p: string): void };
    const host = withFile(CONTRACT, {
      ...world.host,
      templatesPrefix: 'нет-такого-каталога/',
      ownRequisites: { forEntity: async () => ({ name: OUR_NAME, lines: [OUR_NAME] }) },
    });
    expect(files).toBeDefined();
    const out = await run(host);
    expect(out.status).toBe('kind_question');
    expect(out.message).toContain('шаблоны не удалось прочитать');
  });

  test('частичное совпадение с нашим шаблоном: неоднозначно', async () => {
    const template = [
      'Первая строка шаблона договора достаточно длинная',
      'Вторая строка шаблона договора достаточно длинная',
      'Третья строка шаблона договора достаточно длинная',
      'Четвёртая строка шаблона договора достаточно длинная',
    ].join('\n');
    (world.deps.files as unknown as { put(p: string, c: Uint8Array, m: number): void }).put(
      MG_TEMPLATE,
      encode(template),
      2,
    );
    const partial = [CONTRACT, 'Первая строка шаблона договора достаточно длинная'].join('\n');
    const host = withFile(partial, {
      ...world.host,
      ownRequisites: { forEntity: async () => ({ name: OUR_NAME, lines: [OUR_NAME] }) },
    });
    const out = await run(host);
    expect(out.status).toBe('kind_question');
    expect(out.message).toContain('часть текста совпадает с нашим шаблоном');
  });

  test('наши данные в блоке исполнителя: наша сторона исполнитель, режим не подходит', async () => {
    const ours = [
      CONTRACT_TITLE,
      'Исполнитель:',
      OUR_NAME,
      OUR_INN_LINE,
      'Заказчик:',
      '',
    ].join('\n');
    const host = withFile(ours, { ...world.host, ownCompanyRequisites: ['ИНН 7701001238'] });
    const out = await run(host);
    expect(out.status).toBe('our_side_is_executor');
    expect(world.deps.chat.outbox).toHaveLength(0);
  });

  test('ответ «поставщика» в той же реплике, где задан вопрос, не принимается', async () => {
    const host = withFile(EMPTY_EXECUTOR_CONTRACT);
    expect((await run(host)).status).toBe('kind_question');
    const same = await run(host, { kindAnswer: 'supplier' }, 1);
    expect(same.status).toBe('kind_question');
    expect(world.deps.chat.outbox).toHaveLength(0);
  });

  test('ответ без вопроса от кода не принимается: сначала вопрос', async () => {
    const out = await run(withFile(EMPTY_EXECUTOR_CONTRACT), { kindAnswer: 'supplier' }, 5);
    expect(out.status).toBe('kind_question');
    expect(world.deps.chat.outbox).toHaveLength(0);
  });

  test('ответ «поставщика» в следующей реплике после вопроса: правка выполняется', async () => {
    const host = withFile(EMPTY_EXECUTOR_CONTRACT);
    expect((await run(host)).status).toBe('kind_question');
    await noteEmployeeMessage(world.deps.state, THREAD, 'Это договор поставщика, МГ');
    const out = await run(host, { kindAnswer: 'supplier' }, 2);
    expect(out.status).toBe('sent');
    expect(sentText()).toContain(`Заказчик:\n${OUR_NAME}`);
    expect(sentText().split('\n')[0]).toBe(CONTRACT_TITLE);
  });

  test('сотрудник ответил «наш шаблон»: режим не включается, файл не меняется', async () => {
    const host = withFile(EMPTY_EXECUTOR_CONTRACT);
    await run(host);
    await noteEmployeeMessage(world.deps.state, THREAD, 'Нет, это наш шаблон');
    const out = await run(host, { kindAnswer: 'own_template' }, 2);
    expect(out.status).toBe('own_template');
    expect(out.message).toContain('по нашему шаблону');
    expect(world.deps.chat.outbox).toHaveLength(0);
  });

  test('вопрос относится к файлу: ответ про другой файл не принимается', async () => {
    await run(withFile(EMPTY_EXECUTOR_CONTRACT));
    await noteEmployeeMessage(world.deps.state, THREAD, 'Это договор поставщика');
    const other = EMPTY_EXECUTOR_CONTRACT.replace('1/ТЕСТ-26', '2/ТЕСТ-26');
    const out = await run(withFile(other), { kindAnswer: 'supplier' }, 2);
    expect(out.status).toBe('kind_question');
    expect(world.deps.chat.outbox).toHaveLength(0);
  });

  test('вопрос устарел через час: ответ не принимается', async () => {
    const host = withFile(EMPTY_EXECUTOR_CONTRACT);
    await run(host);
    await noteEmployeeMessage(world.deps.state, THREAD, 'Это договор поставщика');
    world.deps.clock.advance(61 * 60 * 1000);
    const out = await run(host, { kindAnswer: 'supplier' }, 2);
    expect(out.status).toBe('kind_question');
  });

  // Ответ сотрудника сверяется с его словами (находка 2 ревью этапа 232).
  describe('ответ на вопрос кода разбирает код по словам сотрудника', () => {
    const asked = async (): Promise<DocumentsDeps> => {
      const host = withFile(EMPTY_EXECUTOR_CONTRACT);
      expect((await run(host)).status).toBe('kind_question');
      return host;
    };
    const reply = (text: string): Promise<void> =>
      noteEmployeeMessage(world.deps.state, THREAD, text);

    test('реплика не по теме при kindAnswer=supplier: ответ не принят, вопрос снова', async () => {
      const host = await asked();
      await reply('И счёт тоже пришли');
      const out = await run(host, { kindAnswer: 'supplier' }, 2);
      expect(out.status).toBe('kind_question');
      expect(out.message).toContain('не принял');
      expect(world.deps.chat.outbox).toHaveLength(0);
    });

    test('слова сотрудника против kindAnswer модели: ответ не принят', async () => {
      const host = await asked();
      await reply('Нет, это наш шаблон');
      const out = await run(host, { kindAnswer: 'supplier' }, 2);
      expect(out.status).toBe('kind_question');
      expect(world.deps.chat.outbox).toHaveLength(0);
    });

    test('принятый ответ погашен: следующая реплика его не использует', async () => {
      const host = await asked();
      await reply('Да, поставщика');
      expect((await run(host, { kindAnswer: 'supplier' }, 2)).status).toBe('sent');
      // Запись вопроса удалена: та же модель в следующей реплике снова должна спросить.
      expect(await world.deps.state.list(CONTRACT_KIND_REQUEST_NAMESPACE, null, 10)).toEqual([]);
      await reply('Пришли ещё раз');
      const again = await run(host, { kindAnswer: 'supplier' }, 3);
      expect(again.status).toBe('kind_question');
      expect(world.deps.chat.outbox).toHaveLength(1);
    });

    test('ответ не в следующей реплике, а позже: не принимается, вопрос гасится', async () => {
      const host = await asked();
      await reply('Подожди минуту');
      expect((await run(host, { kindAnswer: 'supplier' }, 2)).status).toBe('kind_question');
      // Вопрос записан заново в реплике 2; ответ в реплике 4 - уже не «следующая».
      await reply('Это договор поставщика');
      expect((await run(host, { kindAnswer: 'supplier' }, 4)).status).toBe('kind_question');
      expect(world.deps.chat.outbox).toHaveLength(0);
    });

    test('неразобранный ответ не мешает ответить в следующей реплике после повторного вопроса',
      async () => {
        const host = await asked();
        await reply('Не знаю');
        expect((await run(host, { kindAnswer: 'supplier' }, 2)).status).toBe('kind_question');
        await reply('Это договор поставщика');
        expect((await run(host, { kindAnswer: 'supplier' }, 3)).status).toBe('sent');
      },
    );

    test('ответ модели в той же реплике, где задан вопрос: не принят', async () => {
      const host = withFile(EMPTY_EXECUTOR_CONTRACT);
      await run(host);
      const out = await run(host, { kindAnswer: 'supplier' }, 1);
      expect(out.status).toBe('kind_question');
    });
  });

  test('без хранилища состояния ответ принять нечем: код спрашивает снова', async () => {
    const { state: _state, ...withoutState } = withFile(EMPTY_EXECUTOR_CONTRACT);
    const out = await run(withoutState as DocumentsDeps, { kindAnswer: 'supplier' }, 2);
    // Юрлицо тоже проверить нечем (нет сообщений сотрудника): отказ раньше вопроса.
    expect(out.status).toBe('entity_not_confirmed');
  });
});

describe('декларация и промпт', () => {
  const names = (options: Parameters<typeof createDocumentsAgent>[0]): string[] =>
    createDocumentsAgent(options).tools.map((tool) => tool.name);

  test('режим выключен по умолчанию: ни инструмента, ни абзаца промпта', () => {
    expect(names({ model: 'm', chatAttachments: true })).not.toContain('amendCounterpartyContract');
    expect(createDocumentsAgent({ model: 'm', chatAttachments: true }).prompt).not.toContain(
      COUNTERPARTY_AMEND_PROMPT,
    );
  });

  test('с флагом, чтением файлов и договорами: инструмент и промпт есть', () => {
    const agent = createDocumentsAgent({
      model: 'm',
      chatAttachments: true,
      counterpartyAmend: true,
    });
    expect(agent.tools.map((tool) => tool.name)).toContain('amendCounterpartyContract');
    expect(agent.prompt).toContain(COUNTERPARTY_AMEND_PROMPT);
  });

  test('без чтения файлов или без договоров режима нет', () => {
    expect(names({ model: 'm', counterpartyAmend: true })).not.toContain(
      'amendCounterpartyContract',
    );
    expect(
      names({
        model: 'm',
        chatAttachments: true,
        counterpartyAmend: true,
        enabledKinds: ['invoice'],
      }),
    ).not.toContain('amendCounterpartyContract');
  });

  test('промпт: номер не меняется, вид документа решает код, при вопросе спросить', () => {
    expect(COUNTERPARTY_AMEND_PROMPT).toContain('amendCounterpartyContract');
    expect(COUNTERPARTY_AMEND_PROMPT).toContain('нашу форму не собирай');
    expect(COUNTERPARTY_AMEND_PROMPT).toContain('Номер договора поставщика не меняется');
    expect(COUNTERPARTY_AMEND_PROMPT).not.toContain('ourNumber');
    expect(COUNTERPARTY_AMEND_PROMPT).toContain('решает код, а не ты');
    expect(COUNTERPARTY_AMEND_PROMPT).toContain('kind_question');
    expect(COUNTERPARTY_AMEND_PROMPT).toContain('kindAnswer');
    expect(COUNTERPARTY_AMEND_PROMPT).toContain('.doc');
    // Основной промпт не менялся: прежний текст без абзаца режима.
    expect(buildDocumentsPrompt()).not.toContain('amendCounterpartyContract');
  });
});

describe('amendCounterpartyContract: доработки по ревью этапа 227', () => {
  const run = async (host: DocumentsDeps, input: Record<string, unknown> = {}) =>
    amendCounterpartyContract.execute({ entity: 'mg', ...input } as never, host, ctx());
  const contract = (): DocumentsDeps =>
    withChatFiles(world.host, [{ name: 'Договор.docx', text: CONTRACT }]);

  test('юрлицо, которое сотрудник не называл, не принимается (находка 5)', async () => {
    const out = await run(contract(), { entity: 'pr' });
    expect(out.status).toBe('entity_not_confirmed');
    expect(out.message).toContain('юрлиц');
    expect(world.deps.chat.outbox).toHaveLength(0);
  });

  test('юрлицо названо полным именем: принимается', async () => {
    await noteEmployeeMessage(world.deps.state, THREAD, 'Реквизиты Мастер Гифтс, пожалуйста');
    expect((await run(contract())).status).toBe('sent');
  });

  test('«ПР» внутри другого слова юрлицом не считается', async () => {
    const other = 'documents/u-entity';
    await noteEmployeeMessage(world.deps.state, other, 'ПР-Метал прислал договор');
    const out = await amendCounterpartyContract.execute(
      { entity: 'pr' } as never,
      contract(),
      createToolContext({
        threadId: other,
        agentId: 'documents',
        operationId: 'op-entity',
        initiator: { kind: 'user', userId: 'u-amend' },
      }),
    );
    expect(out.status).toBe('entity_not_confirmed');
  });

  test('без хранилища состояния юрлицо проверить нечем: отказ', async () => {
    const { state: _state, ...withoutState } = contract();
    const out = await run(withoutState as DocumentsDeps);
    expect(out.status).toBe('entity_not_confirmed');
    expect(world.deps.chat.outbox).toHaveLength(0);
  });

  test('наша сторона - исполнитель: явный отказ, файл не отправлен (находка 9)', async () => {
    const out = await run(contract(), { ourRole: 'executor' });
    expect(out.status).toBe('our_side_is_executor');
    expect(out.message).toContain('исполнител');
    expect(out.message).not.toContain('чужой текст');
    expect(world.deps.chat.outbox).toHaveLength(0);
  });

  test('отказ «остались пустые поля» объясняется сотруднику своим текстом', async () => {
    const refusing: ContractAmender = {
      replaceSignatory: async () => {
        throw new Error('не должен вызываться');
      },
      amend: async () => {
        throw new ContractAmendRefusedError('customer_placeholders_unfilled');
      },
      classify: async () => ({ verdict: 'supplier', reasons: [], convertedFrom: null }),
      readPartyBlock: async () => ({ name: OUR_NAME, lines: [OUR_NAME] }),
    };
    const out = await run({ ...contract(), contractAmender: refusing });
    expect(out.status).toBe('refused');
    expect(out.reason).toBe('customer_placeholders_unfilled');
    expect(out.message).toContain('вручную');
  });

  test('отмена и сбой при чтении шаблона не прячутся за «нет реквизитов» (находка 8)', async () => {
    const cancelled = {
      ...contract(),
      files: {
        ...world.deps.files,
        read: async () => {
          throw new CancelledError('отменено');
        },
        list: async () => [],
      },
    } as unknown as DocumentsDeps;
    await expect(run(cancelled)).rejects.toBeInstanceOf(CancelledError);
    const broken: ContractAmender = {
      replaceSignatory: async () => {
        throw new Error('не должен вызываться');
      },
      amend: async () => {
        throw new Error('не должен вызываться');
      },
      classify: async () => {
        throw new Error('не должен вызываться');
      },
      readPartyBlock: async () => {
        throw new ServiceError('Сервис недоступен.', { kind: 'network', retryable: true });
      },
    };
    await expect(run({ ...contract(), contractAmender: broken })).rejects.toBeInstanceOf(
      ServiceError,
    );
  });

  test('сигнал отмены доходит до чтения блока, признака и дополнения (находка 8)', async () => {
    const seen: Array<AbortSignal | undefined> = [];
    const inner = new MemoryContractAmender();
    const spy: ContractAmender = {
      replaceSignatory: async () => {
        throw new Error('не должен вызываться');
      },
      amend: async (request) => {
        seen.push(request.signal);
        return inner.amend(request);
      },
      classify: async (request) => {
        seen.push(request.signal);
        return inner.classify(request);
      },
      readPartyBlock: async (request) => {
        seen.push(request.signal);
        return inner.readPartyBlock(request);
      },
    };
    const controller = new AbortController();
    const context = createToolContext({
      threadId: THREAD,
      agentId: 'documents',
      operationId: 'op-signal',
      initiator: { kind: 'user', userId: 'u-amend' },
      signal: controller.signal,
    });
    const out = await amendCounterpartyContract.execute(
      { entity: 'mg' } as never,
      { ...contract(), contractAmender: spy },
      context,
    );
    expect(out.status).toBe('sent');
    expect(seen).toHaveLength(3);
    expect(seen.every((signal) => signal !== undefined)).toBe(true);
  });
});

describe('parseKindReply: ответ сотрудника по смыслу', () => {
  test.each<[string, KindReply]>([
    ['да', 'supplier'],
    ['Да, это договор поставщика', 'supplier'],
    ['поставщика', 'supplier'],
    ['Это его форма', 'supplier'],
    ['не наш шаблон', 'supplier'],
    ['Нет, не по нашему шаблону, а поставщика', 'supplier'],
    ['нет', 'own_template'],
    ['наш', 'own_template'],
    ['Это наш шаблон', 'own_template'],
    ['по нашему шаблону собран', 'own_template'],
    ['мы сами составили', 'own_template'],
  ])('«%s» -> %s', (text, expected) => {
    expect(parseKindReply(text)).toBe(expected);
  });

  test.each([
    '',
    '   ',
    'и счёт тоже пришли',
    'не знаю',
    'не поставщика',
    'да, наш',
    'нет, поставщика',
    'поставщика или наш',
    'отправь поставщику счёт на оплату за прошлый месяц и скажи когда будет готов договор',
  ])('«%s» -> неоднозначно', (text) => {
    expect(parseKindReply(text)).toBe('unclear');
  });
});
