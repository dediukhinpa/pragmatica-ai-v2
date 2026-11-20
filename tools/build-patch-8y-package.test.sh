#!/usr/bin/env bash
# Тест tools/build-patch-8y-package.sh: состав пакета G8y (БЕЗ файлов deploy/), манифест, запрет
# секретов и db, проверка подтверждения подписей (обязательно, если дано; необязательно, если не
# дано), проверка версии lock 1.1.6-pragmatika.2 и образов app и documents по digest, проверка
# (без копирования в пакет) переменных Яндекса и флагов documents в compose и версии платформы
# 1.1.6, архив, права и строгое соответствие списка файлов patch.sh. Docker не нужен.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/build-patch-8y-package.sh"
PATCH_SH="$HERE/../deploy/patch-8y/patch.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP:?}"' EXIT
PASS=0
FAIL=0
LIMIT=100
LOCK_VERSION="1.1.6-pragmatika.2"
DIGEST_A="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
DIGEST_M="eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
DIGEST_D="dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"

ok() { PASS=$((PASS + 1)); echo "PASS $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL $1"; }
assert() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
commit() { git -C "$REPO" add -A -f && git -C "$REPO" -c user.name=t -c user.email=t@example.test \
  commit -q -m "$1"; }

# Временный git-репозиторий с минимальным составом проекта.
REPO="$TMP/repo"
mkdir -p "$REPO/deploy/cutover" "$REPO/deploy/patch-8y" "$REPO/deploy/platform" "$REPO/tools"
for f in compose.project.yml platform/compose.base.yml; do
  printf '# %s\nYANDEX_SEARCH_MAX_CONCURRENCY: 1\n' "$f" >"$REPO/deploy/$f"
  echo 'YANDEX_SEARCH_MIN_INTERVAL_MS: 1200' >>"$REPO/deploy/$f"
  printf 'DOCUMENTS_EDIT_PPTX: true\nDOCUMENTS_EDIT_PDF: true\n' >>"$REPO/deploy/$f"
  printf 'DOCUMENTS_PPT_CONVERT: true\nDOCUMENTS_EDIT_PDF_FALLBACK_FONT: false\n' \
    >>"$REPO/deploy/$f"
done
echo "PLATFORM_PACKAGES_VERSION=1.1.6" >"$REPO/deploy/platform/PLATFORM-VERSION"
# Файлы дерева, которых в пакете G8y быть не должно (G8y заменяет только images.lock).
for f in compose.yml compat.env; do echo "# $f" >"$REPO/deploy/$f"; done
printf '#!/usr/bin/env bash\n' >"$REPO/deploy/patch-8y/patch.sh"
printf '#!/usr/bin/env bash\n' >"$REPO/deploy/patch-8y/smoke_contract.py"
for f in lib.sh verify-signatures.sh; do
  printf '#!/usr/bin/env bash\n' >"$REPO/deploy/cutover/$f"
done
for f in check-routes.sh check-image-routes.sh route-flags.tsv; do
  echo "# $f" >"$REPO/tools/$f"
done
printf 'documents\tPOST\t/parse\troute\n' >"$REPO/deploy/cutover/routes.tsv"
git -C "$REPO" init -q
commit init

printf 'BAI_VERSION=%s\nBAI_IMAGE_APP=r/app@sha256:%s\nBAI_IMAGE_MASK=r/mask@sha256:%s\n' \
  "$LOCK_VERSION" "$DIGEST_A" "$DIGEST_M" >"$TMP/images.lock"
printf 'BAI_IMAGE_DOCUMENTS=r/documents@sha256:%s\n' "$DIGEST_D" >>"$TMP/images.lock"
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
for f in patch.sh lib.sh verify-signatures.sh routes.tsv images.lock signatures.txt cosign.pub \
  OWNER-RUNBOOK.md MANIFEST.sha256 tools/check-routes.sh tools/route-flags.tsv; do
  assert "в пакете есть $f" "[[ -f '$OUT/$f' ]]"
done
assert "в пакете НЕТ каталога deploy/ (G8y заменяет только images.lock)" "[[ ! -e '$OUT/deploy' ]]"
assert "в пакете нет ни одного файла deploy/* (ни compose, ни PLATFORM-VERSION)" \
  "! (cd '$OUT' && find . -type f) | grep -q '^./deploy/'"
for f in smoke_contract.py tools/check-image-routes.sh compose.yml compat.env \
  compose.project.yml platform/PLATFORM-VERSION; do
  assert "в пакете G8y нет $f" "[[ ! -e '$OUT/$f' ]]"
