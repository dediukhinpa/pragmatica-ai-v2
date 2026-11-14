#!/usr/bin/env bash
# Проверка подписей образов из images.lock ДО выкатки на бой. Запускает владелец на Fornex
# (там есть cosign и вход в реестр). Ничего не ставит и не меняет, кроме файла результата.
#
# Использование:
#   bash verify-signatures.sh --lock ФАЙЛ --pubkey ФАЙЛ [--out ФАЙЛ] [--help]
#
#   --lock ФАЙЛ     images.lock (dotenv): строка BAI_VERSION=... и строки
#                   BAI_IMAGE_<ИМЯ>=<репозиторий>@sha256:<64 hex>; других строк быть не должно
#   --pubkey ФАЙЛ   открытый ключ cosign (cosign.pub)
#   --out ФАЙЛ      куда писать результат (по умолчанию ./signatures.txt, режим 644)
#
# Для каждого BAI_IMAGE_* выполняется так же, как у платформы (docs/BAI-CLI.md, `bai verify`):
#   cosign verify --key <pubkey> --insecure-ignore-tlog=true <ссылка>
# (подписи делаются без публичного журнала прозрачности, доверие держится на ключе).
# Команда cosign подменяется переменной VERIFY_COSIGN (для тестов), по умолчанию `cosign`;
# предел времени на один образ - VERIFY_TIMEOUT_S (по умолчанию 120 с).
#
# Файл результата - СТРОГО такого формата (его разбирает cutover.sh, формат не менять):
#   # verify-signatures v1
#   lock_sha256=<sha256 файла lock>
#   pubkey_sha256=<sha256 файла pubkey>
#   cosign=<первая строка версии cosign (GitVersion) либо unknown>
#   verified_at=<UTC, 2026-11-14T08:00:00Z>
#   image<TAB><ИМЯ ключа><TAB><ссылка с digest><TAB><OK|FAIL>   (по строке на образ, порядок lock)
#   result=<OK|FAIL>
# result=OK только если ВСЕ образы OK и их больше нуля. Вывод cosign в файл и на stdout не
# попадает; при FAIL в stderr идут последние 3 строки его вывода без строк с токенами.
# На stdout печатается то же содержимое, что и в файле, - больше ничего.
#
# Коды выхода: 0 - все подписи верны (result=OK); 1 - есть образ без верной подписи (файл с
# result=FAIL записан); 2 - неверный вызов; 3 - отказ: нет cosign, нет/плох lock или ключ, нет
# каталога результата (файл результата при отказе не создаётся, прежний файл нашего формата
# убирается, чтобы старое OK не выдавалось за свежее).
set -euo pipefail
umask 022

# ---------------------------------------------------------------------------------------------
# Константы
# ---------------------------------------------------------------------------------------------
EXIT_OK=0 EXIT_FAIL=1 EXIT_USAGE=2 EXIT_REFUSED=3
RESULT_MAGIC="# verify-signatures v1"
DEFAULT_OUT="./signatures.txt"
RESULT_MODE=644
VERIFY_COSIGN="${VERIFY_COSIGN:-cosign}"
VERIFY_TIMEOUT_S="${VERIFY_TIMEOUT_S:-120}"
SHA256_HEX_LEN=64
ERR_TAIL_LINES=3
VERSION_MAX_LEN=100
TIME_FORMAT="+%Y-%m-%dT%H:%M:%SZ"
# Строки вывода cosign с этими словами и длинные «капли» (токены, подписи) в stderr не идут.
SECRET_LINE_RE='token|password|passwd|secret|authorization|bearer|credential'
LONG_BLOB_RE='[A-Za-z0-9+/=_.-]{80,}'
HIDDEN="<скрыто>"
# Допустимые форматы строк lock.
KEY_RE='^BAI_IMAGE_[A-Z0-9_]+$'
VERSION_RE='^[A-Za-z0-9][A-Za-z0-9._+-]*$'
IMAGE_REF_RE="^[a-z0-9][A-Za-z0-9._/:-]*@sha256:[0-9a-f]{${SHA256_HEX_LEN}}\$"

