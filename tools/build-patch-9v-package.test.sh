#!/usr/bin/env bash
# Тест tools/build-patch-9v-package.sh: состав пакета G9q4 (из файлов deploy/ ровно
# compose.project.yml и копия платформы platform/compose.base.yml + platform/PLATFORM-VERSION,
# плюс enable-flags.sh), манифест, запрет секретов и db, проверка подтверждения подписей
# (обязательно, если дано; необязательно, если не дано), проверка версии lock
# 1.1.11-pragmatika.1 и образов app и documents по digest, сравнение с lock боя после G9s
# (--prev-lock: BAI_VERSION 1.1.10-pragmatika.2, версия, оба образа проекта и ключи платформы -
# основы app и documents, speech; образы app и documents обязаны смениться), сравнение с lock
# выпуска платформы (--platform-lock), проверка копии платформы (версия 1.1.11, сумма
# compose.base.yml, новая переменная VISION_TEXT_FIRST), флагов с умолчанием true (G9q и новый
# PRICES_SCAN_FLOW_ENABLED) и переменных G9s (CHAT_ATTACHMENTS_* со своими умолчаниями) в
# compose.project.yml, переменных Яндекса и флагов documents в обоих файлах compose, маршрута
# documents POST /docx/pages в routes.tsv, архив, права и строгое соответствие списка файлов
# patch.sh. Docker не нужен.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${BUILD9V_SCRIPT:-$HERE/build-patch-9v-package.sh}"
PATCH_SH="$HERE/../deploy/patch-9v/patch.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP:?}"' EXIT
PASS=0
FAIL=0
LIMIT=100
LOCK_VERSION="1.1.11-pragmatika.1"
DIGEST_A="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
DIGEST_B="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
DIGEST_M="eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
DIGEST_D="dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
DIGEST_S="cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
DIGEST_X="1111111111111111111111111111111111111111111111111111111111111111"

ok() { PASS=$((PASS + 1)); echo "PASS $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL $1"; }
assert() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
commit() { git -C "$REPO" add -A -f && git -C "$REPO" -c user.name=t -c user.email=t@example.test \
  commit -q -m "$1"; }
# Строка суммы compose.base.yml в PLATFORM-VERSION пересчитывается после правки файла.
fix_sum() { # fix_sum [версия]
  printf 'PLATFORM_PACKAGES_VERSION=%s\nsha256 %s  compose.base.yml\n' "${1:-1.1.11}" \
    "$(sha256sum <"$REPO/deploy/platform/compose.base.yml" | cut -d' ' -f1)" \
    >"$REPO/deploy/platform/PLATFORM-VERSION"
}

# Временный git-репозиторий с минимальным составом проекта.
REPO="$TMP/repo"
mkdir -p "$REPO/deploy/cutover" "$REPO/deploy/patch-9v" "$REPO/deploy/platform" "$REPO/tools"
for f in compose.project.yml platform/compose.base.yml; do
  printf '# %s\nYANDEX_SEARCH_MAX_CONCURRENCY: 1\n' "$f" >"$REPO/deploy/$f"
  echo 'YANDEX_SEARCH_MIN_INTERVAL_MS: 1200' >>"$REPO/deploy/$f"
  printf 'DOCUMENTS_EDIT_PPTX: true\nDOCUMENTS_EDIT_PDF: true\n' >>"$REPO/deploy/$f"
  printf 'DOCUMENTS_PPT_CONVERT: true\nDOCUMENTS_EDIT_PDF_FALLBACK_FONT: false\n' \
    >>"$REPO/deploy/$f"
done
# Флаги app от G8z, G9p, G9q (уже на бою) и новый флаг сканов с умолчанием true: только в
# compose.project.yml.
FLAG_VARS=(SHORTLIST_PAGING_ENABLED SUPPLIER_DISCOVERY_ENABLED PRICE_EDIT_FIRST_ENABLED
  DOCX_PAGES_ENABLED PRICE_EDIT_DB_WRITE_ENABLED PRICE_EDIT_TEXT_BLOCKS_ENABLED
  EMPTY_REPLY_GUARD_ENABLED PRICE_FILE_ONCE_PER_TURN_ENABLED STEP_TEXT_SEPARATE_ENABLED
  PRICES_SCAN_FLOW_ENABLED)
