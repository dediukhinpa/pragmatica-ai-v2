#!/usr/bin/env bash
# Тест deploy/patch-9s/enable-flags.sh (необязательный шаг после патча G9s: настройки хранения
# файлов чата CHAT_ATTACHMENTS_STORE_ENABLED, CHAT_ATTACHMENTS_RETENTION_DAYS и
# CHAT_ATTACHMENTS_MAX_BYTES в боевом .env и пересоздание только app; после патча хранение
# включено по умолчанию) без настоящего Docker: вместо docker - заглушка с памятью о контейнерах и
# окружении app, которое она собирает из .env дерева (нет ключа - умолчание compose). Проверяются
# отказы (код 3, .env не тронут), --dry-run, успех (бэкап .env, правка только названных ключей,
# права, пересоздание только app, значения в окружении app), возврат умолчаний, границы значений,
# автооткат при сбое (код 1, .env побайтно прежний), невозможный откат (код 4), ручной --rollback
# (бэкап без ключей - у app снова умолчания), секреты (не попадают в вывод и архив), неверный вызов
# и стиль (том приёма скрипт не открывает: ни одного docker exec).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SRC="$ROOT/deploy/patch-9s/enable-flags.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP:?}"' EXIT
PASS=0
FAIL=0
LIMIT=100
EXIT_FAILED=1
EXIT_USAGE=2
EXIT_REFUSED=3
EXIT_STUCK=4
LOCK_VERSION="1.1.10-pragmatika.2"
PREV_LOCK_VERSION="1.1.10-pragmatika.1"
# Три переменные патча и их умолчания compose.
V_STORE="CHAT_ATTACHMENTS_STORE_ENABLED"
V_DAYS="CHAT_ATTACHMENTS_RETENTION_DAYS"
V_BYTES="CHAT_ATTACHMENTS_MAX_BYTES"
DEF_DAYS="30"
DEF_BYTES="3221225472"
# Значения «не по умолчанию», на которых заглушка может сломаться.
NEW_DAYS="7"
NEW_BYTES="5242880"
# Строки .env с переменными патча (для сравнения «остальное побайтно прежнее»).
FLAGS_LINE_RE="^(${V_STORE}|${V_DAYS}|${V_BYTES})="
H_APP="2222222222222222222222222222222222222222222222222222222222222222"
H_DOCS="5555555555555555555555555555555555555555555555555555555555555555"
APP_IMG="r/app@sha256:$H_APP"
DOCS_IMG="r/pragmatika-documents@sha256:$H_DOCS"
SECRET="env-secret-token-0123456789"
MUTATING_RE='^(create|rm|stop|kill|start|restart|load|pull|volume|network|compose .*up)'

ok() { PASS=$((PASS + 1)); echo "PASS $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL $1"; }
assert() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

