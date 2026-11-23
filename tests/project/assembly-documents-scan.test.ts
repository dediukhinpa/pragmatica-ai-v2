import { afterAll, describe, expect, test } from 'bun:test';
import { MemoryChatChannel, MemoryCrm } from '@business-ai/adapters';
import type {
  BitrixAttachment,
  DocumentParser,
  ImageAttachment,
  ImageReader,
  ImageReadItem,
  ProjectAgents,
} from '@business-ai/core';
import { composeProduction, type ProductionConfig } from '@business-ai/core/compose';
import { loadProductionConfig, removeTempDirs } from '@business-ai/testing';
import { pragmatikaProject, type PragmatikaConfig } from '../../src';
import {
  buildAttachmentContext,
  readImages,
} from '../../src/agents/order-calc/attachment-context';
import { DOCUMENTS_AGENT_ID } from '../../src/agents/documents/deps';
import { ORDER_CALC_AGENT_ID } from '../../src/agents/order-calc';
import { PRICES_AGENT_ID } from '../../src/agents/prices/deps';
import { nullDb, pragmatikaEnv } from './support';

afterAll(removeTempDirs);

/**
 * Скан PDF в чате «Документов» (баг с боя 23.11): реквизиты счёта должны дойти до агента, а
 * прайс-скан у прайсов и заявок читается как раньше (таблицей). Сервис разбора и модель зрения
 * подменены, сети нет; данные синтетические.
 */

const INVOICE_FILE = 'scan-invoice.pdf';
const PRICE_FILE = 'scan-price.pdf';
const INN = '7700000001';
const BIK = '044525001';
const ACCOUNT = '40702810900000000001';
const KIND_OK = 'ok';

/**
 * Страница скана счёта как её отдаёт чтение изображений в режиме tokens: распознанный текст
 * одним куском, без markdown-таблицы (таблица позиций идёт обычными строками).
 */
const INVOICE_PAGE_TEXT = [
  'Текст на изображении: Счёт на оплату № 15',
  `ИНН ${INN} КПП 770001001`,
  `БИК ${BIK}, р/с ${ACCOUNT}`,
  'Наименование Кол-во Цена',
  'Ручка 10 25',
].join('\n');
const PRICE_PAGE_TEXT = ['| Товар | Цена |', '|---|---|', '| Блокнот | 40 |'].join('\n');

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/** Ответ сервиса разбора: скан без текстового слоя, страница отдаётся картинкой. */
function scanResponse(fileName: string, extractImages: boolean): unknown {
  const images = extractImages
    ? [
        {
          index: 1,
          placeholder: '',
          mime: 'image/png',
          bytes_b64: Buffer.from(fileName).toString('base64'),
          location: 'страница 1',
          rendered: true,
        },
      ]
    : undefined;
  return {
    format: 'pdf',
    markdown: '',
    sections: [],
    needs_ocr: true,
    has_hidden_content: false,
    warnings: [],
    ...(images === undefined ? {} : { images }),
  };
}

/** Подмена `fetch` сервиса разбора: возвращает только сканы, считает запросы. */
function fakeParseService(requests: string[]) {
  return async (_url: string, init: RequestInit): Promise<Response> => {
    const form = init.body as FormData;
    const file = form.get('file') as File;
    requests.push(file.name);
    return Response.json(scanResponse(file.name, form.get('extract_images') === 'true'));
  };
}

/** Зрение: страница счёта читается текстом (как в режиме tokens), прайса - таблицей. */
function fakeImageReader(): ImageReader {
  return {
    async describe(images: readonly ImageAttachment[]) {
      const items = images.map(
        (image): ImageReadItem => ({
          name: image.name,
          source: image.source,
          status: KIND_OK,
          text: image.name.includes('invoice') ? INVOICE_PAGE_TEXT : PRICE_PAGE_TEXT,
        }),
      );
      return { items, usage: { inputTokens: 0, outputTokens: 0, images: images.length } };
    },
  };
}

