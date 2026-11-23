#!/usr/bin/env bash
# Тест tools/build-patch-9s-package.sh: состав пакета G9s (из файлов deploy/ ровно
# compose.project.yml, плюс enable-flags.sh и необязательный tools/chat-attachments-cli.sh),
# манифест, запрет секретов и db, проверка подтверждения подписей (обязательно, если дано;
# необязательно, если не дано), проверка версии lock 1.1.10-pragmatika.2 и образов app и documents
# по digest, сравнение с lock боя после G9r (--prev-lock: его версия 1.1.10-pragmatika.1, отличия
# только BAI_VERSION и BAI_IMAGE_APP, образ app обязан смениться, образ documents - остаться
# прежним), проверка трёх новых переменных app с умолчаниями (true, 30, 3221225472) и прежних
# переменных с умолчанием true в compose.project.yml, проверка (без копирования в пакет)
# переменных Яндекса и флагов documents в обоих файлах compose, маршрута documents POST /docx/pages
# в routes.tsv, версии платформы 1.1.10 с суммой compose.base.yml и переменных платформы (состояние
# после G9r), архив, права и строгое соответствие списка файлов patch.sh. Docker не нужен.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/build-patch-9s-package.sh"
PATCH_SH="$HERE/../deploy/patch-9s/patch.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP:?}"' EXIT
PASS=0
FAIL=0
LIMIT=100
LOCK_VERSION="1.1.10-pragmatika.2"
PREV_VERSION="1.1.10-pragmatika.1"
# Новые переменные app G9s ИМЯ=умолчание и прежние переменные G8z, G9p, G9q, G9q2 и G9q3, которые
# обязаны остаться в compose.project.yml (умолчание true).
NEW_APP_FLAGS=(CHAT_ATTACHMENTS_STORE_ENABLED=true CHAT_ATTACHMENTS_RETENTION_DAYS=30
  CHAT_ATTACHMENTS_MAX_BYTES=3221225472)
OLD_APP_FLAGS=(SHORTLIST_PAGING_ENABLED SUPPLIER_DISCOVERY_ENABLED PRICE_EDIT_FIRST_ENABLED
  DOCX_PAGES_ENABLED PRICE_EDIT_DB_WRITE_ENABLED PRICE_EDIT_TEXT_BLOCKS_ENABLED
  EMPTY_REPLY_GUARD_ENABLED PRICE_FILE_ONCE_PER_TURN_ENABLED STEP_TEXT_SEPARATE_ENABLED)
DIGEST_A="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
DIGEST_M="eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
DIGEST_D="dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
DIGEST_B="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

ok() { PASS=$((PASS + 1)); echo "PASS $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL $1"; }
assert() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
commit() { git -C "$REPO" add -A -f && git -C "$REPO" -c user.name=t -c user.email=t@example.test \
  commit -q -m "$1"; }

# Строка суммы compose.base.yml в PLATFORM-VERSION пересчитывается после правки файла.
fix_sum() { # fix_sum [версия]
  printf 'PLATFORM_PACKAGES_VERSION=%s\nsha256 %s  compose.base.yml\n' "${1:-1.1.10}" \
    "$(sha256sum <"$REPO/deploy/platform/compose.base.yml" | cut -d' ' -f1)" \
    >"$REPO/deploy/platform/PLATFORM-VERSION"
}

# Временный git-репозиторий с минимальным составом проекта.
REPO="$TMP/repo"
mkdir -p "$REPO/deploy/cutover" "$REPO/deploy/patch-9s" "$REPO/deploy/platform" "$REPO/tools"
for f in compose.project.yml platform/compose.base.yml; do
  printf '# %s\nYANDEX_SEARCH_MAX_CONCURRENCY: 1\n' "$f" >"$REPO/deploy/$f"
  echo 'YANDEX_SEARCH_MIN_INTERVAL_MS: 1200' >>"$REPO/deploy/$f"
  printf 'DOCUMENTS_EDIT_PPTX: true\nDOCUMENTS_EDIT_PDF: true\n' >>"$REPO/deploy/$f"
  printf 'DOCUMENTS_PPT_CONVERT: true\nDOCUMENTS_EDIT_PDF_FALLBACK_FONT: false\n' \
    >>"$REPO/deploy/$f"