for v in "${FLAG_VARS[@]}"; do
  printf '  %s: ${%s:-true}\n' "$v" "$v" >>"$REPO/deploy/compose.project.yml"
done
# Переменные G9s с умолчаниями (не только true): только в compose.project.yml.
G9S_VARS=(CHAT_ATTACHMENTS_STORE_ENABLED=true CHAT_ATTACHMENTS_RETENTION_DAYS=30
  CHAT_ATTACHMENTS_MAX_BYTES=3221225472)
for item in "${G9S_VARS[@]}"; do
  printf '  %s: ${%s:-%s}\n' "${item%%=*}" "${item%%=*}" "${item#*=}" \
    >>"$REPO/deploy/compose.project.yml"
done
# Переменные платформы: G9r (уже на бою) и новая слотов зрения 1.1.11 - только в копии платформы.
printf '  DOCUMENTS_EDIT_PDF_TEXT: ${DOCUMENTS_EDIT_PDF_TEXT:-}\n' \
  >>"$REPO/deploy/platform/compose.base.yml"
printf '  B24_CALL_RECORDING_MAX_BYTES: ${B24_CALL_RECORDING_MAX_BYTES:-104857600}\n' \
  >>"$REPO/deploy/platform/compose.base.yml"
printf '  VISION_TEXT_FIRST: ${VISION_TEXT_FIRST:-true}\n' \
  >>"$REPO/deploy/platform/compose.base.yml"
fix_sum
# Файлы дерева, которых в пакете G9q4 быть не должно (кроме трёх разрешённых).
for f in compose.yml compat.env; do echo "# $f" >"$REPO/deploy/$f"; done
printf '#!/usr/bin/env bash\n' >"$REPO/deploy/patch-9v/patch.sh"
printf '#!/usr/bin/env bash\n' >"$REPO/deploy/patch-9v/enable-flags.sh"
printf '#!/usr/bin/env bash\n' >"$REPO/deploy/patch-9v/smoke_contract.py"
for f in lib.sh verify-signatures.sh; do
  printf '#!/usr/bin/env bash\n' >"$REPO/deploy/cutover/$f"
done
for f in check-routes.sh check-image-routes.sh route-flags.tsv; do
  echo "# $f" >"$REPO/tools/$f"
done
printf 'documents\tPOST\t/parse\troute\ndocuments\tPOST\t/docx/pages\troute\n' \
  >"$REPO/deploy/cutover/routes.tsv"
git -C "$REPO" init -q
commit init

printf 'BAI_VERSION=%s\nBAI_IMAGE_APP=r/app@sha256:%s\nBAI_IMAGE_MASK=r/mask@sha256:%s\n' \
  "$LOCK_VERSION" "$DIGEST_A" "$DIGEST_M" >"$TMP/images.lock"
printf 'BAI_IMAGE_DOCUMENTS=r/documents@sha256:%s\n' "$DIGEST_D" >>"$TMP/images.lock"
printf 'BAI_IMAGE_APP_BASE=r/app-base@sha256:%s\n' "$DIGEST_A" >>"$TMP/images.lock"
printf 'BAI_IMAGE_DOCUMENTS_BASE=r/bai-documents@sha256:%s\n' "$DIGEST_D" >>"$TMP/images.lock"
printf 'BAI_IMAGE_SPEECH=r/speech@sha256:%s\n' "$DIGEST_S" >>"$TMP/images.lock"
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
  tools/route-flags.tsv deploy/compose.project.yml deploy/platform/compose.base.yml \
  deploy/platform/PLATFORM-VERSION; do
  assert "в пакете есть $f" "[[ -f '$OUT/$f' ]]"
done
assert "из файлов deploy/ в пакете ровно три разрешённых" \
  "[[ \"\$(cd '$OUT' && find deploy -type f | LC_ALL=C sort | tr '\n' ' ')\" == \
   'deploy/compose.project.yml deploy/platform/PLATFORM-VERSION \
deploy/platform/compose.base.yml ' ]]"
assert "файлы deploy в пакете - копии из HEAD, байт в байт" \
  "git -C '$REPO' show HEAD:deploy/compose.project.yml \
   | cmp -s - '$OUT/deploy/compose.project.yml' \
   && git -C '$REPO' show HEAD:deploy/platform/compose.base.yml \
   | cmp -s - '$OUT/deploy/platform/compose.base.yml' \
   && git -C '$REPO' show HEAD:deploy/platform/PLATFORM-VERSION \
   | cmp -s - '$OUT/deploy/platform/PLATFORM-VERSION'"
