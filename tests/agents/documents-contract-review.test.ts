import { beforeEach, describe, expect, test } from 'bun:test';
import { CONTRACT_TEMPLATES } from '../../src/agents/documents/template-registry';
import { DOCUMENTS_PROMPT } from '../../src/agents/documents/prompt';
import { buildRenderData } from '../../src/agents/documents/render-data';
import { checkTemplateFieldsTool } from '../../src/agents/documents/check-template-fields';
import { fillTemplate } from '../../src/agents/documents/fill-template';
import { findTemplate } from '../../src/agents/documents/find-template';
import {
  isTemplatePathAllowed,
  readAllowedTemplate,
} from '../../src/agents/documents/template-access';
import { parseAmountWords } from '../../src/agents/documents/amount-words';
import { parsePercent } from '../../src/agents/documents/template-fields';
import type { DealDocument } from '../../src/kit/domain/models';
import { CTX, buildDocument, buildDocumentsDeps, putFile } from './support';

let deps: Awaited<ReturnType<typeof buildDocumentsDeps>>;

beforeEach(async () => {
  deps = await buildDocumentsDeps();
  for (const template of CONTRACT_TEMPLATES) putFile(deps, template.fileName, 'tpl');
});

const MG_READY = '2026_МГ_Шаблон_Договора_на_поставку_готовой_продукции.docx';
const NDA = 'МГ Соглашение NDA.docx';

/** Реквизиты поставщика, которые код подставляет в метки `seller_*`. */
const FULL_REQUISITES: Record<string, string> = {
  inn: '7707083893',
  kpp: '770701001',
  bik: '044525225',
  settlementAccount: '40702810900000000001',
  bankName: 'ПАО Банк',
  correspondentAccount: '30101810400000000225',
  legalAddress: 'г. Москва, ул. Тестовая, 1',
  directorName: 'Иванов И. И.',
};

/** Договор на 120 000 рублей ровно. */
function contract(overrides: Partial<DealDocument> = {}): DealDocument {
  return buildDocument({
    kind: 'contract',
    number: '15/26',
    issuedAt: '2026-10-21',
    seller: 'ООО «Ромашка»',
    total: 120_000,
    lines: [
      {
        name: 'Болт М8',
        quantity: 1,
        unitPrice: 120_000,
        characteristics: 'сталь',
        term: '10 дн.',
      },
    ],
    requisites: FULL_REQUISITES,
    ...overrides,
  });
}

/** Все метки МГ «готовая продукция», которые называет сотрудник. */
const FULL_FIELDS = {
  seller_representative: 'директора Иванова И. И.',
  seller_position: 'директор',
  seller_authority_basis: 'Устава',
  payment_variant: 'advance',
  delivery_variant: 'pickup',
  spec_number: '1',
  spec_date: '2026-10-22',
  tz_number: '2',
  prepayment_percent: '30',
  production_days: '20',
  delivery_days: '5',
  warranty_period: '12 месяцев',
  warranty_months: '12',
  buyer_contact_name: 'Петров П. П.',
  buyer_contact_phone: '+7 900 000-00-00',
  buyer_contact_email: 'p@example.com',
  seller_contactName: 'Сидоров С. С.',
  seller_phone: '+7 900 111-11-11',
  seller_email: 's@example.com',
};

const check = (document: DealDocument, templatePath = MG_READY) =>
  checkTemplateFieldsTool.execute({ templatePath, document }, deps, CTX);

