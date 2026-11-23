import { CancelledError, DomainError } from '@business-ai/core';
import { ContractAmendRefusedError } from '../../kit/domain/errors.owned';
import {
  OWN_ENTITY_CODE_BY_ALIAS,
  OWN_ENTITY_FIELD_LABELS,
  OWN_ENTITY_TITLES,
  ownEntityPrintedMismatches,
  ownEntityRequisiteLines,
  OWN_ENTITY_EXTRA_NUMBER,
  type OwnEntityField,
} from '../../kit/domain/own-legal-entity';
import type { OwnEntity, OwnRequisitesSource } from '../../kit/ports/own-requisites';
import type { OwnLegalEntityRepository } from '../../kit/ports/own-legal-entities';
import type { OwnRequisites } from '../../kit/ports/contract-amender';
import { readAllowedTemplate, type AllowedTemplate } from './template-access';
import { CONTRACT_TEMPLATES, contractTemplateByPath } from './template-registry';
import type { DocumentsDeps } from './deps';

/** Роль нашей стороны в блоке реквизитов договора: так подписан блок в шаблонах. */
const OWN_ROLE = 'Заказчик';

/** Путь файла шаблона на диске: каталог шаблонов плюс имя файла из реестра. */
function templatePathOf(deps: DocumentsDeps, fileName: string): string {
  const prefix = (deps.templatesPrefix ?? '').replace(/\/+$/u, '');
  return prefix === '' ? fileName : `${prefix}/${fileName}`;
}

/**
 * Шаблона нет среди разрешённых, на диске или в нём нет блока «Заказчик»: пробуем следующий
 * шаблон. Отмена хода и сбой сервиса или шары сюда не входят: они не значат «реквизитов нет»,
 * иначе сотруднику сказали бы вписывать реквизиты вручную из-за временной ошибки.
 */
function isMissingTemplate(error: unknown): boolean {
  if (error instanceof ContractAmendRefusedError) return true;
  return (
    error instanceof DomainError && (error.code === 'not_found' || error.code === 'access_denied')
  );
}

/**
 * Наши реквизиты из шаблона договора юрлица: сборка по шаблону берёт их из блока «Заказчик»
 * самого шаблона (они напечатаны в нём текстом), и дополнение присланного договора берёт те же
 * строки, чтобы в двух путях не расходились данные. Шаблона нет или в нём нет блока - undefined.
 */
async function requisitesFromTemplate(
  deps: DocumentsDeps,
  entity: OwnEntity,
  signal: AbortSignal | undefined,
): Promise<OwnRequisites | undefined> {
  const amender = deps.contractAmender;
  if (amender === undefined) return undefined;
  // Блок «Заказчик» одинаков во всех шаблонах юрлица: берём первый, который есть на диске.
  const templates = CONTRACT_TEMPLATES.filter(
    (item) => item.entity === entity && item.variant !== 'nda',
  );
  for (const template of templates) {
    if (signal?.aborted === true) throw new CancelledError('Чтение реквизитов отменено.');
    try {
      const file = await readAllowedTemplate(deps, templatePathOf(deps, template.fileName));
      return await amender.readPartyBlock({
        bytes: file.content,
        role: OWN_ROLE,
        signal,
      });
    } catch (error) {
      if (!isMissingTemplate(error)) throw error;
    }
  }
  return undefined;
}

/**
 * Источник наших реквизитов из БД (этап 230): запись юрлица -> наименование и строки блока
 * «Заказчик» в том виде, как их печатают шаблоны. Записи нет - undefined: источник ничего не
 * подставляет и не обращается к шаблону.
 */
export function ownRequisitesFromRepository(
  repository: OwnLegalEntityRepository,
): OwnRequisitesSource {
  return {
    async forEntity(entity: OwnEntity): Promise<OwnRequisites | undefined> {
      const record = await repository.get(OWN_ENTITY_CODE_BY_ALIAS[entity]);
      return record === null
        ? undefined
        : { name: record.shortName, lines: ownEntityRequisiteLines(record) };
    },
  };
}

