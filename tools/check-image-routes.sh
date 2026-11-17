#!/usr/bin/env bash
# Проверка маршрутов в ОБРАЗЕ сервиса документов до запуска стека: каждый маршрут `documents`
# из манифеста (tools/route-manifest.ts) должен быть зарегистрирован в приложении, которое образ
# запускает по умолчанию (`python -m <модуль>`). Нужна там, где стек ещё не поднят (preflight
# переключения и репетиции): платформенный образ без проектного слоя не имеет `/docx/*`, и это
# видно сразу, без обращения к сети.
#
#   bash tools/check-image-routes.sh --image ССЫЛКА --manifest routes.tsv [--service documents]
#                                    [--flags-file route-flags.tsv] [--flag ИМЯ=ЗНАЧЕНИЕ ...]
#
# Маршруты, которые сервис регистрирует только при флаге окружения (карта route-flags.tsv:
# сервис, путь, переменная), пропускаются, если флаг в --flag выключен (значения по правилам
# карты: 1/true/yes/on - включён). Флаг без значения в --flag считается неизвестным, и маршрут
# проверяется. Приложение образа создаётся с теми же флагами (передаются в контейнер).
#
# Образ запускается одноразовым контейнером без сети (`--network none`), без привилегий, с
# лимитом памяти; сервис не стартует, создаётся только объект приложения и читается таблица его
# маршрутов. Образ должен быть на хосте (docker pull не делается).
#
# Коды выхода: 0 - все маршруты на месте; 1 - каких-то маршрутов нет (перечень в выводе);
# 2 - неверный вызов; 3 - проверку выполнить не удалось (нет образа, docker, не разобран вывод).
set -euo pipefail
export LC_ALL=C

readonly EXIT_OK=0
readonly EXIT_MISSING=1
readonly EXIT_USAGE=2
readonly EXIT_UNABLE=3
# Лимит памяти одноразового контейнера: приложение документов импортирует тяжёлые библиотеки.
readonly CHECK_MEM=512m
readonly CHECK_TIMEOUT_S=120
readonly KIND_ROUTE="route"

IMAGE=""
MANIFEST=""
SERVICE="documents"
FLAGS_FILE="$(dirname "$0")/route-flags.tsv"
FLAGS=()

log() { echo "[check-image-routes] $*"; }
usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }
die_usage() { echo "check-image-routes: $*" >&2; usage >&2; exit "$EXIT_USAGE"; }

while (($#)); do
  case "$1" in
    --image) IMAGE="${2:?--image требует ссылку}"; shift ;;
    --manifest) MANIFEST="${2:?--manifest требует файл}"; shift ;;
    --service) SERVICE="${2:?--service требует имя}"; shift ;;
    --flags-file) FLAGS_FILE="${2:?--flags-file требует файл}"; shift ;;
    --flag) [[ "${2:?--flag требует ИМЯ=ЗНАЧЕНИЕ}" == *=* ]] || die_usage "--flag: ИМЯ=ЗНАЧЕНИЕ"
            FLAGS+=("$2"); shift ;;
    -h | --help) usage; exit "$EXIT_OK" ;;
    *) die_usage "неизвестный ключ: $1" ;;
  esac
  shift
done
[[ -n "$IMAGE" ]] || die_usage "не указан --image"
[[ -n "$MANIFEST" && -f "$MANIFEST" ]] || die_usage "манифест не найден: ${MANIFEST:-не указан}"
command -v docker >/dev/null || { log "нет docker"; exit "$EXIT_UNABLE"; }

# Значение флага по имени из --flag (пусто, если не задан); истина - 1/true/yes/on.
flag_state() { # flag_state <имя> -> on | off | unknown
  local item name="$1" value
  for item in ${FLAGS[@]+"${FLAGS[@]}"}; do
    if [[ "${item%%=*}" == "$name" ]]; then
      value="$(printf '%s' "${item#*=}" | tr '[:upper:]' '[:lower:]')"
      case "$value" in 1 | true | yes | on) echo on ;; *) echo off ;; esac
      return 0
    fi
  done
  echo unknown
}

