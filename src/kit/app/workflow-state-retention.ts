import { MAIL_STALE_NAMESPACES } from '@business-ai/adapters';
import {
  AGENT_CALL_INDEX_NAMESPACE_PREFIX,
  CHAT_ROSTER_NAMESPACE,
  EMAIL_DRAFT_NAMESPACE,
  EMAIL_DRAFT_SCOPE_NAMESPACE,
  HANDOFF_ANSWER_NAMESPACE,
  HANDOFF_INDEX_NAMESPACE_PREFIX,
  HANDOFF_WAIT_INDEX_NAMESPACE_PREFIX,
  HANDOFF_LATEST_NAMESPACE,
  HANDOFF_NAMESPACE,
  MONITORING_NAMESPACE,
  TURN_PRINCIPAL_NAMESPACE,
  WORK_OWNER_NAMESPACE,
} from '@business-ai/core';
import { ATTACHMENT_TEXT_NAMESPACE } from '../../agents/suppliers/document-source-text';
import {
  COMPLETENESS_NAMESPACE,
  REPLY_FILES_NAMESPACE_PREFIX,
  REQUEST_TEXT_RESHOW_NAMESPACE,
  OPEN_SELECTION_NAMESPACE,
  ORDER_DIGEST_SHOWN_NAMESPACE,
  ORDER_REMINDER_SNOOZE_NAMESPACE,
  SENT_NAMESPACE,
  SUPPLIER_DRAFT_OWNER_NAMESPACE,
  UNASSIGNED_FILES_NAMESPACE,
  UNASSIGNED_MAIL_NAMESPACE,
} from '../../agents/order-calc/deps';
import { EMPLOYEE_TEXT_NAMESPACE } from '../../agents/documents/employee-messages';
import {
  JUMP_DECISION_NAMESPACE,
  JUMP_REQUEST_NAMESPACE,
  MAIL_FILE_NAMESPACE,
  MAIL_NAMESPACE,
  MAIL_TRIGGER_NAMESPACE,
  PREVIEW_NAMESPACE,
  SOURCE_CELLS_NAMESPACE,
  PRICE_PROPOSAL_NAMESPACE,
  PRICE_REQUEST_SENT_NAMESPACE,
  TRIGGER_CURSOR_NAMESPACE,
} from '../../agents/prices/deps';
import { PREPARED_CONTRACT_NAMESPACE } from '../../agents/documents/prepared-contract';
import {
  SUPPLIER_BATCH_NAMESPACE,
  SUPPLIER_PENDING_NAMESPACE,
  SUPPLIER_BATCH_TTL_MS,
  SUPPLIER_CARD_REQUEST_NAMESPACE,
  SUPPLIER_CARD_REQUEST_TTL_MS,
} from '../../agents/suppliers/deps';
import { SUPPLIER_CRM_QUOTA_NAMESPACE } from '../../agents/suppliers/crm-sync';
import {
  SUPPLIER_MAIL_CURSOR_NAMESPACE,
  SUPPLIER_MAIL_RETRY_NAMESPACE,
  SUPPLIER_MAIL_SEEN_NAMESPACE,
} from '../../agents/suppliers/mail-enrich';
import {
  SUPPLIER_MAIL_PROPOSAL_CURSOR_NAMESPACE,
  SUPPLIER_MAIL_PROPOSAL_DRAFT_NAMESPACE,
  SUPPLIER_MAIL_PROPOSAL_MSG_NAMESPACE,
  SUPPLIER_MAIL_PROPOSAL_NAMESPACE,
  SUPPLIER_MAIL_PROPOSAL_QUOTA_NAMESPACE,
  SUPPLIER_MAIL_PROPOSAL_ROTATION_NAMESPACE,
} from '../../agents/suppliers/mail-proposal-store';
import {
  WEB_DECISION_NAMESPACE,
  WEB_REQUEST_NAMESPACE,
  WEB_TEXT_NAMESPACE,
} from '../../agents/documents/web-confirmation';
import { OWN_REQUISITES_REQUEST_NAMESPACE } from '../../agents/documents/update-own-requisites';
import { STEPS_NAMESPACE_PREFIX, type WorkflowStateStaleScope } from '@business-ai/core';

