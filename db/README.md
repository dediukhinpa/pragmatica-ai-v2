# db: миграции Прагматики v2

Два потока, как в платформе: `platform` (каталог `db/platform` платформы, в этом репозитории
его нет) и `app` (этот проект, каталог `db/app`). Раннер платформы применяет сначала весь
`platform`, затем весь `app`; учёт - таблица `schema_migrations`, версии вида
`app/007_supplier_cards`.

## Файлы

| Путь | Что это |
|------|---------|
| `db/app/*.sql` | предметные миграции (нумерация потока `app`, 001-026) |
| `db/app/legacy-map.tsv` | карта прежних версий (001-042 старого репозитория) в новые |
| `db/legacy-map.tsv` | символьная ссылка на `app/legacy-map.tsv` |
| `db/allowed-schema-diff.txt` | различия схемы с эталоном, которые допустимы, с причинами |
| `tools/check-migrations.test.sh` | быстрый тест целостности карты (без PostgreSQL) |
| `tools/check-migrations.sh` | проверка на временном PostgreSQL: три сценария |

## Как запускать раннер платформы

Раннер ищет карту `legacy-map.tsv` рядом с миграциями проекта, поэтому при
`APP_MIGRATIONS_DIR=db/app` отдельный `APP_LEGACY_MAP` не нужен:

```bash
export DATABASE_URL='postgres://user:pass@host:5432/dbname'
export APP_MIGRATIONS_DIR="$PWD/db/app"
bash <платформа>/db/migrate.sh --plan   # что будет применено и почему, ничего не меняя
bash <платформа>/db/migrate.sh          # применить
```

Карта лежит именно в `db/app/`, а не в `db/`: в compose платформы сервис `migrate` монтирует в
контейнер только каталог миграций проекта (`/app-migrations`) и не передаёт `APP_LEGACY_MAP`,
поэтому карту рядом с миграциями раннер видит и на хосте, и в контейнере. Путь `db/legacy-map.tsv`
оставлен ссылкой для совместимости с манифестом и описанием проекта. Платформа не менялась.
Если нужна карта из другого места, задайте `APP_LEGACY_MAP=<путь>` (только для запуска на хосте).

## Как устроено деление

- Платформенные миграции прежнего репозитория имеют двойников в `db/platform` платформы и
  в `app` не переносятся; карта отображает их на `platform/NNN_имя`.
- Предметные переносятся без смысловых изменений (те же операторы в том же порядке).
- Смешанные делятся: `001_core` (platform/001_core + app/001), `018_supplier_cards`
  (platform/013_agent_pair_notes + app/007), `020_knowledge_fts_query_suppliers_hnsw`
  (platform/015_knowledge_fts_query + app/008). Одна старая версия отображается на две новые.
- `app/026_knowledge_scope_compat` - единственная новая миграция проекта (прообраза нет, в
  карте её нет). Приводит базу знаний прежней схемы (`supplier_id`, `filter_supplier`) к
  платформенной (`scope`, `filter_scope`); на пустой базе ничего не меняет. Подробности - в
  шапке файла и в отчёте этапа.

## Проверка

```bash
bash tools/check-migrations.test.sh   # секунды, PostgreSQL не нужен
bash tools/check-migrations.sh        # временный PostgreSQL в docker, под flock heavy.lock
```

`check-migrations.sh` проверяет: (1) пустая база даёт схему эталона с точностью до
`db/allowed-schema-diff.txt`; (2) база, поднятая прежним раннером, после нового раннера с
картой равна (1), а `--plan` показывает pending только у новых миграций проекта; (3) то же
для схемы с боя (40 миграций), где `--plan` дополнительно показывает 041 и 042. Протокол пишется
в `$WORK/check.log` (по умолчанию `~/reports/business-ai-modular/stage-6/tmp/migr/`).
