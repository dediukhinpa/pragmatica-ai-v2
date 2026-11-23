#!/usr/bin/env bash
# Проверка хранилища псевдонимизатора (v2, платформа 1.1.2) на КОПИИ тома боя, которую уже
# сняла репетиция. Печатает только счётчики и ok/warn/fail: ни ключа, ни оригиналов, ни токенов.
#
# Использование:
#   [PSEUDONYMIZER_KEY=<ключ>] bash check-pseudonymizer-store.sh --image ОБРАЗ --volume ТОМ
#       [--db-name ФАЙЛ] [--env-file ФАЙЛ] [--sample N] [--checks-file ФАЙЛ] [--help]
#
#   --image       образ псевдонимизатора v2 (по digest из images.lock);
#   --volume      docker-том с копией хранилища репетиции (`<проект>_pseudonymizer-data`);
#   --db-name     имя файла хранилища в томе (по умолчанию pseudonymizer.sqlite3);
#   --env-file    файл окружения репетиции (rehearsal.env): из него берутся PSEUDONYMIZER_KEY и
#                 PSEUDONYMIZER_KEY_SCHEME, если их нет в окружении (значения не печатаются);
#   --sample      сколько токенов раскрыть выборочно (по умолчанию 20);
#   --checks-file дописать результаты и в checks.tsv репетиции (формат имя<TAB>статус<TAB>текст).
#
# Ключ: переменная окружения PSEUDONYMIZER_KEY (как у rehearse.sh) либо --env-file. Схема ключей:
# PSEUDONYMIZER_KEY_SCHEME (по умолчанию v2, как в compose платформы).
#
# Что делает. Том репетиции монтируется ТОЛЬКО на чтение. Из него средствами SQLite (backup API)
# снимается копия-в-копии на временный том, и все проверки идут на ней, поэтому открытие
# хранилища сервисом (метки активности), `rekey --dry-run` и самопроверка не меняют копию
# репетиции. Контейнер одноразовый: без сети, без привилегий, с файловой системой на чтение.
# Проверки: копия-в-копии; PRAGMA integrity_check; открытие хранилища кодом 1.1.2 (как при
# старте сервиса); `python -m labops_pii.rekey --dry-run` (всего строк и сколько на схеме v1);
# выборочное раскрытие N токенов и поиск их по слепому индексу (только числа).
#
# Вывод (stdout): `ok|warn|fail<TAB>имя<TAB>пояснение`. Коды выхода: 0 - нет fail; 1 - есть fail;
# 2 - неверный вызов (ничего не запускалось).
set -euo pipefail
umask 077

DEFAULT_SAMPLE=20
DEFAULT_DB_NAME="pseudonymizer.sqlite3"
DEFAULT_KEY_SCHEME="v2"
KEY_VAR="PSEUDONYMIZER_KEY"
SCHEME_VAR="PSEUDONYMIZER_KEY_SCHEME"
# Предел времени проверки и памяти одноразового контейнера.
RUN_TIMEOUT_S=900
RUN_MEM="512m"
TMP_SIZE="16m"
KIB=1024
EXIT_USAGE=2
SRC_MOUNT="/src"
WORK_MOUNT="/data"
WORK_DB="check.sqlite3"
CONTAINER="pseudonymizer-store-check-$$"
SCRATCH_VOLUME="pseudonymizer-store-check-$$"
CHECK_LABEL="com.labops.rehearsal=pseudonymizer-store-check"

IMAGE="${PSEUDO_CHECK_IMAGE:-}"
VOLUME=""
DB_NAME="$DEFAULT_DB_NAME"
ENV_FILE=""
SAMPLE="$DEFAULT_SAMPLE"
CHECKS_FILE=""
STATUS=0
SCRATCH_CREATED=0

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }
usage_error() { echo "ошибка вызова: $*" >&2; exit "$EXIT_USAGE"; }

# emit <статус> <имя> <пояснение>: строка результата (stdout) и, если задан, checks.tsv.
emit() {
  printf '%s\t%s\t%s\n' "$1" "$2" "$3"
  if [[ -n "$CHECKS_FILE" ]]; then
    printf '%s\t%s\t%s\n' "$2" "$1" "$3" >>"$CHECKS_FILE"
  fi
  [[ "$1" != "fail" ]] || STATUS=1
}

