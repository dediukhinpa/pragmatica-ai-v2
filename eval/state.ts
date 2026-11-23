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
/** Число вне таблицы слайда pptx: то, что отдаёт карта мест сервиса документов (этап 9q). */
export const priceSpotSchema = z
  .object({
    slide: z.number().int().min(1),
    /** Путь фигуры: id через «/» (для группы «7/12»). */
    shape: z.string().min(1),
    paragraph: z.number().int().min(0),
    start: z.number().int().min(0),
    /** Само число как в тексте («680 ₽»). */
    text: z.string().min(1),
    /** Текст абзаца вокруг числа. */
    context: z.string().min(1),
  })
  .strict();
/**
 * Число в тексте PDF вне таблиц с линиями (этап 9r): то, что отдаёт карта мест сервиса документов
 * для pdf. Адрес места - страница и номер на ней; `header` - заголовок столбца таблицы без линий.
 */
export const pricePdfSpotSchema = z
  .object({
    page: z.number().int().min(1),
    spot: z.number().int().min(0),
    /** Само число как напечатано («1 250,00»): валюта и слова в место не входят. */
    text: z.string().min(1),
    /** Строка вокруг числа (колонки разделены « | »). */
    context: z.string().min(1),
    header: z.string().min(1).optional(),
  })
  .strict();
/** Число вне таблицы кейса: слайда pptx или страницы PDF. */
export const priceAnySpotSchema = z.union([priceSpotSchema, pricePdfSpotSchema]);
/** Запись реестра правок сотрудника: позиция базы, момент записи и файл (этап 9q). */
export const employeeFileEditSchema = z
  .object({
    supplierId: z.string().min(1),
    productName: z.string().min(1),
    sku: z.string().min(1).optional(),
    /** Когда сотрудник записал цену (ISO); совпадает с датой строки в `prices`. */
    editedAt: z.string().datetime(),
    fileName: z.string().min(1).default('Спецпредложение.pptx'),
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
    /**
     * Правка цены в файле сотрудника сразу, без вопроса о поставщике (как
     * `PRICE_EDIT_FIRST_ENABLED`, этап 9p): у агента инструменты editPriceInFile,
     * getPendingPriceEdit, closePendingPriceEdit и абзац промпта. По умолчанию выключено,
     * состав инструментов остальных кейсов не меняется.
     */
    priceEditFirst: z.boolean().default(false),
    /**
     * Файлы, присланные сотрудником в чат (`path` - имя файла, `text` - содержимое). Для pptx
     * текст - markdown разбора: заголовки «## Слайд N» и таблицы цен. Файлы кладутся в приём
     * файлов треда кейса до первого хода; путь для инструментов даёт listIntakeFiles.
     */
    chatFiles: z.array(fileSchema).default([]),
    /**
     * «Да» после правки файла пишет изменённые цены в базу (как `PRICE_EDIT_DB_WRITE_ENABLED`,
     * этап 9q): инструмент writeEditedPricesToDb и пункт 5 промпта с прямой записью. Работает
     * вместе с `priceEditFirst`. По умолчанию выключено: «да» ведёт прежним путём.
     */
    priceEditDbWrite: z.boolean().default(false),
    /**
     * Числа вне таблиц слайдов pptx и текста pdf (как `PRICE_EDIT_TEXT_BLOCKS_ENABLED`, этапы 9q
     * и 9r): инструмент listPriceSpots, поиск мест в editPriceInFile и абзац промпта; карту мест
     * отдаёт заглушка из `priceSpots`. Работает вместе с `priceEditFirst`. По умолчанию выключено.
     */
    priceTextBlocks: z.boolean().default(false),
    /**
     * Числа вне таблиц, которые видит заглушка сервиса документов: у презентации - слайд, фигура,
     * абзац, смещение и текст вокруг, у pdf - страница, номер места, число и строка вокруг.
     * Строка `context` должна стоять отдельной строкой в markdown файла из `chatFiles`: по ней
     * заглушка-редактор находит число.
     */
    priceSpots: z.array(priceAnySpotSchema).default([]),
    /**
     * Код отказа, которым заглушка сервиса отвечает на правку числа в тексте PDF (как 422
     * `edit_refused` с причиной по месту, этап 9r): `no_fit`, `price_not_isolated` и т. п. Не
     * задан - правка принимается. Файл при отказе не выдаётся.
     */
    priceEditRefusal: z.string().min(1).optional(),
    /**
     * Цены, записанные в базу сотрудником по правке файла (реестр 9q): позиция берётся из
     * `prices` (цена и дата строки должны совпасть с записью, иначе защита не действует).
     * Нужна, чтобы проверить правило «более старый файл с диска не затирает».
     */
    employeeFileEdits: z.array(employeeFileEditSchema).default([]),
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
    /**
     * Запрос сотрудника пришёл подписью к файлу (этап 9q): платформа для такого текста хук
     * входящих не зовёт, поэтому окружение НЕ записывает запрос как сообщение, а отдаёт его
     * проекту репликой истории треда (как формирует насос чата). По умолчанию выключено.
     */
    captionWithFile: z.boolean().default(false),
    /**
     * Наши реквизиты из базы и шаблон договора Прагматики на диске (этап 9q, п. 5): у агента
     * подстановка подписанта нашей стороны (`own_signatory_name`); сервис склонения - словарь,
     * который, как настоящий, склоняет только именительный падеж и на винительном даёт `null`.
     * По умолчанию выключено.
     */
    ownSignatory: z.boolean().default(false),
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
     * Метка человека: id поставщика, которого выбрал бы менеджер. Метрику выбора считает раннер
     * платформы по `expect.expectedChoice` и предложению окружения (`withShortlistProposal`).
     * Здесь метка только хранится: пока она не перенесена в `expect.expectedChoice`, метрика
     * выключена и вывод eval остаётся прежним. Включение: перенести метку в `expect` кейса и
     * принять новые строки отчёта (проверка и поле называются `choice`, а в эталоне
     * `manager_choice` и `managerChoice`).
     */
    expectedChoice: z.string().min(1).optional(),
    /**
     * «Ещё 10» (как `SHORTLIST_PAGING_ENABLED`, этап 8z): у агента инструмент showMoreSuppliers.
     * Включается только кейсами про следующие десятки; по умолчанию выключено, состав
     * инструментов остальных кейсов не меняется.
     */
    shortlistPaging: z.boolean().default(false),
    /**
     * Пополнение базы поставщиков (как `SUPPLIER_DISCOVERY_ENABLED`, этап 8z): инструменты
     * findSuppliersForBase и prepareDiscoveredSupplierCards. Работает поверх `supplierCards`.
     * По умолчанию выключено.
     */
    supplierDiscovery: z.boolean().default(false),
    /**
     * Тексты страниц сайтов для читателя страниц: хост -> текст главной. Непустая таблица
     * подключает читатель (как при включённом чтении сайтов); по умолчанию читателя нет.
     */
    webPages: z.record(z.string()).default({}),
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
