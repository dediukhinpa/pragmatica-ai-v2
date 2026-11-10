import { shownPrice } from './market-price';
import { findPriceJumps, priceItemKey, type PriceChange } from './price-diff';
import { fromMinorUnits, lineCents, roundMoney, sameMoney } from './money';
import type { DealDocument, PriceItem, ShortList } from './models';
import { validateRequisitesChecksums } from './requisites';
import { warningIssue } from '@business-ai/core';
import {
  allowedVatRatesText,
  isAllowedVatRate,
  vatIncludedInTotal,
  vatIncludedPerLine,
} from './vat';
import { ValidationIssue } from '@business-ai/core';

/** Порог скачка цены относительно последней известной (0.5 = ±50%). */
export const PRICE_JUMP_THRESHOLD = 0.5;
/** Непросклонённый токен псевдонимизации вида [PERSON_1]. */
const UNRESOLVED_TOKEN_PATTERN = /\[[A-Z][A-Z_]*_\d+\]/g;
/** Черновик рассылки поставщикам. */
export interface OutreachDraft {
  recipientSupplierIds: string[];
  subject: string;
  body: string;
}
/** Проверка перед рассылкой: адресаты только из шорт-листа, токены подставлены обратно. */
export function validateOutreachRecipients(
  draft: OutreachDraft,
  shortList: ShortList,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (draft.recipientSupplierIds.length === 0) {
    issues.push({ code: 'no_recipients', message: 'Список адресатов пуст.' });
  }
  const allowed = new Set(shortList.supplierIds);
  for (const id of draft.recipientSupplierIds) {
    if (!allowed.has(id)) {
      issues.push({
        code: 'recipient_not_in_shortlist',
        message: `Поставщик ${id} не входит в шорт-лист заявки ${shortList.requestId}.`,
      });
    }
  }
  const tokens = new Set([
    ...(draft.subject.match(UNRESOLVED_TOKEN_PATTERN) ?? []),
    ...(draft.body.match(UNRESOLVED_TOKEN_PATTERN) ?? []),
  ]);
  for (const token of tokens) {
    issues.push({
      code: 'unresolved_token',
      message: `В тексте остался неподставленный токен ${token}; восстановите значение.`,
    });
  }
  return issues;
}
/** Вход проверки импорта прайс-листа. */
export interface PriceImportCheck {
  /** Число строк данных в исходном файле. */
  sourceRowCount: number;
  imported: PriceItem[];
  /** Текущие цены в базе — для поиска скачков. */
  existing: PriceItem[];
  /** Последние цены, подтверждённые человеком: от них считается накопленное изменение. */
  confirmed?: readonly PriceItem[] | undefined;
  /**
   * Уже посчитанные скачки: `findPriceJumps(imported, existing, undefined, confirmed)` с порогом
   * по умолчанию. Если вызывающий их уже считал, повторный расчёт по прайсу не нужен.
   */
  jumps?: readonly PriceChange[] | undefined;
}
function priceKey(item: PriceItem): string {
  return `${item.supplierId}|${priceItemKey(item)}`;
}
/** Проверка импорта прайса: число строк, дубли, скачки цены сверх порога. */
export function validatePriceImport(check: PriceImportCheck): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (check.imported.length !== check.sourceRowCount) {
    issues.push({
      code: 'row_count_mismatch',
      message: `В исходнике ${check.sourceRowCount} строк, разобрано ${check.imported.length}.`,
    });
  }
  const seen = new Set<string>();
  for (const item of check.imported) {
    const key = priceKey(item);
    if (seen.has(key)) {
      issues.push({ code: 'duplicate_row', message: `Дубль позиции: ${item.productName}.` });
    }
    seen.add(key);
  }
  // Скачок определяет одна функция: тот же расчёт использует файл изменений для ответственного.
  const jumps =
    check.jumps ??
    findPriceJumps(check.imported, check.existing, PRICE_JUMP_THRESHOLD, check.confirmed ?? []);
  const removed = jumps.filter((jump) => jump.removed === true);
  if (removed.length > 0) {
    issues.push({
      code: 'price_mass_removal',
      message: `Из прайса пропало позиций: ${removed.length}.`,
    });
  }
  for (const jump of jumps.filter((item) => item.removed !== true)) {
    const from = `${shownPrice(jump.oldPrice, jump.oldQualifier, jump.oldMax)} ${jump.oldCurrency}`;
    const to = `${shownPrice(jump.newPrice, jump.newQualifier, jump.newMax)} ${jump.currency}`;
    issues.push({
      code: 'price_jump',
      message:
        jump.newItem === true
          ? `Новая позиция «${jump.productName}» по ${to} вне диапазона одноимённых ` +
            `(ближайшая ${from}).`
          : `Цена «${jump.productName}» изменилась с ${from} до ${to}.`,
    });
  }
  return issues;
}
function isValidDate(value: string | undefined): value is string {
  return value !== undefined && !Number.isNaN(Date.parse(value));
}
/**
 * НДС: ставка из действующих (`VAT_RATES_PERCENT`), указаны оба поля, сумма НДС = итог ×
 * ставка / (100 + ставка) либо сумма построчно округлённого НДС строк (так считает 1С в счёте
 * и УПД, R9-A1-07): документ поставщика с НДС построчно иначе не проходил проверку.
 */
