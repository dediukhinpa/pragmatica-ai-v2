#!/usr/bin/env bash
# Тест проверки маршрутов на НАСТОЯЩИХ образах documents: платформенный образ без проектного слоя
# должен провалить tools/check-routes.sh (404 на /docx/*), образ проекта - пройти.
#
#   bash tools/test-check-routes-images.sh --green ОБРАЗ_ПРОЕКТА --red ОБРАЗ_ПЛАТФОРМЫ [--port N]
#
# Образы запускаются одноразовыми контейнерами на 127.0.0.1 (по умолчанию порт 21152, диапазон
# этапа 21150-21199), флаги маршрутов включены как в compose v2 (правки, шаблоны, OCR), архивы
# выключены. Контейнеры имеют метку bai.stage=8v и убираются при выходе.
# Коды выхода: 0 - красный образ провален, зелёный пройден; 1 - иначе; 2 - неверный вызов.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GREEN=""
RED=""
PORT=21152
LABEL="bai.stage=8v"
MEM=1g
WAIT_S=90
EXIT_USAGE=2
WORK="$(mktemp -d)"
NAMES=()
cleanup() {
  local n
  for n in ${NAMES[@]+"${NAMES[@]}"}; do docker rm -f "$n" >/dev/null 2>&1 || true; done
  rm -rf "${WORK:?}"
}
trap cleanup EXIT
log() { echo "[test-check-routes-images] $*"; }

while (($#)); do
  case "$1" in
    --green) GREEN="${2:?--green ОБРАЗ}"; shift ;;
    --red) RED="${2:?--red ОБРАЗ}"; shift ;;
    --port) PORT="${2:?--port N}"; shift ;;
    -h | --help) sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "неизвестный аргумент: $1" >&2; exit "$EXIT_USAGE" ;;
  esac
  shift
done
[[ -n "$GREEN" && -n "$RED" ]] || { echo "нужны --green и --red" >&2; exit "$EXIT_USAGE"; }

# Запускает образ, ждёт /health, прогоняет check-routes.sh, печатает код. Вывод в файл $3.
run_case() { # run_case <образ> <порт> <файл вывода>
  local image="$1" port="$2" out="$3" name="routes-test-$2" waited=0 rc=0
  NAMES+=("$name")
  docker run -d --name "$name" --label "$LABEL" --memory "$MEM" --cap-drop ALL \
    --security-opt no-new-privileges:true -p "127.0.0.1:$port:8310" \
    -e DOCUMENTS_HOST=0.0.0.0 -e DOCUMENTS_EDIT_ENDPOINTS=true \
    -e DOCUMENTS_TEMPLATE_ENDPOINTS=true -e DOCUMENTS_IMAGE_TEXT_ENDPOINT=true \
    "$image" >/dev/null
  until curl -fsS "http://127.0.0.1:$port/health" >/dev/null 2>&1; do
    ((waited += 2 <= WAIT_S)) || { log "сервис $image не поднялся за ${WAIT_S} с"; return 99; }
    sleep 2
  done
  bash "$HERE/check-routes.sh" --manifest "$HERE/../deploy/cutover/routes.tsv" \
    --base "documents=http://127.0.0.1:$port" \
    --flag DOCUMENTS_EDIT_ENDPOINTS=true --flag DOCUMENTS_TEMPLATE_ENDPOINTS=true \
    --flag DOCUMENTS_IMAGE_TEXT_ENDPOINT=true --flag DOCUMENTS_ARCHIVES_ENABLED= \
    --skip-service pseudonymizer --skip-service embeddings --skip-service mask \
    --skip-service speech >"$out" 2>&1 || rc=$?
  return "$rc"
}

rc_red=0
run_case "$RED" "$PORT" "$WORK/red.txt" || rc_red=$?
rc_green=0
run_case "$GREEN" "$((PORT + 1))" "$WORK/green.txt" || rc_green=$?
log "платформенный образ без слоя: код $rc_red (ожидается 1)"
grep -E 'FAIL|итого' "$WORK/red.txt" | head -8 || true
log "образ проекта: код $rc_green (ожидается 0)"
grep -E 'FAIL|итого' "$WORK/green.txt" | head -8 || true
if [[ "$rc_red" == 1 && "$rc_green" == 0 ]] \
  && [[ "$(grep -c '/docx/.*FAIL' "$WORK/red.txt" || true)" -ge 4 ]]; then
  log "ЗЕЛЁНЫЙ: без проектных маршрутов провал на всех четырёх /docx/*, с ними успех"
else
  log "КРАСНЫЙ: поведение проверки не совпало с ожидаемым"
  exit 1
fi
