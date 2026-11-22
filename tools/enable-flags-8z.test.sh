#!/usr/bin/env bash
# Тест deploy/patch-8z/enable-flags.sh (необязательный шаг после патча G8z: включение флагов
# SHORTLIST_PAGING_ENABLED и SUPPLIER_DISCOVERY_ENABLED в боевом .env и пересоздание только app)
# без настоящего Docker: вместо docker - заглушка с памятью о контейнерах и окружении app, которое
# она собирает из .env дерева. Проверяются отказы (код 3, .env не тронут), --dry-run, успех
# (бэкап .env, правка только названных ключей, права, пересоздание только app, значения в
# окружении app), автооткат при сбое (код 1, .env побайтно прежний), невозможный откат (код 4),
# ручной --rollback, секреты (не попадают в вывод и архив), неверный вызов и стиль.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SRC="$ROOT/deploy/patch-8z/enable-flags.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP:?}"' EXIT
PASS=0
FAIL=0
LIMIT=100
EXIT_FAILED=1
EXIT_USAGE=2
EXIT_REFUSED=3
EXIT_STUCK=4
LOCK_VERSION="1.1.6-pragmatika.3"
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
dotenv_value() { # dotenv_value <ИМЯ> <умолчание>: значение из .env дерева
  local v
  v="$(sed -n "s/^$1=//p" "$envfile" 2>/dev/null | tail -1)"
  echo "${v:-$2}"
}
ON_RE='^(SHORTLIST_PAGING_ENABLED|SUPPLIER_DISCOVERY_ENABLED)=true'
flags_on() { grep -qE "$ON_RE" "$STUB/env/p-app-1"; }
case "$1" in
  compose)
    case " $* " in
      *" config "*"--format json"*)
        printf '{"services":{"app":{"environment":{"SUPPLIER_CARDS_ENABLED":"%s",' \
          "$(dotenv_value SUPPLIER_CARDS_ENABLED false)"
        printf '"SHORTLIST_PAGING_ENABLED":"%s","SUPPLIER_DISCOVERY_ENABLED":"%s"}}}}\n' \
          "$(dotenv_value SHORTLIST_PAGING_ENABLED false)" \
          "$(dotenv_value SUPPLIER_DISCOVERY_ENABLED false)" ;;
      *" up "*)
        touch "$STUB/started-any"
        [[ "${*: -1}" == app ]] || { touch "$STUB/other-up"; exit 0; }
        if [[ "${STUB_UP_FAIL_ON_TRUE:-0}" == 1 ]] && grep -qE "$ON_RE" "$envfile"; then
          echo "compose: ошибка up" >&2
          exit 1
        fi
        n="$(cat "$STUB/counter" 2>/dev/null || echo 0)"
        echo $((n + 1)) >"$STUB/counter"
        printf '2026-11-22T10:00:%02dZ\n' "$((n + 1))" >"$STUB/started/p-app-1"
        {
          echo "PATH=/usr/bin"
          echo "OPENAI_API_KEY=$SECRET"
          echo "SHORTLIST_PAGING_ENABLED=$(dotenv_value SHORTLIST_PAGING_ENABLED false)"
          if [[ "${STUB_APP_IGNORES_DISCOVERY:-0}" == 1 ]]; then
            echo "SUPPLIER_DISCOVERY_ENABLED=false"
          else
            echo "SUPPLIER_DISCOVERY_ENABLED=$(dotenv_value SUPPLIER_DISCOVERY_ENABLED false)"
          fi
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
      if [[ "${STUB_READY_500_ON_TRUE:-0}" == 1 ]] && flags_on; then
        echo '500 {"bots":{"ready":0}}'; exit 1
      fi
      echo "200 {\"bots\":{\"ready\":4}}"
    fi ;;
  exec) echo "docker exec не нужен" >&2; exit 99 ;;
esac
exit 0
STUB
chmod +x "$BIN/docker"