done
# Прежние переменные app (уже на бою) с умолчанием true и новые переменные G9s со своими
# умолчаниями: только в compose.project.yml.
for v in "${OLD_APP_FLAGS[@]}"; do
  printf '  %s: ${%s:-true}\n' "$v" "$v" >>"$REPO/deploy/compose.project.yml"
done
for item in "${NEW_APP_FLAGS[@]}"; do
  printf '  %s: ${%s:-%s}\n' "${item%%=*}" "${item%%=*}" "${item#*=}" \
    >>"$REPO/deploy/compose.project.yml"
done
# Новые переменные платформы 1.1.10 (состояние G9r): только в копии платформы.
printf '  DOCUMENTS_EDIT_PDF_TEXT: ${DOCUMENTS_EDIT_PDF_TEXT:-}\n' \
  >>"$REPO/deploy/platform/compose.base.yml"
printf '  B24_CALL_RECORDING_MAX_BYTES: ${B24_CALL_RECORDING_MAX_BYTES:-104857600}\n' \
  >>"$REPO/deploy/platform/compose.base.yml"
printf '  B24_CALL_RECORDING_TIMEOUT_MS: ${B24_CALL_RECORDING_TIMEOUT_MS:-600000}\n' \
  >>"$REPO/deploy/platform/compose.base.yml"
fix_sum
# Файлы дерева, которых в пакете G9s быть не должно (кроме compose.project.yml).
for f in compose.yml compat.env; do echo "# $f" >"$REPO/deploy/$f"; done
printf '#!/usr/bin/env bash\n' >"$REPO/deploy/patch-9s/patch.sh"
printf '#!/usr/bin/env bash\n' >"$REPO/deploy/patch-9s/enable-flags.sh"
printf '#!/usr/bin/env bash\n' >"$REPO/deploy/patch-9s/smoke_contract.py"
for f in lib.sh verify-signatures.sh; do
  printf '#!/usr/bin/env bash\n' >"$REPO/deploy/cutover/$f"
done
for f in check-routes.sh check-image-routes.sh route-flags.tsv chat-attachments-cli.sh; do
  echo "# $f" >"$REPO/tools/$f"
done
printf 'documents\tPOST\t/parse\troute\ndocuments\tPOST\t/docx/pages\troute\n' \
  >"$REPO/deploy/cutover/routes.tsv"
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
for f in patch.sh enable-flags.sh lib.sh verify-signatures.sh routes.tsv images.lock \
  signatures.txt cosign.pub OWNER-RUNBOOK.md MANIFEST.sha256 tools/check-routes.sh \
  tools/route-flags.tsv tools/chat-attachments-cli.sh deploy/compose.project.yml; do
  assert "в пакете есть $f" "[[ -f '$OUT/$f' ]]"
done
assert "из файлов deploy/ в пакете ровно compose.project.yml" \
  "[[ \"\$(cd '$OUT' && find deploy -type f)\" == 'deploy/compose.project.yml' ]]"
assert "compose.project.yml в пакете - копия из HEAD с новыми переменными" \
  "git -C '$REPO' show HEAD:deploy/compose.project.yml \
   | cmp -s - '$OUT/deploy/compose.project.yml' \
   && grep -q 'CHAT_ATTACHMENTS_STORE_ENABLED:-true' '$OUT/deploy/compose.project.yml' \
   && grep -q 'CHAT_ATTACHMENTS_RETENTION_DAYS:-30' '$OUT/deploy/compose.project.yml' \
   && grep -q 'CHAT_ATTACHMENTS_MAX_BYTES:-3221225472' '$OUT/deploy/compose.project.yml'"
assert "routes.tsv в пакете содержит маршрут documents POST /docx/pages" \
  "grep -qxF \$'documents\tPOST\t/docx/pages\troute' '$OUT/routes.tsv'"
