import { z } from 'zod';
import {
  CONTRACT_AMEND_REFUSALS,
  ContractAmendRefusedError,
  type ContractAmendRefusal,
} from '../../kit/domain/errors.owned';
import { OWN_ENTITY_CODE_BY_ALIAS } from '../../kit/domain/own-legal-entity';
import { base64Of } from '@business-ai/core';
import type { BitrixAttachment, ChatFile } from '@business-ai/core';
import { sha256HexSync } from '@business-ai/core';
import { defineTool } from '@business-ai/core';
import { joinKey, requirePort, toStoredJson } from '@business-ai/core';
import { assertEmployeeChatTurn } from '@business-ai/core';
import { attachmentsSignal } from '../order-calc/attachment-context';
import {
  KIND_ANSWERS,
  contractFileHash,
  ownIdentity,
  readOwnTemplates,
  recordKindQuestion,
  resolveKindAnswer,
  unclearReasonText,
} from './contract-kind';
import { AWAITING_REVIEW, REVIEW_NAMESPACE, type DocumentsDeps } from './deps';
import { readRecentEmployeeMessages } from './employee-messages';
import { ownRequisitesNotFilledMessage, resolveOwnRequisites } from './own-requisites';
import { entityNamedIn } from './template-registry';

/** Сколько имён файлов называем сотруднику, если договоров в чате несколько. */
const MAX_NAMES_LISTED = 10;
/** Расширения договора: docx правится сразу, .doc и RTF сервис сначала приводит к docx. */
const CONTRACT_EXTENSIONS: readonly string[] = ['.docx', '.doc', '.rtf'];
/**
 * Сколько последних сообщений сотрудника просматривается при сверке юрлица: его называют в
 * ближайших репликах, а не где-то в давнем разговоре (там мог быть другой договор).
 */
const RECENT_EMPLOYEE_MESSAGES = 6;

const inputSchema = z.object({
  /** Наше юрлицо: чьи реквизиты вписать в сторону заказчика. */
  entity: z.enum(['mg', 'pr']),
  /** Имя присланного файла, если в чате несколько договоров. */
  fileName: z.string().trim().min(1).optional(),
  /**
   * Наша сторона в присланном договоре: заказчик/покупатель (по умолчанию) или исполнитель/
   * поставщик. Для исполнителя режим не работает: инструмент сообщает об этом и ничего не меняет.
   */
  ourRole: z.enum(['customer', 'executor']).default('customer'),
  /**
   * Ответ сотрудника на вопрос «это договор поставщика или наш шаблон?», который задал код
   * (status kind_question). Передавай только после ответа сотрудника в следующей реплике;
   * без вопроса от кода ответ не принимается.
   */
  kindAnswer: z.enum(KIND_ANSWERS).optional(),
});
type AmendInput = z.infer<typeof inputSchema>;

const STATUSES = [
  'sent',
  'no_file',
  'ambiguous_file',
  'unsupported_format',
  'entity_not_confirmed',
  'our_side_is_executor',
  'own_template',
  'kind_question',
  'own_requisites_missing',
  'refused',
] as const;

interface AmendOutput {
  status: (typeof STATUSES)[number];
  fileName?: string | undefined;
  /** Блок заказчика заполнен: факт правки, без значений. */
  customerBlockFilled?: boolean | undefined;
  /** Файл был .doc или RTF и приведён к docx. */
  convertedFrom?: 'doc' | 'rtf' | undefined;
  /** Вердикт кода о виде документа (для status own_template и kind_question). */
  verdict?: 'supplier' | 'own_template' | 'our_side_executor' | 'unclear' | undefined;
  /** Причина отказа сервиса (машинный код), если status=refused. */
  reason?: ContractAmendRefusal | undefined;
  /** Что сказать сотруднику: формулировку статуса задаёт код, а не модель. */
  message: string;
}

const outputSchema = z.object({
  status: z.enum(STATUSES),
  fileName: z.string().optional(),
  customerBlockFilled: z.boolean().optional(),
  convertedFrom: z.enum(['doc', 'rtf']).optional(),
  verdict: z.enum(['supplier', 'own_template', 'our_side_executor', 'unclear']).optional(),
  reason: z.enum(CONTRACT_AMEND_REFUSALS).optional(),
  message: z.string(),
});

