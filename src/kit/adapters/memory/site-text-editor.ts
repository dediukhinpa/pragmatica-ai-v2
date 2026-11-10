import type {
  SiteTextEditOptions,
  SiteTextEditRequest,
  SiteTextEditResult,
  SiteTextEditor,
} from '../../ports/site-text-editor';

/**
 * Редактор текстов в памяти (заглушка и тестовый двойник): ответ задаётся функцией (по
 * умолчанию текст возвращается как есть), все запросы запоминаются для проверки в тестах.
 */
export class MemorySiteTextEditor implements SiteTextEditor {
  /** Пакеты запросов в порядке вызовов. */
  readonly batches: SiteTextEditRequest[][] = [];
  /** Треды вызовов в порядке вызовов. */
  readonly threadIds: string[] = [];

  constructor(
    private readonly decide: (request: SiteTextEditRequest, attempt: number) => string = (
      request,
    ) => request.text,
  ) {}

  async edit(
    requests: readonly SiteTextEditRequest[],
    options: SiteTextEditOptions,
  ): Promise<SiteTextEditResult[]> {
    options.signal.throwIfAborted();
    this.batches.push([...requests]);
    this.threadIds.push(options.threadId);
    return requests.map((request) => ({
      id: request.id,
      text: this.decide(
        request,
        this.batches.flat().filter((item) => item.id === request.id).length,
      ),
    }));
  }
}
