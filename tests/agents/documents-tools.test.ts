import { beforeEach, describe, expect, test } from 'bun:test';
import { DOCUMENTS_PROMPT } from '../../src/agents/documents/prompt';
import { ORDER_CALC_MAIL_PROMPT } from '../../src/agents/order-calc/prompt';
import { recordQuote } from '../../src/agents/order-calc/record-quote';
import { buildRenderData } from '../../src/agents/documents/render-data';
import {
  askToConfirmWebFields,
  recordWebFieldsDecision,
  webFieldsStatus,
  webRequestToken,
  recordWebConfirmation,
} from '../../src/agents/documents/web-confirmation';
import {
  assertDocumentBuildable,
  checkDocument,
  checkParties,
} from '../../src/agents/documents/checks';
import {
  documentFieldsValidator,
  documentPartiesValidator,
  documentSourcesValidator,
  saveDocument,
  saveDocumentKey,
} from '../../src/agents/documents/save-document';
import { fillTemplate } from '../../src/agents/documents/fill-template';
import { findTemplate } from '../../src/agents/documents/find-template';
import { searchInternetForDocuments } from '../../src/agents/documents/search-internet';
import { validateDocument } from '../../src/agents/documents/validate-document';
import { MemoryWebSearch } from '@business-ai/adapters';
import { DomainError, isDomainError } from '@business-ai/core';
import { validateDocumentFields } from '../../src/kit/domain/validators.owned';
import type { RenderRequest } from '@business-ai/core';
import {
  CTX,
  MANAGER_THREAD,
  buildDocument,
  buildDocumentsDeps,
  pressWebConfirm,
  putFile,
} from './support';

let deps: Awaited<ReturnType<typeof buildDocumentsDeps>>;
const TEMPLATE = 'templates/КП шаблон.docx';

beforeEach(async () => {
  deps = await buildDocumentsDeps();
  putFile(deps, TEMPLATE, 'tpl');
  putFile(deps, 'templates/Договор поставки.docx', 'tpl');
  putFile(deps, 'прайс.xlsx', 'not a template');
});

describe('findTemplate', () => {
  test('находит шаблон по слову и виду, подсказки из базы знаний отдельно', async () => {
    const query = { query: 'шаблон КП', kind: 'commercial_offer' as const };
    const out = await findTemplate.execute(query, deps, CTX);
    expect(out.templates.map((t) => t.path)).toEqual([TEMPLATE]);
    const contract = await findTemplate.execute({ query: 'договор', kind: 'contract' }, deps, CTX);
    expect(contract.templates).toHaveLength(1);
    expect(contract.knowledge[0]?.documentId).toBe('kb-1');
  });

  test('шаблона нет: пустой список', async () => {
    const out = await findTemplate.execute({ query: 'акт сверки', kind: 'invoice' }, deps, CTX);
    expect(out.templates).toEqual([]);
  });
});