# --- Заглушка docker ---------------------------------------------------------------------------
BIN="$TMP/bin"
mkdir -p "$BIN"
cat >"$BIN/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$DOCKER_LOG"
envfile="$(printf '%s\n' "$@" | grep -m1 '/\.env$' || true)"
dotenv_value() { # dotenv_value <ИМЯ> <умолчание>: значение из .env дерева (нет ключа - умолчание)
  local v
  v="$(sed -n "s/^$1=//p" "$envfile" 2>/dev/null | tail -1)"
  echo "${v:-$2}"
}
STORE=CHAT_ATTACHMENTS_STORE_ENABLED
DAYS=CHAT_ATTACHMENTS_RETENTION_DAYS
BYTES=CHAT_ATTACHMENTS_MAX_BYTES
CHANGED_RE='^CHAT_ATTACHMENTS_(STORE_ENABLED=false|RETENTION_DAYS=7|MAX_BYTES=5242880)$'
changed_in_app() { grep -qE "$CHANGED_RE" "$STUB/env/p-app-1"; }
case "$1" in
  compose)
    case " $* " in
      *" config "*"--format json"*)
        printf '{"services":{"app":{"environment":{'
        printf '"%s":"%s","%s":%s,"%s":"%s"}}}}\n' \
          "$STORE" "$(dotenv_value "$STORE" true)" \
          "$DAYS" "$(dotenv_value "$DAYS" 30)" \
          "$BYTES" "$(dotenv_value "$BYTES" 3221225472)" ;;
      *" up "*)
        touch "$STUB/started-any"
        [[ "${*: -1}" == app ]] || { touch "$STUB/other-up"; exit 0; }
        if [[ "${STUB_UP_FAIL_ON_CHANGED:-0}" == 1 ]] && grep -qE "$CHANGED_RE" "$envfile"; then
          echo "compose: ошибка up" >&2
          exit 1
        fi
        n="$(cat "$STUB/counter" 2>/dev/null || echo 0)"
        echo $((n + 1)) >"$STUB/counter"
        printf '2026-11-22T10:00:%02dZ\n' "$((n + 1))" >"$STUB/started/p-app-1"
        {
          echo "PATH=/usr/bin"
          echo "OPENAI_API_KEY=$SECRET"
          echo "INTAKE_ROOT=/var/lib/pragmatika/intake"
          echo "$STORE=$(dotenv_value "$STORE" true)"
          if [[ "${STUB_APP_IGNORES_DAYS:-0}" == 1 ]]; then
            echo "$DAYS=30"
          else
            echo "$DAYS=$(dotenv_value "$DAYS" 30)"
          fi
          echo "$BYTES=$(dotenv_value "$BYTES" 3221225472)"
        } >"$STUB/env/p-app-1"
        if [[ "${STUB_DOCS_RESTART:-0}" == 1 ]]; then
          echo "2026-11-22T11:00:00Z" >"$STUB/started/p-documents-1"
        fi ;;
    esac ;;
  ps)
    if [[ "$*" == *"name=^"* ]]; then echo abc123; exit 0; fi
    svc="$(printf '%s\n' "$@" | sed -n 's/^label=com.docker.compose.service=//p')"
    [[ -z "$svc" ]] || echo "p-$svc-1" ;;
  inspect)
    name="${*: -1}"
    case "$*" in
      *"range .Config.Env"*) cat "$STUB/env/$name" ;;
      *"State.StartedAt"*) cat "$STUB/started/$name" ;;
      *"RestartCount"*) echo 0 ;;
      *"{{.Config.Image}}"*) [[ "$name" == p-app-1 ]] && echo "$APP_IMG" || echo "$DOCS_IMG" ;;
      *"{{.Image}}"*) [[ "$name" == p-app-1 ]] && echo "sha256:id-app" || echo "sha256:id-docs" ;;
      *"State.Health"*) echo healthy ;;
    esac ;;
  image)
    if [[ "$2" == inspect && "$*" == *"{{.Id}}"* ]]; then
      [[ "${*: -1}" == "$APP_IMG" ]] && echo "sha256:id-app" || echo "sha256:id-docs"
    fi ;;
  run)
    if [[ "$*" == *"bun"* ]]; then
      [[ "${STUB_NO_READY:-0}" != 1 ]] || { echo "app недоступен"; exit 1; }
      if [[ "${STUB_STUCK:-0}" == 1 && -e "$STUB/started-any" ]]; then
        echo "app недоступен"; exit 1
      fi
      if [[ "${STUB_READY_500_ON_CHANGED:-0}" == 1 ]] && changed_in_app; then
        echo '500 {"bots":{"ready":0}}'; exit 1
      fi
      echo "200 {\"bots\":{\"ready\":4}}"
    fi ;;
  exec) echo "docker exec не нужен" >&2; exit 99 ;;
esac
exit 0
STUB
chmod +x "$BIN/docker"

