#!/usr/bin/env bash
# Тест deploy/rehearsal/check-pseudonymizer-store.sh в двух частях.
#   1. Заглушка docker: разбор вывода одноразового контейнера, статусы ok/warn/fail и коды
#      выхода, аргументы запуска (без сети, том репетиции только на чтение, ключ не в аргументах
#      и не в выводе), уборка временного тома, формат checks.tsv.
#   2. Настоящий образ 1.1.2 и ВЫМЫШЛЕННОЕ хранилище (фамилии, телефоны, почта придуманы): хорошее
#      хранилище со строками схем v1 и v2, неверный ключ, повреждённый файл, пустая таблица;
#      том репетиции остаётся нетронутым (хеш и состав файлов), в выводе нет значений и ключа,
#      временных томов и контейнеров не остаётся.
# Нет docker или образа - вторая часть пропускается с кодом 0 (в CI их нет). Пока скрипта нет,
# тест красный (первое же утверждение), после появления - зелёный.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SCRIPT="${PSC_SCRIPT:-$ROOT/deploy/rehearsal/check-pseudonymizer-store.sh}"
IMAGE_REPO="cr.yandex/crp47obpdt7rmbio2e8h/bai-pseudonymizer"
IMAGE_DIGEST="sha256:39a91ecf90767d2c59ab14078e684f543e8d1265eefdd9f825e0827ebac9fee3"
IMAGE="${PSC_TEST_IMAGE:-$IMAGE_REPO@$IMAGE_DIGEST}"
STAGE_LABEL="${PSC_TEST_LABEL:-bai.stage=8u}"
CHECK_LABEL="com.labops.rehearsal=pseudonymizer-store-check"
TMP="$(mktemp -d)"
PASS=0
FAIL=0
LIMIT=100
EXIT_USAGE=2
SAMPLE=5
# Вымышленные значения: их не должно быть в выводе скрипта.
SECRET_KEY_SENTINEL="STUBKEY-0123456789-sentinel"
FAKE_NAME="Сидоров"
FAKE_MAIL="ivan.sidorov@example.org"
VOLUMES=()

ok() { PASS=$((PASS + 1)); echo "PASS $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL $1"; }
assert() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

cleanup() {
  local v
  for v in "${VOLUMES[@]:+${VOLUMES[@]}}"; do
    docker volume rm -f "$v" >/dev/null 2>&1 || true
  done
  rm -rf "${TMP:?}"
}
trap cleanup EXIT

# --- 0. Сам скрипт -----------------------------------------------------------------------------
assert "скрипт на месте" "[[ -f '$SCRIPT' ]]"
if [[ ! -f "$SCRIPT" ]]; then
  echo "ИТОГ: PASS=$PASS FAIL=$FAIL"
  exit 1
fi
assert "синтаксис bash" "bash -n '$SCRIPT'"
assert "set -euo pipefail" "grep -q '^set -euo pipefail' '$SCRIPT'"
assert "строки не длиннее $LIMIT" \
  "LC_ALL=C.UTF-8 awk 'length(\$0) > $LIMIT { exit 1 }' '$SCRIPT'"
assert "без сети и только чтение тома репетиции" \
  "grep -q -- '--network none' '$SCRIPT' && grep -q ':ro' '$SCRIPT'"
bash "$SCRIPT" >/dev/null 2>&1 && rc=0 || rc=$?
assert "вызов без аргументов - код $EXIT_USAGE" "[[ $rc -eq $EXIT_USAGE ]]"

# --- 1. Заглушка docker ------------------------------------------------------------------------
BIN="$TMP/bin"
mkdir -p "$BIN"
cat >"$BIN/docker" <<'STUB'
#!/usr/bin/env bash
# Заглушка: пишет вызов в журнал; `run` отдаёт заранее заготовленный вывод контейнера.
printf '%s\n' "$*" >>"$DOCKER_LOG"
case "$1 ${2:-}" in
  "image inspect") [[ -z "${STUB_NO_IMAGE:-}" ]]; exit ;;
  "volume inspect") [[ -z "${STUB_NO_VOLUME:-}" ]]; exit ;;
  "volume create") echo "${@: -1}"; exit 0 ;;
  "volume rm") exit 0 ;;
