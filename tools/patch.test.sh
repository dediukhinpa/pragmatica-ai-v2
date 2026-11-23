#!/usr/bin/env bash
# Тест deploy/patch/patch.sh без настоящего Docker: вместо docker - заглушка с памятью о том, какой
# образ в каком контейнере. Проверяются отказы по предусловиям (бой не тронут), --preflight-only,
# успешный ход (файлы заменены, обход снят, тег legacy-docx цел), сбой с автооткатом (файлы
# вернулись, обход на месте), невозможный откат (код 4), ручной --rollback и стиль. Ход на
# настоящем Docker проверяет tools/patch-synth.sh (синтетический бой на Fornex).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SRC="$ROOT/deploy/patch"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP:?}"' EXIT
PASS=0
FAIL=0
LIMIT=100
EXIT_FAILED=1
EXIT_USAGE=2
EXIT_REFUSED=3
EXIT_STUCK=4
H_OLD_DOCS="1111111111111111111111111111111111111111111111111111111111111111"
H_NEW_DOCS="2222222222222222222222222222222222222222222222222222222222222222"
H_APP="3333333333333333333333333333333333333333333333333333333333333333"
H_ALLOY="4444444444444444444444444444444444444444444444444444444444444444"
H_MASK="5555555555555555555555555555555555555555555555555555555555555555"
H_BASE="6666666666666666666666666666666666666666666666666666666666666666"
# Изменяющие команды docker: при отказе не должна появиться ни одна (одноразовые пробы без сети
# и пробы /ready в сети app допустимы: они ничего не меняют).
MUTATING_RE='^(create|rm|stop|kill|start|restart|load|pull|volume|network|compose .*up)'

ok() { PASS=$((PASS + 1)); echo "PASS $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL $1"; }
assert() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

# --- Заглушка docker ---------------------------------------------------------------------------
# Память стенда: $STUB/containers (имя<TAB>образ), $STUB/bots (число ботов, пока образ documents в
# lock боя новый и STUB_BREAK=1 - ноль), журнал вызовов в $DOCKER_LOG.
BIN="$TMP/bin"
mkdir -p "$BIN"
cat >"$BIN/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$DOCKER_LOG"
set_image() { # set_image <имя> <образ>: заменить или добавить строку контейнера
  grep -v "^$1"$'\t' "$STUB/containers" >"$STUB/containers.n" || true
  printf '%s\t%s\n' "$1" "$2" >>"$STUB/containers.n"
  mv "$STUB/containers.n" "$STUB/containers"
}
lock_ref() { grep -E "^$2=" "$1" | head -1 | cut -d= -f2-; }
case "$1" in
  compose)
    case " $* " in
      *" version "*) echo "2.40.3" ;;
      *" config "*"--format json"*) echo '{"services":{"documents":{"environment":{}}}}' ;;
      *" config "*) exit "${STUB_CONFIG_RC:-0}" ;;
      *" up "*)
        touch "$STUB/started"
        lock="$(printf '%s\n' "$@" | grep -m1 'images.lock$')"
        svc="${*: -1}"
        case "$svc" in
          documents) set_image "p-documents-1" "$(lock_ref "$lock" BAI_IMAGE_DOCUMENTS)" ;;
          alloy) set_image "p-alloy-1" "$(lock_ref "$lock" BAI_IMAGE_ALLOY)" ;;
          app) set_image "p-app-1" "$(lock_ref "$lock" BAI_IMAGE_APP)" ;;
          documents-legacy) set_image "p-documents-legacy-1" "pragmatika-documents:legacy-docx" ;;
          documents-router) set_image "p-documents-router-1" "nginx@sha256:router" ;;
        esac ;;
    esac ;;
  ps)
    if [[ "$*" == *"name=^"* ]]; then echo abc123; exit 0; fi
    svc="$(printf '%s\n' "$@" | sed -n 's/^label=com.docker.compose.service=//p')"
    if [[ -n "$svc" ]]; then
      cut -f1 "$STUB/containers" | grep -x "p-$svc-1" || true
    else
      cut -f1 "$STUB/containers"
    fi ;;
  inspect)
    name="${*: -1}"
    img="$(grep "^$name"$'\t' "$STUB/containers" | cut -f2 || true)"
    case "$*" in
      *"{{.Config.Image}}"*) [[ -n "$img" ]] && echo "$img" || exit 1 ;;
      *"{{.Image}}"*) [[ -n "$img" ]] || exit 1
        echo "sha256:id-$(printf '%s' "$img" | tr -c 'a-z0-9' '-')" ;;
      *"HostConfig.Memory"*) echo "${STUB_ALLOY_MEM:-469762048}" ;;
      *"RestartCount"*) echo 0 ;;
      *"State.Status"*) [[ -n "$img" ]] && echo running || exit 1 ;;
      *"State.Health"*) [[ -n "$img" ]] && echo healthy || echo отсутствует ;;
    esac ;;
  image)
    if [[ "$2" == inspect && "$*" == *"{{.Id}}"* ]]; then
      echo "sha256:id-$(printf '%s' "${*: -1}" | tr -c 'a-z0-9' '-')"
    fi ;;
  info) echo "$TMP_DOCKER_ROOT" ;;
  stop) ;;
  rm) grep -v "^$2"$'\t' "$STUB/containers" >"$STUB/containers.n" || true
      mv "$STUB/containers.n" "$STUB/containers" ;;
  run)
    if [[ "$*" == *"bun"* ]]; then
      new="$(lock_ref "$STUB_LIVE_LOCK" BAI_IMAGE_DOCUMENTS)"
      if [[ "${STUB_BREAK:-0}" == 1 && "$new" == *"$H_NEW_DOCS"* ]]; then bots=0; else bots=4; fi
      [[ "${STUB_NO_READY:-0}" != 1 ]] || { echo "app недоступен"; exit 1; }
      # Откат не удался: после первого пересоздания app больше не отвечает
      if [[ "${STUB_STUCK:-0}" == 1 && -e "$STUB/started" ]]; then echo "app недоступен"; exit 1; fi
      echo "200 {\"bots\":{\"ready\":$bots}}"
    elif [[ "$*" == *"--entrypoint python"* ]]; then
      echo "OK amend"; echo "result=${STUB_SMOKE:-OK}"
      [[ "${STUB_SMOKE:-OK}" == OK ]] || exit 1
    fi ;;
