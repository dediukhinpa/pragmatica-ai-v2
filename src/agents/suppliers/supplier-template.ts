import {
  PACKAGING_KIND_LABELS,
  PACKAGING_KINDS,
  PACKAGING_PRICING_LABELS,
  PACKAGING_PRICINGS,
} from '../../kit/domain/supplier-card-full';
import { MAX_PERCENT, MIN_PERCENT } from '../../kit/domain/supplier-card-values';
import { allowedVatRatesText } from '../../kit/domain/vat';
import type { ExportedFile, TableExporter, TableSheet } from '@business-ai/core';

/**
 * Шаблон xlsx для загрузки поставщиков пачкой: колонки, пример и разбор заголовков.
 * Готовый файл лежит в репозитории (`docs/templates/supplier-template.xlsx`) и отдаётся по
 * кнопке «Шаблон»; тот же файл можно собрать через `TableExporter` (`buildSupplierTemplate`).
 * Колонки здесь - единственный источник: тест сверяет с ними файл репозитория.
 */

/**
 * Ключи колонок шаблона в порядке разделов 10.1-10.9 ТЗ заказчика (одна строка файла - один
 * поставщик). Первые колонки прежних версий шаблона сохранили ключи и написания заголовков.
 */
const SUPPLIER_COLUMN_KEYS = [
  // 10.1 О компании
  'name',
  'logoRef',
  'supplierKind',
  'status',
  'inn',
  'kpp',
  'ogrn',
  'legalAddress',
  'bankName',
  'bik',
  'settlementAccount',
  'correspondentAccount',
  'directorName',
  'foundedYear',
  'website',
  // 10.2 Контакты
  'contactName',
  'contactPosition',
  'phone',
  'email',
  'messenger',
  // 10.3 Условия работы
  'agencyDiscount',
  'discounts',
  'minOrderAmount',
  'minBatch',
  'samplesAvailable',
  'samplesQuantity',
  'samplesTerms',
  'payment',
  'paymentNotes',
  'vat',
  'leadTime',
  // 10.4 Доставка
  'delivery',
  'freeDelivery',
  // 10.5 Документы и договор
  'documentFlow',
  'contractNotes',
  'legalEntities',
  // 10.6 О продукции
  'categories',
  'brands',
  'regions',
  'packaging',
  'packagingPricing',
  'technologies',
  'personalizationTypes',
  'presentations',
  'portfolioLinks',
  'technicalRequirements',
  'pragmatikaPortfolio',
  // 10.7 Расположение
  'productionCity',
  'address',
  'transportInfo',
  // 10.8 Сервис
  'marketingSupport',
  'trainingFormats',
  'exclusivity',
  'hasOwnDesigners',
  'designServices',
  'hasQualityControl',
  'additionalServices',
  // 10.9 Оценка поставщика
  'strengths',
  'weaknesses',
  'defectRatePercent',
  'claimsHandling',
  'competitiveAdvantages',
  'customers',
  'turnover',
  'okved',
  'employeeCount',
  // Служебное
  'note',
] as const;
export type SupplierColumnKey = (typeof SUPPLIER_COLUMN_KEYS)[number];

/** Описание колонки шаблона. */
export interface SupplierTemplateColumn {
  key: SupplierColumnKey;
  /** Раздел ТЗ, к которому относится колонка (лист «Как заполнить»). */
  section: string;
  /** Заголовок в файле. «*» - обязательное поле. */
  header: string;
  /** Другие написания заголовка, которые тоже распознаются (в нормализованном виде). */
  aliases: readonly string[];
  /** Что писать: текст листа «Как заполнить». */
  hint: string;
  required: boolean;
  /** Значение в примерной строке. */
  example: string;
}

/** Название примерной строки: такая строка при загрузке пропускается. */
export const SUPPLIER_TEMPLATE_EXAMPLE_NAME = 'Пример: ООО «Ромашка» (удалите эту строку)';