/** Тексты отказов: что именно не получилось и что предложить сотруднику. */
const REFUSAL_MESSAGES: Readonly<Record<ContractAmendRefusal, string>> = {
  customer_block_not_found:
    'В присланном договоре не найден блок реквизитов заказчика («Заказчик:»/«Покупатель:»). ' +
    'Файл не менялся и не отправлен. Скажите сотруднику, что реквизиты нужно вписать вручную.',
  customer_block_filled:
    'В блоке заказчика присланного договора уже есть данные, чужой текст не затираем. Файл не ' +
    'менялся и не отправлен. Скажите об этом сотруднику; если в этом договоре наша сторона ' +
    'исполнитель, а не заказчик, режим не подходит и реквизиты вписывают вручную.',
  customer_placeholders_unfilled:
    'В блоке заказчика остались пустые поля, для которых у нас нет данных (например, факс ' +
    'или e-mail). Файл не менялся и не отправлен. Скажите сотруднику, что реквизиты нужно ' +
    'вписать вручную.',
  verification_failed:
    'Проверка показала, что правка затронула бы текст исполнителя. Файл не отправлен. ' +
    'Скажите сотруднику, что договор нужно дополнить вручную.',
  unsupported_format:
    'Этот формат не правится: нужен docx, .doc (Word 97-2003) или RTF. Файл не отправлен.',
  conversion_failed:
    'Файл .doc/RTF не удалось привести к docx (повреждён, защищён или слишком сложен для ' +
    'преобразования). Файл не менялся и не отправлен. Попросите сотрудника пересохранить ' +
    'договор в docx и прислать снова.',
  conversion_unavailable:
    'Преобразование .doc/RTF в docx сейчас недоступно. Файл не менялся и не отправлен. ' +
    'Попросите сотрудника прислать договор в docx.',
  spool_unavailable:
    'Сервис документов временно не смог подготовить файл к преобразованию (нет места на ' +
    'диске). Файл не менялся и не отправлен. Скажите сотруднику, что это временный сбой, и ' +
    'предложите прислать договор ещё раз чуть позже.',
  service_outdated:
    'Сервис документов устарел, правка договора будет доступна после обновления. Файл не ' +
    'менялся и не отправлен. Вид договора (поставщика или наш) самостоятельно не определяй. ' +
    'Скажите сотруднику, что правка сейчас недоступна и реквизиты можно вписать вручную.',
  file_too_large:
    'Файл слишком большой, либо его не удалось привести к docx за отведённое время. Файл не ' +
    'менялся и не отправлен. Попросите сотрудника пересохранить договор в формате docx (в ' +
    'Word: «Сохранить как» - «Документ Word (*.docx)») или прислать файл поменьше, и ' +
    'отправить снова.',
  nothing_to_do: 'Нечего добавлять: не указаны наши реквизиты.',
  bad_request: 'Данные для дополнения некорректны. Файл не отправлен.',
};

const SENT_MESSAGE =
  'Договор исполнителя отправлен сотруднику без подписи: текст, реквизиты и номер ' +
  'исполнителя не менялись (код проверил это после правки). Скажи одним сообщением, что ' +
  'добавлено: {added}.{notes} Номер договора не менялся и не меняется: это номер поставщика. ' +
  'Статус «ожидает проверки»: документ не подписан и не согласован. Попроси сверить ' +
  'добавленное с первичными документами.';

/** Файл .doc/RTF приведён к docx: проверка шла по сконвертированному исходнику. */
const CONVERTED_NOTE =
  ' Присланный файл был в формате {format}: он приведён к docx, поэтому и отправлен в docx - ' +
  'скажи об этом сотруднику. Проверка «текст и реквизиты исполнителя не изменились» выполнена ' +
  'по сконвертированному исходнику; попроси сверить оформление (шрифты, таблицы) с оригиналом.';
const FORMAT_NAMES = { doc: 'Word 97-2003 (.doc)', rtf: 'RTF' } as const;

const EXECUTOR_SIDE_MESSAGE =
  'Наша сторона в этом договоре - исполнитель, а режим дополняет только сторону заказчика ' +
  '(покупателя). Файл не менялся и не отправлен. Скажите сотруднику, что реквизиты в таком ' +
  'договоре вписывают вручную.';

