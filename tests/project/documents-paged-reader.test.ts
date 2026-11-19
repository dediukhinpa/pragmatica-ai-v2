import { beforeEach, describe, expect, test } from 'bun:test';
import { DomainError } from '@business-ai/core';
import { readAttachmentText } from '../../src/agents/suppliers/document-source-text';
import {
  PAGED_CACHE_MAX_ENTRIES,
  PAGED_DEFAULT_PART_CHARS,
  PAGED_FILE_ABSOLUTE_MAX_CHARS,
  PAGED_MAX_PART_CHARS,
  PAGED_READER_PROMPT,
  PAGED_READER_TOOL,
  PagedReadCache,
  pagedReadCache,
  readChatAttachmentsPaged,
} from '../../src/documents-paged-reader';
import {
  buildPagedRig,
  schedulerContext,
  syntheticContract,
  type PagedRig,
  type RigOptions,
} from './support-paged-reader';

/**
 * Постраничное чтение файлов чата (этап 8y): длинный договор читается целиком, частями; то, что
 * не прочитано, названо в unread. Данные синтетические (вымышленные стороны и номера).
 */

const CONTRACT_SIZE = 40_000;
const TAIL_MARK = 'ПОДПИСИ СТОРОН';
const MANY_PARTS_LIMIT = 50;
const SMALL_PART = 1_000;
/** Тестовый кэш: часы и размеры задаются руками. */
const TEST_TTL_MS = 1_000;
/** Диапазон старшей половины суррогатной пары UTF-16. */
const HIGH_SURROGATE_FROM = 0xd800;
const HIGH_SURROGATE_TO = 0xdbff;

type Result = Awaited<ReturnType<typeof readChatAttachmentsPaged.execute>>;
type Part = NonNullable<Result['part']>;

beforeEach(() => {
  pagedReadCache.clear();
});

function call(rig: PagedRig, input: Record<string, unknown> = {}): Promise<Result> {
  return readChatAttachmentsPaged.execute(input, rig.deps, rig.context());
}

/** Прочитать файл до isLast, вернуть все части подряд. */
async function readAll(rig: PagedRig, input: Record<string, unknown> = {}): Promise<Part[]> {
  const parts: Part[] = [];
  let next: Record<string, unknown> = input;
  for (let step = 0; step < MANY_PARTS_LIMIT; step += 1) {
    const result = await call(rig, next);
    const part = result.part;
    if (part === null) throw new Error('части нет');
    parts.push(part);
    if (part.nextOffset === null) return parts;
    next = { ...input, offset: part.nextOffset };
  }
  throw new Error('файл не кончился за разумное число частей');
}

const rigOf = (options: RigOptions): PagedRig => buildPagedRig(options);