assert "копия платформы в пакете: версия 1.1.11 и переменная VISION_TEXT_FIRST" \
  "grep -qx 'PLATFORM_PACKAGES_VERSION=1.1.11' '$OUT/deploy/platform/PLATFORM-VERSION' \
   && grep -q 'VISION_TEXT_FIRST' '$OUT/deploy/platform/compose.base.yml'"
assert "compose.project.yml в пакете: флаг сканов и переменные G9s на месте" \
  "grep -q 'PRICES_SCAN_FLOW_ENABLED: \${PRICES_SCAN_FLOW_ENABLED:-true}' \
   '$OUT/deploy/compose.project.yml' \
   && grep -q 'CHAT_ATTACHMENTS_RETENTION_DAYS:-30' '$OUT/deploy/compose.project.yml'"
assert "routes.tsv в пакете содержит маршрут documents POST /docx/pages" \
  "grep -qxF \$'documents\tPOST\t/docx/pages\troute' '$OUT/routes.tsv'"
for f in smoke_contract.py tools/check-image-routes.sh compose.yml compat.env deploy/compose.yml \
  deploy/images.lock deploy/compat.env; do
  assert "в пакете G9q4 нет $f" "[[ ! -e '$OUT/$f' ]]"
done
PKG_LIST="$(cd "$OUT" && find . -type f | sed 's|^\./||' | LC_ALL=C sort | tr '\n' ' ')"
PKG_WANT="MANIFEST.sha256 OWNER-RUNBOOK.md cosign.pub deploy/compose.project.yml "
PKG_WANT+="deploy/platform/PLATFORM-VERSION deploy/platform/compose.base.yml enable-flags.sh "
PKG_WANT+="images.lock lib.sh patch.sh routes.tsv signatures.txt tools/check-routes.sh "
PKG_WANT+="tools/route-flags.tsv verify-signatures.sh "
assert "состав пакета - ровно ожидаемые файлы" "[[ '$PKG_LIST' == '$PKG_WANT' ]]"
assert "скрипты исполняемые (patch.sh, enable-flags.sh, verify-signatures.sh, check-routes.sh)" \
  "[[ -x '$OUT/patch.sh' && -x '$OUT/enable-flags.sh' && -x '$OUT/verify-signatures.sh' \
   && -x '$OUT/tools/check-routes.sh' ]]"
assert "обычные файлы 644, каталоги 755" \
  "[[ \$(stat -c %a '$OUT/images.lock') == 644 && \$(stat -c %a '$OUT/tools') == 755 \
   && \$(stat -c %a '$OUT/deploy/platform/compose.base.yml') == 644 \
   && \$(stat -c %a '$OUT/deploy/platform') == 755 && \$(stat -c %a '$OUT/deploy') == 755 ]]"
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
echo "# локальная правка" >>"$REPO/deploy/patch-9v/patch.sh"
rm -rf "${TMP:?}/pkg2"
run --out "$TMP/pkg2" >"$TMP/out2.log" 2>&1
assert "незакоммиченная правка не попала в пакет" "! grep -q 'локальная' '$TMP/pkg2/patch.sh'"
assert "незакоммиченная правка: предупреждение в выводе" "grep -q 'незакоммиченные' '$TMP/out2.log'"
git -C "$REPO" checkout -q -- deploy/patch-9v/patch.sh

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
    fix_sum
    commit "без переменной $var в $target"
    rc=0
    run --out "$TMP/pkg-novar" >"$TMP/out-novar.log" 2>&1 || rc=$?
    assert "в $target нет $var - отказ" "[[ $rc -eq 1 ]]"
    assert "отказ называет переменную $var" "grep -q '$var' '$TMP/out-novar.log'"
    git -C "$REPO" reset -q --hard HEAD~1
    rm -rf "${TMP:?}/pkg-novar"
  done
