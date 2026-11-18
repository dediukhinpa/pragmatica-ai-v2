#!/usr/bin/env bash
# Тест tools/build-patch-8w-package.sh: состав пакета G8w, манифест, запрет секретов и db,
# проверка подтверждения подписей (обязательно, если дано; необязательно, если не дано), проверка
# переменных Яндекса в compose, архив, права и строгое соответствие списка файлов patch.sh.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/build-patch-8w-package.sh"
PATCH_SH="$HERE/../deploy/patch-8w/patch.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP:?}"' EXIT
PASS=0
FAIL=0
LIMIT=100
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
mkdir -p "$REPO/deploy/cutover" "$REPO/deploy/patch-8w" "$REPO/deploy/platform" "$REPO/tools"
for f in compose.project.yml platform/compose.base.yml; do
  printf '# %s\nYANDEX_SEARCH_MAX_CONCURRENCY: 1\n' "$f" >"$REPO/deploy/$f"
  echo 'YANDEX_SEARCH_MIN_INTERVAL_MS: 1000' >>"$REPO/deploy/$f"
done
echo "PLATFORM_PACKAGES_VERSION=1.1.4" >"$REPO/deploy/platform/PLATFORM-VERSION"
# Файлы, которых в пакете G8w быть не должно (G8 их заменял, G8w - нет).
for f in compose.yml compat.env; do echo "# $f" >"$REPO/deploy/$f"; done
printf '#!/usr/bin/env bash\n' >"$REPO/deploy/patch-8w/patch.sh"
printf '#!/usr/bin/env bash\n' >"$REPO/deploy/patch-8w/smoke_contract.py"
for f in lib.sh verify-signatures.sh; do
  printf '#!/usr/bin/env bash\n' >"$REPO/deploy/cutover/$f"
done
for f in check-routes.sh check-image-routes.sh route-flags.tsv; do
  echo "# $f" >"$REPO/tools/$f"
done
printf 'documents\tPOST\t/parse\troute\n' >"$REPO/deploy/cutover/routes.tsv"
git -C "$REPO" init -q
commit init

printf 'BAI_VERSION=1.1.4\nBAI_IMAGE_APP=r/app@sha256:%s\nBAI_IMAGE_MASK=r/mask@sha256:%s\n' \
  "$DIGEST_A" "$DIGEST_M" >"$TMP/images.lock"
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
  OWNER-RUNBOOK.md MANIFEST.sha256 tools/check-routes.sh tools/route-flags.tsv \
  deploy/compose.project.yml deploy/platform/compose.base.yml deploy/platform/PLATFORM-VERSION; do
  assert "в пакете есть $f" "[[ -f '$OUT/$f' ]]"
done
for f in smoke_contract.py tools/check-image-routes.sh deploy/compose.yml deploy/compat.env; do
  assert "в пакете G8w нет $f (это файлы G8)" "[[ ! -e '$OUT/$f' ]]"
done
assert "скрипты исполняемые" \
  "[[ -x '$OUT/patch.sh' && -x '$OUT/verify-signatures.sh' && -x '$OUT/tools/check-routes.sh' ]]"
assert "обычные файлы 644, каталоги 755" \
  "[[ \$(stat -c %a '$OUT/images.lock') == 644 && \$(stat -c %a '$OUT/deploy/platform') == 755 ]]"
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
echo "# локальная правка" >>"$REPO/deploy/compose.project.yml"
rm -rf "${TMP:?}/pkg2"
run --out "$TMP/pkg2" >"$TMP/out2.log" 2>&1
assert "незакоммиченная правка не попала в пакет" \
  "! grep -q 'локальная' '$TMP/pkg2/deploy/compose.project.yml'"
assert "незакоммиченная правка: предупреждение в выводе" "grep -q 'незакоммиченные' '$TMP/out2.log'"
git -C "$REPO" checkout -q -- deploy/compose.project.yml

# Без --signatures: сборка проходит, signatures.txt нет, есть предупреждение.
rc=0
BAI_PROJECT_DIR="$REPO" bash "$SCRIPT" --lock "$TMP/images.lock" --cosign-pub "$TMP/cosign.pub" \
  --out "$TMP/pkg-nosig" >"$TMP/out-nosig.log" 2>&1 || rc=$?
