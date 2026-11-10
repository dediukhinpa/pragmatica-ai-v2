import { beforeEach, describe, expect, test } from 'bun:test';
import {
  MemoryPortalLinks,
  MemoryTaskReader,
  UnconfiguredImageReader,
} from '@business-ai/adapters';
import {
  askManagerToChoose,
  buildChoiceMessage,
} from '../../src/agents/order-calc/ask-manager-to-choose';
import { buildShortlist } from '../../src/agents/order-calc/build-shortlist';
import { readIntakeSource } from '../../src/agents/order-calc/read-intake-source';
import { searchKnowledgeSuppliers, searchWeb } from '../../src/agents/order-calc/search-sources';
import { type OrderCalcDeps } from '../../src/agents/order-calc/deps';
import { PHOTO_HINT_LINE, notePhotosSeen } from '../../src/agents/order-calc/photo-hint';
import { loadProposal, saveProposal } from '../../src/agents/order-calc/state';
import type { ShortlistProposal } from '../../src/kit/domain/shortlist';
import { BUSY_PHOTO_LINE, UNREADABLE_PHOTO_LINE } from '@business-ai/core';
import { CTX } from './support';
import { REQUEST_ID, buildOrderDeps, type OrderTestDeps } from './order-support';

const CHOICE = 'Кому готовить запросы?';
const HOST = 'portal.example.test';
const TASK_LINK = `https://${HOST}/company/personal/user/1/tasks/task/view/77/`;
const OK = { status: 'ok' } as const;
const UNAVAILABLE = { status: 'unavailable' } as const;

describe('этап 189: фраза о непрочитанных фото строится кодом один раз на заявку', () => {
  let deps: OrderTestDeps;
  beforeEach(async () => {
    deps = await buildOrderDeps();
  });

  /** Шорт-лист и вопрос выбора; возвращает версию шорт-листа. */
  async function show(): Promise<string> {
    const input = { requestId: REQUEST_ID };
    await searchKnowledgeSuppliers.execute(input, deps, CTX);
    await searchWeb.execute(input, deps, CTX);
    const { version } = await buildShortlist.execute(input, deps, CTX);
    await askManagerToChoose.execute({ requestId: REQUEST_ID, version }, deps, CTX);
    return version;
  }

  /** Тексты всех сообщений чата. */
  function texts(): string[] {
    return deps.chat.outbox.flatMap((r) => (r.message === undefined ? [] : [r.message.text]));
  }

  test('фото есть, прочитанных нет: отдельная строка перед вопросом выбора', async () => {
    await notePhotosSeen(deps.state, CTX.threadId, 'task', 2, [UNAVAILABLE, UNAVAILABLE]);
    await show();
    const all = texts();
    expect(all).toHaveLength(2);
    const paragraphs = (all[1] ?? '').split('\n\n');
    expect(paragraphs.at(-2)).toBe(PHOTO_HINT_LINE);
    expect(paragraphs.at(-1)).toContain(`[B]${CHOICE}[/B]`);
    expect(all[0]).not.toContain(PHOTO_HINT_LINE);
  });

  test('фото есть, чтение не вернуло ничего: строка есть', async () => {
    await notePhotosSeen(deps.state, CTX.threadId, 'task', 1, []);
    await show();
    expect(texts().join('\n')).toContain(PHOTO_HINT_LINE);
  });

  test('часть фото прочитана: строки нет', async () => {
    await notePhotosSeen(deps.state, CTX.threadId, 'task', 3, [OK, UNAVAILABLE, UNAVAILABLE]);
    await show();
    expect(texts().join('\n')).not.toContain(PHOTO_HINT_LINE);
  });

  test('все фото прочитаны: строки нет', async () => {
    await notePhotosSeen(deps.state, CTX.threadId, 'chat', 2, [OK, OK]);
    await show();
    expect(texts().join('\n')).not.toContain(PHOTO_HINT_LINE);
  });

  test('фото нет или вложения не читались: строки нет', async () => {
    await show();
    expect(texts().join('\n')).not.toContain(PHOTO_HINT_LINE);
    await notePhotosSeen(deps.state, CTX.threadId, 'task', 0, []);
    await show();
    expect(texts().join('\n')).not.toContain(PHOTO_HINT_LINE);
  });

  test('повторный показ шорт-листа той же заявки: строка не повторяется', async () => {
    await notePhotosSeen(deps.state, CTX.threadId, 'task', 1, [UNAVAILABLE]);
    await show();
    // Шорт-лист пересобран (новая версия): новый вопрос выбора, но фразы второй раз нет.
    const proposal = (await loadProposal(deps, REQUEST_ID)) as ShortlistProposal;
    const version = `${proposal.version}-v2`;
    await saveProposal(deps, { ...proposal, version });
    await askManagerToChoose.execute({ requestId: REQUEST_ID, version }, deps, CTX);
    const shownCount = texts().filter((text) => text.includes(PHOTO_HINT_LINE)).length;
    expect(shownCount).toBe(1);
    expect(texts().filter((text) => text.includes(CHOICE))).toHaveLength(2);
  });

  test('фото отклонены как нечитаемые (tokens): строка кода вместо общей фразы', async () => {
    const bad = { status: 'unavailable', unreadable: true } as const;
    await notePhotosSeen(deps.state, CTX.threadId, 'task', 1, [bad]);
    await show();
    const all = texts().join('\n');
    expect(all).toContain(UNREADABLE_PHOTO_LINE);
    expect(all).not.toContain(PHOTO_HINT_LINE);
  });

  test('сервис чтения был занят (tokens): строка «пришлите ещё раз», не «плохо читается»', async () => {
    const busy = { status: 'unavailable', busy: true } as const;
    await notePhotosSeen(deps.state, CTX.threadId, 'task', 1, [busy]);
    await show();
    const all = texts().join('\n');
    expect(all).toContain(BUSY_PHOTO_LINE);
    expect(all).not.toContain(UNREADABLE_PHOTO_LINE);
    expect(all).not.toContain(PHOTO_HINT_LINE);
  });

  test('нечитаемое фото при другом прочитанном: строки нет', async () => {
    const bad = { status: 'unavailable', unreadable: true } as const;
    await notePhotosSeen(deps.state, CTX.threadId, 'task', 2, [OK, bad]);
    await show();
    expect(texts().join('\n')).not.toContain(UNREADABLE_PHOTO_LINE);
  });

  test('старая запись состояния без поля unreadable валидна: общая фраза', async () => {
    await deps.state.put('order-calc:photo-seen', CTX.threadId, {
      sources: { task: { images: 1, read: 0 } },
    });
    await show();
    expect(texts().join('\n')).toContain(PHOTO_HINT_LINE);
  });

  test('формулировка короткая, в одну строку и без ПДн', () => {
    expect(PHOTO_HINT_LINE).not.toContain('\n');
    expect(PHOTO_HINT_LINE.length).toBeLessThanOrEqual(100);
    expect(PHOTO_HINT_LINE).not.toMatch(/\d|@|https?:|req-|не вижу/u);
  });

  test('чистая сборка сообщения без фразы не меняется', async () => {
    const proposal = (await (async () => {
      await show();
      return loadProposal(deps, REQUEST_ID);
    })()) as ShortlistProposal;
    const plain = buildChoiceMessage(proposal, false);
    const withHint = buildChoiceMessage(proposal, false, undefined, [], PHOTO_HINT_LINE);
    expect(plain.text).not.toContain(PHOTO_HINT_LINE);
    expect(withHint.text).toContain(`${PHOTO_HINT_LINE}\n\n[B]${CHOICE}[/B]`);
  });
});