/** Факт от кода: файл собран по нашему шаблону, режим для поставщиков не включается. */
const OWN_TEMPLATE_MESSAGE =
  'Код определил: этот файл собран по нашему шаблону, а не прислан поставщиком ({why}). Режим ' +
  '«дополнить договор поставщика» к нему не применяется, файл не менялся и не отправлен. ' +
  'Скажи сотруднику об этом как о факте. Если нужен новый договор по нашему шаблону - собирай ' +
  'его обычным порядком (findTemplate, fillTemplate). Если сотрудник настаивает, что это ' +
  'договор поставщика, пусть пришлёт файл в том виде, в каком его выслал поставщик.';
const OWN_TEMPLATE_WHY = {
  own_marker: 'в файле стоит наша метка собранного документа',
  template_match: 'его неизменный текст совпадает с нашим шаблоном',
} as const;

/** Вопрос сотруднику, когда код не может однозначно решить. Задаёт агент, не решает сам. */
const KIND_QUESTION_MESSAGE =
  'Код не смог однозначно определить вид документа ({why}). Файл не менялся и не отправлен. ' +
  'Задай сотруднику ОДИН вопрос и закончи ход: «Это договор поставщика, присланный в его ' +
  'форме (ответьте «да»), или документ по нашему шаблону (ответьте «нет» или «наш»)?». ' +
  'Кнопок в этом чате нет - ответ текстом. Сам за сотрудника не отвечай и не угадывай. Когда ' +
  'сотрудник ответит, вызови инструмент снова с теми же entity и fileName и kindAnswer=' +
  'supplier (договор поставщика) либо kindAnswer=own_template (наш шаблон). Код сам прочтёт ' +
  'последнее сообщение сотрудника и примет ответ, только если оно совпадает с твоим ' +
  'kindAnswer и пришло в следующей реплике после вопроса; иначе вопрос будет задан заново.';

/** Ответ сотрудника код не принял: вопрос задаётся заново (ответ не по теме или неоднозначен). */
const UNREADABLE_REPLY_NOTE =
  'Последнее сообщение сотрудника код не принял за ответ на вопрос о виде документа (не по ' +
  'теме, неоднозначно или не совпало с твоим kindAnswer). ';

const OWN_TEMPLATE_ANSWER_MESSAGE =
  'Сотрудник ответил, что это документ по нашему шаблону: режим «дополнить договор поставщика» ' +
  'не включается, файл не менялся. Если нужно собрать договор, собирай по нашему шаблону ' +
  'обычным порядком.';

const ENTITY_NOT_CONFIRMED_MESSAGE =
  'Не ясно, от какого нашего юрлица дополнять договор: в последних сообщениях сотрудника оно ' +
  'не названо. Спросите одним вопросом, чьи реквизиты вписать (Мастер Гифтс или Прагматика), ' +
  'и повторите с entity, которое он назвал. Не угадывайте юрлицо.';

function isContractFile(file: BitrixAttachment): boolean {
  const name = file.name.toLowerCase();
  return CONTRACT_EXTENSIONS.some((extension) => name.endsWith(extension));
}

type Picked =
  | { kind: 'file'; file: BitrixAttachment }
  | { kind: 'none' }
  | { kind: 'unsupported'; names: string[] }
  | { kind: 'ambiguous'; names: string[] };

/** Какой файл дополнять: по имени, либо единственный договор (docx, .doc, RTF) среди присланных. */
function pickFile(files: readonly BitrixAttachment[], wanted: string | undefined): Picked {
  const named =
    wanted === undefined
      ? files
      : files.filter((file) => file.name.toLowerCase() === wanted.toLowerCase());
  const contracts = named.filter(isContractFile);
  const [only] = contracts;
  if (contracts.length === 1 && only !== undefined) return { kind: 'file', file: only };
  if (contracts.length > 1) {
    return {
      kind: 'ambiguous',
      names: contracts.map((file) => file.name).slice(0, MAX_NAMES_LISTED),
    };
  }
  return named.length > 0
    ? { kind: 'unsupported', names: named.map((file) => file.name).slice(0, MAX_NAMES_LISTED) }
    : { kind: 'none' };
}

/**
 * Дополнить присланный договор поставщика нашими реквизитами, не удаляя ничего из данных
 * исполнителя и не меняя номер договора. Вместо сборки договора по нашему шаблону. Режим
 * включает код: файл не по нашему шаблону и сторона исполнителя заполнена (см. `contract-kind`).
 */