esac
case "$1" in
  rm) exit 0 ;;
  run)
    cat >/dev/null
    cat "$STUB_STDOUT"
    [[ ! -f "${STUB_STDERR:-}" ]] || cat "$STUB_STDERR" >&2
    exit "${STUB_RC:-0}"
    ;;
esac
exit 0
STUB
chmod +x "$BIN/docker"
export DOCKER_LOG="$TMP/docker.log"

write_proto() { # write_proto <файл> [ключ=значение ...]: протокол с поправками к «здоровому»
  local file="$1" pair key
  shift
  cat >"$file" <<'EOF'
copy=ok
size_bytes=20480
integrity=ok
open=ok
rekey_rc=0
rekey_total=40
rekey_legacy=0
rows=40
threads=6
rows_v3=0
rows_v1=0
sample=5
revealed=5
reveal_failed=0
index_ok=5
EOF
  for pair in "$@"; do
    key="${pair%%=*}"
    sed -i "s/^$key=.*/$pair/" "$file"
  done
}

# run_stub <имя случая> [аргументы скрипта...]: stdout в $TMP/out, код в $RC.
run_stub() {
  local name="$1"
  shift
  : >"$DOCKER_LOG"
  RC=0
  PATH="$BIN:$PATH" STUB_STDOUT="$TMP/$name.proto" \
    bash "$SCRIPT" --image stub-image --volume stub-volume "$@" >"$TMP/out" 2>"$TMP/err" \
    || RC=$?
}
export PSEUDONYMIZER_KEY="$SECRET_KEY_SENTINEL"

write_proto "$TMP/good.proto"
run_stub good --sample "$SAMPLE"
assert "здоровое хранилище: код 0" "[[ $RC -eq 0 ]]"
assert "здоровое: нет fail и warn" "! grep -qE '^(fail|warn)' '$TMP/out'"
assert "здоровое: все пять проверок" "[[ \$(grep -c '^ok' '$TMP/out') -ge 5 ]]"
assert "формат строки: статус, имя, пояснение через табуляцию" \
  "awk -F'\t' 'NF != 3 || \$1 !~ /^(ok|warn|fail)\$/ { exit 1 }' '$TMP/out'"
assert "ключ не в выводе" "! grep -q '$SECRET_KEY_SENTINEL' '$TMP/out' '$TMP/err'"
assert "ключ не в аргументах docker" "! grep -q '$SECRET_KEY_SENTINEL' '$DOCKER_LOG'"
RUN_LINE="$(grep '^run ' "$DOCKER_LOG" || true)"
assert "запуск без сети" "[[ \"\$RUN_LINE\" == *'--network none'* ]]"
assert "том репетиции смонтирован только на чтение" \
  "[[ \"\$RUN_LINE\" == *'-v stub-volume:/src:ro'* ]]"
assert "том репетиции нигде не смонтирован на запись" \
  "[[ \$(grep -o 'stub-volume:[^ ]*' '$DOCKER_LOG' | grep -vc ':ro\$') -eq 0 ]]"
assert "без привилегий и с файловой системой на чтение" \
  "[[ \"\$RUN_LINE\" == *'--cap-drop ALL'* && \"\$RUN_LINE\" == *'--read-only'* ]]"
assert "ключ передан по имени переменной" "[[ \"\$RUN_LINE\" == *'-e PSEUDONYMIZER_KEY '* ]]"
assert "размер выборки дошёл до контейнера" "[[ \"\$RUN_LINE\" == *'CHECK_SAMPLE=$SAMPLE'* ]]"
assert "временный том создан и убран" \
  "grep -q '^volume create' '$DOCKER_LOG' && grep -q '^volume rm' '$DOCKER_LOG'"

write_proto "$TMP/legacy.proto" rekey_legacy=7 rows_v1=7
run_stub legacy
assert "строки v1: warn, но код 0" "[[ $RC -eq 0 ]] && grep -q '^warn.*rekey --dry-run' '$TMP/out'"
assert "warn называет число строк v1" "grep -q 'схема v1: 7' '$TMP/out'"

