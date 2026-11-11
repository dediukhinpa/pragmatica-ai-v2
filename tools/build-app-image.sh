#!/usr/bin/env bash
# Сборка, публикация и подпись образа `app` проекта поверх базового образа платформы и запись
# images.lock проекта:
#   tools/build-app-image.sh <версия> --base-lock <файл> --lock-out <файл> [--registry <путь>]
#                                     [--push] [--sign] [--no-scan] [--help]
#
# Что делает:
#   1. строго разбирает lock платформы (--base-lock): нужны BAI_VERSION и BAI_IMAGE_APP_BASE;
#   2. собирает образ из ЗАКОММИЧЕННОГО дерева (git archive HEAD: package.json, src,
#      deploy/docker) поверх базового образа по digest, ставит метки OCI и bai.*;
#   3. с --push публикует образ и узнаёт digest; без --push только собирает образ локально
#      (pragmatika-app:<версия>) и lock-out НЕ пишет: digest реестра до публикации неизвестен;
#   4. trivy (если установлен и нет --no-scan): отчёт HIGH и CRITICAL, сборку не блокирует;
#   5. с --sign подписывает образ по digest (cosign) и ОБЯЗАТЕЛЬНО проверяет подпись;
#   6. пишет --lock-out: BAI_VERSION=<версия>, все BAI_IMAGE_* из base lock кроме
#      BAI_IMAGE_APP и новый BAI_IMAGE_APP; ключи по алфавиту. Запись атомарная, права 644,
#      результат проходит тот же строгий разбор, что и base lock.
#
# Аргументы:
#   <версия>        ^[0-9A-Za-z][0-9A-Za-z._-]*$; она же тег образа и BAI_VERSION нового lock
#   --base-lock     lock платформы (BAI_VERSION, BAI_IMAGE_APP_BASE=<репозиторий>@sha256:...)
#   --lock-out      куда записать lock проекта (не совпадает с --base-lock)
#   --registry      реестр образа (по умолчанию префикс репозитория BAI_IMAGE_APP_BASE до
#                   /bai-app-base@)
#   --push          опубликовать образ (нужен для lock-out и для --sign)
#   --sign          подписать и проверить подпись (только вместе с --push)
#   --no-scan       не запускать trivy
#
# Переменные окружения:
#   BAI_APP_IMAGE_NAME   имя образа в реестре (по умолчанию pragmatika-app)
#   BAI_PROJECT_DIR      git-репозиторий проекта (по умолчанию корень репозитория скрипта)
#   BAI_BUILD_DIR        каталог сборки: контекст, отчёты, журнал (по умолчанию
#                        $BAI_PROJECT_DIR/build/app-image)
#   BAI_STAGE            значение метки bai.stage (по умолчанию 7)
#   BAI_ALLOW_CLOUD_REGISTRY  1 - разрешить облачный реестр (шлюз G2: решение владельца)
#   BAI_SIGNING_KEY      закрытый ключ cosign (по умолчанию ~/.config/bai-signing/cosign.key)
#   BAI_SIGNING_PASSWORD_FILE  файл с паролем ключа (по умолчанию cosign.password рядом с ключом)
#   BAI_SIGNING_PUBKEY   открытый ключ для проверки (по умолчанию cosign.pub рядом с ключом)
#   BAI_COSIGN_LEGACY    1 (по умолчанию) - старый формат подписи и режим referrers legacy:
#                        Yandex Container Registry отвергает новый формат; 0 - выключить
# Авторизацию в реестре скрипт не делает: docker уже должен быть авторизован (DOCKER_CONFIG
# вызывающего). Пароль подписи передаётся только окружением процесса cosign и в журнал не
# попадает. Вывод docker и cosign уходит в журнал $BAI_BUILD_DIR/build-<версия>.log.
#
# Коды выхода: 0 - готово, 1 - ошибка сборки, публикации или подписи, 2 - неверный вызов или
# окружение (в том числе плохой base lock и облачный реестр без разрешения).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

# Коды выхода.
readonly EXIT_FAIL=1
readonly EXIT_USAGE=2

