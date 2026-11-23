import { beforeEach, describe, expect, test } from 'bun:test';
import {
  DocumentsImageMasker,
  GatewayImageReader,
  HttpImageTextDetector,
  IMAGE_DETECT_TEXT_ROUTE,
  IMAGE_NORMALIZE_ROUTE,
  IMAGE_RECOGNIZE_TEXT_ROUTE,
  MemoryAccessPolicy,
  MemoryBotFileRegistry,
  VISION_ROUTE,
  type FetchFn,
} from '@business-ai/adapters';
import { BUSINESS_CARD_PHOTO_PROMPT } from '../../src/agents/suppliers/prompt';
import { createOrderCalcAgent } from '../../src/agents/order-calc/declaration';
import { createSiteExportAgent } from '../../src/agents/site-export/declaration';
import { createSupplierFromAttachment } from '../../src/agents/suppliers/attachment-create';
import { readChatAttachmentsRecorded } from '../../src/agents/order-calc/read-chat-attachments';
import { type OrderCalcDeps } from '../../src/agents/order-calc/deps';
import { ACTION_CONFIRM_SUPPLIER_CARD } from '../../src/kit/domain/access.owned';
import type { BitrixAttachmentReader } from '@business-ai/core';
import { buildOrderDeps } from './order-support';
import {
  BOT_ORDERS,
  INN_BETA,
  THREAD_A_ORDERS,
  USER_A,
  buildSupplierWorld,
  turnContext,
  type SupplierWorld,
} from './suppliers-support';

/**
 * Фото визитки + «заведи поставщика» (этап 224): фото -> readChatAttachments -> текст с фото
 * (tokens, Tesseract документов) -> createSupplierFromAttachment. Подменены только HTTP-ответы
 * documents и шлюза; ридер, детектор, адаптер, инструмент чтения и инструмент заведения
 * настоящие. Данные визитки вымышленные.
 */

const DOCUMENTS = 'http://documents.test';
const GATEWAY = 'http://gateway.test';
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const CARD_COMPANY = 'ООО «Бета Трейд»';
const CARD_PERSON = 'Орлов Игорь Павлович';
const CARD_PHONE = '+7 (495) 013-57-91';
const CARD_EMAIL = 'orlov@beta-trade.example';
const CARD_TEXT = [
  CARD_COMPANY,
  CARD_PERSON,
  'Коммерческий директор',
  `Тел. ${CARD_PHONE}`,
  CARD_EMAIL,
  `ИНН ${INN_BETA}`,
].join('\n');
/** Всё, что нельзя увидеть в запросах к шлюзу зрения и в журнале. */
const FORBIDDEN = [CARD_PERSON, CARD_PHONE, CARD_EMAIL, INN_BETA, 'Орлов'];

interface Stubs {
  /** Что отвечает /images/recognize-text: тело или статус сбоя. */
  recognize: { body: unknown } | { status: number };
  detect: 'text' | 'no_text';
}

function recognizedBody(text: string, lowConf = 0): unknown {
  return {
    recognized: { text, codes: [], hidden_text: lowConf > 0 },
    stats: { words: 20, low_conf_boxes: lowConf, codes: 0, unreadable_boxes: 0 },
  };
}

interface Rig {
  deps: OrderCalcDeps;
  world: SupplierWorld;
  routes: string[];
  gatewayBodies: string[];
  logs: string[];
  stubs: Stubs;
}

