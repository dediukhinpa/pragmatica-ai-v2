#!/usr/bin/env bash
# Тест deploy/cutover/verify-signatures.sh на заглушке cosign (сеть и реестр не нужны). Проверяет:
# формат файла результата (его разбирает cutover.sh), код выхода при всех OK / одном FAIL / без
# cosign / с битым lock, подлинность sha256 lock и ключа в файле, отсутствие посторонних данных
# (вывода cosign, токенов) в файле и выводе. Каталог скриптов можно подменить: CUTOVER_DIR (для
# красного прогона: CUTOVER_DIR=/nonexistent - все проверки обязаны упасть).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
CUTOVER_DIR="${CUTOVER_DIR:-$ROOT/deploy/cutover}"
SCRIPT="$CUTOVER_DIR/verify-signatures.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP:?}"' EXIT
PASS=0
FAIL=0
LIMIT=100
EXIT_FAIL=1
EXIT_USAGE=2
EXIT_REFUSED=3
TAB=$'\t'
SHA_A="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
SHA_B="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
SHA_C="cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
NOISE="SECRETNOISE-payload"
FORBIDDEN_CMDS="docker|sudo|curl|wget"
TOKEN_TEXT="sk-TOPSECRET-0123456789"

ok() { PASS=$((PASS + 1)); echo "PASS $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL $1"; }
assert() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

# --- Заглушка cosign ---------------------------------------------------------------------------
BIN="$TMP/bin"
mkdir -p "$BIN"
cat >"$BIN/cosign" <<'STUB'
#!/usr/bin/env bash
# Заглушка: пишет вызов в журнал; verify падает для ссылок с подстрокой STUB_FAIL_MATCH.
printf '%s\n' "$*" >>"$COSIGN_LOG"
case "${1:-}" in
  version)
    if [[ -n "${STUB_PLAIN_VERSION:-}" ]]; then echo "cosign-stub 1.2.3"; exit 0; fi
    printf '  ______   ______\n\nGitVersion:    v9.9.9-stub\nGitCommit:     abc\n'
    exit 0 ;;
  verify)
    ref="${*: -1}"
    echo "{\"critical\":\"$STUB_NOISE\"}"
    if [[ -n "${STUB_FAIL_MATCH:-}" && "$ref" == *"$STUB_FAIL_MATCH"* ]]; then
      echo "Error: no signatures found" >&2
      echo "Authorization: Bearer $STUB_TOKEN" >&2
      echo "main.go:42: verification failed" >&2
      exit 1
    fi
    exit 0 ;;
  *) exit 0 ;;
esac
STUB
chmod +x "$BIN/cosign"

# --- Входные файлы -----------------------------------------------------------------------------
GOOD_LOCK="$TMP/good.lock"
cat >"$GOOD_LOCK" <<EOF
# images.lock теста
BAI_VERSION=1.0.1-test.1
BAI_IMAGE_APP=registry.example/team/app@sha256:$SHA_A
BAI_IMAGE_NGINX=registry.example:5000/nginx@sha256:$SHA_B

BAI_IMAGE_POSTGRES=registry.example/pgvector@sha256:$SHA_C
EOF
PUBKEY="$TMP/cosign.pub"
printf '%s\n' '-----BEGIN PUBLIC KEY-----' 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEstub' \
  '-----END PUBLIC KEY-----' >"$PUBKEY"

# run_sig <имя> [аргументы скрипта] ... (окружение - через env снаружи): stdout/stderr раздельно.
# Код выхода - в переменной RC; журнал вызовов cosign - $TMP/cosign-<имя>.log.
RC=0
run_sig() {
  local name="$1"
  shift
  : >"$TMP/cosign-$name.log"
  RC=0
  env PATH="$BIN:$PATH" COSIGN_LOG="$TMP/cosign-$name.log" STUB_NOISE="$NOISE" \
    STUB_TOKEN="$TOKEN_TEXT" VERIFY_COSIGN="${VERIFY_COSIGN:-cosign}" \
    bash "$SCRIPT" "$@" >"$TMP/out-$name.txt" 2>"$TMP/err-$name.txt" || RC=$?
}
# Допустимые строки файла результата (формат для cutover.sh).
LINE_RE_FILE="^(# verify-signatures v1|lock_sha256=[0-9a-f]{64}|pubkey_sha256=[0-9a-f]{64}"
LINE_RE_FILE+="|cosign=[^${TAB}]+"
LINE_RE_FILE+="|verified_at=[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z"
LINE_RE_FILE+="|image${TAB}BAI_IMAGE_[A-Z0-9_]+${TAB}[^${TAB}]+@sha256:[0-9a-f]{64}${TAB}(OK|FAIL)"
LINE_RE_FILE+="|result=(OK|FAIL))\$"

