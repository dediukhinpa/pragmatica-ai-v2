# config/: настройка сервисов платформы и правила доступа

Здесь лежат только **нейтральные образцы** (`*.example`). Боевые словари и значения заказчика
(имена людей, реквизиты, слова-исключения, настоящие id сотрудников и отделов) в репозиторий
не попадают: они живут на сервере и не входят в сборку.

Сервисы платформы (`pseudonymizer`, `mask`, `documents`, `embeddings`, `indexer`) не содержат
предметных данных проекта. Предметное приходит через каталог `/config` внутри контейнера
(только чтение). На хосте это `BAI_CONFIG_HOST_DIR`, по умолчанию `/etc/pragmatika/config`
(`deploy/compose.project.yml`). Правила чтения (`docs/SERVICE-CONFIG*.md` платформы):

- непустая переменная окружения сильнее файла из `/config`, файл сильнее встроенного значения;
- нет каталога или файла — норма, действует встроенное значение;
- файл с ошибкой формата — сервис не стартует (код 78 у `documents`/`embeddings`/`indexer`,
  1 у `pseudonymizer`/`mask`), значения в журнал не попадают;
- файл подхватывается перезапуском сервиса.

## Что где лежит

| Образец в репозитории | Боевой файл на сервере | Сервис | Что задаёт |
|---|---|---|---|
| `access-policy.example.json` | `/etc/pragmatika/access/access-policy.json` | `app` | кто какого бота и какие действия получает; `ACCESS_POLICY_FILE` в `.env` — путь внутри контейнера |
| `pii-allowed-words.txt.example` | `/etc/pragmatika/config/pii-allowed-words.txt` | `pseudonymizer`, `mask` | слова-исключения (название проекта, торговая марка); либо переменная `PII_ALLOWED_WORDS` |
| `contacts.txt.example` | `/etc/pragmatika/contacts.txt` | `pseudonymizer` | точный словарь имён контактов; монтируется отдельным файлом (`PSEUDONYMIZER_CONTACTS_HOST_FILE`) |
| `currencies.json.example` | `/etc/pragmatika/config/currencies.json` | `documents` | список валют для признака валюты в ячейках; заменяет встроенный |
| `render-false-values.json.example` | `/etc/pragmatika/config/render-false-values.json` | `documents` | значения, которые условные блоки `/render` считают ложью |
| `documents.json.example` | `/etc/pragmatika/config/documents.json` | `documents` | режимы сервиса (дробь без неоднозначности, правка ячеек, шаблоны xlsx) и лимиты |
| `template-rules.json.example` | `/etc/pragmatika/config/template-rules.json` | `documents` | правила шапки шаблона таблицы для `/xlsx/*` |
| `entity-folders.json.example` | `/etc/pragmatika/config/entity-folders.json` | `indexer` | привязка файлов к карточкам поставщиков по имени папки и заметки поставщиков |

Для `documents` режимы из `documents.json` продублированы переменными в
`deploy/compose.project.yml` (`DOCUMENTS_EDIT_ENDPOINTS`, `DOCUMENTS_TEMPLATE_ENDPOINTS`,
`DOCUMENTS_UNAMBIGUOUS_FRACTIONS`, по умолчанию `true`): прежний сервис держал их включёнными
всегда. Лимиты `documents`/`indexer`, заданные в compose непустыми значениями, сильнее файла.

## Чего здесь нет

- **Шаблоны ПДн** (телефоны, почты, ИНН, карты и т.п.) живут в вендоренной библиотеке
  `labops-pii` внутри образов платформы и через `/config` не настраиваются. Настраиваются только
  слова-исключения и словарь контактов (таблица выше).
- **Файлы шлюза** (`search-allowed-models.txt`, `vision-allowed-models.txt`,
  `webpage-allowed-models.txt`, `pii-guard-*.txt`) относятся к `pii-guard` на сервере шлюза;
  этот репозиторий их не разворачивает.
- **Файл ящиков почты** (`mailboxes.json`: логины и пароли приложений) лежит в
  `/etc/pragmatika/mail/`, образец формата — в документации платформы
  (`deploy/mailboxes.example.json`), значений в репозитории нет.
- **Шаблоны документов и прайсы** лежат на SMB-шаре (`/srv/pragmatika/documents`) и в
  `/opt/pragmatika/local` (локальные шаблоны и правила доступа, смонтированы в `app` только для
  чтения как `/opt/pragmatika/local`).

## Образец политики доступа

`access-policy.example.json` содержит все действия доступа, которые знает ядро
(`chat.message`, `chat.file`, `chat.button`, `documents.update_own_requisites`,
`mail.send_draft`, `orders.confirm_selection`, `orders.route_mail`, `prices.confirm_jump`,
`site.confirm_publish`, `suppliers.confirm_card`, `suppliers.export`). Идентификаторы в нём
условные (`employee-id-1`, отделы `12`/`15`/`40`, группы `7`/`9`). Боты — по идентификаторам
агентов: `documents`, `prices`, `order-calc`, `site-export`. Файл без бота — «запрещено всем»;
битый файл — ядро не стартует. Права на `suppliers.confirm_card` и `suppliers.export` ядро
дополнительно проверяет по руководителям отделов портала (см. `ACCESS_EXTRA_HEAD_USER_IDS` в
`deploy/.env.example`).

## Как развернуть на сервере

```bash
sudo install -d -m 755 /etc/pragmatika/config /etc/pragmatika/access /etc/pragmatika/mail
sudo install -m 644 config/access-policy.example.json /etc/pragmatika/access/access-policy.json
sudoedit /etc/pragmatika/access/access-policy.json     # подставить реальные id
sudo install -m 644 config/template-rules.json.example /etc/pragmatika/config/template-rules.json
# остальные файлы из таблицы — по необходимости; права: каталог 0755, файлы 0644 (uid сервисов
# 10001 должен их читать), контакты и ящики — 0640 с группой 10001/1000.
```

Перед копированием сверить образец с боевым поведением: значения в `template-rules.json.example`
(`header_row: 11`, заголовки «название» и «артикул») и `entity-folders.json.example` взяты из
констант прежнего кода сервисов `documents` и `indexer`.