/** Разборщик документов в зависимостях агента. */
interface ParserHost {
  parser?: DocumentParser;
}

/** Разборщик агента из собранных зависимостей. */
function parserOf(deps: ProjectAgents['deps'], agentId: string): DocumentParser {
  const parser = (deps[agentId] as ParserHost | undefined)?.parser;
  if (parser === undefined) throw new Error(`у агента ${agentId} нет разборщика`);
  return parser;
}

/** Собрать приложение Прагматики и вернуть зависимости агентов. */
function assemble(requests: string[], imageReader: ImageReader): ProjectAgents['deps'] {
  let captured: ProjectAgents | undefined;
  const project = {
    ...pragmatikaProject,
    agents: (ctx: Parameters<typeof pragmatikaProject.agents>[0]) => {
      captured = pragmatikaProject.agents(ctx);
      return captured;
    },
  };
  const config = loadProductionConfig(pragmatikaEnv()) as unknown as ProductionConfig<
    PragmatikaConfig
  >;
  const db = nullDb();
  const extra = pragmatikaProject.ports?.({ config, portal: undefined, db });
  composeProduction(
    config,
    {
      chat: new MemoryChatChannel(),
      crm: new MemoryCrm(new Map()),
      imageReader,
      ...(extra ? { extra } : {}),
    },
    project,
    { db, fetchFn: fakeParseService(requests) },
  );
  if (captured === undefined) throw new Error('агенты не собраны');
  return captured.deps;
}

function attachment(name: string): BitrixAttachment {
  return { name, mime: 'application/pdf', bytes: encode(name), source: 'bot' } as BitrixAttachment;
}

/** Что агент увидит в чтении файла: текст разделов и распознанные страницы. */
async function agentReading(
  parser: DocumentParser,
  reader: ImageReader,
  name: string,
): Promise<string> {
  const context = await buildAttachmentContext(
    { attachments: [attachment(name)], errors: [] },
    parser,
    { maxChars: 100_000 },
  );
  const reads = await readImages(context.images, reader);
  return [
    ...context.sections.map((section) => section.text),
    ...reads.map((read) => read.text),
    ...context.notes,
  ].join('\n');
}

describe('сборка: скан PDF у агента «Документы»', () => {
  test('счёт-скан: в чтении агента документов есть ИНН, БИК и р/с', async () => {
    const requests: string[] = [];
    const reader = fakeImageReader();
    const deps = assemble(requests, reader);
    const parser = parserOf(deps, DOCUMENTS_AGENT_ID);
    const reading = await agentReading(parser, reader, INVOICE_FILE);
    expect(reading).toContain(INN);
    expect(reading).toContain(BIK);
    expect(reading).toContain(ACCOUNT);
    expect(reading).not.toContain('скан PDF не поддержан');
    // Разбор и страницы - один запрос к сервису разбора, без повторного.
    expect(requests).toEqual([INVOICE_FILE]);
  });

  test('прайс-скан у «Прайсов»: таблица распознана, как раньше (режим table)', async () => {
    const reader = fakeImageReader();
    const deps = assemble([], reader);
    const parser = parserOf(deps, PRICES_AGENT_ID);
    const parsed = await parser.parse(PRICE_FILE, encode(PRICE_FILE));
    expect(parsed.needsOcr).toBe(false);
    expect(parsed.tables).toEqual([
      [
        ['Товар', 'Цена'],
        ['Блокнот', '40'],
      ],
    ]);
  });

  test('заявки не затронуты: разборщик прайсов и заявок один и тот же', () => {
    const deps = assemble([], fakeImageReader());
    expect(parserOf(deps, ORDER_CALC_AGENT_ID)).toBe(parserOf(deps, PRICES_AGENT_ID));
    expect(parserOf(deps, DOCUMENTS_AGENT_ID)).not.toBe(parserOf(deps, PRICES_AGENT_ID));
  });
});