# --- Боевое дерево (после G8z) ----------------------------------------------------------------
LIVE_ROOT="$TMP/opt/pragmatika-v2"
LIVE="$LIVE_ROOT/deploy"
write_env() { # write_env <с карточками: 0|1> [без перевода строки в конце: 1]
  {
    printf 'POSTGRES_USER=pragmatika\n# комментарий про SHORTLIST_PAGING_ENABLED остаётся\n'
    printf 'OPENAI_API_KEY=%s\n' "$SECRET"
    (($1)) && printf 'SUPPLIER_CARDS_ENABLED=true\n' || printf 'SUPPLIER_CARDS_ENABLED=false\n'
    printf 'SHORTLIST_PAGING_ENABLED=false\n'
    if [[ "${2:-0}" == 1 ]]; then printf 'LAST=1'; else printf 'LAST=1\n'; fi
  } >"$LIVE/.env"
  chmod 600 "$LIVE/.env"
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
  {
    echo "PATH=/usr/bin"
    echo "OPENAI_API_KEY=$SECRET"
    echo "SHORTLIST_PAGING_ENABLED=false"
    echo "SUPPLIER_DISCOVERY_ENABLED=false"
  } >"$STUB/env/p-app-1"
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
    CUTOVER_READY_WAIT_S=3 CUTOVER_POLL_S=1 CUTOVER_HEALTH_WAIT_S=3 FLAGS8Z_SOAK_POLL_S=1 \
    bash "$SRC" --soak-seconds 2 "$@" >"$TMP/out-$name" 2>&1 || RC=$?
}
no_mutation() { ! grep -E "$MUTATING_RE" "$TMP/docker-$1.log" | grep -qv '^compose version'; }
out_has() { grep -q -- "$2" "$TMP/out-$1"; }
app_up_count() { grep -cE '^compose .* up -d --no-deps app$' "$TMP/docker-$1.log" || true; }
env_is() { grep -qx "$1" "$LIVE/.env"; }
refuse_case() { # refuse_case <имя> <описание>: код 3, .env и дерево не тронуты, ни одного up
  assert "$2: код 3" "[[ $RC -eq $EXIT_REFUSED ]]"
  assert "$2: дерево (в том числе .env) не тронуто, up не было" \
    "no_mutation $1 && [[ \"\$(tree_snapshot)\" == \"\$T0\" ]]"
}

assert "enable-flags.sh на месте" "[[ -f '$SRC' ]]"
reset_stand 1
T0="$(tree_snapshot)"

# 1. Отказы по предусловиям.
sed -i "s|^BAI_VERSION=.*|BAI_VERSION=1.1.6-pragmatika.2|" "$LIVE/images.lock"
T0="$(tree_snapshot)"
run notg8z --paging true
refuse_case notg8z "G8z не применён (lock .2)"
assert "G8z не применён: сообщение «сначала примените патч G8z»" \
  "out_has notg8z 'сначала примените патч G8z'"
reset_stand 1
sed -i "s|^BAI_IMAGE_APP=.*|BAI_IMAGE_APP=r/app@sha256:other|" "$LIVE/images.lock"
T0="$(tree_snapshot)"
run appimage --paging true
refuse_case appimage "app не на образе из lock боя"
reset_stand 1
sed -i '/^SUPPLIER_DISCOVERY_ENABLED/d' "$STUB/env/p-app-1"
T0="$(tree_snapshot)"
run novar --paging true
refuse_case novar "в окружении app нет новой переменной (патч G8z не катился)"
assert "нет переменной: сообщение называет её" "out_has novar 'SUPPLIER_DISCOVERY_ENABLED'"
reset_stand 0
T0="$(tree_snapshot)"
run nocards --discovery true
refuse_case nocards "SUPPLIER_DISCOVERY_ENABLED=true без SUPPLIER_CARDS_ENABLED=true"
assert "без карточек: сообщение называет SUPPLIER_CARDS_ENABLED" \
  "out_has nocards 'SUPPLIER_CARDS_ENABLED'"