done
PKG_LIST="$(cd "$OUT" && find . -type f | sed 's|^\./||' | LC_ALL=C sort | tr '\n' ' ')"
PKG_WANT="MANIFEST.sha256 OWNER-RUNBOOK.md cosign.pub images.lock lib.sh patch.sh routes.tsv "
PKG_WANT+="signatures.txt tools/check-routes.sh tools/route-flags.tsv verify-signatures.sh "
assert "состав пакета - ровно ожидаемые файлы" "[[ '$PKG_LIST' == '$PKG_WANT' ]]"
assert "скрипты исполняемые" \
  "[[ -x '$OUT/patch.sh' && -x '$OUT/verify-signatures.sh' && -x '$OUT/tools/check-routes.sh' ]]"
assert "обычные файлы 644, каталоги 755" \
  "[[ \$(stat -c %a '$OUT/images.lock') == 644 && \$(stat -c %a '$OUT/tools') == 755 ]]"
assert "миграций (db) в пакете нет" "[[ ! -e '$OUT/db' && ! -e '$OUT/stack' ]]"
assert "манифест сходится" "(cd '$OUT' && sha256sum -c --quiet MANIFEST.sha256)"
assert "в манифесте нет самого манифеста" "! grep -q MANIFEST '$OUT/MANIFEST.sha256'"
assert "архив создан с режимом 600" "[[ \$(stat -c %a '$TMP/p.tgz') == 600 ]]"
assert "в архиве корень patch-package/" \
  "[[ \$(tar -tzf '$TMP/p.tgz' | grep -vc '^patch-package/') -eq 0 ]]"
assert "в архиве нет файлов с чужим владельцем (владелец - собравший)" \
  "[[ \$(tar -tvzf '$TMP/p.tgz' | awk '{print \$2}' | sort -u | wc -l) -eq 1 ]]"
assert "lock попал в пакет без изменений" "cmp -s '$TMP/images.lock' '$OUT/images.lock'"

# Незакоммиченное в пакет не попадает.
echo "# локальная правка" >>"$REPO/deploy/patch-8y/patch.sh"
rm -rf "${TMP:?}/pkg2"
run --out "$TMP/pkg2" >"$TMP/out2.log" 2>&1
assert "незакоммиченная правка не попала в пакет" "! grep -q 'локальная' '$TMP/pkg2/patch.sh'"
assert "незакоммиченная правка: предупреждение в выводе" "grep -q 'незакоммиченные' '$TMP/out2.log'"
git -C "$REPO" checkout -q -- deploy/patch-8y/patch.sh

# Без --signatures: сборка проходит, signatures.txt нет, есть предупреждение.
rc=0
BAI_PROJECT_DIR="$REPO" bash "$SCRIPT" --lock "$TMP/images.lock" --cosign-pub "$TMP/cosign.pub" \
  --out "$TMP/pkg-nosig" >"$TMP/out-nosig.log" 2>&1 || rc=$?
assert "без --signatures сборка проходит" "[[ $rc -eq 0 ]]"
assert "без --signatures: signatures.txt в пакете нет" "[[ ! -e '$TMP/pkg-nosig/signatures.txt' ]]"
assert "без --signatures: предупреждение про cosign" "grep -q 'нужен cosign' '$TMP/out-nosig.log'"
assert "без --signatures: манифест сходится" \
  "(cd '$TMP/pkg-nosig' && sha256sum -c --quiet MANIFEST.sha256)"

# Нужных переменных нет в compose из HEAD - отказ, причина называет переменную (проверяются оба
# файла: compose.project.yml и platform/compose.base.yml).
for target in platform/compose.base.yml compose.project.yml; do
  for var in YANDEX_SEARCH_MAX_CONCURRENCY YANDEX_SEARCH_MIN_INTERVAL_MS DOCUMENTS_EDIT_PPTX \
    DOCUMENTS_EDIT_PDF DOCUMENTS_PPT_CONVERT DOCUMENTS_EDIT_PDF_FALLBACK_FONT; do
    sed -i "/$var\$/d;/$var:/d" "$REPO/deploy/$target"
    commit "без переменной $var в $target"
    rc=0
    run --out "$TMP/pkg-novar" >"$TMP/out-novar.log" 2>&1 || rc=$?
    assert "в $target нет $var - отказ" "[[ $rc -eq 1 ]]"
    assert "отказ называет переменную $var" "grep -q '$var' '$TMP/out-novar.log'"
    git -C "$REPO" reset -q --hard HEAD~1
    rm -rf "${TMP:?}/pkg-novar"
  done