# Ожидаемые строки образов и аргументы вызова cosign.
ROW_APP="image${TAB}BAI_IMAGE_APP${TAB}registry.example/team/app@sha256:$SHA_A${TAB}OK"
ROW_NGINX="image${TAB}BAI_IMAGE_NGINX${TAB}registry.example:5000/nginx@sha256:$SHA_B${TAB}OK"
ROW_PG="image${TAB}BAI_IMAGE_POSTGRES${TAB}registry.example/pgvector@sha256:$SHA_C${TAB}OK"
VERIFY_ARGS="verify --key $PUBKEY --insecure-ignore-tlog=true"

assert "скрипт существует и исполняемый" "[[ -x '$SCRIPT' ]]"

# 1. Справка и неверный вызов.
run_sig help --help
assert "справка: код 0, есть описание" "[[ $RC -eq 0 ]] \
   && grep -q 'Использование' '$TMP/out-help.txt'"
assert "справка: сказано про VERIFY_COSIGN и формат файла" \
  "grep -q 'VERIFY_COSIGN' '$TMP/out-help.txt' \
   && grep -q 'verify-signatures v1' '$TMP/out-help.txt'"
run_sig nonsense --nonsense
assert "неизвестный аргумент: код 2" "[[ $RC -eq $EXIT_USAGE ]]"
run_sig nolockarg --pubkey "$PUBKEY"
assert "нет --lock: код 2" "[[ $RC -eq $EXIT_USAGE ]]"
run_sig nopubarg --lock "$GOOD_LOCK"
assert "нет --pubkey: код 2" "[[ $RC -eq $EXIT_USAGE ]]"

# 2. Все подписи верны.
OUT_OK="$TMP/ok/signatures.txt"
mkdir -p "$TMP/ok"
umask 077 # проверка, что режим файла 644 не зависит от umask вызывающего
run_sig allok --lock "$GOOD_LOCK" --pubkey "$PUBKEY" --out "$OUT_OK"
umask 022
assert "все OK: код 0" "[[ $RC -eq 0 ]]"
assert "все OK: файл результата создан с режимом 644" \
  "[[ -f '$OUT_OK' && \"\$(stat -c %a '$OUT_OK')\" == 644 ]]"
assert "все OK: первая строка - метка формата" \
  "[[ \"\$(sed -n 1p '$OUT_OK')\" == '# verify-signatures v1' ]]"
assert "все OK: lock_sha256 равен настоящему sha256 файла lock" \
  "grep -qx \"lock_sha256=\$(sha256sum '$GOOD_LOCK' | cut -d' ' -f1)\" '$OUT_OK'"
assert "все OK: pubkey_sha256 равен настоящему sha256 ключа" \
  "grep -qx \"pubkey_sha256=\$(sha256sum '$PUBKEY' | cut -d' ' -f1)\" '$OUT_OK'"
assert "все OK: версия cosign - строка GitVersion" "grep -qx 'cosign=v9.9.9-stub' '$OUT_OK'"
assert "все OK: verified_at в формате UTC" \
  "grep -qE '^verified_at=[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z\$' '$OUT_OK'"
assert "все OK: порядок строк - шапка (5), образы lock, result" \
  "[[ \"\$(sed -n '2p' '$OUT_OK')\" == lock_sha256=* \
   && \"\$(sed -n '3p' '$OUT_OK')\" == pubkey_sha256=* \
   && \"\$(sed -n '4p' '$OUT_OK')\" == cosign=* \
   && \"\$(sed -n '5p' '$OUT_OK')\" == verified_at=* ]]"
