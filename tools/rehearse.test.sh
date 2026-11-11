#!/usr/bin/env bash
# Тест deploy/rehearsal/rehearse.sh без настоящего Docker: вместо docker - заглушка, пишущая
# журнал вызовов. Проверяются разбор аргументов, отказы по предусловиям (бой не тронут: ни одной
# изменяющей команды docker), успешный проход предусловий и состав архива результатов.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SCRIPT="$ROOT/deploy/rehearsal/rehearse.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP:?}"' EXIT
PASS=0
FAIL=0
LIMIT=100
EXIT_REFUSED=3
EXIT_USAGE=2
# Объём БД боя в заглушке: 1 МиБ.
STUB_DB_BYTES=1048576
# Изменяющие команды docker: ни одна не должна появиться при отказе.
MUTATING_RE='^(run|create|rm|stop|kill|start|restart|load|pull|volume rm|volume create|network|compose)'

ok() { PASS=$((PASS + 1)); echo "PASS $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL $1"; }
assert() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

# --- Заглушка docker ---------------------------------------------------------------------------
BIN="$TMP/bin"
mkdir -p "$BIN"
cat >"$BIN/docker" <<'STUB'
#!/usr/bin/env bash
# Заглушка: пишет вызов в журнал и отвечает на то, что спрашивает предусловие.
printf '%s\n' "$*" >>"$DOCKER_LOG"
case "$1" in
  compose) [[ "${2:-}" == "version" ]] && echo "2.40.3"; exit 0 ;;
  inspect) echo "running"; exit 0 ;;
  exec) echo "$STUB_DB_BYTES"; exit 0 ;;
  info) echo "$STUB_DOCKER_ROOT"; exit 0 ;;
  ps) if [[ "$*" == *pragmatika-rehearsal* && -n "${STUB_PROJECT_EXISTS:-}" ]]; then echo abc; fi
      exit 0 ;;
  *) exit 0 ;;
esac
STUB
chmod +x "$BIN/docker"

printf 'MemTotal: 16000000 kB\nMemAvailable: %s kB\n' 8000000 >"$TMP/meminfo.ok"
printf 'MemTotal: 16000000 kB\nMemAvailable: %s kB\n' 1000000 >"$TMP/meminfo.low"
echo "BAI_VERSION=1.0.1" >"$TMP/images.lock"
echo "BAI_IMAGE_POSTGRES=pg@sha256:aa" >>"$TMP/images.lock"
echo "BAI_IMAGE_PSEUDONYMIZER=ps@sha256:bb" >>"$TMP/images.lock"
echo "BAI_IMAGE_APP=app@sha256:cc" >>"$TMP/images.lock"
echo "POSTGRES_USER=pragmatika" >"$TMP/battle.env"

# run <имя> <meminfo> [аргументы] [ПЕРЕМЕННЫЕ=значение через env]: запуск в изолированном $HOME.
run() {
  local name="$1" meminfo="$2"
  shift 2
  local home="$TMP/home-$name"
  mkdir -p "$home"
  : >"$TMP/docker-$name.log"
  env HOME="$home" PATH="$BIN:$PATH" DOCKER_LOG="$TMP/docker-$name.log" \
    STUB_DB_BYTES="$STUB_DB_BYTES" STUB_DOCKER_ROOT="$TMP" \
    REHEARSAL_MEMINFO_FILE="$meminfo" REHEARSAL_HOME="$home/.reh" \
    BATTLE_ENV_FILE="$TMP/battle.env" BATTLE_PG_CONTAINER=battle-pg \
    BATTLE_PSEUDO_CONTAINER=battle-ps BATTLE_PSEUDO_VOLUME=battle_vol \
    bash "$SCRIPT" --lock "$TMP/images.lock" --out-dir "$home" "$@" \
    >"$TMP/out-$name.log" 2>&1
}

# 1. Справка и неверный аргумент.
rc=0
bash "$SCRIPT" --help >"$TMP/help.log" 2>&1 || rc=$?
assert "справка: код 0" "[[ $rc -eq 0 ]]"
assert "справка: есть описание использования" "grep -q 'Использование' '$TMP/help.log'"
rc=0
bash "$SCRIPT" --nonsense >"$TMP/bad.log" 2>&1 || rc=$?
assert "неизвестный аргумент: код 2" "[[ $rc -eq $EXIT_USAGE ]]"

# 1a. Бэкап боя в S3 - только по явному --backup-sh (7u): умолчание не пишет в сторону боя.
assert "справка: --backup-sh есть, умолчание не пишет в бой" \
  "grep -q -- '--backup-sh' '$TMP/help.log' && grep -q '^USE_BACKUP_SH=0' '$SCRIPT'"