/** Разделы ТЗ для листа «Как заполнить». */
const S101 = '10.1 О компании';
const S102 = '10.2 Контакты';
const S103 = '10.3 Условия работы';
const S104 = '10.4 Доставка';
const S105 = '10.5 Документы и договор';
const S106 = '10.6 О продукции';
const S107 = '10.7 Расположение';
const S108 = '10.8 Сервис';
const S109 = '10.9 Оценка поставщика';
const SGENERAL = 'Общее';

/** Подсказки для колонок со ссылками и перечислениями. */
const HINT_LIST = 'Несколько значений через точку с запятой.';
const HINT_YES_NO = 'да или нет. Пусто - не указано.';
const HINT_FILE_LINK =
  'Ссылка или путь файла в базе знаний (не вложение). Несколько - через точку с запятой.';

/** Короткая запись колонки: поля по порядку, необязательность по умолчанию. */
function column(
  key: SupplierColumnKey,
  section: string,
  header: string,
  example: string,
  hint: string,
  aliases: readonly string[] = [],
  required = false,
): SupplierTemplateColumn {
  return { key, section, header, aliases, hint, required, example };
}

export const SUPPLIER_TEMPLATE_COLUMNS: readonly SupplierTemplateColumn[] = [
  column('name', S101, 'Название*', SUPPLIER_TEMPLATE_EXAMPLE_NAME,
    'Название поставщика с формой собственности (ООО «Ромашка»). Обязательно.',
    ['название', 'название поставщика', 'название компании', 'наименование', 'поставщик', 'name'],
    true),
  column('logoRef', S101, 'Логотип (ссылка на файл)', 'Поставщики/Ромашка/logo.png',
    'Ссылка или путь файла логотипа в базе знаний (не вложение).',
    ['логотип', 'лого', 'logo']),
  column('supplierKind', S101, 'Вид поставщика', 'изготавливает и наносит',
    'только изготавливает, изготавливает и наносит или только наносит.',
    ['вид', 'вид поставщика']),
  column('status', S101, 'Тип поставщика', 'потенциальный',
    'действующий, потенциальный или не действующий. Пусто - потенциальный. ' +
      'Прежние «новый» и «не работаем» тоже понимаются.',
    ['тип', 'тип поставщика', 'статус', 'status']),
  column('inn', S101, 'ИНН', '1234567894',
    '10 цифр (организация) или 12 (ИП), с верной контрольной суммой.', ['инн', 'inn']),
  column('kpp', S101, 'КПП', '', '9 знаков, у ИП нет.', ['кпп']),
  column('ogrn', S101, 'ОГРН', '', '13 цифр (организация) или 15 (ИП).', ['огрн', 'огрнип']),
  column('legalAddress', S101, 'Юридический адрес', '', 'Юридический адрес организации.',
    ['юридический адрес', 'юр адрес']),
  column('bankName', S101, 'Банк', '', 'Название банка.', ['банк', 'название банка']),
  column('bik', S101, 'БИК', '', '9 цифр.', ['бик']),
  column('settlementAccount', S101, 'Расчётный счёт', '', '20 цифр.',
    ['расчетный счет', 'р с', 'расч счет']),
  column('correspondentAccount', S101, 'Корр. счёт', '', '20 цифр.',
    ['корр счет', 'корреспондентский счет', 'к с']),
  column('directorName', S101, 'Руководитель', '', 'ФИО подписанта (руководителя).',
    ['руководитель', 'директор', 'подписант']),
  column('foundedYear', S101, 'Год основания', '2005', 'Год основания компании, четыре цифры.',
    ['год основания', 'основана']),
  column('website', S101, 'Сайт', 'romashka.example.ru', 'Адрес сайта, например example.ru.',
    ['сайт', 'веб сайт', 'website', 'site']),
  column('contactName', S102, 'ФИО контакта', 'Иванов Иван Иванович',
    'Имя контактного лица. Один контакт в строке.',
    ['фио контакта', 'фио', 'контакт', 'контактное лицо', 'имя контакта']),
  column('contactPosition', S102, 'Должность', 'менеджер по продажам', 'Должность контакта.',
    ['должность', 'position']),
  column('phone', S102, 'Телефон', '+7 900 000-00-00',
    'Телефон контакта, например +7 900 000-00-00.',
    ['телефон', 'тел', 'phone']),
  column('email', S102, 'Email', 'sales@romashka.example.ru',
    'Адрес электронной почты контакта.',
    ['email', 'e mail', 'почта', 'электронная почта', 'адрес почты']),
  column('messenger', S102, 'Мессенджер', '@romashka_sales', 'Ник или номер в мессенджере.',
    ['мессенджер', 'telegram', 'whatsapp', 'мессенджеры']),
  column('agencyDiscount', S103, 'Скидка для агентства, %', '10',
    'Размер скидки от цены поставщика для рекламного агентства: число от 0 до 100 ' +
      '(например 5 или 5,5), знак % можно не писать.',
    ['скидка для агентства', 'скидка агентству', 'скидка от цены поставщика']),
  column('discounts', S103, 'Условия доп. скидки', 'от тиража 5000 шт.',
    'Условия дополнительной скидки: тираж, сумма заказа и другие.',
    ['условия доп скидки', 'условия дополнительной скидки', 'доп скидка', 'скидки', 'скидка',
      'discounts']),
  column('minOrderAmount', S103, 'Мин. сумма заказа', 'от 50 000 руб.', 'Минимальная сумма заказа.',
    ['мин сумма заказа', 'минимальная сумма заказа', 'минимальная сумма']),
  column('minBatch', S103, 'Мин. тираж', 'от 100 шт.', 'Минимальный тираж.',
    ['мин тираж', 'минимальный тираж', 'мин партия', 'минимальная партия', 'минимальный заказ',
      'мин заказ']),
  column('samplesAvailable', S103, 'Бесплатные образцы', 'да', HINT_YES_NO,
    ['бесплатные образцы', 'образцы']),
  column('samplesQuantity', S103, 'Образцов, шт.', '2', 'Сколько образцов бесплатно, целое число.',
    ['образцов шт', 'количество образцов', 'количество бесплатных образцов']),
  column('samplesTerms', S103, 'Условия образцов', 'при заказе тиража',
    'Условия бесплатных образцов.',
    ['условия образцов', 'условия бесплатных образцов']),
  column('payment', S103, 'Условия оплаты', 'отсрочка 14 дней',
    'Например: предоплата 30%, остальное по факту.', ['условия оплаты', 'оплата', 'payment']),
  column('paymentNotes', S103, 'Комментарии по оплате', 'оплата по счёту, наличные не принимают',
    'Комментарии по видам оплат.', ['комментарии по оплате', 'комментарии по видам оплат']),
  column('vat', S103, 'НДС, %', '20',
    `Ставка НДС числом (${allowedVatRatesText()}; допустимо любое от 0 до 100). ` +
      '«0» - нулевая ставка плательщика. Если работает без НДС (УСН), напишите «без НДС».',
    ['ндс', 'vat', 'ндс %']),
  column('leadTime', S103, 'Сроки производства', '3-5 дней', 'Сроки производства.',
    ['сроки производства', 'сроки', 'срок поставки', 'сроки поставки', 'срок']),
  column('delivery', S104, 'Условия доставки', 'самовывоз или доставка за счёт покупателя',
    'Условия и сроки доставки: до склада, до транспортной компании, до места.',
    ['условия доставки', 'условия и сроки доставки', 'доставка', 'delivery']),
  column('freeDelivery', S104, 'Бесплатная доставка', 'от 30 000 руб. по Москве',
    'Условия бесплатной доставки.', ['бесплатная доставка']),
  column('documentFlow', S105, 'Документооборот', 'ЭДО', 'ЭДО или нет.',
    ['документооборот', 'эдо']),
  column('contractNotes', S105, 'Договор и соглашения', 'договор поставки, NDA подписан',
    'Договор, соглашения о сотрудничестве.', ['договор и соглашения', 'договор', 'соглашения']),
  column('legalEntities', S105, 'Все юрлица (название и ИНН)',
    'ООО «Ромашка» 1234567894; ИП Иванов 123456789047',
    'Название и ИНН каждой организации: «Название ИНН», несколько - через точку с запятой.',
    ['все юрлица', 'все юридические лица', 'юрлица', 'юридические лица']),
  column('categories', S106, 'Товарные группы', 'крепёж; метизы',
    'Направления товарных групп работы и производства. ' + HINT_LIST,
    ['товарные группы', 'направления', 'категории', 'категория', 'что поставляет', 'categories']),
  column('brands', S106, 'Бренды', 'Bosch; Makita', 'Бренды. ' + HINT_LIST,
    ['бренды', 'бренд', 'марки', 'brands']),
  column('regions', S106, 'Регионы', 'Москва; Санкт-Петербург', 'Регионы поставки. ' + HINT_LIST,
    ['регионы', 'регион', 'regions']),
  column('packaging', S106, 'Упаковка', 'подарочная',
    'Ровно одно значение из списка: нет, транспортная или подарочная.', ['упаковка']),
  column('packagingPricing', S106, 'Стоимость упаковки', 'входит в стоимость',
    'входит в стоимость или отдельный прайс.', ['стоимость упаковки', 'упаковка стоимость']),
  column('technologies', S106, 'Технологии производства', 'литьё; штамповка',
    'Технологии производства. ' + HINT_LIST, ['технологии производства', 'технологии']),
  column('personalizationTypes', S106, 'Виды персонификации', 'гравировка; тампопечать',
    'Виды персонификации у поставщика. ' + HINT_LIST,
    ['виды персонификации', 'персонификация']),
  column('presentations', S106, 'Презентации (ссылки)', 'Поставщики/Ромашка/presentation.pdf',
    'Презентации компании и продукции. ' + HINT_FILE_LINK,
    ['презентации ссылки', 'презентации', 'презентация']),
  column('portfolioLinks', S106, 'Портфолио (ссылки)', 'Поставщики/Ромашка/portfolio.pdf',
    'Портфолио поставщика. ' + HINT_FILE_LINK, ['портфолио ссылки', 'портфолио поставщика']),
  column('technicalRequirements', S106, 'Технические требования', 'макет в векторе, CMYK',
    'Технические требования для заказа.', ['технические требования']),
  column('pragmatikaPortfolio', S106, 'Портфолио заказов в Прагматике', 'заказы 2024-2025',
    'Какие заказы Прагматики поставщик выполнял.',
    ['портфолио заказов в прагматике', 'портфолио заказов']),
  column('productionCity', S107, 'Город производства', 'Казань', 'Город производства.',
    ['город производства', 'город']),
  column('address', S107, 'Адрес склада и производства', 'г. Казань, ул. Складская, 5',
    'Фактическое расположение склада и производства.',
    ['адрес склада и производства', 'адрес склада', 'адрес производства', 'адрес']),
  column('transportInfo', S107, 'Для транспортных компаний', 'въезд со двора, пропуск на КПП',
    'Дополнительная информация для транспортных компаний по адресам.',
    ['для транспортных компаний', 'информация для транспортных компаний']),
  column('marketingSupport', S108, 'Маркетинговая поддержка', 'каталоги, фото товаров',
    'Какая маркетинговая поддержка есть.', ['маркетинговая поддержка']),
  column('trainingFormats', S108, 'Обучение менеджеров', 'онлайн; офлайн',
    'онлайн, офлайн или оба через точку с запятой.',
    ['обучение менеджеров', 'обучение']),
  column('exclusivity', S108, 'Эксклюзивное партнёрство', 'по направлению «ручки»',
    'Возможность эксклюзива с Прагматикой: по товарному направлению, региону и другим условиям.',
    ['эксклюзивное партнерство', 'эксклюзив']),
  column('hasOwnDesigners', S108, 'Собственные дизайнеры', 'да', HINT_YES_NO,
    ['собственные дизайнеры', 'есть дизайнеры']),
  column('designServices', S108, 'Дизайн: работы и условия', 'макет за 500 руб.',
    'Виды работ по дизайну и условия.', ['дизайн работы и условия', 'услуги дизайна']),
  column('hasQualityControl', S108, 'Отдел контроля качества', 'да', HINT_YES_NO,
    ['отдел контроля качества', 'контроль качества']),
  column('additionalServices', S108, 'Дополнительные услуги', 'растиражовка; сборка',
    'Дополнительные услуги (растиражовка, сборка и другие) и условия по ним.',
    ['дополнительные услуги', 'доп услуги']),
  column('strengths', S109, 'Сильные стороны', 'крупные тиражи',
    'С какими заказами лучше обращаться.', ['сильные стороны']),
  column('weaknesses', S109, 'Слабые стороны', 'срочные заказы',
    'С какими заказами не стоит обращаться.', ['слабые стороны']),
  column('defectRatePercent', S109, 'Процент брака', '1,5',
    'Процент брака по заказам, число от 0 до 100. 0 - брака нет; пусто - не указано.',
    ['процент брака', 'брак', 'брак процент']),
  column('claimsHandling', S109, 'Работа с рекламациями', 'замена за свой счёт за 10 дней',
    'Как поставщик работает с рекламациями.', ['работа с рекламациями', 'рекламации']),
  column('competitiveAdvantages', S109, 'Конкурентные преимущества', 'свои станки',
    'Основные конкурентные преимущества.',
    ['конкурентные преимущества', 'основные конкурентные преимущества']),
  column('customers', S109, 'Заказчики', 'крупный ритейл', 'Кто заказчики.', ['заказчики']),
  column('turnover', S109, 'Оборот по годам, руб.',
    '2025: 150 млн; 2024: 120 млн; 2023: 100 млн',
    'Оборот за последние 2-3 года: «год: сумма» через «;», например ' +
      '«2025: 150 млн; 2024: 120 млн; 2023: 100 млн» (суммы: 150000000, «1,5 млрд», ' +
      '«500 000 000 руб.»). Допустима и одна сумма без года - она запишется как оборот ' +
      'без указания года.',
    ['оборот руб', 'оборот', 'оборот за 2 3 года', 'оборот по годам']),
  column('okved', S109, 'Основной ОКВЭД', '32.99',
    'Код ОКВЭД 2 (ОК 029-2014): 32, 32.9, 32.99, 32.99.1 или 32.99.11. Допустимы «3299», ' +
      '«32,99», «ОКВЭД 32.99».',
    ['основной оквэд', 'оквэд']),
  column('employeeCount', S109, 'Численность сотрудников', '120', 'Число сотрудников, целое.',
    ['численность сотрудников', 'численность', 'сотрудники']),
  column('note', SGENERAL, 'Заметка', 'работали в 2024 году',
    'Любая заметка к карточке; автором будет сотрудник, подтвердивший загрузку.',
    ['заметка', 'заметки', 'примечание', 'комментарий', 'note']),
];

