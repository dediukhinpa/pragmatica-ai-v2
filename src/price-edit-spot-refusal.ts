import type { PriceEditRefusal } from './price-edit-refusal';
import {
  MAX_REFUSALS_LISTED,
  REFUSAL_TEXTS,
  refusedMessage,
} from './agents/prices/price-edit-source';
import { pagePlace, pdfSpotKey } from './price-spots';

/**
 * Тексты отказов правки числа в тексте PDF вне таблиц (этап 9r). Сервис отказывает по месту
 * (`page` + `spot`) теми же машинными кодами, что у ячеек, и несколькими новыми; для сотрудника
 * часть кодов у числа в тексте звучит иначе (минус перед числом, число длиннее старого). Тексты
 * ячеек (`REFUSAL_TEXTS`) не меняются: отказ без `page`/`spot` собирается прежним путём.
 */

/** Тексты кодов, у которых для числа в тексте другая причина или код новый. */
export const SPOT_REFUSAL_TEXTS: Readonly<Record<string, string>> = {
  spot_not_found: 'числа на этом месте страницы нет: файл отличается от разобранного',
  negative_in_text: 'перед числом стоит минус, плюс или скобка: такое число в тексте не правится',
  no_fit: 'новое число длиннее старого и не помещается на его месте',
  align_unclear: 'не удалось определить выравнивание числа в колонке',
  text_edit_disabled: 'правка чисел в тексте вне таблиц на сервисе выключена',
  unsupported_layout: 'страница или текст повёрнуты либо оформлены особо: править такое нельзя',
  write_failed: 'не удалось записать изменённый файл',
};

/** Отказ относится к числу в тексте PDF (у ячеек таблиц `page` и `spot` нет). */
export function isSpotRefusal(reason: PriceEditRefusal): boolean {
  return reason.page !== undefined && reason.spot !== undefined;
}

/** Понятная причина по коду: у числа в тексте - со своими формулировками, у ячейки - прежняя. */
export function refusalTextOf(reason: PriceEditRefusal): string {
  const spotText = isSpotRefusal(reason) ? SPOT_REFUSAL_TEXTS[reason.code] : undefined;
  return spotText ?? REFUSAL_TEXTS[reason.code] ?? reason.code;
}

/** Ключ места отказа в карте подписей: число в тексте PDF; иначе `null` (ячейка или файл). */
export function spotRefusalKey(reason: PriceEditRefusal): string | null {
  return isSpotRefusal(reason) && reason.page !== undefined && reason.spot !== undefined
    ? pdfSpotKey({ page: reason.page, spot: reason.spot })
    : null;
}

/**
 * Сообщение об отказе проверок для агента. Без отказов по числам в тексте - прежнее сообщение
 * (`refusedMessage`) слово в слово; с ними место числа называется страницей и текстом вокруг
 * (`spotAt` по ключу места), а `no_fit` и прочие причины - по-человечески, с предложением
 * xlsx-копии только с согласия сотрудника.
 */
export function refusedMessageForSpots(
  reasons: readonly PriceEditRefusal[],
  keyAt: ReadonlyMap<string, string>,
  spotAt: ReadonlyMap<string, string>,
): string {
  if (!reasons.some(isSpotRefusal)) return refusedMessage(reasons, keyAt);
  const lines = reasons.slice(0, MAX_REFUSALS_LISTED).map((reason) => {
    const key = spotRefusalKey(reason);
    const place =
      key !== null
        ? (spotAt.get(key) ?? pagePlace(reason.page ?? 0))
        : reason.row === undefined
          ? 'файл целиком'
          : (keyAt.get(`${reason.table ?? ''}:${reason.row}`) ?? `строка ${reason.row}`);
    return `${place}: ${refusalTextOf(reason)}`;
  });
  const rest = reasons.length - lines.length;
  return (
    'Файл на месте поправить нельзя: строгие проверки не прошли, файл не изменён и не ' +
    `отправлен. Причины: ${lines.join('; ')}${rest > 0 ? `; и ещё ${rest}` : ''}. Назови их ` +
    'сотруднику. Предложите xlsx-копию с тем же содержимым (один лист, структура ' +
    'исходного, с новыми ценами) и делайте её ТОЛЬКО с его согласия.'
  );
}
