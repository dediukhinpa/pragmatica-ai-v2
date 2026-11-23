
/** Ключи работ: единое место, чтобы пишущие и читающие инструменты не разошлись. */
export const workSubject = {
  /** Импорт прайса: по хэшу файла (один файл - одна работа, у любого поставщика). */
  import: (fileHash: string): string => `import:${fileHash}`,
  /** Заявка на закупку: расчёт, шорт-лист, напоминание. */
  order: (requestId: string): string => `order:${requestId}`,
  /** Набор карточек выгрузки на сайт. */
  export: (exportId: string): string => `export:${exportId}`,
} as const;