# Допустимые формы значений.
readonly VERSION_RE='^[0-9A-Za-z][0-9A-Za-z._-]*$'
readonly DIGEST_RE='^sha256:[0-9a-f]{64}$'
readonly IMAGE_REF_RE='^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[0-9a-f]{64}$'
readonly IMAGE_KEY_RE='^BAI_IMAGE_[A-Z0-9_]+$'
readonly REGISTRY_RE='^[A-Za-z0-9][A-Za-z0-9._:/-]*$'
readonly IMAGE_NAME_RE='^[a-z0-9][a-z0-9._/-]*$'
readonly LABEL_VALUE_RE='^[0-9A-Za-z][0-9A-Za-z._-]*$'
readonly CLOUD_REGISTRY_RE='(^|\.)(yandex|yandexcloud)\.(net|cloud|ru)(/|:|$)|cr\.yandex'
# Реестры, где trivy можно разрешить http без проверки TLS (локальный реестр разработки).
readonly LOCAL_REGISTRY_RE='^(127\.0\.0\.1|localhost)(:|/|$)'

# Ключи lock и имена образов.
readonly VERSION_KEY="BAI_VERSION"
readonly BASE_KEY="BAI_IMAGE_APP_BASE"
readonly APP_KEY="BAI_IMAGE_APP"
readonly BASE_REPO_NAME="bai-app-base"
readonly APP_TITLE="pragmatika-app"
readonly DEFAULT_STAGE="7"
readonly REVISION_LEN=12
readonly LOCK_FILE_MODE=644
readonly TRIVY_SEVERITIES="HIGH,CRITICAL"

# Что попадает в контекст сборки (из HEAD) и где в нём Dockerfile.
readonly DOCKERFILE_REL="deploy/docker/project-app.Dockerfile"
readonly CONTEXT_PATHS=(package.json src deploy/docker)

PROJECT_DIR="${BAI_PROJECT_DIR:-$ROOT}"
BUILD_DIR="${BAI_BUILD_DIR:-$PROJECT_DIR/build/app-image}"
IMAGE_NAME="${BAI_APP_IMAGE_NAME:-$APP_TITLE}"
STAGE_LABEL="${BAI_STAGE:-$DEFAULT_STAGE}"
SIGNING_KEY="${BAI_SIGNING_KEY:-$HOME/.config/bai-signing/cosign.key}"
SIGNING_PASSWORD_FILE="${BAI_SIGNING_PASSWORD_FILE:-$(dirname "$SIGNING_KEY")/cosign.password}"
SIGNING_PUBKEY="${BAI_SIGNING_PUBKEY:-$(dirname "$SIGNING_KEY")/cosign.pub}"
COSIGN_LEGACY="${BAI_COSIGN_LEGACY:-1}"

LOG_FILE=""
CONTEXT_DIR=""
TMP_LOCK=""

log() {
  local line
  line="[build-app-image] $(date -u +%H:%M:%S) $*"
  echo "$line"
  [[ -z "$LOG_FILE" ]] || echo "$line" >>"$LOG_FILE"
}
fail() {
  local code="$1"
  shift
  log "ОШИБКА: $*" >&2
  exit "$code"
}
die() { fail "$EXIT_FAIL" "$@"; }
die_usage() { fail "$EXIT_USAGE" "$@"; }

# Убирает временный контекст и недописанный lock при любом выходе.
cleanup() {
  [[ -z "$CONTEXT_DIR" ]] || rm -rf "${CONTEXT_DIR:?}"
  [[ -z "$TMP_LOCK" ]] || rm -f "${TMP_LOCK:?}"
}
trap cleanup EXIT

# Справка: заголовочный комментарий этого файла.
print_help() {
  sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
}
usage_error() {
  echo "$1" >&2
  print_help >&2
  exit "$EXIT_USAGE"
}

VERSION=""
BASE_LOCK=""
LOCK_OUT=""
REGISTRY=""
DO_PUSH=0
DO_SIGN=0
DO_SCAN=1