describe('validateDocument: «всё из чата»', () => {
  test('корректный документ с отметками источников без замечаний', async () => {
    const out = await validateDocument.execute({ document: buildDocument() }, deps, CTX);
    expect(out).toEqual({ ok: true, issues: [] });
  });

  test('арифметика: итог, сумма строки, НДС', async () => {
    const doc = buildDocument({
      lines: [{ name: 'Болт М8', quantity: 10, unitPrice: 12, sum: 100 }],
      total: 120,
      vatRate: 20,
      vatAmount: 5,
    });
    const codes = (await validateDocument.execute({ document: doc }, deps, CTX)).issues.map(
      (i) => i.code,
    );
    expect(codes).toEqual(['line_sum_mismatch', 'vat_mismatch']);
    const ok = buildDocument({ vatRate: 20, vatAmount: 20 });
    expect((await validateDocument.execute({ document: ok }, deps, CTX)).ok).toBe(true);
    const half = buildDocument({ vatRate: 20 });
    const incomplete = await validateDocument.execute({ document: half }, deps, CTX);
    expect(incomplete.issues.map((i) => i.code)).toEqual(['vat_incomplete']);
  });

  // R9-A1-02: 22% (с 2026), 5% и 7% (УСН с НДС) принимаются; итог 120 включает НДС.
  test.each([
    [22, 21.64],
    [5, 5.71],
    [7, 7.85],
    [10, 10.91],
  ])('НДС %p%% от итога 120 = %p проходит', async (vatRate, vatAmount) => {
    const doc = buildDocument({ vatRate, vatAmount });
    expect(await validateDocument.execute({ document: doc }, deps, CTX)).toEqual({
      ok: true,
      issues: [],
    });
  });

  test('промпты и описание recordQuote знают действующие ставки и запрет подмены', () => {
    for (const text of [DOCUMENTS_PROMPT, ORDER_CALC_MAIL_PROMPT, recordQuote.description]) {
      expect(text).toContain('0, 5, 7, 10, 20, 22%');
    }
    expect(DOCUMENTS_PROMPT).toContain('не заменяй другой');
  });

  test('недопустимая ставка: предупреждение с перечнем действующих', async () => {
    const doc = buildDocument({ vatRate: 18, vatAmount: 18.31 });
    const out = await validateDocument.execute({ document: doc }, deps, CTX);
    expect(out.ok).toBe(true);
    expect(out.issues.map((i) => i.code)).toEqual(['vat_rate_invalid']);
    expect(out.issues[0]?.severity).toBe('warning');
    expect(out.issues[0]?.message).toContain('0, 5, 7, 10, 20, 22%');
  });

  test('итог не равен сумме строк', async () => {
    const doc = buildDocument({ total: 1 });
    const codes = (await validateDocument.execute({ document: doc }, deps, CTX)).issues.map(
      (i) => i.code,
    );
    expect(codes).toEqual(['total_mismatch']);
  });

  test('контрольные суммы ИНН, КПП и счёта в реквизитах документа', async () => {
    const doc = buildDocument({ requisites: { inn: '7707083894', kpp: '12', bik: '044525225' } });
    const invalid = validateDocumentFields(doc).filter((i) => i.code === 'requisite_invalid');
    expect(invalid.map((i) => i.message.split(':')[0])).toEqual([
      'В документе ИНН',
      'В документе КПП',
    ]);
    const good = buildDocument({ requisites: { inn: '7707083893', kpp: '770701001' } });
    expect(validateDocumentFields(good)).toEqual([]);
    // Тот же перехват работает в общей проверке документа (validateDocument).
    const codes = (await checkDocument(doc, deps)).map((i) => i.code);
    expect(codes).toContain('requisite_invalid');
  });

  test('нет отметки источника у существенных полей', async () => {
    const doc = { ...buildDocument(), fieldSources: { buyer: 'employee' as const } };
    const issues = await checkDocument(doc, deps);
    expect(issues.map((i) => i.code)).toEqual(['field_source_missing']);
    expect(issues[0]?.message).toContain('seller');
    expect(issues[0]?.message).toContain('lines.0.quantity');
  });

  test('отметка родителя покрывает вложенные поля', async () => {
    const base = buildDocument();
    const doc = {
      ...base,
      fieldSources: {
        buyer: 'employee' as const,
        seller: 'employee' as const,
        total: 'employee' as const,
        lines: 'knowledge' as const,
      },
    };
    expect(await checkDocument(doc, deps)).toEqual([]);
  });

  test('стороны неизвестны', async () => {
    const doc = buildDocument({ seller: 'ООО Левая' });
    const codes = (await checkParties(doc, deps)).map((i) => i.code);
    expect(codes).toEqual(['party_unknown']);
  });

  test('сторона-поставщик из базы считается известной', async () => {
    const doc = buildDocument({ seller: 'металлторг', buyer: 'ООО Левая' });
    expect(await checkParties(doc, deps)).toEqual([]);
  });
});

