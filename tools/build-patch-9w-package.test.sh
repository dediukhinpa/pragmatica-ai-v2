#!/usr/bin/env bash
# Тест tools/build-patch-9w-package.sh: состав пакета G9w (из файлов deploy/ ровно копия
# platform/PLATFORM-VERSION, эталоны compose в reference/deploy/, transfer-images-9w.sh), копии из
# HEAD, манифест, права и архив; проверки lock (версия 1.1.12-pragmatika.1, образы по digest),
# сравнение с lock боя после G9q4 (--prev-lock) и lock выпуска платформы (--platform-lock),
# подтверждение подписей, копия платформы, --runbook и --gateway-package, запрет секретов,
# согласованность списков с patch.sh, и что собранный пакет проходит проверку состава в patch.sh.
# Репозиторий проекта - временный, во временном каталоге теста. Docker не нужен.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SCRIPT="${BUILD9W_SCRIPT:-$HERE/build-patch-9w-package.sh}"
PATCH_SH="$ROOT/deploy/patch-9w/patch.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP:?}"' EXIT
PASS=0
FAIL=0
LIMIT=100
EXIT_FAILED=1
EXIT_USAGE=2
EXIT_REFUSED=3
VER_FROM="1.1.11-pragmatika.1"
VER_TO="1.1.12-pragmatika.1"

ok() { PASS=$((PASS + 1)); echo "PASS $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL $1"; }
assert() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
hex() { printf "%064d" 0 | tr 0 "$1"; }
git_t() { git -C "$REPO" -c user.name=t -c user.email=t@example.test "$@"; }
commit() { git_t add -A -f && git_t commit -q -m "$1"; }
fix_sum() { # fix_sum [версия]
  printf 'PLATFORM_PACKAGES_VERSION=%s\nsha256 %s  compose.base.yml\n' "${1:-1.1.12}" \
    "$(sha256sum <"$REPO/deploy/platform/compose.base.yml" | cut -d' ' -f1)" \
    >"$REPO/deploy/platform/PLATFORM-VERSION"
}
list_of() { sed -n "s/^$1=(\(.*\))\$/\1/p" "$2"; }

REPO="$TMP/repo"
mkdir -p "$REPO/deploy/cutover" "$REPO/deploy/patch-9w" "$REPO/deploy/platform" "$REPO/tools"
for f in compose.yml compat.env compose.project.yml platform/compose.base.yml; do
  echo "# $f" >"$REPO/deploy/$f"
done
fix_sum
cp "$PATCH_SH" "$REPO/deploy/patch-9w/patch.sh"
for f in lib.sh verify-signatures.sh; do
  cp "$ROOT/deploy/cutover/$f" "$REPO/deploy/cutover/$f"
done
cp "$HERE/transfer-images-9w.sh" "$HERE/check-routes.sh" "$HERE/route-flags.tsv" "$REPO/tools/"
printf 'documents\tPOST\t/parse\troute\ndocuments\tPOST\t/docx/pages\troute\n' \
  >"$REPO/deploy/cutover/routes.tsv"
git -C "$REPO" init -q
commit init

FROM_APP="$(sed -n 's/^FROM_APP_DIGEST="\(.*\)"$/\1/p' "$PATCH_SH")"
FROM_DOCS="$(sed -n 's/^FROM_DOCS_DIGEST="\(.*\)"$/\1/p' "$PATCH_SH")"
assert "в patch.sh закреплены digest G9q4" \
  "[[ '$FROM_APP' == sha256:* && '$FROM_DOCS' == sha256:* ]]"
