# RUNBOOK: бой Прагматики на v2

Для владельца и дежурного. Состояние на 2026-11-17, после переключения (G7 v3): платформа
business-ai 1.1.3, образ app `1.1.3-pragmatika.1`. Разбор переключения —
`~/reports/business-ai-modular/stage-8r/REPORT.md` (сервер Fornex, не в репозитории).

**Патч G8 (этап 8v)** переносит проектные маршруты `/docx/*` в образ документов проекта
(`pragmatika-documents` `1.1.3-pragmatika.2`) и снимает временный обход. Раздел 2 описывает оба
состояния: «патч G8 применён» (штатное) и «патч G8 ещё не применён» (обход). Применяет патч
владелец по `OWNER-RUNBOOK.md` патч-пакета (`patch.sh`); без него бой остаётся на обходе.

**Патч G8w (этап 8w)** ставится строго после G8: обновляет ядро платформы до 1.1.5 (образ app
`1.1.5-pragmatika.1`) и задаёт app две переменные ограничителя частоты Яндекс Поиска
(`YANDEX_SEARCH_MAX_CONCURRENCY=1`, `YANDEX_SEARCH_MIN_INTERVAL_MS=1200`): ответ 429 по частоте
больше не считается исчерпанной квотой. Меняется только app; `documents` остаётся
`1.1.3-pragmatika.2`. Применяет владелец по `OWNER-RUNBOOK.md` пакета (`patch.sh`, исходники
`deploy/patch-8w/`). До G8w бой работает на ядре 1.1.3 и прежнем поведении.

Все операции на боевом хосте `pragmatika-ru` — красная зона: выполняет владелец. Перед любым
изменением боя делать бэкап. Имена на бою неизменны: compose-проект `pragmatika`, тома
`pragmatika_*`, контейнеры `pragmatika-<сервис>-1`, пути `/etc/pragmatika`, `/srv/pragmatika`,
`/opt/pragmatika/local`.

## 1. Где что лежит

| Что | Где |
|---|---|
| Стек v2 | `/opt/pragmatika-v2/{deploy,db}` (`.env` 600, `images.lock`, ссылка на `secrets.env`) |
| Прежнее дерево | `/opt/pragmatika` (скрипты хоста, три юнита systemd, `local/`); не удалять |
| Токен mask | строка `MASK_TOKEN` в `secrets.env` боя |
| Бэкап до переезда | `/root/backups/pragmatika-before-v2-20261117T164258Z`, хранить до 2026-12-01 |
| Журнал переезда | `~/.pragmatika-cutover/run-20261117T164258Z/` |
| Метрики textfile | `/var/lib/pragmatika/metrics` (в Alloy: `/var/lib/agentplatform/metrics`) |

## 2. Как запускать и перезапускать стек

### 2.1. После патча G8 (обход снят): штатное состояние

Сервис `documents` — образ проекта `pragmatika-documents` (`FROM` платформенного `bai-documents`
1.1.3 по digest + проектные маршруты `/docx/*` и LibreOffice для .doc/RTF); app смотрит на
`DOCUMENTS_URL=http://documents:8310`, контейнеров `documents-router` и `documents-legacy` нет.
Стек запускается обычным compose проекта `pragmatika` с теми же env-файлами, что у `cutover.sh`:
порядок `images.lock`, `.env`, `secrets.env`, `secrets.mask.env`, профили из боевого `.env`.
Готовая обёртка остаётся в `hotfix/dc-v2.sh`; ключ `HOTFIX_DOCX=0` отключает обход, поэтому
после патча в `/opt/pragmatika-v2/deploy` пользоваться так:

```bash
cd /opt/pragmatika-v2/deploy
HOTFIX_DOCX=0 bash hotfix/dc-v2.sh ps
HOTFIX_DOCX=0 bash hotfix/dc-v2.sh up -d app          # пересоздать app
HOTFIX_DOCX=0 bash hotfix/dc-v2.sh logs --since 10m app
```

Теперь допустимы `cutover.sh`, `rollback.sh` и `bai update` (с предусловиями раздела 3): обходу
нечего терять. Тег образа `pragmatika-documents:legacy-docx` на хосте НЕ удалять до конца срока
отката патча (он нужен, чтобы вернуть обход).

**Проверка маршрутов (только чтение):** каждый HTTP-маршрут, который вызывает app у соседних
сервисов, не должен отвечать 404/405. Команда из патч-пакета (или `tools/` дерева проекта):

```bash
bash tools/check-routes.sh --stack --project pragmatika --manifest routes.tsv \
  --flags-file tools/route-flags.tsv
```