describe('readChatAttachmentsPaged: части файла', () => {
  test('имя инструмента и абзац промпта называют друг друга', () => {
    expect(readChatAttachmentsPaged.name).toBe(PAGED_READER_TOOL);
    expect(PAGED_READER_PROMPT).toContain('readChatAttachmentsPaged');
    expect(PAGED_READER_PROMPT).toContain('unread');
    expect(PAGED_READER_PROMPT.trim().split('\n').length).toBeLessThanOrEqual(6);
  });

  test('файл 40 000 знаков читается 3-4 частями, склейка равна исходному тексту', async () => {
    const text = syntheticContract(CONTRACT_SIZE);
    const rig = rigOf({ files: [{ name: 'договор.pdf', text }] });
    const parts = await readAll(rig);
    expect(parts.length).toBeGreaterThanOrEqual(3);
    expect(parts.length).toBeLessThanOrEqual(4);
    // Без потерь и без дублей: части идут подряд, склейка совпадает с текстом файла.
    expect(parts.map((part) => part.text).join('')).toBe(text);
    let expectedOffset = 0;
    for (const part of parts) {
      expect(part.offset).toBe(expectedOffset);
      expect(part.text.length).toBeLessThanOrEqual(PAGED_DEFAULT_PART_CHARS);
      expect(part.totalChars).toBe(text.length);
      expectedOffset += part.text.length;
    }
    const last = parts[parts.length - 1];
    expect(last?.nextOffset).toBeNull();
    expect(last?.isLast).toBe(true);
    expect(last?.text).toContain(TAIL_MARK);
    // Промежуточные части не помечены последними и ведут к следующей.
    for (const part of parts.slice(0, -1)) {
      expect(part.isLast).toBe(false);
      expect(part.nextOffset).toBe(part.offset + part.text.length);
    }
  });

  test('части режутся по переводу строки, когда он рядом', async () => {
    const rig = rigOf({ files: [{ name: 'договор.txt', text: syntheticContract(CONTRACT_SIZE) }] });
    const parts = await readAll(rig);
    for (const part of parts.slice(0, -1)) expect(part.text.endsWith('\n')).toBe(true);
  });

  test('первый вызов: непрочитанное названо в unread, дальше instruction с offset', async () => {
    const text = syntheticContract(CONTRACT_SIZE);
    const rig = rigOf({ files: [{ name: 'договор.pdf', text }] });
    const first = await call(rig);
    expect(first.unread).toHaveLength(1);
    expect(first.unread[0]).toContain('договор.pdf');
    expect(first.unread[0]).toContain(`${text.length - (first.part?.text.length ?? 0)}`);
    expect(first.instruction).toContain(`из ${text.length} знаков`);
    expect(first.instruction).toContain(`offset=${first.part?.nextOffset}`);
    expect(first.files).toEqual([
      {
        name: 'договор.pdf',
        totalChars: text.length,
        readUntil: first.part?.text.length ?? 0,
        complete: false,
        truncated: false,
      },
    ]);
  });

  test('после последней части: файл прочитан целиком, unread пуст', async () => {
    const rig = rigOf({ files: [{ name: 'договор.pdf', text: syntheticContract(CONTRACT_SIZE) }] });
    const parts = await readAll(rig);
    const again = await call(rig, { offset: parts[parts.length - 1]?.offset });
    expect(again.instruction).toContain('Файл прочитан целиком');
    expect(again.unread).toEqual([]);
    expect(again.files[0]?.complete).toBe(true);
    expect(again.files[0]?.readUntil).toBe(again.files[0]?.totalChars);
  });

  test('maxChars задаёт размер части; суррогатные пары не рвутся', async () => {
    const text = '😀 договор 😀\n'.repeat(400).trim();
    const rig = rigOf({ files: [{ name: 'смайлы.txt', text }] });
    const parts = await readAll(rig, { maxChars: 501 });
    expect(parts.map((part) => part.text).join('')).toBe(text);
    for (const part of parts) {
      expect(part.text.length).toBeLessThanOrEqual(501);
      // Часть не кончается половиной суррогатной пары.
      const lastCode = part.text.charCodeAt(part.text.length - 1);
      expect(lastCode >= HIGH_SURROGATE_FROM && lastCode <= HIGH_SURROGATE_TO).toBe(false);
    }
  });

  test('maxChars вне 500..24 000 отклоняется схемой', async () => {
    const rig = rigOf({ files: [{ name: 'a.txt', text: 'x'.repeat(SMALL_PART) }] });
    await expect(call(rig, { maxChars: PAGED_MAX_PART_CHARS + 1 })).rejects.toBeInstanceOf(
      DomainError,
    );
    await expect(call(rig, { maxChars: 10 })).rejects.toBeInstanceOf(DomainError);
    const small = await call(rig, { maxChars: 500 });
    expect(small.part?.text.length).toBeLessThanOrEqual(500);
  });
});