# Lock выпуска платформы, lock боя после G9q4 и новый lock.
{
  echo "BAI_VERSION=1.1.12"
  echo "BAI_IMAGE_APP_BASE=r/app-base@sha256:$(hex 8)"
  echo "BAI_IMAGE_DOCUMENTS=r/bai-documents@sha256:$(hex 9)"
  echo "BAI_IMAGE_PSEUDONYMIZER=r/pseudo@sha256:$(hex 4)"
  echo "BAI_IMAGE_MASK=r/mask@sha256:$(hex 6)"
  echo "BAI_IMAGE_EMBEDDINGS=r/emb@sha256:$(hex e)"
} >"$TMP/platform.lock"
{
  echo "BAI_VERSION=$VER_FROM"
  echo "BAI_IMAGE_APP=r/pragmatika-app@$FROM_APP"
  echo "BAI_IMAGE_APP_BASE=r/app-base@sha256:$(hex 7)"
  echo "BAI_IMAGE_DOCUMENTS=r/pragmatika-documents@$FROM_DOCS"
  echo "BAI_IMAGE_DOCUMENTS_BASE=r/bai-documents@sha256:$(hex b)"
  echo "BAI_IMAGE_PSEUDONYMIZER=r/pseudo@sha256:$(hex 3)"
  echo "BAI_IMAGE_MASK=r/mask@sha256:$(hex 5)"
  echo "BAI_IMAGE_EMBEDDINGS=r/emb@sha256:$(hex e)"
} >"$TMP/prev.lock"
{
  echo "BAI_VERSION=$VER_TO"
  echo "BAI_IMAGE_APP=r/pragmatika-app@sha256:$(hex 2)"
  echo "BAI_IMAGE_APP_BASE=r/app-base@sha256:$(hex 8)"
  echo "BAI_IMAGE_DOCUMENTS=r/pragmatika-documents@sha256:$(hex a)"
  echo "BAI_IMAGE_DOCUMENTS_BASE=r/bai-documents@sha256:$(hex 9)"
  echo "BAI_IMAGE_PSEUDONYMIZER=r/pseudo@sha256:$(hex 4)"
  echo "BAI_IMAGE_MASK=r/mask@sha256:$(hex 6)"
  echo "BAI_IMAGE_EMBEDDINGS=r/emb@sha256:$(hex e)"
} >"$TMP/images.lock"
cp "$TMP/images.lock" "$TMP/images.good"
cp "$TMP/prev.lock" "$TMP/prev.good"
cp "$TMP/platform.lock" "$TMP/platform.good"
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
mkdir -p "$TMP/gw/gateway-9w"
echo "#!/usr/bin/env bash" >"$TMP/gw/gateway-9w/step.sh"
tar -C "$TMP/gw" -czf "$TMP/gateway.tgz" gateway-9w

run() { BAI_PROJECT_DIR="$REPO" bash "$SCRIPT" --lock "$TMP/images.lock" \
  --signatures "$TMP/signatures.txt" --cosign-pub "$TMP/cosign.pub" \
  --prev-lock "$TMP/prev.lock" --platform-lock "$TMP/platform.lock" "$@"; }

assert "bash -n" "bash -n '$SCRIPT'"
assert "строки не длиннее $LIMIT" \
  "LC_ALL=C.UTF-8 awk -v n=$LIMIT 'length(\$0) > n { bad = 1 } END { exit bad }' '$SCRIPT'"
for var in PATCH_FILE_ALLOW:DEPLOY_FILES REFERENCE_FILES:REFERENCE_FILES; do
  assert "список ${var%%:*} patch.sh равен ${var#*:} сборщика" \
    "[[ -n \"\$(list_of ${var%%:*} '$PATCH_SH')\" \
     && \"\$(list_of ${var%%:*} '$PATCH_SH')\" == \"\$(list_of ${var#*:} '$SCRIPT')\" ]]"
done
assert "ключи lock патча равны разрешённым в сборщике" \
  "[[ \"\$(sed -n 's/^PATCH_LOCK_KEYS+\\?=\"\(.*\)\"\$/\1/p' '$PATCH_SH' | tr -d '\n')\" == \
   \"\$(sed -n 's/^ALLOWED_LOCK_DIFF+\\?=\"\(.*\)\"\$/\1/p' '$SCRIPT' | tr -d '\n' \
   | sed 's/\\\$PATCH_LOCK_KEYS//')\" ]]"

OUT="$TMP/pkg"
rc=0
run --out "$OUT" --runbook "$TMP/RUNBOOK.md" --gateway-package "$TMP/gateway.tgz" \
  --tgz "$TMP/p.tgz" >"$TMP/out.log" 2>&1 || rc=$?
assert "сборка проходит" "[[ $rc -eq 0 ]]"
PKG_LIST="$(cd "$OUT" && find . -type f | sed 's|^\./||' | LC_ALL=C sort | tr '\n' ' ')"
PKG_WANT="MANIFEST.sha256 OWNER-RUNBOOK.md cosign.pub deploy/platform/PLATFORM-VERSION "
PKG_WANT+="gateway/gateway-9w.tgz images.lock lib.sh patch.sh reference/deploy/compat.env "
PKG_WANT+="reference/deploy/compose.project.yml reference/deploy/compose.yml "
PKG_WANT+="reference/deploy/platform/compose.base.yml routes.tsv signatures.txt "
PKG_WANT+="tools/check-routes.sh tools/route-flags.tsv transfer-images-9w.sh verify-signatures.sh "
assert "состав пакета - ровно ожидаемые файлы" "[[ '$PKG_LIST' == '$PKG_WANT' ]]"
for pair in "patch.sh|deploy/patch-9w/patch.sh" "lib.sh|deploy/cutover/lib.sh" \
  "transfer-images-9w.sh|tools/transfer-images-9w.sh" "routes.tsv|deploy/cutover/routes.tsv" \
  "deploy/platform/PLATFORM-VERSION|deploy/platform/PLATFORM-VERSION" \
  "reference/deploy/compose.project.yml|deploy/compose.project.yml" \
  "reference/deploy/compose.yml|deploy/compose.yml"; do
  assert "${pair%%|*} - копия из HEAD" \
    "git -C '$REPO' show HEAD:${pair#*|} | cmp -s - '$OUT/${pair%%|*}'"
