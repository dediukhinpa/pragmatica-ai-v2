import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { DomainError } from '@business-ai/core';
import type { ChatChannel, ChatEventHandler, ChatFile, ChatMessage } from '@business-ai/core';
import {
  assertNoUnresolvedTokens,
  extractFileText,
  findUnresolvedTokens,
  guardOutgoingFiles,
  MAX_UNPACKED_BYTES,
  OutgoingFileCheckError,
  UnresolvedTokensInFileError,
  type OutgoingRefusal,
} from '../../src/outgoing-guard';

const ENCODER = new TextEncoder();
const MIB = 1024 * 1024;
const ZIP_VERSION = 20;
const LOCAL_HEADER_SIZE = 30;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const THREAD = 'thread-1';
const KEY = 'key-1';
const MIME_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MIME_BINARY = 'application/octet-stream';

/** Запись для тестового zip-писателя. */
interface TestZipEntry {
  name: string;
  data: string | Uint8Array;
  /** Заявленный в каталоге размер (для подделки зип-бомбы); по умолчанию настоящий. */
  declaredSize?: number;
  stored?: boolean;
}

/** Минимальный zip-писатель для фикстур: deflate или stored и центральный каталог. */
function buildZip(entries: TestZipEntry[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const raw = typeof entry.data === 'string' ? ENCODER.encode(entry.data) : entry.data;
    const packed = entry.stored === true ? Buffer.from(raw) : deflateRawSync(raw);
    const method = entry.stored === true ? METHOD_STORED : METHOD_DEFLATE;
    const name = Buffer.from(entry.name, 'utf8');
    const size = entry.declaredSize ?? raw.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(ZIP_VERSION, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, packed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(ZIP_VERSION, 4);
    central.writeUInt16LE(ZIP_VERSION, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, centralBytes, end]));
}

/** Файл чата из байтов. */
function fileOf(name: string, content: Uint8Array | string, mimeType = MIME_BINARY): ChatFile {
  const bytes = typeof content === 'string' ? ENCODER.encode(content) : content;
  return { name, mimeType, content: bytes };
}