write_proto "$TMP/integrity.proto" integrity=bad:2
run_stub integrity
assert "integrity_check не ok: fail и код 1" \
  "[[ $RC -eq 1 ]] && grep -q '^fail.*integrity_check' '$TMP/out'"

write_proto "$TMP/rekey.proto" rekey_rc=1 rekey_total=
run_stub rekey
assert "rekey --dry-run не прошёл: fail и код 1" \
  "[[ $RC -eq 1 ]] && grep -q '^fail.*rekey --dry-run' '$TMP/out'"

write_proto "$TMP/reveal.proto" revealed=3 reveal_failed=2 index_ok=3
run_stub reveal
assert "раскрыто не всё: fail и код 1" \
  "[[ $RC -eq 1 ]] && grep -q '^fail.*раскрытие выборки.*3 из 5' '$TMP/out'"

write_proto "$TMP/empty.proto" rows=0 sample=0 revealed=0 index_ok=0 rekey_total=0
run_stub empty
assert "пустая таблица: warn, код 0" \
  "[[ $RC -eq 0 ]] && grep -q '^warn.*раскрытие выборки.*пуста' '$TMP/out'"

printf 'copy=ERR:DatabaseError\n' >"$TMP/copyfail.proto"
run_stub copyfail
assert "копия не снялась: fail и код 1" \
  "[[ $RC -eq 1 ]] && grep -q '^fail.*копия-в-копии' '$TMP/out'"
assert "при сбое копии остальные проверки не идут" "[[ \$(wc -l <'$TMP/out') -eq 1 ]]"

write_proto "$TMP/openfail.proto" open=ERR:ConfigError
run_stub openfail
assert "хранилище не открылось: fail и код 1" \
  "[[ $RC -eq 1 ]] && grep -q '^fail.*самопроверка открытия.*ConfigError' '$TMP/out'"

: >"$TMP/dead.proto"
printf 'Traceback ... %s ...\n' "$SECRET_KEY_SENTINEL" >"$TMP/dead.err"
RC=0
: >"$DOCKER_LOG"
PATH="$BIN:$PATH" STUB_STDOUT="$TMP/dead.proto" STUB_STDERR="$TMP/dead.err" STUB_RC=125 \
  bash "$SCRIPT" --image stub-image --volume stub-volume >"$TMP/out" 2>"$TMP/err" || RC=$?
assert "контейнер упал: fail и код 1" "[[ $RC -eq 1 ]] && grep -q '^fail' '$TMP/out'"
assert "хвост stderr не раскрывает ключ" "! grep -q '$SECRET_KEY_SENTINEL' '$TMP/out' '$TMP/err'"

RC=0
: >"$DOCKER_LOG"
env -u PSEUDONYMIZER_KEY PATH="$BIN:$PATH" STUB_STDOUT="$TMP/good.proto" \
  bash "$SCRIPT" --image stub-image --volume stub-volume >"$TMP/out" 2>"$TMP/err" || RC=$?
assert "нет ключа: fail и код 1" \
  "[[ $RC -eq 1 ]] && grep -q '^fail.*предусловия.*PSEUDONYMIZER_KEY' '$TMP/out'"
assert "нет ключа: контейнер не запускался" "! grep -q '^run ' '$DOCKER_LOG'"

printf 'PSEUDONYMIZER_KEY=%s\nPSEUDONYMIZER_KEY_SCHEME=v3\n' "$SECRET_KEY_SENTINEL" \
  >"$TMP/rehearsal.env"
RC=0
: >"$DOCKER_LOG"
env -u PSEUDONYMIZER_KEY PATH="$BIN:$PATH" STUB_STDOUT="$TMP/good.proto" \
  bash "$SCRIPT" --image stub-image --volume stub-volume --env-file "$TMP/rehearsal.env" \
  >"$TMP/out" 2>"$TMP/err" || RC=$?
assert "ключ из --env-file: код 0" "[[ $RC -eq 0 ]]"
assert "схема ключей из --env-file дошла до контейнера" \
  "grep '^run ' '$DOCKER_LOG' | grep -q 'PSEUDONYMIZER_KEY_SCHEME=v3'"
assert "ключ из --env-file не в выводе и не в аргументах" \
  "! grep -q '$SECRET_KEY_SENTINEL' '$TMP/out' '$TMP/err' '$DOCKER_LOG'"

