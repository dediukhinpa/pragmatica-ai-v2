import type { AccessRestrictions } from '@business-ai/core';
import {
  ACTION_CONFIRM_SUPPLIER_CARD,
  ACTION_EXPORT_SUPPLIERS,
  ACTION_UPDATE_OWN_REQUISITES,
} from './kit/domain/access.owned';

/**
 * Действия доступа проекта. Платформа знает свои (`chat.message`, `chat.button`, `chat.file`,
 * `mail.send_draft`); здесь остальные, которые проверяет код агентов и кнопок. Имена совпадают
 * с эталоном прежнего реестра (`stage-0/baseline/config/access-actions.txt`): правила в файле
 * политики доступа ссылаются на них по имени, переименование сломало бы боевые правила.
 */

/** Выбор поставщиков для рассылки запросов (кнопки «отметить» и «Готово»). */
export const ACTION_CONFIRM_SELECTION = 'orders.confirm_selection';
/** Отнесение письма поставщика к заявке и замена КП ответом. */
export const ACTION_ROUTE_MAIL = 'orders.route_mail';
/** Подтверждение скачка цен кнопкой. Снято (цены вносятся только с диска), имя принимается. */
export const ACTION_CONFIRM_JUMP = 'prices.confirm_jump';
/** Подтверждение публикации на сайт. Снято, имя принимается: старые правила не должны падать. */
export const ACTION_CONFIRM_PUBLISH = 'site.confirm_publish';

export {
  ACTION_CONFIRM_SUPPLIER_CARD,
  ACTION_EXPORT_SUPPLIERS,
  ACTION_UPDATE_OWN_REQUISITES,
};

/** Действия проекта в порядке, в котором они перечислены в эталоне (по алфавиту имён). */
export const PROJECT_ACCESS_ACTIONS: readonly string[] = [
  ACTION_UPDATE_OWN_REQUISITES,
  ACTION_CONFIRM_SELECTION,
  ACTION_ROUTE_MAIL,
  ACTION_CONFIRM_JUMP,
  ACTION_CONFIRM_PUBLISH,
  ACTION_CONFIRM_SUPPLIER_CARD,
  ACTION_EXPORT_SUPPLIERS,
];

/**
 * Ограничения действий. Запись карточек и выгрузка базы поставщиков - только руководителям
 * отделов (этап 234); правка наших реквизитов требует явного правила с `allow`, наследования
 * допуска бота здесь нет (fail closed).
 */
export const PROJECT_ACCESS_RESTRICTIONS: AccessRestrictions = {
  headOnlyActions: [ACTION_CONFIRM_SUPPLIER_CARD, ACTION_EXPORT_SUPPLIERS],
  ruleRequiredActions: [ACTION_UPDATE_OWN_REQUISITES],
};