esac
exit 0
STUB
chmod +x "$BIN/docker"

# --- Боевое дерево, пакет и заглушки инструментов ------------------------------------------------
LIVE="$TMP/opt/pragmatika-v2/deploy"
PKG="$TMP/pkg"
mkdir -p "$LIVE/platform" "$LIVE/hotfix" "$PKG/deploy/platform" "$PKG/tools"
write_lock() { # write_lock <файл> <образ documents> <версия>
  {
    echo "BAI_VERSION=$3"
    echo "BAI_IMAGE_APP=r/app@sha256:$H_APP"
    echo "BAI_IMAGE_ALLOY=r/alloy@sha256:$H_ALLOY"
    echo "BAI_IMAGE_MASK=r/mask@sha256:$H_MASK"
    echo "BAI_IMAGE_DOCUMENTS=$2"
  } >"$1"
}
OLD_DOCS="r/bai-documents@sha256:$H_OLD_DOCS"
NEW_DOCS="r/pragmatika-documents@sha256:$H_NEW_DOCS"
write_lock "$LIVE/images.lock" "$OLD_DOCS" "1.1.3-pragmatika.1"
write_lock "$PKG/images.lock" "$NEW_DOCS" "1.1.3-pragmatika.2"
echo "BAI_IMAGE_DOCUMENTS_BASE=r/bai-documents@sha256:$H_BASE" >>"$PKG/images.lock"
echo "services: {}" >"$LIVE/compose.yml"
printf 'services: {}\n' >"$LIVE/compose.project.yml"
printf 'services: {}\n# alloy mem_limit: 320m\n' >"$LIVE/compose.project.yml"
printf 'services: {}\n# alloy mem_limit: 448m\n' >"$PKG/deploy/compose.project.yml"
echo "POSTGRES_USER=pragmatika" >"$LIVE/.env"
echo "MASK_TOKEN=live-secret-token-0123456789" >"$LIVE/secrets.mask.env"
echo "#!/bin/true" >"$LIVE/hotfix/dc-v2.sh"
echo "services: {}" >"$LIVE/$(printf 'hotfix/compose.hotfix-docx.yml')"
date -u +%FT%TZ >"$LIVE/.cutover-deployed"
cp "$ROOT/deploy/cutover/lib.sh" "$PKG/lib.sh"
cp "$SRC/patch.sh" "$PKG/patch.sh"
cp "$SRC/smoke_contract.py" "$PKG/smoke_contract.py"
cp "$ROOT/tools/route-flags.tsv" "$PKG/tools/route-flags.tsv"
printf 'documents\tPOST\t/docx/amend\troute\n' >"$PKG/routes.tsv"
# Заглушки проверок маршрутов: код задаёт файл (0 - успех), настоящие скрипты тестируются отдельно.
for f in check-routes.sh check-image-routes.sh; do
  upper="$(echo "$f" | tr 'a-z.-' 'A-Z__')"
  printf '#!/usr/bin/env bash\necho "[%s] ok"\n' "$f" >"$PKG/tools/$f"
  printf 'exit "$(cat "$STUB_ROUTES_RC_%s" 2>/dev/null || echo 0)"\n' "$upper" >>"$PKG/tools/$f"
  chmod +x "$PKG/tools/$f"