assert "все OK: строки образов - в порядке lock, поля через TAB" \
  "[[ \"\$(sed -n 6p '$OUT_OK')\" == '$ROW_APP' \
   && \"\$(sed -n 7p '$OUT_OK')\" == '$ROW_NGINX' \
   && \"\$(sed -n 8p '$OUT_OK')\" == '$ROW_PG' ]]"
assert "все OK: последняя строка result=OK, всего 9 строк" \
  "[[ \"\$(tail -n 1 '$OUT_OK')\" == 'result=OK' && \"\$(wc -l <'$OUT_OK')\" -eq 9 ]]"
assert "все OK: в файле нет ничего, кроме полей формата" \
  "! grep -vE '$LINE_RE_FILE' '$OUT_OK' | grep -q ."
assert "все OK: вывод cosign не попал в файл и stdout" \
  "! grep -q '$NOISE' '$OUT_OK' '$TMP/out-allok.txt'"
assert "все OK: stdout совпадает с файлом, stderr пуст" \
  "cmp -s '$OUT_OK' '$TMP/out-allok.txt' && [[ ! -s '$TMP/err-allok.txt' ]]"
assert "все OK: cosign verify вызван на каждый образ с --key и --insecure-ignore-tlog=true" \
  "[[ \"\$(grep -c '^$VERIFY_ARGS ' '$TMP/cosign-allok.log')\" -eq 3 ]]"
assert "все OK: ссылки с digest переданы cosign как есть" \
  "grep -qx '$VERIFY_ARGS registry.example:5000/nginx@sha256:$SHA_B' '$TMP/cosign-allok.log'"
# Режим файла при перезаписи: прежний файл с режимом 600 становится 644.
chmod 600 "$OUT_OK" 2>/dev/null || true
run_sig rewrite --lock "$GOOD_LOCK" --pubkey "$PUBKEY" --out "$OUT_OK"
assert "перезапись: режим снова 644" "[[ \"\$(stat -c %a '$OUT_OK')\" == 644 ]]"

# 2а. Первая строка версии без GitVersion - берётся как есть; без вывода версии - unknown.
STUB_PLAIN_VERSION=1 run_sig plainver --lock "$GOOD_LOCK" --pubkey "$PUBKEY" --out "$TMP/plain.txt"
assert "версия без GitVersion: первая строка" "grep -qx 'cosign=cosign-stub 1.2.3' '$TMP/plain.txt'"
cat >"$BIN/cosign-silent" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
chmod +x "$BIN/cosign-silent"
VERIFY_COSIGN=cosign-silent run_sig silent --lock "$GOOD_LOCK" --pubkey "$PUBKEY" \
  --out "$TMP/silent.txt"
assert "cosign без вывода версии: cosign=unknown, всё равно OK" \
  "[[ $RC -eq 0 ]] \
   && grep -qx 'cosign=unknown' '$TMP/silent.txt' \
   && grep -qx 'result=OK' '$TMP/silent.txt'"

# 3. Один образ без верной подписи.
OUT_BAD="$TMP/bad.txt"
STUB_FAIL_MATCH="nginx@" run_sig onefail --lock "$GOOD_LOCK" --pubkey "$PUBKEY" --out "$OUT_BAD"
assert "один FAIL: код 1" "[[ $RC -eq $EXIT_FAIL ]]"
assert "один FAIL: result=FAIL" "[[ \"\$(tail -n 1 '$OUT_BAD')\" == 'result=FAIL' ]]"
assert "один FAIL: помечен именно этот образ, остальные OK" \
  "grep -q \"^image${TAB}BAI_IMAGE_NGINX${TAB}.*${TAB}FAIL\$\" '$OUT_BAD' \
   && grep -q \"^image${TAB}BAI_IMAGE_APP${TAB}.*${TAB}OK\$\" '$OUT_BAD' \
   && grep -q \"^image${TAB}BAI_IMAGE_POSTGRES${TAB}.*${TAB}OK\$\" '$OUT_BAD'"
assert "один FAIL: после сбоя проверка остальных образов продолжается (3 вызова)" \
  "[[ \"\$(grep -c '^verify ' '$TMP/cosign-onefail.log')\" -eq 3 ]]"
