#!/usr/bin/env bash
# Тест tools/build-rehearsal-package.sh: состав пакета, манифест, запрет секретов, отказы.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SCRIPT="$HERE/build-rehearsal-package.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP:?}"' EXIT
PASS=0
FAIL=0
LIMIT=100

ok() { PASS=$((PASS + 1)); echo "PASS $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL $1"; }
assert() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

# Временный git-репозиторий с минимальным составом проекта.
REPO="$TMP/repo"
mkdir -p "$REPO/deploy/rehearsal" "$REPO/deploy/platform" "$REPO/db/app" "$REPO/tools"
echo "services: {}" >"$REPO/deploy/compose.yml"
echo "x" >"$REPO/deploy/platform/compose.base.yml"
echo "SELECT 1;" >"$REPO/db/app/001_x.sql"
echo "KEY=" >"$REPO/deploy/.env.example"
printf '#!/usr/bin/env bash\necho rehearse\n' >"$REPO/deploy/rehearsal/rehearse.sh"
echo "# README" >"$REPO/deploy/rehearsal/README.md"
echo "app/026_x" >"$REPO/deploy/rehearsal/expected-pending.txt"
echo "# tool" >"$REPO/tools/check_migrations_schema.py"
git -C "$REPO" init -q
git -C "$REPO" add -A
git -C "$REPO" -c user.name=t -c user.email=t@example.test commit -q -m init

echo "BAI_VERSION=1.0.0" >"$TMP/images.lock"
echo "-- schema" >"$TMP/schema.sql"
echo "public-key" >"$TMP/cosign.pub"
printf 'A_NAME\nB_NAME\n' >"$TMP/names.txt"
run() { BAI_PROJECT_DIR="$REPO" bash "$SCRIPT" --lock "$TMP/images.lock" \
  --schema-expected "$TMP/schema.sql" --cosign-pub "$TMP/cosign.pub" "$@"; }

OUT="$TMP/pkg"
rc=0
run --out "$OUT" --expected-env-names "$TMP/names.txt" >"$TMP/out.log" 2>&1 || rc=$?
assert "сборка проходит" "[[ $rc -eq 0 ]]"
for f in rehearse.sh README.md images.lock cosign.pub schema-expected.sql expected-pending.txt \
  expected-env-names.txt tools/check_migrations_schema.py stack/deploy/compose.yml \
  stack/deploy/platform/compose.base.yml stack/db/app/001_x.sql MANIFEST.sha256; do
  assert "в пакете есть $f" "[[ -f '$OUT/$f' ]]"
done
assert "rehearse.sh исполняемый" "[[ -x '$OUT/rehearse.sh' ]]"
assert "манифест сходится" "(cd '$OUT' && sha256sum -c --quiet MANIFEST.sha256)"
assert "образец .env.example допустим" "[[ -f '$OUT/stack/deploy/.env.example' ]]"
assert "в манифесте нет самого манифеста" "! grep -q MANIFEST '$OUT/MANIFEST.sha256'"

# Незакоммиченный файл в пакет не попадает.
echo "secret" >"$REPO/deploy/.env"
OUT2="$TMP/pkg2"
run --out "$OUT2" >/dev/null 2>&1
assert "незакоммиченный .env не попал" "[[ ! -e '$OUT2/stack/deploy/.env' ]]"

# Закоммиченный запрещённый файл - отказ.
echo "SECRET=1" >"$REPO/deploy/secrets.env"
git -C "$REPO" add -f deploy/secrets.env
git -C "$REPO" -c user.name=t -c user.email=t@example.test commit -q -m bad
rc=0
run --out "$TMP/pkg3" >"$TMP/out3.log" 2>&1 || rc=$?
assert "запрещённый файл в дереве - отказ" "[[ $rc -eq 1 ]]"
assert "в сообщении назван файл" "grep -q 'secrets.env' '$TMP/out3.log'"
git -C "$REPO" rm -q -f deploy/secrets.env
git -C "$REPO" -c user.name=t -c user.email=t@example.test commit -q -m rm

# Закрытый ключ внутри файла - отказ.
printf -- '-----BEGIN PRIVATE KEY-----\nabc\n' >"$REPO/deploy/platform/note.txt"
git -C "$REPO" add deploy/platform/note.txt
git -C "$REPO" -c user.name=t -c user.email=t@example.test commit -q -m key
rc=0
run --out "$TMP/pkg4" >/dev/null 2>&1 || rc=$?
assert "закрытый ключ в содержимом - отказ" "[[ $rc -eq 1 ]]"

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