async function buildRig(mode: 'tokens' | 'enforce' = 'tokens'): Promise<Rig> {
  const stubs: Stubs = { recognize: { body: recognizedBody(CARD_TEXT) }, detect: 'text' };
  const routes: string[] = [];
  const gatewayBodies: string[] = [];
  const logs: string[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    routes.push(url.replace(DOCUMENTS, '').replace(GATEWAY, ''));
    if (url === `${DOCUMENTS}${IMAGE_NORMALIZE_ROUTE}`) {
      const file = (init.body as FormData).get('file') as Blob;
      return new Response(await file.arrayBuffer(), {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      });
    }
    if (url === `${DOCUMENTS}${IMAGE_DETECT_TEXT_ROUTE}`) {
      return Response.json({ result: stubs.detect });
    }
    if (url === `${DOCUMENTS}${IMAGE_RECOGNIZE_TEXT_ROUTE}`) {
      return 'status' in stubs.recognize
        ? new Response('{}', { status: stubs.recognize.status })
        : Response.json(stubs.recognize.body);
    }
    if (url === `${GATEWAY}${VISION_ROUTE}`) {
      gatewayBodies.push(String(init.body));
      return Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'фото' }] });
    }
    throw new Error(`неожиданный адрес ${url}`);
  };
  const imageReader = new GatewayImageReader({
    gatewayBaseUrl: GATEWAY,
    documentsBaseUrl: DOCUMENTS,
    apiKey: 'key-1',
    model: 'agent-main',
    fetchFn,
    retry: { maxRetries: 0 },
    log: (event, fields) => void logs.push(`${event} ${JSON.stringify(fields ?? {})}`),
    textGateMode: mode,
    textDetector: new HttpImageTextDetector({ baseUrl: DOCUMENTS, fetchFn }),
    masker: new DocumentsImageMasker({ baseUrl: DOCUMENTS, fetchFn }),
  });
  const registry = new MemoryBotFileRegistry({ clock: { now: () => new Date() } });
  registry.remember(THREAD_A_ORDERS, { botId: 1, fileId: 7, name: 'визитка.jpg' });
  const attachments: BitrixAttachmentReader = {
    async fetchAttachments() {
      return {
        attachments: [{ name: 'визитка.jpg', mime: 'image/jpeg', bytes: JPEG, source: 'bot' }],
        errors: [],
      };
    },
  };
  const base = await buildOrderDeps({ request: null });
  const world = buildSupplierWorld();
  const access = new MemoryAccessPolicy();
  access.allow({ userId: USER_A, botId: BOT_ORDERS, action: ACTION_CONFIRM_SUPPLIER_CARD });
  world.deps.access = access;
  const deps = {
    ...base,
    state: world.state,
    botFiles: registry,
    attachments,
    imageReader,
  } as OrderCalcDeps;
  return { deps, world, routes, gatewayBodies, logs, stubs };
}

const ctx = () => turnContext(USER_A, THREAD_A_ORDERS, BOT_ORDERS);

let rig: Rig;
beforeEach(async () => {
  rig = await buildRig();
});

describe('фото визитки: заведи поставщика', () => {
  test('фото -> imageReads (текст с фото) -> createSupplierFromAttachment: created', async () => {
    const read = await readChatAttachmentsRecorded.execute({}, rig.deps, ctx());
    expect(read.filesInChat).toBe(1);
    expect(read.imageReads).toHaveLength(1);
    const photo = read.imageReads?.[0];
    expect(photo?.status).toBe('ok');
    expect(photo?.text).toBe(`Текст с фото: ${CARD_TEXT}`);
    expect(photo?.unreadable).toBeUndefined();

    const out = await createSupplierFromAttachment.execute(
      { name: CARD_COMPANY, inn: INN_BETA, sourceText: photo?.text ?? '' },
      rig.world.host,
      ctx(),
    );
    expect(out.status).toBe('created');
    const [card] = await rig.world.suppliers.searchCards({ limit: 10 });
    expect(card?.name).toContain('Бета Трейд');
    expect(card?.inn).toBe(INN_BETA);
    // Человек с визитки заведён контактом поставщика: ФИО, должность, телефон, почта.
    expect(card?.contacts).toHaveLength(1);
    expect(card?.contacts[0]).toMatchObject({
      fullName: CARD_PERSON,
      position: 'Коммерческий директор',
      email: CARD_EMAIL,
    });
    expect(card?.contacts[0]?.phone?.replace(/\D/g, '')).toBe('74950135791');
    // Вопрос сотруднику не показывался: карточка создана сразу.
    expect(rig.world.chat.outbox.length).toBe(0);
  });

  test('поставщик уже есть: дубль не создаётся (exists)', async () => {
    const read = await readChatAttachmentsRecorded.execute({}, rig.deps, ctx());
    const input = { name: CARD_COMPANY, inn: INN_BETA, sourceText: read.imageReads?.[0]?.text };
    const first = await createSupplierFromAttachment.execute(input, rig.world.host, ctx());
    expect(first.status).toBe('created');
    const second = await createSupplierFromAttachment.execute(input, rig.world.host, ctx());
    expect(second.status).toBe('exists');
    expect(await rig.world.suppliers.searchCards({ limit: 10 })).toHaveLength(1);
  });

  test('ПДн визитки не уходят в шлюз зрения и в журнал: картинка в модель не идёт', async () => {
    await readChatAttachmentsRecorded.execute({}, rig.deps, ctx());
    // Модель зрения не вызывалась вовсе: уходит только текст, и только через псевдонимизатор.
    expect(rig.gatewayBodies).toHaveLength(0);
    expect(rig.routes).toEqual([
      IMAGE_NORMALIZE_ROUTE,
      IMAGE_DETECT_TEXT_ROUTE,
      IMAGE_RECOGNIZE_TEXT_ROUTE,
    ]);
    const journal = rig.logs.join('\n');
    for (const secret of FORBIDDEN) expect(journal).not.toContain(secret);
    expect(journal).toContain('tokens_sent');
  });

  test('сбой Tesseract (502): честная пометка, пустой текст за распознанный не выдан', async () => {
    rig.stubs.recognize = { status: 502 };
    const read = await readChatAttachmentsRecorded.execute({}, rig.deps, ctx());
    const photo = read.imageReads?.[0];
    expect(photo?.status).toBe('unavailable');
    expect(photo?.unreadable).toBe(true);
    expect(photo?.text).toContain('Фото не отправлено');
    expect(rig.gatewayBodies).toHaveLength(0);
  });

  test('плохо читаемое фото: пометка, не карточка', async () => {
    rig.stubs.recognize = { body: recognizedBody(CARD_TEXT, 15) };
    const read = await readChatAttachmentsRecorded.execute({}, rig.deps, ctx());
    expect(read.imageReads?.[0]?.status).toBe('unavailable');
    expect(read.imageReads?.[0]?.text).toContain('Фото не отправлено');
  });
});

