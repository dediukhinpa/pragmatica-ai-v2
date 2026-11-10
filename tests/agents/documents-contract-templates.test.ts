import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  CONTRACT_TEMPLATES,
  contractTemplateByPath,
  contractTemplateFileNames,
  matchContractTemplate,
} from '../../src/agents/documents/template-registry';
import { DOCUMENTS_PROMPT } from '../../src/agents/documents/prompt';
import { buildRenderData, formatContractDate } from '../../src/agents/documents/render-data';
import { checkTemplateFieldsTool } from '../../src/agents/documents/check-template-fields';
import { fillTemplate } from '../../src/agents/documents/fill-template';
import { findTemplate } from '../../src/agents/documents/find-template';
import { isDomainError } from '@business-ai/core';
import { type DealDocument } from '../../src/kit/domain/models';
import { CTX, buildDocument, buildDocumentsDeps, putFile } from './support';

let deps: Awaited<ReturnType<typeof buildDocumentsDeps>>;

/** Все пять файлов шаблонов на диске. */
beforeEach(async () => {
  deps = await buildDocumentsDeps();
  for (const template of CONTRACT_TEMPLATES) putFile(deps, template.fileName, 'tpl');
});

const idOf = (phrase: string): string | undefined => {
  const found = matchContractTemplate(phrase);
  return found.status === 'unique' ? found.template.id : undefined;
};
const candidateIds = (phrase: string): string[] => {
  const found = matchContractTemplate(phrase);
  return found.status === 'ambiguous' ? found.candidates.map((item) => item.id).sort() : [];
};

describe('выбор шаблона договора по фразе сотрудника', () => {
  test.each([
    ['договор Мастер Гифтс на готовую продукцию', 'mg_ready'],
    ['Нужен договор МГ, контрактная продукция', 'mg_contract'],
    ['договор с Прагматикой на поставку готовой продукции', 'pr_ready'],
    ['ПР контрактный договор', 'pr_contract'],
    ['соглашение о неразглашении', 'mg_nda'],
    ['NDA', 'mg_nda'],
    ['МГ Соглашение NDA.docx', 'mg_nda'],
    ['конфиденциальность Мастер Гифтс', 'mg_nda'],
    ['договор Мастер Гифтс на контрактную продукцию', 'mg_contract'],
    ['Шаблон_ПР_Договора_на_поставку_готовой_продукции.docx', 'pr_ready'],
  ])('однозначно: «%s»', (phrase, id) => {
    expect(idOf(phrase)).toBe(id);
  });

  test('неоднозначно: без вида или без юрлица возвращает кандидатов', () => {
    expect(candidateIds('договор Мастер Гифтс')).toEqual(['mg_contract', 'mg_ready']);
    expect(candidateIds('договор с Прагматикой')).toEqual(['pr_contract', 'pr_ready']);
    expect(candidateIds('договор на готовую продукцию')).toEqual(['mg_ready', 'pr_ready']);
    expect(candidateIds('контрактный договор')).toEqual(['mg_contract', 'pr_contract']);
    expect(candidateIds('договор')).toEqual(['mg_contract', 'mg_ready', 'pr_contract', 'pr_ready']);
    // Оба юрлица названы: ограничения по юрлицу нет.
    expect(candidateIds('готовая продукция МГ и ПР')).toEqual(['mg_ready', 'pr_ready']);
  });

  test('не найдено: ничего не названо или названного нет', () => {
    expect(matchContractTemplate('подготовь что-нибудь').status).toBe('not_found');
    expect(matchContractTemplate('').status).toBe('not_found');
    expect(matchContractTemplate('счёт на оплату').status).toBe('not_found');
    // NDA есть только у «Мастер Гифтс».
    expect(matchContractTemplate('NDA Прагматика').status).toBe('not_found');
    expect(matchContractTemplate('соглашение о неразглашении ПР').status).toBe('not_found');
  });

  test('ё, регистр и разделители не мешают; «пр» внутри слова не юрлицо', () => {
    expect(idOf('ДОГОВОР «МАСТЕР-ГИФТС» ГОТОВАЯ ПРОДУКЦИЯ')).toBe('mg_ready');
    expect(idOf('договор мастер гифтс готовая продукция')).toBe('mg_ready');
    expect(matchContractTemplate('прайс').status).toBe('not_found');
  });

  test('путь на шаре: точный относительный путь и любая форма Юникода', () => {
    const decomposed = 'Договоры/МГ Соглашение NDA.docx'.normalize('NFD');
    expect(contractTemplateByPath(decomposed, 'Договоры/')?.id).toBe('mg_nda');
    expect(contractTemplateByPath('МГ Соглашение NDA.docx'.normalize('NFD'))?.id).toBe('mg_nda');
    expect(contractTemplateByPath('другой.docx')).toBeUndefined();
  });

  test('одноимённый файл в другом каталоге шаблоном реестра не считается', () => {
    expect(contractTemplateByPath('Архив/МГ Соглашение NDA.docx')).toBeUndefined();
    expect(contractTemplateByPath('Архив/МГ Соглашение NDA.docx', 'Договоры/')).toBeUndefined();
    expect(contractTemplateByPath('МГ Соглашение NDA.docx', 'Договоры/')).toBeUndefined();
  });

  test('«пр» и «мг» только отдельными словами, не склейкой через дефис', () => {
    // «ПР-Метал» - название контрагента, а не юрлицо «ПР»: подходят оба юрлица.
    const metal = matchContractTemplate('договор с ПР-Метал на контрактную продукцию');
    expect(metal.status).toBe('ambiguous');
    expect(candidateIds('договор с ПР-Метал на контрактную продукцию')).toEqual([
      'mg_contract',
      'pr_contract',
    ]);
    expect(idOf('договор ПР контрактная продукция')).toBe('pr_contract');
    expect(idOf('договор ПР, контрактная продукция')).toBe('pr_contract');
  });

  test('«готов» без слова «продукция» и «соглашение» без «о неразглашении» вид не называют', () => {
    // Юрлицо названо, вида нет: три шаблона МГ, а не договор на готовую продукцию.
    expect(matchContractTemplate('МГ, готов подписать').status).toBe('ambiguous');
    expect(candidateIds('МГ, готов подписать')).toEqual(['mg_contract', 'mg_nda', 'mg_ready']);
    expect(matchContractTemplate('дополнительное соглашение').status).toBe('not_found');
    expect(idOf('договор МГ на готовой продукции')).toBe('mg_ready');
    expect(idOf('соглашение о неразглашении')).toBe('mg_nda');
  });

  test('выбор по словам просит подтверждения, по названию файла - нет', () => {
    const byWords = matchContractTemplate('договор МГ на готовую продукцию');
    expect(byWords).toMatchObject({ status: 'unique', needsConfirmation: true });
    const byFile = matchContractTemplate('МГ Соглашение NDA.docx');
    expect(byFile).toMatchObject({ status: 'unique', needsConfirmation: false });
  });
});

