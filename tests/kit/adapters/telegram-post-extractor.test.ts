import { describe, expect, test } from 'bun:test';
import {
  MemoryTelegramPostExtractor,
} from '../../../src/kit/adapters/memory/telegram-channel-source';
import {
  ModelTelegramPostExtractor,
} from '../../../src/kit/adapters/litellm/telegram-post-extractor';
import { type WebPagePiiStripReport } from '../../../src/kit/adapters/litellm/web-candidate-model';
import type { ModelGateway, ModelRequest } from '@business-ai/core';

const TIMEOUT_MS = 5_000;
const LONG_DIGITS = /\d{10,}/;
/** Пост-ловушка: ФИО менеджера, личный телефон, почта, адрес + цены и товары. */
const TRAP_POST =
  'Арматура 12 мм - 55 руб/м, срок 3 дня. Менеджер Сидоров Пётр Алексеевич, ' +
  'моб. +7 916 555-12-34, почта manager@kanal.example.ru, г. Пермь, ул. Ленина, д. 3, кв. 7.';
const PII_VALUES = ['Сидоров', 'Алексеевич', '555-12-34', 'manager@kanal.example.ru', 'Ленина'];

const signal = (): { signal: AbortSignal } => ({ signal: AbortSignal.timeout(TIMEOUT_MS) });

/** Записывающая заглушка шлюза: тело каждого запроса сохраняется. */
function recordingGateway(answer = '{"name":"Канальный металл","city":"Пермь"}') {
  const seen: ModelRequest[] = [];
  const gateway: ModelGateway = {
    async complete(request) {
      seen.push(request);
      return { model: request.model, content: answer, stopReason: 'end_turn' };
    },
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new Error('не используется');
    },
  };
  return { gateway, seen };
}

const bodyOf = (seen: ModelRequest[]): string =>
  seen.map((request) => request.messages.map((message) => message.content).join('\n')).join('\n');

describe('ModelTelegramPostExtractor: очистка поста перед моделью', () => {
  test('в запросе нет ПДн (режим enforce всегда), цены и товары на месте', async () => {
    const { gateway, seen } = recordingGateway();
    const reports: WebPagePiiStripReport[] = [];
    const extractor = new ModelTelegramPostExtractor(gateway, 'm', {
      onReport: (report) => reports.push(report),
    });
    const answer = await extractor.extract({ text: TRAP_POST, items: ['Арматура'] }, signal());
    const body = bodyOf(seen);
    for (const value of PII_VALUES) expect(body).not.toContain(value);
    expect(LONG_DIGITS.test(body)).toBe(false);
    expect(body).toContain('Арматура 12 мм - 55 руб/м');
    expect(answer).toEqual({ name: 'Канальный металл', city: 'Пермь' });
    expect(reports[0]).toMatchObject({ mode: 'enforce', scope: 'telegram' });
    expect(reports[0]?.counts.phone).toBeGreaterThan(0);
    expect(reports[0]?.counts.email).toBeGreaterThan(0);
  });

  test('сбой очистки: пост модели не уходит (fail closed), ответ - null', async () => {
    const { gateway, seen } = recordingGateway();
    const reports: WebPagePiiStripReport[] = [];
    const extractor = new ModelTelegramPostExtractor(gateway, 'm', {
      sanitize: () => {
        throw new Error('detector down');
      },
      onReport: (report) => reports.push(report),
    });
    expect(await extractor.extract({ text: TRAP_POST, items: [] }, signal())).toBeNull();
    expect(seen).toEqual([]);
    expect(reports[0]).toMatchObject({ failed: 1, dropped: 1 });
  });

  test('в запросе только позиции заявки и очищенный текст; не-JSON ответ - null', async () => {
    const { gateway, seen } = recordingGateway('нет JSON');
    const extractor = new ModelTelegramPostExtractor(gateway, 'm');
    expect(await extractor.extract({ text: 'Цемент', items: ['Цемент М500'] }, signal())).toBeNull();
    const user = seen[0]?.messages.find((message) => message.role === 'user')?.content ?? '';
    expect(JSON.parse(user.slice(user.indexOf('<<<') + 3, user.lastIndexOf('>>>')))).toEqual({
      items: ['Цемент М500'],
      text: 'Цемент',
    });
  });

  test('отменённый ход: модель не вызывается', async () => {
    const { gateway, seen } = recordingGateway();
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    const extractor = new ModelTelegramPostExtractor(gateway, 'm');
    await expect(
      extractor.extract({ text: 'x', items: [] }, { signal: controller.signal }),
    ).rejects.toBeDefined();
    expect(seen).toEqual([]);
  });
});

describe('MemoryTelegramPostExtractor', () => {
  test('отдаёт заданный ответ и запоминает входы', async () => {
    const extractor = new MemoryTelegramPostExtractor((post) => ({ name: post.text }));
    expect(await extractor.extract({ text: 'А', items: [] }, signal())).toEqual({ name: 'А' });
    expect(extractor.seen).toHaveLength(1);
  });
});
