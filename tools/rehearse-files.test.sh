#!/usr/bin/env bash
# Тест deploy/rehearsal/rehearse-files.sh на настоящем Docker (локальный образ bun без сети):
#   * пути каталогов боя берутся из `*_HOST_DIR` боевого .env, умолчания - как в compose v2;
#   * копия разыменовывает симлинки (правила доступа боя - ссылка на файл вне каталога);
#   * КРАСНЫЙ случай отказа G6: файлы копии принадлежат root с режимом 600 (запуск от root) -
#     процесс контейнера под не-root их не читает;
#   * ЗЕЛЁНЫЙ случай: после reh_own_for_image файлы принадлежат uid:gid процесса образа, режим
#     640, процесс их читает, посторонний uid - нет, уборка работает без root.
# Нет docker или базового образа - тест пропускается с кодом 0 (в CI его нет).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
LIB="$ROOT/deploy/rehearsal/rehearse-files.sh"
BASE_IMAGE="${REH_TEST_BASE_IMAGE:-oven/bun:1.3.14-slim}"
TEST_IMAGE="bai-rehearse-test-nonroot:7f3"
STRANGER_UID=12345
TMP="$(mktemp -d)"
PASS=0
FAIL=0

ok() { PASS=$((PASS + 1)); echo "PASS $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL $1"; }
assert() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