/**
 * Прежние записи об уведомлениях по устаревшим файлам (повтор «раз в 30 дней» отменён, код их
 * больше не пишет и не читает). Остались в базе от прошлых версий: пространство оставлено в
 * очистке, чтобы они ушли по сроку, а не лежали вечно.
 */
const LEGACY_PRICE_FILE_NOTICE_NAMESPACE = 'prices:stale-file-notice';

/**
 * Пространства состояния, которые чистятся по сроку без признака `done` (R5-DB-9).
 * Срок - `WORKFLOW_STATE_STALE_RETENTION_DAYS` (ports/workflow-state-store.ts).
 *
 * Почему устаревшее здесь уже не читается:
 * - `order-calc:sent`: ответ привязывается к заявке только в окне `REPLY_WINDOW_DAYS` (60 дней)
 *   от отправки (routeMail), а запись обновляется при каждой повторной отправке;
 *   повторная отправка защищена ключом идемпотентности рантайма (тот же срок хранения);
 * - `order-calc:selection-open`: индекс открытых выборов (копия выбора); выбор старше окна
 *   ответов в него не вносится и снимается при просмотре. Сами выборы (`order-calc:selection`)
 *   и отметка внесения старых выборов в индекс в область НЕ входят;
 * - `order-calc:unassigned-mail` и `order-calc:unassigned-file`: письмо без привязки старше срока
 *   менеджеру уже не показывается как актуальное (окно ответов давно закрыто). Указатели
 *   `r:`, `t:`, `hr:` лежат в том же пространстве и уходят с ним; отметка однократного внесения
 *   в индекс (`order-calc:mail-index-backfill`) в область НЕ входит;
 * - `order-calc:reply-file:<заявка>`: тела вложений ответов нужны только для разбора ответа;
 *   тексты ответов (`order-calc:reply:`) и принятые КП остаются;
 * - `prices:mail`, `prices:mail-file`: непрочитанное письмо с прайсом старше срока устарело
 *   (закрытые письма уходят по `done` раньше). Курсор почты (`prices:inbox-cursor`) не трогаем.
 * - `handoff.v1`, `handoff-index.v1/<тред>`, `handoff-latest.v1`: передачи между агентами живут
 *   не дольше срока годности (1 час) плюс повторы задачи (~11 ч), а передача с вопросом человеку -
 *   не дольше срока ответа (24 ч) плюс повторы; итог читают в ближайшие ходы.
 *   Закрытые записи помечены `done` (срок `WORKFLOW_STATE_RETENTION_DAYS`), брошенные открытые и
 *   индекс уходят по сроку без записи (`WORKFLOW_STATE_STALE_RETENTION_DAYS`);
 * - `handoff-answer.v1`: ответы людей на вопросы дочерних агентов (ключ `<передача>:<вопрос>`).
 *   Текст ответа (в нём могут быть ПДн) стирается при использовании и при ЛЮБОМ закрытии
 *   передачи (итог, срок, отказ в доступе, сбой воркера); стёртая запись помечена `done` и уходит
 *   по сроку завершённых (`WORKFLOW_STATE_RETENTION_DAYS`). Без `done` остаётся лишь ответ на
 *   ещё открытый вопрос (не дольше срока ответа - сутки - плюс повторы задачи), а запись,
 *   которую закрытие так и не затронуло (брошенная передача), уходит по сроку без записи
 *   (`WORKFLOW_STATE_STALE_RETENTION_DAYS`) вместе с текстом, то есть не дольше этого срока;
 * - `app:scheduled-wait` с `handoffId`: ожидание ответа на вопрос передачи; закрытое помечено
 *   `done` кодом исполнения передачи (отдельной записи в области не требует);
 * - `agent-call.v1/<тред>/<номер реплики>`: индекс вызовов агентов хода (ключ вызова и время, без
 *   содержимого); брошенный уходит по сроку без записи.
 * - `turn-principal.v1`: прежняя запись инициатора хода. Больше не пишется (инициатор идёт в
 *   `ToolContext`), префикс остаётся, чтобы ретенция убрала старые строки после обновления.
 * - `steps.v1/<тред>/<номер реплики>` (порт `DurableSteps`): записи шагов и метки аренды хода;
 *   метод порта `close()` (метка `done`) в коде приложения не вызывается, поэтому записи ходов
 *   `done` не получают и уходят по сроку без записи (`WORKFLOW_STATE_STALE_RETENTION_DAYS`, 90
 *   суток), как брошенные. Ключи эффектов и аренды лежат в `idempotency_keys` и чистятся её
 *   ретенцией (результаты по сроку, «в сомнении» - нет).
 * - `work-owner.v1`: владелец работы (тред связки сотрудника, начавшего импорт, заявку, выгрузку
 *   или недельный цикл) и тред последнего вопроса плановому запуску. Только id треда, без
 *   текстов. Запись не обновляется после первой (первый владелец побеждает), поэтому уходит по
 *   сроку без записи (`WORKFLOW_STATE_STALE_RETENTION_DAYS`); после этого адресат - запасной
 *   (`MANAGER_THREAD_ID`), как у работы без владельца.
 * - `mail-draft.v1`, `mail-draft-scope.v1`: черновики исходящих писем сотрудников. В записи
 *   лежит исходный текст с ПДн: на терминальном статусе (отправлен, отменён, просрочен,
 *   заменён, заблокирован) текст стирается и запись помечается `done`, а брошенный
 *   неотправленный черновик (срок действия - сутки) уходит по сроку без записи, вместе с
 *   текстом. Указатель сферы хранит только id и поколение.
 *  * - `order-calc:draft-owner`: «кто последним готовил черновик по заявке» (ключ - заявка, в
 *   значении только id сотрудника, без текстов и адресов). Нужен лишь ключу идемпотентности
 *   инструмента, пока жив черновик (срок действия - сутки); потерянная запись даёт ключ без
 *   предшественника, а не повторную отправку (письмо уходит только кнопкой). Без `done`:
 *   запись перезаписывается при каждом новом черновике, поэтому уходит по сроку без записи.
 * - `prices:price-request-sent`: «запрос прайса этому поставщику на этой неделе отправлен»
 *   (ключ - неделя и поставщик, в значении время и отпечаток адреса, без самого адреса). Ключ
 *   привязан к ISO-неделе, прошлые недели не читаются; ПДн нет, `done` не ставится, поэтому
 *   уходит по сроку без записи.
 * - `chat-roster.v1`: реестр обращений сотрудников к агентам (только идентификаторы). Запись
 *   обновляется не чаще раза в сутки, поэтому ушедший сотрудник пропадает по сроку без записи.
 * - `monitoring.v1`: слоты и границы окон плановых проверок (только даты и время); слот дня
 *   нужен лишь в тот же день, запись `last:` обновляется при каждой проверке.
 * - `prices:stale-file-notice`: «об этом файле уже сообщали» (ключ - отпечаток пути, в значении
 *   дата изменения файла и время сообщения, без самого пути); устаревшее пространство: проверка
 *   диска теперь идёт по дате в названии файла и эту запись не пишет (повтор раз в 30 суток
 *   остался от прежней проверки), старые записи уходят по сроку без записи.
 * - `prices:mail-trigger`: «об этом письме уже сообщали или оно признано незначимым» (только
 *   идентификаторы и даты, без темы и адреса). Нужны лишь для правила «одно письмо - одно
 *   уведомление»: письма старше `PRICE_MAIL_TRIGGER_MAX_AGE_DAYS` (7 суток) просмотр
 *   пропускает по возрасту, поэтому запись старше 90 суток дубль уже не предотвращает.
 * - `prices:trigger-cursor`: курсор просмотра триггеров на ящик. Потерянный курсор не вредит:
 *   старые письма пропускаются по возрасту (`PRICE_MAIL_TRIGGER_MAX_AGE_DAYS`), об уже
 *   замеченных письмах повтор закрыт записью `prices:mail-trigger`.
 * - `suppliers:mail-enrich-seen.v1`: «это письмо ящика-источника уже разобрано» (ключ - хэш
 *   ящика и id письма, в значении время и исход, без адресов, тем и текстов; этап 220, разовый
 *   проход 220b). Запись нужна лишь на время разбора ящика (дни): позже повторный запуск
 *   разберёт письма заново, а дубль карточки закрыт сопоставлением по ИНН и адресам.
 * - `suppliers:mail-enrich-retry.v1`: число повторов оценки письма (ревью 220). Потеря записи
 *   безвредна: счётчик повторов начнётся заново.
 * - `suppliers:mail-enrich-cursor.v1`: курсор разового прохода по ящику-источнику. Потерянный
 *   курсор не вредит: ящик читается с начала, разобранные письма закрыты отметками.
 * - `suppliers:mail-proposal.v1`, `suppliers:mail-proposal-msg.v1`,
 *   `suppliers:mail-proposal-draft.v1`, `suppliers:mail-proposal-cursor.v1`,
 *   `suppliers:mail-proposal-quota.v1`, `suppliers:mail-proposal-rotation.v1`: обзор почты
 *   сотрудников (этап 222). Предложение хранит названия компаний, темы, адрес отправителя, домен
 *   и ИНН письма только пока оно открыто (при закрытии и замене новым тексты стираются);
 *   ротация - одна запись «с кого начинать обход» (потеря безвредна: обход начнётся сначала);
 *   отметка письма - хэш и исход, черновик - не предложенные ещё кандидаты, курсор и счётчик -
 *   служебное. Письма старше окна (7 суток) обзор пропускает по возрасту, поэтому запись старше
 *   90 суток дубль уже не предотвращает; потерянный курсор не вредит (читается заново).
 * - `suppliers:mail-proposal-seen.v1` НЕ чистится по сроку: «этому сотруднику этого поставщика
 *   уже предлагали» (ключ - хэш сотрудника и ИНН, домена или названия; в значении статус
 *   `proposed|declined|created|known` и время, ПДн нет). Отклонённое не предлагается никогда,
 *   потеря записи вернула бы отказанные предложения. `known` пишется только по корпоративному
 *   домену отправителя (ИНН и названия из текста письма в отметки «известен» не идут), поэтому
 *   размер ограничен числом предложенных поставщиков и доменов известных поставщиков на
 *   сотрудника.
 * - `suppliers:crm-sync-quota.v1`: УСТАРЕВШИЙ суточный счётчик CRM-синхронизации (этап 221;
 *   с этапа 243 расписания и квоты нет, ничего не пишется). Остатки прежней версии уходят по
 *   сроку. Пространства `-cycle.v1` и `-cursor.v1` тоже больше не читаются; по сроку они не
 *   чистятся (одна запись и не больше числа компаний), удалить их можно по решению владельца.
 * - `suppliers:crm-link.v1` НЕ чистится по сроку: связь «id компании -> id карточки» (потеря -
 *   дубль карточки при переименовании компании в CRM, где ИНН не указан). Только идентификаторы
 *   и время, объём не больше числа компаний-поставщиков в CRM.
 * - `suppliers:card-request`, `suppliers:card-batch`: запросы подтверждения карточки, заметки и
 *   пачки поставщиков. В записи лежат данные карточки с ПДн (название, ИНН, контакты): на
 *   терминальном статусе (сохранено, отменено, просрочено, заблокировано) данные стираются, а
 *   запись помечается `done`. Брошенный запрос (кнопку так и не нажали) срок действия - сутки -
 *   сам данные не теряет: его удаляет вместе с данными короткая очистка
 *   `SUPPLIER_REQUEST_STALE_SCOPE` (двойной срок действия, `SUPPLIER_REQUEST_STALE_AFTER_MS`).
 *   В общем списке ниже (90 суток) пространства остаются страховкой на случай, если короткая
 *   очистка не выполнялась.
 * - `mail-processed.v1`, `mail-send.v1`, `mail-login.v1` (адаптер IMAP + SMTP): только хэши,
 *   числа и даты, без адресов и текстов. Брошенная пометка, фаза отправки старше срока
 *   идемпотентности и блокировка входа по давности больше не читаются. Базовая точка ящика
 *   (`mail-baseline.v1`) НЕ входит: её потеря означала бы пропуск писем.
 * - `prices:preview`, `prices:jump-request`, `prices:jump-decision` (R6-06-07): полный diff
 *   сравнения (до 12 МБ), запрос и решение человека по скачкам цен. Закрытые записи `done` не
 *   получали (preview - только после отправки файла изменений по уже записанному прайсу), а
 *   брошенные сравнения, отклонённые импорты и неотвеченные запросы лежали бы вечно. Решение
 *   живёт сутки (`JUMP_DECISION_TTL_MS`), запрос читается, пока человек может ответить; запись,
 *   не обновлявшаяся 90 суток, уже не читается и создаётся заново сравнением.
 * - `prices:import-meta` в область НЕ входит: по ней еженедельная проверка старых файлов
 *   (дата в названии старше 3 месяцев) подбирает поставщика по импортам с диска, а срок записи
 *   длиннее 90 суток. Записи не-дисковых источников (письмо, чат, сотрудник; в них тексты
 *   заметок) пишутся сразу с `done` (`saveImportMeta`) и уходят по сроку завершённых; запись
 *   источника «диск» остаётся.
 * - `order-calc:completeness`: вид запроса и характеристики заказа сотрудника (названия, тиражи,
 *   бюджет, возможны ПДн) для проверки полноты и письма поставщику; `done` не ставится, запись
 *   перезаписывается при каждом дополнении, поэтому брошенная заявка уходит по сроку без записи.
 *   Нужна, пока заявка живая (текст запроса собирается по ней); срок 90 суток шире окна ответов.
 * - `prices:proposal`: неподтверждённые цены не с диска (чат, письмо, слова сотрудника). Диск -
 *   источник правды; предложение удаляется импортом прайса поставщика с диска, а не внесённое
 *   на диск за 90 суток устарело.
 * - `order-calc:request-text-reshow`: счётчик повторных показов текста запроса (только число).
 * - `order-calc:digest-shown` (ключ - тред): что показала последняя утренняя сводка (текст с
 *   названиями заявок и поставщиков, список заявок); читается только в окне ответа (4 суток),
 *   новая сводка заменяет запись, брошенная уходит по сроку без записи (этап 226).
 * - `order-calc:reminder-snooze` (ключ - заявка): «не напоминать до даты» (дата, время, id
 *   сотрудника); после даты запись ничего не значит, поэтому уходит по сроку без записи.
 * Намеренно НЕ входят: курсоры почты, предложения, выбор, подтверждения, тексты ответов,
 * последние подтверждённые цены - это живое состояние сценариев.
 *
 * НЕ входят (решение владельца): `order-calc:proposal` и `order-calc:source` - шорт-лист и
 * результаты источников, в них хранятся контакты поставщика; хранятся постоянно, `done` не
 * ставится (тест order-calc-state-retention.test.ts).
 */