done
assert "runbook, архив шлюза, lock и подписи - как переданы" \
  "cmp -s '$TMP/RUNBOOK.md' '$OUT/OWNER-RUNBOOK.md' \
   && cmp -s '$TMP/gateway.tgz' '$OUT/gateway/gateway-9w.tgz' \
   && cmp -s '$TMP/images.lock' '$OUT/images.lock' \
   && cmp -s '$TMP/signatures.txt' '$OUT/signatures.txt'"
assert "манифест сходится и покрывает все файлы" \
  "(cd '$OUT' && sha256sum -c --quiet MANIFEST.sha256) \
   && [[ \$(wc -l <'$OUT/MANIFEST.sha256') -eq \$((\$(find '$OUT' -type f | wc -l) - 1)) ]]"
assert "скрипты 755, прочие файлы 644, каталоги 755" \
  "[[ \$(stat -c %a '$OUT/patch.sh') == 755 && \$(stat -c %a '$OUT/transfer-images-9w.sh') == 755 \
   && \$(stat -c %a '$OUT/tools/check-routes.sh') == 755 \
   && \$(stat -c %a '$OUT/verify-signatures.sh') == 755 \
   && \$(stat -c %a '$OUT/images.lock') == 644 && \$(stat -c %a '$OUT/MANIFEST.sha256') == 644 \
   && \$(stat -c %a '$OUT/reference/deploy') == 755 ]]"
assert "архив: режим 600, корень patch-package/" \
  "[[ \$(stat -c %a '$TMP/p.tgz') == 600 ]] \
   && ! tar -tzf '$TMP/p.tgz' | grep -qv '^patch-package/'"
mkdir -p "$TMP/unpack"
tar -C "$TMP/unpack" -xzf "$TMP/p.tgz"
assert "распакованный архив проходит манифест" \
  "(cd '$TMP/unpack/patch-package' && sha256sum -c --quiet MANIFEST.sha256)"
# Собранный пакет проходит проверку состава в самом patch.sh: отказ только дальше (нет боя).
mkdir -p "$TMP/home" "$TMP/bin"
printf '#!/usr/bin/env bash\nexit 0\n' >"$TMP/bin/docker"
chmod +x "$TMP/bin/docker"
rc=0
env HOME="$TMP/home" PATH="$TMP/bin:$PATH" CUTOVER_NEW_DIR="$TMP/nolive" \
  CUTOVER_COSIGN=/nonexistent bash "$TMP/unpack/patch-package/patch.sh" --preflight-only \
  >"$TMP/patch.log" 2>&1 || rc=$?
assert "patch.sh принимает состав и подписи пакета, отказ только на боевом дереве" \
  "[[ $rc -eq $EXIT_REFUSED ]] && grep -q 'проверка состав пакета: ok' '$TMP/patch.log' \
   && grep -q 'проверка подписи образов: ok' '$TMP/patch.log' \
   && grep -q 'это не дерево v2' '$TMP/patch.log'"
rc=0
env PATH="$TMP/bin:$PATH" bash "$TMP/unpack/patch-package/transfer-images-9w.sh" \
  --host root@h --dry-run >"$TMP/transfer.log" 2>&1 || rc=$?
assert "перенос образов из пакета берёт lock пакета" \
  "grep -q 'в .*images.lock нет ключа' '$TMP/transfer.log' || [[ $rc -eq 0 ]]"

# Без необязательных файлов.
rc=0
BAI_PROJECT_DIR="$REPO" bash "$SCRIPT" --lock "$TMP/images.lock" --cosign-pub "$TMP/cosign.pub" \
  --out "$TMP/pkg-min" >"$TMP/out-min.log" 2>&1 || rc=$?
