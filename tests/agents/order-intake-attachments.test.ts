import { describe, expect, test } from 'bun:test';
import { MemoryDocumentParser, MemoryPortalLinks, MemoryTaskReader } from '@business-ai/adapters';
import { saveIntakeRequest } from '../../src/agents/order-calc/save-intake-request';
import { type OrderCalcDeps } from '../../src/agents/order-calc/deps';
import { DomainError } from '@business-ai/core';
import type { AttachmentBundle, BitrixAttachmentReader, WorkTask } from '@business-ai/core';
import { CTX } from './support';
import { buildOrderDeps } from './order-support';

const HOST = 'portal.example.test';
const TASK_LINK = `https://${HOST}/company/personal/user/1/tasks/task/view/77/`;

const TASK: WorkTask = {
  id: '77',
  title: 'Заказать мерч',
  description: 'Список позиций во вложении',
  checklist: [],
};

const FROM_FILE = { name: 'Кружка с логотипом', quantity: 300, unit: 'шт' };
const INVENTED = { name: 'Выдуманный термос', quantity: 5, unit: 'шт' };

function readerOf(bundle: AttachmentBundle | Error): {
  reader: BitrixAttachmentReader;
  calls: number;
} {
  const state = {
    calls: 0,
    reader: {
      async fetchAttachments(): Promise<AttachmentBundle> {
        state.calls += 1;
        if (bundle instanceof Error) throw bundle;
        return bundle;
      },
    } satisfies BitrixAttachmentReader,
  };
  return state;
}

const csv = (text: string): AttachmentBundle => ({
  attachments: [
    {
      name: 'список.csv',
      mime: 'text/csv',
      bytes: new TextEncoder().encode(text),
      source: 'task',
    },
  ],
  errors: [],
});

async function depsWith(reader: BitrixAttachmentReader | undefined): Promise<OrderCalcDeps> {
  const base = await buildOrderDeps({ request: null });
  const tasks = new MemoryTaskReader();
  tasks.set(TASK);
  return {
    ...base,
    tasks,
    links: new MemoryPortalLinks(HOST),
    parser: new MemoryDocumentParser(),
    ...(reader === undefined ? {} : { attachments: reader }),
  } as OrderCalcDeps;
}

const save = (deps: OrderCalcDeps, items: unknown[]) =>
  saveIntakeRequest.execute({ source: 'task', link: TASK_LINK, items }, deps, CTX);

describe('приём заявки из задачи: позиции из вложений', () => {
  test('позиция, найденная только во вложении, принимается', async () => {
    const net = readerOf(csv('Кружка с логотипом,300,логотип 1 цвет\n'));
    const out = await save(await depsWith(net.reader), [FROM_FILE]);
    expect(out).toMatchObject({ itemsFrom: 'model', itemCount: 1, dealRef: 'task-77' });
  });

  test('выдуманная позиция отклоняется, даже если рядом есть настоящая из вложения', async () => {
    const net = readerOf(csv('Кружка с логотипом,300,логотип 1 цвет\n'));
    const deps = await depsWith(net.reader);
    const failure = await save(deps, [FROM_FILE, INVENTED]).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(DomainError);
    expect((failure as DomainError).code).toBe('validation_failed');
    // Номер позиции есть, название выдумки в отказ не попадает.
    expect((failure as DomainError).message).toContain('позиции 2');
    expect((failure as DomainError).message).not.toContain('термос');
  });

  test('позиция только из файла чата отклоняется: чат открыт для посторонних', async () => {
    const chat = csv('Кружка с логотипом,300,логотип 1 цвет\n');
    chat.attachments[0]!.source = 'chat';
    const net = readerOf(chat);
    const failure = await save(await depsWith(net.reader), [FROM_FILE]).then(
      () => null,
      (error: unknown) => error,
    );
    expect((failure as DomainError).code).toBe('validation_failed');
  });

  test('читателю вложений передан сигнал с дедлайном', async () => {
    let seen: AbortSignal | undefined;
    const reader: BitrixAttachmentReader = {
      async fetchAttachments(request): Promise<AttachmentBundle> {
        seen = request.signal;
        return csv('Кружка с логотипом,300,x\n');
      },
    };
    await save(await depsWith(reader), [FROM_FILE]);
    expect(seen).toBeInstanceOf(AbortSignal);
  });

  test('сбой чтения вложений = нет опоры: позиция отклоняется, ход не падает', async () => {
    const net = readerOf(new Error('boom'));
    const failure = await save(await depsWith(net.reader), [FROM_FILE]).then(
      () => null,
      (error: unknown) => error,
    );
    expect((failure as DomainError).code).toBe('validation_failed');
  });

  test('без порта вложений поведение прежнее', async () => {
    const failure = await save(await depsWith(undefined), [FROM_FILE]).then(
      () => null,
      (error: unknown) => error,
    );
    expect((failure as DomainError).code).toBe('validation_failed');
  });

  test('позиция есть в тексте задачи: вложения не скачиваются', async () => {
    const net = readerOf(csv('x'));
    const deps = await depsWith(net.reader);
    await save(deps, [{ name: 'Список позиций', quantity: 1, unit: 'шт' }]);
    expect(net.calls).toBe(0);
  });
});
