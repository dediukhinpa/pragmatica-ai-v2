import type { DiskFile, FileEntry } from '@business-ai/core';
import { DomainError, INTAKE_HASH_CHARS, intakeFileName, isIntakePath } from '@business-ai/core';
import { bytesOfBase64 } from '@business-ai/core';
import { findEntry, readState, requirePort, stableHash } from '@business-ai/core';
import { fileRefOf, isFileRef } from './file-ref';
import { MAIL_FILE_NAMESPACE, type PricesDeps } from './deps';
import {
  loadMail,
  type MailAccess,
  mailFileKey,
  mailFileSchema,
  parseMailPath,
  requireState,
  type ImportMeta,
  type PriceSourceKind,
} from './price-state';

/** Файл с прайсом из любого источника: диск, чат сотрудника, вложение письма. */
export interface PriceSource {
  /** Идентификатор для инструментов чтения: путь на диске, id из хранилища или `mail:...`. */
  path: string;
  name: string;
  /** Отпечаток содержимого (для диска и чата) либо письма (для вложений). */
  hash: string;
  kind: PriceSourceKind;
  /** Содержимое; для скана из письма не сохраняется, и чтение бросает ошибку. */
  read(): Promise<Uint8Array>;
  /**
   * Тот же файл на диске, если источник его имеет (файлы от сотрудников): большой прайс уходит
   * в сервис документов потоком, без чтения в память (этап 231). Нет - только {@link read}.
   */
  disk?(): Promise<DiskFile>;
  /** Что известно о происхождении (попадает в `ImportMeta`). */
  meta: ImportMeta;
  /**
   * Для вложения письма: поставщик, которому принадлежит адрес отправителя (сопоставил код
   * при приёме письма); undefined - отправитель не опознан.
   */
  senderSupplierId?: string | undefined;
}

/** Размер источника без чтения в память (только файл на диске); иначе undefined. */
export function sourceSizeOf(source: PriceSource): () => Promise<number | undefined> {
  return async () => (source.disk === undefined ? undefined : (await source.disk()).size);
}

/**
 * Вложение письма разбирается только как прайс поставщика-отправителя: письмо поставщика s1
 * не может стать прайсом s2, какой бы supplierId ни передала модель. Письмо неопознанного
 * отправителя не разбирается вовсе. Для диска и чата поставщика определяет сотрудник.
 */
export function assertSourceSupplier(source: PriceSource, supplierId: string): void {
  if (source.kind !== 'mail') return;
  if (source.senderSupplierId === undefined) {
    throw new DomainError(
      'conflict',
      'Письмо от неопознанного отправителя автоматически не разбирается: сообщите менеджеру.',
    );
  }
  if (source.senderSupplierId !== supplierId) {
    throw new DomainError(
      'conflict',
      `Письмо прислал поставщик ${source.senderSupplierId}: его вложение нельзя разобрать ` +
        `как прайс поставщика ${supplierId}.`,
    );
  }
}

/** Сколько похожих имён подсказывать при `not_found` (а не весь диск). */
export const MAX_SIMILAR_FILE_HINTS = 10;
/** Слова короче этого при сравнении имён не считаются (союзы, номера, даты по частям). */
const MIN_NAME_TOKEN_CHARS = 3;
/** Токен-заместитель ПДн в имени: общий у разных файлов, различать им нечего. */
const PII_TOKEN_WORD = 'person';

/** Слова имени файла для сравнения: без регистра, разделителей, расширения и токенов ПДн. */
function nameTokens(path: string): Set<string> {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  const words = (dot > 0 ? base.slice(0, dot) : base).toLowerCase().split(/[^\p{L}\p{N}]+/u);
  return new Set(
    words.filter((word) => word.length >= MIN_NAME_TOKEN_CHARS && word !== PII_TOKEN_WORD),
  );
}