assert "минимальная сборка: код 0, нет подписей, runbook, шлюза; предупреждение" \
  "[[ $rc -eq 0 && ! -e '$TMP/pkg-min/signatures.txt' && ! -e '$TMP/pkg-min/gateway' \
   && ! -e '$TMP/pkg-min/OWNER-RUNBOOK.md' ]] && grep -q 'нужен cosign' '$TMP/out-min.log'"
echo "# правка без коммита" >>"$REPO/deploy/compose.project.yml"
rc=0
run --out "$TMP/pkg-dirty" >"$TMP/out-dirty.log" 2>&1 || rc=$?
assert "незакоммиченная правка не попадает в пакет, есть предупреждение" \
  "[[ $rc -eq 0 ]] && ! grep -q 'без коммита' \
   '$TMP/pkg-dirty/reference/deploy/compose.project.yml' \
   && grep -q 'незакоммиченные' '$TMP/out-dirty.log'"
git_t checkout -q -- deploy/compose.project.yml

# Вызов.
rc=0
bash "$SCRIPT" --help >"$TMP/help.log" 2>&1 || rc=$?
assert "--help: код 0, ключи шлюза и runbook" \
  "[[ $rc -eq 0 ]] && grep -q -- '--gateway-package' '$TMP/help.log' \
   && grep -q -- '--runbook' '$TMP/help.log'"
for args in "--bogus" "--out $TMP/x --runbook $TMP/none" \
  "--out $TMP/x --gateway-package $TMP/none" "--out $OUT"; do
  rc=0
  # shellcheck disable=SC2086
  run $args >"$TMP/usage.log" 2>&1 || rc=$?
  assert "вызов '${args//$TMP/}': код 2" "[[ $rc -eq $EXIT_USAGE ]]"
done

# fail_build <описание> <фрагмент сообщения>: сборка с текущими файлами падает с кодом 1.
CASE=0
fail_build() {
  local rc=0
  CASE=$((CASE + 1))
  run --out "$TMP/f$CASE" ${EXTRA[@]+"${EXTRA[@]}"} >"$TMP/fail.log" 2>&1 || rc=$?
  assert "$1: код 1" "[[ $rc -eq $EXIT_FAILED ]]"
  assert "$1: причина названа" "grep -qF -- '$2' '$TMP/fail.log'"
  assert "$1: манифеста нет" "[[ ! -e '$TMP/f$CASE/MANIFEST.sha256' ]]"
}
restore_locks() {
  cp "$TMP/images.good" "$TMP/images.lock"
  cp "$TMP/prev.good" "$TMP/prev.lock"
  cp "$TMP/platform.good" "$TMP/platform.lock"
  make_sigs "$TMP/signatures.txt" OK
}
# lock_case <файл> <sed> <описание> <фрагмент>
lock_case() {
  restore_locks
  sed -i "$2" "$TMP/$1"
  make_sigs "$TMP/signatures.txt" OK
  fail_build "$3" "$4"
}
for key in BAI_IMAGE_APP BAI_IMAGE_APP_BASE BAI_IMAGE_DOCUMENTS BAI_IMAGE_PSEUDONYMIZER \
  BAI_IMAGE_MASK; do
  lock_case images.lock "/^$key=/d" "в lock нет $key" "нет $key"
  lock_case images.lock "s|^$key=.*|$key=r/x:latest|" "$key по тегу" "нет $key"
done
lock_case images.lock "s|^BAI_VERSION=.*|BAI_VERSION=$VER_FROM|" "версия lock прежняя" \
  "BAI_VERSION=$VER_TO"
lock_case prev.lock "s|^BAI_VERSION=.*|BAI_VERSION=1.1.10-pragmatika.2|" "prev не G9q4" \
  "после патча G9q4"
lock_case prev.lock "s|^BAI_IMAGE_APP=.*|BAI_IMAGE_APP=r/a@sha256:$(hex c)|" \
  "app в prev не на digest G9q4" "FROM_APP_DIGEST"
lock_case prev.lock "s|^BAI_IMAGE_DOCUMENTS=.*|BAI_IMAGE_DOCUMENTS=r/d@sha256:$(hex c)|" \
  "documents в prev не на digest G9q4" "FROM_DOCS_DIGEST"
lock_case images.lock "s|^BAI_IMAGE_EMBEDDINGS=.*|BAI_IMAGE_EMBEDDINGS=r/emb@sha256:$(hex c)|" \
  "lock меняет embeddings" "по BAI_IMAGE_EMBEDDINGS"