: >"$TMP/checks.tsv"
run_stub legacy --checks-file "$TMP/checks.tsv"
assert "checks.tsv: имя, статус, пояснение" \
  "awk -F'\t' 'NF != 3 || \$2 !~ /^(ok|warn|fail)\$/ { exit 1 } END { exit NR < 5 }' \
   '$TMP/checks.tsv'"

RC=0
: >"$DOCKER_LOG"
STUB_NO_VOLUME=1 PATH="$BIN:$PATH" STUB_STDOUT="$TMP/good.proto" \
  bash "$SCRIPT" --image stub-image --volume stub-volume >"$TMP/out" 2>"$TMP/err" || RC=$?
assert "нет тома копии: fail и код 1" "[[ $RC -eq 1 ]] && grep -q '^fail.*нет тома' '$TMP/out'"
assert "нет тома: контейнер не запускался" "! grep -q '^run ' '$DOCKER_LOG'"

# --- 2. Настоящий образ 1.1.2 и вымышленное хранилище ------------------------------------------
if ! command -v docker >/dev/null 2>&1 || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "SKIP: нужен docker и образ $IMAGE (PSC_TEST_IMAGE); часть 2 пропущена"
  echo "ИТОГ: PASS=$PASS FAIL=$FAIL"
  [[ $FAIL -eq 0 ]]
  exit
fi

REAL_KEY="$(python3 -I -c 'import base64, hashlib; print(base64.urlsafe_b64encode(
  hashlib.sha256(b"synthetic-check-test-key").digest()).decode())')"
OTHER_KEY="$(python3 -I -c 'import base64, hashlib; print(base64.urlsafe_b64encode(
  hashlib.sha256(b"another-synthetic-key").digest()).decode())')"
SRC_VOL="psc-test-src-$$"
EMPTY_VOL="psc-test-empty-$$"
BROKEN_VOL="psc-test-broken-$$"
VOLUMES=("$SRC_VOL" "$EMPTY_VOL" "$BROKEN_VOL")
for v in "${VOLUMES[@]}"; do
  docker volume create --label "$STAGE_LABEL" "$v" >/dev/null
done

