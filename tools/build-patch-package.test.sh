#!/usr/bin/env bash
# Тест tools/build-patch-package.sh: состав пакета, манифест, запрет секретов и db, проверка
# подтверждения подписей, архив.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/build-patch-package.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP:?}"' EXIT
PASS=0
FAIL=0
LIMIT=100
DIGEST_A="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
DIGEST_M="eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"

ok() { PASS=$((PASS + 1)); echo "PASS $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL $1"; }
assert() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
commit() { git -C "$REPO" add -A -f && git -C "$REPO" -c user.name=t -c user.email=t@example.test \
  commit -q -m "$1"; }

# Временный git-репозиторий с минимальным составом проекта.
REPO="$TMP/repo"
mkdir -p "$REPO/deploy/cutover" "$REPO/deploy/patch" "$REPO/deploy/platform" "$REPO/tools"
for f in compose.yml compose.project.yml compat.env platform/compose.base.yml \
  platform/PLATFORM-VERSION; do
  echo "# $f" >"$REPO/deploy/$f"
done
for f in patch.sh smoke_contract.py; do
  printf '#!/usr/bin/env bash\n' >"$REPO/deploy/patch/$f"
done
for f in lib.sh verify-signatures.sh; do
  printf '#!/usr/bin/env bash\n' >"$REPO/deploy/cutover/$f"
done
for f in check-routes.sh check-image-routes.sh route-flags.tsv; do
  echo "# $f" >"$REPO/tools/$f"
done
printf 'documents\tPOST\t/parse\troute\n' >"$REPO/deploy/cutover/routes.tsv"
git -C "$REPO" init -q
commit init

printf 'BAI_VERSION=1.1.3\nBAI_IMAGE_APP=r/app@sha256:%s\nBAI_IMAGE_MASK=r/mask@sha256:%s\n' \
  "$DIGEST_A" "$DIGEST_M" >"$TMP/images.lock"
echo "public-key" >"$TMP/cosign.pub"
make_sigs() { # make_sigs <файл> <result>
  local key ref
  printf '# verify-signatures v1\nlock_sha256=%s\npubkey_sha256=%s\ncosign=v3\n' \
    "$(sha256sum "$TMP/images.lock" | cut -d' ' -f1)" \
    "$(sha256sum "$TMP/cosign.pub" | cut -d' ' -f1)" >"$1"
  while IFS='=' read -r key ref; do
    [[ "$key" == BAI_IMAGE_* ]] && printf 'image\t%s\t%s\tOK\n' "$key" "$ref" >>"$1"
  done <"$TMP/images.lock"
  printf 'result=%s\n' "$2" >>"$1"
}
make_sigs "$TMP/signatures.txt" OK
echo "# инструкция" >"$TMP/RUNBOOK.md"

run() { BAI_PROJECT_DIR="$REPO" bash "$SCRIPT" --lock "$TMP/images.lock" \
  --signatures "$TMP/signatures.txt" --cosign-pub "$TMP/cosign.pub" "$@"; }
OUT="$TMP/pkg"
rc=0
run --out "$OUT" --runbook "$TMP/RUNBOOK.md" --tgz "$TMP/p.tgz" >"$TMP/out.log" 2>&1 || rc=$?
assert "сборка проходит" "[[ $rc -eq 0 ]]"
for f in patch.sh lib.sh verify-signatures.sh smoke_contract.py routes.tsv images.lock \
  signatures.txt cosign.pub RUNBOOK.md MANIFEST.sha256 tools/check-routes.sh \
  tools/check-image-routes.sh tools/route-flags.tsv deploy/compose.yml \
  deploy/compose.project.yml deploy/compat.env deploy/platform/compose.base.yml \
  deploy/platform/PLATFORM-VERSION; do
  assert "в пакете есть $f" "[[ -f '$OUT/$f' ]]"
done
assert "скрипты исполняемые" \
  "[[ -x '$OUT/patch.sh' && -x '$OUT/verify-signatures.sh' && -x '$OUT/tools/check-routes.sh' ]]"