for f in smoke_contract.py tools/check-image-routes.sh compose.yml compat.env \
  deploy/platform/PLATFORM-VERSION deploy/platform/compose.base.yml deploy/compose.yml \
  deploy/images.lock; do
  assert "в пакете G9s нет $f" "[[ ! -e '$OUT/$f' ]]"
done
PKG_LIST="$(cd "$OUT" && find . -type f | sed 's|^\./||' | LC_ALL=C sort | tr '\n' ' ')"
PKG_WANT="MANIFEST.sha256 OWNER-RUNBOOK.md cosign.pub deploy/compose.project.yml enable-flags.sh "
PKG_WANT+="images.lock lib.sh patch.sh routes.tsv signatures.txt tools/chat-attachments-cli.sh "
PKG_WANT+="tools/check-routes.sh tools/route-flags.tsv verify-signatures.sh "
assert "состав пакета - ровно ожидаемые файлы" "[[ '$PKG_LIST' == '$PKG_WANT' ]]"
assert "скрипты исполняемые (patch.sh, enable-flags.sh, verify-signatures.sh, check-routes.sh)" \
  "[[ -x '$OUT/patch.sh' && -x '$OUT/enable-flags.sh' && -x '$OUT/verify-signatures.sh' \
   && -x '$OUT/tools/check-routes.sh' ]]"
assert "tools/chat-attachments-cli.sh в пакете - копия из HEAD, исполняемый" \
  "git -C '$REPO' show HEAD:tools/chat-attachments-cli.sh | cmp -s - \
   '$OUT/tools/chat-attachments-cli.sh' && [[ -x '$OUT/tools/chat-attachments-cli.sh' ]]"
assert "в выводе сборки есть пометка про chat-attachments-cli.sh" \
  "grep -q 'chat-attachments-cli.sh' '$TMP/out.log' && ! grep -q 'ПРОПУЩЕНО' '$TMP/out.log'"
assert "файлы платформы (compose.base.yml, PLATFORM-VERSION) в пакет не попадают" \
  "! find '$OUT' -name 'compose.base.yml' -o -name 'PLATFORM-VERSION' | grep -q ."
assert "обычные файлы 644, каталоги 755" \
  "[[ \$(stat -c %a '$OUT/images.lock') == 644 && \$(stat -c %a '$OUT/tools') == 755 \
   && \$(stat -c %a '$OUT/deploy/compose.project.yml') == 644 \
   && \$(stat -c %a '$OUT/deploy') == 755 ]]"
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
echo "# локальная правка" >>"$REPO/deploy/patch-9s/patch.sh"
rm -rf "${TMP:?}/pkg2"
run --out "$TMP/pkg2" >"$TMP/out2.log" 2>&1
assert "незакоммиченная правка не попала в пакет" "! grep -q 'локальная' '$TMP/pkg2/patch.sh'"
assert "незакоммиченная правка: предупреждение в выводе" "grep -q 'незакоммиченные' '$TMP/out2.log'"
git -C "$REPO" checkout -q -- deploy/patch-9s/patch.sh

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
# Новой или прежней переменной app нет в compose.project.yml, или умолчание не то - отказ;
# причина называет переменную и требуемое умолчание. Переменные нужны только в
# compose.project.yml (его кладём в пакет).
ALL_APP_FLAGS=("${NEW_APP_FLAGS[@]}")
for v in "${OLD_APP_FLAGS[@]}"; do ALL_APP_FLAGS+=("$v=true"); done
for item in "${ALL_APP_FLAGS[@]}"; do
  var="${item%%=*}"
  def="${item#*=}"
  wrong="${def}9"
  [[ "$def" != true ]] || wrong="false"
  sed -i "/$var:/d" "$REPO/deploy/compose.project.yml"
  commit "без новой переменной $var"
  rc=0
  run --out "$TMP/pkg-nonew" >"$TMP/out-nonew.log" 2>&1 || rc=$?
  assert "в compose.project.yml нет $var - отказ" \
    "[[ $rc -eq 1 ]]"
  assert "отказ называет переменную $var" "grep -q '$var' '$TMP/out-nonew.log'"
  git -C "$REPO" reset -q --hard HEAD~1
  rm -rf "${TMP:?}/pkg-nonew"
  sed -i "s|$var:-$def|$var:-$wrong|" "$REPO/deploy/compose.project.yml"
  commit "умолчание $var $wrong"
  rc=0
  run --out "$TMP/pkg-nonew" >"$TMP/out-nonew.log" 2>&1 || rc=$?
  assert "умолчание $var не $def ($wrong) - отказ" "[[ $rc -eq 1 ]]"
  assert "отказ называет требуемое умолчание $def" "grep -q ':-$def' '$TMP/out-nonew.log'"
  assert "отказ про умолчание называет $var" "grep -q '$var' '$TMP/out-nonew.log'"
  git -C "$REPO" reset -q --hard HEAD~1
  rm -rf "${TMP:?}/pkg-nonew"