# --- Боевое дерево (после G9s) -----------------------------------------------------------------
LIVE_ROOT="$TMP/opt/pragmatika-v2"
LIVE="$LIVE_ROOT/deploy"
write_env() { # write_env <с карточками: 0|1> [без перевода строки в конце: 1]
  {
    printf 'POSTGRES_USER=pragmatika\n# комментарий про %s остаётся\n' "$V_STORE"
    printf 'OPENAI_API_KEY=%s\n' "$SECRET"
    (($1)) && printf 'SUPPLIER_CARDS_ENABLED=true\n' || printf 'SUPPLIER_CARDS_ENABLED=false\n'
    printf '%s=true\n' "$V_STORE"
    if [[ "${2:-0}" == 1 ]]; then printf 'LAST=1'; else printf 'LAST=1\n'; fi
  } >"$LIVE/.env"
  chmod 600 "$LIVE/.env"
}
write_app_env() { # write_app_env: окружение app после патча (все три переменные, умолчания)
  {
    echo "PATH=/usr/bin"
    echo "OPENAI_API_KEY=$SECRET"
    echo "INTAKE_ROOT=/var/lib/pragmatika/intake"
    echo "$V_STORE=true"
    echo "$V_DAYS=$DEF_DAYS"
    echo "$V_BYTES=$DEF_BYTES"
  } >"$STUB/env/p-app-1"
}
reset_stand() { # reset_stand [с карточками: 0|1] [без перевода строки: 1]
  STUB="$TMP/stub"
  rm -rf "${STUB:?}" "${LIVE_ROOT:?}"
  mkdir -p "$STUB/env" "$STUB/started" "$LIVE"
  echo "services: {}" >"$LIVE/compose.yml"
  printf 'BAI_VERSION=%s\nBAI_IMAGE_APP=%s\nBAI_IMAGE_DOCUMENTS=%s\n' "$LOCK_VERSION" "$APP_IMG" \
    "$DOCS_IMG" >"$LIVE/images.lock"
  date -u +%FT%TZ >"$LIVE/.cutover-deployed"
  write_env "${1:-1}" "${2:-0}"
  echo "2026-11-20T08:00:00Z" >"$STUB/started/p-app-1"
  echo "2026-11-18T08:00:00Z" >"$STUB/started/p-documents-1"
  write_app_env
  echo "PATH=/usr/bin" >"$STUB/env/p-documents-1"
}
tree_snapshot() { (cd "$LIVE" && find . -type f | sort | xargs -d '\n' sha256sum \
  && find . -type f -printf '%m %p\n' | sort); }

run() { # run <имя> [аргументы]: код в RC, вывод в $TMP/out-<имя>; HOME общий T_HOME или по имени
  local name="$1" home="${T_HOME:-$1}"
  shift
  : >"$TMP/docker-$name.log"
  mkdir -p "$TMP/home-$home"
  RC=0
  env HOME="$TMP/home-$home" PATH="$BIN:$PATH" DOCKER_LOG="$TMP/docker-$name.log" STUB="$STUB" \
    APP_IMG="$APP_IMG" DOCS_IMG="$DOCS_IMG" SECRET="$SECRET" CUTOVER_NEW_DIR="$LIVE_ROOT" \
    CUTOVER_PROJECT=p CUTOVER_APP_CONTAINER=p-app-1 CUTOVER_ENV_FILE="$TMP/none.env" \
    CUTOVER_READY_WAIT_S=3 CUTOVER_POLL_S=1 CUTOVER_HEALTH_WAIT_S=3 FLAGS9S_SOAK_POLL_S=1 \
    bash "$SRC" --soak-seconds 2 "$@" >"$TMP/out-$name" 2>&1 || RC=$?
}
no_mutation() { ! grep -E "$MUTATING_RE" "$TMP/docker-$1.log" | grep -qv '^compose version'; }
out_has() { grep -q -- "$2" "$TMP/out-$1"; }
app_up_count() { grep -cE '^compose .* up -d --no-deps app$' "$TMP/docker-$1.log" || true; }
env_is() { grep -qx "$1" "$LIVE/.env"; }
app_has() { grep -qx "$1" "$STUB/env/p-app-1"; }
refuse_case() { # refuse_case <имя> <описание>: код 3, .env и дерево не тронуты, ни одного up
  assert "$2: код 3" "[[ $RC -eq $EXIT_REFUSED ]]"
  assert "$2: дерево (в том числе .env) не тронуто, up не было" \
    "no_mutation $1 && [[ \"\$(tree_snapshot)\" == \"\$T0\" ]]"
}