assert "без --signatures сборка проходит" "[[ $rc -eq 0 ]]"
assert "без --signatures: signatures.txt в пакете нет" "[[ ! -e '$TMP/pkg-nosig/signatures.txt' ]]"
assert "без --signatures: предупреждение про cosign" "grep -q 'нужен cosign' '$TMP/out-nosig.log'"
assert "без --signatures: манифест сходится" \
  "(cd '$TMP/pkg-nosig' && sha256sum -c --quiet MANIFEST.sha256)"

# Переменных Яндекса нет в compose из HEAD - отказ.
sed -i '/YANDEX_SEARCH_MIN_INTERVAL_MS/d' "$REPO/deploy/platform/compose.base.yml"
commit "без переменной"
rc=0
run --out "$TMP/pkg-novar" >"$TMP/out-novar.log" 2>&1 || rc=$?
assert "в compose нет переменной интервала - отказ" "[[ $rc -eq 1 ]]"
assert "отказ называет переменную" "grep -q 'YANDEX_SEARCH_MIN_INTERVAL_MS' '$TMP/out-novar.log'"
git -C "$REPO" reset -q --hard HEAD~1

# Отказы: подтверждение подписей не к этому lock, result=FAIL, lock без mask/app/documents,
# непустой каталог, нет ключа.
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
cp "$TMP/images.lock" "$TMP/images.keep"
for key in MASK APP DOCUMENTS; do
  grep -v "^BAI_IMAGE_$key=" "$TMP/images.keep" >"$TMP/images.lock"
  make_sigs "$TMP/signatures.txt" OK
  rc=0
  run --out "$TMP/pkg-no$key" >"$TMP/out5.log" 2>&1 || rc=$?
  assert "lock без BAI_IMAGE_$key - отказ" "[[ $rc -eq 1 ]]"
done
cp "$TMP/images.keep" "$TMP/images.lock"
make_sigs "$TMP/signatures.txt" OK
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

# Запрещённые файлы: .env в deploy, попавший в пакет, ловится до манифеста.
printf 'x=1\n' >"$REPO/deploy/.env"
git -C "$REPO" add -f deploy/.env
git -C "$REPO" -c user.name=t -c user.email=t@example.test commit -q -m "env"
rc=0
run --out "$TMP/pkg-env" >"$TMP/out10.log" 2>&1 || rc=$?
assert "лишний .env в дереве не попадает в пакет (список файлов закрыт)" \
  "[[ $rc -eq 0 && ! -e '$TMP/pkg-env/deploy/.env' ]]"

assert "строки скрипта до $LIMIT знаков" \
  "! LC_ALL=C.UTF-8 awk 'length > $LIMIT' '$SCRIPT' | grep -q ."
assert "строки теста до $LIMIT знаков" \
  "! LC_ALL=C.UTF-8 awk 'length > $LIMIT' '$0' | grep -q ."
assert "set -euo pipefail" "grep -q '^set -euo pipefail' '$SCRIPT'"
assert "список файлов сборщика = PATCH_FILE_ALLOW в patch.sh" \
  "[[ \"\$(grep -m1 '^DEPLOY_FILES=(' '$SCRIPT' | sed 's/.*(\\(.*\\)).*/\\1/')\" \
     == \"\$(grep -m1 '^PATCH_FILE_ALLOW=(' '$PATCH_SH' | sed 's/.*(\\(.*\\)).*/\\1/')\" \
     && -n \"\$(grep -m1 '^DEPLOY_FILES=(' '$SCRIPT')\" ]]"
assert "в сборщике нет sudo и rm с масками" \
  "! grep -vE '^[[:space:]]*#' '$SCRIPT' | grep -qE '\\bsudo\\b|\\brm +-[a-z]* *[^ ]*[*]'"

echo "проверок: $((PASS + FAIL)), провалено: $FAIL"
[[ "$FAIL" -eq 0 ]]