export const WORKFLOW_STATE_STALE_SCOPE: WorkflowStateStaleScope = {
  namespaces: [
    SENT_NAMESPACE,
    OPEN_SELECTION_NAMESPACE,
    COMPLETENESS_NAMESPACE,
    REQUEST_TEXT_RESHOW_NAMESPACE,
    ORDER_DIGEST_SHOWN_NAMESPACE,
    ORDER_REMINDER_SNOOZE_NAMESPACE,
    UNASSIGNED_MAIL_NAMESPACE,
    UNASSIGNED_FILES_NAMESPACE,
    MAIL_NAMESPACE,
    MAIL_FILE_NAMESPACE,
    HANDOFF_NAMESPACE,
    HANDOFF_ANSWER_NAMESPACE,
    HANDOFF_LATEST_NAMESPACE,
    TURN_PRINCIPAL_NAMESPACE,
    WORK_OWNER_NAMESPACE,
    SUPPLIER_DRAFT_OWNER_NAMESPACE,
    PRICE_REQUEST_SENT_NAMESPACE,
    CHAT_ROSTER_NAMESPACE,
    MONITORING_NAMESPACE,
    LEGACY_PRICE_FILE_NOTICE_NAMESPACE,
    MAIL_TRIGGER_NAMESPACE,
    TRIGGER_CURSOR_NAMESPACE,
    EMAIL_DRAFT_NAMESPACE,
    EMAIL_DRAFT_SCOPE_NAMESPACE,
    SUPPLIER_CARD_REQUEST_NAMESPACE,
    SUPPLIER_BATCH_NAMESPACE,
    SUPPLIER_MAIL_SEEN_NAMESPACE,
    SUPPLIER_MAIL_CURSOR_NAMESPACE,
    SUPPLIER_MAIL_RETRY_NAMESPACE,
    // Обзор почты сотрудников (этап 222). Отметки о поставщиках (`...-seen.v1`) сюда сознательно
    // не входят: отказ не должен забываться.
    SUPPLIER_MAIL_PROPOSAL_NAMESPACE,
    SUPPLIER_MAIL_PROPOSAL_MSG_NAMESPACE,
    SUPPLIER_MAIL_PROPOSAL_DRAFT_NAMESPACE,
    SUPPLIER_MAIL_PROPOSAL_CURSOR_NAMESPACE,
    SUPPLIER_MAIL_PROPOSAL_QUOTA_NAMESPACE,
    SUPPLIER_MAIL_PROPOSAL_ROTATION_NAMESPACE,
    // Суточный счётчик синхронизации с CRM (этап 221). Курсор и связи «компания CRM -> карточка»
    // сюда сознательно не входят (см. выше).
    SUPPLIER_CRM_QUOTA_NAMESPACE,
    PREVIEW_NAMESPACE,
    // Координаты ячеек цен исходного файла: правка на месте нужна, пока прайс свежий.
    SOURCE_CELLS_NAMESPACE,
    JUMP_REQUEST_NAMESPACE,
    JUMP_DECISION_NAMESPACE,
    // Неподтверждённые предложения цен не с диска: закрываются импортом с диска, брошенные -
    // по сроку.
    PRICE_PROPOSAL_NAMESPACE,
    // Подтверждение веб-данных документов: запрос, решение и текст веб-выдачи треда.
    WEB_REQUEST_NAMESPACE,
    WEB_DECISION_NAMESPACE,
    WEB_TEXT_NAMESPACE,
    // Запросы подтверждения изменения наших реквизитов (этап 230): брошенные чистятся по сроку.
    OWN_REQUISITES_REQUEST_NAMESPACE,
    // Текст сообщений сотрудника треда документов (сверка реквизитов; в нём реквизиты и ПДн).
    EMPLOYEE_TEXT_NAMESPACE,
    // Текст прочитанных вложений треда (источник дополнения карточки; в нём реквизиты и ПДн) и
    // поставщики собранных договоров (id, без текстов): нужны, пока идёт разговор.
    ATTACHMENT_TEXT_NAMESPACE,
    PREPARED_CONTRACT_NAMESPACE,
    // Почтовый адаптер: пометки, фазы отправки, блокировки входа (базовая точка не входит).
    ...MAIL_STALE_NAMESPACES,
  ],
  namespacePrefixes: [
    REPLY_FILES_NAMESPACE_PREFIX,
    HANDOFF_INDEX_NAMESPACE_PREFIX,
    HANDOFF_WAIT_INDEX_NAMESPACE_PREFIX,
    AGENT_CALL_INDEX_NAMESPACE_PREFIX,
    STEPS_NAMESPACE_PREFIX,
  ],
};

/**
 * Брошенные запросы карточек и пачек поставщиков: в них открыто лежат данные с ПДн (ФИО,
 * телефоны, email), поэтому чистятся не через 90 суток, а вскоре после срока действия кнопки.
 * Запрос старше этого срока уже не принимает нажатий (`expired`), читать его некому.
 */
export const SUPPLIER_REQUEST_STALE_SCOPE: WorkflowStateStaleScope = {
  namespaces: [
    SUPPLIER_CARD_REQUEST_NAMESPACE,
    SUPPLIER_BATCH_NAMESPACE,
    // Указатель на последний показ треда: ссылается только на токен запроса.
    SUPPLIER_PENDING_NAMESPACE,
  ],
  namespacePrefixes: [],
};

/** Запас сверх срока действия кнопки: сколько сроков действия ждём до удаления. */
const SUPPLIER_REQUEST_STALE_FACTOR = 2;

/** Через сколько после последней записи брошенный запрос поставщиков удаляется. */
export const SUPPLIER_REQUEST_STALE_AFTER_MS =
  SUPPLIER_REQUEST_STALE_FACTOR * Math.max(SUPPLIER_CARD_REQUEST_TTL_MS, SUPPLIER_BATCH_TTL_MS);
