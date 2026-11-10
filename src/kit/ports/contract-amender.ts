/** Наши данные для стороны заказчика в договоре исполнителя. */
export interface OwnRequisites {
  /** Наименование юрлица, как печатается в договоре («ООО «...»»). */
  name: string;
  /** Строки реквизитов как они печатаются (ИНН/КПП, счета, банк, адрес, телефон). */
  lines: readonly string[];
}

/**
 * Формат, из которого файл приведён к docx: `doc` (Word 97-2003) или `rtf`. Договор в docx
 * сервис не конвертирует: `convertedFrom` в таком случае `null`.
 */
export type ConvertedFrom = 'doc' | 'rtf';

/**
 * Запрос дополнения присланного договора исполнителя нашими реквизитами. Номера договора в
 * запросе нет и не будет: номер поставщика не меняется никогда (решение владельца 08.11.2026).
 */
export interface AmendContractRequest {
  fileName: string;
  /** Байты docx, .doc или RTF: .doc и RTF сервис сначала конвертирует в docx. */
  bytes: Uint8Array;
  /** Наши реквизиты для стороны заказчика. */
  own: OwnRequisites;
  /** Отмена хода: запрос к сервису обрывается сразу. */
  signal?: AbortSignal | undefined;
}

/** Что сделано при дополнении: только факты, без значений. */
export interface AmendReport {
  /** Из какого формата файл приведён к docx; `null` - исходный файл уже был docx. */
  convertedFrom: ConvertedFrom | null;
  /** Заполнитель в преамбуле («___, именуемое «Заказчик»») заменён нашим наименованием. */
  preambleFilled: boolean;
  customerBlockFilled: boolean;
  /** Сколько заполнителей и пустых строк блока заказчика заполнено. */
  placeholdersFilled: number;
  /** Сколько строк реквизитов добавлено абзацами. */
  linesAdded: number;
  /** Заполнители в блоке заказчика, для которых у нас нет значения. */
  unfilledPlaceholders: number;
  notes: readonly string[];
}

/** Договор исполнителя, дополненный нашими данными (всегда docx). */
export interface AmendedContract extends AmendReport {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
}

/**
 * Вердикт кода о присланном файле (`/docx/classify`):
 * - `supplier` - не наш шаблон и сторона исполнителя заполнена: режим дополнения допустим;
 * - `own_template` - файл порождён нашими шаблонами: режим не включается;
 * - `our_side_executor` - в блоке исполнителя наши данные: режим не подходит;
 * - `unclear` - признак неоднозначен: агент спрашивает сотрудника.
 */
export const CONTRACT_VERDICTS = [
  'supplier',
  'own_template',
  'our_side_executor',
  'unclear',
] as const;
export type ContractVerdict = (typeof CONTRACT_VERDICTS)[number];

/** Запрос признака «договор поставщика». */
export interface ClassifyContractRequest {
  fileName: string;
  bytes: Uint8Array;
  /** Наши шаблоны договоров (байты с шары), с которыми сравнивается текст файла. */
  templates: readonly Uint8Array[];
  /** ИНН наших юрлиц: чтобы не принять нашу сторону за исполнителя. */
  ownInns: readonly string[];
  /** Наименования наших юрлиц. */
  ownNames: readonly string[];
  signal?: AbortSignal | undefined;
}

/** Итог классификации: вердикт и машинные коды причин (значений документа в них нет). */
export interface ContractKindResult {
  verdict: ContractVerdict;
  reasons: readonly string[];
  convertedFrom: ConvertedFrom | null;
}

/** Подписант нашей стороны в формах, как он печатается в шаблонах договоров. */
export interface OwnSignatoryForms {
  /** «Фамилия И.О.»: строка подписи блока «Заказчик». */
  nominativeShort: string;
  /** «И.О. Фамилия»: строка «____/И.О. Фамилия». */
  nominativeReversed: string;
  /** «Фамилия Имя Отчество» в родительном падеже: «в лице генерального директора ...». */
  genitiveFull: string;
  /** «Фамилия И.О.» в родительном падеже: преамбула приложения. */
  genitiveShort: string;
}

/** Итог подстановки подписанта: только числа, значений нет. */
export interface ReplaceSignatoryResult {
  /** Шаблон с новым подписантом; при `unchanged` - исходные байты. */
  bytes: Uint8Array;
  /** Сколько мест с подписантом найдено в шаблоне. */
  found: number;
  replaced: number;
  /** В шаблоне уже напечатан этот подписант: замен нет. */
  unchanged: boolean;
}

/**
 * Дополнение присланного договора исполнителя: наши реквизиты вписываются в сторону заказчика,
 * номер и данные исполнителя не меняются. Текст исполнителя не удаляется и не заменяется - это
 * проверяет сервис после правки. Исходный файл не меняется. Форматы .doc и RTF сервис приводит к
 * docx (LibreOffice), правит и выдаёт docx; проверка идёт по сконвертированному исходнику.
 */
export interface ContractAmender {
  /**
   * Дополнить договор. Нельзя или не прошла сверка - `ContractAmendRefusedError` с причиной;
   * сбой сервиса - ошибка адаптера.
   */
  amend(request: AmendContractRequest): Promise<AmendedContract>;
  /**
   * Признак «договор поставщика» кодом: не по нашему шаблону и сторона исполнителя заполнена.
   * Решает код, а не модель; результат агент получает как факт.
   */
  classify(request: ClassifyContractRequest): Promise<ContractKindResult>;
  /**
   * Прочитать блок стороны («Заказчик») документа, например нашего шаблона договора: в
   * шаблоне наши реквизиты напечатаны в этом блоке. Блока нет - `ContractAmendRefusedError`.
   */
  readPartyBlock(request: {
    bytes: Uint8Array;
    role: string;
    /** Отмена хода: запрос к сервису обрывается сразу. */
    signal?: AbortSignal | undefined;
  }): Promise<OwnRequisites>;
  /**
   * Подставить подписанта нашей стороны вместо напечатанного в шаблоне договора. Прежний
   * подписант определяется по самому шаблону (преамбула «в лице ... действующего», строки
   * подписи). Неоднозначно, не найден или остался после замены - `OwnSignatoryRefusedError`.
   */
  replaceSignatory(request: {
    bytes: Uint8Array;
    forms: OwnSignatoryForms;
    signal?: AbortSignal | undefined;
  }): Promise<ReplaceSignatoryResult>;
}