/**
 * Правило ячеек колонки для файла шаблона: список значений, числовой формат или текстовый
 * формат (Excel иначе превратит код «47.10» в число 47,1 и потеряет нуль).
 */
export type SupplierCellRule =
  | { kind: 'text'; key: SupplierColumnKey; header: string }
  | { kind: 'list'; key: SupplierColumnKey; header: string; values: readonly string[] }
  | { kind: 'number'; key: SupplierColumnKey; header: string; format: string; min: number;
      max: number };

/** Числовой формат Excel для процентов (до сотых). */
const PERCENT_NUMBER_FORMAT = '0.##';

function headerOfKey(key: SupplierColumnKey): string {
  return SUPPLIER_TEMPLATE_COLUMNS.find((item) => item.key === key)?.header ?? key;
}

/**
 * Правила ячеек листа «Поставщики»: выпадающие списки (упаковка и стоимость упаковки),
 * числовой формат (скидка) и текстовый (ОКВЭД, оборот по годам). Колонка «НДС» принимает и
 * число, и «без НДС», поэтому числового ограничения не получает. Файл шаблона собирает
 * `build_supplier_template.py`.
 */
export function supplierTemplateCellRules(): SupplierCellRule[] {
  return [
    {
      kind: 'list',
      key: 'packaging',
      header: headerOfKey('packaging'),
      values: PACKAGING_KINDS.map((code) => PACKAGING_KIND_LABELS[code]),
    },
    {
      kind: 'list',
      key: 'packagingPricing',
      header: headerOfKey('packagingPricing'),
      values: PACKAGING_PRICINGS.map((code) => PACKAGING_PRICING_LABELS[code]),
    },
    { kind: 'text', key: 'okved', header: headerOfKey('okved') },
    {
      kind: 'number',
      key: 'agencyDiscount',
      header: headerOfKey('agencyDiscount'),
      format: PERCENT_NUMBER_FORMAT,
      min: MIN_PERCENT,
      max: MAX_PERCENT,
    },
    // Текст «год: сумма»: числовая проверка Excel отклонила бы запись по годам.
    { kind: 'text', key: 'turnover', header: headerOfKey('turnover') },
  ];
}