done
# В routes.tsv из HEAD нет маршрута documents POST /docx/pages - отказ.
printf 'documents\tPOST\t/parse\troute\n' >"$REPO/deploy/cutover/routes.tsv"
commit "routes.tsv без /docx/pages"
rc=0
run --out "$TMP/pkg-noroute" >"$TMP/out-noroute.log" 2>&1 || rc=$?
assert "в routes.tsv нет маршрута /docx/pages - отказ" "[[ $rc -eq 1 ]]"
assert "отказ называет маршрут /docx/pages" "grep -q '/docx/pages' '$TMP/out-noroute.log'"
git -C "$REPO" reset -q --hard HEAD~1
rm -rf "${TMP:?}/pkg-noroute"
# Переменные app нужны только в compose.project.yml: в platform/compose.base.yml их нет, и это
# не мешает сборке (файл в пакет не кладётся; сборка выше прошла).
assert "в platform/compose.base.yml новых переменных нет (и не нужны)" \
  "! grep -q 'SHORTLIST_PAGING_ENABLED' '$REPO/deploy/platform/compose.base.yml'"
# Версия платформы в PLATFORM-VERSION не 1.1.10 (стоит прежняя 1.1.6, G9r не в HEAD) - отказ.
fix_sum 1.1.6
commit "старая версия платформы"
rc=0
run --out "$TMP/pkg-oldver" >"$TMP/out-oldver.log" 2>&1 || rc=$?
assert "PLATFORM-VERSION не 1.1.10 - отказ" "[[ $rc -eq 1 ]]"
assert "отказ называет версию" "grep -q '1.1.10' '$TMP/out-oldver.log'"
git -C "$REPO" reset -q --hard HEAD~1
# Сумма compose.base.yml не сходится со строкой PLATFORM-VERSION (файл правили руками) - отказ.
echo "# правка руками" >>"$REPO/deploy/platform/compose.base.yml"
commit "правка платформы без пересчёта суммы"
rc=0
run --out "$TMP/pkg-sum" >"$TMP/out-sum.log" 2>&1 || rc=$?
assert "сумма compose.base.yml не сходится с PLATFORM-VERSION - отказ" "[[ $rc -eq 1 ]]"
assert "отказ про сумму называет compose.base.yml" "grep -q 'compose.base.yml' '$TMP/out-sum.log'"
git -C "$REPO" reset -q --hard HEAD~1
# Новых переменных платформы 1.1.10 нет в compose.base.yml (при верной сумме) - отказ.
for var in DOCUMENTS_EDIT_PDF_TEXT B24_CALL_RECORDING_MAX_BYTES B24_CALL_RECORDING_TIMEOUT_MS; do
  sed -i "/$var/d" "$REPO/deploy/platform/compose.base.yml"
  fix_sum
  commit "без переменной платформы $var"
  rc=0
  run --out "$TMP/pkg-pvar" >"$TMP/out-pvar.log" 2>&1 || rc=$?
  assert "в compose.base.yml нет $var - отказ" "[[ $rc -eq 1 ]]"
  assert "отказ называет переменную платформы $var" "grep -q '$var' '$TMP/out-pvar.log'"
  git -C "$REPO" reset -q --hard HEAD~1
  rm -rf "${TMP:?}/pkg-pvar"
