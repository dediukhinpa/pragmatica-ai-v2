/**
 * Заглушка шлюза моделей для репетиции переезда: отвечает на `/health` и OpenAI-совместимые
 * маршруты фиксированным текстом. Ничего не запоминает и не пишет в журнал (тела запросов
 * могут нести данные). Запускается на образе app: `bun run model-stub.ts`.
 */

/** Порт по умолчанию, если не задан MODEL_STUB_PORT. */
const DEFAULT_PORT = 4000;
/** Размерность векторов, если запрос не указал свою (размерность базы знаний). */
const DEFAULT_EMBEDDING_DIMENSIONS = 768;
/** Текст ответа заглушки. */
const STUB_REPLY = 'Заглушка шлюза моделей репетиции: настоящая модель не вызывалась.';
/** Алиас модели в ответах, если запрос его не назвал. */
const STUB_MODEL_ALIAS = 'rehearsal-stub';
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const HTTP_BAD_REQUEST = 400;

/** Тело запроса в той части, что заглушке нужна (остальное игнорируется). */
interface StubRequest {
  model?: string;
  stream?: boolean;
  input?: string | string[];
  dimensions?: number;
}

/** Разбирает JSON запроса; не объект или не JSON - пустой запрос. */
async function readBody(request: Request): Promise<StubRequest> {
  try {
    const parsed: unknown = await request.json();
    return typeof parsed === 'object' && parsed !== null ? (parsed as StubRequest) : {};
  } catch {
    return {};
  }
}

/** Ответ чата одним куском. */
function completion(model: string): Response {
  return Response.json(
    {
      id: 'stub-completion',
      object: 'chat.completion',
      created: 0,
      model,
      choices: [
        { index: 0, message: { role: 'assistant', content: STUB_REPLY }, finish_reason: 'stop' },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    },
    { status: HTTP_OK },
  );
}

/** Ответ чата потоком SSE: один кусок с текстом и завершение. */
function completionStream(model: string): Response {
  const chunk = {
    id: 'stub-completion',
    object: 'chat.completion.chunk',
    created: 0,
    model,
    choices: [{ index: 0, delta: { role: 'assistant', content: STUB_REPLY }, finish_reason: null }],
  };
  const last = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
  const events = [JSON.stringify(chunk), JSON.stringify(last), '[DONE]'];
  const body = events.map((event) => `data: ${event}\n\n`).join('');
  return new Response(body, { status: HTTP_OK, headers: { 'content-type': 'text/event-stream' } });
}

/** Векторы нулей по числу входов. */
function embeddings(request: StubRequest, model: string): Response {
  const inputs = Array.isArray(request.input) ? request.input.length : 1;
  const size = request.dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS;
  const data = Array.from({ length: inputs }, (_, index) => ({
    object: 'embedding',
    index,
    embedding: new Array<number>(size).fill(0),
  }));
  const usage = { prompt_tokens: 0, total_tokens: 0 };
  return Response.json({ object: 'list', model, data, usage });
}

/** Запускает заглушку; порт 0 - свободный (тесты). */
export function startStub(port: number): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (request.method === 'GET' && pathname === '/health') {
        return Response.json({ status: 'ok' }, { status: HTTP_OK });
      }
      if (request.method === 'GET' && pathname === '/v1/models') {
        return Response.json({ object: 'list', data: [{ id: STUB_MODEL_ALIAS, object: 'model' }] });
      }
      if (request.method !== 'POST') {
        return Response.json({ error: 'not_found' }, { status: HTTP_NOT_FOUND });
      }
      const body = await readBody(request);
      const model = body.model ?? STUB_MODEL_ALIAS;
      if (pathname === '/v1/chat/completions') {
        return body.stream === true ? completionStream(model) : completion(model);
      }
      if (pathname === '/v1/embeddings') return embeddings(body, model);
      return Response.json({ error: 'not_found' }, { status: HTTP_NOT_FOUND });
    },
    error() {
      return Response.json({ error: 'bad_request' }, { status: HTTP_BAD_REQUEST });
    },
  });
}

if (import.meta.main) {
  const port = Number(process.env.MODEL_STUB_PORT ?? DEFAULT_PORT);
  startStub(port);
}