assert "флаг --backup-sh включает бэкап" "grep -q -- '--backup-sh) USE_BACKUP_SH=1' '$SCRIPT'"
assert "старый --no-backup-sh принимается" "grep -q -- '--no-backup-sh) USE_BACKUP_SH=0' '$SCRIPT'"

# 2. Мало памяти: отказ, код 3, сообщение, ни одной изменяющей команды docker.
rc=0
run lowmem "$TMP/meminfo.low" --preflight-only || rc=$?
assert "мало памяти: код 3" "[[ $rc -eq $EXIT_REFUSED ]]"
assert "мало памяти: понятное сообщение" "grep -q 'мало памяти' '$TMP/out-lowmem.log'"
assert "мало памяти: сказано, что бой не тронут" "grep -q 'Бой не тронут' '$TMP/out-lowmem.log'"
assert "мало памяти: нет изменяющих вызовов docker" \
  "! grep -E '$MUTATING_RE' '$TMP/docker-lowmem.log' | grep -vq '^compose version'"
assert "мало памяти: архив результатов создан" "compgen -G '$TMP/home-lowmem/rehearsal-*.tgz'"

# 3. Мало места на диске.
rc=0
REHEARSAL_MIN_DISK_MIB=999999999 run lowdisk "$TMP/meminfo.ok" --preflight-only || rc=$?
assert "мало диска: код 3" "[[ $rc -eq $EXIT_REFUSED ]]"
assert "мало диска: сообщение" "grep -q 'мало места' '$TMP/out-lowdisk.log'"

# 4. Проект репетиции уже существует.
rc=0
STUB_PROJECT_EXISTS=1 run exists "$TMP/meminfo.ok" --preflight-only || rc=$?
assert "остаток прошлой репетиции: код 3" "[[ $rc -eq $EXIT_REFUSED ]]"
assert "остаток прошлой репетиции: сообщение" "grep -q 'уже существует' '$TMP/out-exists.log'"

# 5. Нет images.lock.
rc=0
run nolock "$TMP/meminfo.ok" --lock "$TMP/нет-такого.lock" --preflight-only || rc=$?
assert "нет lock: код 3" "[[ $rc -eq $EXIT_REFUSED ]]"
assert "нет lock: сообщение" "grep -q 'нет images.lock' '$TMP/out-nolock.log'"

# 6. Предусловия проходят: код 0, архив без данных, лимит строк.
rc=0
run pass "$TMP/meminfo.ok" --preflight-only || rc=$?
assert "предусловия пройдены: код 0" "[[ $rc -eq 0 ]]"
assert "предусловия пройдены: нет изменяющих вызовов docker" \
  "! grep -E '$MUTATING_RE' '$TMP/docker-pass.log' | grep -vq '^compose version'"
archive="$(compgen -G "$TMP/home-pass/rehearsal-*.tgz" | head -1)"
assert "архив результатов создан" "[[ -f '$archive' ]]"
mkdir -p "$TMP/unpack"
tar -xzf "$archive" -C "$TMP/unpack"
for f in summary.md checks.tsv preflight.txt versions.txt rehearsal.log; do
  assert "в архиве есть $f" "[[ -f '$TMP/unpack/results/$f' ]]"
done
assert "в архиве есть units-old-tree.tsv (аудит юнитов, 1.0.1)" \
  "[[ -f '$TMP/unpack/results/units-old-tree.tsv' ]]"
assert "архив не содержит дампов и env" \
  "! find '$TMP/unpack' -name '*.dump' -o -name '*.env' -o -name '*.sqlite3' | grep -q ."
assert "рабочий каталог запуска убран" "! compgen -G '$TMP/home-pass/.reh/run-*/work'"

# 6а. Файл --battle-config действует: имя боевого проекта берётся из него, а не по умолчанию.
printf 'BATTLE_PROJECT=pragmatika-cfgtest\n' >"$TMP/battle.cfg"
rc=0
run cfg "$TMP/meminfo.ok" --battle-config "$TMP/battle.cfg" --preflight-only || rc=$?
assert "battle-config: проект боя из файла" "grep -q 'бой pragmatika-cfgtest' '$TMP/out-cfg.log'"

# 7. Сам скрипт: синтаксис и длина строк.
assert "bash -n" "bash -n '$SCRIPT'"
assert "строки rehearse.sh не длиннее $LIMIT" \
  "! awk 'length > $LIMIT' '$SCRIPT' | grep -q ."
assert "set -euo pipefail в начале" "grep -q '^set -euo pipefail' '$SCRIPT'"

echo "ИТОГО: PASS=$PASS FAIL=$FAIL"
[[ $FAIL -eq 0 ]]