describe('источник маски выключен: прежнее поведение (enforce)', () => {
  test('фото с текстом не уходит в модель, Tesseract документов для текста не зовётся', async () => {
    const legacy = await buildRig('enforce');
    const read = await readChatAttachmentsRecorded.execute({}, legacy.deps, ctx());
    expect(read.imageReads?.[0]?.status).toBe('unavailable');
    expect(read.imageReads?.[0]?.text).toContain('обнаружен текст');
    expect(legacy.routes).not.toContain(IMAGE_RECOGNIZE_TEXT_ROUTE);
    expect(legacy.gatewayBodies).toHaveLength(0);
  });
});

describe('промпт: фото визитки (businessCardPhoto)', () => {
  const agents = {
    'агент заявок': (businessCardPhoto?: boolean) =>
      createOrderCalcAgent({
        model: 'm',
        intake: true,
        supplierCards: businessCardPhoto === undefined ? {} : { businessCardPhoto },
      }),
  };

  for (const [title, make] of Object.entries(agents)) {
    test(`${title}: без опции и с false промпт прежний байт-в-байт`, () => {
      expect(make(false).prompt).toBe(make().prompt);
      expect(make().prompt).not.toContain(BUSINESS_CARD_PHOTO_PROMPT);
    });

    test(`${title}: с опцией правило фото визитки добавлено, инструменты те же`, () => {
      const plain = make();
      const withCard = make(true);
      expect(withCard.prompt).toContain(BUSINESS_CARD_PHOTO_PROMPT);
      expect(withCard.prompt.replace(BUSINESS_CARD_PHOTO_PROMPT, '')).toBe(plain.prompt);
      expect(withCard.tools.map((tool) => tool.name)).toEqual(plain.tools.map((t) => t.name));
    });
  }

  // У сайта «дополнить карточку» привязано к выгрузке («после заполнения файла и отчёта»),
  // правило про визитку ему противоречило бы: оно только у агента заявок.
  test('агент сайта: правило фото визитки не добавляется даже при опции', () => {
    const make = (businessCardPhoto?: boolean) =>
      createSiteExportAgent({
        model: 'm',
        supplierCards: businessCardPhoto === undefined ? {} : { businessCardPhoto },
      });
    expect(make(true).prompt).not.toContain(BUSINESS_CARD_PHOTO_PROMPT);
    expect(make(true).prompt).toBe(make().prompt);
  });

  test('правило: порядок инструментов, exists -> дополнение, честный отказ без выдумок', () => {
    const text = BUSINESS_CARD_PHOTO_PROMPT;
    const order = ['readChatAttachments', 'findSupplierCard', 'createSupplierFromAttachment'];
    const positions = order.map((name) => text.indexOf(name));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(text).toContain('Текст с фото');
    expect(text).toContain('exists');
    expect(text).toContain('enrichSupplierCard');
    expect(text).toContain('Фото не отправлено');
    expect(text).toContain('текстом');
    expect(text).toContain('контактом поставщика');
    expect(text).toContain('contacts');
  });
});