/** Имя файла шаблона и его тип. */
const SUPPLIER_TEMPLATE_FILE_NAME = 'Шаблон поставщиков.xlsx';
const SUPPLIER_TEMPLATE_MIME_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/** Листы шаблона. */
const SUPPLIER_TEMPLATE_DATA_SHEET = 'Поставщики';
const SUPPLIER_TEMPLATE_GUIDE_SHEET = 'Как заполнить';

const GUIDE_COLUMNS = ['Раздел ТЗ', 'Колонка', 'Что писать', 'Обязательно'] as const;
const GUIDE_GENERAL_RULES: ReadonlyArray<readonly [string, string, string, string]> = [
  ['Общее', 'Колонки', 'Одна строка - один поставщик с одним контактом.', ''],
  ['Общее', 'Колонки', 'Примерную строку (первую) удалите или замените своей.', ''],
  ['Общее', 'Колонки', 'Заголовки колонок не меняйте; порядок колонок любой.', ''],
  ['Общее', 'Колонки', 'Колонки идут по разделам 10.1-10.9 ТЗ; нужны только те, что знаете.', ''],
  ['Общее', 'Файлы', 'Логотип, презентации и портфолио - ссылки на файлы в базе знаний.', ''],
  ['Общее', 'Проверка', 'Перед записью бот покажет отчёт, ошибки по строкам и дубли.', ''],
];

