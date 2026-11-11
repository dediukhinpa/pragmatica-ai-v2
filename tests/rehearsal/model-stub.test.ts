import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { startStub } from '../../deploy/rehearsal/model-stub';

/** Ответ чата, в той части, что проверяет тест. */
interface ChatReply {
  choices: { message: { content: string } }[];
  usage: { total_tokens: number };
}

describe('model-stub: заглушка шлюза моделей репетиции', () => {
  let server: ReturnType<typeof startStub>;
  let base = '';

  beforeAll(() => {
    server = startStub(0);
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => {
    server.stop(true);
  });

  test('/health отвечает ok', async () => {
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  test('чат возвращает фиксированный текст и нулевое потребление', async () => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({ model: 'alias-a', messages: [{ role: 'user', content: 'x' }] }),
    });
    const reply = (await response.json()) as ChatReply;
    expect(reply.choices[0]?.message.content).toContain('Заглушка');
    expect(reply.usage.total_tokens).toBe(0);
  });

  test('потоковый чат заканчивается [DONE]', async () => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({ stream: true }),
    });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect((await response.text()).trimEnd().endsWith('data: [DONE]')).toBe(true);
  });

  test('векторы: по одному на вход, размерность из запроса', async () => {
    const response = await fetch(`${base}/v1/embeddings`, {
      method: 'POST',
      body: JSON.stringify({ input: ['a', 'b'], dimensions: 4 }),
    });
    const body = (await response.json()) as { data: { embedding: number[] }[] };
    expect(body.data.length).toBe(2);
    expect(body.data[0]?.embedding).toEqual([0, 0, 0, 0]);
  });

  test('неизвестный маршрут - 404, тело запроса не нужно', async () => {
    const reply = await fetch(`${base}/v1/unknown`, { method: 'POST', body: 'не json' });
    expect(reply.status).toBe(404);
    expect((await fetch(`${base}/other`)).status).toBe(404);
  });
});