describe('поля из интернета', () => {
  /** Свой документ клиенту: условия оплаты нашёл веб-поиск. */
  const WEB_TERMS = '30 дней по данным сайта';
  const webDocument = (extra: Record<string, unknown> = {}) => {
    const base = buildDocument({ paymentTerms: WEB_TERMS });
    return {
      ...base,
      fieldSources: { ...base.fieldSources, paymentTerms: 'web' as const },
      ...extra,
    };
  };

  test('без подтверждения: предупреждение с именем поля, без значений', async () => {
    const out = await validateDocument.execute({ document: webDocument() }, deps, CTX);
    // Решение владельца 03.11: неподтверждённые веб-поля - предупреждение, не блокировка.
    expect(out.ok).toBe(true);
    const issue = out.issues.find((i) => i.code === 'web_fields_unconfirmed');
    expect(issue?.severity).toBe('warning');
    expect(issue?.message).toContain('Взято из интернета');
    expect(issue?.message).toContain('условия оплаты');
    expect(issue?.message).not.toContain(WEB_TERMS);
  });

  test('значения реквизитов из интернета не попадают в текст замечания и ошибки', async () => {
    const base = buildDocument({ requisites: { inn: '7707083893' } });
    const document = {
      ...base,
      fieldSources: { ...base.fieldSources, 'requisites.inn': 'web' as const },
    };
    const issues = await validateDocument.execute({ document }, deps, CTX);
    expect(JSON.stringify(issues)).not.toContain('7707083893');
    const input = { templatePath: TEMPLATE, document };
    const sources = await documentSourcesValidator.validate(input, deps, CTX);
    expect(JSON.stringify(sources)).not.toContain('7707083893');
  });

  test('без подтверждения документ собирается: fillTemplate и saveDocument', async () => {
    const document = webDocument();
    const filled = await fillTemplate.execute({ templatePath: TEMPLATE, document }, deps, CTX);
    expect(filled.fileName).toContain('.docx');
    const saved = await saveDocument.execute({ templatePath: TEMPLATE, document }, deps, CTX);
    expect(saved.delivered).toBe(true);
    expect(deps.chat.outbox).toHaveLength(1);
    // Единственная остановка сборки - выключенный вид документа.
    await expect(assertDocumentBuildable(document, deps)).resolves.toBeUndefined();
  });

  test('валидатор источников только предупреждает о веб-полях', async () => {
    const input = { templatePath: TEMPLATE, document: webDocument() };
    const issues = await documentSourcesValidator.validate(input, deps, CTX);
    expect(issues.map((i) => i.code)).toEqual(['web_fields_unconfirmed']);
    expect(issues.every((i) => i.severity === 'warning')).toBe(true);
    expect(documentSourcesValidator.appliesTo).toEqual(['saveDocument', 'handoffForReview']);
  });

  test('поле webConfirmedFields от модели подтверждением не считается', async () => {
    // Модель дописала «подтверждено» сама: схема документа поле не знает, код его не читает.
    const document = webDocument({ webConfirmedFields: ['paymentTerms'] });
    const codes = (await validateDocument.execute({ document }, deps, CTX)).issues.map(
      (i) => i.code,
    );
    expect(codes).toEqual(['web_fields_unconfirmed']);
  });

  test('запрос подтверждения: список со значениями и подсказка жирным, без кнопок', async () => {
    const asked = await askToConfirmWebFields.execute({ document: webDocument() }, deps, CTX);
    expect(asked).toEqual({ status: 'asked' });
    const message = deps.chat.outbox[0]?.message;
    expect(deps.chat.outbox[0]?.threadId).toBe(MANAGER_THREAD);
    expect(message?.text).toContain(`условия оплаты = ${WEB_TERMS}`);
    expect(message?.text).toContain('Например: «подтверждаю», «да», «не подтверждаю», «нет».');
    expect(message?.buttons).toBeUndefined();
  });

  test('ответ сотрудника текстом: recordWebFieldsDecision записывает подтверждение', async () => {
    const document = webDocument();
    const employee = { ...CTX, initiator: { kind: 'user' as const, userId: 'u7' } };
    const early = await recordWebFieldsDecision.execute(
      { document, decision: 'confirmed' },
      deps,
      employee,
    );
    expect(early).toEqual({ status: 'not_asked' });
    await askToConfirmWebFields.execute({ document }, deps, CTX);
    const scheduled = { ...CTX, initiator: { kind: 'scheduler' as const } };
    const denied = await recordWebFieldsDecision
      .execute({ document, decision: 'confirmed' }, deps, scheduled)
      .catch((e: unknown) => e);
    expect(isDomainError(denied) && denied.code).toBe('access_denied');
    const out = await recordWebFieldsDecision.execute(
      { document, decision: 'confirmed' },
      deps,
      employee,
    );
    expect(out).toEqual({ status: 'recorded', decision: 'confirmed' });
    expect((await validateDocument.execute({ document }, deps, CTX)).ok).toBe(true);
  });

  test('этап 164: свободные согласия и отказы кладутся в то же решение, ' +
    'повтор идемпотентен', async () => {
    const employee = { ...CTX, initiator: { kind: 'user' as const, userId: 'u7' } };
    // Смысл слов («хорошо», «давай», «ок», «подтверждаю») читает модель: код видит confirmed.
    for (const phrase of ['хорошо', 'давай', 'ок', 'подтверждаю']) {
      const world = await buildDocumentsDeps();
      const document = webDocument();
      await askToConfirmWebFields.execute({ document }, world, CTX);
      const out = await recordWebFieldsDecision.execute(
        { document, decision: 'confirmed' },
        world,
        employee,
      );
      expect({ phrase, status: out.status }).toEqual({ phrase, status: 'recorded' });
      const again = await recordWebFieldsDecision.execute(
        { document, decision: 'confirmed' },
        world,
        employee,
      );
      expect(again.status).toBe('already_decided');
    }
    // Отказ («не надо», «нет», «пока не нужно») - rejected: предупреждение, документ собирается.
    const document = webDocument();
    await askToConfirmWebFields.execute({ document }, deps, CTX);
    const no = await recordWebFieldsDecision.execute(
      { document, decision: 'rejected' },
      deps,
      employee,
    );
    expect(no).toEqual({ status: 'recorded', decision: 'rejected' });
    const after = await validateDocument.execute({ document }, deps, CTX);
    expect(after.ok).toBe(true);
    expect(after.issues.map((i) => i.code)).toContain('web_fields_rejected');
  });

  test('этап 164: неясный ответ и ответ не про вопрос ничего не пишут и ' +
    'решение не тратят', async () => {
    const employee = { ...CTX, initiator: { kind: 'user' as const, userId: 'u7' } };
    const document = webDocument();
    await askToConfirmWebFields.execute({ document }, deps, CTX);
    const unclear = await recordWebFieldsDecision.execute(
      { document, decision: 'unclear' },
      deps,
      employee,
    );
    expect(unclear.status).toBe('unclear');
    expect(unclear.question).toContain('повтори вопрос');
    expect((await webFieldsStatus(document, deps, CTX.threadId)).status).toBe('unconfirmed');
    // Одноразовое решение цело: следующий внятный ответ записывается.
    const out = await recordWebFieldsDecision.execute(
      { document, decision: 'confirmed' },
      deps,
      employee,
    );
    expect(out.status).toBe('recorded');
    // Служебный ход неясным ответом не обойти: проверка хода идёт до всего.
    const scheduled = { ...CTX, initiator: { kind: 'scheduler' as const } };
    const denied = await recordWebFieldsDecision
      .execute({ document, decision: 'unclear' }, deps, scheduled)
      .catch((e: unknown) => e);
    expect(isDomainError(denied) && denied.code).toBe('access_denied');
  });

  test('этап 164: промпт и описание инструмента перечисляют свободные слова', () => {
    for (const word of ['«хорошо»', '«давай»', '«ок»', '«не надо»', '«пока нет»', 'unclear']) {
      expect(DOCUMENTS_PROMPT).toContain(word);
      expect(recordWebFieldsDecision.description).toContain(word);
    }
  });

  test('нет веб-полей: подтверждение не требуется', async () => {
    const out = await askToConfirmWebFields.execute({ document: buildDocument() }, deps, CTX);
    expect(out).toEqual({ status: 'not_required' });
    expect(deps.chat.outbox).toEqual([]);
  });

  test('после нажатия кнопки документ собирается и уходит в чат', async () => {
    const document = webDocument();
    expect(await pressWebConfirm(deps, document)).toBe('recorded');
    expect((await validateDocument.execute({ document }, deps, CTX)).ok).toBe(true);
    const context = { ...CTX };
    putFile(deps, TEMPLATE, 'КП {{number}}, оплата {{paymentTerms}}');
    const out = await saveDocument.execute({ templatePath: TEMPLATE, document }, deps, context);
    expect(out.delivered).toBe(true);
    expect(deps.chat.outbox.at(-1)?.threadId).toBe(MANAGER_THREAD);
  });

  test('изменилось значение веб-поля: подтверждение недействительно', async () => {
    const document = webDocument();
    await pressWebConfirm(deps, document);
    const changed = { ...document, paymentTerms: '60 дней по данным сайта' };
    const codes = (await validateDocument.execute({ document: changed }, deps, CTX)).issues.map(
      (i) => i.code,
    );
    expect(codes).toEqual(['web_fields_unconfirmed']);
  });

  test('отметки источников и id на подтверждение не влияют, значения - влияют', async () => {
    const document = webDocument();
    await pressWebConfirm(deps, document);
    const renamed = { ...document, id: 'doc-other' };
    expect((await validateDocument.execute({ document: renamed }, deps, CTX)).ok).toBe(true);
  });

  test('подтверждение действует только в своём треде', async () => {
    const document = webDocument();
    await pressWebConfirm(deps, document);
    const other = { ...CTX, threadId: 'other-thread' };
    const codes = (await validateDocument.execute({ document }, deps, other)).issues.map(
      (i) => i.code,
    );
    expect(codes).toEqual(['web_fields_unconfirmed']);
  });

  test('нажатие из чужого треда или без личности не записывается', async () => {
    const document = webDocument();
    expect(await pressWebConfirm(deps, document, { threadId: 'thread-a' })).toBe('recorded');
    const { valuesHash } = await webFieldsStatus(document, deps, 'thread-a');
    const token = webRequestToken('thread-a', valuesHash);
    const base = { token, decision: 'confirmed' as const };
    const wrong = await recordWebConfirmation(deps.state, deps.clock, {
      ...base,
      userId: 'u',
      threadId: 'thread-b',
    });
    expect(wrong.kind).toBe('wrong_thread');
    const anonymous = await recordWebConfirmation(deps.state, deps.clock, {
      ...base,
      userId: '  ',
      threadId: 'thread-a',
    });
    expect(anonymous.kind).toBe('no_identity');
    const unknown = await recordWebConfirmation(deps.state, deps.clock, {
      token: 'нет',
      decision: 'confirmed',
      userId: 'u',
      threadId: 'thread-a',
    });
    expect(unknown.kind).toBe('unknown_request');
  });

  test('отказ сотрудника: предупреждение web_fields_rejected, документ собирается', async () => {
    const document = webDocument();
    await pressWebConfirm(deps, document, { decision: 'rejected' });
    const codes = (await validateDocument.execute({ document }, deps, CTX)).issues.map(
      (i) => i.code,
    );
    expect(codes).toEqual(['web_fields_rejected']);
  });

  test('значение из веб-поиска считается веб-полем, что бы ни отметила модель', async () => {
    const page = { title: 'Условия', url: 'https://x.example', snippet: `Оплата: ${WEB_TERMS}.` };
    const withWeb = { ...deps, web: new MemoryWebSearch([page]) };
    await searchInternetForDocuments.execute({ query: 'условия оплаты' }, withWeb, CTX);
    // Модель выдала найденное в вебе за слова сотрудника.
    const document = buildDocument({ paymentTerms: WEB_TERMS });
    expect(document.fieldSources?.['paymentTerms']).toBe('employee');
    const codes = (await validateDocument.execute({ document }, withWeb, CTX)).issues.map(
      (i) => i.code,
    );
    expect(codes).toEqual(['web_fields_unconfirmed']);
    expect(await pressWebConfirm(withWeb, document)).toBe('recorded');
    expect((await validateDocument.execute({ document }, withWeb, CTX)).ok).toBe(true);
  });

  test('без веб-поиска в треде значения из чата не трогаются', async () => {
    const document = buildDocument({ paymentTerms: WEB_TERMS });
    expect((await validateDocument.execute({ document }, deps, CTX)).ok).toBe(true);
  });
});