assert "enable-flags.sh на месте" "[[ -f '$SRC' ]]"
reset_stand 1
T0="$(tree_snapshot)"

# 1. Отказы по предусловиям.
sed -i "s|^BAI_VERSION=.*|BAI_VERSION=$PREV_LOCK_VERSION|" "$LIVE/images.lock"
T0="$(tree_snapshot)"
run notg9s --store false
refuse_case notg9s "G9s не применён (lock .1, стоит только G9r)"
assert "G9s не применён: сообщение «сначала примените патч G9s»" \
  "out_has notg9s 'сначала примените патч G9s'"
assert "G9s не применён: сообщение называет нужную версию" "out_has notg9s '$LOCK_VERSION'"
reset_stand 1
sed -i "s|^BAI_VERSION=.*|BAI_VERSION=1.1.10-pragmatika.3|" "$LIVE/images.lock"
T0="$(tree_snapshot)"
run laterver --store false
refuse_case laterver "версия lock не G9s (.3)"
reset_stand 1
sed -i "s|^BAI_IMAGE_APP=.*|BAI_IMAGE_APP=r/app@sha256:other|" "$LIVE/images.lock"
T0="$(tree_snapshot)"
run appimage --store false
refuse_case appimage "app не на образе из lock боя"
for var in "$V_STORE" "$V_DAYS" "$V_BYTES"; do
  reset_stand 1
  sed -i "/^$var=/d" "$STUB/env/p-app-1"
  T0="$(tree_snapshot)"
  run "novar-$var" --store false
  refuse_case "novar-$var" "в окружении app нет $var (патч G9s не катился)"
  assert "нет переменной: сообщение называет $var" "out_has 'novar-$var' '$var'"
done
reset_stand 1
rm -f "$LIVE/.env"
T0="$(tree_snapshot)"
run noenv --store false
refuse_case noenv "нет .env"
reset_stand 1
T0="$(tree_snapshot)"
STUB_NO_READY=1 run noready --store false
refuse_case noready "app нездоров (/ready)"
rm -f "$LIVE/.cutover-deployed"
T0="$(tree_snapshot)"
run nomark --store false
refuse_case nomark "дерево создано не cutover.sh"

# 2. --dry-run.
reset_stand 1
T0="$(tree_snapshot)"
run dry --store true --retention-days 14 --max-bytes 10485760 --dry-run
assert "--dry-run: код 0" "[[ $RC -eq 0 ]]"
assert "--dry-run: .env и дерево не тронуты, up не было, бэкапа нет" \
  "no_mutation dry && [[ \"\$(tree_snapshot)\" == \"\$T0\" ]] \
   && ! compgen -G '$TMP/home-dry/backups/*'"
assert "--dry-run: в журнале три переменные с будущими значениями" \
  "out_has dry '$V_DAYS=14' && out_has dry '$V_BYTES=10485760' && out_has dry '$V_STORE=true'"

# 3. Успех: сменить все три значения.
reset_stand 1
T0="$(tree_snapshot)"
cp -p "$LIVE/.env" "$TMP/env-before"
L0="$(cd "$LIVE" && sha256sum compose.yml images.lock .cutover-deployed)"
run all3 --store false --retention-days "$NEW_DAYS" --max-bytes "$NEW_BYTES"
assert "успех: код 0" "[[ $RC -eq 0 ]]"
assert "успех: в .env $V_STORE=false (заменена существующая строка)" \
  "env_is '$V_STORE=false' && [[ \$(grep -c '^$V_STORE=' '$LIVE/.env') -eq 1 ]]"
assert "успех: в .env сроки и предел (строки дописаны)" \
  "env_is '$V_DAYS=$NEW_DAYS' && env_is '$V_BYTES=$NEW_BYTES'"
assert "успех: остальные строки .env побайтно прежние (секреты, комментарий, карточки)" \
  "[[ \"\$(grep -v -E '$FLAGS_LINE_RE' '$LIVE/.env')\" \
     == \"\$(grep -v -E '$FLAGS_LINE_RE' '$TMP/env-before')\" ]]"
