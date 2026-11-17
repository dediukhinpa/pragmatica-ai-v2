#!/usr/bin/env bash
# Контрактный тест адаптера v2 (HttpContractAmender) против сервиса документов: поднимает сервис
# на 127.0.0.1, строит синтетические docx и запускает bun-тест
# tests/kit/adapters/http-contract-amender.contract.test.ts.
#
#   tools/test-documents-contract.sh --image <ссылка на образ> [--port N] [--expect-missing]
#   tools/test-documents-contract.sh --python <python> --platform-src <каталог> [--port N]
#                                    [--expect-missing]
#
# --image: сервис запускается контейнером (образ pragmatika-documents; для красной проверки -
#   платформенный bai-documents вместе с --expect-missing). Образ не собирается и не тянется.
# --python/--platform-src: тот же код без Docker: python с зависимостями платформы и каталог
#   с исходниками платформы (services/documents и vendor/labops-pii внутри). С
#   --expect-missing запускается платформенное приложение БЕЗ проектного слоя.
# --no-project-layer: (только с --python) запустить платформенное приложение без проектного
#   слоя и прогнать обычный тест: он обязан стать КРАСНЫМ (доказательство «красный до»).
# --expect-missing: проверяет обратное (404 на /docx/*): доказательство «красный до».
# Порт по умолчанию 21150 (диапазон этапа 8v: 21150-21199), только 127.0.0.1.
# Коды выхода: 0 - зелёный, 1 - тест красный, 2 - неверный вызов или окружение.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
readonly EXIT_FAIL=1
readonly EXIT_USAGE=2
readonly DEFAULT_PORT=21150
readonly CONTAINER_PORT=8310
readonly START_WAIT_S=90
readonly CONTAINER_NAME_PREFIX="bai8v-contract"

IMAGE=""
PYTHON=""
PLATFORM_SRC=""
PORT="$DEFAULT_PORT"
EXPECT_MISSING=0
PLATFORM_ONLY=0
SERVER_PID=""
CONTAINER=""
WORK=""

log() { echo "[test-documents-contract] $*"; }
usage() {
  sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
  exit "$EXIT_USAGE"
}

cleanup() {
  [[ -z "$CONTAINER" ]] || docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  [[ -z "$SERVER_PID" ]] || kill "$SERVER_PID" >/dev/null 2>&1 || true
  [[ -z "$WORK" ]] || rm -rf "${WORK:?}"
}
trap cleanup EXIT

while (($#)); do
  case "$1" in
    --image) IMAGE="${2:?--image требует ссылку}"; shift ;;
    --python) PYTHON="${2:?--python требует путь}"; shift ;;
    --platform-src) PLATFORM_SRC="${2:?--platform-src требует каталог}"; shift ;;
    --port) PORT="${2:?--port требует число}"; shift ;;
    --expect-missing) EXPECT_MISSING=1 ;;
    --no-project-layer) PLATFORM_ONLY=1 ;;
    -h | --help) usage ;;
    *) echo "неизвестный ключ: $1" >&2; usage ;;
  esac
  shift
done
[[ "$PORT" =~ ^[0-9]+$ ]] || { echo "порт не число" >&2; exit "$EXIT_USAGE"; }
if [[ -n "$IMAGE" ]]; then
  [[ -z "$PYTHON" ]] || { echo "--image и --python вместе нельзя" >&2; exit "$EXIT_USAGE"; }
else
  [[ -n "$PYTHON" && -n "$PLATFORM_SRC" ]] || usage
  [[ -x "$PYTHON" && -d "$PLATFORM_SRC/services/documents" ]] \
    || { echo "python или платформенные исходники не найдены" >&2; exit "$EXIT_USAGE"; }
fi

WORK="$(mktemp -d)"
DOCS_PATH="$ROOT/services/documents-docx"
PLATFORM_PATH="${PLATFORM_SRC:+$PLATFORM_SRC/services/documents:$PLATFORM_SRC/vendor/labops-pii}"

# Фикстуры строятся хостовым python (в образе нет pytest и построителей).
BUILDER="${PYTHON:-$(command -v python3)}"
log "строю синтетические docx"
PYTHONPATH="$DOCS_PATH${PLATFORM_PATH:+:$PLATFORM_PATH}" "$BUILDER" -W ignore \
  "$DOCS_PATH/tests/make_contract_fixtures.py" "$WORK/fixtures" >/dev/null

if [[ -n "$IMAGE" ]]; then
  CONTAINER="${CONTAINER_NAME_PREFIX}-$$"
  log "запускаю контейнер $IMAGE на 127.0.0.1:$PORT"
  docker run -d --name "$CONTAINER" -p "127.0.0.1:$PORT:$CONTAINER_PORT" \
    --label bai.stage=8v "$IMAGE" >/dev/null
else
  entry="pragmatika_documents"
  ((! EXPECT_MISSING && ! PLATFORM_ONLY)) || entry="documents"
  log "запускаю python -m $entry на 127.0.0.1:$PORT"
  PYTHONPATH="$DOCS_PATH:$PLATFORM_PATH" DOCUMENTS_HOST=127.0.0.1 DOCUMENTS_PORT="$PORT" \
    TMPDIR="$WORK" "$PYTHON" -m "$entry" >"$WORK/server.log" 2>&1 &
  SERVER_PID=$!
fi

deadline=$((SECONDS + START_WAIT_S))
until curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; do
  ((SECONDS < deadline)) || { echo "сервис не поднялся за ${START_WAIT_S} с" >&2; exit "$EXIT_FAIL"; }
  sleep 1
done
log "сервис отвечает"

export DOCUMENTS_CONTRACT_URL="http://127.0.0.1:$PORT"
export DOCUMENTS_CONTRACT_FIXTURES="$WORK/fixtures"
((! EXPECT_MISSING)) || export DOCUMENTS_CONTRACT_EXPECT=missing
cd "$ROOT"
if bun test tests/kit/adapters/http-contract-amender.contract.test.ts; then
  log "контрактный тест зелёный"
else
  log "контрактный тест КРАСНЫЙ"
  exit "$EXIT_FAIL"
fi