describe('readChatAttachmentsPaged: кэш и запоминание', () => {
  test('порт парсера и скачивание вызваны один раз на все части', async () => {
    const rig = rigOf({ files: [{ name: 'договор.pdf', text: syntheticContract(CONTRACT_SIZE) }] });
    const parts = await readAll(rig);
    expect(parts.length).toBeGreaterThan(1);
    expect(rig.calls.parses).toBe(1);
    expect(rig.calls.fetches).toBe(1);
  });

  test('параллельные вызовы ждут один разбор', async () => {
    const rig = rigOf({ files: [{ name: 'договор.pdf', text: syntheticContract(CONTRACT_SIZE) }] });
    await Promise.all([call(rig), call(rig, { offset: PAGED_DEFAULT_PART_CHARS })]);
    expect(rig.calls.parses).toBe(1);
  });

  test('сбой скачивания не кэшируется: повтор читает заново', async () => {
    const rig = rigOf({
      files: [{ name: 'договор.pdf', text: 'Текст договора' }],
      fetchError: 'не удалось скачать файл «сбой.pdf»',
    });
    const first = await call(rig);
    expect(first.unread.join('\n')).toContain('не удалось скачать файл');
    await call(rig);
    expect(rig.calls.fetches).toBe(2);
  });

  test('прочитанные части запоминаются для дополнения карточки поставщика', async () => {
    const rig = rigOf({ files: [{ name: 'договор.pdf', text: syntheticContract(CONTRACT_SIZE) }] });
    expect(await readAttachmentText(rig.state, rig.threadId)).toBe('');
    await readAll(rig);
    const recorded = await readAttachmentText(rig.state, rig.threadId);
    expect(recorded).toContain(TAIL_MARK);
    expect(recorded).toContain('ДОГОВОР ПОСТАВКИ № 7');
  });

  test('кэш: срок жизни, число записей и объём ограничены', () => {
    let now = 0;
    const read = (chars: number) => ({
      files: [{ name: 'a', text: 'x'.repeat(chars), truncated: false, readUntil: 0 }],
      notes: [],
      failures: [],
      imageFailures: [],
      cacheable: true,
    });
    const cache = new PagedReadCache({
      now: () => now,
      ttlMs: TEST_TTL_MS,
      maxEntries: 2,
      maxChars: 100,
    });
    cache.set('a', read(10));
    cache.set('b', read(10));
    cache.set('c', read(10));
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeDefined();
    expect(cache.size).toBe(2);
    // Слишком большое для кэша не кладётся.
    cache.set('big', read(101));
    expect(cache.get('big')).toBeUndefined();
    // Суммарный объём: новая запись вытесняет самую старую.
    cache.set('d', read(80));
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('d')).toBeDefined();
    now += TEST_TTL_MS;
    expect(cache.get('d')).toBeUndefined();
    expect(cache.size).toBe(0);
    expect(PAGED_CACHE_MAX_ENTRIES).toBeGreaterThan(1);
  });
});

describe('readChatAttachmentsPaged: предел и неполный разбор', () => {
  test('файл длиннее абсолютного предела: хвост назван в unread, не молча', async () => {
    const text = 'п. 1. Строка договора.\n'.repeat(
      Math.ceil((PAGED_FILE_ABSOLUTE_MAX_CHARS + 50_000) / 23),
    ).trim();
    const rig = rigOf({ files: [{ name: 'огромный.txt', text }] });
    const first = await call(rig, { maxChars: PAGED_MAX_PART_CHARS });
    expect(first.files[0]?.truncated).toBe(true);
    expect(first.files[0]?.totalChars).toBe(PAGED_FILE_ABSOLUTE_MAX_CHARS);
    expect(first.unread.join('\n')).toContain('хвост файла НЕ прочитан');
    const last = await call(rig, { offset: PAGED_FILE_ABSOLUTE_MAX_CHARS - 100 });
    expect(last.part?.isLast).toBe(true);
    expect(last.part?.nextOffset).toBeNull();
    expect(last.part?.sourceTruncated).toBe(true);
    expect(last.instruction).toContain('НЕ прочитан');
    // Даже прочитав всё доступное, файл не complete, а unread не пуст.
    expect(last.files[0]?.complete).toBe(false);
    expect(last.unread.join('\n')).toContain('хвост файла НЕ прочитан');
  });

  test('парсер разобрал файл не целиком: то же предупреждение', async () => {
    const rig = rigOf({
      files: [{ name: 'договор.pdf', text: 'Короткий текст' }],
      parserTruncated: true,
    });
    const result = await call(rig);
    expect(result.part?.isLast).toBe(true);
    expect(result.part?.sourceTruncated).toBe(true);
    expect(result.files[0]?.complete).toBe(false);
    expect(result.unread.join('\n')).toContain('неполный разбор');
  });
});

