import { CancelledError, DomainError } from '@business-ai/core';
import { OWN_ENTITY_CODE_BY_ALIAS, OWN_ENTITY_TITLES } from '../../kit/domain/own-legal-entity';
import { OwnSignatoryRefusedError, type OwnSignatoryRefusal } from '../../kit/domain/errors.owned';
import type { OwnSignatoryForms } from '../../kit/ports/contract-amender';
import type { DealDocument } from '../../kit/domain/models';
import type { DocumentsDeps } from './deps';
import type { OwnEntity } from '../../kit/ports/own-requisites';
import type { AllowedTemplate } from './template-access';
import { contractTemplateByPath } from './template-registry';

/**
 * Подстановка подписанта НАШЕЙ стороны в шаблон договора из записи БД `own_legal_entities`
 * (поля signatoryName и signatoryPosition). В шаблонах на шаре подписант напечатан текстом, а
 * владелец решил менять его кодом при сборке, шаблоны не править.
 *
 * Прежний подписант не задаётся ни кодом, ни настройкой: сервис документов определяет его по
 * самому шаблону (преамбула «в лице <должность> <ФИО>, действующего», строка подписи «Генеральный
 * директор Фамилия И.О.»), поэтому смена подписанта в шаблоне на шаре ничего не ломает. Формы
 * нового подписанта строит код: инициалы из записи, родительный падеж даёт сервис склонения
 * (`deps.signatoryInflector`), пол и падеж здесь не угадываются.
 *
 * Fail closed (только при источнике БД `deps.ownRequisites`): нет уверенного склонения, подписант
 * в шаблоне не найден или назван неоднозначно, прежний остался после замены - документ не
 * собирается, сотруднику понятный текст без значений, в журнал событие без значений. Флаг
 * источника выключен - поведение прежнее, шаблон не меняется. Подписанта поставщика
 * (`seller_representative`) и его сторону это не затрагивает.
 */