# Хранилище из строк схем v2 и v1 (v1 - как в базе до перешифрования), через код образа.
make_store() { # make_store <том> <режим: full|empty|broken>
  docker run --rm -i --network none --label "$STAGE_LABEL" --entrypoint python \
    -e PSEUDONYMIZER_KEY="$REAL_KEY" -e MODE="$2" -e PYTHONDONTWRITEBYTECODE=1 \
    -v "$1:/data" "$IMAGE" - <<'PY'
import os
from pathlib import Path

from labops_pii.store import SqliteReplacementStore

path = Path("/data/pseudonymizer.sqlite3")
store = SqliteReplacementStore(path, os.environ["PSEUDONYMIZER_KEY"], key_scheme="v2")
mode = os.environ["MODE"]
if mode != "empty":
    people = [("Сидоров", "ivan.sidorov@example.org"), ("Орлова", "m.orlova@example.org"),
              ("Кузнецов", "a.kuznetsov@example.com"), ("Белова", "t.belova@example.net")]
    for n, (name, mail) in enumerate(people, 1):
        thread = f"check:t{n % 2}"
        store.add(thread, f"[PERSON_{n}]", "PERSON", name.lower(), name)
        store.add(thread, f"[EMAIL_{n}]", "EMAIL", mail, mail)
    # Две строки переводим на схему v1: мастер-ключ напрямую, индекс без метки.
    for n in (1, 2):
        key = people[n - 1][0].lower()
        store._conn.execute(
            "UPDATE replacements SET key_hash=?, key_enc=?, value_enc=? WHERE token=?",
            (store._legacy_hash(key), store._legacy_fernet.encrypt(key.encode()),
             store._legacy_fernet.encrypt(people[n - 1][0].encode()), f"[PERSON_{n}]"),
        )
    store._conn.commit()
store.close()
if mode == "broken":
    data = path.read_bytes()
    path.write_bytes(data[:len(data) // 2] + b"\xff" * 4096 + data[len(data) // 2 + 4096:])
os.chmod(path, 0o600)
PY
}
make_store "$SRC_VOL" full
make_store "$EMPTY_VOL" empty
make_store "$BROKEN_VOL" broken

# volume_digest <том>: хеш файла хранилища и состав каталога (для проверки «том не тронут»).
volume_digest() {
  docker run --rm --network none --label "$STAGE_LABEL" --entrypoint python \
    -v "$1:/data:ro" "$IMAGE" -c '
import hashlib, os
names = sorted(os.listdir("/data"))
digest = hashlib.sha256(open("/data/pseudonymizer.sqlite3", "rb").read()).hexdigest()
print(digest, names)'
}
BEFORE="$(volume_digest "$SRC_VOL")"

real_run() { # real_run <том> <ключ> [аргументы...]: stdout в $TMP/real.out, код в $RC
  local vol="$1" key="$2"
  shift 2
  RC=0
  PSEUDONYMIZER_KEY="$key" PSEUDO_CHECK_LABEL="$STAGE_LABEL" \
    bash "$SCRIPT" --image "$IMAGE" --volume "$vol" "$@" >"$TMP/real.out" 2>"$TMP/real.err" \
    || RC=$?
}

real_run "$SRC_VOL" "$REAL_KEY" --sample "$SAMPLE"
assert "реальный образ: код 0 (есть warn про v1)" "[[ $RC -eq 0 ]]"
assert "реальный образ: копия-в-копии ok" "grep -q '^ok.*копия-в-копии.*строк 8' '$TMP/real.out'"
assert "реальный образ: integrity_check ok" "grep -q '^ok.*integrity_check' '$TMP/real.out'"
assert "реальный образ: самопроверка открытия ok" \
  "grep -q '^ok.*самопроверка открытия' '$TMP/real.out'"
assert "реальный образ: rekey --dry-run видит 2 строки v1" \
  "grep -q '^warn.*rekey --dry-run.*всего строк 8, схема v1: 2' '$TMP/real.out'"
assert "реальный образ: раскрыто $SAMPLE из $SAMPLE" \
  "grep -q '^ok.*раскрытие выборки.*раскрыто $SAMPLE из $SAMPLE' '$TMP/real.out'"
assert "в выводе нет значений и ключа" \
  "! grep -q -e '$FAKE_NAME' -e '$FAKE_MAIL' -e 'Орлова' -e '$REAL_KEY' \
   '$TMP/real.out' '$TMP/real.err'"
assert "том репетиции не тронут (хеш и состав каталога)" \
  "[[ \"\$(volume_digest '$SRC_VOL')\" == \"\$BEFORE\" ]]"

real_run "$SRC_VOL" "$OTHER_KEY" --sample "$SAMPLE"
assert "неверный ключ: fail и код 1" \
  "[[ $RC -eq 1 ]] && grep -q '^fail.*rekey --dry-run' '$TMP/real.out'"
assert "неверный ключ не в выводе" "! grep -q '$OTHER_KEY' '$TMP/real.out' '$TMP/real.err'"
assert "том не тронут и после неверного ключа" \
  "[[ \"\$(volume_digest '$SRC_VOL')\" == \"\$BEFORE\" ]]"

real_run "$BROKEN_VOL" "$REAL_KEY"
assert "повреждённый файл: fail и код 1" "[[ $RC -eq 1 ]] && grep -q '^fail' '$TMP/real.out'"

real_run "$EMPTY_VOL" "$REAL_KEY"
assert "пустая таблица: код 0 и warn" \
  "[[ $RC -eq 0 ]] && grep -q '^warn.*раскрытие выборки.*пуста' '$TMP/real.out'"

LEFT_VOLUMES="$(docker volume ls -q --filter "label=$CHECK_LABEL")"
LEFT_CONTAINERS="$(docker ps -aq --filter "label=$CHECK_LABEL")"
assert "временные тома убраны" "[[ -z \"\$LEFT_VOLUMES\" ]]"
assert "контейнеры убраны" "[[ -z \"\$LEFT_CONTAINERS\" ]]"

echo "ИТОГ: PASS=$PASS FAIL=$FAIL"
[[ $FAIL -eq 0 ]]
