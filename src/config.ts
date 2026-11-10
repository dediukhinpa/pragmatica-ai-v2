import { z } from 'zod';
import { DIRECTORY_DEPARTMENT_PREFIX } from '@business-ai/core';
import { emptyAsUnset, flag, positiveInt, splitList } from '@business-ai/core/compose';
import { DEFAULT_PRICE_MIN_COSINE } from './kit/adapters/postgres/price-repository';
import {
  PRICE_STALE_PREFIX_SEPARATOR,
  validatePriceStalePattern,
} from './kit/domain/price-stale-scope';
import { DEFAULT_BUSINESS_TIMEZONE, ORDER_DIGEST_OPEN_MAX_DAYS } from './kit/domain/monitoring';
import { DOCUMENT_KINDS } from './kit/domain/models';
import { parseContractRegistryPath } from './agents/documents/contract-registry';
import { DEFAULT_CONTRACT_TIMEOUT_MS } from './kit/adapters/http/http-contract-amender';
import {
  WEB_ENRICH_CONCURRENCY,
  WEB_ENRICH_MAX_CANDIDATES,
  WEB_ENRICH_MAX_QUERIES,
  WEB_SEARCH_PER_TURN_WITH_ENRICH,
} from './agents/order-calc/web-enrichment';
import { PRICE_RELEVANCE_MAX_NAMES } from './agents/order-calc/price-relevance';
import {
  TELEGRAM_SEARCH_MAX_POSTS_DEFAULT,
  TELEGRAM_SEARCH_MAX_POSTS_LIMIT,
} from './agents/order-calc/telegram-source';
import {
  SUPPLIER_MAIL_BACKFILL_WINDOW_DAYS,
  SUPPLIER_MAIL_MAX_CLASSIFY_PER_RUN,
} from './agents/suppliers/mail-enrich';
import {
  SUPPLIER_MAIL_PROPOSALS_CHECK_HOUR,
  SUPPLIER_MAIL_PROPOSALS_INTERVAL_DAYS,
  SUPPLIER_MAIL_PROPOSALS_MAX_CLASSIFY_PER_RUN,
  SUPPLIER_MAIL_PROPOSALS_WINDOW_DAYS,
} from './agents/suppliers/mail-proposals';
import {
  DEFAULT_TELEGRAM_SEARCH_TIMEOUT_MS,
} from './kit/adapters/http/http-telegram-channel-source';
import { DEFAULT_SUPPLIER_ATTACHMENT_MAX_PER_RUN } from './agents/prices/price-mail-triggers';

/**
 * Алиасы моделей агентов проекта: id агента -> переменная окружения (алиасы LiteLLM).
 * Значения по умолчанию намеренно нет: модель задаёт владелец.
 */
export const PRAGMATIKA_MODELS = {
  prices: 'PRICES_MODEL',
  documents: 'DOCUMENTS_MODEL',
  'order-calc': 'ORDER_CALC_MODEL',
  'site-export': 'SITE_EXPORT_MODEL',
} as const;

/** Разделитель списка отделов и id сотрудников. */
const ID_LIST_SEPARATOR = ',';
/** Разделитель названий и реквизитов наших юрлиц: в названиях бывают запятые. */
const OWN_COMPANY_SEPARATOR = ';';
/** Последний допустимый час суток для часа обзора почты. */
const MAX_HOUR_OF_DAY = 23;
/** Отдел в настройке: `department:<id>` либо числовой id отдела портала. */
const STAFF_DEPARTMENT_PATTERN = /^(?:department:)?\d{1,15}$/;
/** Числовой id сотрудника портала. */
const USER_ID_PATTERN = /^\d{1,15}$/;
/** Путь к файлу-шаблону поставщиков в образе по умолчанию. */
export const DEFAULT_SUPPLIER_TEMPLATE_PATH = '/app/templates/supplier-template.xlsx';

/** Булев флаг, включённый по умолчанию (`false` выключает). */
const flagOn = () => emptyAsUnset(z.enum(['true', 'false']).default('true'));