done
# Версия платформы в PLATFORM-VERSION не 1.1.6 - отказ; файла нет - отказ.
echo "PLATFORM_PACKAGES_VERSION=1.1.5" >"$REPO/deploy/platform/PLATFORM-VERSION"
commit "старая версия платформы"
rc=0
run --out "$TMP/pkg-oldver" >"$TMP/out-oldver.log" 2>&1 || rc=$?
assert "PLATFORM-VERSION не 1.1.6 - отказ" "[[ $rc -eq 1 ]]"
assert "отказ называет версию" "grep -q '1.1.6' '$TMP/out-oldver.log'"
git -C "$REPO" reset -q --hard HEAD~1
git -C "$REPO" rm -q -f deploy/platform/PLATFORM-VERSION
git -C "$REPO" -c user.name=t -c user.email=t@example.test commit -q -m "нет PLATFORM-VERSION"
rc=0
run --out "$TMP/pkg-nover" >"$TMP/out-nover.log" 2>&1 || rc=$?
assert "в HEAD нет PLATFORM-VERSION - отказ" "[[ $rc -eq 1 ]]"
git -C "$REPO" reset -q --hard HEAD~1

# Отказы по lock: версия не 1.1.6-pragmatika.2, нет app/documents/mask по digest.
cp "$TMP/images.lock" "$TMP/images.keep"
for ver in 1.1.6-pragmatika.1 1.1.6 1.1.6-pragmatika.3; do
  sed "s|^BAI_VERSION=.*|BAI_VERSION=$ver|" "$TMP/images.keep" >"$TMP/images.lock"
  make_sigs "$TMP/signatures.txt" OK
  rc=0
  run --out "$TMP/pkg-ver" >"$TMP/out-ver.log" 2>&1 || rc=$?
  assert "BAI_VERSION=$ver - отказ" "[[ $rc -eq 1 && ! -e '$TMP/pkg-ver/patch.sh' ]]"
  assert "отказ называет нужную версию" "grep -q '$LOCK_VERSION' '$TMP/out-ver.log'"
  rm -rf "${TMP:?}/pkg-ver"
done
grep -v '^BAI_VERSION=' "$TMP/images.keep" >"$TMP/images.lock"
make_sigs "$TMP/signatures.txt" OK
rc=0
run --out "$TMP/pkg-nover2" >"$TMP/out-nover2.log" 2>&1 || rc=$?
assert "lock без BAI_VERSION - отказ" "[[ $rc -eq 1 ]]"
for key in MASK APP DOCUMENTS; do
  grep -v "^BAI_IMAGE_$key=" "$TMP/images.keep" >"$TMP/images.lock"
  make_sigs "$TMP/signatures.txt" OK
  rc=0
  run --out "$TMP/pkg-no$key" >"$TMP/out5.log" 2>&1 || rc=$?
  assert "lock без BAI_IMAGE_$key - отказ" "[[ $rc -eq 1 ]]"
done
sed "s|^BAI_IMAGE_DOCUMENTS=.*|BAI_IMAGE_DOCUMENTS=r/documents:latest|" "$TMP/images.keep" \
  >"$TMP/images.lock"
make_sigs "$TMP/signatures.txt" OK
rc=0
run --out "$TMP/pkg-tag" >"$TMP/out5b.log" 2>&1 || rc=$?
assert "BAI_IMAGE_DOCUMENTS по тегу, не по digest - отказ" "[[ $rc -eq 1 ]]"
cp "$TMP/images.keep" "$TMP/images.lock"
make_sigs "$TMP/signatures.txt" OK

# Отказы: подтверждение подписей не к этому lock, result=FAIL, не покрывает все образы.
cp "$TMP/signatures.txt" "$TMP/signatures.good"
echo "BAI_IMAGE_X=r/x@sha256:$DIGEST_A" >>"$TMP/images.lock"
rc=0
run --out "$TMP/pkg-sigold" >"$TMP/out3.log" 2>&1 || rc=$?
assert "подписи не покрывают lock - отказ" "[[ $rc -eq 1 && ! -e '$TMP/pkg-sigold/patch.sh' ]]"
cp "$TMP/images.keep" "$TMP/images.lock"
make_sigs "$TMP/sigs.fail" FAIL
rc=0
BAI_PROJECT_DIR="$REPO" bash "$SCRIPT" --lock "$TMP/images.lock" --signatures "$TMP/sigs.fail" \
  --cosign-pub "$TMP/cosign.pub" --out "$TMP/pkg-fail" >"$TMP/out4.log" 2>&1 || rc=$?