/**
 * Строки шаблона для выгрузки: лист «Поставщики» (заголовки колонок и одна примерная строка)
 * и лист «Как заполнить».
 */
export function buildSupplierTemplateRows(): TableSheet[] {
  return [
    {
      name: SUPPLIER_TEMPLATE_DATA_SHEET,
      columns: SUPPLIER_TEMPLATE_COLUMNS.map((column) => column.header),
      rows: [SUPPLIER_TEMPLATE_COLUMNS.map((column) => column.example)],
    },
    {
      name: SUPPLIER_TEMPLATE_GUIDE_SHEET,
      columns: [...GUIDE_COLUMNS],
      rows: [
        ...SUPPLIER_TEMPLATE_COLUMNS.map((column) => [
          column.section,
          column.header,
          column.hint,
          column.required ? 'да' : 'нет',
        ]),
        ...GUIDE_GENERAL_RULES.map((rule) => [...rule]),
      ],
    },
  ];
}

/** Собрать файл шаблона через выгрузку таблиц (когда готового файла под рукой нет). */
export function buildSupplierTemplate(exporter: TableExporter): Promise<ExportedFile> {
  return exporter.export(buildSupplierTemplateRows(), 'xlsx', SUPPLIER_TEMPLATE_FILE_NAME);
}