assert "один FAIL: формат файла тот же" "! grep -vE '$LINE_RE_FILE' '$OUT_BAD' | grep -q ."
assert "один FAIL: в stderr последние строки cosign" \
  "grep -q 'verification failed' '$TMP/err-onefail.txt'"
assert "один FAIL: токен и строка Authorization в stderr скрыты" \
  "! grep -qi '$TOKEN_TEXT\|Authorization' '$TMP/err-onefail.txt'"
assert "один FAIL: токена и вывода cosign нет в файле и stdout" \
  "! grep -q \"$TOKEN_TEXT\|$NOISE\" '$OUT_BAD' '$TMP/out-onefail.txt'"
assert "один FAIL: не больше 3 строк вывода cosign в stderr" \
  "[[ \"\$(grep -c '^  | ' '$TMP/err-onefail.txt')\" -le 3 ]]"

STUB_FAIL_MATCH="registry.example" run_sig allfail --lock "$GOOD_LOCK" --pubkey "$PUBKEY" \
  --out "$TMP/allfail.txt"
assert "все FAIL: код 1 и result=FAIL" \
  "[[ $RC -eq $EXIT_FAIL ]] && grep -qx 'result=FAIL' '$TMP/allfail.txt'"

# 4. Нет cosign: отказ, файла OK нет; старый файл нашего формата убран, чужой цел.
STALE="$TMP/stale.txt"
printf '# verify-signatures v1\nresult=OK\n' >"$STALE"
VERIFY_COSIGN="$TMP/нет-такого/cosign" run_sig nocosign --lock "$GOOD_LOCK" --pubkey "$PUBKEY" \
  --out "$STALE"
assert "нет cosign: код 3" "[[ $RC -eq $EXIT_REFUSED ]]"
assert "нет cosign: сообщение об отказе" "grep -q 'нет команды cosign' '$TMP/err-nocosign.txt'"
assert "нет cosign: устаревший файл с OK убран, нового нет" "[[ ! -e '$STALE' ]]"
assert "нет cosign: на stdout ничего" "[[ ! -s '$TMP/out-nocosign.txt' ]]"
FOREIGN="$TMP/foreign.txt"
echo "чужой файл" >"$FOREIGN"
VERIFY_COSIGN="$TMP/нет-такого/cosign" run_sig foreign --lock "$GOOD_LOCK" --pubkey "$PUBKEY" \
  --out "$FOREIGN"
assert "отказ не трогает чужой файл (без нашей метки)" "grep -qx 'чужой файл' '$FOREIGN'"

# 5. Битый lock: отказ с кодом 3, cosign не вызывался, файла результата нет.
bad_lock() { # <имя> <содержимое строки(строк)>
  local name="$1"
  printf '%s\n' "BAI_VERSION=1.0.1" >"$TMP/$name.lock"
  printf '%b\n' "$2" >>"$TMP/$name.lock"
  run_sig "$name" --lock "$TMP/$name.lock" --pubkey "$PUBKEY" --out "$TMP/$name.txt"
  assert "битый lock ($name): код 3" "[[ $RC -eq $EXIT_REFUSED ]]"
  assert "битый lock ($name): файла результата нет" "[[ ! -e '$TMP/$name.txt' ]]"
  assert "битый lock ($name): cosign не вызывался" \
    "! grep -q '^verify ' '$TMP/cosign-$name.log'"
}
bad_lock tag "BAI_IMAGE_APP=registry.example/app:latest"
assert "тег вместо digest: в сообщении есть имя ключа" "grep -q 'BAI_IMAGE_APP' '$TMP/err-tag.txt'"
bad_lock empty "BAI_IMAGE_APP="
bad_lock dup "BAI_IMAGE_APP=r/app@sha256:$SHA_A\nBAI_IMAGE_APP=r/app@sha256:$SHA_B"
assert "повтор ключа: сообщение о повторе" "grep -q 'повторён' '$TMP/err-dup.txt'"
bad_lock shortsha "BAI_IMAGE_APP=r/app@sha256:abc123"
bad_lock tagplussha "BAI_IMAGE_APP=r/app:1.0@sha256:$SHA_A\nBAI_IMAGE_X=r/x:latest"
bad_lock unknownkey "BAI_IMAGE_APP=r/app@sha256:$SHA_A\nBAI_OTHER=1"
bad_lock noimages "# нет образов"
bad_lock quoted "BAI_IMAGE_APP=\"r/app@sha256:$SHA_A\""
bad_lock crlf "BAI_IMAGE_APP=r/app@sha256:$SHA_A\r"
bad_lock garbage "это не dotenv"
printf 'BAI_IMAGE_APP=r/app@sha256:%s\n' "$SHA_A" >"$TMP/nover.lock"
run_sig nover --lock "$TMP/nover.lock" --pubkey "$PUBKEY" --out "$TMP/nover.txt"
assert "lock без BAI_VERSION: код 3, файла нет" "[[ $RC -eq $EXIT_REFUSED \
   && ! -e '$TMP/nover.txt' ]]"