run nocards_paging --paging true --dry-run
assert "без карточек флаг paging допустим (dry-run, код 0)" "[[ $RC -eq 0 ]]"
reset_stand 1
rm -f "$LIVE/.env"
T0="$(tree_snapshot)"
run noenv --paging true
refuse_case noenv "нет .env"
reset_stand 1
T0="$(tree_snapshot)"
STUB_NO_READY=1 run noready --paging true
refuse_case noready "app нездоров (/ready)"
rm -f "$LIVE/.cutover-deployed"
T0="$(tree_snapshot)"
run nomark --paging true
refuse_case nomark "дерево создано не cutover.sh"

# 2. --dry-run.
reset_stand 1
T0="$(tree_snapshot)"
run dry --paging true --discovery true --dry-run
assert "--dry-run: код 0" "[[ $RC -eq 0 ]]"
assert "--dry-run: .env и дерево не тронуты, up не было, бэкапа нет" \
  "no_mutation dry && [[ \"\$(tree_snapshot)\" == \"\$T0\" ]] \
   && ! compgen -G '$TMP/home-dry/backups/*'"

# 3. Успех: оба флага.
reset_stand 1
T0="$(tree_snapshot)"
cp -p "$LIVE/.env" "$TMP/env-before"
L0="$(cd "$LIVE" && sha256sum compose.yml images.lock .cutover-deployed)"
run both --paging true --discovery true
assert "успех: код 0" "[[ $RC -eq 0 ]]"
assert "успех: в .env SHORTLIST_PAGING_ENABLED=true (заменена существующая строка)" \
  "env_is 'SHORTLIST_PAGING_ENABLED=true' \
   && [[ \$(grep -c '^SHORTLIST_PAGING_ENABLED=' '$LIVE/.env') -eq 1 ]]"
assert "успех: в .env SUPPLIER_DISCOVERY_ENABLED=true (строка дописана)" \
  "env_is 'SUPPLIER_DISCOVERY_ENABLED=true'"
assert "успех: остальные строки .env побайтно прежние (секреты, комментарий, карточки)" \
  "[[ \"\$(grep -v -E '^(SHORTLIST_PAGING_ENABLED|SUPPLIER_DISCOVERY_ENABLED)=' '$LIVE/.env')\" \
     == \"\$(grep -v -E '^(SHORTLIST_PAGING_ENABLED|SUPPLIER_DISCOVERY_ENABLED)=' \
     '$TMP/env-before')\" ]]"
assert "успех: права .env прежние (600)" "[[ \$(stat -c %a '$LIVE/.env') == 600 ]]"
assert "успех: бэкап .env равен прежнему, права 600, каталог 700" \
  "cmp -s '$TMP/env-before' '$TMP'/home-both/backups/pragmatika-flags8z-*/.env \
   && [[ \$(stat -c %a '$TMP'/home-both/backups/pragmatika-flags8z-*/.env) == 600 ]] \
   && [[ \$(stat -c %a '$TMP'/home-both/backups/pragmatika-flags8z-*) == 700 ]]"
assert "успех: app пересоздан один раз, только он (--no-deps)" \
  "[[ \$(app_up_count both) -eq 1 ]] && [[ ! -e '$STUB/other-up' ]]"
assert "успех: БЕЗ down, --remove-orphans, --force-recreate, documents не тронут" \
  "! grep -E ' (down|--remove-orphans|--force-recreate)( |\$)' '$TMP/docker-both.log' \
   && [[ \$(cat '$STUB/started/p-documents-1') == 2026-11-18T08:00:00Z ]]"
assert "успех: в окружении app оба флага true" \
  "grep -qx 'SHORTLIST_PAGING_ENABLED=true' '$STUB/env/p-app-1' \
   && grep -qx 'SUPPLIER_DISCOVERY_ENABLED=true' '$STUB/env/p-app-1'"