done
echo "public-key" >"$PKG/cosign.pub"
LOCK_PUB_SHA="$(sha256sum "$PKG/cosign.pub" | cut -d' ' -f1)"

make_sigs() { # make_sigs <файл> <result>: подтверждение подписей по lock пакета
  local key ref
  printf '# verify-signatures v1\nlock_sha256=%s\npubkey_sha256=%s\ncosign=v3\n' \
    "$(sha256sum "$PKG/images.lock" | cut -d' ' -f1)" "$LOCK_PUB_SHA" >"$1"
  printf 'verified_at=2026-11-17T08:00:00Z\n' >>"$1"
  while IFS='=' read -r key ref; do
    [[ "$key" == BAI_IMAGE_* ]] || continue
    printf 'image\t%s\t%s\tOK\n' "$key" "$ref" >>"$1"
  done <"$PKG/images.lock"
  printf 'result=%s\n' "$2" >>"$1"
}
make_sigs "$PKG/signatures.txt" OK
seal() { (cd "$PKG" && find . -type f ! -name MANIFEST.sha256 | sort | sed 's|^\./||' \
  | xargs -d '\n' sha256sum >MANIFEST.sha256); }
seal

reset_stand() { # reset_stand: контейнеры боя до патча (с обходом), счётчики вызовов
  STUB="$TMP/stub"
  rm -rf "${STUB:?}"
  mkdir -p "$STUB"
  printf '%s\t%s\n' "p-documents-1" "$OLD_DOCS" "p-alloy-1" "r/alloy@sha256:$H_ALLOY" \
    "p-app-1" "r/app@sha256:$H_APP" "p-documents-legacy-1" "pragmatika-documents:legacy-docx" \
    "p-documents-router-1" "nginx@sha256:router" >"$STUB/containers"
  write_lock "$LIVE/images.lock" "$OLD_DOCS" "1.1.3-pragmatika.1"
  printf 'services: {}\n# alloy mem_limit: 320m\n' >"$LIVE/compose.project.yml"
}

# run <имя> [аргументы patch.sh]: изолированный $HOME; код в RC, вывод в $TMP/out-<имя>.
run() {
  local name="$1"
  shift
  : >"$TMP/docker-$name.log"
  mkdir -p "$TMP/home-$name"
  RC=0
  env HOME="$TMP/home-$name" PATH="$BIN:$PATH" DOCKER_LOG="$TMP/docker-$name.log" STUB="$STUB" \
    TMP_DOCKER_ROOT="$TMP" STUB_LIVE_LOCK="$LIVE/images.lock" H_NEW_DOCS="$H_NEW_DOCS" \
    CUTOVER_COSIGN=/nonexistent-cosign CUTOVER_NEW_DIR="$TMP/opt/pragmatika-v2" \
    CUTOVER_PROJECT=p CUTOVER_APP_CONTAINER=p-app-1 CUTOVER_ENV_FILE="$TMP/none.env" \
    CUTOVER_READY_WAIT_S=3 CUTOVER_POLL_S=1 CUTOVER_HEALTH_WAIT_S=3 PATCH_MIN_DISK_MIB=1 \
    PATCH_MIN_AVAILABLE_MIB=1 PATCH_SOAK_POLL_S=1 \
    bash "${PKG_RUN:-$PKG}/patch.sh" --soak-seconds 2 "$@" >"$TMP/out-$name" 2>&1 || RC=$?
}
no_mutation() { ! grep -E "$MUTATING_RE" "$TMP/docker-$1.log" | grep -qv '^compose version'; }
out_has() { grep -q -- "$2" "$TMP/out-$1"; }