describe('readChatAttachmentsPaged: несколько файлов и пустой чат', () => {
  const files = [
    { name: 'приложение.txt', text: 'Приложение 1. Спецификация.\nПозиция А: 10 шт.' },
    { name: 'договор.pdf', text: syntheticContract(CONTRACT_SIZE) },
  ];

  test('без fileName берётся первый непрочитанный, затем следующий', async () => {
    const rig = rigOf({ files });
    const first = await call(rig);
    expect(first.part?.fileName).toBe('приложение.txt');
    expect(first.part?.isLast).toBe(true);
    expect(first.files.map((file) => file.complete)).toEqual([true, false]);
    // Первый файл прочитан: unread называет второй, instruction зовёт дочитать остальное.
    expect(first.unread.join('\n')).toContain('договор.pdf');
    expect(first.instruction).toContain('«договор.pdf»');
    const second = await call(rig);
    expect(second.part?.fileName).toBe('договор.pdf');
    expect(second.part?.offset).toBe(0);
    const third = await call(rig);
    expect(third.part?.fileName).toBe('договор.pdf');
    // Без offset чтение продолжается с места остановки, а не сначала.
    expect(third.part?.offset).toBe(second.part?.nextOffset ?? -1);
  });

  test('fileName выбирает файл: точно, без регистра, по вхождению', async () => {
    const rig = rigOf({ files });
    expect((await call(rig, { fileName: 'договор.pdf' })).part?.fileName).toBe('договор.pdf');
    expect((await call(rig, { fileName: 'ДОГОВОР.PDF' })).part?.fileName).toBe('договор.pdf');
    expect((await call(rig, { fileName: 'приложен' })).part?.fileName).toBe('приложение.txt');
    // С fileName offset по умолчанию 0.
    expect((await call(rig, { fileName: 'договор.pdf' })).part?.offset).toBe(0);
  });

  test('неизвестное или неоднозначное имя - понятная ошибка со списком файлов', async () => {
    const rig = rigOf({ files });
    const missing = call(rig, { fileName: 'нет такого.docx' });
    await expect(missing).rejects.toBeInstanceOf(DomainError);
    await expect(call(rig, { fileName: 'нет такого.docx' })).rejects.toThrow('договор.pdf');
    const ambiguous = rigOf({
      files: [
        { name: 'договор_1.txt', text: 'Один' },
        { name: 'договор_2.txt', text: 'Два' },
      ],
    });
    await expect(call(ambiguous, { fileName: 'договор' })).rejects.toBeInstanceOf(DomainError);
  });

  test('два файла с одним именем различимы: второй получает номер', async () => {
    const rig = rigOf({
      files: [
        { name: 'договор.txt', text: 'Первый' },
        { name: 'договор.txt', text: 'Второй' },
      ],
    });
    const result = await call(rig);
    expect(result.files.map((file) => file.name)).toEqual(['договор.txt', 'договор.txt (2)']);
    expect((await call(rig, { fileName: 'договор.txt (2)' })).part?.text).toBe('Второй');
  });

  test('пустой чат: части нет, файлов нет, понятная фраза', async () => {
    const rig = rigOf({ files: [] });
    const result = await call(rig);
    expect(result.filesInChat).toBe(0);
    expect(result.files).toEqual([]);
    expect(result.part).toBeNull();
    expect(result.unread).toEqual([]);
    expect(result.instruction).toContain('нет файлов');
  });

  test('нет порта вложений: читать нечего, без сбоя', async () => {
    const rig = rigOf({ files: [{ name: 'a.txt', text: 'x' }], noAttachments: true });
    const result = await call(rig);
    expect(result.part).toBeNull();
    expect(result.filesInChat).toBe(0);
  });

  test('не ход сотрудника в чате: отказ', async () => {
    const rig = rigOf({ files });
    await expect(
      readChatAttachmentsPaged.execute({}, rig.deps, schedulerContext(rig.threadId)),
    ).rejects.toBeInstanceOf(DomainError);
  });
});