for key in BAI_IMAGE_PSEUDONYMIZER BAI_IMAGE_MASK; do
  restore_locks
  old="$(grep "^$key=" "$TMP/prev.lock")"
  sed -i "s|^$key=.*|$old|" "$TMP/images.lock"
  make_sigs "$TMP/signatures.txt" OK
  fail_build "lock не меняет $key" "не меняет $key"
done
lock_case platform.lock "s|^BAI_VERSION=.*|BAI_VERSION=1.1.11|" "lock платформы не 1.1.12" \
  "не lock выпуска платформы 1.1.12"
for pair in BAI_IMAGE_APP_BASE:BAI_IMAGE_APP_BASE BAI_IMAGE_DOCUMENTS:BAI_IMAGE_DOCUMENTS_BASE \
  BAI_IMAGE_PSEUDONYMIZER:BAI_IMAGE_PSEUDONYMIZER BAI_IMAGE_MASK:BAI_IMAGE_MASK; do
  lock_case platform.lock "s|^${pair%%:*}=.*|${pair%%:*}=r/p@sha256:$(hex d)|" \
    "расхождение с платформой: ${pair#*:}" "по: ${pair#*:}"
done
restore_locks
make_sigs "$TMP/signatures.txt" FAIL
fail_build "подписи result=FAIL" "подтверждение подписей"
restore_locks
sed -i '/BAI_IMAGE_MASK/d' "$TMP/signatures.txt"
fail_build "подписи без mask" "подтверждение подписей"
restore_locks
echo "# другой" >>"$TMP/images.lock"
fail_build "подписи от другого lock" "подтверждение подписей"
restore_locks

# Дефекты HEAD.
head_case() { # head_case <описание> <фрагмент> <команда правки в $REPO>
  eval "$3"
  commit "$1"
  fail_build "$1" "$2"
  git_t reset -q --hard HEAD~1
}
head_case "платформа HEAD 1.1.11" "PLATFORM_PACKAGES_VERSION=1.1.12" 'fix_sum 1.1.11'
head_case "сумма compose.base.yml не сходится" "не сходится" \
  'echo "# x" >>"$REPO/deploy/platform/compose.base.yml"'
head_case "нет compose.project.yml" "нет deploy/compose.project.yml" \
  'rm "$REPO/deploy/compose.project.yml"'
head_case "нет transfer-images" "tools/transfer-images-9w.sh" \
  'rm "$REPO/tools/transfer-images-9w.sh"'
head_case "нет patch.sh" "deploy/patch-9w/patch.sh" 'rm "$REPO/deploy/patch-9w/patch.sh"'
head_case "в routes.tsv нет /docx/pages" "/docx/pages" \
  'sed -i "/docx/d" "$REPO/deploy/cutover/routes.tsv"'
head_case "закрытый ключ в эталоне" "закрытое ключевое" \
  'echo "-----BEGIN PRIVATE KEY-----" >>"$REPO/deploy/compat.env"'

# Архив шлюза.
echo "not a tar" >"$TMP/bad-gw.tgz"
EXTRA=(--gateway-package "$TMP/bad-gw.tgz")
fail_build "архив шлюза не tgz" "не читается"
for name in .env gateway.key secrets.env; do
  mkdir -p "$TMP/gw-$name/g"
  echo x >"$TMP/gw-$name/g/$name"
  tar -C "$TMP/gw-$name" -czf "$TMP/gw-$name.tgz" g
  EXTRA=(--gateway-package "$TMP/gw-$name.tgz")
  fail_build "в архиве шлюза $name" "запрещённые файлы"
done
mkdir -p "$TMP/gw-pem/g"
echo "-----BEGIN RSA PRIVATE KEY-----" >"$TMP/gw-pem/g/notes.txt"
seq 1 20000 >"$TMP/gw-pem/g/zz-tail.txt"
tar -C "$TMP/gw-pem" -czf "$TMP/gw-pem.tgz" g
EXTRA=(--gateway-package "$TMP/gw-pem.tgz")
fail_build "в архиве шлюза закрытый ключ" "закрытое ключевое"
mkdir -p "$TMP/gw-example/g"
echo "KEY=" >"$TMP/gw-example/g/.env.example"
tar -C "$TMP/gw-example" -czf "$TMP/gw-example.tgz" g
rc=0
run --out "$TMP/pkg-example" --gateway-package "$TMP/gw-example.tgz" >"$TMP/ex.log" 2>&1 || rc=$?
assert ".env.example в архиве шлюза допустим" "[[ $rc -eq 0 ]]"

echo "----"
echo "PASS=$PASS FAIL=$FAIL"
((FAIL == 0))