describe('сумма прописью сверяется с суммой договора', () => {
  test('разбор числительных', () => {
    expect(parseAmountWords('сто двадцать тысяч')).toBe(120_000);
    expect(parseAmountWords('Сто двадцать тысяч рублей')).toBe(120_000);
    expect(parseAmountWords('одна тысяча пятьсот')).toBe(1500);
    expect(parseAmountWords('два миллиона триста тысяч пять')).toBe(2_300_005);
    expect(parseAmountWords('тысяча')).toBe(1000);
    expect(parseAmountWords('много денег')).toBeUndefined();
    expect(parseAmountWords('  ')).toBeUndefined();
  });

  test('все метки заполнены, договор полный: пропись считает код', async () => {
    const out = await check(contract({ templateFields: FULL_FIELDS }));
    expect(out.complete).toBe(true);
    expect(buildRenderData(contract()).fields['total_rubles_words']).toBe('сто двадцать тысяч');
  });

  test('пропись сотрудника не принимается: ключ отклоняется, значение не нужно', async () => {
    const document = contract({
      templateFields: { ...FULL_FIELDS, total_rubles_words: 'сто тысяч' },
    });
    const out = await check(document);
    expect(out.complete).toBe(false);
    expect(out.rejectedKeys).toEqual(['total_rubles_words']);
    expect(buildRenderData(document).fields['total_rubles_words']).toBe('сто двадцать тысяч');
  });

  test('итог считает код по строкам, а не слово модели в total', () => {
    const data = buildRenderData(contract({ total: 5 }));
    expect(data.fields['total_rubles']).toBe(120_000);
    expect(data.fields['total']).toBe(120_000);
  });

  test('пропись сотрудника игнорируется с предупреждением, договор собран', async () => {
    const out = await fillTemplate.execute(
      {
        templatePath: MG_READY,
        document: contract({ templateFields: { ...FULL_FIELDS, total_rubles_words: 'сто' } }),
      },
      deps,
      CTX,
    );
    expect(out.fileName).toContain('.docx');
    expect(out.unfilled.join(' ')).toContain('total_rubles_words');
  });
});

describe('окончательный платёж и предоплата', () => {
  test('слово сотрудника расчёт не перекрывает', () => {
    const data = buildRenderData(
      contract({
        templateFields: {
          payment_variant: 'advance',
          prepayment_percent: '30',
          final_payment_percent: '10',
        },
      }),
    );
    expect(data.fields['final_payment_percent']).toBe('70');
  });

  test('предоплата и окончательный платёж не дают 100 - вопрос', async () => {
    const out = await check(
      contract({ templateFields: { ...FULL_FIELDS, final_payment_percent: '10' } }),
    );
    expect(out.complete).toBe(false);
    expect(out.missingLabels).toEqual(['final_payment_percent']);
  });

  test('согласованные 30 и 70 принимаются', async () => {
    const out = await check(
      contract({ templateFields: { ...FULL_FIELDS, final_payment_percent: '70' } }),
    );
    expect(out.complete).toBe(true);
  });

  test('дробные проценты: 12,5 и 87,5 дают 100', async () => {
    const out = await check(
      contract({
        templateFields: {
          ...FULL_FIELDS,
          prepayment_percent: '12,5%',
          final_payment_percent: '87.5',
        },
      }),
    );
    expect(out.complete).toBe(true);
  });
});

describe('«—» только там, где вариант может быть не выбран', () => {
  test('условные поля с «—» заполнены', async () => {
    const out = await check(
      contract({
        templateFields: {
          ...FULL_FIELDS,
          prepayment_percent: '—',
          delivery_address: '—',
          warranty_period: '—',
          warranty_months: '—',
        },
      }),
    );
    expect(out.complete).toBe(true);
  });

  test('«—» у подписанта, номера спецификации, штрафа NDA - не заполнено', async () => {
    const out = await check(
      contract({
        templateFields: { ...FULL_FIELDS, seller_representative: '—', spec_number: ' — ' },
      }),
    );
    expect(out.missingLabels).toEqual(['seller_representative', 'spec_number']);
    const nda = await check(
      contract({
        templateFields: {
          seller_representative: 'директора Иванова И. И.',
          seller_authority_basis: 'Устава',
          contract_number: '1',
          contract_date: '2026-10-01',
          seller_position: 'директор',
          nda_penalty_amount: '—',
        },
      }),
      NDA,
    );
    expect(nda.missingLabels).toEqual(['nda_penalty_amount']);
  });

  test('у ИП (ИНН из 12 цифр) КПП пустой и не спрашивается', async () => {
    const requisites = { ...FULL_REQUISITES, inn: '500100732259', kpp: '' };
    const ip = await check(
      contract({ templateFields: FULL_FIELDS, requisites }),
    );
    expect(ip.missingLabels).not.toContain('seller_kpp');
  });
});