done
# Переменных app нет в compose.project.yml, или умолчание не true - отказ; причина называет
# переменную (пакет заменяет файл целиком, флаги G8z, G9p, G9q и сканов обязаны быть).
for var in "${FLAG_VARS[@]}"; do
  sed -i "/$var:/d" "$REPO/deploy/compose.project.yml"
  commit "без переменной $var"
  rc=0
  run --out "$TMP/pkg-nonew" >"$TMP/out-nonew.log" 2>&1 || rc=$?
  assert "в compose.project.yml нет $var - отказ" "[[ $rc -eq 1 ]]"
  assert "отказ называет переменную $var" "grep -q '$var' '$TMP/out-nonew.log'"
  git -C "$REPO" reset -q --hard HEAD~1
  rm -rf "${TMP:?}/pkg-nonew"
  sed -i "s|$var:-true|$var:-false|" "$REPO/deploy/compose.project.yml"
  commit "умолчание $var false"
  rc=0
  run --out "$TMP/pkg-nonew" >"$TMP/out-nonew.log" 2>&1 || rc=$?
  assert "умолчание $var не true (false) - отказ" "[[ $rc -eq 1 ]]"
  assert "отказ называет требуемое умолчание true" "grep -q ':-true' '$TMP/out-nonew.log'"
  assert "отказ про умолчание называет $var" "grep -q '$var' '$TMP/out-nonew.log'"
  git -C "$REPO" reset -q --hard HEAD~1
  rm -rf "${TMP:?}/pkg-nonew"
done
# Переменных G9s нет в compose.project.yml или умолчание иное - отказ (замена файла потеряла бы их).
for item in "${G9S_VARS[@]}"; do
  var="${item%%=*}"
  sed -i "/$var:/d" "$REPO/deploy/compose.project.yml"
  commit "без переменной G9s $var"
  rc=0
  run --out "$TMP/pkg-nog9s" >"$TMP/out-nog9s.log" 2>&1 || rc=$?
  assert "в compose.project.yml нет переменной G9s $var - отказ" "[[ $rc -eq 1 ]]"
  assert "отказ называет переменную G9s $var и G9s" \
    "grep -q '$var' '$TMP/out-nog9s.log' && grep -q 'G9s' '$TMP/out-nog9s.log'"
  git -C "$REPO" reset -q --hard HEAD~1
  rm -rf "${TMP:?}/pkg-nog9s"
  sed -i "s|$var:-${item#*=}|$var:-0|" "$REPO/deploy/compose.project.yml"
  commit "умолчание G9s $var иное"
  rc=0
  run --out "$TMP/pkg-nog9s" >"$TMP/out-nog9s.log" 2>&1 || rc=$?
  assert "умолчание переменной G9s $var иное - отказ" "[[ $rc -eq 1 ]]"
  git -C "$REPO" reset -q --hard HEAD~1
  rm -rf "${TMP:?}/pkg-nog9s"
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

