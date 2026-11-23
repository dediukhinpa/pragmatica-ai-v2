#!/usr/bin/env bash
# Тест deploy/patch-9r/enable-flags.sh (необязательный шаг после патча G9r: выключатель флагов
# PRICE_EDIT_TEXT_BLOCKS_ENABLED (app) и DOCUMENTS_EDIT_PDF_TEXT (documents) в боевом .env -
# `false` выключает функцию, `true` возвращает - и пересоздание только затронутого сервиса
# (documents, затем app); после патча обе функции включены по умолчанию) без настоящего Docker:
# вместо docker - заглушка с памятью о контейнерах и окружении app и documents, которое она
# собирает из .env дерева. Проверяются отказы (код 3, .env не тронут), --dry-run, успех (бэкап
# .env, правка только названных ключей, права, пересоздание только названных сервисов в порядке
# documents, app, значения в окружении), возврат включённого состояния, автооткат при сбое (код 1,
# .env побайтно прежний), невозможный откат (код 4), ручной --rollback (бэкап без ключа - у app
# снова true, у documents пусто), секреты (не попадают в вывод и архив), неверный вызов и стиль.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SRC="${ENABLE9R_SRC:-$ROOT/deploy/patch-9r/enable-flags.sh}"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP:?}"' EXIT
PASS=0
FAIL=0
LIMIT=100
EXIT_FAILED=1
EXIT_USAGE=2
EXIT_REFUSED=3
EXIT_STUCK=4
LOCK_VERSION="1.1.10-pragmatika.1"
# Строки .env с флагами патча (для сравнения «остальное побайтно прежнее»).
FLAGS_LINE_RE="^(PRICE_EDIT_TEXT_BLOCKS_ENABLED|DOCUMENTS_EDIT_PDF_TEXT)="
H_APP="2222222222222222222222222222222222222222222222222222222222222222"
H_DOCS="5555555555555555555555555555555555555555555555555555555555555555"
APP_IMG="r/app@sha256:$H_APP"
DOCS_IMG="r/pragmatika-documents@sha256:$H_DOCS"
SECRET="env-secret-token-0123456789"
MUTATING_RE='^(create|rm|stop|kill|start|restart|load|pull|volume|network|compose .*up)'
DOCS_START0="2026-11-18T08:00:00Z"
APP_START0="2026-11-20T08:00:00Z"

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
dotenv_value() { # dotenv_value <ИМЯ> <умолчание>: значение из .env дерева (как compose :-)
  local v
  v="$(sed -n "s/^$1=//p" "$envfile" 2>/dev/null | tail -1)"
  echo "${v:-$2}"
}
docs_off() { grep -qx 'DOCUMENTS_EDIT_PDF_TEXT=false' "$STUB/env/p-documents-1"; }
case "$1" in
  compose)
    case " $* " in
      *" config "*"--format json"*)
        printf '{"services":{"app":{"environment":{'
        printf '"PRICE_EDIT_TEXT_BLOCKS_ENABLED":"%s"}},' \
          "$(dotenv_value PRICE_EDIT_TEXT_BLOCKS_ENABLED true)"
        printf '"documents":{"environment":{"DOCUMENTS_EDIT_PDF_TEXT":"%s"}}}}\n' \
          "$(dotenv_value DOCUMENTS_EDIT_PDF_TEXT '')" ;;
      *" up "*)
        touch "$STUB/started-any"
        svc="${*: -1}"
        n="$(cat "$STUB/counter" 2>/dev/null || echo 0)"
        echo $((n + 1)) >"$STUB/counter"
        case "$svc" in
          documents)
            if [[ "${STUB_DOCS_UP_FAIL_ON_FALSE:-0}" == 1 ]] \
              && grep -qE '^DOCUMENTS_EDIT_PDF_TEXT=false' "$envfile"; then
              echo "compose: ошибка up documents" >&2
              exit 1
            fi
            printf '2026-11-22T10:00:%02dZ\n' "$((n + 1))" >"$STUB/started/p-documents-1"
            {
              echo "PATH=/usr/bin"
              echo "DOCUMENTS_EDIT_PDF=true"
              if [[ "${STUB_DOCS_IGNORES_PDF_TEXT:-0}" == 1 ]] \
                && [[ -n "$(dotenv_value DOCUMENTS_EDIT_PDF_TEXT '')" ]]; then
                echo "DOCUMENTS_EDIT_PDF_TEXT=true"
              else
                echo "DOCUMENTS_EDIT_PDF_TEXT=$(dotenv_value DOCUMENTS_EDIT_PDF_TEXT '')"
              fi
            } >"$STUB/env/p-documents-1"
            if [[ "${STUB_APP_RESTART_ON_DOCS:-0}" == 1 ]]; then
              echo "2026-11-22T11:00:00Z" >"$STUB/started/p-app-1"
            fi ;;
          app)
            if [[ "${STUB_UP_FAIL_ON_FALSE:-0}" == 1 ]] \
              && grep -qE '^PRICE_EDIT_TEXT_BLOCKS_ENABLED=false' "$envfile"; then
              echo "compose: ошибка up" >&2
              exit 1
            fi
            printf '2026-11-22T10:00:%02dZ\n' "$((n + 1))" >"$STUB/started/p-app-1"
            {
              echo "PATH=/usr/bin"
              echo "OPENAI_API_KEY=$SECRET"
              echo "PRICE_EDIT_DB_WRITE_ENABLED=true"
              if [[ "${STUB_APP_IGNORES_TEXT_BLOCKS:-0}" == 1 ]]; then
                echo "PRICE_EDIT_TEXT_BLOCKS_ENABLED=true"
              else
                tb=PRICE_EDIT_TEXT_BLOCKS_ENABLED
                echo "$tb=$(dotenv_value "$tb" true)"
              fi
            } >"$STUB/env/p-app-1"
            if [[ "${STUB_DOCS_RESTART:-0}" == 1 ]]; then
              echo "2026-11-22T11:00:00Z" >"$STUB/started/p-documents-1"
            fi ;;
          *) touch "$STUB/other-up" ;;
        esac ;;
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
      case "${*: -1}" in
        "$APP_IMG") echo "sha256:id-app" ;;
        "$DOCS_IMG") echo "sha256:id-docs" ;;
        *) echo "sha256:id-other" ;;
      esac
    fi ;;
  run)
    if [[ "$*" == *"bun"* ]]; then
      if [[ "$*" == *"/health"* ]]; then
        [[ "${STUB_DOCS_DOWN:-0}" != 1 ]] || { echo "documents недоступен"; exit 1; }
        if [[ "${STUB_STUCK:-0}" == 1 && -e "$STUB/started-any" ]]; then
          echo "documents недоступен"; exit 1
        fi
        if [[ "${STUB_DOCS_HEALTH_500_ON_FALSE:-0}" == 1 ]] && docs_off; then
          echo '500 {"status":"error"}'; exit 1
        fi
        echo '200 {"status":"ok"}'; exit 0
      fi
      [[ "${STUB_NO_READY:-0}" != 1 ]] || { echo "app недоступен"; exit 1; }
      if [[ "${STUB_STUCK:-0}" == 1 && -e "$STUB/started-any" ]]; then
        echo "app недоступен"; exit 1
      fi
      if [[ "${STUB_READY_500_ON_FALSE:-0}" == 1 ]] \
        && grep -qx 'PRICE_EDIT_TEXT_BLOCKS_ENABLED=false' "$STUB/env/p-app-1"; then
        echo '500 {"bots":{"ready":0}}'; exit 1
      fi
      echo "200 {\"bots\":{\"ready\":4}}"
    fi ;;
  exec) echo "docker exec не нужен" >&2; exit 99 ;;