/** Сколько слов в ФИО подписанта: «Фамилия Имя Отчество». */
const FULL_NAME_WORDS = 3;
const CYRILLIC_WORD = /^[А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?$/u;
/** Окончание родительного падежа отчества женского и мужского рода (от сервиса склонения). */
const FEMININE_PATRONYMIC = /(?:вны|чны)$/u;
const MASCULINE_PATRONYMIC = /(?:вича|ича)$/u;
/** Женские фамилии на -а: именительный -> родительный (как правила сервиса склонения). */
const FEMININE_SURNAME_RULES: ReadonlyArray<readonly [string, string]> = [
  ['ская', 'ской'],
  ['цкая', 'цкой'],
  ['ова', 'овой'],
  ['ева', 'евой'],
  ['ёва', 'ёвой'],
  ['ина', 'иной'],
  ['ына', 'ыной'],
];

const REFUSAL_TEXTS: Record<OwnSignatoryRefusal, string> = {
  signatory_not_found: 'в шаблоне не найден подписант нашей стороны',
  signatory_inconsistent: 'в шаблоне названы разные подписанты нашей стороны',
  signatory_left: 'после замены в документе остался прежний подписант',
  verification_failed: 'проверка документа после замены не прошла',
  bad_request: 'сервис документов отклонил формы подписанта',
};

function failure(entity: string, detail: string): DomainError {
  return new DomainError(
    'conflict',
    `Подписант юрлица «${entity}» не подставлен: ${detail}. Документ не собран. Скажите ` +
      'сотруднику: нужно проверить запись реквизитов и шаблон на диске, значения здесь не ' +
      'показываются.',
  );
}

/** Инициалы «В.Ю.» из имени и отчества. */
function initialsOf(firstName: string, patronymic: string): string {
  return `${firstName.charAt(0).toUpperCase()}.${patronymic.charAt(0).toUpperCase()}.`;
}

/**
 * Фамилия в родительном падеже с проверкой по роду, который показало отчество. Словарь сервиса
 * склонения для части женских фамилий на -а отдаёт форму существительного («Пехтышевы» вместо
 * «Пехтышевой»): при женском отчестве такая известная ошибка исправляется по правилу, любой
 * другой неожиданный результат - отказ.
 */
function surnameGenitive(
  nominative: string,
  serviceForm: string,
  patronymicGenitive: string,
): string | null {
  if (MASCULINE_PATRONYMIC.test(patronymicGenitive.toLowerCase())) return serviceForm;
  if (!FEMININE_PATRONYMIC.test(patronymicGenitive.toLowerCase())) return null;
  const lowered = nominative.toLowerCase();
  for (const [ending, replacement] of FEMININE_SURNAME_RULES) {
    if (!lowered.endsWith(ending)) continue;
    const expected = nominative.slice(0, nominative.length - ending.length) + replacement;
    if (serviceForm.toLowerCase() === expected.toLowerCase()) return serviceForm;
    const noun = `${nominative.slice(0, -1)}ы`;
    return serviceForm.toLowerCase() === noun.toLowerCase() ? expected : null;
  }
  // Фамилия без женской формы на -а (Шевчук, Ткаченко): склонение сервиса принимается.
  return serviceForm;
}

/**
 * Формы подписанта по записи БД. Склонение не удалось, ФИО не «Фамилия Имя Отчество» или сервис
 * склонения не подключён - `null` (причина в журнале без значений).
 */
export async function ownSignatoryForms(
  deps: DocumentsDeps,
  record: { signatoryName: string; signatoryPosition: string },
  signalAborted: () => boolean,
): Promise<{ forms: OwnSignatoryForms } | { reason: string }> {
  const inflector = deps.signatoryInflector;
  if (inflector === undefined) return { reason: 'inflector_not_configured' };
  const words = record.signatoryName.trim().split(/\s+/u);
  if (words.length !== FULL_NAME_WORDS || !words.every((word) => CYRILLIC_WORD.test(word))) {
    return { reason: 'name_format' };
  }
  const [surname = '', firstName = '', patronymic = ''] = words;
  if (signalAborted()) throw new CancelledError('Подстановка подписанта отменена.');
  let inflected: string | null;
  try {
    inflected = await inflector.signatoryGenitive(record.signatoryPosition, record.signatoryName);
  } catch {
    return { reason: 'inflector_failed' };
  }
  if (inflected === null) return { reason: 'inflection_uncertain' };
  const tail = inflected.trim().split(/\s+/u).slice(-FULL_NAME_WORDS);
  const [surnameForm = '', firstForm = '', patronymicForm = ''] = tail;
  const sameLetters = [
    [surname, surnameForm],
    [firstName, firstForm],
    [patronymic, patronymicForm],
  ].every(([source = '', form = '']) => source.charAt(0).toLowerCase() === form.charAt(0).toLowerCase());
  if (tail.length !== FULL_NAME_WORDS || !sameLetters) return { reason: 'inflection_shape' };
  const surnameGen = surnameGenitive(surname, surnameForm, patronymicForm);
  if (surnameGen === null) return { reason: 'inflection_unreliable' };
  const initials = initialsOf(firstName, patronymic);
  return {
    forms: {
      nominativeShort: `${surname} ${initials}`,
      nominativeReversed: `${initials} ${surname}`,
      genitiveFull: `${surnameGen} ${firstForm} ${patronymicForm}`,
      genitiveShort: `${surnameGen} ${initials}`,
    },
  };
}

/** Ключи `templateFields` с подписантом нашей стороны только для этого договора (этап 8y). */
export const OWN_SIGNATORY_NAME_KEY = 'own_signatory_name';
export const OWN_SIGNATORY_POSITION_KEY = 'own_signatory_position';

/** Подписант нашей стороны, названный сотрудником для одного договора. */
export interface OwnSignatoryOverride {
  name: string;
  /** Должность; нет - берётся из записи юрлица. */
  position?: string | undefined;
}

/**
 * Подписант нашей стороны «только в этом договоре»: команда «замени директора <наше юрлицо> на
 * <ФИО>» меняет сторону Заказчика/нашу сторону в собираемом документе, запись `own_legal_entities`
 * не трогает (постоянная смена - отдельный шаг с подтверждением, `proposeOwnRequisitesUpdate`).
 */
export function ownSignatoryOverrideOf(
  document: Pick<DealDocument, 'templateFields'> | undefined,
): OwnSignatoryOverride | undefined {
  const fields = document?.templateFields;
  const name = fields?.[OWN_SIGNATORY_NAME_KEY]?.trim() ?? '';
  if (name === '') return undefined;
  const position = fields?.[OWN_SIGNATORY_POSITION_KEY]?.trim() ?? '';
  return { name, ...(position === '' ? {} : { position }) };
}

/**
 * Шаблон договора с подписантом нашей стороны из записи БД (или названным сотрудником для этого
 * договора). Не из реестра шаблонов или источник БД не подключён (флаг выключен) - шаблон
 * возвращается как есть, а названный сотрудником подписант без источника БД отказом: молча
 * оставить прежнего нельзя. Вызывать после `assertTemplateOwnSideMatches` (запись уже проверена).
 */
export async function applyOwnSignatory(
  deps: DocumentsDeps,
  template: AllowedTemplate,
  signal?: AbortSignal,
  document?: Pick<DealDocument, 'templateFields'>,
): Promise<AllowedTemplate> {
  const override = ownSignatoryOverrideOf(document);
  const repository = deps.ownEntities;
  if (deps.ownRequisites === undefined || repository === undefined) {
    const known = contractTemplateByPath(template.path, deps.templatesPrefix ?? '');
    if (override !== undefined && known !== undefined) {
      deps.log?.('own_signatory_refused', { reason: 'override_without_source' });
      throw new DomainError(
        'conflict',
        'Подписант нашей стороны не заменён: источник наших реквизитов выключен. Документ не ' +
          'собран, скажите сотруднику, что смену подписанта нужно сделать вручную.',
      );
    }
    return template;
  }
  const registered = contractTemplateByPath(template.path, deps.templatesPrefix ?? '');
  if (registered === undefined) return template;
  const entity: OwnEntity = registered.entity;
  const code = OWN_ENTITY_CODE_BY_ALIAS[entity];
  const title = OWN_ENTITY_TITLES[code];
  const record = await repository.get(code);
  if (record === null) {
    if (override !== undefined) {
      deps.log?.('own_signatory_refused', { entity: code, reason: 'record_missing' });
      throw failure(title, 'нет записи юрлица в базе');
    }
    return template;
  }
  const amender = deps.contractAmender;
  if (amender === undefined) {
    deps.log?.('own_signatory_refused', { entity: code, reason: 'amender_not_configured' });
    throw failure(title, 'сервис документов не подключён');
  }
  // Названный сотрудником подписант заменяет запись только в этом документе.
  const effective =
    override === undefined
      ? record
      : {
          signatoryName: override.name,
          signatoryPosition: override.position ?? record.signatoryPosition,
        };
  if (override !== undefined) deps.log?.('own_signatory_override', { entity: code });
  const built = await ownSignatoryForms(deps, effective, () => signal?.aborted === true);
  if ('reason' in built) {
    deps.log?.('own_signatory_refused', { entity: code, reason: built.reason });
    throw failure(title, 'не удалось уверенно разобрать и просклонять ФИО подписанта');
  }
  try {
    const result = await amender.replaceSignatory({
      bytes: template.content,
      forms: built.forms,
      signal,
    });
    deps.log?.('own_signatory_substituted', {
      entity: code,
      found: result.found,
      replaced: result.replaced,
    });
    return result.unchanged ? template : { ...template, content: result.bytes };
  } catch (error) {
    if (!(error instanceof OwnSignatoryRefusedError)) throw error;
    // NDA: подписант в соглашении может быть не напечатан; тогда подставлять нечего. Неоднозначный
    // или оставшийся подписант отказом остаётся и там.
    if (registered.variant === 'nda' && error.reason === 'signatory_not_found') {
      deps.log?.('own_signatory_not_found', { entity: code, variant: 'nda' });
      return template;
    }
    deps.log?.('own_signatory_refused', { entity: code, reason: error.reason });
    throw failure(title, REFUSAL_TEXTS[error.reason]);
  }
}