assert "успех: права .env прежние (600)" "[[ \$(stat -c %a '$LIVE/.env') == 600 ]]"
assert "успех: бэкап .env равен прежнему, права 600, каталог 700" \
  "cmp -s '$TMP/env-before' '$TMP'/home-all3/backups/pragmatika-flags9s-*/.env \
   && [[ \$(stat -c %a '$TMP'/home-all3/backups/pragmatika-flags9s-*/.env) == 600 ]] \
   && [[ \$(stat -c %a '$TMP'/home-all3/backups/pragmatika-flags9s-*) == 700 ]]"
assert "успех: app пересоздан один раз, только он (--no-deps)" \
  "[[ \$(app_up_count all3) -eq 1 ]] && [[ ! -e '$STUB/other-up' ]]"
assert "успех: БЕЗ down, --remove-orphans, --force-recreate, documents не тронут" \
  "! grep -E ' (down|--remove-orphans|--force-recreate)( |\$)' '$TMP/docker-all3.log' \
   && [[ \$(cat '$STUB/started/p-documents-1') == 2026-11-18T08:00:00Z ]]"
assert "успех: в окружении app все три значения новые" \
  "app_has '$V_STORE=false' && app_has '$V_DAYS=$NEW_DAYS' && app_has '$V_BYTES=$NEW_BYTES'"
assert "успех: другие файлы дерева (compose.yml, lock, метка выкатки) не тронуты" \
  "[[ \"\$(cd '$LIVE' && sha256sum compose.yml images.lock .cutover-deployed)\" == \"\$L0\" ]]"
mkdir -p "$TMP/arch"
tar -C "$TMP/arch" -xzf "$(compgen -G "$TMP/home-all3/flags9s-*.tgz" | head -1)"
assert "успех: секреты не попали в вывод, каталог запуска (кроме бэкапа .env) и архив" \
  "! grep -rq '$SECRET' '$TMP/out-all3' '$TMP/home-all3/.pragmatika-cutover' '$TMP/arch'"
assert "успех: в каталоге запуска нет копий .env (секреты лежат только в бэкапе)" \
  "! find '$TMP/home-all3/.pragmatika-cutover' -name 'env*' | grep -q ."
assert "успех: журнал называет три переменные и значения" \
  "out_has all3 '$V_STORE=false' && out_has all3 '$V_DAYS=$NEW_DAYS' \
   && out_has all3 '$V_BYTES=$NEW_BYTES'"
assert "успех: в журнале нет пути тома приёма и имени каталога архива" \
  "! grep -q 'chat-attachments\|/var/lib/pragmatika' '$TMP/out-all3'"
assert "успех: ни одного docker exec (том приёма не открывается)" \
  "! grep -q '^exec ' '$TMP/docker-all3.log'"

# Вернуть умолчания (после смены): значения умолчаний, .env правится только на трёх ключах.
T_HOME=all3 run back --store true --retention-days "$DEF_DAYS" --max-bytes "$DEF_BYTES"
assert "возврат умолчаний: код 0, в .env три строки с умолчаниями" \
  "[[ $RC -eq 0 ]] && env_is '$V_STORE=true' && env_is '$V_DAYS=$DEF_DAYS' \
   && env_is '$V_BYTES=$DEF_BYTES'"
assert "возврат умолчаний: в окружении app умолчания, пересоздан только app" \
  "app_has '$V_STORE=true' && app_has '$V_DAYS=$DEF_DAYS' && app_has '$V_BYTES=$DEF_BYTES' \
   && [[ ! -e '$STUB/other-up' ]]"

# Одна переменная за раз: остальные ключи в .env не появляются, у app остаются умолчания.
reset_stand 1
run onlydays --retention-days 14
assert "только --retention-days: код 0, в .env только срок (ключей предела нет)" \
  "[[ $RC -eq 0 ]] && env_is '$V_DAYS=14' && ! grep -q '^$V_BYTES' '$LIVE/.env' \
   && app_has '$V_DAYS=14' && app_has '$V_BYTES=$DEF_BYTES' && app_has '$V_STORE=true'"