/** До {@link MAX_SIMILAR_FILE_HINTS} путей диска, делящих с искомым больше всего слов имени. */
async function similarPaths(deps: PricesDeps, path: string): Promise<string[]> {
  const wanted = nameTokens(path);
  if (wanted.size === 0) return [];
  const scored = (await deps.files.list()).flatMap((entry) => {
    const shared = [...nameTokens(entry.path)].filter((word) => wanted.has(word)).length;
    return shared === 0 ? [] : [{ path: entry.path, shared }];
  });
  scored.sort((a, b) => b.shared - a.shared || a.path.localeCompare(b.path));
  return scored.slice(0, MAX_SIMILAR_FILE_HINTS).map((item) => item.path);
}

/** Нормализация имени для сравнения: NFC, пробельные серии в один пробел, без регистра. */
function looseKey(path: string): string {
  return path.normalize('NFC').replace(/\s+/gu, ' ').trim().toLowerCase();
}

/** Токен-заместитель ПДн (`[PERSON_1]`; сравнение идёт после приведения к нижнему регистру). */
const PII_TOKEN = /\[[a-z_]+_\d+\]/gu;

/** Сколько слов может заменять один токен ПДн (фамилия, имя, отчество). */
const MAX_TOKEN_WORDS = 3;

/**
 * Что может стоять в имени файла вместо токена ПДн: от одного до {@link MAX_TOKEN_WORDS} слов
 * через одиночный пробел, без `/` (границы каталога) и без `.` (расширение, дата, инициалы).
 * Иначе токен «съел» бы произвольный кусок имени и подошёл бы чужой файл.
 */
const TOKEN_WORD = '[^/.\\s]+';
const TOKEN_SUBSTITUTION = `${TOKEN_WORD}(?: ${TOKEN_WORD}){0,${MAX_TOKEN_WORDS - 1}}`;

/**
 * Единственный файл диска, который отличается от искомого пути только пробелами, регистром
 * или токеном ПДн вместо фамилии (1-3 слова без `/` и точек). Неоднозначность (0 или 2+
 * совпадений) - не угадываем.
 */
async function looseMatch(deps: PricesDeps, path: string): Promise<FileEntry | null> {
  const parts = looseKey(path).split(PII_TOKEN);
  const escaped = parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
  const pattern = new RegExp(`^${escaped.join(TOKEN_SUBSTITUTION)}$`, 'u');
  const hits = (await deps.files.list()).filter((entry) => pattern.test(looseKey(entry.path)));
  return hits.length === 1 ? (hits[0] ?? null) : null;
}

/** Файл диска по пути; при `not_found` в ошибке - похожие имена (до 10), а не весь диск. */
async function findDiskEntry(deps: PricesDeps, path: string): Promise<FileEntry> {
  try {
    return await findEntry(deps.files, path);
  } catch (error) {
    if (!(error instanceof DomainError) || error.code !== 'not_found') throw error;
    // Модель могла схлопнуть двойные пробелы или оставить токен ПДн вместо фамилии.
    const loose = await looseMatch(deps, path);
    if (loose !== null) return loose;
    const similar = await similarPaths(deps, path);
    if (similar.length === 0) throw error;
    throw new DomainError(
      'not_found',
      `${error.message} Похожие файлы: ${similar.join('; ')}. ` +
        'Возьмите путь из этого списка или найдите файл через listPriceFiles с query.',
    );
  }
}

/**
 * Реальный путь файла диска по непрозрачному `fileRef` (хэш пути, см. {@link fileRefOf}).
 * Разрешается кодом по списку файлов диска: модель путь не переписывает.
 */
async function entryByFileRef(deps: PricesDeps, ref: string): Promise<FileEntry> {
  const entry = (await deps.files.list()).find((item) => fileRefOf(item.path, deps.fileRefSecret) === ref);
  if (entry === undefined) {
    throw new DomainError(
      'not_found',
      'Файл по этому идентификатору не найден (удалён или переименован).',
    );
  }
  return entry;
}