export const amendCounterpartyContract = defineTool<AmendInput, AmendOutput, DocumentsDeps>({
  name: 'amendCounterpartyContract',
  readsFile: true,
  sideEffect: true,
  // Другая формулировка аргументов на повторе даст второй файл сотруднику: оборванный ход
  // повторяется только по кнопке человека.
  replay: 'confirm',
  description:
    'Дополнить ПРИСЛАННЫЙ сотрудником договор поставщика (docx, .doc или RTF из этого чата): ' +
    'вписать наши реквизиты в сторону заказчика, НЕ удаляя и не заменяя ничего из текста, ' +
    'реквизитов и номера исполнителя. Номер договора поставщика не меняется никогда: ни ' +
    'дописать, ни заменить его нельзя. Используй, когда сотрудник прислал договор контрагента ' +
    'и просит добавить наши реквизиты; договор по нашему шаблону в этом случае НЕ собирай. ' +
    'Является ли файл договором поставщика, решает код, а не ты: не по нашему шаблону и ' +
    'сторона исполнителя заполнена. Код не уверен - status kind_question: задай сотруднику ' +
    'вопрос из message и после его ответа вызови снова с kindAnswer. entity - наше юрлицо (mg ' +
    'или pr; если сотрудник не назвал - спроси). Файл уходит сотруднику в чат сам. Если status ' +
    'не sent - перескажи message сотруднику и ничего не придумывай. Файл .doc/RTF приводится к ' +
    'docx, результат выдаётся в docx - скажи об этом сотруднику. Файл читается из чата сам, ' +
    'readChatAttachments перед этим вызывать не нужно.',
  inputSchema,
  outputSchema,
  // Другой присланный файл (повторная отправка исправленного договора) - новая операция.
  idempotencyPredecessor: async (_input, deps, threadId) =>
    (deps.botFiles?.recent(threadId) ?? []).map((file) => file.fileId).join(','),
  async execute(input, deps, context): Promise<AmendOutput> {
    assertEmployeeChatTurn(context);
    const amender = requirePort(deps.contractAmender, 'дополнение договора исполнителя');
    const reader = requirePort(deps.attachments, 'чтение файлов чата');
    if (input.ourRole === 'executor') {
      return { status: 'our_side_is_executor', message: EXECUTOR_SIDE_MESSAGE };
    }
    // Без хранилища сообщений сотрудника проверить нечем: юрлицо не принимается на веру.
    const said = await readRecentEmployeeMessages(
      deps.state,
      context.threadId,
      RECENT_EMPLOYEE_MESSAGES,
    );
    // Юрлицо называет сотрудник: чужие реквизиты в договоре - ошибка, которую не видно.
    if (!said.some((text) => entityNamedIn(text, input.entity))) {
      return { status: 'entity_not_confirmed', message: ENTITY_NOT_CONFIRMED_MESSAGE };
    }
    const refs = deps.botFiles?.recent(context.threadId) ?? [];
    const bundle =
      refs.length === 0
        ? { attachments: [], errors: [] }
        : await reader.fetchAttachments({
            botFiles: refs,
            signal: attachmentsSignal(context.signal),
          });
    const picked = pickFile(bundle.attachments, input.fileName);
    if (picked.kind === 'none') {
      return {
        status: 'no_file',
        message: 'В чате нет присланного договора. Попросите сотрудника прислать файл docx.',
      };
    }
    if (picked.kind === 'unsupported') {
      return {
        status: 'unsupported_format',
        message:
          `Присланные файлы (${picked.names.join(', ')}) не docx, не .doc и не RTF: такой ` +
          'формат не правится. Попросите сотрудника прислать договор в формате docx.',
      };
    }
    if (picked.kind === 'ambiguous') {
      return {
        status: 'ambiguous_file',
        message:
          `В чате несколько договоров (${picked.names.join(', ')}). Спросите сотрудника, какой ` +
          'дополнить, и повторите с fileName.',
      };
    }
    const own = await resolveOwnRequisites(deps, input.entity, context.signal);
    if (own === undefined) {
      // Этап 230: источник - запись БД; нет записи - отказ, текст шаблона не подставляется.
      if (deps.ownRequisites !== undefined) {
        deps.log?.('own_requisites_not_filled', { entity: OWN_ENTITY_CODE_BY_ALIAS[input.entity] });
        return {
          status: 'own_requisites_missing',
          message: `${ownRequisitesNotFilledMessage(input.entity)} Файл не изменён.`,
        };
      }
      return {
        status: 'own_requisites_missing',
        message:
          'Не удалось получить наши реквизиты (нет шаблона договора юрлица). Файл не изменён. ' +
          'Скажите сотруднику, что реквизиты нужно вписать вручную.',
      };
    }
    try {
      // Признак «договор поставщика» решает код (решение владельца 08.11.2026): модель только
      // передаёт ответ сотрудника на вопрос кода.
      const identity = await ownIdentity(deps);
      const kind = await amender.classify({
        fileName: picked.file.name,
        bytes: picked.file.bytes,
        templates: await readOwnTemplates(deps, context.signal),
        ownInns: identity.inns,
        ownNames: identity.names,
        signal: context.signal,
      });
      if (kind.verdict === 'our_side_executor') {
        return { status: 'our_side_is_executor', message: EXECUTOR_SIDE_MESSAGE };
      }
      if (kind.verdict === 'own_template') {
        const why = kind.reasons.includes('own_marker')
          ? OWN_TEMPLATE_WHY.own_marker
          : OWN_TEMPLATE_WHY.template_match;
        return {
          status: 'own_template',
          verdict: kind.verdict,
          message: OWN_TEMPLATE_MESSAGE.replace('{why}', why),
        };
      }
      if (kind.verdict === 'unclear') {
        const fileHash = contractFileHash(picked.file.bytes);
        const resolved = await resolveKindAnswer(
          deps,
          context.threadId,
          fileHash,
          context.turnNumber,
          input.kindAnswer,
        );
        if (resolved.status !== 'accepted') {
          await recordKindQuestion(deps, context.threadId, fileHash, context.turnNumber);
          const question = KIND_QUESTION_MESSAGE.replace('{why}', unclearReasonText(kind));
          return {
            status: 'kind_question',
            verdict: kind.verdict,
            message:
              resolved.status === 'unreadable' ? `${UNREADABLE_REPLY_NOTE}${question}` : question,
          };
        }
        if (resolved.answer === 'own_template') {
          return { status: 'own_template', message: OWN_TEMPLATE_ANSWER_MESSAGE };
        }
      }
      const amended = await amender.amend({
        fileName: picked.file.name,
        bytes: picked.file.bytes,
        own,
        signal: context.signal,
      });
      const file: ChatFile = {
        name: amended.fileName,
        mimeType: amended.mimeType,
        content: amended.bytes,
      };
      const threadId = deps.reviewerThreadId ?? context.threadId;
      // Тот же файл с теми же параметрами уходит один раз; ключ канала включает тред получателя.
      const key = joinKey(
        'contract-amend',
        sha256HexSync(base64Of(picked.file.bytes)),
        input.entity,
        threadId,
      );
      await requirePort(deps.chat, 'канал чата').sendFile(threadId, file, key);
      const sentAt = (deps.clock?.now() ?? new Date()).toISOString();
      await deps.state?.put(
        REVIEW_NAMESPACE,
        joinKey('amend', amended.fileName, sha256HexSync(key)),
        toStoredJson({
          status: AWAITING_REVIEW,
          kind: 'contract',
          mode: 'amend',
          fileName: amended.fileName,
          handedAt: sentAt,
        }),
        { done: true },
      );
      return {
        status: 'sent',
        fileName: amended.fileName,
        customerBlockFilled: amended.customerBlockFilled,
        ...(amended.convertedFrom === null ? {} : { convertedFrom: amended.convertedFrom }),
        message: SENT_MESSAGE.replace(
          '{added}',
          amended.customerBlockFilled ? 'наши реквизиты вписаны в сторону заказчика' : 'ничего',
        ).replace(
          '{notes}',
          amended.convertedFrom === null
            ? ''
            : CONVERTED_NOTE.replace('{format}', FORMAT_NAMES[amended.convertedFrom]),
        ),
      };
    } catch (error) {
      if (!(error instanceof ContractAmendRefusedError)) throw error;
      return { status: 'refused', reason: error.reason, message: REFUSAL_MESSAGES[error.reason] };
    }
  },
});