/** Тело документа Word с абзацами, каждый в своём фрагменте форматирования. */
function wordBody(...paragraphs: string[]): string {
  const body = paragraphs.map((text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`).join('');
  return `<?xml version="1.0"?><w:document><w:body>${body}</w:body></w:document>`;
}

/** docx с телом и дополнительными частями. */
function docx(body: string, extra: TestZipEntry[] = []): ChatFile {
  const parts: TestZipEntry[] = [
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: 'word/document.xml', data: body },
    { name: 'word/media/image1.png', data: new Uint8Array([137, 80, 78, 71]) },
    ...extra,
  ];
  return fileOf('Договор.docx', buildZip(parts), MIME_DOCX);
}

/** Исход проверки: пойманные виды или `ok`. */
async function verdict(file: ChatFile): Promise<string> {
  const text = await extractFileText(file);
  if (text === null) return 'ok';
  const tokens = findUnresolvedTokens(text);
  return tokens.length === 0 ? 'ok' : tokens.join(',');
}

describe('findUnresolvedTokens', () => {
  test('ловит знаки платформы, без повторов, в том числе с падежной пометкой', () => {
    const text = 'Звонить [PHONE_3], писать [EMAIL_2], снова [PHONE_3], директор [PERSON_1|datv]';
    expect(findUnresolvedTokens(text)).toEqual(['[PHONE_3]', '[EMAIL_2]', '[PERSON_1|datv]']);
  });

  test('виды, которых псевдонимизатор не выдаёт, знаком не считаются (артикулы, размеры)', () => {
    expect(findUnresolvedTokens('[PERSON_NAME_12] [XL_2] [ФИО_1] [SKU_7]')).toEqual([]);
  });

  test('наш маркер [ЗАПОЛНИТЬ: ...] знаком не считается', () => {
    const text = 'Договор № [ЗАПОЛНИТЬ: номер договора] от [ЗАПОЛНИТЬ: дата]';
    expect(findUnresolvedTokens(text)).toEqual([]);
  });

  test('обычные квадратные скобки и списки не ловятся', () => {
    expect(findUnresolvedTokens('[1] [abc_1] [A_B] [PHONE_] [x] [PHONE_3a]')).toEqual([]);
  });
});

describe('ошибки отказа', () => {
  test('сообщение называет число и вид, без самих знаков и слов «токен/метка»', () => {
    const error = new UnresolvedTokensInFileError(['[PHONE_3]', '[EMAIL_2]', '[PHONE_4]']);
    expect(error).toBeInstanceOf(DomainError);
    expect(error.code).toBe('validation_failed');
    expect(error.message).toBe(
      'В файле остались неподставленные значения (телефон, e-mail), всего 3. Файл не отправлен.',
    );
    expect(error.message).not.toMatch(/токен|метк|PHONE|\[/i);
    expect(error.kinds).toEqual(['PHONE', 'EMAIL']);
    expect(error.count).toBe(3);
  });

  test('виды ФИО, организация, адрес; неизвестный вид даёт «данные»', () => {
    const error = new UnresolvedTokensInFileError([
      '[PERSON_1]',
      '[ORG_1]',
      '[ADDRESS_1]',
      '[PASSPORT_1]',
      '[SNILS_2]',
    ]);
    expect(error.message).toContain('(ФИО, организация, адрес, данные)');
  });

  test('assertNoUnresolvedTokens: чистый текст проходит, знак в ошибку не попадает', () => {
    expect(() => assertNoUnresolvedTokens('Привет, [ЗАПОЛНИТЬ: имя]')).not.toThrow();
    expect(() => assertNoUnresolvedTokens('Звоните [PHONE_1]')).toThrow(
      UnresolvedTokensInFileError,
    );
    try {
      assertNoUnresolvedTokens('Звоните [PHONE_1]');
    } catch (error) {
      expect((error as Error).message).not.toContain('[PHONE_1]');
    }
  });
});

describe('extractFileText: docx/xlsx/pptx', () => {
  test('знак в теле docx', async () => {
    expect(await verdict(docx(wordBody('Телефон: [PHONE_3]')))).toBe('[PHONE_3]');
  });

  test('знак, разбитый на несколько фрагментов форматирования', async () => {
    const split = '<w:p><w:r><w:t>[EMAIL_</w:t></w:r><w:r><w:t>2]</w:t></w:r></w:p>';
    expect(await verdict(docx(`<w:document>${split}</w:document>`))).toBe('[EMAIL_2]');
  });

  test('знак в колонтитуле, сноске и комментарии', async () => {
    const parts = ['header1', 'footer2', 'footnotes', 'comments'].map((n) => `word/${n}.xml`);
    for (const part of parts) {
      const file = docx(wordBody('Чистый текст'), [{ name: part, data: wordBody('[ORG_1]') }]);
      expect(await verdict(file)).toBe('[ORG_1]');
    }
  });

  test('знак в свойствах документа и в alt-тексте картинки', async () => {
    const props = docx(wordBody('Чисто'), [
      { name: 'docProps/core.xml', data: '<dc:title>Письмо для [PERSON_1]</dc:title>' },
    ]);
    expect(await verdict(props)).toBe('[PERSON_1]');
    const alt = docx('<w:document><wp:docPr id="1" descr="Фото [PERSON_2]"/></w:document>');
    expect(await verdict(alt)).toBe('[PERSON_2]');
  });

  test('знак в записанном сущностями виде', async () => {
    expect(await verdict(docx(wordBody('&#91;PHONE_7&#93; и &#x5B;EMAIL_1&#x5D;')))).toBe(
      '[PHONE_7],[EMAIL_1]',
    );
  });

  test('знак в ячейке xlsx: общие строки, встроенные строки, имя листа', async () => {
    const shared = fileOf(
      'Список.xlsx',
      buildZip([
        { name: 'xl/workbook.xml', data: '<workbook><sheet name="Лист1"/></workbook>' },
        { name: 'xl/sharedStrings.xml', data: '<sst><si><t>Позвонить [PHONE_9]</t></si></sst>' },
      ]),
    );
    expect(await verdict(shared)).toBe('[PHONE_9]');
    const inline = fileOf(
      'Список.xlsx',
      buildZip([
        {
          name: 'xl/worksheets/sheet1.xml',
          data: '<worksheet><c t="inlineStr"><is><t>[EMAIL_4]</t></is></c></worksheet>',
        },
      ]),
    );
    expect(await verdict(inline)).toBe('[EMAIL_4]');
    const sheetName = fileOf(
      'Список.xlsx',
      buildZip([{ name: 'xl/workbook.xml', data: '<sheet name="Клиент [ORG_3]"/>' }]),
    );
    expect(await verdict(sheetName)).toBe('[ORG_3]');
  });

  test('знак в слайде и в заметках pptx', async () => {
    const slide = fileOf(
      'Показ.pptx',
      buildZip([
        { name: 'ppt/slides/slide1.xml', data: '<p:sld><a:p><a:t>[ORG_2]</a:t></a:p></p:sld>' },
      ]),
    );
    expect(await verdict(slide)).toBe('[ORG_2]');
    const notes = fileOf(
      'Показ.pptx',
      buildZip([
        { name: 'ppt/slides/slide1.xml', data: '<a:t>Чисто</a:t>' },
        { name: 'ppt/notesSlides/notesSlide1.xml', data: '<a:t>Позвонить [PHONE_1]</a:t>' },
      ]),
    );
    expect(await verdict(notes)).toBe('[PHONE_1]');
  });

  test('stored-запись (без сжатия) тоже читается', async () => {
    const file = fileOf(
      'Письмо.docx',
      buildZip([{ name: 'word/document.xml', data: wordBody('[PERSON_5]'), stored: true }]),
    );
    expect(await verdict(file)).toBe('[PERSON_5]');
  });

  test('чистый файл проходит', async () => {
    expect(await verdict(docx(wordBody('Договор поставки', 'Сумма 100 000 руб.')))).toBe('ok');
  });

  test('маркер [ЗАПОЛНИТЬ: номер договора] проходит', async () => {
    const file = docx(wordBody('Договор № [ЗАПОЛНИТЬ: номер договора]'));
    expect(await verdict(file)).toBe('ok');
  });

  test('знак вида ORG в теле ловится, артикул вида [XL_2] нет', async () => {
    expect(await verdict(docx(wordBody('Заказчик [ORG_1]')))).toBe('[ORG_1]');
    expect(await verdict(docx(wordBody('Размер [XL_2]')))).toBe('ok');
  });

  test('картинки и бинарные части не мешают и не читаются как текст', async () => {
    const file = docx(wordBody('Чисто'), [
      { name: 'word/media/image2.jpeg', data: ENCODER.encode('[PHONE_1] в картинке') },
    ]);
    expect(await verdict(file)).toBe('ok');
  });
});

describe('extractFileText: отказ при сбое (fail closed)', () => {
  test('битый zip: сигнатура есть, каталога нет', async () => {
    const broken = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    await expect(extractFileText(fileOf('Файл.docx', broken))).rejects.toBeInstanceOf(
      OutgoingFileCheckError,
    );
  });

  test('обрезанный zip', async () => {
    const whole = docx(wordBody('Чисто')).content;
    const cut = whole.subarray(0, whole.length - 30);
    await expect(extractFileText(fileOf('Файл.docx', cut))).rejects.toBeInstanceOf(
      OutgoingFileCheckError,
    );
  });

  test('испорченный deflate-поток', async () => {
    const zip = buildZip([{ name: 'word/document.xml', data: wordBody('Чисто') }]);
    const damaged = Uint8Array.from(zip);
    const dataStart = LOCAL_HEADER_SIZE + 'word/document.xml'.length;
    damaged.fill(0xff, dataStart, dataStart + 8);
    await expect(extractFileText(fileOf('Файл.docx', damaged))).rejects.toBeInstanceOf(
      OutgoingFileCheckError,
    );
  });

  test('зип-бомба: заявленный размер больше предела', async () => {
    const big = new Uint8Array(MAX_UNPACKED_BYTES + MIB);
    const file = fileOf('Бомба.docx', buildZip([{ name: 'word/document.xml', data: big }]));
    await expect(extractFileText(file)).rejects.toMatchObject({ reason: 'archive_too_large' });
  });

  test('зип-бомба с ложным размером в каталоге: предел действует на сам поток', async () => {
    const big = new Uint8Array(MAX_UNPACKED_BYTES + MIB);
    const zip = buildZip([{ name: 'word/document.xml', data: big, declaredSize: 10 }]);
    await expect(extractFileText(fileOf('Бомба.docx', zip))).rejects.toMatchObject({
      reason: 'archive_too_large',
    });
  });

  test('зип-бомба из многих частей: суммарный предел', async () => {
    const part = new Uint8Array(MAX_UNPACKED_BYTES / 4 + MIB);
    const entries = [1, 2, 3, 4].map((n) => ({ name: `word/part${n}.xml`, data: part }));
    await expect(extractFileText(fileOf('Бомба.docx', buildZip(entries)))).rejects.toMatchObject({
      reason: 'archive_too_large',
    });
  });

  test('слишком много записей', async () => {
    const entries = Array.from({ length: 5000 }, (_, n) => ({ name: `a/${n}.bin`, data: 'x' }));
    await expect(extractFileText(fileOf('Много.zip', buildZip(entries)))).rejects.toMatchObject({
      reason: 'archive_too_large',
    });
  });

  test('сообщение отказа проверки без служебных слов', () => {
    const error = new OutgoingFileCheckError('broken_archive');
    expect(error).toBeInstanceOf(DomainError);
    expect(error.message).toBe('Не удалось проверить файл перед отправкой. Файл не отправлен.');
    expect(error.message).not.toMatch(/токен|метк/i);
  });
});

describe('extractFileText: текст, сырые форматы, диск', () => {
  test('txt/csv/md/json: UTF-8 и BOM', async () => {
    for (const name of ['a.txt', 'a.csv', 'a.md', 'a.json']) {
      expect(await verdict(fileOf(name, 'ФИО;телефон\nИван;[PHONE_1]'))).toBe('[PHONE_1]');
    }
    const bom = Uint8Array.from([0xef, 0xbb, 0xbf, ...ENCODER.encode('[EMAIL_1]')]);
    expect(await verdict(fileOf('a.csv', bom))).toBe('[EMAIL_1]');
    expect(await verdict(fileOf('a.txt', 'Всё чисто, [ЗАПОЛНИТЬ: дата]'))).toBe('ok');
  });

  test('UTF-16 с BOM', async () => {
    const body = Buffer.from('﻿[ORG_1]', 'utf16le');
    expect(await verdict(fileOf('a.txt', new Uint8Array(body)))).toBe('[ORG_1]');
  });

  test('PDF и прочие форматы: сырые байты', async () => {
    const pdf = '%PDF-1.4\n1 0 obj\n<< /Title ([ORG_1]) >>\nendobj\n%%EOF';
    expect(await verdict(fileOf('Счёт.pdf', pdf, 'application/pdf'))).toBe('[ORG_1]');
    expect(await verdict(fileOf('Счёт.pdf', '%PDF-1.4\nчисто', 'application/pdf'))).toBe('ok');
    expect(await verdict(fileOf('Файл.bin', 'xx [PERSON_2] yy'))).toBe('[PERSON_2]');
  });

  test('старый .doc: текст в UTF-16 и в обоих выравниваниях', async () => {
    const even = new Uint8Array(Buffer.from('[PHONE_5]', 'utf16le'));
    const odd = Uint8Array.from([0x01, ...even]);
    expect(await verdict(fileOf('Старый.doc', even))).toBe('[PHONE_5]');
    expect(await verdict(fileOf('Старый.doc', odd))).toBe('[PHONE_5]');
  });

  test('пустой файл: проверять нечего', async () => {
    expect(await extractFileText(fileOf('Пусто.txt', new Uint8Array()))).toBeNull();
  });

  test('файл на диске читается по пути', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'outgoing-guard-'));
    const path = join(dir, 'Таблица.docx');
    try {
      writeFileSync(path, docx(wordBody('Звонить [PHONE_8]')).content);
      const disk = { path, size: 1, dispose: async () => undefined };
      const file: ChatFile = { ...fileOf('Таблица.docx', '', MIME_DOCX), disk };
      expect(await verdict(file)).toBe('[PHONE_8]');
      const missing = { ...disk, path: join(dir, 'нет.docx') };
      await expect(extractFileText({ ...file, disk: missing })).rejects.toBeInstanceOf(
        OutgoingFileCheckError,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('файл на диске с собственным дескриптором шары читается порциями', async () => {
    const bytes = ENCODER.encode('Письмо [EMAIL_6]');
    let closed = false;
    let position = 0;
    const disk = {
      path: '/не/читается/по/пути',
      size: bytes.length,
      dispose: async () => undefined,
      open: async () => ({
        read: async (buffer: Uint8Array): Promise<number> => {
          const chunk = bytes.subarray(position, position + 4);
          buffer.set(chunk);
          position += chunk.length;
          return chunk.length;
        },
        close: async () => {
          closed = true;
        },
      }),
    };
    const file: ChatFile = { ...fileOf('Письмо.txt', '', 'text/plain'), disk };
    expect(await verdict(file)).toBe('[EMAIL_6]');
    expect(closed).toBe(true);
  });
});

/** Канал-пустышка: считает вызовы и помнит `this`. */
class FakeChat implements ChatChannel {
  readonly calls: string[] = [];
  readonly files: string[] = [];
  handler: ChatEventHandler | undefined;
  typing = async (threadId: string): Promise<void> => {
    this.calls.push(`typing:${threadId}`);
  };

  onEvent(handler: ChatEventHandler): void {
    this.calls.push('onEvent');
    this.handler = handler;
  }

  async reply(threadId: string, message: ChatMessage, key: string): Promise<void> {
    this.calls.push(`reply:${threadId}:${message.text}:${key}`);
  }

  async sendFile(threadId: string, file: ChatFile, key: string): Promise<void> {
    this.calls.push(`sendFile:${threadId}:${key}`);
    this.files.push(file.name);
  }
}

/** Канал только с обязательными методами. */
function minimalChat(sent: string[]): ChatChannel {
  return {
    onEvent: () => undefined,
    reply: async () => undefined,
    sendFile: async (_thread, file) => {
      sent.push(file.name);
    },
  };
}

describe('guardOutgoingFiles', () => {
  test('чистый файл уходит исходному каналу с теми же аргументами', async () => {
    const inner = new FakeChat();
    const chat = guardOutgoingFiles(inner);
    const file = docx(wordBody('Всё чисто'));
    await chat.sendFile(THREAD, file, KEY);
    expect(inner.calls).toEqual([`sendFile:${THREAD}:${KEY}`]);
    expect(inner.files).toEqual(['Договор.docx']);
  });

  test('файл с неподставленным знаком: отказ, исходный sendFile не вызывается', async () => {
    const inner = new FakeChat();
    const refused: OutgoingRefusal[] = [];
    const chat = guardOutgoingFiles(inner, (info) => refused.push(info));
    const file = docx(wordBody('Телефон [PHONE_3], почта [EMAIL_2]'));
    const error = await chat.sendFile(THREAD, file, KEY).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnresolvedTokensInFileError);
    expect((error as Error).message).toBe(
      'В файле остались неподставленные значения (телефон, e-mail), всего 2. Файл не отправлен.',
    );
    expect(inner.calls).toEqual([]);
    expect(refused).toEqual([
      { fileName: 'Договор.docx', kinds: ['PHONE', 'EMAIL'], reason: 'unresolved' },
    ]);
  });

  test('битый файл: отказ с понятным сообщением, ничего не отправлено', async () => {
    const inner = new FakeChat();
    const refused: OutgoingRefusal[] = [];
    const chat = guardOutgoingFiles(inner, (info) => refused.push(info));
    const broken = fileOf('Файл.docx', Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 9, 9, 9, 9]));
    const error = await chat.sendFile(THREAD, broken, KEY).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OutgoingFileCheckError);
    expect(inner.calls).toEqual([]);
    expect(refused[0]?.reason).toBe('unchecked');
  });

  test('сбой обратного вызова журнала не подменяет отказ', async () => {
    const chat = guardOutgoingFiles(new FakeChat(), () => {
      throw new Error('журнал недоступен');
    });
    const error = await chat
      .sendFile(THREAD, fileOf('a.txt', '[ORG_1]'), KEY)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnresolvedTokensInFileError);
  });

  test('reply, typing, onEvent делегируются с сохранением this', async () => {
    const inner = new FakeChat();
    const chat = guardOutgoingFiles(inner);
    const handler: ChatEventHandler = async () => undefined;
    chat.onEvent(handler);
    await chat.reply(THREAD, { text: 'привет' }, KEY);
    await chat.typing?.(THREAD);
    expect(inner.calls).toEqual(['onEvent', `reply:${THREAD}:привет:${KEY}`, `typing:${THREAD}`]);
    expect(inner.handler).toBe(handler);
  });

  test('необязательные методы, которых нет у исходного канала, в обёртке не появляются', () => {
    const chat = guardOutgoingFiles(minimalChat([]));
    expect(chat.typing).toBeUndefined();
    expect(chat.updateMessage).toBeUndefined();
    expect('typing' in chat).toBe(false);
    expect('updateMessage' in chat).toBe(false);
    expect(typeof chat.reply).toBe('function');
  });

  test('без обратного вызова отказ всё равно бросается', async () => {
    const sent: string[] = [];
    const chat = guardOutgoingFiles(minimalChat(sent));
    await expect(chat.sendFile(THREAD, fileOf('a.csv', 'x;[PERSON_1]'), KEY)).rejects.toThrow(
      'неподставленные значения (ФИО)',
    );
    expect(sent).toEqual([]);
    await chat.sendFile(THREAD, fileOf('a.csv', 'x;y'), KEY);
    expect(sent).toEqual(['a.csv']);
  });
});