done
git -C "$REPO" rm -q -f deploy/platform/PLATFORM-VERSION
git -C "$REPO" -c user.name=t -c user.email=t@example.test commit -q -m "нет PLATFORM-VERSION"
rc=0
run --out "$TMP/pkg-nover" >"$TMP/out-nover.log" 2>&1 || rc=$?
assert "в HEAD нет PLATFORM-VERSION - отказ" "[[ $rc -eq 1 ]]"
git -C "$REPO" reset -q --hard HEAD~1

# tools/chat-attachments-cli.sh нет в HEAD: сборка проходит, файл пропускается с пометкой.
git -C "$REPO" rm -q -f tools/chat-attachments-cli.sh
git -C "$REPO" -c user.name=t -c user.email=t@example.test commit -q -m "нет обёртки владельца"
rc=0
run --out "$TMP/pkg-nocli" >"$TMP/out-nocli.log" 2>&1 || rc=$?
assert "без chat-attachments-cli.sh в HEAD сборка проходит" "[[ $rc -eq 0 ]]"
assert "без chat-attachments-cli.sh: файла в пакете нет, в выводе пометка ПРОПУЩЕНО" \
  "[[ ! -e '$TMP/pkg-nocli/tools/chat-attachments-cli.sh' ]] \
   && grep -q 'ПРОПУЩЕНО.*chat-attachments-cli.sh' '$TMP/out-nocli.log'"
assert "без chat-attachments-cli.sh: манифест сходится" \
  "(cd '$TMP/pkg-nocli' && sha256sum -c --quiet MANIFEST.sha256)"
git -C "$REPO" reset -q --hard HEAD~1

# Отказы по lock: версия не 1.1.10-pragmatika.2, нет app/documents/mask по digest.
cp "$TMP/images.lock" "$TMP/images.keep"
for ver in 1.1.10-pragmatika.1 1.1.10 1.1.10-pragmatika.3 1.1.6-pragmatika.7; do
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

# --prev-lock: lock боя после G9r (версия .1); новый lock отличается только BAI_VERSION и
# BAI_IMAGE_APP (образ app обязан смениться, образ documents обязан остаться прежним).
sed -e "s|^BAI_VERSION=.*|BAI_VERSION=$PREV_VERSION|" \
  -e "s|^BAI_IMAGE_APP=.*|BAI_IMAGE_APP=r/app@sha256:$DIGEST_B|" \
  "$TMP/images.keep" >"$TMP/prev.lock"
rc=0
run --out "$TMP/pkg-prev" --prev-lock "$TMP/prev.lock" >"$TMP/out-prev.log" 2>&1 || rc=$?
assert "--prev-lock: lock отличается только версией и образом app - сборка проходит" \
  "[[ $rc -eq 0 && -f '$TMP/pkg-prev/patch.sh' ]]"
# Образ documents у боя другой: G9s его не меняет, отличие недопустимо - отказ.
sed "s|^BAI_IMAGE_DOCUMENTS=.*|BAI_IMAGE_DOCUMENTS=r/documents@sha256:$DIGEST_B|" "$TMP/prev.lock" \
  >"$TMP/prev-docs.lock"
rc=0
run --out "$TMP/pkg-prev2" --prev-lock "$TMP/prev-docs.lock" >"$TMP/out-prev2.log" 2>&1 || rc=$?
assert "--prev-lock: образ documents отличается (G9s его не меняет) - отказ" \
  "[[ $rc -eq 1 && ! -e '$TMP/pkg-prev2/patch.sh' ]]"
assert "--prev-lock: отказ называет BAI_IMAGE_DOCUMENTS" \
  "grep -q 'BAI_IMAGE_DOCUMENTS' '$TMP/out-prev2.log'"
sed "s|^BAI_IMAGE_MASK=.*|BAI_IMAGE_MASK=r/mask@sha256:$DIGEST_A|" "$TMP/prev.lock" \
  >"$TMP/prev-mask.lock"