/** Готовый файл шаблона из байтов (файл репозитория читает насос по пути из настройки). */
export function supplierTemplateFile(bytes: Uint8Array): ExportedFile {
  return {
    fileName: SUPPLIER_TEMPLATE_FILE_NAME,
    mimeType: SUPPLIER_TEMPLATE_MIME_TYPE,
    bytes,
  };
}

const HEADER_STRIP = /[*:.,;()«»"'_]/g;
const HEADER_SPACES = /[\s\-–—/]+/g;

/** Заголовок для сравнения: регистр, «ё», знаки и пробелы не важны. */
function normalizeHeader(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(HEADER_STRIP, ' ')
    .replace(HEADER_SPACES, ' ')
    .trim();
}

const HEADER_LOOKUP: ReadonlyMap<string, SupplierColumnKey> = new Map(
  SUPPLIER_TEMPLATE_COLUMNS.flatMap((column) =>
    [column.header, ...column.aliases].map(
      (name) => [normalizeHeader(name), column.key] as [string, SupplierColumnKey],
    ),
  ),
);

/**
 * Колонка шаблона по названию, которое назвал сотрудник (этап 215): ключ колонки, заголовок или
 * любой из синонимов; регистр, «ё», знаки и пробелы не важны. null - такой колонки нет.
 */
export function resolveSupplierColumn(raw: string): SupplierTemplateColumn | undefined {
  const wanted = raw.trim();
  const byKey = SUPPLIER_TEMPLATE_COLUMNS.find((item) => item.key === wanted);
  if (byKey !== undefined) return byKey;
  const key = HEADER_LOOKUP.get(normalizeHeader(wanted));
  return key === undefined ? undefined : SUPPLIER_TEMPLATE_COLUMNS.find((item) => item.key === key);
}

/** Слово (или слова) сотрудника и колонки, которые за ним стоят. */
interface FieldWordSet {
  words: readonly string[];
  keys: readonly SupplierColumnKey[];
}

/** Нормализованное слово -> колонки, из набора слов. */
function wordIndex(
  sets: readonly FieldWordSet[],
): ReadonlyMap<string, readonly SupplierColumnKey[]> {
  return new Map(
    sets.flatMap((set) =>
      set.words.map((word): [string, readonly SupplierColumnKey[]] => [
        normalizeHeader(word),
        set.keys,
      ]),
    ),
  );
}

/**
 * Группы полей (этап 215): одно слово сотрудника - несколько колонок. «Контакты» - ФИО, телефон
 * и почта основного контакта; «реквизиты» - ИНН, КПП, ОГРН, банк, БИК, расчётный и корр. счёт.
 */
const FIELD_GROUPS = wordIndex([
  {
    words: ['контакты', 'контактные данные', 'контактная информация'],
    keys: ['contactName', 'phone', 'email'],
  },
  {
    words: ['реквизиты', 'банковские реквизиты', 'платежные реквизиты', 'реквизиты компании'],
    keys: ['inn', 'kpp', 'ogrn', 'bankName', 'bik', 'settlementAccount', 'correspondentAccount'],
  },
]);

/**
 * Неоднозначные названия (этап 215): за словом стоит несколько колонок, и угадывать нельзя -
 * сотрудник уточняет, какую именно. Колонки - варианты для короткой подсказки.
 */
const AMBIGUOUS_FIELDS = wordIndex([
  { words: ['адрес', 'адреса'], keys: ['legalAddress', 'address'] },
  { words: ['счет', 'счета'], keys: ['settlementAccount', 'correspondentAccount'] },
  { words: ['скидка', 'скидки'], keys: ['agencyDiscount', 'discounts'] },
  { words: ['образцы'], keys: ['samplesAvailable', 'samplesQuantity', 'samplesTerms'] },
  { words: ['условия'], keys: ['payment', 'delivery', 'discounts', 'samplesTerms'] },
]);

/** Итог разбора названия поля, которое назвал сотрудник. */
export type SupplierFieldResolution =
  | { kind: 'columns'; columns: SupplierTemplateColumn[] }
  | { kind: 'ambiguous'; options: string[] }
  | { kind: 'unknown' };

function columnsByKeys(keys: readonly SupplierColumnKey[]): SupplierTemplateColumn[] {
  return SUPPLIER_TEMPLATE_COLUMNS.filter((item) => keys.includes(item.key));
}

/**
 * Разобрать название поля сотрудника (этап 215). Порядок: ключ колонки; группа («контакты»,
 * «реквизиты») - несколько колонок в порядке шаблона; неоднозначное слово («адрес», «счёт») -
 * варианты для уточнения; заголовок или синоним одной колонки; иначе неизвестное.
 */
export function resolveSupplierField(raw: string): SupplierFieldResolution {
  const wanted = raw.trim();
  const byKey = SUPPLIER_TEMPLATE_COLUMNS.find((item) => item.key === wanted);
  if (byKey !== undefined) return { kind: 'columns', columns: [byKey] };
  const normalized = normalizeHeader(wanted);
  const group = FIELD_GROUPS.get(normalized);
  if (group !== undefined) return { kind: 'columns', columns: columnsByKeys(group) };
  const options = AMBIGUOUS_FIELDS.get(normalized);
  if (options !== undefined) {
    return {
      kind: 'ambiguous',
      options: columnsByKeys(options).map((item) => item.header.replace('*', '')),
    };
  }
  const single = resolveSupplierColumn(wanted);
  return single === undefined ? { kind: 'unknown' } : { kind: 'columns', columns: [single] };
}

/** Заголовки колонок шаблона без отметки «*»: допустимые названия полей для отказа модели. */
export function supplierColumnTitles(): string[] {
  return SUPPLIER_TEMPLATE_COLUMNS.map((item) => item.header.replace('*', ''));
}

/** Колонки шаблона, по которым строка заголовков считается «поставщиками». */
const IDENTIFYING_KEYS: readonly SupplierColumnKey[] = ['inn', 'email', 'phone'];
/** Не меньше распознанных колонок (включая название) для признания файла шаблоном. */
const MIN_RECOGNIZED_COLUMNS = 3;
/** Заголовки прайса: если они есть, файл поставщиками не считается. */
const PRICE_HEADERS: readonly string[] = [
  'цена',
  'цена руб',
  'артикул',
  'sku',
  'price',
  'количество',
  'остаток',
  'ед изм',
];

/**
 * Распознать строку заголовков: соответствие «колонка шаблона -> номер ячейки». null, если
 * строка не похожа на шаблон поставщиков (нет названия, нет ИНН/почты/телефона, мало
 * колонок или есть заголовки прайса). Порядок колонок и регистр не важны.
 */
export function matchSupplierHeaders(
  cells: readonly string[],
): Map<SupplierColumnKey, number> | null {
  const columns = new Map<SupplierColumnKey, number>();
  let priceLike = false;
  cells.forEach((cell, index) => {
    const header = normalizeHeader(cell);
    if (PRICE_HEADERS.includes(header)) priceLike = true;
    const key = HEADER_LOOKUP.get(header);
    if (key !== undefined && !columns.has(key)) columns.set(key, index);
  });
  if (priceLike || !columns.has('name')) return null;
  if (!IDENTIFYING_KEYS.some((key) => columns.has(key))) return null;
  // Название и ИНН вместе - достаточный признак: так выглядит самая узкая выгрузка базы (этап 215),
  // и её обратная загрузка не должна уходить в обычную обработку файла.
  const nameAndInn = columns.has('inn');
  return columns.size >= MIN_RECOGNIZED_COLUMNS || nameAndInn ? columns : null;
}
