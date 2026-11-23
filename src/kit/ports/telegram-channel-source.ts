import type { WebModelOptions } from './web-candidate-model';

/**
 * Пост закрытого Telegram-канала. Автора и подписи поста нет намеренно: источник отдаёт только
 * то, что нужно для поиска поставщика. Текст поста - недоверенные данные внешнего источника.
 */
export interface TelegramPost {
  /** Канал, из которого пост (имя из настройки сервиса чтения). */
  channel: string;
  /** Номер сообщения в канале: вместе с каналом однозначно называет пост. */
  messageId: number;
  /** Дата поста, ISO 8601. */
  date: string;
  text: string;
  /** Ссылка на пост, если сервис её знает (у закрытого канала бывает только `t.me/c/...`). */
  link?: string | undefined;
}

/** Необязательные условия поиска. */
export interface TelegramSearchOptions {
  /** Сигнал отмены хода: поиск обрывается вместе с ним. */
  signal?: AbortSignal | undefined;
}

/**
 * Поиск по сообщениям закрытого Telegram-канала (чтение от пользовательского аккаунта,
 * MTProto). Реальный сервис чтения стоит на зарубежном шлюзе: с РФ-сервера Telegram недоступен.
 */
export interface TelegramChannelSource {
  /**
   * Найти посты по запросу; не более `limit`, самые подходящие и свежие первыми. Пустой запрос
   * даёт пустой результат. Недоступность сервиса - DomainError('external_failure').
   */
  search(query: string, limit: number, options?: TelegramSearchOptions): Promise<TelegramPost[]>;
}

/** Пост для разбора: исходный текст (очистку от ПДн делает адаптер) и позиции заявки. */
export interface TelegramPostInput {
  text: string;
  /** Названия позиций заявки: по ним ищется цена в посте (данных заявки сверх них нет). */
  items: string[];
}

/**
 * Разбор поста моделью: название поставщика, город, цены по позициям, срок. Идёт через
 * `PseudonymizingModelGateway`; текст поста перед моделью очищается кодом от телефонов, почты,
 * ФИО и адресов. Ответ - сырой JSON: проверяет вызывающий код. Контакты в нём не ожидаются,
 * их достаёт код из исходного текста.
 */
export interface TelegramPostExtractor {
  /** Сырой объект от модели; `null` - пост модели не отдавался или ответ не JSON. */
  extract(post: TelegramPostInput, options: WebModelOptions): Promise<unknown>;
}
