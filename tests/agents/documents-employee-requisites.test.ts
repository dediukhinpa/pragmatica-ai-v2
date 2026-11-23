import { beforeEach, describe, expect, test } from 'bun:test';
import { MemoryModelGateway } from '@business-ai/adapters';
import {
  EMPLOYEE_TEXT_NAMESPACE,
  noteEmployeeMessage,
} from '../../src/agents/documents/employee-messages';
import { PseudonymizingModelGateway } from '@business-ai/core';
import {
  assessSupplierDocument,
  checkSupplierDocument,
} from '../../src/agents/documents/supplier-checks';
import { noteWebSearchText } from '../../src/agents/documents/web-confirmation';
import { type DocumentsDeps } from '../../src/agents/documents/deps';
import { dealDocumentSchema, type DealDocument, type Supplier } from '../../src/kit/domain/models';
import { WORKFLOW_STATE_STALE_SCOPE } from '../../src/kit/app/workflow-state-retention';
import { FULL_SUPPLIER } from '../kit/support/supplier-fixtures';
import { DictionaryPseudonymizer } from '@business-ai/testing';
import { OWN_COMPANY, buildDocumentsDeps, withSources } from './support';

const THREAD = 't-docs-1';
const OTHER_THREAD = 't-docs-2';
/** Другой настоящий ИНН (контрольная сумма сходится). */
const OTHER_INN = '7736050003';
const WRONG_INN = '7707083894';
const DIRECTOR = 'Сидоров Сергей Петрович';

/** Договор по карточке поставщика: все реквизиты как в базе. */
function contract(requisites: Record<string, string>): DealDocument {
  const base: Record<string, string> = {
    inn: FULL_SUPPLIER.inn ?? '',
    kpp: FULL_SUPPLIER.kpp ?? '',
    ogrn: FULL_SUPPLIER.ogrn ?? '',
    legalAddress: FULL_SUPPLIER.legalAddress ?? '',
    bankName: FULL_SUPPLIER.bankName ?? '',
    bik: FULL_SUPPLIER.bik ?? '',
    settlementAccount: FULL_SUPPLIER.settlementAccount ?? '',
    correspondentAccount: FULL_SUPPLIER.correspondentAccount ?? '',
    directorName: FULL_SUPPLIER.directorName ?? '',
  };
  return withSources({
    id: 'doc-1',
    kind: 'contract',
    number: 'Д-1',
    buyer: OWN_COMPANY,
    seller: FULL_SUPPLIER.name,
    supplierId: FULL_SUPPLIER.id,
    lines: [{ name: 'Болт М8', quantity: 10, unitPrice: 12 }],
    total: 120,
    currency: 'RUB',
    issuedAt: '2026-01-05T00:00:00.000Z',
    requisites: { ...base, ...requisites },
  });
}

let deps: Awaited<ReturnType<typeof buildDocumentsDeps>>;

async function setSupplier(supplier: Supplier): Promise<void> {
  await deps.suppliers.upsert(supplier);
}

/** Карточка с ИНН, не прошедшим проверку (запись такого ИНН хранилище не принимает). */
function withCardInn(inn: string): void {
  const card: Supplier = { ...FULL_SUPPLIER, inn };
  deps.suppliers.get = async () => card;
}

const codes = async (doc: DealDocument, threadId: string | undefined = THREAD) =>
  (await checkSupplierDocument(doc, deps, threadId)).map((issue) => issue.code);

beforeEach(async () => {
  deps = await buildDocumentsDeps();
  await setSupplier(FULL_SUPPLIER);
});