reset_stand 1
run onlybytes --max-bytes 10485760
assert "только --max-bytes: код 0, в .env только предел, срок у app прежний" \
  "[[ $RC -eq 0 ]] && env_is '$V_BYTES=10485760' && ! grep -q '^$V_DAYS' '$LIVE/.env' \
   && app_has '$V_BYTES=10485760' && app_has '$V_DAYS=$DEF_DAYS'"
reset_stand 1
run onlystore --store FALSE
assert "только --store (регистр не важен): в .env false, прочие ключи не тронуты" \
  "[[ $RC -eq 0 ]] && env_is '$V_STORE=false' && ! grep -q '^$V_DAYS' '$LIVE/.env' \
   && app_has '$V_STORE=false'"
# Ведущие нули снимаются: 007 -> 7.
reset_stand 1
run zeros --retention-days 007
assert "--retention-days 007: в .env записано 7 (без ведущих нулей)" \
  "[[ $RC -eq 0 ]] && env_is '$V_DAYS=7' && app_has '$V_DAYS=7'"
# Границы: 1 и 365 допустимы.
reset_stand 1
run day1 --retention-days 1
assert "--retention-days 1 (нижняя граница): код 0" "[[ $RC -eq 0 ]] && env_is '$V_DAYS=1'"
reset_stand 1
run day365 --retention-days 365
assert "--retention-days 365 (верхняя граница): код 0" "[[ $RC -eq 0 ]] && env_is '$V_DAYS=365'"
# .env без перевода строки в конце и без ключей: строки дописываются с переводом строки.
reset_stand 0 1
sed -i "/^$V_STORE=/d" "$LIVE/.env"
run nonl --retention-days 14 --max-bytes 2097152
assert "при .env без перевода строки в конце: код 0, обе строки дописаны на новых строках" \
  "[[ $RC -eq 0 ]] \
   && [[ \"\$(tail -n 3 '$LIVE/.env')\" == \$'LAST=1\n$V_DAYS=14\n$V_BYTES=2097152' ]]"

# 4. Сбои после правки: автооткат, .env побайтно прежний.
rollback_case() { # rollback_case <имя> <описание>
  assert "$2: код 1 (откат выполнен)" "[[ $RC -eq $EXIT_FAILED ]]"
  assert "$2: .env побайтно прежний (откат из бэкапа)" "[[ \"\$(tree_snapshot)\" == \"\$T0\" ]]"
  assert "$2: автооткат запущен и выполнен" \
    "out_has $1 'автоматический откат' && out_has $1 'ОТКАТ ВЫПОЛНЕН'"
  assert "$2: app на прежних значениях (умолчания)" \
    "app_has '$V_STORE=true' && app_has '$V_DAYS=$DEF_DAYS' && app_has '$V_BYTES=$DEF_BYTES'"
  assert "$2: пересоздавался только app (замена и откат)" \
    "[[ \$(app_up_count $1) -eq 2 && ! -e '$STUB/other-up' ]]"
}
reset_stand 1
T0="$(tree_snapshot)"
STUB_UP_FAIL_ON_CHANGED=1 run upfail --store false --retention-days "$NEW_DAYS"
rollback_case upfail "compose up app не удался с новыми значениями"
reset_stand 1
T0="$(tree_snapshot)"
STUB_READY_500_ON_CHANGED=1 run ready500 --max-bytes "$NEW_BYTES"
rollback_case ready500 "/ready 500 после смены предела"
reset_stand 1
T0="$(tree_snapshot)"
STUB_APP_IGNORES_DAYS=1 run ignores --retention-days "$NEW_DAYS"
rollback_case ignores "в окружении app значение срока не совпало"
reset_stand 1
T0="$(tree_snapshot)"
STUB_DOCS_RESTART=1 run docsrestart --store false
assert "documents перезапущен: код 1 и откат" "[[ $RC -eq $EXIT_FAILED ]]"
assert "documents перезапущен: .env прежний" "[[ \"\$(tree_snapshot)\" == \"\$T0\" ]]"
reset_stand 1
T0="$(tree_snapshot)"
STUB_UP_FAIL_ON_CHANGED=1 STUB_STUCK=1 run stuck --store false
assert "откат не удался: код 4" "[[ $RC -eq $EXIT_STUCK ]]"
assert "откат не удался: .env всё равно возвращён из бэкапа" \
  "[[ \"\$(tree_snapshot)\" == \"\$T0\" ]]"