# Требуемые маршруты сервиса: «МЕТОД ПУТЬ» по одному в строке (только вид route).
required="$(awk -F'\t' -v s="$SERVICE" -v k="$KIND_ROUTE" \
  '$1 == s && $4 == k { print $2 " " $3 }' "$MANIFEST")"
# Маршруты за выключенным флагом не требуются.
if [[ -f "$FLAGS_FILE" && ${#FLAGS[@]} -gt 0 ]]; then
  kept=""
  while IFS= read -r line; do
    path="${line#* }"
    flag="$(awk -F'\t' -v s="$SERVICE" -v p="$path" '$1 == s && $2 == p { print $3 }' \
      "$FLAGS_FILE" | head -1)"
    if [[ -n "$flag" && "$(flag_state "$flag")" == off ]]; then
      log "пропущен $line: флаг $flag выключен"
      continue
    fi
    kept+="$line"$'\n'
  done <<<"$required"
  required="${kept%$'\n'}"
fi
[[ -n "$required" ]] || { log "в манифесте нет маршрутов сервиса $SERVICE"; exit "$EXIT_UNABLE"; }

# Модуль точки входа образа: `python -m <модуль>` из Cmd.
cmd_json="$(docker image inspect --format '{{json .Config.Cmd}}' "$IMAGE" 2>/dev/null)" \
  || { log "образа нет на хосте: $IMAGE"; exit "$EXIT_UNABLE"; }
module="$(printf '%s' "$cmd_json" | sed -n 's/.*"-m","\([A-Za-z0-9_.]*\)".*/\1/p')"
[[ -n "$module" ]] \
  || { log "точка входа образа не вида python -m <модуль>: $cmd_json"; exit "$EXIT_UNABLE"; }

read -r -d '' PROBE <<'PY' || true
import importlib
import os
import sys

module = sys.argv[1]
required = [line.split(" ", 1) for line in os.environ["REQUIRED_ROUTES"].splitlines() if line]
factory = None
for sub in ("app", "api"):
    try:
        factory = importlib.import_module(f"{module}.{sub}").create_app
        break
    except (ImportError, AttributeError):
        continue
if factory is None:
    print("ERR no_app_factory")
    sys.exit(3)
present = {(m, r.path) for r in factory().routes for m in (getattr(r, "methods", None) or ())}
for method, path in required:
    print(("OK " if (method, path) in present else "MISSING ") + method + " " + path)
PY

flag_env=()
for item in ${FLAGS[@]+"${FLAGS[@]}"}; do flag_env+=(-e "$item"); done
out="$(timeout "$CHECK_TIMEOUT_S" docker run --rm --network none --cap-drop ALL \
  --security-opt no-new-privileges:true --memory "$CHECK_MEM" \
  -e "REQUIRED_ROUTES=$required" "${flag_env[@]}" --entrypoint python "$IMAGE" \
  -c "$PROBE" "$module" 2>/dev/null)" \
  || { log "не удалось получить таблицу маршрутов образа $IMAGE"; exit "$EXIT_UNABLE"; }

missing=0
while IFS= read -r line; do
  case "$line" in
    OK\ *) ;;
    MISSING\ *) log "нет маршрута в образе: ${line#MISSING }"; missing=$((missing + 1)) ;;
    *) log "непонятный вывод проверки: ${line:0:80}"; exit "$EXIT_UNABLE" ;;
  esac
done <<<"$out"
total="$(printf '%s\n' "$required" | wc -l)"
if ((missing > 0)); then
  log "ПРОВАЛ: в образе нет $missing из $total маршрутов $SERVICE (модуль $module)"
  exit "$EXIT_MISSING"
fi
log "ok: все $total маршрутов $SERVICE есть в образе (модуль $module)"