/**
 * Путь, понятный коду: `fileref:<id>` заменяется реальным путём файла диска, остальное
 * возвращается как есть. Нужен инструментам, которые используют путь в тексте или записи.
 */
export async function resolveFileRefPath(deps: PricesDeps, path: string): Promise<string> {
  return isFileRef(path) ? (await entryByFileRef(deps, path)).path : path;
}

/** Хэш из идентификатора хранилища приёма: `<каталог>/<хэш>_<имя>`. */
function intakeHash(path: string): string {
  const tail = path.slice(path.lastIndexOf('/') + 1);
  return tail.slice(0, INTAKE_HASH_CHARS);
}

/**
 * Открыть источник по идентификатору. Три вида: файл с диска (путь источника), файл,
 * присланный сотрудником (id хранилища), вложение письма (`mail:<id>#<номер>`).
 */
export async function openPriceSource(
  deps: PricesDeps,
  path: string,
  access: MailAccess,
): Promise<PriceSource> {
  const { threadId } = access;
  const mail = parseMailPath(path);
  if (mail !== null) return openMailSource(deps, path, mail.messageId, mail.index, access);
  if (isIntakePath(path)) {
    const intake = requirePort(deps.intake, 'файлы от сотрудников');
    const openFile = intake.openFile?.bind(intake);
    const name = intakeFileName(path);
    return {
      path,
      name,
      hash: intakeHash(path),
      kind: 'intake',
      read: () => intake.read(threadId, path),
      // Открытие файла на диске есть не у каждого хранилища приёма (порт его не требует).
      ...(openFile === undefined ? {} : { disk: () => openFile(threadId, path) }),
      meta: { source: 'intake', fileName: name, notes: [] },
    };
  }
  const entry = isFileRef(path) ? await entryByFileRef(deps, path) : await findDiskEntry(deps, path);
  return diskPriceSource(deps, entry);
}

/**
 * Источник «файл сетевого диска». Если хранилище умеет открыть файл по пути, прайс уходит в
 * сервис разбора потоком (`disk`), а не читается в память и не копируется в форму запроса:
 * при десяти прайсах по 20 МБ разом, пока они ждут слот разбора, это экономит ~400 МиБ ядра
 * (этап 239e).
 */
export function diskPriceSource(deps: PricesDeps, entry: FileEntry): PriceSource {
  const open = deps.files.openFile?.bind(deps.files);
  return {
    path: entry.path,
    name: entry.path,
    hash: entry.hash,
    kind: 'disk',
    read: () => deps.files.read(entry.path),
    ...(open === undefined ? {} : { disk: () => open(entry.path) }),
    meta: { source: 'disk', fileName: entry.path, notes: [] },
  };
}

async function openMailSource(
  deps: PricesDeps,
  path: string,
  messageId: string,
  index: number,
  access: MailAccess,
): Promise<PriceSource> {
  const record = await loadMail(deps, messageId, access);
  const attachment = record.attachments.find((item) => item.index === index);
  if (attachment === undefined) {
    throw new DomainError('not_found', `В письме ${messageId} нет вложения ${index}.`);
  }
  return {
    path,
    name: attachment.fileName,
    hash: `mail-${stableHash([messageId, index, attachment.sizeBytes])}`,
    kind: 'mail',
    senderSupplierId: record.supplierId,
    async read() {
      if (!attachment.stored) {
        throw new DomainError('invalid_input', 'Вложение не сохранено (скан или слишком большое).');
      }
      const file = await readState(
        requireState(deps),
        MAIL_FILE_NAMESPACE,
        mailFileKey(messageId, index),
        mailFileSchema,
      );
      if (file === null) throw new DomainError('not_found', 'Содержимое вложения не найдено.');
      return bytesOfBase64(file.base64);
    },
    meta: {
      source: 'mail',
      fileName: attachment.fileName,
      sender: record.from,
      senderVerified: record.senderVerified === true,
      subject: record.subject,
      receivedAt: record.receivedAt,
      notes: [],
    },
  };
}