assert "patch.sh на месте" "[[ -f '$SRC/patch.sh' ]]"
reset_stand

# 1. Отказы по предусловиям: бой не тронут (ни stop/rm/pull/compose up).
echo "tamper" >>"$PKG/routes.tsv"
run manifest
assert "MANIFEST не сходится - код 3" "[[ $RC -eq $EXIT_REFUSED ]]"
assert "MANIFEST: бой не тронут" "no_mutation manifest"
printf 'documents\tPOST\t/docx/amend\troute\n' >"$PKG/routes.tsv"
seal

mv "$PKG/signatures.txt" "$TMP/signatures.keep"
seal
run nosig
assert "нет подтверждения подписей и cosign - код 3" "[[ $RC -eq $EXIT_REFUSED ]]"
assert "нет подписей: сообщение называет signatures" "out_has nosig 'signatures'"
assert "нет подписей: бой не тронут" "no_mutation nosig"
make_sigs "$PKG/signatures.txt" FAIL
seal
run sigfail
assert "подписи result=FAIL - код 3" "[[ $RC -eq $EXIT_REFUSED ]]"
cp "$TMP/signatures.keep" "$PKG/signatures.txt"
seal

cp "$PKG/images.lock" "$TMP/lock.keep"
sed -i "s|^BAI_IMAGE_APP=.*|BAI_IMAGE_APP=r/app@sha256:$H_MASK|" "$PKG/images.lock"
make_sigs "$PKG/signatures.txt" OK
seal
run applock
assert "lock меняет образ app - код 3" "[[ $RC -eq $EXIT_REFUSED ]]"
assert "образ app: сообщение называет ключ" "out_has applock 'BAI_IMAGE_APP'"
assert "образ app: бой не тронут" "no_mutation applock"
cp "$TMP/lock.keep" "$PKG/images.lock"
make_sigs "$PKG/signatures.txt" OK
seal

mkdir -p "$PKG/db"
seal
run withdb
assert "в патче есть db - код 3" "[[ $RC -eq $EXIT_REFUSED ]]"
rm -rf "${PKG:?}/db"
seal

echo "x" >"$PKG/deploy/.env"
seal
run foreignfile
assert "файл вне списка замены - код 3" "[[ $RC -eq $EXIT_REFUSED ]]"
assert "чужой файл: бой не тронут" "no_mutation foreignfile"
rm -f "$PKG/deploy/.env"
seal

rm -f "$LIVE/.cutover-deployed"
run nomark
assert "дерево создано не cutover.sh - код 3" "[[ $RC -eq $EXIT_REFUSED ]]"
date -u +%FT%TZ >"$LIVE/.cutover-deployed"

printf '1\n' >"$TMP/rc-image"
STUB_ROUTES_RC_CHECK_IMAGE_ROUTES_SH="$TMP/rc-image" run imageroutes
assert "образ без маршрутов - код 3 до замены" "[[ $RC -eq $EXIT_REFUSED ]]"
assert "образ без маршрутов: бой не тронут" "no_mutation imageroutes"
assert "образ без маршрутов: файл дерева прежний" "grep -q '320m' '$LIVE/compose.project.yml'"

STUB_CONFIG_RC=1 run badconfig
assert "compose config не принял - код 3" "[[ $RC -eq $EXIT_REFUSED ]]"

STUB_NO_READY=1 run noready
assert "бой нездоров (/ready) - код 3" "[[ $RC -eq $EXIT_REFUSED ]]"
assert "бой нездоров: бой не тронут" "no_mutation noready"

# 2. --preflight-only: код 0, ничего не менялось.
run preflight --preflight-only
assert "--preflight-only - код 0" "[[ $RC -eq 0 ]]"
assert "--preflight-only: бой не тронут" "no_mutation preflight"
assert "--preflight-only: lock боя прежний" "grep -q '$OLD_DOCS' '$LIVE/images.lock'"
assert "--preflight-only: файл compose боя прежний" "grep -q '320m' '$LIVE/compose.project.yml'"
assert "--preflight-only: бэкап не создан" "! compgen -G '$TMP/home-preflight/backups/*'"