/**
 * Единственная точка получения наших реквизитов для договоров. Внедрённый источник
 * (`deps.ownRequisites`, записи БД при `OWN_REQUISITES_DB_ENABLED`) главнее и единственный: нет
 * записи - undefined, а не текст шаблона (fail closed). Без источника (флаг выключен) - блок
 * «Заказчик» шаблона юрлица, как в этапе 227.
 */
export async function resolveOwnRequisites(
  deps: DocumentsDeps,
  entity: OwnEntity,
  signal?: AbortSignal,
): Promise<OwnRequisites | undefined> {
  if (deps.ownRequisites !== undefined) return deps.ownRequisites.forEntity(entity, signal);
  return requisitesFromTemplate(deps, entity, signal);
}

/** Сообщение сотруднику: у юрлица нет записи реквизитов. Значений не содержит. */
export function ownRequisitesNotFilledMessage(entity: OwnEntity): string {
  return (
    `В базе нет записи реквизитов юрлица «${OWN_ENTITY_TITLES[OWN_ENTITY_CODE_BY_ALIAS[entity]]}»: ` +
    'их заполняет владелец (скрипт заполнения) или сотрудник через агента договоров. ' +
    'Документ не собран, реквизиты из шаблона не подставлялись.'
  );
}

/** Названия полей расхождения для сообщения (без значений). */
function mismatchNames(fields: readonly string[]): string {
  return fields
    .map((field) =>
      field === OWN_ENTITY_EXTRA_NUMBER
        ? 'лишний номер в блоке'
        : OWN_ENTITY_FIELD_LABELS[field as OwnEntityField],
    )
    .join(', ');
}

/**
 * Перед выпуском документа по шаблону договора сверяет напечатанные в шаблоне наши реквизиты с
 * записью БД. Шаблоны лежат на шаре заказчика и печатают наш блок текстом, подставить запись в
 * них нельзя; зато можно не выпустить документ, где напечатано не то, что в базе. Нет записи
 * или есть расхождение - ошибка с названиями полей (значений нет), документ не собирается.
 * Не из реестра шаблонов и источник БД не подключён (флаг выключен) - проверки нет. Соглашение
 * о неразглашении блока реквизитов не имеет: для него проверяется только наличие записи.
 */
export async function assertTemplateOwnSideMatches(
  deps: DocumentsDeps,
  template: AllowedTemplate,
  signal?: AbortSignal,
): Promise<void> {
  const repository = deps.ownEntities;
  if (deps.ownRequisites === undefined || repository === undefined) return;
  const registered = contractTemplateByPath(template.path, deps.templatesPrefix ?? '');
  if (registered === undefined) return;
  const entity: OwnEntity = registered.entity;
  const code = OWN_ENTITY_CODE_BY_ALIAS[entity];
  const record = await repository.get(code);
  if (record === null) {
    deps.log?.('own_requisites_not_filled', { entity: code });
    throw new DomainError('not_found', ownRequisitesNotFilledMessage(entity));
  }
  if (registered.variant === 'nda') return;
  const amender = deps.contractAmender;
  if (amender === undefined) {
    throw new DomainError(
      'not_configured',
      'Сверка реквизитов шаблона с базой недоступна (сервис документов не подключён): ' +
        'документ не собран.',
    );
  }
  const printed = await amender.readPartyBlock({
    bytes: template.content,
    role: OWN_ROLE,
    signal,
  });
  const mismatches = ownEntityPrintedMismatches(record, printed);
  if (mismatches.length === 0) return;
  deps.log?.('own_requisites_template_mismatch', { entity: code, fields: mismatches.join(',') });
  throw new DomainError(
    'conflict',
    `Реквизиты юрлица «${OWN_ENTITY_TITLES[code]}», напечатанные в шаблоне, расходятся с ` +
      `записью в базе (${mismatchNames(mismatches)}). Документ не собран. Скажите сотруднику: ` +
      'нужно привести в соответствие шаблон на диске или запись реквизитов.',
  );
}