: >"$TMP/empty.lock"
run_sig emptylock --lock "$TMP/empty.lock" --pubkey "$PUBKEY" --out "$TMP/emptylock.txt"
assert "пустой lock: код 3, файла нет" "[[ $RC -eq $EXIT_REFUSED && ! -e '$TMP/emptylock.txt' ]]"

# 6. Прочие отказы: нет lock, нет ключа, закрытый ключ вместо открытого, нет каталога результата.
run_sig nolockfile --lock "$TMP/нет.lock" --pubkey "$PUBKEY" --out "$TMP/nolockfile.txt"
assert "нет файла lock: код 3" "[[ $RC -eq $EXIT_REFUSED && ! -e '$TMP/nolockfile.txt' ]]"
run_sig nokey --lock "$GOOD_LOCK" --pubkey "$TMP/нет.pub" --out "$TMP/nokey.txt"
assert "нет файла ключа: код 3" "[[ $RC -eq $EXIT_REFUSED && ! -e '$TMP/nokey.txt' ]]"
printf -- '-----BEGIN EC PRIVATE KEY-----\nxx\n-----END EC PRIVATE KEY-----\n' >"$TMP/cosign.key"
run_sig privkey --lock "$GOOD_LOCK" --pubkey "$TMP/cosign.key" --out "$TMP/privkey.txt"
assert "закрытый ключ вместо cosign.pub: код 3" \
  "[[ $RC -eq $EXIT_REFUSED \
   && ! -e '$TMP/privkey.txt' ]] \
   && grep -q 'ЗАКРЫТЫЙ' '$TMP/err-privkey.txt'"
run_sig nodir --lock "$GOOD_LOCK" --pubkey "$PUBKEY" --out "$TMP/нет-каталога/s.txt"
assert "нет каталога результата: код 3" "[[ $RC -eq $EXIT_REFUSED ]]"

# 7. Умолчание --out: ./signatures.txt в текущем каталоге.
mkdir -p "$TMP/cwd"
(cd "$TMP/cwd" && env PATH="$BIN:$PATH" COSIGN_LOG="$TMP/cosign-cwd.log" STUB_NOISE="$NOISE" \
  STUB_TOKEN="$TOKEN_TEXT" bash "$SCRIPT" --lock "$GOOD_LOCK" --pubkey "$PUBKEY" \
  >/dev/null 2>&1) || true
assert "по умолчанию результат пишется в ./signatures.txt" \
  "[[ -f '$TMP/cwd/signatures.txt' ]] && grep -qx 'result=OK' '$TMP/cwd/signatures.txt'"

# 8. Сам скрипт: синтаксис, длина строк, строгий режим, нет записи в сеть/бой.
assert "bash -n" "bash -n '$SCRIPT'"
assert "строки скрипта не длиннее $LIMIT" \
  "! LC_ALL=C.UTF-8 grep -qE '^.{$((LIMIT + 1)),}' '$SCRIPT'"
assert "set -euo pipefail" "grep -q '^set -euo pipefail' '$SCRIPT'"
assert "скрипт не вызывает docker, sudo, curl" \
  "! grep -vE '^[[:space:]]*#' '$SCRIPT' | grep -qE '(^|[^a-z_-])($FORBIDDEN_CMDS)[[:space:]]'"

echo "ИТОГО: ok $PASS / fail $FAIL"
[[ $FAIL -eq 0 ]]