# 3. Успех: файлы заменены, пересозданы сервисы по порядку, обход снят, тег legacy-docx цел.
reset_stand
run apply
assert "успех: код 0" "[[ $RC -eq 0 ]]"
assert "успех: lock боя новый" "grep -q '$NEW_DOCS' '$LIVE/images.lock'"
assert "успех: compose.project.yml новый (448m)" "grep -q '448m' '$LIVE/compose.project.yml'"
assert "успех: бэкап deploy на месте с прежним lock" \
  "grep -q '$OLD_DOCS' '$TMP'/home-apply/backups/pragmatika-patch-*/deploy/images.lock"
assert "успех: бэкап хранит прежний compose.project.yml" \
  "grep -q '320m' '$TMP'/home-apply/backups/pragmatika-patch-*/deploy/compose.project.yml"
assert "успех: пересоздание по порядку documents -> alloy -> app" \
  "grep -E '^compose .* up -d --no-deps (documents|alloy|app)\$' '$TMP/docker-apply.log' \
   | sed 's/.* //' | tr '\n' ' ' | grep -qx 'documents alloy app '"
assert "успех: БЕЗ compose down и БЕЗ --remove-orphans" \
  "! grep -E ' (down|--remove-orphans)( |\$)' '$TMP/docker-apply.log'"
assert "успех: контейнеры обхода остановлены и удалены" \
  "grep -q '^rm p-documents-router-1' '$TMP/docker-apply.log' \
   && grep -q '^rm p-documents-legacy-1' '$TMP/docker-apply.log'"
assert "успех: обхода больше нет" "! grep -q 'router\\|legacy' '$STUB/containers'"
assert "успех: образ и тег legacy-docx не трогались" \
  "! grep -qE '^(rmi|image rm|image prune|tag|untag)' '$TMP/docker-apply.log'"
assert "успех: documents работает на новом образе" "grep -q '$NEW_DOCS' '$STUB/containers'"
assert "успех: смоук запущен до и после снятия обхода" \
  "[[ \$(grep -c 'entrypoint python' '$TMP/docker-apply.log') -eq 2 ]]"
assert "успех: архив результатов создан" "compgen -G '$TMP/home-apply/patch-*.tgz'"
assert "успех: токен не попал в журнал" \
  "! grep -rq 'live-secret-token-0123456789' '$TMP/home-apply' --include='*.log' --include='*.tsv'"

# 4. Повторный запуск того же патча: нечего применять - код 3.
run again
assert "повтор того же патча - код 3 (нечего применять)" "[[ $RC -eq $EXIT_REFUSED ]]"
assert "повтор: сообщение «нечего применять»" "out_has again 'нечего применять'"

# 5. Сбой после замены (бот не вернулся): автооткат, файлы из бэкапа, обход на месте, код 1.
reset_stand
STUB_BREAK=1 run broken
assert "сбой после замены: код 1 (откат выполнен)" "[[ $RC -eq $EXIT_FAILED ]]"
assert "откат: автоматический откат запущен" "out_has broken 'автоматический откат'"
assert "откат: lock боя прежний" "grep -q '$OLD_DOCS' '$LIVE/images.lock'"
assert "откат: compose.project.yml прежний (320m)" "grep -q '320m' '$LIVE/compose.project.yml'"
assert "откат: поднят обход (documents-router и documents-legacy)" \
  "grep -q 'up -d --no-deps documents-router' '$TMP/docker-broken.log' \
   && grep -q 'up -d --no-deps documents-legacy' '$TMP/docker-broken.log'"
assert "откат: обход подключён вторым compose-файлом hotfix" \
  "grep -q 'hotfix/compose.hotfix-docx.yml' '$TMP/docker-broken.log'"
assert "откат: documents снова на прежнем образе" "grep -q '$OLD_DOCS' '$STUB/containers'"
assert "откат: контейнеры обхода на месте" \
  "grep -q 'p-documents-router-1' '$STUB/containers' \
   && grep -q 'p-documents-legacy-1' '$STUB/containers'"