describe('реквизиты от сотрудника в документе с поставщиком', () => {
  test('нет в карточке, есть в сообщении: вписывается без замечания', async () => {
    await setSupplier({ ...FULL_SUPPLIER, directorName: undefined });
    await noteEmployeeMessage(deps.state, THREAD, `Подписант у них ${DIRECTOR}, впиши.`);
    const result = await assessSupplierDocument(
      contract({ directorName: DIRECTOR }),
      deps,
      THREAD,
    );
    expect(result.issues).toEqual([]);
    expect(result.employee).toEqual({
      fromEmployee: ['directorName'],
      divergent: [],
      unconfirmed: [],
      mismatched: [],
    });
  });

  test('расходится с карточкой, есть в сообщении: проходит, расхождение помечено', async () => {
    await noteEmployeeMessage(deps.state, THREAD, `У них новый ИНН ${OTHER_INN}`);
    const result = await assessSupplierDocument(contract({ inn: OTHER_INN }), deps, THREAD);
    expect(result.issues).toEqual([]);
    expect(result.employee).toEqual({
      fromEmployee: ['inn'],
      divergent: ['inn'],
      unconfirmed: [],
      mismatched: [],
    });
  });

  test('отметка employee от модели, значения в сообщениях нет: без значения', async () => {
    await noteEmployeeMessage(deps.state, THREAD, 'Подготовь договор с МеталлТорг');
    const issues = await checkSupplierDocument(contract({ inn: OTHER_INN }), deps, THREAD);
    expect(issues.map((issue) => issue.code)).toEqual(['requisite_mismatch']);
    expect(issues[0]?.message).toContain('ваших сообщениях');
    expect(issues[0]?.message).not.toContain(OTHER_INN);
  });

  test('расходится с карточкой, в сообщениях нет: вносится, карточка названа', async () => {
    const assessed = await assessSupplierDocument(contract({ inn: OTHER_INN }), deps, THREAD);
    expect(assessed.employee.mismatched).toEqual([
      { field: 'inn', cardValue: FULL_SUPPLIER.inn ?? '' },
    ]);
    // Допущенным сотрудником значение не считается: источник «чат» ему не ставится.
    expect(assessed.employee.fromEmployee).toEqual([]);
    const message = assessed.issues[0]?.message ?? '';
    expect(message).toContain(
      'внесено со слов сотрудника, отличается от карточки поставщика ' +
        `(в карточке: ${FULL_SUPPLIER.inn})`,
    );
    expect(message).not.toContain('не вносят');
    expect(message).not.toContain(OTHER_INN);
  });

  test('значение есть в сообщении: предупреждения о расхождении нет', async () => {
    await noteEmployeeMessage(deps.state, THREAD, `ИНН ${OTHER_INN}`);
    const assessed = await assessSupplierDocument(contract({ inn: OTHER_INN }), deps, THREAD);
    expect(assessed.employee.mismatched).toEqual([]);
  });

  test('нет в карточке и нет в сообщениях: requisite_not_in_base', async () => {
    await setSupplier({ ...FULL_SUPPLIER, directorName: undefined });
    const unknown = contract({ directorName: DIRECTOR });
    const assessed = await assessSupplierDocument(unknown, deps, THREAD);
    expect(assessed.employee.unconfirmed).toEqual(['directorName']);
    const issues = assessed.issues;
    expect(issues.map((issue) => issue.code)).toEqual(['requisite_not_in_base']);
    expect(issues[0]?.message).toContain('нет ни в карточке');
    expect(issues[0]?.message).toContain('внесено со слов сотрудника, в базе не подтверждено');
    expect(issues[0]?.message).not.toContain('не вносят');
    expect(issues[0]?.message).not.toContain(DIRECTOR);
  });

  test('значение только в веб-поиске: по-прежнему замечание', async () => {
    await noteWebSearchText(deps.state, THREAD, [
      { title: 'Реквизиты', snippet: `ИНН ${OTHER_INN}`, url: 'https://example.test' },
    ]);
    expect(await codes(contract({ inn: OTHER_INN }))).toEqual(['requisite_mismatch']);
  });

  test('неверная контрольная сумма значения сотрудника: замечание без значения', async () => {
    await noteEmployeeMessage(deps.state, THREAD, `ИНН ${WRONG_INN}`);
    const issues = await checkSupplierDocument(contract({ inn: WRONG_INN }), deps, THREAD);
    expect(issues.map((issue) => issue.code)).toEqual(['employee_requisite_invalid']);
    expect(issues[0]?.message).not.toContain(WRONG_INN);
    expect(issues[0]?.message).toContain('проверьте');
    expect(issues[0]?.severity).toBe('warning');
  });

  test('счёт сотрудника неверной длины: замечание', async () => {
    const short = '4070281020000000000';
    await noteEmployeeMessage(deps.state, THREAD, `р/с ${short}`);
    const issues = await checkSupplierDocument(
      contract({ settlementAccount: short }),
      deps,
      THREAD,
    );
    expect(issues.map((issue) => issue.code)).toEqual(['employee_requisite_invalid']);
    expect(issues[0]?.message).not.toContain(short);
  });

  test('изоляция по треду: чужой тред и вызов без треда не засчитываются', async () => {
    await noteEmployeeMessage(deps.state, OTHER_THREAD, `ИНН ${OTHER_INN}`);
    expect(await codes(contract({ inn: OTHER_INN }), THREAD)).toEqual(['requisite_mismatch']);
    expect(await codes(contract({ inn: OTHER_INN }), undefined)).toEqual(['requisite_mismatch']);
    expect(await codes(contract({ inn: OTHER_INN }), OTHER_THREAD)).toEqual([]);
  });

  test('цифры с пробелами и дефисами в сообщении сопоставляются', async () => {
    await noteEmployeeMessage(deps.state, THREAD, 'ИНН: 7736-050003');
    expect(await codes(contract({ inn: OTHER_INN }))).toEqual([]);
  });

  test('ИНН внутри более длинного числа в сообщении не засчитывается', async () => {
    await noteEmployeeMessage(deps.state, THREAD, `счёт 40${OTHER_INN}00000000`);
    expect(await codes(contract({ inn: OTHER_INN }))).toEqual(['requisite_mismatch']);
  });

  test('название стороны от сотрудника допускается и помечается расхождением', async () => {
    const renamed = { ...contract({}), seller: 'ООО «Новый МеталлТорг»' };
    expect(await codes(renamed)).toEqual(['seller_mismatch']);
    await noteEmployeeMessage(deps.state, THREAD, 'Теперь они ООО «Новый МеталлТорг»');
    const result = await assessSupplierDocument(renamed, deps, THREAD);
    expect(result.issues).toEqual([]);
    expect(result.employee).toEqual({
      fromEmployee: ['seller'],
      divergent: ['seller'],
      unconfirmed: [],
      mismatched: [],
    });
  });

  test('токены псевдонимизации: сверка по восстановленному значению', async () => {
    const pseudonymizer = new DictionaryPseudonymizer([{ kind: 'PERSON', values: [DIRECTOR] }]);
    const inner = new MemoryModelGateway(() => ({
      content: '',
      toolCalls: [
        {
          id: 'c1',
          name: 'handoffForReview',
          arguments: { document: contract({ directorName: '[PERSON_1]' }) as never },
        },
      ],
      stopReason: 'tool_use',
    }));
    const gateway = new PseudonymizingModelGateway(inner, pseudonymizer);
    const message = `Подписант у них ${DIRECTOR}`;
    await setSupplier({ ...FULL_SUPPLIER, directorName: undefined });
    // Код чата хранит реальный текст; модель видит токен.
    await noteEmployeeMessage(deps.state, THREAD, message);
    const response = await gateway.complete({
      model: 'm',
      threadId: THREAD,
      messages: [{ role: 'user', content: message }],
    });
    const wire = JSON.stringify(inner.requests);
    expect(wire).not.toContain(DIRECTOR);
    const args = response.toolCalls?.[0]?.arguments as { document: unknown };
    const restored = dealDocumentSchema.parse(args.document);
    expect(restored.requisites?.directorName).toBe(DIRECTOR);
    expect(await codes(restored)).toEqual([]);
    // Неподставленный токен реквизитом сотрудника не считается.
    const raw = contract({ directorName: '[PERSON_1]' });
    expect(await codes(raw)).toEqual(['requisite_not_in_base']);
  });
});

