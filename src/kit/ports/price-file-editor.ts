import type { DiskFile, TempDiskFile } from '@business-ai/core';

/** Новое значение одной ячейки цены в исходном файле. */
export interface PriceCellEdit {
  /** Название листа (xlsx); нет - берётся таблица по номеру. */
  sheet?: string | undefined;
  /** Номер таблицы файла (с нуля, как в readPriceFile); для docx и csv - единственная ключевая. */
  table?: number | undefined;
  /**
   * Строка и столбец с нуля, как в markdown из readPriceFile. Это индексы разобранной таблицы
   * (пустые строки и столбцы в ней выброшены), а не номера строки и столбца листа: сервис
   * переводит их в ячейку файла по тем же правилам, что и разбор.
   */
  row: number;
  col: number;
  value: number;
  /**
   * Старое значение ячейки, как его прочитал core. Если в файле сейчас другое, сервис ячейку
   * не пишет (пропуск `mismatch`): координата не должна попасть в чужую ячейку.
   */
  expected?: number | string | null | undefined;
  /**
   * Число в текстовом блоке слайда pptx (вне таблицы): слайд с 1, путь фигуры (id через «/»),
   * абзац с 0 и смещение числа в абзаце с 0, как их отдаёт `/parse` с `locations=true`. Либо
   * все четыре, либо ни одного. С локатором `row` и `col` равны 0, `table` не задаётся, а
   * `expected` обязателен: координатам текстового блока сервис без старого значения не верит.
   */
  slide?: number | undefined;
  shape?: string | undefined;
  paragraph?: number | undefined;
  start?: number | undefined;
}

/** Ячейка, которую сервис не изменил, и причина. */
export interface SkippedPriceEdit {
  sheet?: string | undefined;
  table?: number | undefined;
  row: number;
  col: number;
  reason: string;
  /** Локатор текстового блока pptx из правки, которую сервис не тронул (см. PriceCellEdit). */
  slide?: number | undefined;
  shape?: string | undefined;
  paragraph?: number | undefined;
  start?: number | undefined;
}

/** Запрос правки цен в копии исходного файла. */
export interface EditPricesRequest {
  fileName: string;
  bytes: Uint8Array;
  edits: readonly PriceCellEdit[];
}

/** Файл с исправленными ценами и итог правки. */
export interface EditedPriceFile {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
  /** Сколько ячеек изменено. */
  changed: number;
  /** Ячейки, которые не тронуты (текстовые цены, формулы, вне таблицы). */
  skipped: readonly SkippedPriceEdit[];
  /**
   * Исходный формат, если результат в другом: `ppt` - старый файл приведён к pptx, правка и
   * отправка идут в pptx (обратная конвертация теряет вёрстку). Нет - формат прежний.
   */
  convertedFrom?: string | undefined;
}

/** Запрос правки цен в файле на диске (этап 231): файл в память целиком не читается. */
export interface EditPricesFileRequest {
  fileName: string;
  /** Исходный файл; не изменяется и не удаляется. */
  file: DiskFile;
  edits: readonly PriceCellEdit[];
}

/** Результат правки цен файлом на диске. */
export interface EditedPriceDiskFile {
  fileName: string;
  mimeType: string;
  /** Исправленный файл; вызывающий убирает его через `dispose`. */
  file: TempDiskFile;
  changed: number;
  skipped: readonly SkippedPriceEdit[];
  /** См. {@link EditedPriceFile.convertedFrom}. */
  convertedFrom?: string | undefined;
}

/**
 * Правка цен в копии исходного прайса: меняются только указанные ячейки, структура, стили и
 * остальное содержимое сохраняются. Исходный файл на диске не затрагивается.
 */
export interface PriceFileEditor {
  /**
   * Применить правки. Формат, который на месте не правится (xls, скан, pdf или pptx при
   * выключенной правке), - UnsupportedPriceFormatError; файл, который сервис отказался править
   * строгими проверками (pdf: цена не найдена однозначно, нет глифов, не помещается; старый
   * .ppt после конвертации), - PriceEditRefusedError с причинами по местам; файл больше
   * предела сервиса - PriceFileTooLargeError (повтор бесполезен); пустой список правок и
   * неверная ячейка вне файла - в `skipped` либо DomainError('invalid_input').
   */
  editPrices(request: EditPricesRequest): Promise<EditedPriceFile>;
  /**
   * То же для файла на диске: прайс до 100 МБ с картинками уходит в сервис и возвращается
   * потоком через диск, пик памяти не растёт с размером файла. Отказы те же, что у
   * `editPrices`.
   */
  editPricesFile?(request: EditPricesFileRequest): Promise<EditedPriceDiskFile>;
}