describe('fillTemplate', () => {
  test('готовит файл, ничего не отправляя', async () => {
    const document = buildDocument();
    const out = await fillTemplate.execute({ templatePath: TEMPLATE, document }, deps, CTX);
    expect(out.fileName).toBe('Заказчик_Коммерческое_предложение_КП-1.docx');
    expect(deps.chat.outbox).toEqual([]);
    expect(fillTemplate.sideEffect).toBeUndefined();
  });

  test('шаблон и данные документа передаются в рендерер', async () => {
    const seen: RenderRequest[] = [];
    const spy = {
      render: (request: RenderRequest) => {
        seen.push(request);
        return deps.renderer.render(request);
      },
    };
    putFile(deps, TEMPLATE, 'КП {{number}} для {{buyer}}\n{{items._n}}. {{items.name}}');
    await fillTemplate.execute(
      { templatePath: TEMPLATE, document: buildDocument() },
      { ...deps, renderer: spy },
      CTX,
    );
    const request = seen[0];
    expect(request?.template.kind).toBe('bytes');
    expect(request?.data).toEqual(buildRenderData(buildDocument()));
    expect(request?.outputName).toBe('Заказчик_Коммерческое_предложение_КП-1.docx');
    const rendered = await deps.renderer.render(request as RenderRequest);
    expect(new TextDecoder().decode(rendered.content)).toBe('КП КП-1 для ООО Заказчик\n1. Болт М8');
  });

  test('метка вне списка кода: повтор рендера с маркерами по error.missing, не 422', async () => {
    putFile(deps, TEMPLATE, 'КП {{number}}, ИНН {{buyerInn}}, КПП {{buyerKpp}}');
    let calls = 0;
    const counting = {
      render: (request: RenderRequest) => {
        calls += 1;
        return deps.renderer.render(request);
      },
    };
    const out = await fillTemplate.execute(
      { templatePath: TEMPLATE, document: buildDocument() },
      { ...deps, renderer: counting },
      CTX,
    );
    expect(calls).toBe(2);
    expect(out.unfilled).toHaveLength(2);
    expect(out.unfilled.join(' ')).toContain('buyerInn');
    expect(out.unfilled.join(' ')).toContain('buyerKpp');
  });

  test('технический сбой рендера по-прежнему пробрасывается', async () => {
    const broken = {
      render: async () => {
        throw new DomainError('invalid_input', 'Сервис документов отклонил шаблон: сбой.');
      },
    };
    const error = await fillTemplate
      .execute(
        { templatePath: TEMPLATE, document: buildDocument() },
        { ...deps, renderer: broken },
        CTX,
      )
      .catch((e) => e);
    expect(isDomainError(error) && error.code).toBe('invalid_input');
  });

  test('нет шаблона: not_found', async () => {
    const error = await fillTemplate
      .execute({ templatePath: 'нет.docx', document: buildDocument() }, deps, CTX)
      .catch((e) => e);
    expect(isDomainError(error) && error.code).toBe('not_found');
  });
});