describe('хранилище текста сообщений сотрудника', () => {
  test('пространство входит в чистку по сроку; пустой текст не пишется', async () => {
    expect(WORKFLOW_STATE_STALE_SCOPE.namespaces).toContain(EMPLOYEE_TEXT_NAMESPACE);
    await noteEmployeeMessage(deps.state, THREAD, '   ');
    expect(await deps.state.get(EMPLOYEE_TEXT_NAMESPACE, THREAD)).toBeNull();
  });

  test('хвост ограничен: свежий текст остаётся, старый вытесняется', async () => {
    await noteEmployeeMessage(deps.state, THREAD, `старый ${'я'.repeat(50_000)}`);
    await noteEmployeeMessage(deps.state, THREAD, `ИНН ${OTHER_INN}`);
    expect(await codes(contract({ inn: OTHER_INN }))).toEqual([]);
  });

  test('нет в карточке inn и bik, есть в сообщении: карточка не блокирует', async () => {
    await setSupplier({ ...FULL_SUPPLIER, inn: undefined, bik: undefined });
    const bik = FULL_SUPPLIER.bik ?? '';
    await noteEmployeeMessage(deps.state, THREAD, `ИНН ${FULL_SUPPLIER.inn}, БИК ${bik}`);
    const result = await assessSupplierDocument(contract({}), deps, THREAD);
    expect(result.issues).toEqual([]);
    expect(result.employee.fromEmployee).toEqual(['inn', 'bik']);
  });

  test('в карточке неверный inn, сотрудник прислал верный: проходит', async () => {
    withCardInn(WRONG_INN);
    await noteEmployeeMessage(deps.state, THREAD, `Правильный ИНН ${OTHER_INN}`);
    const result = await assessSupplierDocument(contract({ inn: OTHER_INN }), deps, THREAD);
    expect(result.issues).toEqual([]);
  });

  test('в карточке неверный inn, сотрудник прислал неверный: замечание', async () => {
    withCardInn(WRONG_INN.slice(0, -1) + '0');
    await noteEmployeeMessage(deps.state, THREAD, `ИНН ${WRONG_INN}`);
    const issues = await checkSupplierDocument(contract({ inn: WRONG_INN }), deps, THREAD);
    expect(issues.map((issue) => issue.code)).toContain('employee_requisite_invalid');
  });

  test('inn не прислан сотрудником: замечание карточки прежнее', async () => {
    await setSupplier({ ...FULL_SUPPLIER, inn: undefined });
    await noteEmployeeMessage(deps.state, THREAD, 'Подготовь договор');
    expect(await codes(contract({ inn: '' }))).toContain('requisite_missing');
  });
});