function validateVat(doc: DealDocument): ValidationIssue[] {
  const { vatRate, vatAmount } = doc;
  if (vatRate === undefined && vatAmount === undefined) return [];
  if (vatRate === undefined || vatAmount === undefined) {
    return [
      warningIssue(
        'vat_incomplete',
        'НДС назван не полностью (нужны ставка vatRate и сумма vatAmount): сверку НДС ' +
          'пропустили, проверьте НДС по первичным документам.',
      ),
    ];
  }
  if (!isAllowedVatRate(vatRate)) {
    // Перечень без «ставь N»: ставку берут из источника, а не подбирают под проверку (R9-A1-02).
    return [
      warningIssue(
        'vat_rate_invalid',
        `Ставка НДС ${vatRate}% не входит в действующие (${allowedVatRatesText()}): ` +
          'в документ внесена как названа, проверьте ставку по источнику.',
      ),
    ];
  }
  const expected = vatIncludedInTotal(doc.total, vatRate);
  if (sameMoney(expected, vatAmount)) return [];
  const perLine = vatIncludedPerLine(
    doc.lines.map((line) => lineCents(line.quantity, line.unitPrice)),
    vatRate,
  );
  if (sameMoney(perLine, vatAmount)) return [];
  const perLineText = sameMoney(perLine, expected) ? '' : `, построчно - ${perLine}`;
  return [
    warningIssue(
      'vat_mismatch',
      `НДС ${vatAmount} не сходится: при ставке ${vatRate}% от итога ${doc.total} ` +
        `должно быть ${expected}${perLineText} (НДС входит в итог). Проверьте НДС.`,
    ),
  ];
}
/** Проверка документа перед выпуском: обязательные поля, суммы, НДС, реквизиты, даты. */
export function validateDocumentFields(doc: DealDocument): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const required: Array<[string, string]> = [
    ['number', doc.number],
    ['buyer', doc.buyer],
    ['seller', doc.seller],
    ['currency', doc.currency],
  ];
  for (const [field, value] of required) {
    if (value.trim() === '') {
      // Пропуск не блокирует выдачу: в файле маркер, а валюту не подставляем (выдумывать
      // значение нельзя): сотрудник получает предупреждение и называет её сам.
      issues.push(warningIssue('missing_field', `Не заполнено обязательное поле ${field}.`));
    }
  }
  if (doc.lines.length === 0) {
    issues.push(warningIssue('no_lines', 'В документе нет ни одной строки.'));
  }
  // Строки округляются до копеек по одной, сумма целая (R3-ALG-19/20): без хвоста двоичной дроби.
  let sumCents = 0;
  for (const line of doc.lines) {
    if (line.quantity <= 0 || line.unitPrice < 0) {
      issues.push(
        warningIssue('bad_line', `Некорректная строка «${line.name}» (количество или цена).`),
      );
    }
    const cents = lineCents(line.quantity, line.unitPrice);
    sumCents += cents;
    if (line.sum !== undefined && !sameMoney(line.sum, fromMinorUnits(cents))) {
      issues.push(
        warningIssue(
          'line_sum_mismatch',
          `«${line.name}»: сумма строки ${line.sum} не равна ` +
            `${line.quantity} × ${line.unitPrice} = ${fromMinorUnits(cents)}. Проверьте.`,
        ),
      );
    }
  }
  const sum = fromMinorUnits(sumCents);
  if (!sameMoney(sum, doc.total)) {
    issues.push(
      // Сумма округляется до копеек: хвост двоичной дроби (0.30000000000000004) - серия цифр.
      warningIssue(
        'total_mismatch',
        `Итог ${doc.total} не равен сумме строк ${roundMoney(sum)}. Проверьте итог.`,
      ),
    );
  }
  issues.push(...validateVat(doc), ...validateRequisitesChecksums(doc.requisites));
  if (doc.kind === 'contract' && doc.issuedAt.trim() === '') {
    // Дату договора называет сотрудник; пропуск не блокирует выдачу: в файле будет маркер.
    issues.push(warningIssue('missing_field', 'Не заполнено обязательное поле issuedAt.'));
  } else if (!isValidDate(doc.issuedAt)) {
    issues.push(warningIssue('bad_date', 'Дата выпуска не распознана: проверьте дату.'));
  } else if (doc.dueDate !== undefined) {
    if (!isValidDate(doc.dueDate)) {
      issues.push(warningIssue('bad_date', 'Срок оплаты не распознан: проверьте срок.'));
    } else if (Date.parse(doc.dueDate) < Date.parse(doc.issuedAt)) {
      issues.push(
        warningIssue('due_before_issue', 'Срок оплаты раньше даты выпуска: проверьте даты.'),
      );
    }
  }
  return issues;
}
