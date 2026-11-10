import type {
  Bitrix24PortalStub,
  PortalEnqueued,
  PortalSentMessage,
  PortalUploadedFile,
} from '@business-ai/testing';
import { CHAT_FEEDBACK_PROMPT } from './project-env';
import { WAIT_TIMEOUT_MS } from './handoff-core';

/**
 * Заголовок сообщения о шорт-листе (`shortlistTitleLines`). С коммита 8168ae91 это отдельная
 * строка с заглавной буквы; прежнее вводное «...: шорт-лист поставщиков» убрано. Тесты ищут
 * сообщение по этой константе, а не по своей копии строки.
 */
export const SHORTLIST_TITLE = 'Шорт-лист поставщиков';

/**
 * Имя файла Excel шорт-листа: «Шорт-лист_<название заявки>.xlsx». С коммита 95c28765 в имени
 * название заявки, а не `req-<хэш>`; проверка «не id» сохраняет смысл прежнего ожидания.
 */
export const SHORTLIST_FILE_NAME = /^Шорт-лист_(?!req-).+\.xlsx$/u;

/**
 * Первая строка утренней сводки по заказам. С коммита d3fa423f сводка - «План на день» с
 * названиями заявок (id не показывается), а не «Открытые заказы, по которым мы ждём...».
 */
export const DIGEST_HEADLINE = 'План на день:';
/** Просьба проверить статус в конце сводки (формулировка с коммита d3fa423f, на «вы»). */
export const DIGEST_STATUS_FOOTER = 'Проверьте, пожалуйста, статус по этим заявкам';

/** Пауза между проверками при ожидании ответа, мс. */
const WAIT_PAUSE_MS = 250;
/** Сколько последних строк журнала и сколько знаков строки попадает в сообщение о таймауте. */
const LOG_TAIL = 8;
const TEXT_MAX = 200;

/** Что нужно сотруднику от мира: портал и опрос (мир реализует этот интерфейс). */
export interface EmployeeHost {
  readonly portal: Bitrix24PortalStub;
  /** Опрос портала вручную; в фоновом режиме опрос идёт сам. */
  readonly background: boolean;
  /** Журнал службы: последние строки попадают в сообщение о таймауте ожидания. */
  readonly logs?: readonly string[];
  pollOnce(): Promise<unknown>;
  /** Запомнить имя файла, который прислал сотрудник (имя отдаётся при скачивании). */
  rememberFile(fileId: number, name: string): void;
}

/** Условие на текст: подстрока или предикат. */
export type TextMatcher = string | ((text: string) => boolean);

/** Снимок сообщений бота в диалоге: id сообщения -> текст на момент снимка. */
export type DialogSnapshot = ReadonlyMap<number, string>;

/** Параметры ожидания. */
export interface WaitOptions {
  /** Учитывать только новые или изменённые после снимка сообщения. */
  since?: DialogSnapshot;
  timeoutMs?: number;
}

/** Параметры нажатия кнопки. */
export interface PressOptions {
  /**
   * Чьё сообщение с клавиатурой нажимается: по умолчанию свой диалог. Нажать чужую кнопку
   * (от имени этого сотрудника) - передать владельца сообщения.
   */
  owner?: BitrixEmployee;
}

function matches(matcher: TextMatcher, text: string): boolean {
  return typeof matcher === 'string' ? text.includes(matcher) : matcher(text);
}

function describe(matcher: TextMatcher): string {
  return typeof matcher === 'string' ? `«${matcher}»` : 'по условию';
}

/**
 * Сотрудник портала: пишет боту, нажимает кнопки и присылает файлы через заглушку портала,
 * читает ответы из актуальных записей `sent` (ответ может прийти правкой сообщения, поэтому
 * текст берётся из записи, а не считается по числу сообщений).
 */
export class BitrixEmployee {
  /** Диалог с ботом в Bitrix24: личный чат, id = id сотрудника. */
  readonly dialogId: string;

  constructor(
    readonly userId: number,
    private readonly host: EmployeeHost,
  ) {
    this.dialogId = String(userId);
  }

  /** Id сотрудника строкой: так он виден правилам доступа и тредам (`<бот>/<id>`). */
  get id(): string {
    return String(this.userId);
  }

  /** Тред связки бота и сотрудника, как его видит насос. */
  threadOf(bot: string): string {
    return `${bot}/${this.userId}`;
  }

  /** Написать боту; событие сразу опрашивается (в ручном режиме). */
  async say(bot: string, text: string): Promise<PortalEnqueued> {
    const enqueued = this.host.portal.enqueueMessage(bot, { userId: this.userId, text });
    await this.poll();
    return enqueued;
  }

