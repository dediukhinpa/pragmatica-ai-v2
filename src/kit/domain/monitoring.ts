/** Пояс бизнеса по умолчанию (`BUSINESS_TIMEZONE` не задан). */
export const DEFAULT_BUSINESS_TIMEZONE = 'Europe/Moscow';
/**
 * Рабочие дни недели (0 - воскресенье): пн-пт. Праздничного календаря нет - известное
 * ограничение: в праздничный будний день сводка тоже уходит.
 */
export const WORKING_WEEKDAYS: readonly number[] = [1, 2, 3, 4, 5];

/** Локальный час, с которого уходит сводка по заказам. */
export const ORDER_DIGEST_HOUR = 9;
/**
 * Сколько дней с отправки запроса заказ без КП показывается в утренней сводке по отдельности
 * (`ORDER_DIGEST_OPEN_MAX_DAYS`, решение владельца 27.10.2026); старше - одной строкой с числом.
 */
export const ORDER_DIGEST_OPEN_MAX_DAYS = 14;
/** Сколько заказов перечисляется в одной сводке (остаток - числом). */
export const ORDER_DIGEST_MAX_ORDERS_LISTED = 20;

/** День недели еженедельной проверки диска (ТЗ, п. 7.1): понедельник. */
export const PRICE_FILE_CHECK_WEEKDAY = 1;
/** Локальный час, с которого в понедельник уходит проверка диска (ТЗ, п. 7.1). */
export const PRICE_FILE_CHECK_HOUR = 9;
/** Сколько файлов перечисляется в одном сообщении (остаток - числом). */
export const PRICE_FILE_MAX_LISTED = 50;

/** Как часто просматриваются письма с триггерами о ценах, дней. */
export const PRICE_MAIL_TRIGGER_INTERVAL_DAYS = 3;
/** Допущение: локальный час просмотра писем с триггерами. */
export const PRICE_MAIL_TRIGGER_CHECK_HOUR = 10;
/** Письма старше этого числа дней при первом просмотре ящика пропускаются. */
export const PRICE_MAIL_TRIGGER_MAX_AGE_DAYS = 7;