assert "успех: другие файлы дерева (compose.yml, lock, метка выкатки) не тронуты" \
  "[[ \"\$(cd '$LIVE' && sha256sum compose.yml images.lock .cutover-deployed)\" == \"\$L0\" ]]"
mkdir -p "$TMP/arch"
tar -C "$TMP/arch" -xzf "$(compgen -G "$TMP/home-both/flags8z-*.tgz" | head -1)"
assert "успех: секреты не попали в вывод, каталог запуска (кроме бэкапа .env) и архив" \
  "! grep -rq '$SECRET' '$TMP/out-both' '$TMP/home-both/.pragmatika-cutover' '$TMP/arch'"
assert "успех: в каталоге запуска нет копий .env (секреты лежат только в бэкапе)" \
  "! find '$TMP/home-both/.pragmatika-cutover' -name 'env*' | grep -q ."
assert "успех: журнал называет флаги и значения" \
  "out_has both 'SHORTLIST_PAGING_ENABLED=true' && out_has both 'SUPPLIER_DISCOVERY_ENABLED=true'"
assert "успех: ни одного docker exec" "! grep -q '^exec ' '$TMP/docker-both.log'"

# Выключение одного флага, второй остаётся (T_HOME общий не нужен).
T1="$(tree_snapshot)"
run offpaging --paging false
assert "выключение paging: код 0, discovery остался true" \
  "[[ $RC -eq 0 ]] && env_is 'SHORTLIST_PAGING_ENABLED=false' \
   && env_is 'SUPPLIER_DISCOVERY_ENABLED=true'"

# Только paging, .env без перевода строки в конце и без ключа paging.
reset_stand 0 1
sed -i '/^SHORTLIST_PAGING_ENABLED=/d' "$LIVE/.env"
run onlypaging --paging true
assert "paging при .env без перевода строки в конце и без ключа: код 0, строка дописана" \
  "[[ $RC -eq 0 ]] \
   && [[ \"\$(tail -n 2 '$LIVE/.env')\" == \$'LAST=1\nSHORTLIST_PAGING_ENABLED=true' ]]"
assert "paging: discovery не тронут (ключа в .env нет)" \
  "! grep -q '^SUPPLIER_DISCOVERY_ENABLED' '$LIVE/.env'"

# 4. Сбои после правки: автооткат, .env побайтно прежний.
rollback_case() { # rollback_case <имя> <описание>
  assert "$2: код 1 (откат выполнен)" "[[ $RC -eq $EXIT_FAILED ]]"
  assert "$2: .env побайтно прежний (откат из бэкапа)" "[[ \"\$(tree_snapshot)\" == \"\$T0\" ]]"
  assert "$2: автооткат запущен и выполнен" \
    "out_has $1 'автоматический откат' && out_has $1 'ОТКАТ ВЫПОЛНЕН'"
  assert "$2: app на прежних значениях (оба false)" \
    "grep -qx 'SHORTLIST_PAGING_ENABLED=false' '$STUB/env/p-app-1' \
     && grep -qx 'SUPPLIER_DISCOVERY_ENABLED=false' '$STUB/env/p-app-1'"
  assert "$2: пересоздавался только app (замена и откат)" \
    "[[ \$(app_up_count $1) -eq 2 && ! -e '$STUB/other-up' ]]"
}
reset_stand 1
T0="$(tree_snapshot)"
STUB_UP_FAIL_ON_TRUE=1 run upfail --paging true --discovery true
rollback_case upfail "compose up app не удался с новыми флагами"
reset_stand 1
T0="$(tree_snapshot)"
STUB_READY_500_ON_TRUE=1 run ready500 --discovery true
rollback_case ready500 "/ready 500 после включения"
reset_stand 1
T0="$(tree_snapshot)"
STUB_APP_IGNORES_DISCOVERY=1 run ignores --discovery true
rollback_case ignores "в окружении app значение флага не совпало"
reset_stand 1
T0="$(tree_snapshot)"
STUB_DOCS_RESTART=1 run docsrestart --paging true
assert "documents перезапущен: код 1 и откат" "[[ $RC -eq $EXIT_FAILED ]]"
assert "documents перезапущен: .env прежний" "[[ \"\$(tree_snapshot)\" == \"\$T0\" ]]"
reset_stand 1
T0="$(tree_snapshot)"
STUB_UP_FAIL_ON_TRUE=1 STUB_STUCK=1 run stuck --paging true
assert "откат не удался: код 4" "[[ $RC -eq $EXIT_STUCK ]]"
assert "откат не удался: .env всё равно возвращён из бэкапа" \
  "[[ \"\$(tree_snapshot)\" == \"\$T0\" ]]"