describe('этап 189: чтение задачи запоминает фото без прочтения', () => {
  test('readIntakeSource с фото и заглушкой ридера даёт строку под шорт-листом', async () => {
    const base = await buildOrderDeps();
    const tasks = new MemoryTaskReader();
    tasks.set({
      id: '77',
      title: 'Заказ',
      description: 'см. фото',
      checklist: [],
      attachments: [{ name: 'фото.jpg', isImage: true }],
    });
    const deps = {
      ...base,
      tasks,
      links: new MemoryPortalLinks(HOST),
      imageReader: new UnconfiguredImageReader(),
      attachments: {
        async fetchAttachments() {
          return {
            attachments: [
              { name: 'фото.jpg', mime: 'image/jpeg', bytes: new Uint8Array([1]), source: 'task' },
            ],
            errors: [],
          };
        },
      },
    } as unknown as OrderCalcDeps;
    const out = await readIntakeSource.execute({ link: TASK_LINK }, deps, CTX);
    expect(out).toMatchObject({ kind: 'task', imageCount: 1 });
    const input = { requestId: REQUEST_ID };
    await searchKnowledgeSuppliers.execute(input, deps, CTX);
    await searchWeb.execute(input, deps, CTX);
    const { version } = await buildShortlist.execute(input, deps, CTX);
    await askManagerToChoose.execute({ requestId: REQUEST_ID, version }, deps, CTX);
    const sent = (base as OrderTestDeps).chat.outbox.flatMap((r) =>
      r.message === undefined ? [] : [r.message.text],
    );
    expect(sent.join('\n')).toContain(PHOTO_HINT_LINE);
  });
});