# Копия платформы: версия не 1.1.11 - отказ; файла нет - отказ; сумма compose.base.yml не сходится
# с PLATFORM-VERSION - отказ; нет новой переменной платформы VISION_TEXT_FIRST - отказ.
fix_sum 1.1.6
commit "платформа 1.1.6"
rc=0
run --out "$TMP/pkg-oldver" >"$TMP/out-oldver.log" 2>&1 || rc=$?
assert "PLATFORM-VERSION не 1.1.11 - отказ" "[[ $rc -eq 1 ]]"
assert "отказ называет версию 1.1.11" "grep -q '1.1.11' '$TMP/out-oldver.log'"
git -C "$REPO" reset -q --hard HEAD~1
fix_sum 1.1.10
commit "платформа 1.1.10 (копия боя)"
rc=0
run --out "$TMP/pkg-oldver2" >"$TMP/out-oldver2.log" 2>&1 || rc=$?
assert "PLATFORM-VERSION 1.1.10 (копия боя, не новая) - отказ" "[[ $rc -eq 1 ]]"
git -C "$REPO" reset -q --hard HEAD~1
git -C "$REPO" rm -q -f deploy/platform/PLATFORM-VERSION
git -C "$REPO" -c user.name=t -c user.email=t@example.test commit -q -m "нет PLATFORM-VERSION"
rc=0
run --out "$TMP/pkg-nover" >"$TMP/out-nover.log" 2>&1 || rc=$?
assert "в HEAD нет PLATFORM-VERSION - отказ" "[[ $rc -eq 1 ]]"
git -C "$REPO" reset -q --hard HEAD~1
git -C "$REPO" rm -q -f deploy/platform/compose.base.yml
git -C "$REPO" -c user.name=t -c user.email=t@example.test commit -q -m "нет compose.base.yml"
rc=0
run --out "$TMP/pkg-nobase" >"$TMP/out-nobase.log" 2>&1 || rc=$?
assert "в HEAD нет compose.base.yml - отказ" "[[ $rc -eq 1 ]]"
git -C "$REPO" reset -q --hard HEAD~1
echo "# правка руками" >>"$REPO/deploy/platform/compose.base.yml"
commit "compose.base.yml правлен без пересчёта суммы"
rc=0
run --out "$TMP/pkg-sum" >"$TMP/out-sum.log" 2>&1 || rc=$?
assert "сумма compose.base.yml не сходится с PLATFORM-VERSION - отказ" "[[ $rc -eq 1 ]]"
assert "отказ называет PLATFORM-VERSION" "grep -q 'PLATFORM-VERSION' '$TMP/out-sum.log'"
git -C "$REPO" reset -q --hard HEAD~1
for var in VISION_TEXT_FIRST; do
  sed -i "/$var/d" "$REPO/deploy/platform/compose.base.yml"
  fix_sum
  commit "без новой переменной платформы $var"
  rc=0
  run --out "$TMP/pkg-nonewvar" >"$TMP/out-nonewvar.log" 2>&1 || rc=$?
  assert "в compose.base.yml нет $var - отказ" "[[ $rc -eq 1 ]]"
  assert "отказ называет переменную платформы $var" "grep -q '$var' '$TMP/out-nonewvar.log'"
  git -C "$REPO" reset -q --hard HEAD~1
  rm -rf "${TMP:?}/pkg-nonewvar"
done

# Отказы по lock: версия не 1.1.11-pragmatika.1, нет app/documents/mask по digest.
cp "$TMP/images.lock" "$TMP/images.keep"
for ver in 1.1.10-pragmatika.1 1.1.10-pragmatika.2 1.1.11 1.1.11-pragmatika.2; do
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

# --prev-lock: lock боя после G9s; новый lock отличается только версией, образами app и
# documents (обязаны смениться) и ключами платформы: основы app и documents, speech.
sed -e "s|^BAI_VERSION=.*|BAI_VERSION=1.1.10-pragmatika.2|" \
  -e "s|^BAI_IMAGE_APP=.*|BAI_IMAGE_APP=r/app@sha256:$DIGEST_B|" \
  -e "s|^BAI_IMAGE_DOCUMENTS=.*|BAI_IMAGE_DOCUMENTS=r/documents@sha256:$DIGEST_B|" \
  -e "s|^BAI_IMAGE_APP_BASE=.*|BAI_IMAGE_APP_BASE=r/app-base@sha256:$DIGEST_B|" \
  -e "s|^BAI_IMAGE_DOCUMENTS_BASE=.*|BAI_IMAGE_DOCUMENTS_BASE=r/bai-documents@sha256:$DIGEST_B|" \
  -e "s|^BAI_IMAGE_SPEECH=.*|BAI_IMAGE_SPEECH=r/speech@sha256:$DIGEST_B|" \
  "$TMP/images.keep" >"$TMP/prev.lock"
rc=0
run --out "$TMP/pkg-prev" --prev-lock "$TMP/prev.lock" >"$TMP/out-prev.log" 2>&1 || rc=$?
assert "--prev-lock: отличаются версия, оба образа и ключи платформы - сборка проходит" \
  "[[ $rc -eq 0 && -f '$TMP/pkg-prev/patch.sh' ]]"
# Основы и speech у боя уже равны новым (платформа их не меняла): допустимо.
sed -e "s|^BAI_IMAGE_APP_BASE=.*|BAI_IMAGE_APP_BASE=r/app-base@sha256:$DIGEST_A|" \
  -e "s|^BAI_IMAGE_DOCUMENTS_BASE=.*|BAI_IMAGE_DOCUMENTS_BASE=r/bai-documents@sha256:$DIGEST_D|" \
  -e "s|^BAI_IMAGE_SPEECH=.*|BAI_IMAGE_SPEECH=r/speech@sha256:$DIGEST_S|" \
  "$TMP/prev.lock" >"$TMP/prev-same-bases.lock"
