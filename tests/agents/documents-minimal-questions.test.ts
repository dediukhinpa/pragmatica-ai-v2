import { describe, expect, test } from 'bun:test';
import { DOCUMENTS_PROMPT } from '../../src/agents/documents/prompt';
import { checkTemplateFieldsTool } from '../../src/agents/documents/check-template-fields';
import { prepareSupplierDocument } from '../../src/agents/documents/prepare-supplier-document';

/**
 * Договор выдаётся с пропусками, без допроса: спрашивают только юрлицо, вид договора и
 * контрагента. Строки-ловушки ловят возврат прежнего перечня вопросов.
 */

/** Раздел правила: от заголовка до следующего раздела. */
function ruleSection(): string {
  const start = DOCUMENTS_PROMPT.indexOf('Договор: что спрашивать, а что нет.');
  const end = DOCUMENTS_PROMPT.indexOf('Шаблоны договоров и NDA.');
  return DOCUMENTS_PROMPT.slice(start, end);
}

describe('промпт: договор без допроса', () => {
  test('есть правило с тремя обязательными вопросами', () => {
    const rule = ruleSection();
    expect(rule.length).toBeGreaterThan(0);
    for (const need of ['наше юрлицо', 'вид договора', 'контрагент (название)']) {
      expect(rule).toContain(need);
    }
    expect(rule).toContain('ОДНИМ коротким сообщением');
    expect(rule).toContain('«реквизиты от Прагматики» - это юрлицо');
    expect(rule).toContain('Не повторяй вопрос');
  });

  test('НДС, срок, оплата, гарантия, доставка, позиции, подписант - маркеры, не вопросы', () => {
    const rule = ruleSection();
    const words = ['НДС', 'сроки', 'оплаты', 'гарантию', 'адрес доставки', 'позиции', 'подписанта'];
    for (const word of words) expect(rule).toContain(word);
    expect(rule).toContain('НЕ спрашивай');
  });

  test('старые указания допроса удалены', () => {
    for (const old of [
      'спроси сотрудника один раз все вопросы из questions',
      'передай их сотруднику одним сообщением',
      'вместе с остальными вопросами одним',
      'включи это в общий вопрос',
      'спроси число рабочих дней на каждый',
      'Характеристик или срока позиции нет в КП: спроси',
      'задай вопрос\nкак есть',
      'спроси у сотрудника название заявки',
    ]) {
      expect(DOCUMENTS_PROMPT).not.toContain(old);
    }
  });

  test('описания инструментов не велят передавать вопросы сотруднику', () => {
    expect(checkTemplateFieldsTool.description).toContain('не вопросы');
    expect(checkTemplateFieldsTool.description).not.toContain('спроси сотрудника один раз');
    expect(prepareSupplierDocument.description).not.toContain('передай их сотруднику');
    expect(prepareSupplierDocument.description).toContain('пропуски');
  });

  test('решение 03.11: предупреждения одним списком после выдачи, блокировок нет', () => {
    expect(DOCUMENTS_PROMPT).toContain('ОДИН короткий список ПОСЛЕ выдачи');
    // Остались только технические остановки; прежние блокировки по данным убраны.
    expect(DOCUMENTS_PROMPT).toContain('Останавливает');
    for (const old of [
      'Вернул blocked: документ не выпущен',
      'не соберётся (quote_reconcile_required)',
      'Документ не передан (blocked) только',
      'fillTemplate, saveDocument и\nhandoffForReview не соберут документ',
      'иначе спрашивай их (contract_number, contract_date)',
    ]) {
      expect(DOCUMENTS_PROMPT).not.toContain(old);
    }
  });

  test('B1-B4: NDA не спрашивает номер и дату, заявка и реестр не допрашиваются', () => {
    expect(DOCUMENTS_PROMPT).toContain('contract_number и contract_date НЕ спрашивай');
    expect(DOCUMENTS_PROMPT).toContain('requestId не обязателен');
    expect(DOCUMENTS_PROMPT).toContain('это не повод\nостанавливаться или спрашивать');
    expect(DOCUMENTS_PROMPT).toContain('нет ответа - маркер');
  });
});
