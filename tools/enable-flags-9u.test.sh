#!/usr/bin/env bash
# Тест deploy/patch-9u/enable-flags.sh (необязательный шаг после патча G9q3: выключатель флагов
# PRICE_FILE_ONCE_PER_TURN_ENABLED и STEP_TEXT_SEPARATE_ENABLED в боевом .env - `false` выключает
# функцию, `true` возвращает - и пересоздание только app; после патча обе функции включены по
# умолчанию) без настоящего Docker: вместо docker - заглушка с памятью о контейнерах и окружении
# app, которое она собирает из .env дерева (нет ключа - true). Проверяются отказы (код 3, .env не
# тронут), --dry-run, успех (бэкап .env, правка только названных ключей, права, пересоздание только
# app, значения в окружении app), возврат включённого состояния, автооткат при сбое (код 1, .env
# побайтно прежний), невозможный откат (код 4), ручной --rollback (бэкап без ключа - у app снова
# true), секреты (не попадают в вывод и архив), неверный вызов и стиль.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SRC="$ROOT/deploy/patch-9u/enable-flags.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP:?}"' EXIT
PASS=0
FAIL=0
LIMIT=100
EXIT_FAILED=1
EXIT_USAGE=2
EXIT_REFUSED=3
EXIT_STUCK=4
LOCK_VERSION="1.1.6-pragmatika.7"
# Строки .env с флагами патча (для сравнения «остальное побайтно прежнее»).
FLAGS_LINE_RE="^(PRICE_FILE_ONCE_PER_TURN_ENABLED|STEP_TEXT_SEPARATE_ENABLED)="
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
dotenv_value() { # dotenv_value <ИМЯ> <умолчание>: значение из .env дерева (флаги G9q3: true)
  local v
  v="$(sed -n "s/^$1=//p" "$envfile" 2>/dev/null | tail -1)"
  echo "${v:-$2}"
}
OFF_RE='^(PRICE_FILE_ONCE_PER_TURN_ENABLED|STEP_TEXT_SEPARATE_ENABLED)=false'
flags_off() { grep -qE "$OFF_RE" "$STUB/env/p-app-1"; }
case "$1" in
  compose)
    case " $* " in
      *" config "*"--format json"*)
        printf '{"services":{"app":{"environment":{'
        printf '"PRICE_FILE_ONCE_PER_TURN_ENABLED":"%s","STEP_TEXT_SEPARATE_ENABLED":"%s"}}}}\n' \
          "$(dotenv_value PRICE_FILE_ONCE_PER_TURN_ENABLED true)" \
          "$(dotenv_value STEP_TEXT_SEPARATE_ENABLED true)" ;;
      *" up "*)
        touch "$STUB/started-any"
        [[ "${*: -1}" == app ]] || { touch "$STUB/other-up"; exit 0; }
        if [[ "${STUB_UP_FAIL_ON_FALSE:-0}" == 1 ]] && grep -qE "$OFF_RE" "$envfile"; then
          echo "compose: ошибка up" >&2
          exit 1
        fi
        n="$(cat "$STUB/counter" 2>/dev/null || echo 0)"
        echo $((n + 1)) >"$STUB/counter"
        printf '2026-11-22T10:00:%02dZ\n' "$((n + 1))" >"$STUB/started/p-app-1"
        {
          echo "PATH=/usr/bin"
          echo "OPENAI_API_KEY=$SECRET"
          once=PRICE_FILE_ONCE_PER_TURN_ENABLED
          echo "$once=$(dotenv_value "$once" true)"
          if [[ "${STUB_APP_IGNORES_STEP_TEXT:-0}" == 1 ]]; then
            echo "STEP_TEXT_SEPARATE_ENABLED=true"
          else
            tb=STEP_TEXT_SEPARATE_ENABLED
            echo "$tb=$(dotenv_value "$tb" true)"
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
      if [[ "${STUB_READY_500_ON_FALSE:-0}" == 1 ]] && flags_off; then
        echo '500 {"bots":{"ready":0}}'; exit 1
      fi
      echo "200 {\"bots\":{\"ready\":4}}"
    fi ;;
  exec) echo "docker exec не нужен" >&2; exit 99 ;;