assert "откат не удался: сообщение о ручном вмешательстве" "out_has stuck 'ОТКАТ НЕ УДАЛСЯ'"

# 5. Ручной откат: --rollback по последнему бэкапу и по --backup. В бэкапе нет ключей срока и
# предела: после отката значения у app - умолчания compose.
reset_stand 1
T0="$(tree_snapshot)"
run man_apply --store false --retention-days "$NEW_DAYS" --max-bytes "$NEW_BYTES"
assert "ручной откат: исходный запуск успешен" "[[ $RC -eq 0 ]]"
T_HOME=man_apply run man_rollback --rollback
assert "ручной откат: код 0" "[[ $RC -eq 0 ]]"
assert "ручной откат: .env побайтно прежний" "[[ \"\$(tree_snapshot)\" == \"\$T0\" ]]"
assert "ручной откат: у app умолчания (в бэкапе нет ключей), пересоздан только app" \
  "app_has '$V_STORE=true' && app_has '$V_DAYS=$DEF_DAYS' && app_has '$V_BYTES=$DEF_BYTES' \
   && [[ ! -e '$STUB/other-up' ]]"
bk="$(compgen -G "$TMP/home-man_apply/backups/pragmatika-flags9s-*/.env" | head -1)"
reset_stand 1
run man_apply2 --retention-days 14
T_HOME=man_apply2 run man_rollback2 --rollback --backup "$bk"
assert "откат по --backup ФАЙЛ: код 0 и .env из этого файла" \
  "[[ $RC -eq 0 ]] && cmp -s '$bk' '$LIVE/.env'"
# Бэкап с явными значениями: после отката у app они же (значения из бэкапа).
reset_stand 1
printf '%s=false\n%s=14\n%s=10485760\n' "$V_STORE" "$V_DAYS" "$V_BYTES" >>"$LIVE/.env"
T0="$(tree_snapshot)"
run keep --store true --retention-days 90
T_HOME=keep run keep_rb --rollback
assert "ручной откат: бэкап с явными значениями возвращает их у app" \
  "[[ $RC -eq 0 ]] && [[ \"\$(tree_snapshot)\" == \"\$T0\" ]] \
   && app_has '$V_STORE=false' && app_has '$V_DAYS=14' && app_has '$V_BYTES=10485760'"
reset_stand 1
run norb --rollback
assert "--rollback без бэкапа - код 2" "[[ $RC -eq $EXIT_USAGE ]]"

# 6. Неверный вызов.
run noargs
assert "без аргументов - код 2" "[[ $RC -eq $EXIT_USAGE ]]"
run badval --store yes
assert "--store не true/false - код 2" "[[ $RC -eq $EXIT_USAGE ]]"
for val in 0 366 abc -5 1.5 "" 9999; do
  run "days-$val" --retention-days "$val"
  assert "--retention-days '$val' вне 1..365 - код 2" "[[ $RC -eq $EXIT_USAGE ]]"
done
for val in 0 1048575 abc -1 12.5 1234567890123456789 1000000000000000000; do
  run "bytes-$val" --max-bytes "$val"
  assert "--max-bytes '$val' вне допустимых - код 2" "[[ $RC -eq $EXIT_USAGE ]]"