describe('saveDocument', () => {
  test('отдаёт файл в тред из контекста рантайма', async () => {
    const document = buildDocument();
    const context = { ...CTX, threadId: 'thread-of-this-dialog' };
    const out = await saveDocument.execute({ templatePath: TEMPLATE, document }, deps, context);
    expect(out.delivered).toBe(true);
    expect(deps.chat.outbox[0]?.threadId).toBe('thread-of-this-dialog');
    expect(deps.chat.outbox[0]?.file?.name).toBe('Заказчик_Коммерческое_предложение_КП-1.docx');
  });

  test('плейсхолдер без значения: файл уходит с маркером, пропуск в unfilled', async () => {
    putFile(deps, TEMPLATE, 'ИНН {{buyerInn}}');
    const out = await saveDocument.execute(
      { templatePath: TEMPLATE, document: buildDocument() },
      deps,
      CTX,
    );
    expect(out.delivered).toBe(true);
    expect(out.unfilled.join(' ')).toContain('buyerInn');
    const sent = deps.chat.outbox[0]?.file;
    expect(new TextDecoder().decode(sent?.content)).toContain('[ЗАПОЛНИТЬ: buyerInn]');
  });

  test('валидатор полей предупреждает о неверном итоге', () => {
    const input = { templatePath: TEMPLATE, document: buildDocument({ total: 1 }) };
    const issues = documentFieldsValidator.validate(input, deps, CTX);
    expect(Array.isArray(issues) && issues.map((issue) => issue.code)).toContain('total_mismatch');
    const all = Array.isArray(issues) ? issues : [];
    expect(all.every((issue) => issue.severity === 'warning')).toBe(true);
  });

  test('валидатор сторон (асинхронный) предупреждает о неизвестных сторонах', async () => {
    const document = buildDocument({ seller: 'ООО Левая' });
    const issues = await documentPartiesValidator.validate(
      { templatePath: TEMPLATE, document },
      deps,
      CTX,
    );
    expect(issues.map((issue) => issue.code)).toEqual(['party_unknown']);
  });

  test('валидаторы привязаны к saveDocument', () => {
    // handoffForReview проходит те же проверки, что и выпуск документа.
    expect(documentFieldsValidator.appliesTo).toEqual(['saveDocument', 'handoffForReview']);
    expect(documentPartiesValidator.appliesTo).toEqual(['saveDocument', 'handoffForReview']);
  });

  test('ключ от данных документа: поставщик, вид, номер, дата, КП, шаблон, отпечаток', () => {
    const a = { templatePath: TEMPLATE, document: buildDocument() };
    const same = { templatePath: TEMPLATE, document: buildDocument() };
    const changed = { templatePath: TEMPLATE, document: buildDocument({ number: 'КП-2' }) };
    const quote = { templatePath: TEMPLATE, document: buildDocument({ requestId: 'req-1' }) };
    expect(saveDocumentKey(a)).toBe(saveDocumentKey(same));
    expect(saveDocumentKey(a)).not.toBe(saveDocumentKey(changed));
    expect(saveDocumentKey(a)).not.toBe(saveDocumentKey(quote));
    expect(saveDocumentKey(a)).toContain(`${a.document.seller}:commercial_offer:КП-1:`);
    expect(saveDocumentKey(a)).not.toContain('D-1');
  });
});