rc=0
run --out "$TMP/pkg-prev3" --prev-lock "$TMP/prev-mask.lock" >"$TMP/out-prev3.log" 2>&1 || rc=$?
assert "--prev-lock: образ mask отличается - отказ" "[[ $rc -eq 1 ]]"
sed "s|^BAI_VERSION=.*|BAI_VERSION=$PREV_VERSION|" "$TMP/images.keep" >"$TMP/prev-same.lock"
rc=0
run --out "$TMP/pkg-prev4" --prev-lock "$TMP/prev-same.lock" >"$TMP/out-prev4.log" 2>&1 || rc=$?
assert "--prev-lock: образ app не меняется (патчу нечего катить) - отказ" "[[ $rc -eq 1 ]]"
assert "--prev-lock: отказ называет BAI_IMAGE_APP" "grep -q 'BAI_IMAGE_APP' '$TMP/out-prev4.log'"
# Версия prev-lock не G9r (уже G9s, либо старее G9r) - отказ, причина называет нужную версию.
for pver in "$LOCK_VERSION" 1.1.6-pragmatika.7; do
  sed "s|^BAI_VERSION=.*|BAI_VERSION=$pver|" "$TMP/prev.lock" >"$TMP/prev-ver.lock"
  rc=0
  run --out "$TMP/pkg-prev6" --prev-lock "$TMP/prev-ver.lock" >"$TMP/out-prev6.log" 2>&1 || rc=$?
  assert "--prev-lock с версией $pver (не G9r) - отказ" \
    "[[ $rc -eq 1 && ! -e '$TMP/pkg-prev6/patch.sh' ]]"
  assert "--prev-lock: отказ называет версию G9r $PREV_VERSION" \
    "grep -q '$PREV_VERSION' '$TMP/out-prev6.log'"
  rm -rf "${TMP:?}/pkg-prev6"
done
rc=0
run --out "$TMP/pkg-prev5" --prev-lock "$TMP/нет.lock" >"$TMP/out-prev5.log" 2>&1 || rc=$?
assert "--prev-lock: нет файла - код 2" "[[ $rc -eq 2 ]]"

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

# Запрещённые файлы: .env в deploy, попавший в HEAD, в пакет не попадает (копируется только
# compose.project.yml).
printf 'x=1\n' >"$REPO/deploy/.env"
git -C "$REPO" add -f deploy/.env
git -C "$REPO" -c user.name=t -c user.email=t@example.test commit -q -m "env"
rc=0
run --out "$TMP/pkg-env" >"$TMP/out10.log" 2>&1 || rc=$?
assert "лишний .env в дереве не попадает в пакет (копируется только compose.project.yml)" \
  "[[ $rc -eq 0 && ! -e '$TMP/pkg-env/deploy/.env' ]] && ! grep -rq 'x=1' '$TMP/pkg-env'"
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
assert "список файлов сборщика = PATCH_FILE_ALLOW в patch.sh (оба - compose.project.yml)" \
  "[[ \"\$(grep -m1 '^DEPLOY_FILES=(' '$SCRIPT' | sed 's/.*(\\(.*\\)).*/\\1/')\" \
     == \"\$(grep -m1 '^PATCH_FILE_ALLOW=(' '$PATCH_SH' | sed 's/.*(\\(.*\\)).*/\\1/')\" \
     && \"\$(grep -m1 '^DEPLOY_FILES=(' '$SCRIPT' | sed 's/.*(\\(.*\\)).*/\\1/')\" \
     == 'compose.project.yml' ]]"
assert "в сборщике нет sudo и rm с масками" \
  "! grep -vE '^[[:space:]]*#' '$SCRIPT' | grep -qE '\\bsudo\\b|\\brm +-[a-z]* *[^ ]*[*]'"
assert "в сборщике нет предмета G8x и G9p (patch-8x, patch-9p, pypdf, impress)" \
  "! grep -qiE 'patch-8x|patch8x|patch-9p|patch9p|pypdf|impress' '$SCRIPT'"

echo "проверок: $((PASS + FAIL)), провалено: $FAIL"
[[ "$FAIL" -eq 0 ]]