describe('readChatAttachmentsPaged: offset за пределами', () => {
  test('offset за концом файла - ошибка с длиной файла', async () => {
    const text = syntheticContract(SMALL_PART);
    const rig = rigOf({ files: [{ name: 'a.txt', text }] });
    const bad = call(rig, { offset: text.length });
    await expect(bad).rejects.toBeInstanceOf(DomainError);
    await expect(call(rig, { offset: text.length + 5 })).rejects.toThrow(
      `в нём ${text.length} знаков`,
    );
    // Ошибка прогресс не сдвигает: файл по-прежнему не прочитан.
    const ok = await call(rig, { offset: 0 });
    expect(ok.part?.text).toBe(text);
  });

  test('пропущенный кусок не считается прочитанным', async () => {
    const text = syntheticContract(CONTRACT_SIZE);
    const rig = rigOf({ files: [{ name: 'a.txt', text }] });
    const skipped = await call(rig, { offset: PAGED_DEFAULT_PART_CHARS * 2 });
    expect(skipped.files[0]?.readUntil).toBe(0);
    expect(skipped.unread.join('\n')).toContain('не прочитано');
  });
});

describe('readChatAttachmentsPaged: сканы', () => {
  test('ридера нет: причина дословно в unread и imageReads, части нет', async () => {
    const rig = rigOf({ files: [{ name: 'скан.pdf', scanPages: 2 }], noImageReader: true });
    const result = await call(rig);
    expect(result.part).toBeNull();
    expect(result.imageReads?.every((read) => read.status === 'unavailable')).toBe(true);
    const unread = result.unread.join('\n');
    expect(unread).toContain('скан.pdf (стр. 1)');
    expect(unread).toContain('распознавание изображений не настроено');
    expect(result.instruction).toContain('unread');
  });

  test('парсер не отдаёт страницы: причина из пометки скана попадает в unread', async () => {
    const rig = rigOf({ files: [{ name: 'скан.pdf', scanPages: 2 }], pageImages: false });
    const result = await call(rig);
    expect(result.part).toBeNull();
    expect(result.attachmentNotes?.join('\n')).toContain('скан PDF не поддержан');
    expect(result.unread.join('\n')).toContain('скан PDF не поддержан');
  });

  test('ридер вернул причину отказа: она дословно в unread', async () => {
    const rig = rigOf({
      files: [{ name: 'скан.pdf', scanPages: 1 }],
      pageAnswer: () => ({ status: 'unavailable', text: '', note: 'сервис чтения занят' }),
    });
    const result = await call(rig);
    expect(result.part).toBeNull();
    expect(result.unread.join('\n')).toContain('сервис чтения занят');
  });

  test('скан распознан: страницы собраны в текст файла и читаются частями', async () => {
    const rig = rigOf({
      files: [{ name: 'скан.pdf', scanPages: 3 }],
      pageAnswer: (index) => ({ status: 'ok', text: `Реквизиты, страница ${index + 1}` }),
    });
    const result = await call(rig);
    expect(result.part?.fileName).toBe('скан.pdf');
    expect(result.part?.text).toContain('[скан.pdf (стр. 1)]');
    expect(result.part?.text).toContain('Реквизиты, страница 3');
    expect(result.part?.isLast).toBe(true);
    expect(result.imageReads).toBeUndefined();
    expect(result.unread).toEqual([]);
    // Распознавание платное: на следующих вызовах оно не повторяется.
    await call(rig, { offset: 0 });
    expect(rig.calls.imageReads).toBe(1);
  });

  test('одна страница скана не распознана: пропуск виден в тексте и в unread', async () => {
    const rig = rigOf({
      files: [{ name: 'скан.pdf', scanPages: 2 }],
      pageAnswer: (index) =>
        index === 1
          ? { status: 'unavailable', text: '', note: 'страница нечитаема' }
          : { status: 'ok', text: 'Страница с реквизитами' },
    });
    const result = await call(rig);
    expect(result.part?.text).toContain('(не распознано: страница нечитаема)');
    expect(result.unread.join('\n')).toContain('страница нечитаема');
    expect(result.imageReads).toHaveLength(1);
  });
});