LOCK_FILE=""
PUBKEY_FILE=""
OUT_FILE="$DEFAULT_OUT"
LOCK_KEYS=()
LOCK_REFS=()
REFUSALS=0

usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }
die_usage() { echo "ошибка вызова: $1" >&2; echo "см. --help" >&2; exit "$EXIT_USAGE"; }
refuse() { echo "отказ: $1" >&2; REFUSALS=$((REFUSALS + 1)); }
finish_refused() {
  echo "отказ: проверка подписей не выполнялась, файл результата не создан." >&2
  exit "$EXIT_REFUSED"
}

# ---------------------------------------------------------------------------------------------
# Разбор аргументов
# ---------------------------------------------------------------------------------------------
while (($# > 0)); do
  case "$1" in
    --lock) LOCK_FILE="${2:?--lock требует файл}"; shift 2 ;;
    --pubkey) PUBKEY_FILE="${2:?--pubkey требует файл}"; shift 2 ;;
    --out) OUT_FILE="${2:?--out требует файл}"; shift 2 ;;
    --help | -h) usage; exit "$EXIT_OK" ;;
    *) die_usage "неизвестный аргумент: $1" ;;
  esac
done
[[ -n "$LOCK_FILE" ]] || die_usage "не задан --lock"
[[ -n "$PUBKEY_FILE" ]] || die_usage "не задан --pubkey"

# ---------------------------------------------------------------------------------------------
# Предусловия и разбор lock
# ---------------------------------------------------------------------------------------------
# Прежний файл результата нашего формата убирается заранее: при отказе не должно остаться OK.
discard_stale_result() {
  if [[ -f "$OUT_FILE" ]] && [[ "$(head -n 1 "$OUT_FILE" 2>/dev/null || true)" == "$RESULT_MAGIC" ]]
  then
    rm -f -- "${OUT_FILE:?}"
  fi
}