assert "откат не удался: сообщение о ручном вмешательстве" "out_has stuck 'ОТКАТ НЕ УДАЛСЯ'"

# 5. Ручной откат: --rollback по последнему бэкапу и по --backup.
reset_stand 1
T0="$(tree_snapshot)"
run man_apply --paging true --discovery true
assert "ручной откат: исходный запуск успешен" "[[ $RC -eq 0 ]]"
T_HOME=man_apply run man_rollback --rollback
assert "ручной откат: код 0" "[[ $RC -eq 0 ]]"
assert "ручной откат: .env побайтно прежний" "[[ \"\$(tree_snapshot)\" == \"\$T0\" ]]"
assert "ручной откат: app на прежних значениях, пересоздан только app" \
  "grep -qx 'SHORTLIST_PAGING_ENABLED=false' '$STUB/env/p-app-1' \
   && grep -qx 'SUPPLIER_DISCOVERY_ENABLED=false' '$STUB/env/p-app-1' \
   && [[ ! -e '$STUB/other-up' ]]"
bk="$(compgen -G "$TMP/home-man_apply/backups/pragmatika-flags8z-*/.env" | head -1)"
reset_stand 1
run man_apply2 --discovery true
T_HOME=man_apply2 run man_rollback2 --rollback --backup "$bk"
assert "откат по --backup ФАЙЛ: код 0 и .env из этого файла" \
  "[[ $RC -eq 0 ]] && cmp -s '$bk' '$LIVE/.env'"
reset_stand 1
run norb --rollback
assert "--rollback без бэкапа - код 2" "[[ $RC -eq $EXIT_USAGE ]]"

# 6. Неверный вызов.
run noargs
assert "без аргументов - код 2" "[[ $RC -eq $EXIT_USAGE ]]"
run badval --paging yes
assert "значение флага не true/false - код 2" "[[ $RC -eq $EXIT_USAGE ]]"
run rbflags --rollback --paging true
assert "--rollback с --paging - код 2" "[[ $RC -eq $EXIT_USAGE ]]"
run bkonly --paging true --backup "$TMP/x"
assert "--backup без --rollback - код 2" "[[ $RC -eq $EXIT_USAGE ]]"
run unknownarg --nonsense
assert "неизвестный аргумент - код 2" "[[ $RC -eq $EXIT_USAGE ]]"
run badsoak --paging true --soak-seconds abc
assert "--soak-seconds не число - код 2" "[[ $RC -eq $EXIT_USAGE ]]"
run helpout --help
assert "--help - код 0 и описание" "[[ $RC -eq 0 ]] && out_has helpout 'SHORTLIST_PAGING_ENABLED'"
assert "неверный вызов: ни одного up" "no_mutation noargs && no_mutation badval"

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
assert "печатаются только флаги: нет cat/echo .env и env_value вне двух флагов" \
  "! grep -vE '^[[:space:]]*#' '$SRC' | grep -qE 'cat .*LIVE_ENV|cat .*BACKUP|echo .*LIVE_ENV'"

echo "проверок: $((PASS + FAIL)), провалено: $FAIL"
[[ "$FAIL" -eq 0 ]]