/** Проверка IANA-пояса; значение в текст ошибки не попадает. */
export function isValidTimeZone(timeZone: string): boolean {
  if (timeZone.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Путь к шаблону сайта: относительный, из непустых сегментов без «.» и «..», расширение .xlsx.
 * Ранний отказ при запуске с понятным сообщением вместо отказа при первой просьбе сотрудника.
 */
export function isSiteTemplatePath(value: string): boolean {
  if (value.startsWith('/') || value.includes('\\') || !/\.xlsx$/i.test(value)) return false;
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/** Карта полей сделки: JSON в строке; значение в сообщение об ошибке не попадает. */
const dealFieldMapEnvSchema = z.string().transform((raw, ctx): unknown => {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    ctx.addIssue({ code: 'custom', message: 'некорректный JSON' });
    return z.NEVER;
  }
});

/** Предметные переменные окружения Прагматики (платформенные описаны в пакете платформы). */
export const pragmatikaConfigSchema = z.object({
  /** Виды документов, которые готовит агент «Подготовка документов»; не задано - все. */
  DOCUMENTS_ENABLED_KINDS: emptyAsUnset(
    splitList(',').pipe(z.array(z.enum(DOCUMENT_KINDS)).min(1)).optional(),
  ),
  /** Договорные ручки documents (classify, party-block, amend): срок включает ожидание места. */
  DOCUMENTS_CONTRACT_TIMEOUT_MS: positiveInt(DEFAULT_CONTRACT_TIMEOUT_MS),
  /** Корень прайсов (диск К): прайсы и реестр договоров, только чтение. */
  PRICES_FILES_ROOT: z.string().min(1),
  /** Корень шаблонов документов и шаблона сайта, только чтение. */
  TEMPLATES_FILES_ROOT: z.string().min(1),
  TEMPLATES_PREFIX: z.string().optional(),
  /** Папка реестров договоров: `files:<путь>` или `templates:<путь>`; пусто - только поиск. */
  CONTRACT_REGISTRY_PATH: emptyAsUnset(
    z
      .string()
      .refine(
        (value) => parseContractRegistryPath(value) !== undefined,
        'CONTRACT_REGISTRY_PATH: files:<путь> или templates:<путь>, без «..» и абсолютных путей',
      )
      .optional(),
  ),
  /** Чистый шаблон заказчика для «Актуализации сайта»: .xlsx от корня шаблонов. */
  SITE_TEMPLATE_PATH: emptyAsUnset(
    z
      .string()
      .min(1)
      .refine(isSiteTemplatePath, 'SITE_TEMPLATE_PATH: относительный путь к .xlsx под корнем')
      .optional(),
  ),
  /**
   * Прежнее имя треда оператора. Платформа читает `OWNER_THREAD_ID`; здесь необязательный
   * синоним: задан - им пользуются агенты Прагматики, иначе тредом владельца платформы.
   */
  MANAGER_THREAD_ID: emptyAsUnset(z.string().min(1).optional()),
  /** Тред ответственного за прайсы и сайт; не задан - владелец работы, иначе менеджер. */
  PRICE_RESPONSIBLE_THREAD_ID: emptyAsUnset(
    z.preprocess(
      (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
      z.string().min(1).optional(),
    ),
  ),
  /** Отделы для адресной недельной сводки по устаревшим прайсам (через запятую). */
  PRICE_STAFF_DEPARTMENT: emptyAsUnset(
    splitList(ID_LIST_SEPARATOR)
      .pipe(
        z.array(
          z
            .string()
            .regex(STAFF_DEPARTMENT_PATTERN, 'ожидается department:<id> или числовой id отдела')
            .transform((value) =>
              value.startsWith(DIRECTORY_DEPARTMENT_PREFIX)
                ? value
                : `${DIRECTORY_DEPARTMENT_PREFIX}${value}`,
            ),
        ),
      )
      // Один отдел в двух записях (`22` и `department:22`) - одна группа.
      .transform((groups) => [...new Set(groups)])
      .optional(),
  ),
  /** Отдельные сотрудники сверх отделов для сопоставления по фамилии в пути. */
  PRICE_STAFF_EXTRA_USER_IDS: emptyAsUnset(
    splitList(ID_LIST_SEPARATOR)
      .pipe(z.array(z.string().regex(USER_ID_PATTERN, 'ожидается числовой id сотрудника')))
      .transform((ids) => [...new Set(ids)])
      .optional(),
  ),
  /** Бот пишет первым сотруднику, не открывавшему диалог (тред по id портала). */
  PRICE_RECIPIENT_OPEN_THREAD: flag(),
  /** Область еженедельной проверки устаревших прайсов: префиксы путей (пусто - весь корень). */
  PRICE_STALE_SCAN_PREFIXES: emptyAsUnset(splitList(PRICE_STALE_PREFIX_SEPARATOR).optional()),
  /** Регулярное выражение по сегментам пути: подходящие файлы из проверки исключаются. */
  PRICE_STALE_EXCLUDE_PATTERN: emptyAsUnset(
    z
      .string()
      .refine((value) => validatePriceStalePattern(value) === null, {
        message: 'некорректное регулярное выражение',
      })
      .optional(),
  ),
  /** Прайс = слово «прайс»/«price» в имени ИЛИ таблица цен в начале разобранного текста. */
  PRICE_STALE_CONTENT_CHECK: flag(),
  /** Сотрудники, которые не бывают получателями недельной сводки (системные учётки). */
  PRICE_RECIPIENT_EXCLUDE_IDS: emptyAsUnset(
    splitList(ID_LIST_SEPARATOR)
      .pipe(z.array(z.string().regex(USER_ID_PATTERN, 'ожидается числовой id сотрудника')))
      .optional(),
  ),
  /** Названия наших юрлиц через «;» (названия содержат запятые). */
  OWN_COMPANY_NAMES: splitList(OWN_COMPANY_SEPARATOR).pipe(z.array(z.string()).min(1)),
  /** Реквизиты наших юрлиц через «;»: значения, которые нельзя писать в карточку поставщика. */
  OWN_COMPANY_REQUISITES: emptyAsUnset(splitList(OWN_COMPANY_SEPARATOR).optional()),
  /** Передача задач «Поиск поставщика» -> «Актуализация прайса» через очередь. */
  AGENT_HANDOFF_ORDER_CALC_TO_PRICES: flag(),
  /** Синхронный вызов агента как инструмента (долговечные шаги, права, аудит). */
  AGENT_CALL_ENABLED: flag(),
  /**
   * Карта полей сделки (JSON). Платформа карту не читает: значение проверяется как JSON и
   * сохранено для совместимости окружения (см. отчёт: пробел платформы).
   */
  BITRIX24_DEAL_FIELD_MAP: emptyAsUnset(dealFieldMapEnvSchema.optional()),
  /** Инструменты приёма заявки (из текста, ссылки на задачу или сделку). */
  ORDER_CALC_INTAKE_ENABLED: flag(),
  /** Проверка полноты запроса до поиска поставщиков. */
  ORDER_CALC_COMPLETENESS_ENABLED: flag(),
  /** Ответ на утреннее напоминание «План на день» (нужна утренняя сводка). */
  ORDER_REMINDER_REPLY_ENABLED: flag(),
  /** Режим «дополнить присланный договор исполнителя». */
  DOCUMENTS_COUNTERPARTY_AMEND_ENABLED: flag(),
  /** Наши реквизиты из БД (таблица own_legal_entities). */
  OWN_REQUISITES_DB_ENABLED: flag(),
  /** Чей ящик читает плановый разбор прайс-почты (запуск не от сотрудника). */
  PRICES_MAILBOX_OWNER_USER_ID: emptyAsUnset(z.string().min(1).optional()),
  /** Запасной разбор даты из названия прайса моделью. */
  PRICE_FILE_DATE_MODEL_FALLBACK: flag(),
  /** Оценка моделью поверх кодового фильтра прайс-писем; действует только при почте. */
  PRICE_MAIL_ASSESSOR_ENABLED: flagOn(),
  /** Правка описаний выгрузочной таблицы сайта моделью. */
  SITE_TEXT_EDITOR_ENABLED: flag(),
  /** Предел писем поставщиков с таблицей без триггеров на оценку за прогон просмотра. */
  PRICE_MAIL_SUPPLIER_ATTACHMENT_MAX_PER_RUN: positiveInt(
    DEFAULT_SUPPLIER_ATTACHMENT_MAX_PER_RUN,
  ),
  /** Рейтинг поставщика в шорт-листе вместе с моделью. */
  SUPPLIER_RATING_MODEL_ENABLED: flagOn(),
  /** Шорт-лист менеджеру карточками-вложениями. */
  SHORTLIST_ATTACH_ENABLED: flagOn(),
  /** Файл Excel «Шорт-лист_<заявка>.xlsx» вслед за шорт-листом. */
  SHORTLIST_XLSX_ENABLED: flagOn(),
  /** Веб-поиск поставщиков с моделью. */
  WEB_SEARCH_MODEL_ENABLED: flagOn(),
  /** Классификация хитов веб-выдачи одним вызовом модели. */
  WEB_HIT_CLASSIFY_ENABLED: flagOn(),
  /** Выбор сайта поставщика и страниц моделью. */
  SUPPLIER_SITE_MODEL_ENABLED: flagOn(),
  /** Проверка строк прайсов моделью. */
  PRICE_RELEVANCE_ENABLED: flagOn(),
  /** Сколько разных названий строк прайсов уходит на проверку по одной позиции. */
  PRICE_RELEVANCE_MAX_NAMES: emptyAsUnset(positiveInt(PRICE_RELEVANCE_MAX_NAMES)),
  /** Порог косинусной близости векторной ветки поиска по прайсам (0..1). */
  PRICE_SEARCH_MIN_COSINE: emptyAsUnset(
    z.coerce.number().min(0).max(1).default(DEFAULT_PRICE_MIN_COSINE),
  ),
  /** Бюджет обогащения веб-кандидатов. */
  WEB_ENRICH_MAX_CANDIDATES: emptyAsUnset(positiveInt(WEB_ENRICH_MAX_CANDIDATES)),
  WEB_ENRICH_MAX_QUERIES: emptyAsUnset(positiveInt(WEB_ENRICH_MAX_QUERIES)),
  WEB_ENRICH_CONCURRENCY: emptyAsUnset(positiveInt(WEB_ENRICH_CONCURRENCY)),
  /** Обогащение карточек поставщиков базы через интернет. */
  WEB_ENRICH_SUPPLIERS_ENABLED: emptyAsUnset(z.enum(['true', 'false']).default('false')),
  /** Закрытый Telegram-канал как источник поиска поставщиков. */
  TELEGRAM_CHANNEL_SOURCE_ENABLED: emptyAsUnset(flag()),
  /** Bearer-токен службы чтения канала; обязателен при включённом источнике. */
  TELEGRAM_READER_TOKEN: emptyAsUnset(z.string().min(1).optional()),
  /** Сколько постов канала брать в разбор за одну сборку шорт-листа. */
  TELEGRAM_SEARCH_MAX_POSTS: emptyAsUnset(
    positiveInt(TELEGRAM_SEARCH_MAX_POSTS_DEFAULT).pipe(
      z.number().max(TELEGRAM_SEARCH_MAX_POSTS_LIMIT),
    ),
  ),
  /** Предел ожидания ответа сервиса чтения канала, мс. */
  TELEGRAM_SEARCH_TIMEOUT_MS: emptyAsUnset(positiveInt(DEFAULT_TELEGRAM_SEARCH_TIMEOUT_MS)),
  /** Адрес сервиса чтения канала; не задан - шлюз моделей. */
  TELEGRAM_READER_BASE_URL: emptyAsUnset(z.string().url().optional()),
  /** Каналы, которыми ограничен поиск (через запятую); не заданы - всеми. */
  TELEGRAM_CHANNELS: emptyAsUnset(splitList(',').optional()),
  /** Поисков за один ход агента (общий лимитер). */
  WEB_SEARCH_MAX_PER_TURN: emptyAsUnset(positiveInt(WEB_SEARCH_PER_TURN_WITH_ENRICH)),
  /** Карточки поставщиков: инструменты, кнопки, загрузка файлом, личные заметки. */
  SUPPLIER_CARDS_ENABLED: flag(),
  /** Выгрузка базы поставщиков файлом xlsx (требует SUPPLIER_CARDS_ENABLED). */
  SUPPLIER_EXPORT_ENABLED: flag(),
  /** Файл xlsx-шаблона для кнопки «Шаблон». */
  SUPPLIER_TEMPLATE_PATH: emptyAsUnset(z.string().min(1).default(DEFAULT_SUPPLIER_TEMPLATE_PATH)),
  /** Синхронизация цен с диска (диск - источник правды). */
  PRICE_DISK_SYNC_ENABLED: flag(),
  /** Первичный импорт существующих прайсов с диска (только вместе с синхронизацией). */
  PRICE_DISK_INITIAL_IMPORT_ENABLED: flag(),
  /** Адрес ящика-источника для разового прохода по общему ящику (команда, не служба). */
  INFO_MAILBOX_ENRICH_ADDRESS: emptyAsUnset(z.string().trim().min(1).optional()),
  /** Обращений к модели за один запуск команды разового прохода. */
  INFO_MAILBOX_ENRICH_MAX_CLASSIFY_PER_RUN: emptyAsUnset(
    positiveInt(SUPPLIER_MAIL_MAX_CLASSIFY_PER_RUN),
  ),
  /** Окно разового прохода, дней. */
  INFO_MAILBOX_ENRICH_WINDOW_DAYS: emptyAsUnset(positiveInt(SUPPLIER_MAIL_BACKFILL_WINDOW_DAYS)),
  /** Обзор почты сотрудников: предложения завести карточки. */
  SUPPLIER_MAIL_PROPOSALS_ENABLED: emptyAsUnset(flag()),
  SUPPLIER_MAIL_PROPOSALS_AUTO_ENRICH_ENABLED: emptyAsUnset(flag()),
  /** Раз в сколько суток просматривать почту. */
  SUPPLIER_MAIL_PROPOSALS_INTERVAL_DAYS: emptyAsUnset(
    positiveInt(SUPPLIER_MAIL_PROPOSALS_INTERVAL_DAYS),
  ),
  /** Не раньше какого часа (0-23) по `BUSINESS_TIMEZONE` начинается проход. */
  SUPPLIER_MAIL_PROPOSALS_CHECK_HOUR: emptyAsUnset(
    z.coerce.number().int().min(0).max(MAX_HOUR_OF_DAY).default(SUPPLIER_MAIL_PROPOSALS_CHECK_HOUR),
  ),
  /** За сколько суток читаются письма. */
  SUPPLIER_MAIL_PROPOSALS_WINDOW_DAYS: emptyAsUnset(
    positiveInt(SUPPLIER_MAIL_PROPOSALS_WINDOW_DAYS),
  ),
  /** Оценок моделью за сутки на все ящики. */
  SUPPLIER_MAIL_PROPOSALS_MAX_CLASSIFY_PER_RUN: emptyAsUnset(
    positiveInt(SUPPLIER_MAIL_PROPOSALS_MAX_CLASSIFY_PER_RUN),
  ),
  /** Признак «поставщик» - тип компании CRM (код вроде `SUPPLIER`). */
  CRM_SUPPLIERS_COMPANY_TYPE: emptyAsUnset(
    z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_]{1,50}$/)
      // Коды COMPANY_TYPE в Bitrix24 заглавные или цифровые.
      .transform((value) => value.toUpperCase())
      .optional(),
  ),
  /** Признак «поставщик» - категория компаний CRM (id воронки). */
  CRM_SUPPLIERS_CATEGORY_ID: emptyAsUnset(z.coerce.number().int().positive().optional()),
  /** Сколько дней открытый заказ без КП показывается в утренней сводке отдельной строкой. */
  ORDER_DIGEST_OPEN_MAX_DAYS: emptyAsUnset(positiveInt(ORDER_DIGEST_OPEN_MAX_DAYS)),
  /** Часовой пояс бизнеса (IANA): по нему считаются рабочий день и час проверок. */
  BUSINESS_TIMEZONE: emptyAsUnset(
    z.string().refine(isValidTimeZone).default(DEFAULT_BUSINESS_TIMEZONE),
  ),
});

/** Разобранные предметные переменные Прагматики. */
export type PragmatikaConfig = z.infer<typeof pragmatikaConfigSchema>;

/** Что нужно кросс-проверке из платформенной конфигурации. */
export interface PlatformFacts {
  employeeMailboxEnabled: boolean;
}

/**
 * Проверки, которым нужны сразу несколько переменных. В схеме их не выразить: предметная схема
 * разбирается отдельно от платформенной. Возвращает имена переменных с ошибками (значения в
 * текст не попадают).
 */
export function crossCheckErrors(project: PragmatikaConfig, platform: PlatformFacts): string[] {
  const errors: string[] = [];
  if (project.SUPPLIER_EXPORT_ENABLED === 'true' && project.SUPPLIER_CARDS_ENABLED !== 'true') {
    errors.push('SUPPLIER_EXPORT_ENABLED требует SUPPLIER_CARDS_ENABLED');
  }
  if (
    project.TELEGRAM_CHANNEL_SOURCE_ENABLED === 'true' &&
    project.TELEGRAM_READER_TOKEN === undefined
  ) {
    errors.push('TELEGRAM_CHANNEL_SOURCE_ENABLED требует TELEGRAM_READER_TOKEN');
  }
  if (project.SUPPLIER_MAIL_PROPOSALS_ENABLED === 'true') {
    if (!platform.employeeMailboxEnabled) {
      errors.push('SUPPLIER_MAIL_PROPOSALS_ENABLED требует EMPLOYEE_MAILBOX_ENABLED');
    }
    if ((project.OWN_COMPANY_REQUISITES ?? []).length === 0) {
      errors.push('SUPPLIER_MAIL_PROPOSALS_ENABLED требует OWN_COMPANY_REQUISITES');
    }
  }
  return errors;
}

/** Бросить ошибку запуска с перечнем нарушенных связей между переменными. */
export function assertCrossChecks(project: PragmatikaConfig, platform: PlatformFacts): void {
  const errors = crossCheckErrors(project, platform);
  if (errors.length > 0) {
    throw new Error(`Некорректная конфигурация окружения: ${errors.join('; ')}`);
  }
}

/**
 * Слова белого списка детектора ПДн (названия собственной компании). Реальных названий в
 * репозитории нет: оператор задаёт их платформенной переменной `PII_ALLOWED_WORDS`.
 */
export const PRAGMATIKA_PII_ALLOWED_WORDS: readonly string[] = [];
