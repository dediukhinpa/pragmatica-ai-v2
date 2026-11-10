import type { Severity } from '@business-ai/adapters';

/**
 * Классы событий журнала, которые пишет код проекта (агенты, адаптеры, сборка). События
 * платформы здесь не повторяются: их класс задаёт сама платформа и менять его проект не может.
 * Событие без записи получает класс `info`, поэтому новое событие агента обязано попасть сюда
 * (это проверяет `tests/project/event-severity.test.ts`). Таблица снята с прежнего ядра
 * Прагматики; события платформы отсюда исключены.
 */
export const PROJECT_EVENT_SEVERITY: Readonly<Record<string, Severity>> = {
  // Этап 230: наши реквизиты как данные. Нет записи юрлица - договор не собран (fail closed);
  // печатный блок шаблона расходится с записью - тоже отказ; запись изменена сотрудником
  // (в поле только юрлицо и названия полей); чтение записей для фильтра не удалось - остаётся env.
  own_requisites_not_filled: 'warning',
  own_requisites_template_mismatch: 'warning',
  own_signatory_refused: 'warning',
  own_signatory_not_found: 'warning',
  own_signatory_substituted: 'info',
  own_requisites_updated: 'info',
  own_requisites_read_failed: 'warning',
  // Запись реквизитов прошла, а закрыть заявку подтверждения не удалось (повтор её закроет).
  own_requisites_close_failed: 'warning',
  // Этап 232: шаблон договора для признака «договор поставщика» не прочитан с шары (сравнить не
  // с чем: код спросит сотрудника, а не объявит файл чужим).
  contract_kind_template_unreadable: 'warning',
  // Этап 219: текст вложения не сохранён - дополнение карточки из договора/сайта не пройдёт сверку.
  attachment_text_not_saved: 'warning',
  // Этап 108: у каждого сбоя есть откат на прежнее поведение, ответ сотруднику не теряется.
  order_calc_document_search_failed: 'warning',
  // Этап 226: справка об ответе на напоминание не записана или не прочитана. Сводка ушла и
  // ход идёт, теряется только связка ответа с заявками (было serious, но это не отказ).
  order_digest_shown_failed: 'warning',
  order_reminder_context_failed: 'warning',
  web_page_read_failed: 'warning',
  // Этап 158: шаблон заказчика. Запись пакета позиций и выдача файла сотруднику (только числа).
  site_template_filled: 'info',
  site_template_sent: 'info',
  site_template_send_failed: 'serious',
  // Этап 167: повторная выдача той же версии в том же ходе пропущена.
  site_template_send_skipped: 'info',
  web_hit_classify_implausible: 'warning',
  intake_task_read_denied: 'warning',
  intake_deal_read_denied: 'warning',
  saved_script_run: 'info',
  script_items_staged: 'info',
  order_calc_card_search_failed: 'serious',
  order_digest_mailbox_unreadable: 'serious',
  order_digest_order_failed: 'serious',
  order_digest_send_failed: 'serious',
  order_reply_replace_offer_failed: 'serious',
  order_reply_replay_failed: 'serious',
  order_reply_reread_failed: 'serious',
  price_mail_assess_failed: 'serious',
  price_stale_files_send_failed: 'serious',
  supplier_batch_storage_unavailable: 'serious',
  supplier_export_audit_failed: 'serious',
  supplier_import_failed: 'serious',
  supplier_rating_cache_read_failed: 'serious',
  supplier_rating_cache_write_failed: 'serious',
  supplier_rating_model_failed: 'serious',
  supplier_template_failed: 'serious',
  supplier_template_file_unavailable: 'serious',
  order_reply_held_overflow: 'warning',
  order_state_scan_limit: 'warning',
  price_file_date_fallback: 'warning',
  supplier_rating_model_limit: 'warning',
  shortlist_compare_failed: 'warning',
  shortlist_compare_partial: 'info',
  // Веб-поиск с моделью: сбой не ломает ход, есть запасной путь (запросы по названиям позиций,
  // кандидат без обогащения), поэтому warning, а не serious.
  web_enrich_model_failed: 'warning',
  // Отказ шлюза на маршруте страниц сайтов: факты взяты разбором кодом, ход не ломается.
  web_enrich_page_fallback: 'warning',
  web_enrich_search_failed: 'warning',
  web_query_plan_failed: 'warning',
  // Классификация хитов: сбой модели оставляет кандидатов как есть (название по домену).
  web_hit_classify_failed: 'warning',
  // Этап 121: гибридный поиск по прайсам. Сбой эмбеддингов - поиск по словам, импорт цел.
  price_embeddings_failed: 'warning',
  price_search_embed_failed: 'warning',
  // Проверка строк прайсов моделью: сбой или недостоверный ответ ничего не убирает.
  price_relevance_failed: 'warning',
  // info
  price_embeddings_filled: 'info',
  price_relevance_check: 'info',
  // Этап 121: обогащение карточек поставщиков через интернет; сбой не убирает поставщика из списка.
  supplier_enrich: 'info',
  supplier_enrich_failed: 'warning',
  // Этап 220: разовый проход по ящику-источнику. Сбой модели или записи - пропуск письма без
  // записи, прогон идёт дальше.
  supplier_mail_enrich_classify_failed: 'warning',
  supplier_mail_enrich_rejected: 'warning',
  supplier_mail_enrich_audit_failed: 'warning',
  // Письмо закрыто после предела повторов оценки: потеря сведений письма, на это смотрит человек.
  supplier_mail_enrich_abandoned: 'warning',
  // Этап 221: синхронизация карточек поставщиков с CRM. Сбой записи компании - пропуск без
  // остановки прохода; нет прав вебхука на CRM - ошибка настройки, на неё смотрит владелец.
  supplier_crm_sync: 'info',
  supplier_crm_sync_rejected: 'warning',
  supplier_crm_sync_audit_failed: 'warning',
  supplier_crm_sync_access_denied: 'warning',
  // Ревью 221: расхождение связи компании с карточкой решает человек; фильтр признака
  // «поставщик» на портале, скорее всего, не сработал или не нашёл ни одной компании.
  supplier_crm_sync_link_mismatch: 'warning',
  supplier_crm_sync_filter_suspect: 'warning',
  crm_suppliers_sync_ignored: 'warning',
  bitrix24_crm_suppliers: 'info',
  // Этап 222: обзор почты сотрудников и предложения завести карточки. Сбой оценки письма или
  // ящика одного сотрудника - пропуск без остановки прохода; закрытое после предела повторов
  // письмо и сбой записи ответа - потеря сведений, на неё смотрит человек. Итог прохода и ответ
  // сотрудника - штатное; отключённая почта - предупреждение.
  supplier_mail_proposals: 'info',
  supplier_mail_proposals_classify_failed: 'warning',
  supplier_mail_proposals_abandoned: 'warning',
  supplier_mail_proposals_employee_failed: 'warning',
  supplier_mail_proposal_decision: 'info',
  // Этап 233: реквизиты из письма не применены автоматически, ждут подтверждения человека.
  supplier_mail_requisites_withheld: 'warning',
  // Этап 233: правку с реквизитами письма показать не удалось, осталась пометка на карточке.
  supplier_mail_requisites_offer_failed: 'warning',
  // Этап 233: в обследовании доверия не удалось прочитать один из ящиков.
  mail_trust_survey_mailbox_failed: 'warning',
  supplier_mail_proposal_audit_failed: 'warning',
  supplier_mail_auto_enrich_audit_failed: 'warning',
  supplier_mail_auto_enrich_failed: 'warning',
  supplier_mail_proposal_unavailable: 'warning',
  supplier_mail_proposal_letters_unavailable: 'warning',
  mail_proposals_ignored: 'warning',
  // Этап 220b: сбой аудита при применении подтверждённого пункта отчёта (запись уже сделана).
  supplier_mail_backfill_audit_failed: 'warning',
  // Этап 163: названный поставщик без карточки - предложение, ответ сотрудника и заведённая
  // карточка по сайту; все три - обычный ход работы, не сбой.
  supplier_card_offer: 'info',
  supplier_card_offer_decision: 'info',
  supplier_card_from_site: 'info',
  // Этап 182: поиск поставщика по базе у остальных агентов; только коды и счётчики, без названий.
  supplier_lookup: 'info',
  supplier_lookup_offer: 'info',
  supplier_lookup_decision: 'info',
  supplier_lookup_unavailable: 'warning',
  web_query_plan: 'info',
  web_hit_classify: 'info',
  web_hits_refined: 'info',
  shortlist_ranked: 'info',
  // Названные сотрудником поставщики в шорт-листе: только числа итогов по названиям.
  shortlist_named_suppliers: 'info',
  // Этап 141: прежние плановые проверки срока ответа сняты, старые задачи завершаются молча.
  sla_check_retired: 'info',
  bitrix24_user_contact: 'info',
  price_disk_sync: 'info',
  // Тема 4 этапа 151: акционное вложение письма пропущено при индексации.
  price_mail_promo_skipped: 'info',
  price_disk_supplier_failed: 'warning',
  price_disk_ask_recipient_failed: 'warning',
  // Этап 155: координаты цен не сохранены, правка в исходном файле для импорта недоступна.
  price_source_cells_failed: 'warning',
  order_digest_mailbox_not_connected: 'info',
  order_digest_sent: 'info',
  order_mail_index_backfilled: 'info',
  order_reply_legacy_sent_skipped: 'info',
  order_reply_mailbox_not_connected: 'info',
  order_request_text_prepared: 'info',
  order_selection_index_backfilled: 'info',
  price_file_authorship: 'info',
  price_stale_files_opened_redirected: 'info',
  price_file_year_anchor: 'info',
  price_mail_assessment: 'info',
  price_mail_scan: 'info',
  price_stale_content_check: 'info',
  // Без класса в таблице с этапов 120-127: сбои вложений и выгрузки - агент ответил без файла,
  // сбои поиска на сайте - карточка осталась без части данных; итог выбора страниц - событие.
  intake_attachments_failed: 'warning',
  shortlist_xlsx_unavailable: 'warning',
  shortlist_xlsx_failed: 'warning',
  supplier_site_model_failed: 'warning',
  supplier_contacts_search_failed: 'warning',
  site_pages_pick_failed: 'warning',
  site_pages_read_failed: 'warning',
  site_pages_picked: 'info',
  web_enrich_prices: 'info',
  // Этап 216: Telegram-канал как источник шорт-листа. Сбой одного поста или всего источника
  // не ломает ход: остальные источники отработали, поэтому warning, а не serious.
  telegram_post_failed: 'warning',
  telegram_source: 'info',
  telegram_source_unavailable: 'warning',
  telegram_source_failed: 'warning',
};
