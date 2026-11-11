#!/usr/bin/env bash
# Тест tools/build-app-image.sh на заглушках docker, cosign и trivy: настоящих сборок, реестров
# и подписей нет. Заглушки лежат во временном PATH, пишут свои вызовы в файл и отдают
# заготовленный вывод push с digest. Проект - временный git-репозиторий с минимальными файлами.
#
#   bash tools/build-app-image.test.sh
#
# Проверяет: аргументы сборки и метки, контекст из HEAD, содержимое lock-out, строгий разбор
# base lock, отказ для облачного реестра, правила --sign (legacy-флаги, проверка подписи после
# подписи, сбои), отсутствие пароля в выводе и журнале, поведение без --push.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/build-app-image.sh"
WORK="$(mktemp -d)"
FAILED=0
CHECKS=0
trap 'rm -rf "${WORK:?}"' EXIT

# Предельная длина строки в исходниках и длина hex-digest.
readonly MAX_LINE=100
readonly HEX_LEN=64
readonly REVISION_LEN=12
readonly PASSWORD_MARKER="SECRET_PASSWORD_MARKER_qwerty"
readonly FOREIGN_MARKER="FOREIGN_CONTENT_MARKER_zxcv"

check() {
  local name="$1" expected="$2" actual="$3"
  CHECKS=$((CHECKS + 1))
  if [[ "$expected" == "$actual" ]]; then
    echo "PASS $name"
  else
    echo "FAIL $name: ожидалось '$expected', получено '$actual'"
    FAILED=$((FAILED + 1))
  fi
}

# Число строк файла, подходящих под шаблон (0, если файла нет).
count() {
  local flags=()
  if [[ "$1" == -E ]]; then
    flags=(-E)
    shift
  fi
  local pattern="$1" file="$2"
  [[ -f "$file" ]] || { echo 0; return 0; }
  grep -c ${flags[@]+"${flags[@]}"} -e "$pattern" -- "$file" || true
}
exists() { [[ -e "$1" ]] && echo 1 || echo 0; }

# --- заглушки --------------------------------------------------------------------------------
STUBS="$WORK/stubs"
CALLS="$WORK/calls.log"
LISTING="$WORK/context-listing.txt"
CTX_MAIN="$WORK/context-main.ts"
mkdir -p "$STUBS"
cat >"$STUBS/docker" <<'EOF'
#!/usr/bin/env bash
echo "docker $*" >>"$CALLS"
case "$1" in
  build)
    # Последний аргумент - каталог контекста: снимаем его состав до удаления скриптом.
    ctx="${*: -1}"
    (cd "$ctx" && find . -type f | sort) >"$LISTING"
    cp "$ctx/src/main.ts" "$CTX_MAIN" 2>/dev/null || true
    [[ "${FAKE_BUILD_FAIL:-0}" == "1" ]] && exit 1
    ;;
  push)
    [[ "${FAKE_PUSH_NO_DIGEST:-0}" == "1" ]] && { echo "pushed"; exit 0; }
    # digest зависит от ссылки без тега, как у настоящего реестра по образу.
    h="$(printf '%s' "${2%:*}" | sha256sum | cut -c1-64)"
    echo "The push refers to repository"
    echo "${2##*:}: digest: sha256:$h size: 100"
    ;;