# Разбор images.lock: заполняет LOCK_KEYS/LOCK_REFS, ошибки формата копит через refuse.
parse_lock() {
  local line n=0 key value version_count=0
  local -A seen=()
  while IFS= read -r line || [[ -n "$line" ]]; do
    n=$((n + 1))
    if [[ "$line" == *$'\r'* ]]; then
      refuse "lock, строка $n: символ возврата каретки (файл с CRLF)"
      continue
    fi
    [[ "$line" =~ ^[[:space:]]*$ || "$line" == "#"* ]] && continue
    if [[ ! "$line" =~ ^([A-Z][A-Z0-9_]*)=(.*)$ ]]; then
      refuse "lock, строка $n: не формат ИМЯ=значение"
      continue
    fi
    key="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    if [[ -n "${seen[$key]:-}" ]]; then
      refuse "lock, строка $n: ключ $key повторён"
      continue
    fi
    seen[$key]=1
    if [[ "$key" == "BAI_VERSION" ]]; then
      version_count=$((version_count + 1))
      [[ "$value" =~ $VERSION_RE ]] || refuse "lock, строка $n: BAI_VERSION пуст или неверен"
    elif [[ "$key" =~ $KEY_RE ]]; then
      if [[ -z "$value" ]]; then
        refuse "lock, строка $n: $key - пустое значение"
      elif [[ ! "$value" =~ $IMAGE_REF_RE ]]; then
        refuse "lock, строка $n: $key - ссылка не вида репозиторий@sha256:<64 hex> (тег?)"
      else
        LOCK_KEYS+=("$key")
        LOCK_REFS+=("$value")
      fi
    else
      refuse "lock, строка $n: неизвестный ключ $key (ожидаются BAI_VERSION и BAI_IMAGE_*)"
    fi
  done <"$LOCK_FILE"
  ((version_count == 1)) || refuse "lock: нет строки BAI_VERSION"
  ((${#LOCK_KEYS[@]} > 0)) || refuse "lock: нет ни одной строки BAI_IMAGE_*"
}

sha256_of() { sha256sum -- "$1" | cut -d' ' -f1; }

# Первая содержательная строка версии cosign: GitVersion, иначе первая непустая; иначе unknown.
cosign_version() {
  local out line
  out="$("$VERIFY_COSIGN" version 2>/dev/null || true)"
  line="$(grep -m1 -E '^GitVersion:' <<<"$out" | sed -E 's/^GitVersion:[[:space:]]*//' || true)"
  [[ -n "$line" ]] || line="$(grep -m1 -v '^[[:space:]]*$' <<<"$out" || true)"
  line="$(LC_ALL=C tr -cd '[:print:]' <<<"$line" | sed -E 's/^ +| +$//g')"
  line="${line:0:VERSION_MAX_LEN}"
  printf '%s' "${line:-unknown}"
}

# Последние строки вывода cosign для stderr: без строк с токенами и длинных «капель».
show_failure() {
  local key="$1" output="$2"
  echo "FAIL $key: последние $ERR_TAIL_LINES строки вывода cosign:" >&2
  tail -n "$ERR_TAIL_LINES" <<<"$output" \
    | sed -E -e "/($SECRET_LINE_RE)/Id" -e "s/$LONG_BLOB_RE/$HIDDEN/g" \
    | sed 's/^/  | /' >&2
}

discard_stale_result_and_check() {
  discard_stale_result
  [[ -f "$LOCK_FILE" && -r "$LOCK_FILE" ]] || refuse "нет файла lock: $LOCK_FILE"
  if [[ ! -s "$PUBKEY_FILE" || ! -r "$PUBKEY_FILE" ]]; then
    refuse "нет файла ключа (или он пуст): $PUBKEY_FILE"
  elif grep -q 'PRIVATE KEY' "$PUBKEY_FILE"; then
    refuse "в --pubkey лежит ЗАКРЫТЫЙ ключ: передайте cosign.pub"
  fi
  [[ -d "$(dirname -- "$OUT_FILE")" ]] || refuse "нет каталога для результата: $OUT_FILE"
  command -v "$VERIFY_COSIGN" >/dev/null 2>&1 || refuse "нет команды cosign ($VERIFY_COSIGN)"
  command -v sha256sum >/dev/null 2>&1 || refuse "нет команды sha256sum"
  if ((REFUSALS == 0)); then parse_lock; fi
  if ((REFUSALS > 0)); then finish_refused; fi
}
discard_stale_result_and_check

# ---------------------------------------------------------------------------------------------
# Проверка подписей
# ---------------------------------------------------------------------------------------------
lines=("$RESULT_MAGIC")
lines+=("lock_sha256=$(sha256_of "$LOCK_FILE")")
lines+=("pubkey_sha256=$(sha256_of "$PUBKEY_FILE")")
lines+=("cosign=$(cosign_version)")
lines+=("verified_at=$(date -u "$TIME_FORMAT")")

all_ok=1
for i in "${!LOCK_KEYS[@]}"; do
  rc=0
  output="$(timeout "$VERIFY_TIMEOUT_S" "$VERIFY_COSIGN" verify --key "$PUBKEY_FILE" \
    --insecure-ignore-tlog=true "${LOCK_REFS[$i]}" 2>&1)" || rc=$?
  if ((rc == 0)); then
    status="OK"
  else
    status="FAIL"
    all_ok=0
    show_failure "${LOCK_KEYS[$i]}" "$output"
  fi
  lines+=("image"$'\t'"${LOCK_KEYS[$i]}"$'\t'"${LOCK_REFS[$i]}"$'\t'"$status")
done

if ((all_ok == 1)); then result="OK"; else result="FAIL"; fi
lines+=("result=$result")

printf '%s\n' "${lines[@]}" >"$OUT_FILE"
chmod "$RESULT_MODE" "$OUT_FILE"
printf '%s\n' "${lines[@]}"

[[ "$result" == "OK" ]] || exit "$EXIT_FAIL"
exit "$EXIT_OK"
