# RUNBOOK: бой Прагматики на v2

Для владельца и дежурного. Состояние на 2026-11-17, после переключения (G7 v3): платформа
business-ai 1.1.3, образ app `1.1.3-pragmatika.1`. Разбор переключения —
`~/reports/business-ai-modular/stage-8r/REPORT.md` (сервер Fornex, не в репозитории).

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

## 2. Как запускать и перезапускать стек (временный обход `/docx/*`)

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
`HOTFIX_DOCX=0 bash hotfix/dc-v2.sh …` — стек без обхода (только для снятия обхода и сверки).

**Нельзя** запускать стек голым `docker compose`, `cutover.sh` или `bai update`: обход потеряется
(контейнеры router/legacy будут считаться сиротами, app вернётся на платформенный documents) и
сборка договоров снова упадёт с 404.

Снять обход (когда маршруты `/docx/*` появились в образе документов, образ проверен, новый
app-lock опубликован и прошла репетиция):

```bash
HOTFIX_DOCX=0 bash hotfix/dc-v2.sh up -d app
docker rm -f pragmatika-documents-router-1 pragmatika-documents-legacy-1
```

## 3. Как обновлять через `bai`

`bai` (`deploy/bai` платформы, описание — `docs/BAI-CLI.md` business-ai) выкатывает версию по
подписанному `images.lock`: проверяет подписи ВСЕХ образов, делает бэкап, применяет миграции,
поднимает стек, ждёт `/ready`, при сбое после миграций возвращает прежний lock.

**Состояние на 2026-11-17: `bai` на бою не установлен**, `/etc/pragmatika/bai-state` нет.
Переезд сделан скриптом `cutover.sh`. Первый `bai update` не выполнять, пока не выполнены
предусловия ниже; сначала репетиция на Fornex.

### Предусловия

1. **Обход `/docx/*` снят** (раздел 2). `bai` вызывает `docker compose -f <один файл>`
   и не знает `hotfix/compose.hotfix-docx.yml`.
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

1. Снять обход `/docx/*` (раздел 2, `docker rm -f` двух контейнеров).
2. `bash rollback.sh` из пакета G7: прежние образы + обратные миграции, данные после хода
   сохраняются.
3. Крайний случай: `bash rollback.sh --restore-db --i-understand-data-loss` — БД и том
   псевдонимизатора на момент до хода, всё записанное после отрезается.

Прежние образы на хосте не удалять (`docker image prune` не запускать) до конца срока отката.

## 5. Проверка здоровья

```bash
bash hotfix/dc-v2.sh ps                        # все healthy
docker stats --no-stream                       # память
docker logs --since 10m pragmatika-app-1 | grep -c '"level":"error"'
docker logs --since 1h pragmatika-documents-1 | grep -c '"status":404'   # должно быть 0
systemctl --failed
```

Ожидаемо: 13 контейнеров healthy (11 штатных + router и legacy обхода), `/ready` 200, четыре бота
`bitrix24_bot_ready`, 404 у documents нет, `IMAGE_SEND_PHOTO=false` в окружении app.

## 6. Известные хвосты

- `pragmatika-cert-expiry.service` падает с `203/EXEC` с начала ноября: у
  `/opt/pragmatika/deploy/scripts/cert-expiry.sh` нет бита исполнения (`chmod +x`, владелец;
  в git старого репо режим 100644). Пока не исправлено, сроки сертификатов не мониторятся.
- После пересоздания app реестр договоров ~2 мин не читается (холодный кэш хэшей источника файлов).
- Панель «Контейнеры: Есть упавший» держится ~1 ч после хода из-за разовых `pragmatika-app-run-*`.
- «Квота Яндекс Поиска исчерпана» на одиночный 429 — различать частоту и квоту.
- Сумма лимитов памяти контейнеров (18440 МиБ с обходом) больше памяти ВМ (15993 МиБ);
  реальное потребление ≈ 2,9 ГиБ. alloy держится около 80 % своего лимита (320 МиБ).
- Правильный фикс `/docx/*`: маршруты в образ документов проекта, новый app-lock, репетиция,
  проверка «каждый маршрут, который вызывает app, не отвечает 404» в preflight и репетиции.
