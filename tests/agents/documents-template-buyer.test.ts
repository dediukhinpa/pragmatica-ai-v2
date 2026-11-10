import { beforeEach, describe, expect, test } from 'bun:test';
// Покупатель в договоре по шаблону - юрлицо шаблона: модель не угадывает его написание.
import {
  CONTRACT_TEMPLATES,
  templateBuyerName,
} from '../../src/agents/documents/template-registry';
import { checkSupplierDocument } from '../../src/agents/documents/supplier-checks';
import type { DealDocument } from '../../src/kit/domain/models';
import { buildDocument, buildDocumentsDeps } from './support';

const OWN = ['ООО «Прагматика»', 'ООО «Мастер Гифтс»'];
const MG_READY = '2026_МГ_Шаблон_Договора_на_поставку_готовой_продукции.docx';
const PR_READY = 'Шаблон_ПР_Договора_на_поставку_готовой_продукции.docx';

let deps: Awaited<ReturnType<typeof buildDocumentsDeps>>;

beforeEach(async () => {
  deps = { ...(await buildDocumentsDeps()), ownCompanyNames: OWN };
});

const contract = (buyer: string): DealDocument =>
  buildDocument({ kind: 'contract', buyer, seller: 'ООО «Ромашка»', supplierId: 's1' });

const buyerIssue = async (doc: DealDocument, templatePath?: string): Promise<boolean> =>
  (await checkSupplierDocument(doc, deps, undefined, templatePath)).some(
    (issue) => issue.code === 'buyer_not_own_company',
  );

describe('покупатель по шаблону договора', () => {
  test('юрлицо шаблона находится в OWN_COMPANY_NAMES', () => {
    const byId = (id: string) => CONTRACT_TEMPLATES.find((t) => t.id === id);
    const mg = byId('mg_ready');
    const pr = byId('pr_ready');
    expect(mg === undefined ? undefined : templateBuyerName(mg, OWN)).toBe('ООО «Мастер Гифтс»');
    expect(pr === undefined ? undefined : templateBuyerName(pr, OWN)).toBe('ООО «Прагматика»');
  });

  test('написание модели не важно: «Мастер Гифтс» без кавычек проходит', async () => {
    expect(await buyerIssue(contract('ООО "Мастер Гифтс"'), MG_READY)).toBe(false);
    expect(await buyerIssue(contract('Мастер Гифтс'), PR_READY)).toBe(false);
  });

  test('без шаблона проверка покупателя прежняя', async () => {
    expect(await buyerIssue(contract('ООО "Мастер Гифтс"'))).toBe(true);
  });
});