Пробы идут изнутри сети стека одноразовым контейнером (`--rm`, 128 МиБ), ничего не создаётся и не
меняется; 401/403 без токена печатаются как «существование не проверено». Код 0 — провалов нет,
1 — есть 404/405 или сервис недоступен. Та же проверка встроена в preflight `cutover.sh` (образ
documents до остановки боя) и в проверки после запуска v2 (в живом стеке, провал ведёт к откату),
а образ documents — ещё и в preflight репетиции `rehearse.sh`.

### 2.2. Пока патч G8 не применён: временный обход `/docx/*`

Платформенный сервис документов 1.1.3 не знает проектных маршрутов `/docx/*`
(`replace-signatory`, `party-block`, `classify`, `amend`). Пока маршруты не вошли в образ
документов, рядом работают `documents-legacy` (старый образ, только `/docx/*`) и
`documents-router` (nginx), а app смотрит на `DOCUMENTS_URL=http://documents-router:8310`.

**Любое действие со стеком — только через обёртку:**

```bash
cd /opt/pragmatika-v2/deploy
bash hotfix/dc-v2.sh ps
bash hotfix/dc-v2.sh up -d app          # пересоздать app
bash hotfix/dc-v2.sh logs --since 10m app
```

Обёртка собирает те же `--env-file` (lock, `.env`, `secrets.env`, `secrets.mask.env`), профили из
боевого `.env`, проект `pragmatika` и файл `hotfix/compose.hotfix-docx.yml`.
`HOTFIX_DOCX=0 bash hotfix/dc-v2.sh …` — стек без обхода (после патча G8 это штатный вызов).

**Нельзя** до патча запускать стек голым `docker compose`, `cutover.sh` или `bai update`: обход
потеряется (контейнеры router/legacy будут считаться сиротами, app вернётся на платформенный
documents) и сборка договоров снова упадёт с 404.

Снять обход — только патчем G8 (`patch.sh`): он сверяет подписи, проверяет маршруты образа и
стека, делает смоук сборки договора и сам убирает контейнеры обхода. Вручную снимать обход не
нужно и без проверок не стоит.

### 2.3. Откат патча G8

Автоматически при любом сбое после начала замены (код 1). Вручную, если проблему заметили позже:

```bash
bash patch.sh --rollback [--run-dir ~/.pragmatika-cutover/patch-<время>]
```

Файлы `/opt/pragmatika-v2/deploy` возвращаются из бэкапа `~/backups/pragmatika-patch-<время>`,
поднимается стек с обходом (`documents-legacy`, `documents-router`, app на роутер), проверяются
`/ready` и образы. Эквивалент вручную: вернуть файлы дерева из бэкапа и `bash hotfix/dc-v2.sh
up -d`. БД патч не трогает, откат данных не нужен.

## 3. Как обновлять через `bai`

`bai` (`deploy/bai` платформы, описание — `docs/BAI-CLI.md` business-ai) выкатывает версию по
подписанному `images.lock`: проверяет подписи ВСЕХ образов, делает бэкап, применяет миграции,
поднимает стек, ждёт `/ready`, при сбое после миграций возвращает прежний lock.

**Состояние на 2026-11-17: `bai` на бою не установлен**, `/etc/pragmatika/bai-state` нет.
Переезд сделан скриптом `cutover.sh`. Первый `bai update` не выполнять, пока не выполнены
предусловия ниже; сначала репетиция на Fornex.

### Предусловия

1. **Обход `/docx/*` снят патчем G8** (раздел 2.1). `bai` вызывает `docker compose -f <один
   файл>` и не знает `hotfix/compose.hotfix-docx.yml`; после патча он не нужен. **После патча
   G8 `bai update` снова допустим** (при остальных предусловиях ниже).
2. **Штатный бэкап настроен** (`BACKUP_S3_ENDPOINT`, `BACKUP_S3_BUCKET`,
   `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`, ключ age) и
   `backup.sh --verify` проходит. Иначе шаг бэкапа в `bai update` откажет до любых изменений.
   Сейчас не настроен, `pragmatika_backup.prom` от 2026-11-09.
3. **Один env-файл для compose.** `bai` передаёт compose только lock и `BAI_ENV_FILE`; `cutover.sh`
   передавал ещё `secrets.env` и `secrets.mask.env`. Нужен объединённый файл с переменными `.env`
   и `secrets.env` (права 600, не в репозитории), а `COMPOSE_PROFILES` экспортировать из боевого
   `.env`. Без этого compose не стартует (`MASK_TOKEN`, ключи).
4. **Ключ подписей:** `BAI_PUBKEY` = `cosign.pub` пакета. Образы тянутся из `cr.yandex` (вход
   pull-ключом во временный `DOCKER_CONFIG`, после — `docker logout`) либо загружаются
   `bai load` из архива, собранного `bai bundle` на Fornex.
5. **Начальный lock.** Без `current.lock` `bai` считает установку первой и откатываться ему
   некуда. Положить в `/etc/pragmatika/bai-state/current.lock` копию действующего
   `/opt/pragmatika-v2/deploy/images.lock` (после проверки `bai verify`). Не проверено на бою.