esac
exit 0
STUB
chmod +x "$BIN/docker"

# --- Боевое дерево (после G9r) ----------------------------------------------------------------
LIVE_ROOT="$TMP/opt/pragmatika-v2"
LIVE="$LIVE_ROOT/deploy"
write_env() { # write_env <с карточками: 0|1> [без перевода строки в конце: 1]
  {
    printf 'POSTGRES_USER=pragmatika\n# комментарий про DOCUMENTS_EDIT_PDF_TEXT остаётся\n'
    printf 'OPENAI_API_KEY=%s\n' "$SECRET"
    (($1)) && printf 'SUPPLIER_CARDS_ENABLED=true\n' || printf 'SUPPLIER_CARDS_ENABLED=false\n'
    printf 'PRICE_EDIT_TEXT_BLOCKS_ENABLED=true\n'
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
  echo "$APP_START0" >"$STUB/started/p-app-1"
  echo "$DOCS_START0" >"$STUB/started/p-documents-1"
  {
    echo "PATH=/usr/bin"
    echo "OPENAI_API_KEY=$SECRET"
    echo "PRICE_EDIT_DB_WRITE_ENABLED=true"
    echo "PRICE_EDIT_TEXT_BLOCKS_ENABLED=true"
  } >"$STUB/env/p-app-1"
  printf 'PATH=/usr/bin\nDOCUMENTS_EDIT_PDF=true\nDOCUMENTS_EDIT_PDF_TEXT=\n' \
    >"$STUB/env/p-documents-1"
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
    CUTOVER_READY_WAIT_S=3 CUTOVER_POLL_S=1 CUTOVER_HEALTH_WAIT_S=3 FLAGS9R_SOAK_POLL_S=1 \
    bash "$SRC" --soak-seconds 2 "$@" >"$TMP/out-$name" 2>&1 || RC=$?
}
no_mutation() { ! grep -E "$MUTATING_RE" "$TMP/docker-$1.log" | grep -qv '^compose version'; }
out_has() { grep -q -- "$2" "$TMP/out-$1"; }
app_up_count() { grep -cE '^compose .* up -d --no-deps app$' "$TMP/docker-$1.log" || true; }
docs_up_count() { grep -cE '^compose .* up -d --no-deps documents$' "$TMP/docker-$1.log" || true; }
up_line() {
  grep -nE "^compose .* up -d --no-deps $2\$" "$TMP/docker-$1.log" | head -1 | cut -d: -f1
}
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
run notg9r --text-blocks true
refuse_case notg9r "G9r не применён (lock .6, стоит только G9q2)"
assert "G9r не применён: сообщение «сначала примените патч G9r»" \
  "out_has notg9r 'сначала примените патч G9r'"
assert "G9r не применён: сообщение называет нужную версию" "out_has notg9r '$LOCK_VERSION'"
reset_stand 1
sed -i "s|^BAI_IMAGE_APP=.*|BAI_IMAGE_APP=r/app@sha256:other|" "$LIVE/images.lock"
T0="$(tree_snapshot)"
run appimage --text-blocks true
refuse_case appimage "app не на образе из lock боя"
reset_stand 1
sed -i "s|^BAI_IMAGE_DOCUMENTS=.*|BAI_IMAGE_DOCUMENTS=r/other-documents@sha256:other|" \
  "$LIVE/images.lock"
T0="$(tree_snapshot)"
run docsimage --pdf-text false
refuse_case docsimage "documents не на образе из lock боя"
reset_stand 1
sed -i '/^PRICE_EDIT_TEXT_BLOCKS_ENABLED/d' "$STUB/env/p-app-1"
T0="$(tree_snapshot)"
run novar --text-blocks false
refuse_case novar "в окружении app нет переменной флага (патч G9q не катился)"
assert "нет переменной: сообщение называет её" "out_has novar 'PRICE_EDIT_TEXT_BLOCKS_ENABLED'"
reset_stand 1
rm -f "$LIVE/.env"
T0="$(tree_snapshot)"
run noenv --pdf-text false
refuse_case noenv "нет .env"
reset_stand 1
T0="$(tree_snapshot)"
STUB_NO_READY=1 run noready --pdf-text false
refuse_case noready "app нездоров (/ready)"
rm -f "$LIVE/.cutover-deployed"
T0="$(tree_snapshot)"
run nomark --pdf-text false
refuse_case nomark "дерево создано не cutover.sh"

# 2. --dry-run.
reset_stand 1
T0="$(tree_snapshot)"
run dry --pdf-text false --text-blocks true --dry-run
assert "--dry-run: код 0" "[[ $RC -eq 0 ]]"
assert "--dry-run: .env и дерево не тронуты, up не было, бэкапа нет" \
  "no_mutation dry && [[ \"\$(tree_snapshot)\" == \"\$T0\" ]] \
   && ! compgen -G '$TMP/home-dry/backups/*'"

# 3. Успех: выключить обе функции (выключатель).
reset_stand 1
T0="$(tree_snapshot)"
cp -p "$LIVE/.env" "$TMP/env-before"
L0="$(cd "$LIVE" && sha256sum compose.yml images.lock .cutover-deployed)"
run both --pdf-text false --text-blocks false
assert "успех: код 0" "[[ $RC -eq 0 ]]"
assert "успех: в .env PRICE_EDIT_TEXT_BLOCKS_ENABLED=false (заменена существующая строка)" \
  "env_is 'PRICE_EDIT_TEXT_BLOCKS_ENABLED=false' \
   && [[ \$(grep -c '^PRICE_EDIT_TEXT_BLOCKS_ENABLED=' '$LIVE/.env') -eq 1 ]]"
assert "успех: в .env DOCUMENTS_EDIT_PDF_TEXT=false (строка дописана)" \
  "env_is 'DOCUMENTS_EDIT_PDF_TEXT=false'"
assert "успех: остальные строки .env побайтно прежние (секреты, комментарий, карточки)" \
  "[[ \"\$(grep -v -E '$FLAGS_LINE_RE' '$LIVE/.env')\" \
     == \"\$(grep -v -E '$FLAGS_LINE_RE' '$TMP/env-before')\" ]]"
assert "успех: права .env прежние (600)" "[[ \$(stat -c %a '$LIVE/.env') == 600 ]]"
assert "успех: бэкап .env равен прежнему, права 600, каталог 700" \
  "cmp -s '$TMP/env-before' '$TMP'/home-both/backups/pragmatika-flags9r-*/.env \
   && [[ \$(stat -c %a '$TMP'/home-both/backups/pragmatika-flags9r-*/.env) == 600 ]] \
   && [[ \$(stat -c %a '$TMP'/home-both/backups/pragmatika-flags9r-*) == 700 ]]"
assert "успех: documents и app пересозданы по одному разу, остальное не тронуто (--no-deps)" \
  "[[ \$(docs_up_count both) -eq 1 && \$(app_up_count both) -eq 1 ]] \
   && [[ ! -e '$STUB/other-up' ]]"
assert "успех: сначала documents, затем app" \
  "(( \$(up_line both documents) < \$(up_line both app) ))"
assert "успех: БЕЗ down, --remove-orphans, --force-recreate" \
  "! grep -E ' (down|--remove-orphans|--force-recreate)( |\$)' '$TMP/docker-both.log'"
assert "успех: в окружении app флаг false, в окружении documents DOCUMENTS_EDIT_PDF_TEXT=false" \
  "grep -qx 'PRICE_EDIT_TEXT_BLOCKS_ENABLED=false' '$STUB/env/p-app-1' \
   && grep -qx 'DOCUMENTS_EDIT_PDF_TEXT=false' '$STUB/env/p-documents-1' \
   && grep -qx 'DOCUMENTS_EDIT_PDF=true' '$STUB/env/p-documents-1'"
assert "успех: другие файлы дерева (compose.yml, lock, метка выкатки) не тронуты" \
  "[[ \"\$(cd '$LIVE' && sha256sum compose.yml images.lock .cutover-deployed)\" == \"\$L0\" ]]"
mkdir -p "$TMP/arch"
tar -C "$TMP/arch" -xzf "$(compgen -G "$TMP/home-both/flags9r-*.tgz" | head -1)"
assert "успех: секреты не попали в вывод, каталог запуска (кроме бэкапа .env) и архив" \
  "! grep -rq '$SECRET' '$TMP/out-both' '$TMP/home-both/.pragmatika-cutover' '$TMP/arch'"
assert "успех: в каталоге запуска нет копий .env (секреты лежат только в бэкапе)" \
  "! find '$TMP/home-both/.pragmatika-cutover' -name 'env*' | grep -q ."
assert "успех: журнал называет флаги и значения" \
  "out_has both 'PRICE_EDIT_TEXT_BLOCKS_ENABLED=false' \
   && out_has both 'DOCUMENTS_EDIT_PDF_TEXT=false'"
assert "успех: ни одного docker exec" "! grep -q '^exec ' '$TMP/docker-both.log'"

# Вернуть обе функции (после выключения): значения true, .env правится только на двух ключах.
T_HOME=both run backon --pdf-text true --text-blocks true
assert "возврат: код 0, в .env обе строки true" \
  "[[ $RC -eq 0 ]] && env_is 'PRICE_EDIT_TEXT_BLOCKS_ENABLED=true' \
   && env_is 'DOCUMENTS_EDIT_PDF_TEXT=true'"
assert "возврат: в окружении app и documents true, пересоздано только документы и app" \
  "grep -qx 'PRICE_EDIT_TEXT_BLOCKS_ENABLED=true' '$STUB/env/p-app-1' \
   && grep -qx 'DOCUMENTS_EDIT_PDF_TEXT=true' '$STUB/env/p-documents-1' \
   && [[ ! -e '$STUB/other-up' ]]"

# Только --pdf-text: пересоздаётся один documents, app не перезапускается.
reset_stand 1
run onlypdf --pdf-text false
assert "только --pdf-text: код 0, в .env DOCUMENTS_EDIT_PDF_TEXT=false, флаг app не тронут" \
  "[[ $RC -eq 0 ]] && env_is 'DOCUMENTS_EDIT_PDF_TEXT=false' \
   && env_is 'PRICE_EDIT_TEXT_BLOCKS_ENABLED=true'"
assert "только --pdf-text: пересоздан только documents, app не пересоздавался и не перезапускался" \
  "[[ \$(docs_up_count onlypdf) -eq 1 && \$(app_up_count onlypdf) -eq 0 ]] \
   && [[ \$(cat '$STUB/started/p-app-1') == $APP_START0 ]]"
assert "только --pdf-text: documents отвечает false" \
  "grep -qx 'DOCUMENTS_EDIT_PDF_TEXT=false' '$STUB/env/p-documents-1'"
assert "только --pdf-text: журнал называет проверку /health documents и непересоздание app" \
  "out_has onlypdf 'app' && out_has onlypdf 'не перезапускался'"

# Только --text-blocks: пересоздаётся один app, documents не перезапускается.
reset_stand 1
run onlytb --text-blocks false
assert "только --text-blocks: код 0, ключа documents в .env нет" \
  "[[ $RC -eq 0 ]] && env_is 'PRICE_EDIT_TEXT_BLOCKS_ENABLED=false' \
   && ! grep -q '^DOCUMENTS_EDIT_PDF_TEXT' '$LIVE/.env'"
assert "только --text-blocks: пересоздан только app, documents не перезапускался" \
  "[[ \$(app_up_count onlytb) -eq 1 && \$(docs_up_count onlytb) -eq 0 ]] \
   && [[ \$(cat '$STUB/started/p-documents-1') == $DOCS_START0 ]]"

# .env без перевода строки в конце и без ключа: строка дописывается на новой строке.
reset_stand 0 1
sed -i '/^PRICE_EDIT_TEXT_BLOCKS_ENABLED=/d' "$LIVE/.env"
sed -i 's/^LAST=1$/LAST=1/' "$LIVE/.env"
run nonl --pdf-text false
assert "pdf-text при .env без перевода строки в конце и без ключа: код 0, строка дописана" \
  "[[ $RC -eq 0 ]] \
   && [[ \"\$(tail -n 2 '$LIVE/.env')\" == \$'LAST=1\nDOCUMENTS_EDIT_PDF_TEXT=false' ]]"

# Явное значение в .env с кавычками и регистром: документы получают его как есть.
reset_stand 1
printf 'DOCUMENTS_EDIT_PDF_TEXT=TRUE\n' >>"$LIVE/.env"
printf 'PATH=/usr/bin\nDOCUMENTS_EDIT_PDF=true\nDOCUMENTS_EDIT_PDF_TEXT=TRUE\n' \
  >"$STUB/env/p-documents-1"
T0="$(tree_snapshot)"
run upperpre --pdf-text false
assert "в .env уже TRUE (регистр): значение заменено на false, одна строка ключа" \
  "[[ $RC -eq 0 ]] && env_is 'DOCUMENTS_EDIT_PDF_TEXT=false' \
   && [[ \$(grep -c '^DOCUMENTS_EDIT_PDF_TEXT=' '$LIVE/.env') -eq 1 ]]"

# Предупреждение: DOCUMENTS_EDIT_PDF у documents не true.
reset_stand 1
printf 'PATH=/usr/bin\nDOCUMENTS_EDIT_PDF=false\nDOCUMENTS_EDIT_PDF_TEXT=\n' \
  >"$STUB/env/p-documents-1"
run pdfoff --pdf-text true
assert "DOCUMENTS_EDIT_PDF не true: предупреждение, патч не отказывает" \
  "[[ $RC -eq 0 ]] && out_has pdfoff 'ВНИМАНИЕ' && out_has pdfoff 'DOCUMENTS_EDIT_PDF'"

# 4. Сбои после правки: автооткат, .env побайтно прежний.
rollback_case() { # rollback_case <имя> <описание>
  assert "$2: код 1 (откат выполнен)" "[[ $RC -eq $EXIT_FAILED ]]"
  assert "$2: .env побайтно прежний (откат из бэкапа)" "[[ \"\$(tree_snapshot)\" == \"\$T0\" ]]"
  assert "$2: автооткат запущен и выполнен" \
    "out_has $1 'автоматический откат' && out_has $1 'ОТКАТ ВЫПОЛНЕН'"
  assert "$2: app на прежнем значении (true), documents без значения (включено)" \
    "grep -qx 'PRICE_EDIT_TEXT_BLOCKS_ENABLED=true' '$STUB/env/p-app-1' \
     && grep -qx 'DOCUMENTS_EDIT_PDF_TEXT=' '$STUB/env/p-documents-1'"
  assert "$2: откат без down, пересоздавались только documents и app" \
    "! grep -E ' (down|--remove-orphans)( |\$)' '$TMP/docker-$1.log' && [[ ! -e '$STUB/other-up' ]]"
}
reset_stand 1
T0="$(tree_snapshot)"
STUB_DOCS_UP_FAIL_ON_FALSE=1 run docsupfail --pdf-text false
rollback_case docsupfail "compose up documents не удался с выключенным флагом"
assert "up documents не удался: documents пересоздавался дважды (замена и откат), app не нужен" \
  "[[ \$(docs_up_count docsupfail) -eq 2 ]]"
reset_stand 1
T0="$(tree_snapshot)"
STUB_DOCS_HEALTH_500_ON_FALSE=1 run docs500 --pdf-text false
rollback_case docs500 "/health documents 500 после выключения"
assert "/health 500: причина в журнале" "out_has docs500 '/health documents не 200'"
reset_stand 1
T0="$(tree_snapshot)"
STUB_DOCS_IGNORES_PDF_TEXT=1 run docsignores --pdf-text false
rollback_case docsignores "в окружении documents значение флага не совпало"
assert "значение не совпало: причина называет ключ" "out_has docsignores 'DOCUMENTS_EDIT_PDF_TEXT'"
reset_stand 1
T0="$(tree_snapshot)"
STUB_UP_FAIL_ON_FALSE=1 run upfail --text-blocks false
rollback_case upfail "compose up app не удался с выключенным флагом"
assert "up app не удался: app пересоздавался дважды (замена и откат)" \
  "[[ \$(app_up_count upfail) -eq 2 ]]"
reset_stand 1
T0="$(tree_snapshot)"
STUB_UP_FAIL_ON_FALSE=1 run bothfail --pdf-text true --text-blocks false
rollback_case bothfail "documents обновлён, а app не поднялся (оба флага названы)"
reset_stand 1
T0="$(tree_snapshot)"
STUB_READY_500_ON_FALSE=1 run ready500 --text-blocks false
rollback_case ready500 "/ready 500 после выключения"
reset_stand 1
T0="$(tree_snapshot)"
STUB_APP_IGNORES_TEXT_BLOCKS=1 run ignores --text-blocks false
rollback_case ignores "в окружении app значение флага не совпало"
reset_stand 1
T0="$(tree_snapshot)"
STUB_DOCS_RESTART=1 run docsrestart --text-blocks false
assert "documents перезапущен при пересоздании app: код 1 и откат" "[[ $RC -eq $EXIT_FAILED ]]"
assert "documents перезапущен: .env прежний" "[[ \"\$(tree_snapshot)\" == \"\$T0\" ]]"
assert "documents перезапущен: причина в журнале" "out_has docsrestart 'перезапускался'"
reset_stand 1
T0="$(tree_snapshot)"
STUB_APP_RESTART_ON_DOCS=1 run apprestart --pdf-text false
assert "app перезапущен при пересоздании documents: код 1 и откат" "[[ $RC -eq $EXIT_FAILED ]]"
assert "app перезапущен: .env прежний" "[[ \"\$(tree_snapshot)\" == \"\$T0\" ]]"
assert "app перезапущен: причина в журнале" "out_has apprestart 'перезапускался'"
reset_stand 1
T0="$(tree_snapshot)"
STUB_DOCS_UP_FAIL_ON_FALSE=1 STUB_STUCK=1 run stuck --pdf-text false
assert "откат не удался: код 4" "[[ $RC -eq $EXIT_STUCK ]]"
assert "откат не удался: .env всё равно возвращён из бэкапа" \
  "[[ \"\$(tree_snapshot)\" == \"\$T0\" ]]"
assert "откат не удался: сообщение о ручном вмешательстве" "out_has stuck 'ОТКАТ НЕ УДАЛСЯ'"

# 5. Ручной откат: --rollback по последнему бэкапу и по --backup. В бэкапе нет ключа
# DOCUMENTS_EDIT_PDF_TEXT: после отката у documents пусто; нет PRICE_EDIT_TEXT_BLOCKS_ENABLED:
# у app по умолчанию true.
reset_stand 1
sed -i '/^PRICE_EDIT_TEXT_BLOCKS_ENABLED=/d' "$LIVE/.env"
T0="$(tree_snapshot)"
run man_apply --pdf-text false --text-blocks false
assert "ручной откат: исходный запуск успешен" "[[ $RC -eq 0 ]]"
T_HOME=man_apply run man_rollback --rollback
assert "ручной откат: код 0" "[[ $RC -eq 0 ]]"
assert "ручной откат: .env побайтно прежний" "[[ \"\$(tree_snapshot)\" == \"\$T0\" ]]"
assert "ручной откат: app снова true (в бэкапе нет ключа - default), documents пусто" \
  "grep -qx 'PRICE_EDIT_TEXT_BLOCKS_ENABLED=true' '$STUB/env/p-app-1' \
   && grep -qx 'DOCUMENTS_EDIT_PDF_TEXT=' '$STUB/env/p-documents-1' \
   && [[ ! -e '$STUB/other-up' ]]"
assert "ручной откат: сначала documents, затем app, без down" \
  "(( \$(up_line man_rollback documents) < \$(up_line man_rollback app) )) \
   && ! grep -E ' (down|--remove-orphans)( |\$)' '$TMP/docker-man_rollback.log'"
bk="$(compgen -G "$TMP/home-man_apply/backups/pragmatika-flags9r-*/.env" | head -1)"
reset_stand 1
run man_apply2 --text-blocks false
T_HOME=man_apply2 run man_rollback2 --rollback --backup "$bk"
assert "откат по --backup ФАЙЛ: код 0 и .env из этого файла" \
  "[[ $RC -eq 0 ]] && cmp -s '$bk' '$LIVE/.env'"
# Бэкап с явным значением: после отката значение из бэкапа (false у app, off у documents).
reset_stand 1
printf 'PRICE_EDIT_TEXT_BLOCKS_ENABLED=false\nDOCUMENTS_EDIT_PDF_TEXT=off\n' >>"$LIVE/.env"
printf 'PATH=/usr/bin\nDOCUMENTS_EDIT_PDF=true\nDOCUMENTS_EDIT_PDF_TEXT=off\n' \
  >"$STUB/env/p-documents-1"
sed -i 's/^PRICE_EDIT_TEXT_BLOCKS_ENABLED=.*/&false/;s/=true\(false\)/=\1/' "$STUB/env/p-app-1"
T0="$(tree_snapshot)"
run offkeep --pdf-text true
T_HOME=offkeep run offkeep_rb --rollback
assert "ручной откат: бэкап с явными значениями возвращает false у app и off у documents" \
  "[[ $RC -eq 0 ]] && [[ \"\$(tree_snapshot)\" == \"\$T0\" ]] \
   && grep -qx 'PRICE_EDIT_TEXT_BLOCKS_ENABLED=false' '$STUB/env/p-app-1' \
   && grep -qx 'DOCUMENTS_EDIT_PDF_TEXT=off' '$STUB/env/p-documents-1'"
reset_stand 1
run norb --rollback
assert "--rollback без бэкапа - код 2" "[[ $RC -eq $EXIT_USAGE ]]"

# 6. Неверный вызов.
run noargs
assert "без аргументов - код 2" "[[ $RC -eq $EXIT_USAGE ]]"
run badval --text-blocks yes
assert "значение флага не true/false - код 2" "[[ $RC -eq $EXIT_USAGE ]]"
run badval2 --pdf-text 1
assert "значение --pdf-text не true/false - код 2" "[[ $RC -eq $EXIT_USAGE ]]"
run rbflags --rollback --pdf-text true
assert "--rollback с --pdf-text - код 2" "[[ $RC -eq $EXIT_USAGE ]]"
run bkonly --text-blocks true --backup "$TMP/x"
assert "--backup без --rollback - код 2" "[[ $RC -eq $EXIT_USAGE ]]"
run oldflag --db-write true
assert "флаг G9q --db-write в G9r не поддерживается - код 2" "[[ $RC -eq $EXIT_USAGE ]]"
run unknownarg --nonsense
assert "неизвестный аргумент - код 2" "[[ $RC -eq $EXIT_USAGE ]]"
run badsoak --pdf-text true --soak-seconds abc
assert "--soak-seconds не число - код 2" "[[ $RC -eq $EXIT_USAGE ]]"
run helpout --help
assert "--help - код 0 и описание обоих флагов" \
  "[[ $RC -eq 0 ]] && out_has helpout 'DOCUMENTS_EDIT_PDF_TEXT' \
   && out_has helpout 'PRICE_EDIT_TEXT_BLOCKS_ENABLED'"
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
assert "up только с --no-deps и одним сервисом" \
  "[[ \$(grep -vE '^[[:space:]]*#' '$SRC' | grep -c 'dc_new up ') -eq 1 ]] \
   && grep -vE '^[[:space:]]*#' '$SRC' | grep 'dc_new up ' | grep -q -- '--no-deps \"\$svc\"'"
assert "сервисы пересоздаются только из констант (documents, app)" \
  "grep -q 'SERVICES+=(\"\$DOCUMENTS_SERVICE\")' '$SRC' \
   && grep -q 'SERVICES+=(\"\$APP_SERVICE\")' '$SRC'"
assert "окружение контейнера читается через фильтр одного ключа (sed -n), Config.Env один раз" \
  "[[ \$(grep -vE '^[[:space:]]*#' '$SRC' | grep -c 'Config.Env') -eq 1 ]] \
   && sed -n '/^container_env_value()/,/^}/p' '$SRC' | grep -q 'sed -n'"
assert "печатаются только флаги: нет cat/echo .env и env_value вне двух флагов" \
  "! grep -vE '^[[:space:]]*#' '$SRC' | grep -qE 'cat .*LIVE_ENV|cat .*BACKUP|echo .*LIVE_ENV'"
assert "нет следов флагов G9q и префиксов других патчей" \
  "! grep -qE 'PRICE_EDIT_DB_WRITE|flags9q|enable-flags-9q|FLAGS9Q|G9q\\\\b' '$SRC' \
   || ! grep -vE '^[[:space:]]*#' '$SRC' | grep -qE 'PRICE_EDIT_DB_WRITE|flags9q|FLAGS9Q'"

echo "проверок: $((PASS + FAIL)), провалено: $FAIL"
[[ "$FAIL" -eq 0 ]]