rc=0
run --out "$TMP/pkg-prev0" --prev-lock "$TMP/prev-same-bases.lock" >"$TMP/out-prev0.log" 2>&1 \
  || rc=$?
assert "--prev-lock: основы и speech не менялись - сборка проходит" "[[ $rc -eq 0 ]]"
# Lock боя не после G9s (версия 1.1.10-pragmatika.1, то есть только G9r): отказ с подсказкой.
sed "s|^BAI_VERSION=.*|BAI_VERSION=1.1.10-pragmatika.1|" "$TMP/prev.lock" >"$TMP/prev-g9r.lock"
rc=0
run --out "$TMP/pkg-prevg9r" --prev-lock "$TMP/prev-g9r.lock" >"$TMP/out-prevg9r.log" 2>&1 || rc=$?
assert "--prev-lock: lock боя после G9r, а не G9s - отказ" \
  "[[ $rc -eq 1 && ! -e '$TMP/pkg-prevg9r/patch.sh' ]]"
assert "--prev-lock: отказ называет версию G9s и патч G9s" \
  "grep -q '1.1.10-pragmatika.2' '$TMP/out-prevg9r.log' && grep -q 'G9s' '$TMP/out-prevg9r.log'"
# Образ documents у боя уже равен новому: патчу его катить нечего - отказ.
sed "s|^BAI_IMAGE_DOCUMENTS=.*|BAI_IMAGE_DOCUMENTS=r/documents@sha256:$DIGEST_D|" "$TMP/prev.lock" \
  >"$TMP/prev-docs.lock"
rc=0
run --out "$TMP/pkg-prev2" --prev-lock "$TMP/prev-docs.lock" >"$TMP/out-prev2.log" 2>&1 || rc=$?
assert "--prev-lock: образ documents не меняется - отказ" \
  "[[ $rc -eq 1 && ! -e '$TMP/pkg-prev2/patch.sh' ]]"
assert "--prev-lock: отказ называет BAI_IMAGE_DOCUMENTS" \
  "grep -q 'BAI_IMAGE_DOCUMENTS' '$TMP/out-prev2.log'"
sed "s|^BAI_IMAGE_MASK=.*|BAI_IMAGE_MASK=r/mask@sha256:$DIGEST_A|" "$TMP/prev.lock" \
  >"$TMP/prev-mask.lock"
rc=0
run --out "$TMP/pkg-prev3" --prev-lock "$TMP/prev-mask.lock" >"$TMP/out-prev3.log" 2>&1 || rc=$?
assert "--prev-lock: образ mask отличается - отказ" "[[ $rc -eq 1 ]]"
assert "--prev-lock: отказ называет BAI_IMAGE_MASK" "grep -q 'BAI_IMAGE_MASK' '$TMP/out-prev3.log'"
sed "s|^BAI_VERSION=.*|BAI_VERSION=1.1.10-pragmatika.2|" "$TMP/images.keep" >"$TMP/prev-same.lock"
rc=0
run --out "$TMP/pkg-prev4" --prev-lock "$TMP/prev-same.lock" >"$TMP/out-prev4.log" 2>&1 || rc=$?
assert "--prev-lock: образы app и documents не меняются (катить нечего) - отказ" "[[ $rc -eq 1 ]]"
assert "--prev-lock: отказ называет BAI_IMAGE_APP" "grep -q 'BAI_IMAGE_APP' '$TMP/out-prev4.log'"
rc=0
run --out "$TMP/pkg-prev5" --prev-lock "$TMP/нет.lock" >"$TMP/out-prev5.log" 2>&1 || rc=$?
assert "--prev-lock: нет файла - код 2" "[[ $rc -eq 2 ]]"

