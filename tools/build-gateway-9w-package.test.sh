#!/usr/bin/env bash
# Тест tools/build-gateway-9w-package.sh на временных git-репозиториях (Docker не нужен): состав
# пакета из тега платформы (без тестов и лишнего), update-guard.sh из HEAD проекта, манифест,
# VERSION, воспроизводимость архива и права, отказы (нет тега, не та библиотека, чужие хеши и
# лишние файлы вендора, COPY без источника). Если рядом есть настоящий репозиторий платформы с
# тегом v1.1.12, проверяется и сборка из него.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${BUILDGW9W_SCRIPT:-$HERE/build-gateway-9w-package.sh}"
REAL_PLATFORM="${PLATFORM_REPO:-$HOME/agent-platform-template}"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP:?}"' EXIT
PASS=0
FAIL=0
LIMIT=100
TAG="v1.1.12"

ok() { PASS=$((PASS + 1)); echo "PASS $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL $1"; }
assert() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
git_in() {
  local repo="$1"
  shift
  git -C "$repo" -c user.name=t -c user.email=t@example.test "$@"
}

PROJECT="$TMP/project"
PLATFORM="$TMP/platform"
OUT="$TMP/out.tgz"
CODE=0
OUTPUT=""

# Строка «  sha256  путь» для списка файлов VERSION вендора.
vendor_version() {
  local vendor="$PLATFORM/vendor/labops-pii" tag="${1:-v1.3.0}" file
  {
    echo "ref: $tag"
    echo "tag: $tag"
    echo "commit: 0123456789abcdef0123456789abcdef01234567"
    echo "files:"
    for file in LICENSE labops_pii/__init__.py labops_pii/guard/proxy.py ts/index.ts; do
      echo "  $(sha256sum <"$vendor/$file" | cut -d' ' -f1)  $file"
    done
  } >"$vendor/VERSION"
}

fresh() {
  rm -rf "${PROJECT:?}" "${PLATFORM:?}" "${OUT:?}"
  mkdir -p "$PROJECT/tools" "$PROJECT/deploy/patch-9w/gateway" \
    "$PLATFORM/gateway/pii-guard/agentplatform_guard" "$PLATFORM/gateway/pii-guard/tests" \
    "$PLATFORM/vendor/labops-pii/labops_pii/guard" "$PLATFORM/vendor/labops-pii/ts" \
    "$PLATFORM/deploy/docker"
  cp "$SCRIPT" "$PROJECT/tools/build-gateway-9w-package.sh"
  printf '#!/usr/bin/env bash\necho из HEAD\n' \
    >"$PROJECT/deploy/patch-9w/gateway/update-guard.sh"
  git_in "$PROJECT" init -q
  git_in "$PROJECT" add -A
  git_in "$PROJECT" commit -q -m project
  local guard="$PLATFORM/gateway/pii-guard"
  cat >"$guard/Dockerfile" <<'EOF'
FROM python:3.12.7-slim-bookworm
COPY gateway/pii-guard/requirements.txt gateway/pii-guard/constraints.txt ./
COPY vendor/labops-pii/labops_pii ./labops_pii
COPY gateway/pii-guard/agentplatform_guard ./agentplatform_guard
COPY deploy/docker/config-env.sh /usr/local/bin/config-env.sh
EOF
  echo '*' >"$guard/Dockerfile.dockerignore"
  echo 'fastapi' >"$guard/requirements.txt"
  echo 'fastapi==1' >"$guard/constraints.txt"
  echo 'pytest' >"$guard/requirements-dev.txt"
  echo 'readme' >"$guard/README.md"
  echo 'app = 1' >"$guard/agentplatform_guard/app.py"
  echo 'def test_x(): pass' >"$guard/tests/test_x.py"
  echo 'license' >"$PLATFORM/vendor/labops-pii/LICENSE"
  echo '__version__ = "1.3.0"' >"$PLATFORM/vendor/labops-pii/labops_pii/__init__.py"
  echo 'proxy = 1' >"$PLATFORM/vendor/labops-pii/labops_pii/guard/proxy.py"
  echo 'export {}' >"$PLATFORM/vendor/labops-pii/ts/index.ts"
  echo '#!/bin/sh' >"$PLATFORM/deploy/docker/config-env.sh"
  echo 'SECRET=1' >"$PLATFORM/deploy/docker/.env"
  vendor_version
  git_in "$PLATFORM" init -q
}