esac
exit 0
STUB
chmod +x "$BIN/docker"

# --- Боевое дерево (после G9q3) ----------------------------------------------------------------
LIVE_ROOT="$TMP/opt/pragmatika-v2"
LIVE="$LIVE_ROOT/deploy"
write_env() { # write_env <с карточками: 0|1> [без перевода строки в конце: 1]
  {
    printf 'POSTGRES_USER=pragmatika\n# комментарий про PRICE_FILE_ONCE_PER_TURN_ENABLED остаётся\n'
    printf 'OPENAI_API_KEY=%s\n' "$SECRET"
    (($1)) && printf 'SUPPLIER_CARDS_ENABLED=true\n' || printf 'SUPPLIER_CARDS_ENABLED=false\n'
    printf 'PRICE_FILE_ONCE_PER_TURN_ENABLED=true\n'
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
    echo "PRICE_FILE_ONCE_PER_TURN_ENABLED=true"
    echo "STEP_TEXT_SEPARATE_ENABLED=true"
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
    CUTOVER_READY_WAIT_S=3 CUTOVER_POLL_S=1 CUTOVER_HEALTH_WAIT_S=3 FLAGS9U_SOAK_POLL_S=1 \
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
sed -i "s|^BAI_VERSION=.*|BAI_VERSION=1.1.6-pragmatika.6|" "$LIVE/images.lock"
T0="$(tree_snapshot)"
run notg9q3 --once-per-turn true
refuse_case notg9q3 "G9q3 не применён (lock .6, стоит только G9q2)"
assert "G9q3 не применён: сообщение «сначала примените патч G9q3»" \
  "out_has notg9q3 'сначала примените патч G9q3'"
reset_stand 1
sed -i "s|^BAI_IMAGE_APP=.*|BAI_IMAGE_APP=r/app@sha256:other|" "$LIVE/images.lock"
T0="$(tree_snapshot)"
run appimage --once-per-turn true
refuse_case appimage "app не на образе из lock боя"
reset_stand 1
sed -i '/^STEP_TEXT_SEPARATE_ENABLED/d' "$STUB/env/p-app-1"
T0="$(tree_snapshot)"
run novar --once-per-turn true
refuse_case novar "в окружении app нет новой переменной (патч G9q3 не катился)"
assert "нет переменной: сообщение называет её" "out_has novar 'STEP_TEXT_SEPARATE_ENABLED'"
reset_stand 1
rm -f "$LIVE/.env"
T0="$(tree_snapshot)"
run noenv --once-per-turn true
refuse_case noenv "нет .env"
reset_stand 1
T0="$(tree_snapshot)"
STUB_NO_READY=1 run noready --once-per-turn true
refuse_case noready "app нездоров (/ready)"
rm -f "$LIVE/.cutover-deployed"
T0="$(tree_snapshot)"
run nomark --once-per-turn true
refuse_case nomark "дерево создано не cutover.sh"

# 2. --dry-run.
reset_stand 1
T0="$(tree_snapshot)"
run dry --once-per-turn true --step-text true --dry-run
assert "--dry-run: код 0" "[[ $RC -eq 0 ]]"
assert "--dry-run: .env и дерево не тронуты, up не было, бэкапа нет" \
  "no_mutation dry && [[ \"\$(tree_snapshot)\" == \"\$T0\" ]] \
   && ! compgen -G '$TMP/home-dry/backups/*'"

# 3. Успех: выключить обе функции (выключатель).
reset_stand 1
T0="$(tree_snapshot)"
cp -p "$LIVE/.env" "$TMP/env-before"
L0="$(cd "$LIVE" && sha256sum compose.yml images.lock .cutover-deployed)"
run both --once-per-turn false --step-text false
assert "успех: код 0" "[[ $RC -eq 0 ]]"
assert "успех: в .env PRICE_FILE_ONCE_PER_TURN_ENABLED=false (заменена существующая строка)" \
  "env_is 'PRICE_FILE_ONCE_PER_TURN_ENABLED=false' \
   && [[ \$(grep -c '^PRICE_FILE_ONCE_PER_TURN_ENABLED=' '$LIVE/.env') -eq 1 ]]"
assert "успех: в .env STEP_TEXT_SEPARATE_ENABLED=false (строка дописана)" \
  "env_is 'STEP_TEXT_SEPARATE_ENABLED=false'"
assert "успех: остальные строки .env побайтно прежние (секреты, комментарий, карточки)" \
  "[[ \"\$(grep -v -E '$FLAGS_LINE_RE' '$LIVE/.env')\" \
     == \"\$(grep -v -E '$FLAGS_LINE_RE' '$TMP/env-before')\" ]]"
assert "успех: права .env прежние (600)" "[[ \$(stat -c %a '$LIVE/.env') == 600 ]]"
assert "успех: бэкап .env равен прежнему, права 600, каталог 700" \
  "cmp -s '$TMP/env-before' '$TMP'/home-both/backups/pragmatika-flags9u-*/.env \
   && [[ \$(stat -c %a '$TMP'/home-both/backups/pragmatika-flags9u-*/.env) == 600 ]] \
   && [[ \$(stat -c %a '$TMP'/home-both/backups/pragmatika-flags9u-*) == 700 ]]"
assert "успех: app пересоздан один раз, только он (--no-deps)" \
  "[[ \$(app_up_count both) -eq 1 ]] && [[ ! -e '$STUB/other-up' ]]"
assert "успех: БЕЗ down, --remove-orphans, --force-recreate, documents не тронут" \
  "! grep -E ' (down|--remove-orphans|--force-recreate)( |\$)' '$TMP/docker-both.log' \
   && [[ \$(cat '$STUB/started/p-documents-1') == 2026-11-18T08:00:00Z ]]"
assert "успех: в окружении app оба флага false" \
  "grep -qx 'PRICE_FILE_ONCE_PER_TURN_ENABLED=false' '$STUB/env/p-app-1' \
   && grep -qx 'STEP_TEXT_SEPARATE_ENABLED=false' '$STUB/env/p-app-1'"
assert "успех: другие файлы дерева (compose.yml, lock, метка выкатки) не тронуты" \
  "[[ \"\$(cd '$LIVE' && sha256sum compose.yml images.lock .cutover-deployed)\" == \"\$L0\" ]]"
mkdir -p "$TMP/arch"
tar -C "$TMP/arch" -xzf "$(compgen -G "$TMP/home-both/flags9u-*.tgz" | head -1)"
assert "успех: секреты не попали в вывод, каталог запуска (кроме бэкапа .env) и архив" \
  "! grep -rq '$SECRET' '$TMP/out-both' '$TMP/home-both/.pragmatika-cutover' '$TMP/arch'"
assert "успех: в каталоге запуска нет копий .env (секреты лежат только в бэкапе)" \
  "! find '$TMP/home-both/.pragmatika-cutover' -name 'env*' | grep -q ."
assert "успех: журнал называет флаги и значения" \
  "out_has both 'PRICE_FILE_ONCE_PER_TURN_ENABLED=false' \
   && out_has both 'STEP_TEXT_SEPARATE_ENABLED=false'"
assert "успех: ни одного docker exec" "! grep -q '^exec ' '$TMP/docker-both.log'"

# Вернуть обе функции (после выключения): значения true, .env правится только на двух ключах.
cp -p "$LIVE/.env" "$TMP/env-off"
T_HOME=both run backon --once-per-turn true --step-text true
assert "возврат: код 0, в .env обе строки true" \
  "[[ $RC -eq 0 ]] && env_is 'PRICE_FILE_ONCE_PER_TURN_ENABLED=true' \
   && env_is 'STEP_TEXT_SEPARATE_ENABLED=true'"
assert "возврат: в окружении app обе true, пересоздан только app" \
  "grep -qx 'PRICE_FILE_ONCE_PER_TURN_ENABLED=true' '$STUB/env/p-app-1' \
   && grep -qx 'STEP_TEXT_SEPARATE_ENABLED=true' '$STUB/env/p-app-1' \
   && [[ ! -e '$STUB/other-up' ]]"

# Выключение одного флага, второй остаётся.
reset_stand 1
run offonce --once-per-turn false
assert "выключение once-per-turn: код 0, step-text остался включённым (ключа в .env нет)" \
  "[[ $RC -eq 0 ]] && env_is 'PRICE_FILE_ONCE_PER_TURN_ENABLED=false' \
   && ! grep -q '^STEP_TEXT_SEPARATE_ENABLED' '$LIVE/.env' \
   && grep -qx 'STEP_TEXT_SEPARATE_ENABLED=true' '$STUB/env/p-app-1'"

# Только once-per-turn, .env без перевода строки в конце и без ключа once-per-turn.
reset_stand 0 1
sed -i '/^PRICE_FILE_ONCE_PER_TURN_ENABLED=/d' "$LIVE/.env"
run onlyonce --once-per-turn false
assert "once-per-turn при .env без перевода строки в конце и без ключа: код 0, строка дописана" \
  "[[ $RC -eq 0 ]] \
   && [[ \"\$(tail -n 2 '$LIVE/.env')\" == \$'LAST=1\nPRICE_FILE_ONCE_PER_TURN_ENABLED=false' ]]"
assert "once-per-turn: step-text не тронут (ключа в .env нет)" \
  "! grep -q '^STEP_TEXT_SEPARATE_ENABLED' '$LIVE/.env'"

# 4. Сбои после правки: автооткат, .env побайтно прежний.
rollback_case() { # rollback_case <имя> <описание>
  assert "$2: код 1 (откат выполнен)" "[[ $RC -eq $EXIT_FAILED ]]"
  assert "$2: .env побайтно прежний (откат из бэкапа)" "[[ \"\$(tree_snapshot)\" == \"\$T0\" ]]"
  assert "$2: автооткат запущен и выполнен" \
    "out_has $1 'автоматический откат' && out_has $1 'ОТКАТ ВЫПОЛНЕН'"
  assert "$2: app на прежних значениях (оба true)" \
    "grep -qx 'PRICE_FILE_ONCE_PER_TURN_ENABLED=true' '$STUB/env/p-app-1' \
     && grep -qx 'STEP_TEXT_SEPARATE_ENABLED=true' '$STUB/env/p-app-1'"
  assert "$2: пересоздавался только app (замена и откат)" \
    "[[ \$(app_up_count $1) -eq 2 && ! -e '$STUB/other-up' ]]"
}
reset_stand 1
T0="$(tree_snapshot)"
STUB_UP_FAIL_ON_FALSE=1 run upfail --once-per-turn false --step-text false
rollback_case upfail "compose up app не удался с выключенными флагами"
reset_stand 1
T0="$(tree_snapshot)"
STUB_READY_500_ON_FALSE=1 run ready500 --step-text false
rollback_case ready500 "/ready 500 после выключения"
reset_stand 1
T0="$(tree_snapshot)"
STUB_APP_IGNORES_STEP_TEXT=1 run ignores --step-text false
rollback_case ignores "в окружении app значение флага не совпало"
reset_stand 1
T0="$(tree_snapshot)"
STUB_DOCS_RESTART=1 run docsrestart --once-per-turn false
assert "documents перезапущен: код 1 и откат" "[[ $RC -eq $EXIT_FAILED ]]"
assert "documents перезапущен: .env прежний" "[[ \"\$(tree_snapshot)\" == \"\$T0\" ]]"
reset_stand 1
T0="$(tree_snapshot)"
STUB_UP_FAIL_ON_FALSE=1 STUB_STUCK=1 run stuck --once-per-turn false
assert "откат не удался: код 4" "[[ $RC -eq $EXIT_STUCK ]]"
assert "откат не удался: .env всё равно возвращён из бэкапа" \
  "[[ \"\$(tree_snapshot)\" == \"\$T0\" ]]"
assert "откат не удался: сообщение о ручном вмешательстве" "out_has stuck 'ОТКАТ НЕ УДАЛСЯ'"

# 5. Ручной откат: --rollback по последнему бэкапу и по --backup. В бэкапе нет ключа
# STEP_TEXT_SEPARATE_ENABLED: после отката значение у app - по умолчанию true.
reset_stand 1
T0="$(tree_snapshot)"
run man_apply --once-per-turn false --step-text false
assert "ручной откат: исходный запуск успешен" "[[ $RC -eq 0 ]]"
T_HOME=man_apply run man_rollback --rollback
assert "ручной откат: код 0" "[[ $RC -eq 0 ]]"
assert "ручной откат: .env побайтно прежний" "[[ \"\$(tree_snapshot)\" == \"\$T0\" ]]"
assert "ручной откат: app снова true (в бэкапе нет ключа - default), пересоздан только app" \
  "grep -qx 'PRICE_FILE_ONCE_PER_TURN_ENABLED=true' '$STUB/env/p-app-1' \
   && grep -qx 'STEP_TEXT_SEPARATE_ENABLED=true' '$STUB/env/p-app-1' \
   && [[ ! -e '$STUB/other-up' ]]"
bk="$(compgen -G "$TMP/home-man_apply/backups/pragmatika-flags9u-*/.env" | head -1)"
reset_stand 1
run man_apply2 --step-text false
T_HOME=man_apply2 run man_rollback2 --rollback --backup "$bk"
assert "откат по --backup ФАЙЛ: код 0 и .env из этого файла" \
  "[[ $RC -eq 0 ]] && cmp -s '$bk' '$LIVE/.env'"
# Бэкап с явным false: после отката у app false (значение из бэкапа).
reset_stand 1
printf 'STEP_TEXT_SEPARATE_ENABLED=false\n' >>"$LIVE/.env"
T0="$(tree_snapshot)"
run offkeep --once-per-turn false
T_HOME=offkeep run offkeep_rb --rollback
assert "ручной откат: бэкап с явным false возвращает false у app" \
  "[[ $RC -eq 0 ]] && [[ \"\$(tree_snapshot)\" == \"\$T0\" ]] \
   && grep -qx 'STEP_TEXT_SEPARATE_ENABLED=false' '$STUB/env/p-app-1' \
   && grep -qx 'PRICE_FILE_ONCE_PER_TURN_ENABLED=true' '$STUB/env/p-app-1'"
reset_stand 1
run norb --rollback
assert "--rollback без бэкапа - код 2" "[[ $RC -eq $EXIT_USAGE ]]"

# 6. Неверный вызов.
run noargs
assert "без аргументов - код 2" "[[ $RC -eq $EXIT_USAGE ]]"
run badval --once-per-turn yes
assert "значение флага не true/false - код 2" "[[ $RC -eq $EXIT_USAGE ]]"
run rbflags --rollback --once-per-turn true
assert "--rollback с --once-per-turn - код 2" "[[ $RC -eq $EXIT_USAGE ]]"
run bkonly --once-per-turn true --backup "$TMP/x"
assert "--backup без --rollback - код 2" "[[ $RC -eq $EXIT_USAGE ]]"
run unknownarg --nonsense
assert "неизвестный аргумент - код 2" "[[ $RC -eq $EXIT_USAGE ]]"
run badsoak --once-per-turn true --soak-seconds abc
assert "--soak-seconds не число - код 2" "[[ $RC -eq $EXIT_USAGE ]]"
run helpout --help
assert "--help - код 0 и описание" \
  "[[ $RC -eq 0 ]] && out_has helpout 'PRICE_FILE_ONCE_PER_TURN_ENABLED'"
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
