import type {
  SitePagePicker,
  SitePagesChoiceInput,
  WebCandidateEnricher,
  WebHitClassifier,
  WebHitClassifyInput,
  WebCandidatePage,
  WebModelOptions,
  WebQueryPlanInput,
  WebQueryPlanner,
  SupplierNameInput,
  SupplierSiteChoiceInput,
  SupplierSiteChooser,
} from '../../ports/web-candidate-model';

/** Планировщик в памяти (тестовый двойник): отдаёт заданный ответ, запоминает входы. */
export class MemoryWebQueryPlanner implements WebQueryPlanner {
  readonly seen: WebQueryPlanInput[] = [];

  constructor(private readonly answer: (input: WebQueryPlanInput) => unknown) {}

  async plan(input: WebQueryPlanInput, options: WebModelOptions): Promise<unknown> {
    options.signal.throwIfAborted();
    this.seen.push(input);
    return this.answer(input);
  }
}

/** Обогатитель в памяти (тестовый двойник): ответ по странице, входы запоминаются. */
export class MemoryWebCandidateEnricher implements WebCandidateEnricher {
  readonly seen: WebCandidatePage[] = [];

  constructor(private readonly answer: (page: WebCandidatePage) => unknown) {}

  async extract(page: WebCandidatePage, options: WebModelOptions): Promise<unknown> {
    options.signal.throwIfAborted();
    this.seen.push(page);
    return this.answer(page);
  }
}

/** Классификатор хитов в памяти (тестовый двойник): ответ по входу, входы запоминаются. */
export class MemoryWebHitClassifier implements WebHitClassifier {
  readonly seen: WebHitClassifyInput[] = [];

  constructor(private readonly answer: (input: WebHitClassifyInput) => unknown) {}

  async classify(input: WebHitClassifyInput, options: WebModelOptions): Promise<unknown> {
    options.signal.throwIfAborted();
    this.seen.push(input);
    return this.answer(input);
  }
}

/** Выбор сайта в памяти (тестовый двойник): ответы по входу, входы и число вызовов запоминаются. */
export class MemorySupplierSiteChooser implements SupplierSiteChooser {
  readonly nameInputs: SupplierNameInput[] = [];
  readonly siteInputs: SupplierSiteChoiceInput[] = [];

  constructor(
    private readonly answers: {
      checkName?: (input: SupplierNameInput) => unknown;
      chooseSite?: (input: SupplierSiteChoiceInput) => unknown;
    },
  ) {}

  async checkName(input: SupplierNameInput, options: WebModelOptions): Promise<unknown> {
    options.signal.throwIfAborted();
    this.nameInputs.push(input);
    return this.answers.checkName?.(input) ?? { isCompany: true };
  }

  async chooseSite(input: SupplierSiteChoiceInput, options: WebModelOptions): Promise<unknown> {
    options.signal.throwIfAborted();
    this.siteInputs.push(input);
    return this.answers.chooseSite?.(input) ?? { site: null };
  }
}

/** Выбор страниц сайта в памяти (тестовый двойник): ответ по входу, входы запоминаются. */
export class MemorySitePagePicker implements SitePagePicker {
  readonly seen: SitePagesChoiceInput[] = [];

  constructor(private readonly answer: (input: SitePagesChoiceInput) => unknown) {}

  async pickPages(input: SitePagesChoiceInput, options: WebModelOptions): Promise<unknown> {
    options.signal.throwIfAborted();
    this.seen.push(input);
    return this.answer(input);
  }
}