tag_platform() {
  git_in "$PLATFORM" add -A -f
  git_in "$PLATFORM" commit -q -m platform
  git_in "$PLATFORM" tag -f "$TAG" >/dev/null
}

build() {
  CODE=0
  OUTPUT="$(bash "$PROJECT/tools/build-gateway-9w-package.sh" --platform-repo "$PLATFORM" \
    --out "$OUT" "$@" 2>&1)" || CODE=$?
}

unpack() {
  rm -rf "${TMP:?}/unpacked"
  mkdir -p "$TMP/unpacked"
  tar -xzf "$OUT" -C "$TMP/unpacked"
}

refused() {
  local name="$1" pattern="$2"
  shift 2
  build "$@"
  assert "отказ $name: код 1 (получен $CODE)" "[[ $CODE == 1 ]]"
  assert "отказ $name: причина «$pattern»" "grep -qF -- \"\$pattern\" <<<\"\$OUTPUT\""
  assert "отказ $name: архив не создан" "[[ ! -e \"$OUT\" ]]"
}

echo "== статические проверки"
assert "скрипт разбирается bash" "bash -n \"$SCRIPT\""
assert "строки не длиннее $LIMIT" \
  "[[ -z \"\$(LC_ALL=C.UTF-8 awk 'length > $LIMIT' \"$SCRIPT\")\" ]]"

echo "== состав пакета"
fresh
tag_platform
# Правки после тега и незакоммиченный скрипт проекта в пакет не попадают
echo 'app = 2' >"$PLATFORM/gateway/pii-guard/agentplatform_guard/app.py"
echo 'незакоммиченное' >>"$PROJECT/deploy/patch-9w/gateway/update-guard.sh"
build
assert "сборка: код 0 (получен $CODE)" "[[ $CODE == 0 ]]"
[[ $CODE == 0 ]] || echo "$OUTPUT"
unpack
PKG="$TMP/unpacked/gateway-9w"
expected="MANIFEST.sha256
VERSION
platform/deploy/docker/config-env.sh
platform/gateway/pii-guard/Dockerfile
platform/gateway/pii-guard/Dockerfile.dockerignore
platform/gateway/pii-guard/agentplatform_guard/app.py
platform/gateway/pii-guard/constraints.txt
platform/gateway/pii-guard/requirements.txt
platform/vendor/labops-pii/LICENSE
platform/vendor/labops-pii/VERSION
platform/vendor/labops-pii/labops_pii/__init__.py
platform/vendor/labops-pii/labops_pii/guard/proxy.py
update-guard.sh"
actual="$(cd "$PKG" && find . -type f | sed 's|^\./||' | LC_ALL=C sort)"
assert "состав ровно ожидаемый (без тестов, README, ts и .env)" \
  "[[ \"\$actual\" == \"\$expected\" ]]"
assert "манифест сходится" "(cd \"$PKG\" && sha256sum --quiet -c MANIFEST.sha256)"
assert "манифест покрывает все файлы" \
  "[[ \$(wc -l <\"$PKG/MANIFEST.sha256\") == \$((\$(wc -l <<<\"\$actual\") - 1)) ]]"
assert "код платформы взят из тега, а не из рабочей копии" \
  "grep -qx 'app = 1' \"$PKG/platform/gateway/pii-guard/agentplatform_guard/app.py\""
assert "update-guard.sh из HEAD, исполняемый" \
  "! grep -q 'незакоммиченное' \"$PKG/update-guard.sh\" && [[ -x \"$PKG/update-guard.sh\" ]]"
assert "VERSION: тег, коммиты платформы и библиотеки, источник скрипта" \
  "grep -qx 'platform_tag=$TAG' \"$PKG/VERSION\" &&
   grep -qx \"platform_commit=\$(git -C \"$PLATFORM\" rev-parse $TAG)\" \"$PKG/VERSION\" &&
   grep -qx 'library_commit=0123456789abcdef0123456789abcdef01234567' \"$PKG/VERSION\" &&
   grep -qx \"script_source=проект \$(git -C \"$PROJECT\" rev-parse HEAD)\" \"$PKG/VERSION\""