assert "откат: тег legacy-docx не удалялся" \
  "! grep -qE '^(rmi|image rm|tag|untag)' '$TMP/docker-broken.log'"

# 6. Сбой смоука и маршрутов стека также ведут к откату.
reset_stand
STUB_SMOKE=FAIL run smokefail
assert "смоук договора красный: код 1 и откат" \
  "[[ $RC -eq $EXIT_FAILED ]] && grep -q '$OLD_DOCS' '$LIVE/images.lock'"
reset_stand
printf '1\n' >"$TMP/rc-stack"
STUB_ROUTES_RC_CHECK_ROUTES_SH="$TMP/rc-stack" run routesfail
assert "маршруты стека красные: код 1 и откат" \
  "[[ $RC -eq $EXIT_FAILED ]] && grep -q '$OLD_DOCS' '$LIVE/images.lock'"
reset_stand
STUB_ALLOY_MEM=335544320 run alloymem
assert "лимит alloy не 448 МиБ: код 1 и откат" \
  "[[ $RC -eq $EXIT_FAILED ]] && grep -q '320m' '$LIVE/compose.project.yml'"

# 7. Откат не удался: стенд не приходит в /ready - код 4.
reset_stand
STUB_STUCK=1 run stuck
assert "откат не удался (/ready не отвечает после замены): код 4" "[[ $RC -eq $EXIT_STUCK ]]"
assert "откат не удался: файлы дерева всё равно возвращены" \
  "grep -q '$OLD_DOCS' '$LIVE/images.lock'"
assert "откат не удался: сообщение о ручном вмешательстве" "out_has stuck 'ОТКАТ НЕ УДАЛСЯ'"

# 8. Ручной откат: patch.sh --rollback по каталогу успешного запуска возвращает дерево.
reset_stand
run manual_apply
assert "ручной откат: исходный запуск успешен" "[[ $RC -eq 0 ]]"
rundir="$(readlink -f "$TMP/home-manual_apply/.pragmatika-cutover/patch-latest")"
run manual_rollback --rollback --run-dir "$rundir"
assert "ручной откат - код 0" "[[ $RC -eq 0 ]]"
assert "ручной откат: lock боя прежний" "grep -q '$OLD_DOCS' '$LIVE/images.lock'"
assert "ручной откат: обход поднят снова" \
  "grep -q 'p-documents-router-1' '$STUB/containers' \
   && grep -q 'p-documents-legacy-1' '$STUB/containers'"
run badargs --preflight-only --rollback
assert "--preflight-only и --rollback вместе - код 2" "[[ $RC -eq $EXIT_USAGE ]]"
run unknownarg --nonsense
assert "неизвестный аргумент - код 2" "[[ $RC -eq $EXIT_USAGE ]]"

# 9. Стиль.
assert "строки patch.sh до $LIMIT знаков" \
  "! LC_ALL=C.UTF-8 awk 'length > $LIMIT' '$SRC/patch.sh' | grep -q ."
assert "строки теста до $LIMIT знаков" "! LC_ALL=C.UTF-8 awk 'length > $LIMIT' '$0' | grep -q ."
assert "patch.sh: set -euo pipefail" "grep -q '^set -euo pipefail' '$SRC/patch.sh'"
assert "в patch.sh нет sudo и curl|sh" \
  "! grep -nE 'curl[^|]*\\| *(ba)?sh|^[^#]*\\bsudo\\b' '$SRC/patch.sh'"
assert "patch.sh не трогает БД и миграции (нет migrate, psql, pg_dump)" \
  "! grep -vE '^[[:space:]]*#' '$SRC/patch.sh' | grep -qE 'migrate|psql|pg_dump'"
assert "patch.sh не удаляет образы и теги (нет rmi, image rm, tag)" \
  "! grep -vE '^[[:space:]]*#' '$SRC/patch.sh' | grep -qE 'docker (rmi|image rm|tag|image prune)'"
assert "smoke_contract.py: нет реальных ФИО и реквизитов (синтетика)" \
  "! grep -qE '[0-9]{20}' '$SRC/smoke_contract.py' || grep -q 'Смоук' '$SRC/smoke_contract.py'"

echo "проверок: $((PASS + FAIL)), провалено: $FAIL"
[[ "$FAIL" -eq 0 ]]