assert "подтверждение result=FAIL - отказ" "[[ $rc -eq 1 ]]"
grep -v 'BAI_IMAGE_ALLOY\|BAI_IMAGE_MASK' "$TMP/signatures.good" >"$TMP/sigs.partial"
rc=0
BAI_PROJECT_DIR="$REPO" bash "$SCRIPT" --lock "$TMP/images.lock" --signatures "$TMP/sigs.partial" \
  --cosign-pub "$TMP/cosign.pub" --out "$TMP/pkg-partial" >"$TMP/out4b.log" 2>&1 || rc=$?
assert "подтверждение покрывает не все образы lock - отказ" "[[ $rc -eq 1 ]]"
rc=0
run --out "$OUT" >"$TMP/out6.log" 2>&1 || rc=$?
assert "непустой каталог - код 2" "[[ $rc -eq 2 ]]"
rc=0
bash "$SCRIPT" --out "$TMP/pkg-x" >"$TMP/out7.log" 2>&1 || rc=$?
assert "нет обязательного --lock - код 2" "[[ $rc -eq 2 ]]"
rc=0
run --out "$TMP/pkg-y" --nonsense >"$TMP/out8.log" 2>&1 || rc=$?
assert "неизвестный аргумент - код 2" "[[ $rc -eq 2 ]]"
rc=0
bash "$SCRIPT" --lock "$TMP/images.lock" --cosign-pub "$TMP/нет.pub" --out "$TMP/pkg-z" \
  >"$TMP/out9.log" 2>&1 || rc=$?
assert "нет файла ключа - код 2" "[[ $rc -eq 2 ]]"

# Запрещённые файлы: .env в deploy, попавший в HEAD, в пакет не попадает (deploy/ не копируется).
printf 'x=1\n' >"$REPO/deploy/.env"
git -C "$REPO" add -f deploy/.env
git -C "$REPO" -c user.name=t -c user.email=t@example.test commit -q -m "env"
rc=0
run --out "$TMP/pkg-env" >"$TMP/out10.log" 2>&1 || rc=$?
assert "лишний .env в дереве не попадает в пакет (deploy/ в пакет не копируется)" \
  "[[ $rc -eq 0 && ! -e '$TMP/pkg-env/deploy' ]] && ! grep -rq 'x=1' '$TMP/pkg-env'"
# Секрет в приложенных файлах (закрытый ключ в инструкции) - отказ.
printf -- '-----BEGIN PRIVATE KEY-----\nabc\n' >"$TMP/RUNBOOK-secret.md"
rc=0
run --out "$TMP/pkg-secret" --runbook "$TMP/RUNBOOK-secret.md" >"$TMP/out11.log" 2>&1 || rc=$?
assert "закрытый ключ в пакете - отказ" "[[ $rc -eq 1 ]]"

assert "строки скрипта до $LIMIT знаков" \
  "! LC_ALL=C.UTF-8 awk 'length > $LIMIT' '$SCRIPT' | grep -q ."
assert "строки теста до $LIMIT знаков" \
  "! LC_ALL=C.UTF-8 awk 'length > $LIMIT' '$0' | grep -q ."
assert "set -euo pipefail" "grep -q '^set -euo pipefail' '$SCRIPT'"
assert "список файлов сборщика = PATCH_FILE_ALLOW в patch.sh (оба пусты)" \
  "[[ \"\$(grep -m1 '^DEPLOY_FILES=(' '$SCRIPT' | sed 's/.*(\\(.*\\)).*/\\1/')\" \
     == \"\$(grep -m1 '^PATCH_FILE_ALLOW=(' '$PATCH_SH' | sed 's/.*(\\(.*\\)).*/\\1/')\" \
     && -n \"\$(grep -m1 '^DEPLOY_FILES=(' '$SCRIPT')\" \
     && -z \"\$(grep -m1 '^DEPLOY_FILES=(' '$SCRIPT' | sed 's/.*(\\(.*\\)).*/\\1/')\" ]]"
assert "в сборщике нет sudo и rm с масками" \
  "! grep -vE '^[[:space:]]*#' '$SCRIPT' | grep -qE '\\bsudo\\b|\\brm +-[a-z]* *[^ ]*[*]'"
assert "в сборщике нет предмета G8x (patch-8x, pypdf, impress)" \
  "! grep -qiE 'patch-8x|patch8x|pypdf|impress' '$SCRIPT'"

echo "проверок: $((PASS + FAIL)), провалено: $FAIL"
[[ "$FAIL" -eq 0 ]]