assert "миграций (db) в пакете нет" "[[ ! -e '$OUT/db' && ! -e '$OUT/stack' ]]"
assert "манифест сходится" "(cd '$OUT' && sha256sum -c --quiet MANIFEST.sha256)"
assert "в манифесте нет самого манифеста" "! grep -q MANIFEST '$OUT/MANIFEST.sha256'"
assert "архив создан с режимом 600" "[[ \$(stat -c %a '$TMP/p.tgz') == 600 ]]"
assert "в архиве корень patch-package/" \
  "[[ \$(tar -tzf '$TMP/p.tgz' | grep -vc '^patch-package/') -eq 0 ]]"

# Незакоммиченное в пакет не попадает.
echo "# локальная правка" >>"$REPO/deploy/compose.project.yml"
rm -rf "${TMP:?}/pkg2"
run --out "$TMP/pkg2" >"$TMP/out2.log" 2>&1
assert "незакоммиченная правка не попала в пакет" \
  "! grep -q 'локальная' '$TMP/pkg2/deploy/compose.project.yml'"
git -C "$REPO" checkout -q -- deploy/compose.project.yml

# Отказы: подтверждение подписей не к этому lock, result=FAIL, lock без mask, непустой каталог.
echo "BAI_IMAGE_X=r/x@sha256:$DIGEST_A" >>"$TMP/images.lock"
rc=0
run --out "$TMP/pkg-sigold" >"$TMP/out3.log" 2>&1 || rc=$?
assert "подписи не покрывают lock - отказ" "[[ $rc -eq 1 && ! -e '$TMP/pkg-sigold/patch.sh' ]]"
make_sigs "$TMP/signatures.txt" OK
make_sigs "$TMP/sigs.fail" FAIL
rc=0
BAI_PROJECT_DIR="$REPO" bash "$SCRIPT" --lock "$TMP/images.lock" --signatures "$TMP/sigs.fail" \
  --cosign-pub "$TMP/cosign.pub" --out "$TMP/pkg-fail" >"$TMP/out4.log" 2>&1 || rc=$?
assert "подтверждение result=FAIL - отказ" "[[ $rc -eq 1 ]]"
grep -v '^BAI_IMAGE_MASK=' "$TMP/images.lock" >"$TMP/nomask.lock"
cp "$TMP/images.lock" "$TMP/images.keep"
cp "$TMP/nomask.lock" "$TMP/images.lock"
make_sigs "$TMP/signatures.txt" OK
rc=0
run --out "$TMP/pkg-nomask" >"$TMP/out5.log" 2>&1 || rc=$?
assert "lock без mask - отказ" "[[ $rc -eq 1 ]]"
cp "$TMP/images.keep" "$TMP/images.lock"
make_sigs "$TMP/signatures.txt" OK
rc=0
run --out "$OUT" >"$TMP/out6.log" 2>&1 || rc=$?
assert "непустой каталог - код 2" "[[ $rc -eq 2 ]]"

assert "строки скрипта до $LIMIT знаков" \
  "! LC_ALL=C.UTF-8 awk 'length > $LIMIT' '$SCRIPT' | grep -q ."
assert "строки теста до $LIMIT знаков" \
  "! LC_ALL=C.UTF-8 awk 'length > $LIMIT' '$0' | grep -q ."
assert "set -euo pipefail" "grep -q '^set -euo pipefail' '$SCRIPT'"
assert "список файлов сборщика = PATCH_FILE_ALLOW в patch.sh" \
  "[[ \"\$(sed -n '/^DEPLOY_FILES=(/,/)/p' '$SCRIPT' | tr -d '\\n' | tr -s ' ' \
     | sed 's/.*(\\(.*\\)).*/\\1/')\" == \"\$(sed -n '/^PATCH_FILE_ALLOW=(/,/)/p' \
     '$HERE/../deploy/patch/patch.sh' | tr -d '\\n' | tr -s ' ' | sed 's/.*(\\(.*\\)).*/\\1/')\" ]]"

echo "проверок: $((PASS + FAIL)), провалено: $FAIL"
[[ "$FAIL" -eq 0 ]]