assert "архив с правами 600" "[[ \$(stat -c %a \"$OUT\") == 600 ]]"
first="$(sha256sum <"$OUT")"
command sleep 1
build
assert "повторная сборка даёт тот же архив" "[[ \"\$(sha256sum <\"$OUT\")\" == \"\$first\" ]]"
build --script "$PROJECT/deploy/patch-9w/gateway/update-guard.sh"
unpack
assert "--script берёт указанный файл и помечает это в VERSION" \
  "grep -q 'незакоммиченное' \"$PKG/update-guard.sh\" &&
   grep -qx 'script_source=файл update-guard.sh' \"$PKG/VERSION\""

echo "== отказы"
fresh; tag_platform
refused "нет тега" 'нет тега v9.9.9' --tag v9.9.9
fresh; vendor_version v1.2.0; tag_platform
refused "не та библиотека" 'не labops-pii v1.3.0'
fresh; echo 'x' >>"$PLATFORM/vendor/labops-pii/labops_pii/guard/proxy.py"; tag_platform
refused "хеш вендора" 'не совпадают с VERSION'
fresh; echo 'x' >"$PLATFORM/vendor/labops-pii/labops_pii/extra.py"; tag_platform
refused "лишний файл вендора" 'вне списка VERSION'
fresh; sed -i '/COPY deploy/a COPY gateway/pii-guard/missing.py ./' \
  "$PLATFORM/gateway/pii-guard/Dockerfile"; tag_platform
refused "COPY без источника" 'копирует gateway/pii-guard/missing.py'
fresh; echo 'COPY --from=x /a /b' >>"$PLATFORM/gateway/pii-guard/Dockerfile"; tag_platform
refused "COPY с параметрами" 'COPY с параметрами'
fresh; rm "$PLATFORM/deploy/docker/config-env.sh"; tag_platform
refused "нет файла в теге" 'нет нужных файлов'
fresh; tag_platform; git_in "$PROJECT" rm -q deploy/patch-9w/gateway/update-guard.sh
git_in "$PROJECT" commit -q -m drop
refused "нет скрипта в HEAD" 'сначала коммит'
fresh; tag_platform; printf 'if\n' >"$TMP/broken.sh"
refused "скрипт с ошибкой синтаксиса" 'не разбирается' --script "$TMP/broken.sh"
build --unknown
assert "неизвестный параметр: код 2" "[[ $CODE == 2 ]]"
build --out
assert "параметр без значения: код 2" "[[ $CODE == 2 ]]"

if git -C "$REAL_PLATFORM" rev-parse -q --verify "refs/tags/$TAG" >/dev/null 2>&1; then
  echo "== настоящий репозиторий платформы"
  rm -f "${OUT:?}"
  CODE=0
  OUTPUT="$(bash "$SCRIPT" --platform-repo "$REAL_PLATFORM" --out "$OUT" \
    --script "$HERE/../deploy/patch-9w/gateway/update-guard.sh" 2>&1)" || CODE=$?
  assert "сборка из $TAG: код 0 (получен $CODE)" "[[ $CODE == 0 ]]"
  unpack
  assert "настоящий пакет: манифест сходится" \
    "(cd \"$PKG\" && sha256sum --quiet -c MANIFEST.sha256)"
  assert "настоящий пакет: нет тестов, .env и кэшей" \
    "[[ -z \"\$(find \"$PKG\" -name tests -o -name '*.env*' -o -name __pycache__)\" ]]"
  assert "настоящий пакет: надстройка и вход config-env" \
    "[[ -f \"$PKG/platform/gateway/pii-guard/agentplatform_guard/app.py\" &&
        -f \"$PKG/platform/deploy/docker/config-env.sh\" ]]"
else
  echo "ПРОПУСК: нет репозитория платформы с тегом $TAG"
fi

echo "--- итог: проверок $((PASS + FAIL)), провалов $FAIL"
((FAIL == 0))
