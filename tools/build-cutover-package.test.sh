#!/usr/bin/env bash
# Тест tools/build-cutover-package.sh: состав пакета, манифест, запрет секретов, отказы.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/build-cutover-package.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP:?}"' EXIT
PASS=0
FAIL=0
LIMIT=100
FREEZE="5ea7f2d308beb476fb8b6fe05e095587c9ee4f40"

ok() { PASS=$((PASS + 1)); echo "PASS $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL $1"; }
assert() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
commit() { git -C "$REPO" add -A -f && git -C "$REPO" -c user.name=t -c user.email=t@example.test \
  commit -q -m "$1"; }

# Временный git-репозиторий с минимальным составом проекта.
REPO="$TMP/repo"
mkdir -p "$REPO/deploy/cutover" "$REPO/deploy/rehearsal" "$REPO/deploy/platform" \
  "$REPO/db/app/rollback" "$REPO/tools"
echo "services: {}" >"$REPO/deploy/compose.yml"
echo "x" >"$REPO/deploy/platform/compose.base.yml"
echo "SELECT 1;" >"$REPO/db/app/001_x.sql"
echo "SELECT 2;" >"$REPO/db/app/rollback/026_down.sql"
echo "KEY=" >"$REPO/deploy/.env.example"
for f in cutover.sh rollback.sh lib.sh verify-signatures.sh units-old-tree.sh; do
  printf '#!/usr/bin/env bash\necho %s\n' "$f" >"$REPO/deploy/cutover/$f"
done
for f in CHECKLIST.md README.md expected-host-dirs.txt; do
  echo "# $f" >"$REPO/deploy/cutover/$f"
done
echo "app/026_x" >"$REPO/deploy/rehearsal/expected-pending.txt"
echo "# tool" >"$REPO/tools/check_migrations_schema.py"
printf '# Последняя синхронизация\n\n- Коммит старого репозитория: `%s`\n' "$FREEZE" \
  >"$REPO/tools/last-sync.md"
git -C "$REPO" init -q
commit init

echo "BAI_VERSION=1.0.1" >"$TMP/images.lock"
echo "-- schema" >"$TMP/schema.sql"
echo "public-key" >"$TMP/cosign.pub"
run() { BAI_PROJECT_DIR="$REPO" bash "$SCRIPT" --lock "$TMP/images.lock" \
  --schema-expected "$TMP/schema.sql" --cosign-pub "$TMP/cosign.pub" "$@"; }

OUT="$TMP/pkg"
rc=0
run --out "$OUT" >"$TMP/out.log" 2>&1 || rc=$?
assert "сборка проходит" "[[ $rc -eq 0 ]]"
for f in cutover.sh rollback.sh lib.sh verify-signatures.sh units-old-tree.sh CHECKLIST.md \
  README.md expected-host-dirs.txt images.lock cosign.pub schema-expected.sql \
  expected-pending.txt FREEZE_SRC tools/check_migrations_schema.py stack/deploy/compose.yml \
  stack/deploy/platform/compose.base.yml stack/db/app/001_x.sql \
  stack/db/app/rollback/026_down.sql MANIFEST.sha256; do
  assert "в пакете есть $f" "[[ -f '$OUT/$f' ]]"
done
assert "cutover.sh и rollback.sh исполняемые" "[[ -x '$OUT/cutover.sh' && -x '$OUT/rollback.sh' ]]"
assert "FREEZE_SRC из last-sync.md" "[[ \"\$(cat '$OUT/FREEZE_SRC')\" == '$FREEZE' ]]"
assert "копии скриптов нет в stack" "[[ ! -e '$OUT/stack/deploy/cutover' ]]"
assert "манифест сходится" "(cd '$OUT' && sha256sum -c --quiet MANIFEST.sha256)"
assert "в манифесте нет самого манифеста" "! grep -q MANIFEST '$OUT/MANIFEST.sha256'"

# Незакоммиченный файл в пакет не попадает.
echo "secret" >"$REPO/deploy/.env"
OUT2="$TMP/pkg2"
run --out "$OUT2" >/dev/null 2>&1
assert "незакоммиченный .env не попал" "[[ ! -e '$OUT2/stack/deploy/.env' ]]"
rm -f "$REPO/deploy/.env"

# Закоммиченный запрещённый файл - отказ.
echo "SECRET=1" >"$REPO/deploy/secrets.env"
commit bad
rc=0
run --out "$TMP/pkg3" >"$TMP/out3.log" 2>&1 || rc=$?
assert "запрещённый файл в дереве - отказ" "[[ $rc -eq 1 ]]"
assert "в сообщении назван файл" "grep -q 'secrets.env' '$TMP/out3.log'"
git -C "$REPO" rm -q -f deploy/secrets.env
commit rm

# Нет файла отката БД - отказ.
git -C "$REPO" rm -q -f db/app/rollback/026_down.sql
commit no-down
rc=0
run --out "$TMP/pkg4" >"$TMP/out4.log" 2>&1 || rc=$?
assert "нет 026_down.sql - отказ" "[[ $rc -eq 1 ]]"
assert "в сообщении названа причина" "grep -q '026_down' '$TMP/out4.log'"

# Непустой каталог, нет аргументов, нет схемы.
mkdir -p "$TMP/full" && touch "$TMP/full/x"
rc=0
run --out "$TMP/full" >/dev/null 2>&1 || rc=$?
assert "непустой каталог - код 2" "[[ $rc -eq 2 ]]"
rc=0
bash "$SCRIPT" >/dev/null 2>&1 || rc=$?
assert "без аргументов - код 2" "[[ $rc -eq 2 ]]"
rc=0
BAI_PROJECT_DIR="$REPO" bash "$SCRIPT" --out "$TMP/pkg5" --lock "$TMP/images.lock" \
  --schema-expected "$TMP/none.sql" --cosign-pub "$TMP/cosign.pub" >/dev/null 2>&1 || rc=$?
assert "нет файла схемы - код 2" "[[ $rc -eq 2 ]]"

# Стиль.
assert "bash -n" "bash -n '$SCRIPT'"
assert "строки до $LIMIT знаков" "! awk 'length > $LIMIT' '$SCRIPT' '$0' | grep -q ."
assert "set -euo pipefail" "grep -q '^set -euo pipefail' '$SCRIPT'"

echo "проверок: $((PASS + FAIL)), провалено: $FAIL"
[[ "$FAIL" -eq 0 ]]
