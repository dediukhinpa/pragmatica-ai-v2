import { z } from 'zod';
import { purchaseRequestSchema, supplierSchema } from '../src/kit/domain/models';
import { DEFAULT_CURRENCY, DEFAULT_OWN_COMPANY } from './constants';
import { SEED_DATE } from '@business-ai/eval';

/** Файл на «диске» (прайс, шаблон документа): путь и текст. */
export const fileSchema = z.object({ path: z.string().min(1), text: z.string() }).strict();
/** Строка прайса в начальном состоянии. */
export const priceRowSchema = z
  .object({
    supplierId: z.string().min(1),
    productName: z.string().min(1),
    sku: z.string().min(1).optional(),
    price: z.number().positive(),
    currency: z.string().min(1).default(DEFAULT_CURRENCY),
    date: z.string().default(SEED_DATE),
  })
  .strict();
const webHitSchema = z
  .object({ title: z.string(), url: z.string().min(1), snippet: z.string() })
  .strict();
/**
 * Ящик сотрудника в режиме почты сотрудников (этап 49). Непустой список включает режим:
 * письма поставщикам готовятся черновиком и уходят с ящика сотрудника по кнопке. Сотрудник
 * прогона - `eval-manager`: без ящика для него инструмент отвечает «почта не подключена».
 */
export const mailboxSchema = z
  .object({ userId: z.string().min(1), address: z.string().min(1) })
  .strict();
const mailboxesSchema = z.array(mailboxSchema).default([]);
const knowledgeSchema = z.record(z.string());
const suppliersSchema = z.array(supplierSchema).default([]);
const pricesSchema = z.array(priceRowSchema).default([]);
/** Начальное состояние агента «Актуализация прайса (ИИ агент)». */
export const pricesStateSchema = z
  .object({
    suppliers: suppliersSchema,
    prices: pricesSchema,
    files: z.array(fileSchema).default([]),
    /** Текущий момент прогона (ISO); не задан - время часов оценки по умолчанию. */
    now: z.string().datetime().optional(),
  })
  .strict();
/** Начальное состояние агента «Подготовка документов (ИИ агент)». */
export const documentsStateSchema = z
  .object({
    suppliers: suppliersSchema,
    files: z.array(fileSchema).default([]),
    knowledge: knowledgeSchema.default({}),
    ownCompanyNames: z.array(z.string().min(1)).default([DEFAULT_OWN_COMPANY]),
    /**
     * Карточки поставщиков у агента (как `SUPPLIER_CARDS_ENABLED`): поиск поставщика по базе с
     * вопросом «Добавить в базу?» и дополнение карточки из договора. По умолчанию выключено,
     * состав инструментов остальных кейсов не меняется.
     */
    supplierCards: z.boolean().default(false),
    /**
     * Реквизиты наших юрлиц (как `OWN_COMPANY_REQUISITES`): значения, которые код не даёт
     * записать в карточку поставщика при дополнении из договора. По умолчанию не заданы.
     */
    ownCompanyRequisites: z.array(z.string().min(1)).default([]),
    /**
     * Режим «дополнить присланный договор исполнителя» (как
     * `DOCUMENTS_COUNTERPARTY_AMEND_ENABLED`, этап 227): у агента инструмент
     * `amendCounterpartyContract` и чтение файлов чата. По умолчанию выключено.
     */
    counterpartyAmend: z.boolean().default(false),
    /**
     * Файлы, присланные сотрудником в чат (`path` - имя файла, `text` - содержимое). Нужны
     * режиму дополнения договора; без режима агент их не читает.
     */
    chatFiles: z.array(fileSchema).default([]),
  })
  .strict();
/**
 * Фото в личном чате сотрудника (этап 224). `text` - то, что вернёт чтение фото в режиме
 * `IMAGE_TEXT_MODE=tokens` («Текст с фото: ...»); `unreadable` - фото не прочиталось, код
 * вернул фиксированную пометку «Фото не отправлено: ...» (status=unavailable).
 */
export const chatPhotoSchema = z
  .object({
    name: z.string().min(1),
    text: z.string(),
    unreadable: z.boolean().default(false),
  })
  .strict();
/** Начальное состояние агента «Поиск поставщика (ИИ агент)». */
export const orderCalcStateSchema = z
  .object({
    requests: z.array(purchaseRequestSchema).min(1),
    suppliers: suppliersSchema,
    prices: pricesSchema,
    knowledge: knowledgeSchema.default({}),
    web: z.array(webHitSchema).default([]),
    /** Ящики сотрудников: непустой список включает черновики писем (см. `mailboxSchema`). */
    mailboxes: mailboxesSchema,
    /**
     * Подсказка о полноте запроса (как `ORDER_CALC_COMPLETENESS_ENABLED`): у агента
     * инструмент checkRequestCompleteness (подсказка о неполноте; поиск она не блокирует).
     */
    completeness: z.boolean().default(false),
    /**
     * Ответ «модели-составителя» веб-запросов (как `WEB_SEARCH_MODEL_ENABLED`): сырой список
     * строк, который проверяет код. Нет поля - составителя нет, запросы - названия позиций.
     */
    webPlan: z.array(z.string()).optional(),
    /**
     * Сведения «модели-обогатителя» по адресу страницы кандидата (город, телефон, цена, срок).
     * Нет поля - обогащения нет, кандидат - заголовок и адрес.
     */
    webFacts: z.record(z.record(z.unknown())).optional(),
    /**
     * Карточки поставщиков у агента (как `SUPPLIER_CARDS_ENABLED`): поиск, заведение и
     * дополнение карточки. Запись разрешена условному сотруднику. По умолчанию выключено.
     */
    supplierCards: z.boolean().default(false),
    /**
     * Фото, присланные сотрудником в чат. Непустой список включает чтение вложений чата
     * (`readChatAttachments`) и правило про фото визитки в промпте, как при
     * `IMAGE_TEXT_MODE=tokens`; чтение фото подменено заглушкой с заданным ответом.
     */
    chatPhotos: z.array(chatPhotoSchema).default([]),
    /**
     * Метка человека: id поставщика, которого выбрал бы менеджер. В прежнем eval она лежала в
     * корне кейса, и раннер сверял её с шорт-листом агента (проверка `manager_choice`). Раннер
     * платформы метку не считает (пробел платформы), поэтому здесь она только хранится.
     */
    expectedManagerChoice: z.string().min(1).optional(),
  })
  .strict();
/** Начальное состояние агента «Актуализация сайта (ИИ агент)». */
export const siteExportStateSchema = z
  .object({
    prices: pricesSchema,
    knowledge: knowledgeSchema.default({}),
    web: z.array(webHitSchema).default([]),
    /** Ящики сотрудников: как в проде при флаге, сбор данных читает почту сотрудника хода. */
    mailboxes: mailboxesSchema,
  })
  .strict();