describe('проценты строго', () => {
  test.each(['30', '30%', '12,5', '12.5%', '0', '100'])('«%s» - процент', (value) => {
    expect(parsePercent(value)).toBeDefined();
  });

  test.each(['1e1', '0x10', '.5', '5.', '', ' ', '-5', '101', '1000', '30 %', 'Infinity', '30%%'])(
    '«%s» - не процент',
    (value) => {
      expect(parsePercent(value)).toBeUndefined();
    },
  );

  test('«1e1» в предоплате - вопрос, а не 10%', async () => {
    const out = await check(
      contract({ templateFields: { ...FULL_FIELDS, prepayment_percent: '1e1' } }),
    );
    expect(out.complete).toBe(false);
    expect(out.missingLabels).toEqual(['prepayment_percent']);
    expect(
      buildRenderData(
        contract({ templateFields: { payment_variant: 'advance', prepayment_percent: '1e1' } }),
      ).fields,
    ).toMatchObject({ final_payment_percent: '—' });
  });
});

describe('ИНН и реквизиты', () => {
  test('ИНН ИП с пробелами и дефисами нормализуется до цифр: КПП пустой', () => {
    const data = buildRenderData(
      contract({ requisites: { inn: '5001 007-32259' } }),
    );
    expect(data.fields['seller_kpp']).toBe('');
  });

  test('юрлицо с КПП: КПП из реквизитов, прочерка нет', () => {
    expect(buildRenderData(contract()).fields['seller_kpp']).toBe('770701001');
  });

  test('requisites принимает только поля поставщика; прочее не попадает в метки', () => {
    const data = buildRenderData(
      contract({
        requisites: {
          ...FULL_REQUISITES,
          contactName: 'Подмена',
          phone: '1',
          representative: 'x',
          email: 'a@b.c',
        },
      }),
    );
    expect(data.fields['seller_inn']).toBe('7707083893');
    for (const key of ['seller_contactName', 'seller_phone', 'seller_representative']) {
      expect(data.fields[key]).toBeUndefined();
    }
    expect(data.fields['seller_email']).toBeUndefined();
  });

  test('метки через requisites не закрываются; лишние ключи - предупреждение', async () => {
    const document = contract({
      requisites: { ...FULL_REQUISITES, contactName: 'Подмена', phone: '1' },
      templateFields: FULL_FIELDS,
    });
    const out = await check(document);
    expect(out.rejectedRequisites).toEqual(['contactName', 'phone']);
    expect(out.complete).toBe(false);
    const filled = await fillTemplate.execute({ templatePath: MG_READY, document }, deps, CTX);
    expect(filled.unfilled.join(' ')).toContain('requisites');
  });

  test('seller_contactName без templateFields остаётся незаполненным', async () => {
    const withoutContact = { ...FULL_FIELDS } as Record<string, string>;
    delete withoutContact['seller_contactName'];
    const out = await check(
      contract({
        requisites: { ...FULL_REQUISITES, contactName: 'Подмена' },
        templateFields: withoutContact,
      }),
    );
    expect(out.missingLabels).toContain('seller_contactName');
  });
});