6. Свободно на диске ≥ 8 ГиБ, `available` памяти ≥ 3,5 ГиБ (`free -m`, `df -h /`).

### Процедура

```bash
export BAI_PROJECT=pragmatika
export BAI_COMPOSE_FILE=/opt/pragmatika-v2/deploy/compose.yml
export BAI_ENV_FILE=<объединённый env-файл, 600>
export BAI_EXPECT_BOTS_READY=4
bai verify <версия|lock>     # только подписи, бой не меняется
bai update <версия|lock>     # подписи → pull → бэкап → migrate --plan → migrate → up → /ready
bai status                   # совпадение образов с lock, /ready
```

Если у версии появились новые миграции платформы или проекта, перед `update` сверить
`migrate --plan` на копии боевой БД (репетиция G6) и заранее приготовить `*_down.sql`:
`bai` миграции назад не откатывает (откат данных — только из бэкапа).

Новая версия проекта = новый образ app: `tools/build-app-image.sh` на Fornex (digest, подпись,
trivy), затем новый `images.lock`, пакет и репетиция (`deploy/rehearsal`). Без репетиции на
этих digest на бой не выкатывать.

### Откат после `bai update`

- Сбой до `/ready` — `bai` возвращает прежний lock сам.
- Проблема найдена позже: `bai rollback` (предыдущий lock из `history/`). Миграции назад не
  откатываются; для переезда G7 обратные миграции `021_down.sql`/`026_down.sql` — в пакете
  `stage-8/package` (Fornex), применяет `rollback.sh`.

## 4. Откат переезда G7 на прежний стек

Только решение владельца; срок — до 2026-12-01 и не дольше первой новой миграции после G7.

1. Если патч G8 применён, обход уже снят; если нет — `rollback.sh` сам убирает контейнеры
   обхода `documents-router` и `documents-legacy` (образ и тег `legacy-docx` остаются).
2. `bash rollback.sh` из пакета G7: прежние образы + обратные миграции, данные после хода
   сохраняются.
3. Крайний случай: `bash rollback.sh --restore-db --i-understand-data-loss` — БД и том
   псевдонимизатора на момент до хода, всё записанное после отрезается.

Прежние образы на хосте не удалять (`docker image prune` не запускать) до конца срока отката.

## 5. Проверка здоровья

```bash
HOTFIX_DOCX=0 bash hotfix/dc-v2.sh ps          # все healthy (до патча G8 - без HOTFIX_DOCX=0)
docker stats --no-stream                       # память
docker logs --since 10m pragmatika-app-1 | grep -c '"level":"error"'
docker logs --since 1h pragmatika-documents-1 | grep -c '"status":404'   # должно быть 0
systemctl --failed
```

Ожидаемо после патча G8: 11 контейнеров healthy, `/ready` 200, четыре бота `bitrix24_bot_ready`,
404 у documents нет, `IMAGE_SEND_PHOTO=false` в окружении app, `check-routes.sh` (раздел 2.1) с
кодом 0. До патча: 13 контейнеров (ещё router и legacy обхода).

## 6. Известные хвосты

- `pragmatika-cert-expiry.service` падает с `203/EXEC` с начала ноября: у
  `/opt/pragmatika/deploy/scripts/cert-expiry.sh` нет бита исполнения (`chmod +x`, владелец;
  в git старого репо режим 100644). Пока не исправлено, сроки сертификатов не мониторятся.
- После пересоздания app реестр договоров ~2 мин не читается (холодный кэш хэшей источника файлов).
- Панель «Контейнеры: Есть упавший» держится ~1 ч после хода из-за разовых `pragmatika-app-run-*`.
- «Квота Яндекс Поиска исчерпана» на одиночный 429 — различать частоту и квоту.
- Сумма лимитов памяти контейнеров больше памяти ВМ (15993 МиБ): **16392 МиБ без обхода** (после
  патча G8; было 18440 МиБ с обходом: без `documents-legacy` 2048 и `documents-router` 128 МиБ
  это 16264, плюс alloy 320 → 448 МиБ, +128). Реальное потребление ≈ 2,9 ГиБ. alloy держался около
  80 % прежнего лимита (255 из 320 МиБ), решение владельца 17.11.2026 — лимит 448 МиБ; мягкий
  предел кучи Go (`GOMEMLIMIT` 256MiB, платформа) не менялся.
- `cert-expiry.sh` в дереве v2 нет: скрипт и юнит остаются в прежнем дереве `/opt/pragmatika`,
  режим 755 в git v2 ставить не на что (см. пункт выше про `203/EXEC`).
- Проверка «каждый маршрут, который вызывает app, не отвечает 404» (главный урок G6/G7) теперь
  часть preflight `cutover.sh`, `rehearse.sh` и патча G8 (раздел 2.1).
