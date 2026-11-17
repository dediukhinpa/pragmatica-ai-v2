#!/usr/bin/env bash
# Тест tools/check-image-routes.sh на заглушке docker. Необязательно (BAI_ROUTES_IMAGE_GREEN и
# BAI_ROUTES_IMAGE_RED - локальные образы): проверка на настоящих образах, зелёный образ проекта
# и красный платформенный без проектных маршрутов.
#
#   bash tools/check-image-routes.test.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/check-image-routes.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK:?}"' EXIT
FAILED=0
CHECKS=0
readonly MAX_LINE=100

check() { # check <имя> <ожидалось> <получено>
  CHECKS=$((CHECKS + 1))
  if [[ "$2" == "$3" ]]; then echo "PASS $1"; else echo "FAIL $1: ожидалось '$2', получено '$3'"
    FAILED=$((FAILED + 1)); fi
}

MANIFEST="$WORK/routes.tsv"
printf '%s\n' \
  $'documents\tPOST\t/parse\troute' \
  $'documents\tPOST\t/docx/amend\troute' \
  $'documents\tPOST\t/parse-archive\troute' \
  $'documents\tPOST\t/jobs/{id}\ttemplate' \
  $'mask\tPOST\t/mask_image\troute' >"$MANIFEST"
FLAGS="$WORK/flags.tsv"
printf 'documents\t/parse-archive\tDOCUMENTS_ARCHIVES_ENABLED\n' >"$FLAGS"

# Заглушка docker: «image inspect» отдаёт Cmd, «run» печатает заготовленный вывод проверки.
STUBS="$WORK/stubs"
mkdir -p "$STUBS"
cat >"$STUBS/docker" <<'STUB'
#!/usr/bin/env bash
echo "docker $*" >>"$CALLS"
case "$1" in
  image) [[ "${FAKE_NO_IMAGE:-0}" == 1 ]] && exit 1
         echo '["python","-m","pragmatika_documents"]' ;;
  run) [[ "${FAKE_RUN_FAIL:-0}" == 1 ]] && exit 1
       # Все требуемые маршруты, кроме перечисленных в FAKE_MISSING (через пробел «ПУТЬ»)
       while IFS= read -r line; do
         [[ -n "$line" ]] || continue
         path="${line#* }"
         verdict=OK
         [[ " ${FAKE_MISSING:-} " != *" $path "* ]] || verdict=MISSING
         echo "$verdict $line"
       done <<<"$(for a in "$@"; do
         [[ "$a" != REQUIRED_ROUTES=* ]] || printf '%s\n' "${a#REQUIRED_ROUTES=}"
       done)" ;;
esac
STUB
chmod +x "$STUBS/docker"
CALLS="$WORK/calls.log"
: >"$CALLS"
export CALLS

run() { # run <аргументы...> -> код выхода; вывод в $WORK/out.txt
  local rc=0
  PATH="$STUBS:$PATH" bash "$SCRIPT" --manifest "$MANIFEST" --flags-file "$FLAGS" "$@" \
    >"$WORK/out.txt" 2>&1 || rc=$?
  echo "$rc"
}
count() { grep -c -e "$1" "$WORK/out.txt" || true; }

check "все маршруты на месте: код 0" 0 "$(run --image img:1)"
check "проверены только route документов (3 штуки)" 1 "$(count 'все 3 маршрутов documents')"
check "нет /docx/amend: код 1" 1 "$(FAKE_MISSING='/docx/amend' run --image img:1)"
check "нет /docx/amend: назван в выводе" 1 "$(count 'нет маршрута в образе: POST /docx/amend')"
check "флаг выключен: /parse-archive пропущен" 0 \
  "$(FAKE_MISSING='/parse-archive' run --image img:1 --flag DOCUMENTS_ARCHIVES_ENABLED=)"
check "флаг выключен: причина в выводе" 1 "$(count 'флаг DOCUMENTS_ARCHIVES_ENABLED выключен')"
check "флаг включён: нет маршрута - код 1" 1 \
  "$(FAKE_MISSING='/parse-archive' run --image img:1 --flag DOCUMENTS_ARCHIVES_ENABLED=true)"
check "флаг неизвестен: нет маршрута - код 1" 1 \
  "$(FAKE_MISSING='/parse-archive' run --image img:1 --flag OTHER=1)"
check "флаги передаются контейнеру" 1 \
  "$(grep -c -- '-e DOCUMENTS_ARCHIVES_ENABLED=true' "$CALLS" || true)"
check "контейнер без сети и без привилегий" 5 \
  "$(grep '^docker run' "$CALLS" | grep -c -- '--network none --cap-drop ALL' || true)"
check "нет образа: код 3" 3 "$(FAKE_NO_IMAGE=1 run --image img:1)"
check "сбой запуска: код 3" 3 "$(FAKE_RUN_FAIL=1 run --image img:1)"
check "без --image: код 2" 2 "$(run)"
check "нет манифеста: код 2" 2 \
  "$(PATH="$STUBS:$PATH" bash "$SCRIPT" --image img:1 --manifest "$WORK/нет" \
    >/dev/null 2>&1; echo $?)"
check "сервис без маршрутов в манифесте: код 3" 3 "$(run --image img:1 --service embeddings)"

if [[ -n "${BAI_ROUTES_IMAGE_GREEN:-}" && -n "${BAI_ROUTES_IMAGE_RED:-}" ]]; then
  REAL="${BAI_ROUTES_MANIFEST:-$MANIFEST}"
  rc=0; bash "$SCRIPT" --image "$BAI_ROUTES_IMAGE_GREEN" --manifest "$REAL" \
    --flags-file "$HERE/route-flags.tsv" --flag DOCUMENTS_EDIT_ENDPOINTS=true \
    --flag DOCUMENTS_TEMPLATE_ENDPOINTS=true --flag DOCUMENTS_IMAGE_TEXT_ENDPOINT=true \
    --flag DOCUMENTS_ARCHIVES_ENABLED= >"$WORK/real-green.txt" 2>&1 || rc=$?
  check "настоящий образ проекта: код 0" 0 "$rc"
  rc=0; bash "$SCRIPT" --image "$BAI_ROUTES_IMAGE_RED" --manifest "$REAL" \
    --flags-file "$HERE/route-flags.tsv" --flag DOCUMENTS_EDIT_ENDPOINTS=true \
    --flag DOCUMENTS_TEMPLATE_ENDPOINTS=true --flag DOCUMENTS_IMAGE_TEXT_ENDPOINT=true \
    --flag DOCUMENTS_ARCHIVES_ENABLED= >"$WORK/real-red.txt" 2>&1 || rc=$?
  check "платформенный образ без слоя: код 1" 1 "$rc"
  check "платформенный образ: нет всех четырёх /docx/*" 4 \
    "$(grep -c 'нет маршрута в образе: POST /docx/' "$WORK/real-red.txt" || true)"
fi

for file in "$SCRIPT" "$HERE/check-image-routes.test.sh"; do
  check "bash -n $(basename "$file")" 0 "$(bash -n "$file" >/dev/null 2>&1 && echo 0 || echo 1)"
  check "строки до $MAX_LINE: $(basename "$file")" 0 \
    "$(LC_ALL=C.UTF-8 grep -cE "^.{$((MAX_LINE + 1)),}\$" "$file" || true)"
done
echo "проверок: $CHECKS, провалено: $FAILED"
[[ "$FAILED" -eq 0 ]]