describe('NFC: путь и перечень разрешённых', () => {
  const nfd = (text: string): string => text.normalize('NFD');

  test('NFD-имя файла при перечне в NFC и наоборот', async () => {
    const decomposed = nfd(MG_READY);
    expect(decomposed).not.toBe(MG_READY);
    const byNfc = { ...deps, templateAllowlist: [MG_READY] };
    expect(isTemplatePathAllowed(byNfc, decomposed)).toBe(true);
    const byNfd = { ...deps, templateAllowlist: [decomposed] };
    expect(isTemplatePathAllowed(byNfd, MG_READY)).toBe(true);
    expect(isTemplatePathAllowed(byNfd, decomposed)).toBe(true);
    expect(isTemplatePathAllowed(byNfc, nfd('Другое.docx'))).toBe(false);
  });

  test('каталог в перечне и префикс каталога сравниваются в NFC', () => {
    const dir = nfd('Шаблоны_готовой/');
    const scoped = { ...deps, templateAllowlist: [dir] };
    expect(isTemplatePathAllowed(scoped, `Шаблоны_готовой/${MG_READY}`)).toBe(true);
    const prefixed = { ...deps, templatesPrefix: nfd('Шаблоны_готовой/') };
    expect(isTemplatePathAllowed(prefixed, `Шаблоны_готовой/${MG_READY}`)).toBe(true);
  });

  test('чтение: файл лежит под NFD-именем, запрос в NFC - читается', async () => {
    const bare = await buildDocumentsDeps();
    putFile(bare, nfd(MG_READY), 'nfd-bytes');
    const strict = { ...bare, templateAllowlist: [MG_READY] };
    const read = await readAllowedTemplate(strict, MG_READY);
    expect(new TextDecoder().decode(read.content)).toBe('nfd-bytes');
    expect(read.path).toBe(MG_READY);
  });

  test('findTemplate: NFD-файл при перечне в NFC находится', async () => {
    const bare = await buildDocumentsDeps();
    putFile(bare, nfd(MG_READY), 'x');
    const out = await findTemplate.execute(
      { query: 'договор МГ готовая продукция' },
      { ...bare, templateAllowlist: [MG_READY] },
      CTX,
    );
    expect(out.match.status).toBe('unique');
    expect(out.templates.length).toBe(1);
  });
});

describe('findTemplate: точный путь и одноимённые файлы', () => {
  test('файл в каталоге префикса - unique; в другом каталоге - file_missing', async () => {
    const bare = await buildDocumentsDeps();
    putFile(bare, `Договоры/${NDA}`, 'x');
    putFile(bare, `Архив/${NDA}`, 'x');
    const out = await findTemplate.execute(
      { query: 'NDA' },
      { ...bare, templatesPrefix: 'Договоры/' },
      CTX,
    );
    expect(out.match.status).toBe('unique');
    expect(out.match.template?.path).toBe(`Договоры/${NDA}`);
    const wrong = await buildDocumentsDeps();
    putFile(wrong, `Архив/${NDA}`, 'x');
    const missing = await findTemplate.execute({ query: 'NDA' }, wrong, CTX);
    expect(missing.match.status).toBe('file_missing');
  });

  test('несколько одноимённых файлов без каталога-префикса - не unique', async () => {
    const bare = await buildDocumentsDeps();
    putFile(bare, NDA, 'x');
    putFile(bare, `Архив/${NDA}`, 'x');
    const out = await findTemplate.execute({ query: 'NDA' }, bare, CTX);
    expect(out.match.status).toBe('ambiguous');
    expect(out.match.candidates.map((item) => item.path).sort()).toEqual(
      [`Архив/${NDA}`, NDA].sort(),
    );
  });

  test('выбор по словам просит подтверждения, по названию файла - нет', async () => {
    const byWords = await findTemplate.execute({ query: 'соглашение о неразглашении' }, deps, CTX);
    expect(byWords.match).toMatchObject({ status: 'unique', needsConfirmation: true });
    const byFile = await findTemplate.execute({ query: NDA }, deps, CTX);
    expect(byFile.match).toMatchObject({ status: 'unique', needsConfirmation: false });
  });

  test('промпт требует подтверждения шаблона, выбранного по словам', () => {
    expect(DOCUMENTS_PROMPT).toContain('needsConfirmation');
  });
});
