import { afterAll, describe, expect, test } from 'bun:test';
import { FixedClock, MemoryChatChannel, noopTelemetry } from '@business-ai/adapters';
import { loadProductionConfig, removeTempDirs } from '@business-ai/testing';
import type { ProductionConfig } from '@business-ai/core/compose';
import { projectModels, type ProjectModelsServices } from '../../src/assembly/project-models';
import type { PragmatikaConfig } from '../../src/config';
import { pragmatikaEnv } from './support';

afterAll(removeTempDirs);

/** Предел одновременных запросов к псевдонимизатору в тесте. */
const MAX_INFLIGHT = 2;
/** Сколько вызовов модели запускается разом через каждый из путей проекта. */
const CALLS_PER_PATH = 6;
/** Время ответа заглушки псевдонимизатора, мс: запросы успевают накладываться. */
const SERVICE_DELAY_MS = 15;

/** Заглушка сетевого слоя: считает одновременные запросы к псевдонимизатору. */
class FakeNetwork {
  inFlight = 0;
  maxInFlight = 0;
  pseudonymizerCalls = 0;

  fetch = async (input: string, init: RequestInit): Promise<Response> => {
    if (!input.startsWith('http://pseudonymizer.test')) return this.model(input);
    this.pseudonymizerCalls += 1;
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, SERVICE_DELAY_MS));
    } finally {
      this.inFlight -= 1;
    }
    const body = JSON.parse(String(init.body ?? '{}')) as { text?: string; texts?: string[] };
    if (input.endsWith('/pseudonymize_batch')) {
      const items = (body.texts ?? []).map((text) => ({ text, entities: [] }));
      return Response.json({ items });
    }
    if (input.endsWith('/check')) return Response.json({ has_pii: false, types: [] });
    return Response.json({ text: body.text ?? '', entities: [] });
  };

  private model(_input: string): Response {
    return Response.json({
      id: 'msg-1',
      type: 'message',
      role: 'assistant',
      model: 'alias',
      content: [{ type: 'text', text: 'готово' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  }
}

function services(): ProjectModelsServices {
  return {
    chat: new MemoryChatChannel(),
    clock: new FixedClock(),
    telemetry: noopTelemetry,
    webSearchQueryPiiAllowed: false,
  };
}

function configWith(inflight: number): ProductionConfig<PragmatikaConfig> {
  const env = pragmatikaEnv({ PSEUDONYMIZER_MAX_INFLIGHT: String(inflight) });
  return loadProductionConfig(env) as unknown as ProductionConfig<PragmatikaConfig>;
}

/** Один вызов модели с текстом, который уходит на псевдонимизацию. */
function call(models: ReturnType<typeof projectModels>, index: number): Promise<unknown> {
  return models.complete({
    model: 'alias',
    threadId: `thread-${index}`,
    messages: [{ role: 'user', content: `Запрос номер ${index}` }],
  });
}

describe('PSEUDONYMIZER_MAX_INFLIGHT: шлюз проекта один на сборку', () => {
  test('повторный запрос шлюза отдаёт тот же экземпляр', () => {
    const shared = services();
    const input = { config: configWith(MAX_INFLIGHT), services: shared, alertThreadId: 'owner' };
    const network = new FakeNetwork();
    const first = projectModels(input, { fetchFn: network.fetch });
    const second = projectModels(input);
    expect(second).toBe(first);
    // Другая сборка (другие сервисы) получает свой шлюз.
    expect(projectModels({ ...input, services: services() }, { fetchFn: network.fetch })).not.toBe(
      first,
    );
  });

  test('суммарно через оба пути проекта не больше предела одновременных вызовов', async () => {
    const shared = services();
    const input = { config: configWith(MAX_INFLIGHT), services: shared, alertThreadId: 'owner' };
    const network = new FakeNetwork();
    // Первый путь строит шлюз (адаптеры моделей), второй - обзор почты: оба просят шлюз сборки.
    const viaAdapters = projectModels(input, { fetchFn: network.fetch });
    const viaMailProposals = projectModels(input);
    const calls = Array.from({ length: CALLS_PER_PATH }, (_, index) => [
      call(viaAdapters, index),
      call(viaMailProposals, index + CALLS_PER_PATH),
    ]).flat();
    await Promise.all(calls);
    expect(network.pseudonymizerCalls).toBeGreaterThan(CALLS_PER_PATH);
    expect(network.maxInFlight).toBeGreaterThan(0);
    expect(network.maxInFlight).toBeLessThanOrEqual(MAX_INFLIGHT);
  });
});