# Каталоги root-владельца (если что-то создал контейнер) убирает контейнер, а не хост.
cleanup() {
  docker run --rm --user 0:0 -v "$TMP:/t" --entrypoint rm "$TEST_IMAGE" -rf /t/work 2>/dev/null \
    || true
  rm -rf "${TMP:?}"
  docker rmi "$TEST_IMAGE" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if ! command -v docker >/dev/null 2>&1 || ! docker image inspect "$BASE_IMAGE" >/dev/null 2>&1
then
  echo "SKIP: нужен docker и образ $BASE_IMAGE (REH_TEST_BASE_IMAGE)"
  exit 0
fi
# Образ с USER bun: как образ app (процесс не root). Метка этапа для уборки образов.
printf 'FROM %s\nUSER bun\n' "$BASE_IMAGE" \
  | docker build -q --label bai.stage=7f3 -t "$TEST_IMAGE" - >/dev/null 2>&1

# env_value из rehearse.sh (библиотека вызывает его) - упрощённая замена без кавычек.
env_value() { [[ -f "$1" ]] && sed -n "s/^$2=//p" "$1" | tail -1 || true; }
# shellcheck source=../deploy/rehearsal/rehearse-files.sh
source "$LIB"

# --- 1. Пути из боевого .env --------------------------------------------------------------------
W="$TMP/work"
mkdir -p "$W"
cat >"$W/battle.env" <<EOF
ACCESS_POLICY_HOST_DIR=/opt/example/local/access
TEMPLATES_HOST_DIR=relative/templates
EOF
got="$(reh_host_dir "$W/battle.env" ACCESS_POLICY_HOST_DIR /etc/example/access)"
assert "ACCESS_POLICY_HOST_DIR берётся из .env боя" "[[ '$got' == /opt/example/local/access ]]"
got="$(reh_host_dir "$W/battle.env" MAIL_HOST_DIR /etc/example/mail)"
assert "нет переменной - умолчание compose" "[[ '$got' == /etc/example/mail ]]"
got="$(BATTLE_DEPLOY_DIR=/srv/battle/deploy reh_host_dir "$W/battle.env" TEMPLATES_HOST_DIR /x)"
assert "относительный путь отсчитывается от deploy боя" \
  "[[ '$got' == /srv/battle/deploy/relative/templates ]]"

# --- 2. Копия: симлинк разыменован, источник не тронут ------------------------------------------
mkdir -p "$W/src/sub" "$W/outside"
echo '{}' >"$W/outside/real.json"
ln -s ../outside/real.json "$W/src/access-policy.json"
echo 1 >"$W/src/sub/note.txt"
reh_copy_dir "$W/src" "$W/copy"
assert "симлинк правил в копии - обычный файл" \
  "[[ -f '$W/copy/access-policy.json' && ! -L '$W/copy/access-policy.json' ]]"
assert "источник цел: ссылка на месте" "[[ -L '$W/src/access-policy.json' ]]"
assert "вложенные файлы скопированы" "[[ -f '$W/copy/sub/note.txt' ]]"

# --- 3. КРАСНЫЙ: запуск от root оставляет файлы у root с режимом 600 ----------------------------
docker run --rm --user 0:0 -v "$W/copy:/d" --entrypoint sh "$TEST_IMAGE" -c \
  'cd /d && chown 0:0 access-policy.json sub/note.txt && chmod 600 access-policy.json sub/note.txt'
rc=0
reh_readable_by_image "$TEST_IMAGE" "$W/copy:/etc/example/access" -- \
  /etc/example/access/access-policy.json >"$W/red.out" 2>&1 || rc=$?
assert "красный: файл root:600 не читается процессом контейнера (код 1)" "[[ $rc -eq 1 ]]"
assert "красный: сообщение «нет прав»" "grep -q 'нет прав' '$W/red.out'"

# --- 4. ЗЕЛЁНЫЙ: владелец uid:gid процесса образа, режим 640 ------------------------------------
reh_own_for_image "$TEST_IMAGE" "$W/copy"
image_uid="$(reh_image_ids "$TEST_IMAGE" | cut -d' ' -f1)"
assert "uid процесса образа не root (образ с USER)" "[[ '$image_uid' != 0 ]]"
assert "владелец файла - uid процесса образа" \
  "[[ \"\$(stat -c %u '$W/copy/access-policy.json')\" == '$image_uid' ]]"
assert "режим файлов 640" "[[ \"\$(stat -c %a '$W/copy/access-policy.json')\" == 640 ]]"
assert "режим каталогов 755" "[[ \"\$(stat -c %a '$W/copy/sub')\" == 755 ]]"
rc=0
reh_readable_by_image "$TEST_IMAGE" "$W/copy:/etc/example/access" -- \
  @ACCESS_POLICY_FILE /etc/example/access/sub/note.txt >"$W/green.out" 2>&1 || rc=$?
assert "зелёный: файл читается процессом контейнера (код 0)" "[[ $rc -eq 0 ]]"
rc=0
docker run --rm --user "$STRANGER_UID:$STRANGER_UID" -v "$W/copy:/d:ro" --entrypoint sh \
  "$TEST_IMAGE" -c 'cat /d/access-policy.json' >/dev/null 2>&1 || rc=$?
assert "посторонний uid файл не читает (права не шире нужного)" "[[ $rc -ne 0 ]]"
assert "уборка без root: каталог копии удаляется" "rm -rf '$W/copy' && [[ ! -e '$W/copy' ]]"

# --- 5. Скрипт проверки: переменная-путь -------------------------------------------------------
mkdir -p "$W/dir"
rc=0
reh_readable_by_image "$TEST_IMAGE" "$W/dir:/etc/example/access" -- /etc/example/access \
  >"$W/dir.out" 2>&1 || rc=$?
assert "каталог по пути читается" "[[ $rc -eq 0 ]]"
rc=0
docker run --rm --network none -e ACCESS_POLICY_FILE=/etc/example/access \
  -v "$W/dir:/etc/example/access:ro" --entrypoint sh "$TEST_IMAGE" \
  -c "$REH_READ_SCRIPT" sh @ACCESS_POLICY_FILE \
  >"$W/isdir.out" 2>&1 || rc=$?
assert "ACCESS_POLICY_FILE указывает на каталог: отказ «не файл»" \
  "[[ $rc -eq 1 ]] && grep -q 'не файл' '$W/isdir.out'"
rc=0
docker run --rm --network none -e ACCESS_POLICY_FILE=/etc/example/nope \
  --entrypoint sh "$TEST_IMAGE" -c "$REH_READ_SCRIPT" sh @ACCESS_POLICY_FILE \
  >"$W/nofile.out" 2>&1 || rc=$?
assert "ACCESS_POLICY_FILE: нет файла - отказ с именем переменной" \
  "[[ $rc -eq 1 ]] && grep -q '^ACCESS_POLICY_FILE нет файла' '$W/nofile.out'"

# --- 6. Сам файл -------------------------------------------------------------------------------
assert "bash -n" "bash -n '$LIB'"
assert "строки не длиннее 100" "! awk 'length > 100' '$LIB' | grep -q ."

echo "ИТОГО: PASS=$PASS FAIL=$FAIL"
[[ $FAIL -eq 0 ]]