esac
exit 0
EOF
cat >"$STUBS/cosign" <<'EOF'
#!/usr/bin/env bash
echo "cosign $*" >>"$CALLS"
echo "password_present=${COSIGN_PASSWORD:+yes}" >>"$CALLS"
[[ "$1" == "sign" && "${FAKE_SIGN_FAIL:-0}" == "1" ]] && { echo "sign failed" >&2; exit 1; }
[[ "$1" == "verify" && "${FAKE_VERIFY_FAIL:-0}" == "1" ]] && { echo "bad sig" >&2; exit 1; }
exit 0
EOF
cat >"$STUBS/trivy" <<'EOF'
#!/usr/bin/env bash
echo "trivy $*" >>"$CALLS"
[[ "${FAKE_TRIVY_FAIL:-0}" == "1" ]] && exit 1
out=""
while (($#)); do
  [[ "$1" == "--output" ]] && out="$2"
  shift
done
[[ -z "$out" ]] || printf 'HIGH CVE-0000-0001\nCRITICAL CVE-0000-0002\nHIGH CVE-0000-0003\n' >"$out"
exit 0
EOF
chmod +x "$STUBS"/*

KEYDIR="$WORK/keys"
mkdir -p "$KEYDIR"
echo "fake-key" >"$KEYDIR/cosign.key"
echo "fake-pub" >"$KEYDIR/cosign.pub"
echo "$PASSWORD_MARKER" >"$KEYDIR/cosign.password"

# --- проект: временный git-репозиторий -------------------------------------------------------
PROJ="$WORK/project"
mkdir -p "$PROJ/src" "$PROJ/db/app" "$PROJ/deploy/docker"
echo '{"name":"proj","private":true}' >"$PROJ/package.json"
echo 'export const committed = 1;' >"$PROJ/src/main.ts"
echo 'SELECT 1;' >"$PROJ/db/app/001_base.sql"
echo 'FROM scratch' >"$PROJ/deploy/docker/project-app.Dockerfile"
IGNORE_FILE="$PROJ/deploy/docker/project-app.Dockerfile.dockerignore"
printf '*\n!package.json\n!src/\n!src/**\n!db/\n!db/app/\n!db/app/**\n' >"$IGNORE_FILE"
echo 'вне контекста' >"$PROJ/README.md"
git -C "$PROJ" init -q
git -C "$PROJ" add -A
git -C "$PROJ" -c user.name=test -c user.email=test@example.test commit -q -m "initial"
HEAD_REV="$(git -C "$PROJ" rev-parse HEAD | cut -c1-"$REVISION_LEN")"
# Незакоммиченное: неотслеженный файл и правка отслеженного не должны попасть в контекст.
echo 'export const uncommitted = 1;' >"$PROJ/src/uncommitted.ts"
echo 'export const dirty = 1;' >"$PROJ/src/main.ts"

# --- lock платформы --------------------------------------------------------------------------
hex() { printf "$1%.0s" $(seq 1 "$HEX_LEN"); }
DG_ALLOY="sha256:$(hex a)"
DG_BASE="sha256:$(hex b)"
DG_OLDAPP="sha256:$(hex c)"
DG_DOCS="sha256:$(hex d)"
DG_PG="sha256:$(hex e)"
REG_LOCAL="127.0.0.1:25000/bai"
BASE_REF="$REG_LOCAL/bai-app-base@$DG_BASE"

# Корректный lock платформы; ключи нарочно не по алфавиту, в нём уже есть старый APP.
write_base_lock() {
  local file="$1" reg="${2:-$REG_LOCAL}"
  {
    echo "# lock платформы"
    echo "BAI_VERSION=1.0.0"
    echo
    echo "BAI_IMAGE_POSTGRES=$reg/pgvector@$DG_PG"
    echo "BAI_IMAGE_APP_BASE=$reg/bai-app-base@$DG_BASE"
    echo "BAI_IMAGE_APP=$reg/old-app@$DG_OLDAPP"
    echo "BAI_IMAGE_DOCUMENTS=$reg/bai-documents@$DG_DOCS"
    echo "BAI_IMAGE_ALLOY=$reg/alloy@$DG_ALLOY"
  } >"$file"
}
BASE_LOCK="$WORK/base.lock"
write_base_lock "$BASE_LOCK"
LOCK_OUT="$WORK/out/project.lock"

# Чистое окружение: переменные задаёт только вызывающий проверку.
unset BAI_STAGE BAI_COSIGN_LEGACY BAI_ALLOW_CLOUD_REGISTRY BAI_APP_IMAGE_NAME \
  BAI_SIGNING_PUBKEY BAI_SIGNING_PASSWORD_FILE FAKE_BUILD_FAIL FAKE_PUSH_NO_DIGEST \
  FAKE_SIGN_FAIL FAKE_VERIFY_FAIL FAKE_TRIVY_FAIL
export CALLS LISTING CTX_MAIN
: >"$WORK/all-out.txt"
: >"$WORK/all-calls.txt"

# Запуск скрипта с заглушками; печатает код выхода. Вывод - $WORK/out.txt.
run() {
  : >"$CALLS"
  local rc=0
  PATH="$STUBS:$PATH" BAI_PROJECT_DIR="$PROJ" BAI_BUILD_DIR="$WORK/build" \
    BAI_SIGNING_KEY="${BAI_SIGNING_KEY:-$KEYDIR/cosign.key}" \
    bash "$SCRIPT" "$@" >"$WORK/out.txt" 2>&1 || rc=$?
  cat "$WORK/out.txt" >>"$WORK/all-out.txt"
  cat "$CALLS" >>"$WORK/all-calls.txt"
  echo "$rc"
}
# Типовой вызов: версия и два обязательных файла плюс дополнительные аргументы.
run_std() {
  local version="$1"
  shift
  run "$version" --base-lock "$BASE_LOCK" --lock-out "$LOCK_OUT" "$@"
}
reset_out() { rm -rf "${WORK:?}/out"; }

check "скрипт существует" 1 "$(exists "$SCRIPT")"

# --- неверный вызов --------------------------------------------------------------------------
check "без аргументов: код 2" 2 "$(run)"
check "неверная версия: код 2" 2 "$(run_std 'bad version!')"
check "версия с начальной точкой: код 2" 2 "$(run_std '.1')"
check "без --base-lock: код 2" 2 "$(run 1.0.0 --lock-out "$LOCK_OUT")"
check "без --lock-out: код 2" 2 "$(run 1.0.0 --base-lock "$BASE_LOCK")"
check "неизвестный ключ: код 2" 2 "$(run_std 1.0.0 --frob)"
check "--registry без значения: код 2" 2 "$(run_std 1.0.0 --registry)"
check "два позиционных аргумента: код 2" 2 \
  "$(run 1.0.0 2.0.0 --base-lock "$BASE_LOCK" --lock-out "$LOCK_OUT")"
check "--help: код 0" 0 "$(run --help)"
check "--lock-out совпадает с --base-lock: код 2" 2 \
  "$(run 1.0.0 --base-lock "$BASE_LOCK" --lock-out "$BASE_LOCK" --push)"
check "ошибки вызова: docker не вызывался" 0 "$(count '^docker' "$WORK/all-calls.txt")"

# --- сборка без публикации: аргументы, метки, контекст из HEAD -------------------------------
reset_out
check "сборка без --push: код 0" 0 "$(run_std 1.2.3)"
check "сборка: docker build вызван" 1 "$(count '^docker build' "$CALLS")"
check "сборка: BAI_APP_BASE из base lock" 1 \
  "$(grep '^docker build' "$CALLS" | grep -cF -- "--build-arg BAI_APP_BASE=$BASE_REF" || true)"
check "сборка: локальный тег pragmatika-app:1.2.3" 1 \
  "$(grep '^docker build' "$CALLS" | grep -cF -- '-t pragmatika-app:1.2.3' || true)"
for label in \
  "org.opencontainers.image.title=pragmatika-app" \
  "org.opencontainers.image.version=1.2.3" \
  "org.opencontainers.image.revision=$HEAD_REV" \
  "org.opencontainers.image.licenses=LicenseRef-Proprietary" \
  "bai.stage=7" \
  "bai.version=1.2.3"; do
  check "метка $label" 1 \
    "$(grep '^docker build' "$CALLS" | grep -cF -- "--label=$label" || true)"
done
check "метка created (UTC)" 1 \
  "$(grep '^docker build' "$CALLS" \
    | grep -cE -- '--label=org.opencontainers.image.created=[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]+Z' \
    || true)"
check "Dockerfile из контекста" 1 \
  "$(grep '^docker build' "$CALLS" | grep -cE -- '-f [^ ]+/deploy/docker/project-app\.Dockerfile ' \
    || true)"
check "контекст: package.json из HEAD" 1 "$(count '^\./package.json$' "$LISTING")"
check "контекст: src/main.ts из HEAD" 1 "$(count '^\./src/main.ts$' "$LISTING")"
check "контекст: миграции db/app из HEAD" 1 "$(count '^\./db/app/001_base.sql$' "$LISTING")"
check "контекст: Dockerfile и .dockerignore" 2 \
  "$(count '^\./deploy/docker/project-app.Dockerfile' "$LISTING")"
check "контекст: неотслеженный файл не попал" 0 "$(count 'uncommitted' "$LISTING")"
check "контекст: правка отслеженного файла не попала" 1 "$(count 'committed = 1' "$CTX_MAIN")"
check "контекст: файлы вне списка не попали" 0 "$(count 'README' "$LISTING")"
check "контекст: временный каталог убран" 0 \
  "$(find "$WORK/build" -maxdepth 1 -name 'context.*' | wc -l)"
check "метка bai.stage из BAI_STAGE" 1 \
  "$(BAI_STAGE=9 run_std 1.2.3 >/dev/null; grep '^docker build' "$CALLS" \
    | grep -cF -- '--label=bai.stage=9' || true)"
check "без --push: push не вызывался" 0 "$(count '^docker push' "$CALLS")"
check "без --push: lock-out не создан" 0 "$(exists "$LOCK_OUT")"
check "без --push: объяснение в выводе" 1 "$(count 'digest реестра неизвестен' "$WORK/out.txt")"
check "без --push: trivy и cosign не вызывались" 0 "$(count -E '^(trivy|cosign)' "$CALLS")"
check "журнал сборки создан" 1 "$(exists "$WORK/build/build-1.2.3.log")"

# --- публикация и lock-out -------------------------------------------------------------------
reset_out
check "--push: код 0" 0 "$(run_std 1.2.3 --push --no-scan)"
EXPECT_DG="sha256:$(printf '%s' "$REG_LOCAL/pragmatika-app" | sha256sum | cut -c1-64)"
check "--push: реестр из base lock" 1 \
  "$(grep '^docker push' "$CALLS" | grep -cF -- "$REG_LOCAL/pragmatika-app:1.2.3" || true)"
check "lock-out создан" 1 "$(exists "$LOCK_OUT")"
check "lock-out: права 644" 644 "$(stat -c %a "$LOCK_OUT" 2>/dev/null || echo none)"
check "lock-out: заголовок-комментарий" 1 "$(head -1 "$LOCK_OUT" | grep -c '^# ' || true)"
check "lock-out: BAI_VERSION новой версии" 1 "$(count '^BAI_VERSION=1.2.3$' "$LOCK_OUT")"
check "lock-out: BAI_VERSION платформы не остался" 0 "$(count '^BAI_VERSION=1.0.0$' "$LOCK_OUT")"
check "lock-out: новый APP по digest" 1 \
  "$(count "^BAI_IMAGE_APP=$REG_LOCAL/pragmatika-app@$EXPECT_DG\$" "$LOCK_OUT")"
check "lock-out: старый APP заменён" 0 "$(count 'old-app' "$LOCK_OUT")"
check "lock-out: APP ровно один" 1 "$(count '^BAI_IMAGE_APP=' "$LOCK_OUT")"
for key in ALLOY APP_BASE DOCUMENTS POSTGRES; do
  check "lock-out: ключ базы $key сохранён" 1 \
    "$(count -E "^BAI_IMAGE_$key=127\\.0\\.0\\.1:25000/bai/[a-z-]+@sha256:[0-9a-f]{64}\$" \
      "$LOCK_OUT")"
done
check "lock-out: значения базы не изменены" 1 \
  "$(count "^BAI_IMAGE_APP_BASE=$BASE_REF\$" "$LOCK_OUT")"
check "lock-out: ключи по алфавиту" "$(grep -o '^BAI_IMAGE_[A-Z_]*' "$LOCK_OUT" | LC_ALL=C sort)" \
  "$(grep -o '^BAI_IMAGE_[A-Z_]*' "$LOCK_OUT")"
check "lock-out: BAI_VERSION раньше образов" 1 \
  "$(grep -v '^#' "$LOCK_OUT" | head -1 | grep -c '^BAI_VERSION=' || true)"
check "lock-out: нет посторонних строк" 0 \
  "$(grep -vcE '^(#.*|BAI_VERSION=.*|BAI_IMAGE_[A-Z_]+=.*)$' "$LOCK_OUT" || true)"
check "lock-out: временных файлов нет" 0 "$(find "$WORK/out" -name '*.??????' | wc -l)"
# Результат пригоден как base lock (строгий разбор тем же кодом): повторная сборка поверх него.
BASE_LOCK_SAVE="$BASE_LOCK"
BASE_LOCK="$LOCK_OUT"
LOCK_OUT="$WORK/out/second.lock"
check "lock-out как base lock: код 0" 0 "$(run_std 1.2.4 --push --no-scan)"
check "lock-out как base lock: следующий lock создан" 1 "$(exists "$LOCK_OUT")"
BASE_LOCK="$BASE_LOCK_SAVE"
LOCK_OUT="$WORK/out/project.lock"

check "--registry переопределяет реестр" 0 \
  "$(run_std 1.2.5 --push --no-scan --registry 127.0.0.1:25001/other)"
check "--registry: тег в другом реестре" 1 \
  "$(grep '^docker push' "$CALLS" | grep -cF -- '127.0.0.1:25001/other/pragmatika-app:1.2.5' \
    || true)"
check "BAI_APP_IMAGE_NAME меняет имя в реестре" 1 \
  "$(BAI_APP_IMAGE_NAME=custom-app run_std 1.2.6 --push --no-scan >/dev/null; \
    grep '^docker push' "$CALLS" | grep -cF -- "$REG_LOCAL/custom-app:1.2.6" || true)"
check "push без digest в выводе: код 1" 1 "$(FAKE_PUSH_NO_DIGEST=1 run_std 1.2.7 --push)"
reset_out
check "сбой сборки: код 1" 1 "$(FAKE_BUILD_FAIL=1 run_std 1.2.8 --push)"
check "сбой сборки: push не вызывался" 0 "$(count '^docker push' "$CALLS")"
check "сбой сборки: lock-out не создан" 0 "$(exists "$LOCK_OUT")"

# --- плохие base lock: отказ без записи lock-out ---------------------------------------------
reset_out
bad_lock() {
  local name="$1" content="$2" code
  printf '%b' "$content" >"$WORK/bad.lock"
  BASE_LOCK_SAVE="$BASE_LOCK"
  BASE_LOCK="$WORK/bad.lock"
  : >"$CALLS"
  code="$(run_std 1.3.0 --push)"
  BASE_LOCK="$BASE_LOCK_SAVE"
  check "base lock: $name: код 2" 2 "$code"
  check "base lock: $name: lock-out не создан" 0 "$(exists "$LOCK_OUT")"
  check "base lock: $name: сборки не было" 0 "$(count '^docker build' "$CALLS")"
}
GOOD_BASE="BAI_VERSION=1.0.0\nBAI_IMAGE_APP_BASE=$BASE_REF\n"
bad_lock "тег вместо digest" "BAI_VERSION=1.0.0\nBAI_IMAGE_APP_BASE=$REG_LOCAL/bai-app-base:1.0.0\n"
bad_lock "повтор ключа" "${GOOD_BASE}BAI_IMAGE_APP_BASE=$BASE_REF\n"
bad_lock "нет BAI_IMAGE_APP_BASE" "BAI_VERSION=1.0.0\nBAI_IMAGE_ALLOY=$REG_LOCAL/alloy@$DG_ALLOY\n"
bad_lock "пробел на конце" "BAI_VERSION=1.0.0\nBAI_IMAGE_APP_BASE=$BASE_REF \n"
bad_lock "CRLF" "BAI_VERSION=1.0.0\r\nBAI_IMAGE_APP_BASE=$BASE_REF\r\n"
bad_lock "нет BAI_VERSION" "BAI_IMAGE_APP_BASE=$BASE_REF\n"
bad_lock "кавычки" "BAI_VERSION=1.0.0\nBAI_IMAGE_APP_BASE=\"$BASE_REF\"\n"
bad_lock "digest в верхнем регистре" \
  "BAI_VERSION=1.0.0\nBAI_IMAGE_APP_BASE=$REG_LOCAL/bai-app-base@sha256:$(hex B)\n"
bad_lock "чужой ключ" "${GOOD_BASE}FOREIGN_KEY=$FOREIGN_MARKER\n"
bad_lock "пустое значение" "${GOOD_BASE}BAI_IMAGE_ALLOY=\n"
bad_lock "пустой файл" ""
bad_lock "отступ перед комментарием" " # коммент\n$GOOD_BASE"
check "плохой base lock: содержимое не попало в вывод" 0 \
  "$(grep -c "$FOREIGN_MARKER" "$WORK/all-out.txt" || true)"
check "отсутствующий base lock: код 2" 2 \
  "$(run 1.3.0 --base-lock "$WORK/нет-файла.lock" --lock-out "$LOCK_OUT" --push)"
printf '%b' "$GOOD_BASE" >"$WORK/ok-min.lock"
BASE_LOCK_SAVE="$BASE_LOCK"
BASE_LOCK="$WORK/ok-min.lock"
check "минимальный корректный base lock: код 0" 0 "$(run_std 1.3.1 --push --no-scan)"
check "минимальный base lock: lock-out создан" 1 "$(exists "$LOCK_OUT")"
BASE_LOCK="$BASE_LOCK_SAVE"
reset_out

# --- облачный реестр (шлюз G2) ---------------------------------------------------------------
CLOUD_LOCK="$WORK/cloud.lock"
write_base_lock "$CLOUD_LOCK" "cr.yandex/crp0example"
BASE_LOCK_SAVE="$BASE_LOCK"
BASE_LOCK="$CLOUD_LOCK"
check "облачный реестр без разрешения: код 2" 2 "$(run_std 1.4.0 --push)"
check "облачный реестр: сборки и push не было" 0 "$(count -E '^docker (build|push)' "$CALLS")"
check "облачный реестр: lock-out не создан" 0 "$(exists "$LOCK_OUT")"
check "облачный реестр: объяснение G2" 1 "$(count 'G2' "$WORK/out.txt")"
check "облачный реестр через --registry: код 2" 2 \
  "$(BASE_LOCK="$BASE_LOCK_SAVE" run_std 1.4.0 --push --registry cr.yandex/crp0example)"
check "облачный реестр с BAI_ALLOW_CLOUD_REGISTRY=1: код 0" 0 \
  "$(BAI_ALLOW_CLOUD_REGISTRY=1 run_std 1.4.1 --push --no-scan)"
check "облачный реестр с разрешением: lock-out создан" 1 "$(exists "$LOCK_OUT")"
check "облачный реестр: сборка без --push не требует разрешения" 0 "$(run_std 1.4.2)"
BASE_LOCK="$BASE_LOCK_SAVE"
reset_out

# --- подпись ---------------------------------------------------------------------------------
check "--sign без --push: код 2" 2 "$(run_std 1.5.0 --sign)"
check "--sign без --push: сборки не было" 0 "$(count '^docker build' "$CALLS")"
check "--sign без ключа: код 2" 2 \
  "$(BAI_SIGNING_KEY="$WORK/нет-ключа" run_std 1.5.0 --push --sign)"
check "--sign без файла пароля: код 2" 2 \
  "$(BAI_SIGNING_PASSWORD_FILE="$WORK/нет-пароля" run_std 1.5.0 --push --sign)"
check "--sign без открытого ключа: код 2" 2 \
  "$(BAI_SIGNING_PUBKEY="$WORK/нет-pub" run_std 1.5.0 --push --sign)"
check "ошибки подписи до сборки: docker не вызывался" 0 "$(count '^docker' "$CALLS")"

check "--push --sign: код 0" 0 "$(run_std 1.5.1 --push --sign --no-scan)"
SIGN_REF="$REG_LOCAL/pragmatika-app@$EXPECT_DG"
check "cosign sign по digest" 1 \
  "$(grep '^cosign sign' "$CALLS" | grep -cF -- "$SIGN_REF" || true)"
check "cosign sign: тот же digest в lock" 1 "$(count "^BAI_IMAGE_APP=$SIGN_REF\$" "$LOCK_OUT")"
check "sign: без публичного журнала" 1 \
  "$(grep '^cosign sign' "$CALLS" | grep -c -- '--tlog-upload=false' || true)"
check "sign: --use-signing-config=false" 1 \
  "$(grep '^cosign sign' "$CALLS" | grep -c -- '--use-signing-config=false' || true)"
check "sign: аннотации bai-version и bai-image" 1 \
  "$(grep '^cosign sign' "$CALLS" | grep -c -- '-a bai-version=1.5.1 -a bai-image=pragmatika-app' \
    || true)"
check "sign: legacy --new-bundle-format=false" 1 \
  "$(grep '^cosign sign' "$CALLS" | grep -c -- '--new-bundle-format=false' || true)"
check "sign: legacy --registry-referrers-mode=legacy" 1 \
  "$(grep '^cosign sign' "$CALLS" | grep -c -- '--registry-referrers-mode=legacy' || true)"
check "sign: пароль передан окружением" 1 "$(count 'password_present=yes' "$CALLS")"
check "verify: пароль не нужен и не передаётся" 1 "$(count '^password_present=$' "$CALLS")"
check "sign: пароль не в аргументах" 0 "$(count "$PASSWORD_MARKER" "$CALLS")"
SIGN_LINE="$(grep -n '^cosign sign' "$CALLS" | head -1 | cut -d: -f1 || true)"
VERIFY_LINE="$(grep -n '^cosign verify' "$CALLS" | head -1 | cut -d: -f1 || true)"
check "verify вызван" 1 "$(count '^cosign verify' "$CALLS")"
check "verify вызван после sign" 1 "$([[ -n "$SIGN_LINE" && -n "$VERIFY_LINE" \
  && "$VERIFY_LINE" -gt "$SIGN_LINE" ]] && echo 1 || echo 0)"
check "verify: ключ и --insecure-ignore-tlog=true, ссылка по digest" 1 \
  "$(grep '^cosign verify' "$CALLS" \
    | grep -cF -- "--key $KEYDIR/cosign.pub --insecure-ignore-tlog=true $SIGN_REF" || true)"

check "BAI_COSIGN_LEGACY=0: код 0" 0 "$(BAI_COSIGN_LEGACY=0 run_std 1.5.2 --push --sign --no-scan)"
check "legacy выключен: нет --new-bundle-format" 0 \
  "$(grep '^cosign sign' "$CALLS" | grep -c -- '--new-bundle-format' || true)"
check "legacy выключен: нет --registry-referrers-mode" 0 \
  "$(grep '^cosign sign' "$CALLS" | grep -c -- '--registry-referrers-mode' || true)"
check "legacy выключен: прочие флаги на месте" 1 \
  "$(grep '^cosign sign' "$CALLS" | grep -c -- '--tlog-upload=false' || true)"
check "BAI_COSIGN_LEGACY=2: код 2" 2 "$(BAI_COSIGN_LEGACY=2 run_std 1.5.3 --push --sign)"

reset_out
check "сбой verify: код 1" 1 "$(FAKE_VERIFY_FAIL=1 run_std 1.5.4 --push --sign --no-scan)"
check "сбой verify: sign был, verify был" 2 "$(count -E '^cosign (sign|verify)' "$CALLS")"
check "сбой verify: lock-out не создан" 0 "$(exists "$LOCK_OUT")"
check "сбой sign: код 1" 1 "$(FAKE_SIGN_FAIL=1 run_std 1.5.5 --push --sign --no-scan)"
check "сбой sign: verify не вызывался" 0 "$(count '^cosign verify' "$CALLS")"
check "сбой sign: lock-out не создан" 0 "$(exists "$LOCK_OUT")"
mkdir -p "$WORK/out"
echo "SENTINEL" >"$LOCK_OUT"
check "сбой verify при существующем lock-out: код 1" 1 \
  "$(FAKE_VERIFY_FAIL=1 run_std 1.5.6 --push --sign --no-scan)"
check "сбой verify: прежний lock-out не тронут" "SENTINEL" "$(cat "$LOCK_OUT")"
reset_out

# --- пароль не утекает -----------------------------------------------------------------------
check "пароль не в выводе скрипта" 0 "$(count "$PASSWORD_MARKER" "$WORK/all-out.txt")"
check "пароль не в вызовах заглушек" 0 "$(count "$PASSWORD_MARKER" "$WORK/all-calls.txt")"
check "пароль не в журналах сборки" 0 \
  "$(grep -rl -- "$PASSWORD_MARKER" "$WORK/build" | wc -l)"
check "пароль не в lock-out" 0 "$(grep -rl -- "$PASSWORD_MARKER" "$WORK/out" 2>/dev/null | wc -l)"

# --- trivy -----------------------------------------------------------------------------------
check "trivy: код 0" 0 "$(run_std 1.6.0 --push)"
check "trivy: вызван по digest с HIGH,CRITICAL" 1 \
  "$(grep '^trivy image' "$CALLS" | grep -cE -- "--severity HIGH,CRITICAL .*@sha256:" || true)"
check "trivy: отчёт сохранён" 1 "$(exists "$WORK/build/reports/pragmatika-app-1.6.0.txt")"
check "trivy: число строк в журнале" 1 "$(count 'HIGH=2 CRITICAL=1' "$WORK/out.txt")"
reset_out
check "сбой trivy не блокирует: код 0" 0 "$(FAKE_TRIVY_FAIL=1 run_std 1.6.1 --push)"
check "сбой trivy: lock-out создан" 1 "$(exists "$LOCK_OUT")"
check "сбой trivy отмечен" 1 "$(count 'сканирование не удалось' "$WORK/out.txt")"
reset_out
check "--no-scan: код 0" 0 "$(run_std 1.6.2 --push --no-scan)"
check "--no-scan: trivy не вызывался" 0 "$(count '^trivy' "$CALLS")"
reset_out

# --- стиль исходников ------------------------------------------------------------------------
for file in "$SCRIPT" "$HERE/build-app-image.test.sh"; do
  base="$(basename "$file")"
  check "bash -n $base" 0 "$(bash -n "$file" >/dev/null 2>&1 && echo 0 || echo 1)"
  check "строки до $MAX_LINE символов: $base" 0 \
    "$(LC_ALL=C.UTF-8 grep -cE "^.{$((MAX_LINE + 1)),}\$" "$file" || true)"
  check "set -euo pipefail: $base" 1 "$(count '^set -euo pipefail$' "$file")"
done

echo "проверок: $CHECKS, провалено: $FAILED"
[[ "$FAILED" -eq 0 ]]