describe('findTemplate: match', () => {
  const run = (query: string) => findTemplate.execute({ query }, deps, CTX);

  test('однозначный выбор отдаёт путь файла', async () => {
    const out = await run('соглашение о неразглашении');
    expect(out.match.status).toBe('unique');
    expect(out.match.template?.path).toBe('МГ Соглашение NDA.docx');
  });

  test('неоднозначный: кандидаты с путями', async () => {
    const out = await run('договор Мастер Гифтс');
    expect(out.match.status).toBe('ambiguous');
    expect(out.match.candidates.map((item) => item.path !== undefined)).toEqual([true, true]);
  });

  test('не найден: статус not_found, пустой список', async () => {
    const out = await run('что-то неизвестное');
    expect(out.match).toEqual({
      status: 'not_found',
      candidates: [],
      needsConfirmation: false,
    });
  });

  test('шаблон известен, файла на шаре нет: file_missing', async () => {
    const bare = await buildDocumentsDeps();
    const out = await findTemplate.execute({ query: 'NDA' }, bare, CTX);
    expect(out.match.status).toBe('file_missing');
  });

  test('файл вне перечня разрешённых не считается найденным', async () => {
    const strict = { ...deps, templateAllowlist: ['другое.docx'] };
    const out = await findTemplate.execute({ query: 'NDA' }, strict, CTX);
    expect(out.match.status).toBe('file_missing');
  });
});

/** Договор с реквизитами поставщика. */
function contract(overrides: Partial<DealDocument> = {}): DealDocument {
  return buildDocument({
    kind: 'contract',
    number: '15/26',
    issuedAt: '2026-10-21',
    seller: 'ООО «Ромашка»',
    total: 1234.5,
    lines: [
      { name: 'Болт М8', quantity: 1, unitPrice: 1234.5, characteristics: 'сталь', term: '10 дн.' },
    ],
    requisites: { inn: '7707083893', kpp: '770701001', bik: '044525225' },
    ...overrides,
  });
}