# --platform-lock: образы платформы в lock проекта равны lock выпуска (основа app, образ
# documents выпуска = основа documents проекта, speech и прочие образы платформы).
{
  printf '# lock выпуска платформы\nBAI_VERSION=1.1.11\n'
  printf 'BAI_IMAGE_APP_BASE=r/app-base@sha256:%s\n' "$DIGEST_A"
  printf 'BAI_IMAGE_DOCUMENTS=r/bai-documents@sha256:%s\n' "$DIGEST_D"
  printf 'BAI_IMAGE_MASK=r/mask@sha256:%s\n' "$DIGEST_M"
  printf 'BAI_IMAGE_SPEECH=r/speech@sha256:%s\n' "$DIGEST_S"
} >"$TMP/release.lock"
rc=0
run --out "$TMP/pkg-rel" --platform-lock "$TMP/release.lock" >"$TMP/out-rel.log" 2>&1 || rc=$?
assert "--platform-lock: образы платформы равны выпуску - сборка проходит" "[[ $rc -eq 0 ]]"
for key in BAI_IMAGE_APP_BASE BAI_IMAGE_DOCUMENTS BAI_IMAGE_MASK BAI_IMAGE_SPEECH; do
  sed "s|^$key=.*|$key=r/x@sha256:$DIGEST_X|" "$TMP/release.lock" >"$TMP/release-bad.lock"
  rc=0
  run --out "$TMP/pkg-relbad" --platform-lock "$TMP/release-bad.lock" \
    >"$TMP/out-relbad.log" 2>&1 || rc=$?
  assert "--platform-lock: $key выпуска отличается - отказ" \
    "[[ $rc -eq 1 && ! -e '$TMP/pkg-relbad/patch.sh' ]]"
  want_key="$key"
  [[ "$key" != BAI_IMAGE_DOCUMENTS ]] || want_key=BAI_IMAGE_DOCUMENTS_BASE
  assert "--platform-lock: отказ называет $want_key" "grep -q '$want_key' '$TMP/out-relbad.log'"
  rm -rf "${TMP:?}/pkg-relbad"
done
rc=0
run --out "$TMP/pkg-rel2" --platform-lock "$TMP/нет.lock" >"$TMP/out-rel2.log" 2>&1 || rc=$?
assert "--platform-lock: нет файла - код 2" "[[ $rc -eq 2 ]]"

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
grep -v 'BAI_IMAGE_SPEECH\|BAI_IMAGE_MASK' "$TMP/signatures.good" >"$TMP/sigs.partial"
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

# Запрещённые файлы: .env в deploy, попавший в HEAD, в пакет не попадает (копируются только три
# разрешённых файла дерева).
printf 'x=1\n' >"$REPO/deploy/.env"
git -C "$REPO" add -f deploy/.env
git -C "$REPO" -c user.name=t -c user.email=t@example.test commit -q -m "env"
rc=0
run --out "$TMP/pkg-env" >"$TMP/out10.log" 2>&1 || rc=$?
assert "лишний .env в дереве не попадает в пакет (копируются только три файла)" \
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
assert "список файлов сборщика = PATCH_FILE_ALLOW в patch.sh (три файла)" \
  "[[ \"\$(grep -m1 '^DEPLOY_FILES=(' '$SCRIPT' | sed 's/.*(\\(.*\\)).*/\\1/')\" \
     == \"\$(grep -m1 '^PATCH_FILE_ALLOW=(' '$PATCH_SH' | sed 's/.*(\\(.*\\)).*/\\1/')\" \
     && \"\$(grep -m1 '^DEPLOY_FILES=(' '$SCRIPT' | sed 's/.*(\\(.*\\)).*/\\1/')\" \
     == 'compose.project.yml platform/compose.base.yml platform/PLATFORM-VERSION' ]]"
assert "в сборщике нет sudo и rm с масками" \
  "! grep -vE '^[[:space:]]*#' '$SCRIPT' | grep -qE '\\bsudo\\b|\\brm +-[a-z]* *[^ ]*[*]'"
assert "в сборщике нет предмета G8x и G8y (patch-8x, patch-8y, pypdf, impress)" \
  "! grep -qiE 'patch-8x|patch8x|patch-8y|patch8y|pypdf|impress' '$SCRIPT'"
assert "в сборщике нет следов других патчей (patch-9p, patch-9q, patch-9r, patch-9s)" \
  "! grep -qE 'patch-9[pqrs]|patch9[pqrs]' '$SCRIPT'"

echo "проверок: $((PASS + FAIL)), провалено: $FAIL"
[[ "$FAIL" -eq 0 ]]