parse_args() {
  while (($#)); do
    case "$1" in
      --base-lock)
        [[ $# -ge 2 && -n "$2" ]] || usage_error "--base-lock требует файл"
        BASE_LOCK="$2"
        shift
        ;;
      --lock-out)
        [[ $# -ge 2 && -n "$2" ]] || usage_error "--lock-out требует файл"
        LOCK_OUT="$2"
        shift
        ;;
      --registry)
        [[ $# -ge 2 && -n "$2" ]] || usage_error "--registry требует путь реестра"
        REGISTRY="$2"
        shift
        ;;
      --push) DO_PUSH=1 ;;
      --sign) DO_SIGN=1 ;;
      --no-scan) DO_SCAN=0 ;;
      --help | -h)
        print_help
        exit 0
        ;;
      -*) usage_error "неизвестный ключ: $1" ;;
      *)
        [[ -z "$VERSION" ]] || usage_error "лишний аргумент: $1"
        VERSION="$1"
        ;;
    esac
    shift
  done
  [[ -n "$VERSION" ]] || usage_error "не указана версия"
  [[ "$VERSION" =~ $VERSION_RE ]] || usage_error "версия недопустима"
  [[ -n "$BASE_LOCK" ]] || usage_error "не указан --base-lock"
  [[ -n "$LOCK_OUT" ]] || usage_error "не указан --lock-out"
  ((! DO_SIGN || DO_PUSH)) || usage_error "--sign без --push: подписывать нечего"
}

# --- строгий разбор lock ---------------------------------------------------------------------
# Результат: LOCK_VERSION, массив LOCK_IMAGES (ключ BAI_IMAGE_* -> ссылка), LOCK_ERROR.
# В сообщение попадают только номер строки и имя ключа из белого списка, не содержимое файла.
LOCK_VERSION=""
LOCK_ERROR=""
declare -A LOCK_IMAGES=()