describe('данные для шаблона договора', () => {
  test('дата читаемая, сумма раскладывается, КПП ИП - пустой', () => {
    const data = buildRenderData(contract({ requisites: { inn: '500100732259' } }));
    expect(data.fields['issuedAt']).toBe('«21» октября 2026 года');
    expect(data.fields['total_rubles']).toBe(1234);
    expect(data.fields['total_kopecks']).toBe('50');
    expect(data.fields['seller_kpp']).toBe('');
    expect(data.fields['seller_inn']).toBe('500100732259');
  });

  test('копейки меньше десяти дополняются нулём', () => {
    const lines = [{ name: 'Болт', quantity: 1, unitPrice: 10.05 }];
    expect(buildRenderData(contract({ lines })).fields['total_kopecks']).toBe('05');
  });

  test('КП и счёт: дата остаётся как была', () => {
    const data = buildRenderData(buildDocument({ issuedAt: '2026-10-21' }));
    expect(data.fields['issuedAt']).toBe('2026-10-21');
    expect(data.fields['total_rubles']).toBeUndefined();
  });

  test('формат даты: ISO, русская запись, несуществующая и текст', () => {
    expect(formatContractDate('2026-10-21T10:00:00.000Z')).toBe('«21» октября 2026 года');
    expect(formatContractDate('1.3.2026')).toBe('«1» марта 2026 года');
    expect(formatContractDate('2026-02-30')).toBe('2026-02-30');
    expect(formatContractDate('двадцатое октября')).toBe('двадцатое октября');
  });

  test('поля сотрудника: допустимые подставляются, окончательный платёж считается', () => {
    const data = buildRenderData(
      contract({
        templateFields: {
          payment_variant: 'advance',
          prepayment_percent: '30',
          spec_date: '2026-10-22',
          seller_inn: '0',
        },
      }),
    );
    expect(data.fields['prepayment_percent']).toBe('30');
    expect(data.fields['final_payment_percent']).toBe('70');
    expect(data.fields['spec_date']).toBe('«22» октября 2026 года');
    // Реквизит через templateFields не перекрывается.
    expect(data.fields['seller_inn']).toBe('7707083893');
  });

  test('«—» вместо предоплаты даёт «—» в окончательном платеже', () => {
    const data = buildRenderData(
      contract({ templateFields: { payment_variant: 'advance', prepayment_percent: '—' } }),
    );
    expect(data.fields['final_payment_percent']).toBe('—');
  });
});

const NDA = 'МГ Соглашение NDA.docx';
const MG_READY = '2026_МГ_Шаблон_Договора_на_поставку_готовой_продукции.docx';
const NDA_FIELDS = {
  seller_representative: 'директора Иванова И. И.',
  seller_authority_basis: 'Устава',
  contract_number: '15/26',
  contract_date: '2026-10-01',
  seller_position: 'директор',
  nda_penalty_amount: '50000',
};