while (($#)); do
  case "$1" in
    --image) IMAGE="${2:?--image требует значение}"; shift 2 ;;
    --volume) VOLUME="${2:?--volume требует значение}"; shift 2 ;;
    --db-name) DB_NAME="${2:?--db-name требует значение}"; shift 2 ;;
    --env-file) ENV_FILE="${2:?--env-file требует значение}"; shift 2 ;;
    --sample) SAMPLE="${2:?--sample требует значение}"; shift 2 ;;
    --checks-file) CHECKS_FILE="${2:?--checks-file требует значение}"; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) usage_error "неизвестный аргумент $1" ;;
  esac
done
[[ -n "$IMAGE" ]] || usage_error "не задан --image"
[[ -n "$VOLUME" ]] || usage_error "не задан --volume"
[[ "$SAMPLE" =~ ^[0-9]+$ ]] || usage_error "--sample должен быть числом"
[[ "$DB_NAME" =~ ^[A-Za-z0-9._-]+$ ]] || usage_error "--db-name: только имя файла"

# env_value <файл> <ИМЯ>: последнее значение без кавычек; пусто, если нет (значение не печатается).
env_value() {
  [[ -f "$1" ]] || return 0
  sed -n "s/^$2=//p" "$1" | tail -n 1 | sed -e "s/^[\"']//" -e "s/[\"']\$//"
}

NAME="хранилище"
KEY="${!KEY_VAR:-}"
SCHEME="${!SCHEME_VAR:-}"
if [[ -n "$ENV_FILE" ]]; then
  [[ -n "$KEY" ]] || KEY="$(env_value "$ENV_FILE" "$KEY_VAR")"
  [[ -n "$SCHEME" ]] || SCHEME="$(env_value "$ENV_FILE" "$SCHEME_VAR")"
fi
[[ -n "$SCHEME" ]] || SCHEME="$DEFAULT_KEY_SCHEME"