  /** Прислать файл боту. */
  async sendFile(bot: string, name: string, content: Uint8Array): Promise<PortalEnqueued> {
    const enqueued = this.host.portal.enqueueFile(bot, { userId: this.userId, name, content });
    for (const fileId of enqueued.fileIds) this.host.rememberFile(fileId, name);
    await this.poll();
    return enqueued;
  }

  /**
   * Нажать кнопку по подписи (или началу подписи) на самом свежем сообщении бота, где она есть.
   * Возвращает событие портала.
   */
  async press(bot: string, label: string, options: PressOptions = {}): Promise<PortalEnqueued> {
    const owner = options.owner ?? this;
    const found = owner.findButton(bot, label);
    if (found === null) {
      throw new Error(`нет кнопки «${label}» у бота ${bot} в диалоге ${owner.dialogId}`);
    }
    return this.pressId(bot, found.message.id, found.buttonId);
  }

  /** Нажать кнопку по id сообщения и id кнопки (`COMMAND_PARAMS`). */
  async pressId(bot: string, messageId: number, buttonId: string): Promise<PortalEnqueued> {
    const enqueued = this.host.portal.pressButton(bot, {
      userId: this.userId,
      messageId,
      buttonId,
    });
    await this.poll();
    return enqueued;
  }

  /** Все сообщения бота в диалоге с этим сотрудником (актуальные тексты и клавиатуры). */
  messages(bot: string): PortalSentMessage[] {
    return this.host.portal.sent(bot, this.dialogId);
  }

  /** Тексты ответов бота (без файлов), в порядке отправки. */
  texts(bot: string): string[] {
    return this.messages(bot)
      .filter((message) => message.kind !== 'file')
      .map((message) => message.text);
  }

  /** Блоки `fields.attach` всех сообщений бота в диалоге, в порядке отправки. */
  attachBlocks(bot: string): Array<Record<string, unknown>> {
    const blocks: Array<Record<string, unknown>> = [];
    for (const message of this.messages(bot)) {
      const attach = message.attach;
      if (typeof attach !== 'object' || attach === null) continue;
      const list = Array.isArray(attach) ? attach : (attach as { BLOCKS?: unknown }).BLOCKS;
      if (!Array.isArray(list)) continue;
      for (const block of list) {
        if (typeof block === 'object' && block !== null) {
          blocks.push(block as Record<string, unknown>);
        }
      }
    }
    return blocks;
  }