describe('проверка меток шаблона до сборки', () => {
  test('NDA без данных: вопросы человеческими словами, без меток', async () => {
    const out = await checkTemplateFieldsTool.execute(
      { templatePath: NDA, document: contract() },
      deps,
      CTX,
    );
    expect(out.complete).toBe(false);
    expect(out.missingLabels).toEqual([
      'seller_representative',
      'seller_position',
      'seller_authority_basis',
      'contract_number',
      'contract_date',
      'nda_penalty_amount',
    ]);
    expect(out.questions.join(' ')).toContain('штраф');
    expect(out.questions.join(' ')).not.toContain('{{');
  });

  test('NDA с полями сотрудника полная', async () => {
    const out = await checkTemplateFieldsTool.execute(
      { templatePath: NDA, document: contract({ templateFields: NDA_FIELDS }) },
      deps,
      CTX,
    );
    expect(out).toMatchObject({ known: true, templateId: 'mg_nda', complete: true });
  });

  test('договор МГ: нужны срок изготовления, срок поставки и гарантия', async () => {
    const out = await checkTemplateFieldsTool.execute(
      { templatePath: MG_READY, document: contract() },
      deps,
      CTX,
    );
    expect(out.missingLabels).toContain('production_days');
    expect(out.missingLabels).toContain('warranty_months');
    // С 23.10.2026 шаблоны МГ тоже пишут «Срок поставки: {{delivery_days}} рабочих дней»
    expect(out.missingLabels).toContain('delivery_days');
    // Окончательный платёж отдельно не спрашивается, пока нет предоплаты.
    expect(out.missingLabels).not.toContain('final_payment_percent');
    expect(out.missingLabels).not.toContain('seller_kpp');
    expect(out.missingLabels).not.toContain('issuedAt');
  });

  test('лишний ключ и не процент отклоняются', async () => {
    const out = await checkTemplateFieldsTool.execute(
      {
        templatePath: NDA,
        document: contract({ templateFields: { ...NDA_FIELDS, seller_inn: '1', total: '5' } }),
      },
      deps,
      CTX,
    );
    expect(out.rejectedKeys).toEqual(['seller_inn', 'total']);
    expect(out.complete).toBe(false);
    const percent = await checkTemplateFieldsTool.execute(
      {
        templatePath: MG_READY,
        document: contract({
          templateFields: { payment_variant: 'advance', prepayment_percent: 'половина' },
        }),
      },
      deps,
      CTX,
    );
    expect(percent.missingLabels).toContain('prepayment_percent');
  });

  test('другой шаблон (КП): проверка не применяется', async () => {
    putFile(deps, 'КП.docx', 'tpl');
    const out = await checkTemplateFieldsTool.execute(
      { templatePath: 'КП.docx', document: buildDocument() },
      deps,
      CTX,
    );
    expect(out).toMatchObject({ known: false, complete: true, questions: [] });
  });

  test('шаблон вне перечня разрешённых: access_denied', async () => {
    const strict = { ...deps, templateAllowlist: [MG_READY] };
    const error = await checkTemplateFieldsTool
      .execute({ templatePath: NDA, document: contract() }, strict, CTX)
      .catch((e: unknown) => e);
    expect(isDomainError(error) && error.code).toBe('access_denied');
  });

  test('fillTemplate собирает NDA с пропусками: маркеры и вопрос в unfilled', async () => {
    const out = await fillTemplate.execute(
      { templatePath: NDA, document: contract() },
      deps,
      CTX,
    );
    expect(out.sizeBytes).toBeGreaterThan(0);
    expect(out.unfilled.join(' ')).toContain('Какой размер штрафа');
  });

  test('fillTemplate собирает NDA, когда всё заполнено', async () => {
    const out = await fillTemplate.execute(
      { templatePath: NDA, document: contract({ templateFields: NDA_FIELDS }) },
      deps,
      CTX,
    );
    expect(out.fileName).toContain('.docx');
  });
});

describe('промпт агента документов', () => {
  test('как называть шаблон, что спрашивать, что ничего не отправляет', () => {
    for (const text of [
      'findTemplate',
      'match.status',
      'ambiguous',
      'checkTemplateFields',
      'templateFields',
      'Сам ты ничего не отправляешь',
      'NDA',
    ]) {
      expect(DOCUMENTS_PROMPT).toContain(text);
    }
  });
});

describe('промпт: пропуски не блокируют выдачу', () => {
  test('один вопрос и маркеры вместо «жди» и «не готовь»', () => {
    expect(DOCUMENTS_PROMPT).toContain('НЕ спрашивай: оставь маркеры');
    expect(DOCUMENTS_PROMPT).toContain('[ЗАПОЛНИТЬ: …]');
    for (const old of ['ВСЕ вопросы', 'документ не готовь', 'и жди ответа', 'Не обходи проверку']) {
      expect(DOCUMENTS_PROMPT).not.toContain(old);
    }
    expect(DOCUMENTS_PROMPT).not.toContain('дождись подтверждения; только потом');
  });

  test('шаблон: назвать и продолжить, ambiguous - вероятный и остальные в конце', () => {
    expect(DOCUMENTS_PROMPT).toContain('продолжай в том же ходе');
    expect(DOCUMENTS_PROMPT).toContain('предложи остальные варианты');
    expect(DOCUMENTS_PROMPT).not.toContain('сам не выбирай');
  });

  test('запреты не ослаблены: не выдумывать, веб только после подтверждения, не отправлять', () => {
    for (const text of [
      'не выдумывай',
      'Подтверждение',
      'нельзя выдумать',
      'Сам ты ничего не отправляешь',
      'НИКОГДА не называешь документ подписанным',
    ]) {
      expect(DOCUMENTS_PROMPT).toContain(text);
    }
  });

  test('описания инструментов без «дождись подтверждения»', async () => {
    const description = findTemplate.description ?? '';
    expect(description).not.toContain('дождись');
    expect(description).not.toContain('переспроси');
  });
});

describe('перечень разрешённых шаблонов в документации', () => {
  test('значение DOCUMENT_TEMPLATE_ALLOWLIST в deploy/.env.example = имена файлов реестра', () => {
    const path = new URL('../../deploy/.env.example', import.meta.url);
    const example = readFileSync(path, 'utf8');
    const line = /^#DOCUMENT_TEMPLATE_ALLOWLIST=(.+)$/m.exec(example);
    expect(line?.[1]?.split(',').map((name) => name.trim())).toEqual(contractTemplateFileNames());
  });
});
