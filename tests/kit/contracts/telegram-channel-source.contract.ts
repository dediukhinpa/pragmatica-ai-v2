import { describe, expect, test } from 'bun:test';
import type {
  TelegramChannelSource,
  TelegramPost,
} from '../../../src/kit/ports/telegram-channel-source';

/** Посты, которые фабрика обязана загрузить в адаптер (синтетика, без реальных каналов). */
export const TELEGRAM_SEED: readonly TelegramPost[] = [
  {
    channel: 'suppliers',
    messageId: 101,
    date: '2026-11-01T10:00:00.000Z',
    text: 'Арматура 12 мм, 55 руб/м, склад в Перми',
    link: 'https://t.me/c/1000/101',
  },
  {
    channel: 'suppliers',
    messageId: 102,
    date: '2026-11-03T09:30:00.000Z',
    text: 'Цемент М500 оптом, самовывоз',
  },
  {
    channel: 'suppliers',
    messageId: 103,
    date: '2026-11-05T12:00:00.000Z',
    text: 'Арматура 10 мм и сетка кладочная, доставка по области',
  },
];

/** Контрактный набор TelegramChannelSource; фабрика получает посты для загрузки. */
export function telegramChannelSourceContract(
  name: string,
  factory: (seed: readonly TelegramPost[]) => TelegramChannelSource,
): void {
  describe(`TelegramChannelSource: ${name}`, () => {
    test('находит посты по словам запроса', async () => {
      const posts = await factory(TELEGRAM_SEED).search('цемент', 5);
      expect(posts.map((post) => post.messageId)).toEqual([102]);
    });

    test('уважает limit; среди равных по совпадению свежие раньше', async () => {
      const source = factory(TELEGRAM_SEED);
      const all = await source.search('арматура', 5);
      expect(all.map((post) => post.messageId)).toEqual([103, 101]);
      expect(await source.search('арматура', 1)).toHaveLength(1);
    });

    test('пустой запрос и ненайденное дают пустой результат', async () => {
      const source = factory(TELEGRAM_SEED);
      expect(await source.search('   ', 5)).toEqual([]);
      expect(await source.search('космолёт', 5)).toEqual([]);
    });

    test('пост несёт канал, номер, дату, текст и, если есть, ссылку', async () => {
      const [post] = await factory(TELEGRAM_SEED).search('перми', 1);
      expect(post).toEqual(TELEGRAM_SEED[0]!);
      const [plain] = await factory(TELEGRAM_SEED).search('цемент', 1);
      expect(plain?.link).toBeUndefined();
    });

    test('отменённый сигнал обрывает поиск', async () => {
      const controller = new AbortController();
      controller.abort(new Error('cancelled'));
      await expect(
        factory(TELEGRAM_SEED).search('цемент', 5, { signal: controller.signal }),
      ).rejects.toBeDefined();
    });
  });
}