done
run bytes_min --max-bytes 1048576 --dry-run
assert "--max-bytes 1048576 (нижняя граница) допустим: код 0 на --dry-run" "[[ $RC -eq 0 ]]"
run bytes_max --max-bytes 999999999999999999 --dry-run
assert "--max-bytes из 18 цифр допустим: код 0 на --dry-run" "[[ $RC -eq 0 ]]"
run nodays --retention-days
assert "--retention-days без значения - код 2" "[[ $RC -eq $EXIT_USAGE ]]"
run nostore --store
assert "--store без значения - код 2" "[[ $RC -eq $EXIT_USAGE ]]"
run rbflags --rollback --store true
assert "--rollback с --store - код 2" "[[ $RC -eq $EXIT_USAGE ]]"
run rbdays --rollback --retention-days 10
assert "--rollback с --retention-days - код 2" "[[ $RC -eq $EXIT_USAGE ]]"
run rbbytes --rollback --max-bytes 2097152
assert "--rollback с --max-bytes - код 2" "[[ $RC -eq $EXIT_USAGE ]]"
run rbdry --rollback --dry-run
assert "--rollback с --dry-run - код 2" "[[ $RC -eq $EXIT_USAGE ]]"
run bkonly --store true --backup "$TMP/x"
assert "--backup без --rollback - код 2" "[[ $RC -eq $EXIT_USAGE ]]"
run unknownarg --nonsense
assert "неизвестный аргумент - код 2" "[[ $RC -eq $EXIT_USAGE ]]"
run oldflag --once-per-turn true
assert "флаги прежних патчей (--once-per-turn) не принимаются - код 2" "[[ $RC -eq $EXIT_USAGE ]]"
run badsoak --store true --soak-seconds abc
assert "--soak-seconds не число - код 2" "[[ $RC -eq $EXIT_USAGE ]]"
run helpout --help
assert "--help - код 0 и описание трёх переменных" \
  "[[ $RC -eq 0 ]] && out_has helpout '$V_STORE' && out_has helpout '$V_DAYS' \
   && out_has helpout '$V_BYTES'"
assert "неверный вызов: ни одного up" \
  "no_mutation noargs && no_mutation badval && no_mutation days-0 && no_mutation bytes-0"

# 7. Стиль и безопасность сценария.
assert "строки скрипта до $LIMIT знаков" "! LC_ALL=C.UTF-8 awk 'length > $LIMIT' '$SRC' | grep -q ."
assert "строки теста до $LIMIT знаков" "! LC_ALL=C.UTF-8 awk 'length > $LIMIT' '$0' | grep -q ."
assert "set -euo pipefail, bash -n" "grep -q '^set -euo pipefail' '$SRC' && bash -n '$SRC'"
assert "нет sudo, docker exec, down, stop, rm -rf" \
  "! grep -vE '^[[:space:]]*#' '$SRC' \
   | grep -qE '\\bsudo\\b|docker exec|compose.* down|dc_new down|docker (rm|stop|kill)|rm -rf'"
assert "нет --force-recreate и --remove-orphans вне комментариев" \
  "! grep -vE '^[[:space:]]*#' '$SRC' | grep -qE -- '--force-recreate|--remove-orphans'"
assert "up только для app (все dc_new up называют APP_SERVICE)" \
  "[[ -n \"\$(grep -vE '^[[:space:]]*#' '$SRC' | grep 'dc_new up ')\" ]] \
   && [[ -z \"\$(grep -vE '^[[:space:]]*#' '$SRC' | grep 'dc_new up ' | grep -v 'APP_SERVICE')\" ]]"
assert "окружение контейнера читается через фильтр одного ключа (sed -n), Config.Env один раз" \
  "[[ \$(grep -vE '^[[:space:]]*#' '$SRC' | grep -c 'Config.Env') -eq 1 ]] \
   && sed -n '/^container_env_value()/,/^}/p' '$SRC' | grep -q 'sed -n'"
assert "печатаются только три переменные: нет cat/echo .env" \
  "! grep -vE '^[[:space:]]*#' '$SRC' | grep -qE 'cat .*LIVE_ENV|cat .*BACKUP|echo .*LIVE_ENV'"
assert "том приёма не затрагивается: в скрипте нет INTAKE_ROOT, chat-attachments, intake-data" \
  "! grep -vE '^[[:space:]]*#' '$SRC' | grep -qE 'INTAKE_ROOT|chat-attachments|intake-data'"
assert "в скрипте нет упоминаний ИИ-инструментов" \
  "! grep -qiE 'cl[a]ude|anthr[o]pic' '$SRC'"

echo "проверок: $((PASS + FAIL)), провалено: $FAIL"
[[ "$FAIL" -eq 0 ]]