cleanup() {
  docker rm -f "${CONTAINER:?}" >/dev/null 2>&1 || true
  if ((SCRATCH_CREATED)); then
    docker volume rm -f "${SCRATCH_VOLUME:?}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# --- Предусловия: без них проверять нечего (fail, код 1) -----------------------------------------
if [[ -z "$KEY" ]]; then
  emit fail "$NAME: предусловия" "нет $KEY_VAR в окружении и в --env-file"
  exit 1
fi
if ! command -v docker >/dev/null 2>&1; then
  emit fail "$NAME: предусловия" "нет docker"
  exit 1
fi
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  emit fail "$NAME: предусловия" "нет образа псевдонимизатора $IMAGE"
  exit 1
fi
if ! docker volume inspect "$VOLUME" >/dev/null 2>&1; then
  emit fail "$NAME: предусловия" "нет тома копии $VOLUME"
  exit 1
fi
LABEL_ARGS=(--label "$CHECK_LABEL")
[[ -z "${PSEUDO_CHECK_LABEL:-}" ]] || LABEL_ARGS+=(--label "$PSEUDO_CHECK_LABEL")
if ! docker volume create "${LABEL_ARGS[@]}" "$SCRATCH_VOLUME" >/dev/null 2>&1; then
  emit fail "$NAME: предусловия" "не создан временный том копии-в-копии"
  exit 1
fi
SCRATCH_CREATED=1

# --- Проверки внутри одноразового контейнера -----------------------------------------------------
# Программа идёт со стандартного ввода. Печатает ТОЛЬКО строки ключ=число/слово: типы ошибок и
# счётчики, но не значения, токены и ключи.
read -r -d '' PY_CHECK <<'PY' || true
import os
import re
import sqlite3
import subprocess
import sys
from pathlib import Path

src = Path(os.environ["CHECK_SRC"])
dst = Path(os.environ["CHECK_DST"])
sample = int(os.environ["CHECK_SAMPLE"])
V1_RE = re.compile(r"всего строк: (\d+), на схеме v1 было: (\d+)")


def out(key: str, value: object) -> None:
    """Печатает одну строку протокола."""
    print(f"{key}={value}", flush=True)


# 1. Копия-в-копии средствами SQLite; источник открыт только на чтение.
try:
    ro = sqlite3.connect(f"file:{src}?mode=ro", uri=True)
    rw = sqlite3.connect(str(dst))
    ro.backup(rw)
    rw.close()
    ro.close()
    out("copy", "ok")
    out("size_bytes", dst.stat().st_size)
except Exception as exc:  # noqa: BLE001 - наружу только тип ошибки
    out("copy", f"ERR:{type(exc).__name__}")
    sys.exit(0)


def check_copy() -> None:
    """Шаги 2-6 на копии-в-копии; любой сбой даёт одну строку fatal=<тип ошибки>."""
    # 2. PRAGMA integrity_check на копии.
    conn = sqlite3.connect(f"file:{dst}?mode=ro", uri=True)
    verdict = [row[0] for row in conn.execute("PRAGMA integrity_check")]
    out("integrity", "ok" if verdict == ["ok"] else f"bad:{len(verdict)}")
    conn.close()

    # 3. Открытие хранилища кодом образа (как при старте сервиса: таблицы, метки активности).
    from labops_pii.store import SqliteReplacementStore

    try:
        store = SqliteReplacementStore(
            dst, os.environ["PSEUDONYMIZER_KEY"],
            key_scheme=os.environ["PSEUDONYMIZER_KEY_SCHEME"],
        )
        out("open", "ok")
    except Exception as exc:  # noqa: BLE001
        out("open", f"ERR:{type(exc).__name__}")
        return

    # 4. rekey --dry-run: тот же код, что запустит владелец (копию читает только на чтение).
    proc = subprocess.run(
        [sys.executable, "-m", "labops_pii.rekey", "--db", str(dst), "--dry-run"],
        capture_output=True, text=True, check=False,
    )
    match = V1_RE.search(proc.stderr + proc.stdout)
    out("rekey_rc", proc.returncode)
    if match:
        out("rekey_total", match.group(1))
        out("rekey_legacy", match.group(2))

    # 5. Схемы строк (по меткам формата, без значений).
    conn = sqlite3.connect(f"file:{dst}?mode=ro", uri=True)
    out("rows", conn.execute("SELECT COUNT(*) FROM replacements").fetchone()[0])
    out("threads", conn.execute("SELECT COUNT(DISTINCT thread_id) FROM replacements").fetchone()[0])
    out("rows_v3", conn.execute(
        "SELECT COUNT(*) FROM replacements WHERE key_hash LIKE 'v3:%'").fetchone()[0])
    out("rows_v1", store.legacy_row_count())

    # 6. Выборочное раскрытие: оригинал расшифровывается, ключ находится по слепому индексу.
    picked = conn.execute(
        "SELECT thread_id, token, pii_type FROM replacements ORDER BY RANDOM() LIMIT ?", (sample,)
    ).fetchall()
    conn.close()
    revealed = failed = index_ok = 0
    for thread_id, token, pii_type in picked:
        try:
            if store.get_original(thread_id, token) is None:
                failed += 1
                continue
            revealed += 1
            found = [k for k, t in store.list_keys(thread_id, pii_type) if t == token]
            if found and store.find_token(thread_id, pii_type, found[0]) == token:
                index_ok += 1
        except Exception:  # noqa: BLE001 - тип и значения не печатаем
            failed += 1
    out("sample", len(picked))
    out("revealed", revealed)
    out("reveal_failed", failed)
    out("index_ok", index_ok)
    store.close()


try:
    check_copy()
except Exception as exc:  # noqa: BLE001 - наружу только тип ошибки
    out("fatal", type(exc).__name__)
PY

DOCKER_ARGS=(run --rm -i --name "$CONTAINER" --network none --read-only
  --tmpfs "/tmp:size=$TMP_SIZE" --cap-drop ALL --security-opt no-new-privileges:true
  --memory "$RUN_MEM" "${LABEL_ARGS[@]}"
  -e "$KEY_VAR" -e "$SCHEME_VAR=$SCHEME" -e PYTHONDONTWRITEBYTECODE=1
  -e "CHECK_SRC=$SRC_MOUNT/$DB_NAME" -e "CHECK_DST=$WORK_MOUNT/$WORK_DB" -e "CHECK_SAMPLE=$SAMPLE"
  -v "$VOLUME:$SRC_MOUNT:ro" -v "$SCRATCH_VOLUME:$WORK_MOUNT"
  --entrypoint python "$IMAGE" -)

ERR_FILE="$(mktemp)"
trap 'rm -f "${ERR_FILE:?}"; cleanup' EXIT
# Ключ уходит в контейнер по имени переменной (-e PSEUDONYMIZER_KEY), в аргументах его нет.
export PSEUDONYMIZER_KEY="$KEY"
RC=0
OUT="$(printf '%s\n' "$PY_CHECK" \
  | timeout "$RUN_TIMEOUT_S" docker "${DOCKER_ARGS[@]}" 2>"$ERR_FILE")" || RC=$?

# Значение протокола по ключу (последнее вхождение); пусто, если строки нет.
get() { sed -n "s/^$1=//p" <<<"$OUT" | tail -n 1; }

COPY="$(get copy)"
if [[ "$COPY" != "ok" ]]; then
  # Хвост stderr без значения ключа и не длиннее одной строки: диагностика сбоя запуска.
  TAIL="$(tail -n 1 "$ERR_FILE" | cut -c1-160)"
  TAIL="${TAIL//"$KEY"/***}"
  emit fail "$NAME: копия-в-копии" \
    "не снята (${COPY:-контейнер завершился с кодом $RC}) ${TAIL}"
  exit 1
fi
SIZE_BYTES="$(get size_bytes)"
ROWS="$(get rows)"
emit ok "$NAME: копия-в-копии" \
  "снята backup API на временный том: строк ${ROWS:-?}, $(( ${SIZE_BYTES:-0} / KIB )) КиБ"

INTEGRITY="$(get integrity)"
if [[ "$INTEGRITY" == "ok" ]]; then
  emit ok "$NAME: PRAGMA integrity_check" "ok"
elif [[ "$INTEGRITY" == bad:* ]]; then
  emit fail "$NAME: PRAGMA integrity_check" "замечаний: ${INTEGRITY#bad:}"
else
  emit fail "$NAME: PRAGMA integrity_check" "нет ответа ($(get fatal))"
fi

OPEN="$(get open)"
if [[ "$OPEN" == "ok" ]]; then
  emit ok "$NAME: самопроверка открытия" "открыто кодом образа, схема записи $SCHEME"
else
  emit fail "$NAME: самопроверка открытия" "${OPEN:-нет ответа} (схема $SCHEME)"
  exit 1
fi

REKEY_RC="$(get rekey_rc)"
REKEY_TOTAL="$(get rekey_total)"
REKEY_LEGACY="$(get rekey_legacy)"
if [[ "$REKEY_RC" != "0" || -z "$REKEY_TOTAL" ]]; then
  emit fail "$NAME: rekey --dry-run" \
    "расшифровка не прошла (код ${REKEY_RC:-?}): неверный ключ или повреждённые данные"
elif ((${REKEY_LEGACY:-0} > 0)); then
  emit warn "$NAME: rekey --dry-run" \
    "всего строк $REKEY_TOTAL, схема v1: $REKEY_LEGACY (читаются как есть; rekey не обязателен)"
else
  emit ok "$NAME: rekey --dry-run" "всего строк $REKEY_TOTAL, строк схемы v1: 0"
fi
emit ok "$NAME: схемы строк" \
  "v1: $(get rows_v1), v3: $(get rows_v3), тредов: $(get threads), строк: ${ROWS:-?}"

SAMPLED="$(get sample)"
REVEALED="$(get revealed)"
REVEAL_FAILED="$(get reveal_failed)"
INDEX_OK="$(get index_ok)"
if [[ -z "$SAMPLED" ]]; then
  emit fail "$NAME: раскрытие выборки" "нет ответа контейнера"
elif [[ "$SAMPLED" == "0" ]]; then
  emit warn "$NAME: раскрытие выборки" "таблица замен пуста: раскрывать нечего"
elif [[ "$REVEALED" == "$SAMPLED" && "$REVEAL_FAILED" == "0" && "$INDEX_OK" == "$SAMPLED" ]]; then
  emit ok "$NAME: раскрытие выборки" \
    "раскрыто $REVEALED из $SAMPLED, найдено по индексу $INDEX_OK (значения не выводятся)"
else
  emit fail "$NAME: раскрытие выборки" \
    "раскрыто ${REVEALED:-0} из $SAMPLED, ошибок ${REVEAL_FAILED:-?}, по индексу ${INDEX_OK:-0}"
fi
FATAL="$(get fatal)"
[[ -z "$FATAL" ]] || emit fail "$NAME: проверка в контейнере" "прервана: $FATAL"
exit "$STATUS"