parse_lock() {
  local file="$1" line key value n=0
  LOCK_VERSION=""
  LOCK_ERROR=""
  LOCK_IMAGES=()
  [[ -f "$file" && -r "$file" ]] || { LOCK_ERROR="файл не найден или не читается"; return 1; }
  while IFS= read -r line || [[ -n "$line" ]]; do
    n=$((n + 1))
    if [[ "$line" == *$'\r'* ]]; then
      LOCK_ERROR="строка $n: символ CR"
      return 1
    fi
    if [[ "$line" =~ [[:space:]]$ ]]; then
      LOCK_ERROR="строка $n: пробел или табуляция в конце строки"
      return 1
    fi
    if [[ -z "$line" || "$line" == '#'* ]]; then
      continue
    fi
    if [[ "$line" != *=* ]]; then
      LOCK_ERROR="строка $n: нет знака ="
      return 1
    fi
    key="${line%%=*}"
    value="${line#*=}"
    if [[ "$key" == "$VERSION_KEY" ]]; then
      if [[ -n "$LOCK_VERSION" ]]; then
        LOCK_ERROR="строка $n: повтор ключа $VERSION_KEY"
        return 1
      fi
      if [[ ! "$value" =~ $VERSION_RE ]]; then
        LOCK_ERROR="строка $n: недопустимое значение $VERSION_KEY"
        return 1
      fi
      LOCK_VERSION="$value"
    elif [[ "$key" =~ $IMAGE_KEY_RE ]]; then
      if [[ -n "${LOCK_IMAGES[$key]+x}" ]]; then
        LOCK_ERROR="строка $n: повтор ключа $key"
        return 1
      fi
      if [[ ! "$value" =~ $IMAGE_REF_RE ]]; then
        LOCK_ERROR="строка $n: значение $key не вида <репозиторий>@sha256:<64 hex>"
        return 1
      fi
      LOCK_IMAGES["$key"]="$value"
    else
      LOCK_ERROR="строка $n: чужой ключ"
      return 1
    fi
  done <"$file"
  if [[ -z "$LOCK_VERSION" ]]; then
    LOCK_ERROR="нет ключа $VERSION_KEY"
    return 1
  fi
  if ((${#LOCK_IMAGES[@]} == 0)); then
    LOCK_ERROR="нет ни одного ключа BAI_IMAGE_*"
    return 1
  fi
}

# --- проверки окружения ----------------------------------------------------------------------
BASE_REF=""

check_environment() {
  local path
  command -v docker >/dev/null || die_usage "нет docker"
  command -v git >/dev/null || die_usage "нет git"
  [[ -d "$PROJECT_DIR" ]] || die_usage "нет каталога проекта: $PROJECT_DIR"
  git -C "$PROJECT_DIR" rev-parse --verify --quiet HEAD >/dev/null \
    || die_usage "в $PROJECT_DIR нет git-репозитория с коммитом (сборка идёт из HEAD)"
  for path in "${CONTEXT_PATHS[@]}"; do
    git -C "$PROJECT_DIR" cat-file -e "HEAD:$path" 2>/dev/null \
      || die_usage "в HEAD нет $path: закоммитьте файлы проекта"
  done
  git -C "$PROJECT_DIR" cat-file -e "HEAD:$DOCKERFILE_REL" 2>/dev/null \
    || die_usage "в HEAD нет $DOCKERFILE_REL"
  [[ "$IMAGE_NAME" =~ $IMAGE_NAME_RE ]] || die_usage "BAI_APP_IMAGE_NAME недопустимо"
  [[ "$STAGE_LABEL" =~ $LABEL_VALUE_RE ]] || die_usage "BAI_STAGE недопустимо"
  [[ "$COSIGN_LEGACY" == "0" || "$COSIGN_LEGACY" == "1" ]] \
    || die_usage "BAI_COSIGN_LEGACY: допустимо 0 или 1"

  parse_lock "$BASE_LOCK" || die_usage "base lock: $LOCK_ERROR"
  BASE_REF="${LOCK_IMAGES[$BASE_KEY]:-}"
  [[ -n "$BASE_REF" ]] || die_usage "base lock: нет ключа $BASE_KEY"
  [[ ! "$BASE_LOCK" -ef "$LOCK_OUT" ]] || die_usage "--lock-out совпадает с --base-lock"

  ((DO_PUSH)) && check_registry
  ((DO_SIGN)) && check_signing_prerequisites
  return 0
}

# Определяет реестр и отказывает для облачного без явного разрешения (шлюз G2).
check_registry() {
  local base_repo="${BASE_REF%@*}"
  if [[ -z "$REGISTRY" ]]; then
    [[ "$base_repo" == */"$BASE_REPO_NAME" ]] \
      || die_usage "репозиторий базы не оканчивается на /$BASE_REPO_NAME: задайте --registry"
    REGISTRY="${base_repo%/"$BASE_REPO_NAME"}"
  fi
  [[ "$REGISTRY" =~ $REGISTRY_RE && "$REGISTRY" != */ ]] || die_usage "реестр недопустим"
  if [[ "$REGISTRY" =~ $CLOUD_REGISTRY_RE && "${BAI_ALLOW_CLOUD_REGISTRY:-0}" != "1" ]]; then
    die_usage "реестр $REGISTRY облачный: шлюз G2 закрыт, публикация в облако идёт только по" \
      "решению владельца (BAI_ALLOW_CLOUD_REGISTRY=1 снимает отказ)"
  fi
}

check_signing_prerequisites() {
  command -v cosign >/dev/null || die_usage "нет cosign"
  [[ -f "$SIGNING_KEY" ]] || die_usage "нет ключа подписи: $SIGNING_KEY"
  [[ -f "$SIGNING_PASSWORD_FILE" ]] || die_usage "нет файла пароля: $SIGNING_PASSWORD_FILE"
  [[ -f "$SIGNING_PUBKEY" ]] || die_usage "нет открытого ключа для проверки: $SIGNING_PUBKEY"
}

# --- сборка ----------------------------------------------------------------------------------
REVISION=""
CREATED=""

# Метки OCI и bai.* для docker build (по одной в строке).
label_args() {
  printf '%s\n' \
    "--label=org.opencontainers.image.title=$APP_TITLE" \
    "--label=org.opencontainers.image.version=$VERSION" \
    "--label=org.opencontainers.image.revision=$REVISION" \
    "--label=org.opencontainers.image.created=$CREATED" \
    "--label=org.opencontainers.image.licenses=LicenseRef-Proprietary" \
    "--label=bai.stage=$STAGE_LABEL" \
    "--label=bai.version=$VERSION"
}

build_image() {
  local args=() dirty
  dirty="$(git -C "$PROJECT_DIR" status --porcelain -- "${CONTEXT_PATHS[@]}" | wc -l)"
  if ((dirty > 0)); then
    log "в рабочем дереве есть незакоммиченное ($dirty путей): в образ оно не попадёт"
  fi
  # Контекст - закоммиченное дерево (git archive): неотслеженные файлы, node_modules и .env не
  # попадают в образ, а метка revision точно описывает собранное. Рядом с Dockerfile лежит его
  # .dockerignore (его читает BuildKit); классический сборщик его игнорирует, но лишние файлы
  # из deploy/docker в образ всё равно не копируются: Dockerfile берёт только package.json и src.
  CONTEXT_DIR="$(mktemp -d "$BUILD_DIR/context.XXXXXX")"
  git -C "$PROJECT_DIR" archive --format=tar HEAD "${CONTEXT_PATHS[@]}" \
    | tar -x -C "$CONTEXT_DIR" || die "не удалось выгрузить контекст из HEAD"
  mapfile -t args < <(label_args)
  log "сборка $APP_TITLE:$VERSION поверх базы из base lock"
  docker build "${args[@]}" --build-arg "BAI_APP_BASE=$BASE_REF" -t "$APP_TITLE:$VERSION" \
    -f "$CONTEXT_DIR/$DOCKERFILE_REL" "$CONTEXT_DIR" >>"$LOG_FILE" 2>&1 \
    || die "сборка образа не удалась (журнал $LOG_FILE)"
  log "образ собран: $APP_TITLE:$VERSION"
}

# Публикует образ, возвращает ссылку <реестр>/<имя>@sha256:... (печатает только её).
push_image() {
  local remote="$REGISTRY/$IMAGE_NAME:$VERSION" out digest
  docker tag "$APP_TITLE:$VERSION" "$remote" >>"$LOG_FILE" 2>&1 || die "docker tag $remote"
  out="$(docker push "$remote" 2>&1)" || { echo "$out" >>"$LOG_FILE"; die "push $remote"; }
  echo "$out" >>"$LOG_FILE"
  digest="$(printf '%s\n' "$out" | sed -n 's/.*digest: \(sha256:[0-9a-f]\{64\}\).*/\1/p' | tail -1)"
  [[ "$digest" =~ $DIGEST_RE ]] || die "не удалось получить digest после push $remote"
  printf '%s' "$REGISTRY/$IMAGE_NAME@$digest"
}

# Сканирует опубликованный образ trivy: отчёт, сборку не блокирует.
scan_image() {
  local ref="$1" report="$BUILD_DIR/reports/$APP_TITLE-$VERSION.txt" high critical
  ((DO_SCAN)) || return 0
  if ! command -v trivy >/dev/null; then
    log "trivy не найден: сканирование пропущено"
    return 0
  fi
  mkdir -p "$BUILD_DIR/reports"
  local insecure=false
  [[ "$REGISTRY" =~ $LOCAL_REGISTRY_RE ]] && insecure=true
  if TRIVY_INSECURE="$insecure" trivy image --quiet --scanners vuln \
    --severity "$TRIVY_SEVERITIES" --exit-code 0 --format table --output "$report" "$ref" \
    >>"$LOG_FILE" 2>&1; then
    high="$(grep -c 'HIGH' "$report" 2>/dev/null || true)"
    critical="$(grep -c 'CRITICAL' "$report" 2>/dev/null || true)"
    log "trivy: строк HIGH=${high:-0} CRITICAL=${critical:-0} (отчёт $report)"
  else
    log "trivy: сканирование не удалось (сборку не блокирует), см. журнал"
  fi
}

# Подписывает образ по digest и проверяет подпись. Пароль - только окружением процесса cosign.
sign_and_verify() {
  local ref="$1" legacy=()
  ((DO_SIGN)) || return 0
  if [[ "$COSIGN_LEGACY" == "1" ]]; then
    # Yandex Container Registry отвергает новый формат подписи и referrers API.
    legacy=(--new-bundle-format=false --registry-referrers-mode=legacy)
  fi
  COSIGN_PASSWORD="$(<"$SIGNING_PASSWORD_FILE")" cosign sign --yes --key "$SIGNING_KEY" \
    --use-signing-config=false --tlog-upload=false ${legacy[@]+"${legacy[@]}"} \
    -a "bai-version=$VERSION" -a "bai-image=$APP_TITLE" "$ref" \
    >>"$LOG_FILE" 2>&1 || die "подпись не удалась (журнал $LOG_FILE); образ опубликован без lock"
  log "подписан $ref"
  # Подпись без проверки ничего не гарантирует: lock пишется только после успешной проверки.
  cosign verify --key "$SIGNING_PUBKEY" --insecure-ignore-tlog=true "$ref" \
    >>"$LOG_FILE" 2>&1 || die "проверка подписи не пройдена (журнал $LOG_FILE); lock не записан"
  log "подпись проверена"
}

# --- запись lock -----------------------------------------------------------------------------
# Пишет lock проекта: версия, образы платформы кроме APP и новый APP, ключи по алфавиту.
write_lock() {
  local app_ref="$1" key
  LOCK_IMAGES["$APP_KEY"]="$app_ref"
  mkdir -p "$(dirname "$LOCK_OUT")"
  TMP_LOCK="$(mktemp "$LOCK_OUT.XXXXXX")"
  {
    echo "# images.lock проекта: создан tools/build-app-image.sh, правится только им."
    echo "# Образы платформы взяты из base lock, образ app собран поверх BAI_IMAGE_APP_BASE."
    echo "$VERSION_KEY=$VERSION"
    printf '%s\n' "${!LOCK_IMAGES[@]}" | LC_ALL=C sort | while IFS= read -r key; do
      echo "$key=${LOCK_IMAGES[$key]}"
    done
  } >"$TMP_LOCK"
  chmod "$LOCK_FILE_MODE" "$TMP_LOCK"
  parse_lock "$TMP_LOCK" || die "собранный lock не прошёл разбор ($LOCK_ERROR); не записан"
  [[ "$LOCK_VERSION" == "$VERSION" && "${LOCK_IMAGES[$APP_KEY]:-}" == "$app_ref" ]] \
    || die "собранный lock не совпал с ожидаемым; не записан"
  mv "$TMP_LOCK" "$LOCK_OUT"
  TMP_LOCK=""
  log "записан $LOCK_OUT"
}

main() {
  parse_args "$@"
  mkdir -p "$BUILD_DIR" || die_usage "не создать каталог сборки"
  BUILD_DIR="$(cd "$BUILD_DIR" && pwd)"
  LOG_FILE="$BUILD_DIR/build-$VERSION.log"
  : >"$LOG_FILE"
  check_environment
  REVISION="$(git -C "$PROJECT_DIR" rev-parse HEAD | cut -c1-"$REVISION_LEN")"
  CREATED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  log "версия $VERSION, ревизия $REVISION, база платформы $LOCK_VERSION"

  build_image
  if ((! DO_PUSH)); then
    log "образ не опубликован (нет --push); $LOCK_OUT не создаётся: digest реестра неизвестен" \
      "до публикации. Для записи lock запустите с --push."
    return 0
  fi
  local app_ref
  app_ref="$(push_image)"
  log "опубликован $app_ref"
  scan_image "$app_ref"
  sign_and_verify "$app_ref"
  write_lock "$app_ref"
  log "готово"
}

main "$@"