  /**
   * Карточки вложения (этап 113) плоским текстом: заголовок «N. Поставщик: Имя (источник)» и
   * строки «Название: значение» из GRID. BB-коды убираются. Так сценарии шорт-листа проверяют
   * содержимое карточек так же, как раньше проверяли сплошной текст.
   */
  attachText(bot: string): string {
    const lines: string[] = [];
    for (const block of this.attachBlocks(bot)) {
      const message = block['MESSAGE'];
      const grid = block['GRID'];
      if (typeof message === 'string') {
        const plain = message.replace(/\[\/?[a-z]+(?:=[^\]]*)?\]/giu, '');
        const head = /^(\d+)\.\s*(.+?)\s*·\s*(.+)$/u.exec(plain);
        lines.push(head === null ? plain : `${head[1]}. Поставщик: ${head[2]} (${head[3]})`);
      } else if (Array.isArray(grid)) {
        for (const row of grid as Array<{ NAME?: string; VALUE?: string }>) {
          lines.push(`${row.NAME ?? ''}: ${row.VALUE ?? ''}`);
        }
      }
    }
    return lines.join('\n');
  }

  /**
   * Шорт-лист целиком (этап 113): вводный текст сообщения (средние, призыв выбрать номера) и
   * карточки поставщиков из вложения - в одном тексте.
   */
  shortlistText(bot: string): string {
    const lead = this.texts(bot).find((text) => text.includes(SHORTLIST_TITLE)) ?? '';
    return `${lead}\n${this.attachText(bot)}`;
  }

  /** Ответы бота без служебных предложений оценить ответ (👍/👎 после каждого хода). */
  replies(bot: string): string[] {
    return this.texts(bot).filter((text) => text !== CHAT_FEEDBACK_PROMPT);
  }

  /** Файлы, которые бот прислал этому сотруднику. */
  files(bot: string): PortalUploadedFile[] {
    return this.host.portal.uploads.filter(
      (file) => file.botKey === bot && file.dialogId === this.dialogId,
    );
  }

  /**
   * Подпись -> id кнопки (`COMMAND_PARAMS`) с самого свежего сообщения с клавиатурой. Кнопки
   * оценки ответа (👍/👎) пропускаются, если не попросили `includeFeedback`.
   */
  lastButtons(bot: string, includeFeedback = false): Record<string, string> {
    const withKeyboard = this.messages(bot).filter(
      (message) =>
        message.keyboard !== null && (includeFeedback || message.text !== CHAT_FEEDBACK_PROMPT),
    );
    const last = withKeyboard[withKeyboard.length - 1];
    const entries: Array<[string, string]> = [];
    for (const button of last?.keyboard?.BUTTONS ?? []) {
      if (button.TEXT !== undefined && button.COMMAND_PARAMS !== undefined) {
        entries.push([button.TEXT, button.COMMAND_PARAMS]);
      }
    }
    return Object.fromEntries(entries);
  }

  /** Снимок диалога: нужен, чтобы ждать именно новый или изменённый ответ. */
  snapshot(bot: string): DialogSnapshot {
    return new Map(this.messages(bot).map((message) => [message.id, message.text]));
  }

  /** Сколько сообщений (кроме файлов) бот прислал. */
  count(bot: string): number {
    return this.texts(bot).length;
  }

  /**
   * Ждёт ответ бота с подходящим текстом (в новом сообщении или правкой); в ручном режиме
   * сам опрашивает портал. Возвращает найденный текст.
   */
  async waitText(bot: string, matcher: TextMatcher, options: WaitOptions = {}): Promise<string> {
    const since = options.since;
    const find = (): string | undefined =>
      this.messages(bot)
        .filter((message) => message.kind !== 'file')
        .filter((message) => since === undefined || since.get(message.id) !== message.text)
        .map((message) => message.text)
        .find((text) => matches(matcher, text));
    return this.until(`ответ бота ${bot} ${describe(matcher)}`, bot, find, options.timeoutMs);
  }

  /**
   * Ждёт файл Excel шорт-листа «Шорт-лист_<название заявки>.xlsx» (этап 113, имя - с этапа
   * 125), возвращает файл.
   * Файл уходит отдельным сообщением после карточек.
   */
  async waitShortlistFile(bot: string, options: WaitOptions = {}): Promise<PortalUploadedFile> {
    const find = (): PortalUploadedFile | undefined =>
      this.files(bot).find((file) => /^Шорт-лист_.+\.xlsx$/u.test(file.name));
    const found = await this.until(`файл шорт-листа от бота ${bot}`, bot, find, options.timeoutMs);
    return found;
  }

  /** Ждёт сообщение бота с кнопкой, подпись которой начинается с `label`; возвращает id кнопки. */
  async waitButton(bot: string, label: string, options: WaitOptions = {}): Promise<string> {
    const since = options.since;
    const find = (): string | undefined => {
      const found = this.findButton(bot, label);
      if (found === null) return undefined;
      const wasThere = since?.get(found.message.id) === found.message.text;
      return wasThere ? undefined : found.buttonId;
    };
    return this.until(`кнопка «${label}» у бота ${bot}`, bot, find, options.timeoutMs);
  }

  /** Ждёт файл от бота с подходящим именем; возвращает запись загрузки. */
  async waitFile(
    bot: string,
    matcher: TextMatcher,
    options: Pick<WaitOptions, 'timeoutMs'> = {},
  ): Promise<PortalUploadedFile> {
    const find = (): PortalUploadedFile | undefined =>
      this.files(bot).find((file) => matches(matcher, file.name));
    return this.until(`файл от бота ${bot} ${describe(matcher)}`, bot, find, options.timeoutMs);
  }

  /** Самое свежее сообщение с кнопкой `label` (по началу подписи) и id этой кнопки. */
  private findButton(
    bot: string,
    label: string,
  ): { message: PortalSentMessage; buttonId: string } | null {
    for (const message of [...this.messages(bot)].reverse()) {
      const button = message.keyboard?.BUTTONS.find(
        (item) =>
          item.TEXT !== undefined &&
          item.TEXT.startsWith(label) &&
          item.COMMAND_PARAMS !== undefined,
      );
      if (button?.COMMAND_PARAMS !== undefined) {
        return { message, buttonId: button.COMMAND_PARAMS };
      }
    }
    return null;
  }

  /** Что было в диалоге и журнале к моменту таймаута: без этого причину не разобрать. */
  private context(bot: string): string {
    const texts = this.texts(bot).map((text) => text.slice(0, TEXT_MAX));
    const logs = (this.host.logs ?? []).slice(-LOG_TAIL).map((line) => line.slice(0, TEXT_MAX));
    return (
      `\nДиалог ${bot}/${this.userId}: ${JSON.stringify(texts)}` +
      `\nЖурнал (хвост): ${JSON.stringify(logs)}`
    );
  }

  private async poll(): Promise<void> {
    if (!this.host.background) await this.host.pollOnce();
  }

  private async until<T>(
    what: string,
    bot: string,
    find: () => T | undefined,
    timeoutMs: number = WAIT_TIMEOUT_MS,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = find();
      if (found !== undefined) return found;
      if (Date.now() > deadline) throw new Error(`Не дождались: ${what}${this.context(bot)}`);
      await this.poll();
      await Bun.sleep(WAIT_PAUSE_MS);
    }
  }
}
