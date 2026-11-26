#!/usr/bin/env bash
# Сборка патч-пакета G9w (платформа 1.1.11 -> 1.1.12, labops-pii 1.3.0; меняются ЧЕТЫРЕ образа:
# pseudonymizer, mask, documents, app, оба образа проекта 1.1.12-pragmatika.1; из файлов дерева
# заменяются только images.lock и deploy/platform/PLATFORM-VERSION): каталог, который переносят на
# боевой хост и запускают там `bash patch.sh` (см. OWNER-RUNBOOK.md). Ставится строго после
# патча G9q4. Красная зона: запускает владелец.
#
# Использование:
#   bash tools/build-patch-9w-package.sh --out КАТАЛОГ --lock ФАЙЛ [--signatures ФАЙЛ]
#        [--prev-lock ФАЙЛ] [--platform-lock ФАЙЛ] [--cosign-pub ФАЙЛ] [--runbook ФАЙЛ]
#        [--gateway-package АРХИВ] [--tgz ФАЙЛ] [--help]
#   --lock             images.lock этапа pd (новый, образы по digest)
#   --prev-lock        lock боя после патча G9q4 (images.lock этапа 9v)
#   --platform-lock    lock выпуска платформы 1.1.12
#   --runbook          OWNER-RUNBOOK.md, кладётся в корень пакета как есть
#   --gateway-package  архив шага шлюза (.tgz), кладётся как gateway/gateway-9w.tgz
#
# Состав (копии закоммиченного дерева, git show HEAD; незакоммиченное не попадает):
#   patch.sh, lib.sh, verify-signatures.sh   сценарий патча и общие функции (deploy/patch-9w,
#                                            deploy/cutover)
#   transfer-images-9w.sh                    перенос образов с Fornex на бой (tools/)
#   tools/check-routes.sh, route-flags.tsv, routes.tsv   проверка маршрутов стека
#   deploy/platform/PLATFORM-VERSION         копия платформы 1.1.12: единственный файл дерева
#                                            помимо images.lock, который патч заменяет
#   reference/deploy/compose.yml, compat.env, compose.project.yml, platform/compose.base.yml
#                                            эталоны: patch.sh сверяет с ними боевые файлы и
#                                            НЕ заменяет их
#   images.lock, cosign.pub                  образы по digest и открытый ключ
#   signatures.txt                           подтверждение подписей (если дан --signatures; без
#                                            него на хосте нужен cosign)
#   OWNER-RUNBOOK.md                         инструкция владельцу (если дан --runbook)
#   gateway/gateway-9w.tgz                   шаг шлюза (если дан --gateway-package)
#   MANIFEST.sha256                          контрольные суммы всех файлов пакета
# Образы в пакет не входят: их переносит transfer-images-9w.sh. Секретов, .env и ключей в пакет не
# кладётся: проверяется перед записью манифеста (в том числе внутри архива шлюза). Миграций (db)
# в патче нет.
#
# Проверки сборки: lock содержит BAI_VERSION=1.1.12-pragmatika.1 и образы app, documents,
# pseudonymizer, mask, основу app по digest; с --prev-lock (BAI_VERSION 1.1.11-pragmatika.1, app и
# documents на digest, закреплённых в patch.sh) lock отличается от него ТОЛЬКО ключами
# BAI_VERSION, BAI_IMAGE_APP, BAI_IMAGE_APP_BASE, BAI_IMAGE_DOCUMENTS, BAI_IMAGE_DOCUMENTS_BASE,
# BAI_IMAGE_PSEUDONYMIZER, BAI_IMAGE_MASK, и четыре образа сменились; с --platform-lock
# (BAI_VERSION=1.1.12) основы app и documents и все прочие образы платформы равны значениям
# выпуска (BAI_IMAGE_DOCUMENTS_BASE равен BAI_IMAGE_DOCUMENTS выпуска); подтверждение подписей
# (если дано) относится к ЭТОМУ lock (sha256), этому ключу и покрывает все его образы. Копия
# платформы из HEAD: PLATFORM-VERSION - версия 1.1.12, сумма compose.base.yml равна строке в нём.
# С --tgz пакет упаковывается в архив (режим 600, корень patch-package/).
#
# Коды выхода: 0 - готово; 1 - ошибка сборки; 2 - неверный вызов.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${BAI_PROJECT_DIR:-$(cd "$HERE/.." && pwd)}"
EXIT_FAILED=1
EXIT_USAGE=2
SCRIPTS_PATCH=(patch.sh)
SCRIPTS_CUTOVER=(lib.sh verify-signatures.sh)
SCRIPTS_TOOLS=(transfer-images-9w.sh)
ROUTE_TOOLS=(check-routes.sh route-flags.tsv)
# ДОЛЖНЫ совпадать с PATCH_FILE_ALLOW и REFERENCE_FILES в patch.sh.
DEPLOY_FILES=(platform/PLATFORM-VERSION)
REFERENCE_FILES=(compose.yml compat.env compose.project.yml platform/compose.base.yml)
PAGES_ROUTE_ROW=$'documents\tPOST\t/docx/pages\troute'
GATEWAY_DIR="gateway"
GATEWAY_NAME="gateway-9w.tgz"
ALLOWED_LOCK_DIFF="BAI_VERSION BAI_IMAGE_APP BAI_IMAGE_APP_BASE BAI_IMAGE_DOCUMENTS"
ALLOWED_LOCK_DIFF+=" BAI_IMAGE_DOCUMENTS_BASE BAI_IMAGE_PSEUDONYMIZER BAI_IMAGE_MASK"
REQUIRED_LOCK_DIFF="BAI_IMAGE_APP BAI_IMAGE_DOCUMENTS BAI_IMAGE_PSEUDONYMIZER BAI_IMAGE_MASK"
LOCK_IMAGE_KEYS="BAI_IMAGE_APP BAI_IMAGE_APP_BASE BAI_IMAGE_DOCUMENTS BAI_IMAGE_PSEUDONYMIZER"
LOCK_IMAGE_KEYS+=" BAI_IMAGE_MASK"
# Образы платформы в lock проекта берутся из lock выпуска; у проектных образов образ платформы
# лежит в ключе-основе.
PLATFORM_LOCK_BASES="BAI_IMAGE_APP_BASE:BAI_IMAGE_APP_BASE"
PLATFORM_LOCK_BASES+=" BAI_IMAGE_DOCUMENTS_BASE:BAI_IMAGE_DOCUMENTS"
PROJECT_IMAGE_KEYS="BAI_IMAGE_APP BAI_IMAGE_DOCUMENTS BAI_IMAGE_APP_BASE BAI_IMAGE_DOCUMENTS_BASE"
PLATFORM_VERSION_FILE="platform/PLATFORM-VERSION"
PLATFORM_BASE_FILE="platform/compose.base.yml"
PLATFORM_VERSION="1.1.12"
TARGET_LOCK_VERSION="1.1.12-pragmatika.1"
PREV_LOCK_VERSION="1.1.11-pragmatika.1"
FORBIDDEN_RE='(^|/)(\.env|\.env\..*|secrets\.env|.*\.key|.*\.pem|.*\.bak.*)$'
ALLOWED_RE='(^|/)\.env\.example$'
SECRET_CONTENT_RE='^(-----BEGIN [A-Z ]*PRIVATE KEY-----|AGE-SECRET-KEY-)'
OUT=""
LOCK=""
SIGNATURES=""
PREV_LOCK=""
PLATFORM_LOCK=""
COSIGN_PUB="${BAI_SIGNING_PUBKEY:-$HOME/.config/bai-signing/cosign.pub}"
RUNBOOK=""
GATEWAY=""
TGZ=""

usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }
log() { echo "[build-patch-9w-package] $(date -u +%T) $*"; }
fail() { echo "[build-patch-9w-package] ОШИБКА: $*" >&2; exit "$EXIT_FAILED"; }

while (($#)); do
  case "$1" in
    --out) OUT="${2:?--out КАТАЛОГ}"; shift ;;
    --lock) LOCK="${2:?--lock ФАЙЛ}"; shift ;;
    --signatures) SIGNATURES="${2:?--signatures ФАЙЛ}"; shift ;;
    --prev-lock) PREV_LOCK="${2:?--prev-lock ФАЙЛ}"; shift ;;
    --platform-lock) PLATFORM_LOCK="${2:?--platform-lock ФАЙЛ}"; shift ;;
    --cosign-pub) COSIGN_PUB="${2:?--cosign-pub ФАЙЛ}"; shift ;;
    --runbook) RUNBOOK="${2:?--runbook ФАЙЛ}"; shift ;;
    --gateway-package) GATEWAY="${2:?--gateway-package АРХИВ}"; shift ;;
    --tgz) TGZ="${2:?--tgz ФАЙЛ}"; shift ;;
    --help | -h) usage; exit 0 ;;
    *) echo "неизвестный аргумент: $1" >&2; usage >&2; exit "$EXIT_USAGE" ;;
  esac
  shift
done
[[ -n "$OUT" && -n "$LOCK" ]] || { usage >&2; exit "$EXIT_USAGE"; }
for f in "$LOCK" "$COSIGN_PUB" ${SIGNATURES:+"$SIGNATURES"} ${PREV_LOCK:+"$PREV_LOCK"} \
  ${PLATFORM_LOCK:+"$PLATFORM_LOCK"} ${RUNBOOK:+"$RUNBOOK"} ${GATEWAY:+"$GATEWAY"}; do
  [[ -f "$f" ]] || { echo "нет файла $f" >&2; exit "$EXIT_USAGE"; }
done
if [[ -e "$OUT" ]] && [[ -n "$(ls -A "$OUT" 2>/dev/null)" ]]; then
  echo "каталог $OUT не пуст" >&2
  exit "$EXIT_USAGE"
fi

# Подтверждение подписей относится к этому lock, этому ключу и покрывает все образы lock.
if [[ -n "$SIGNATURES" ]]; then
  python3 -I - "$SIGNATURES" "$LOCK" "$COSIGN_PUB" <<'PY' \
    || fail "подтверждение подписей не подходит к lock"
import hashlib, re, sys
sig, lock, pub = sys.argv[1:4]
fields, images = {}, {}
for raw in open(sig, encoding="utf-8"):
    line = raw.rstrip("\n")
    if line.startswith("image\t"):
        parts = line.split("\t")
        images[parts[1]] = (parts[2], parts[3])
    elif "=" in line and not line.startswith("#"):
        key, value = line.split("=", 1)
        fields[key] = value
want = dict(
    line.split("=", 1) for line in open(lock, encoding="utf-8").read().splitlines()
    if re.match(r"^BAI_IMAGE_[A-Z0-9_]+=", line)
)
ok = (
    fields.get("result") == "OK"
    and fields.get("lock_sha256") == hashlib.sha256(open(lock, "rb").read()).hexdigest()
    and fields.get("pubkey_sha256") == hashlib.sha256(open(pub, "rb").read()).hexdigest()
    and set(images) == set(want)
    and all(images[k] == (v, "OK") for k, v in want.items())
)
sys.exit(0 if ok else 1)
PY
else
  log "ВНИМАНИЕ: --signatures не дан: signatures.txt в пакет не попадёт, на хосте нужен cosign"
fi
for key in $LOCK_IMAGE_KEYS; do
  grep -qE "^$key=[^@[:space:]]+@sha256:[0-9a-f]{64}\$" "$LOCK" \
    || fail "в $LOCK нет $key (образ по digest)"
done
grep -qx "BAI_VERSION=$TARGET_LOCK_VERSION" "$LOCK" \
  || fail "в $LOCK нет строки BAI_VERSION=$TARGET_LOCK_VERSION"

patch_sh="$(git -C "$ROOT" show HEAD:deploy/patch-9w/patch.sh)" \
  || fail "в HEAD нет deploy/patch-9w/patch.sh"
# Lock отличается от lock боя после G9q4 только ключами патча.
if [[ -n "$PREV_LOCK" ]]; then
  grep -qx "BAI_VERSION=$PREV_LOCK_VERSION" "$PREV_LOCK" \
    || fail "в $PREV_LOCK нет строки BAI_VERSION=$PREV_LOCK_VERSION (lock боя после патча G9q4)"
  for pair in FROM_APP_DIGEST:BAI_IMAGE_APP FROM_DOCS_DIGEST:BAI_IMAGE_DOCUMENTS; do
    digest="$(sed -n "s/^${pair%%:*}=\"\(sha256:[0-9a-f]*\)\"\$/\1/p" <<<"$patch_sh")"
    [[ -n "$digest" ]] || fail "в HEAD:deploy/patch-9w/patch.sh нет ${pair%%:*}"
    grep -qE "^${pair#*:}=[^@[:space:]]+@$digest\$" "$PREV_LOCK" \
      || fail "в $PREV_LOCK ${pair#*:} не на digest, закреплённом в patch.sh (${pair%%:*})"
  done
  diff_keys="$(python3 -I - "$PREV_LOCK" "$LOCK" <<'PY'
import sys

def read(path: str) -> dict[str, str]:
    pairs = (line.split("=", 1) for line in open(path, encoding="utf-8").read().splitlines()
             if line.startswith("BAI_") and "=" in line)
    return {key: value for key, value in pairs}

old, new = read(sys.argv[1]), read(sys.argv[2])
print(" ".join(sorted(k for k in set(old) | set(new) if old.get(k) != new.get(k))))
PY
)" || fail "не удалось сравнить $LOCK с $PREV_LOCK"
  for key in $diff_keys; do
    [[ " $ALLOWED_LOCK_DIFF " == *" $key "* ]] \
      || fail "$LOCK отличается от $PREV_LOCK по $key: разрешено только: $ALLOWED_LOCK_DIFF"
  done
  for key in $REQUIRED_LOCK_DIFF; do
    [[ " $diff_keys " == *" $key "* ]] \
      || fail "$LOCK не меняет $key относительно $PREV_LOCK: патч G9w катит четыре образа"
  done
fi

# Образы платформы в lock проекта равны значениям lock выпуска платформы.
if [[ -n "$PLATFORM_LOCK" ]]; then
  grep -qx "BAI_VERSION=$PLATFORM_VERSION" "$PLATFORM_LOCK" \
    || fail "$PLATFORM_LOCK не lock выпуска платформы $PLATFORM_VERSION"
  platform_diff="$(python3 -I - "$PLATFORM_LOCK" "$LOCK" "$PLATFORM_LOCK_BASES" \
    "$PROJECT_IMAGE_KEYS" <<'PY'
import sys

def read(path: str) -> dict[str, str]:
    pairs = (line.split("=", 1) for line in open(path, encoding="utf-8").read().splitlines()
             if line.startswith("BAI_IMAGE_") and "=" in line)
    return {key: value for key, value in pairs}

release, project = read(sys.argv[1]), read(sys.argv[2])
bases = dict(item.split(":") for item in sys.argv[3].split())
skip = set(sys.argv[4].split())
bad = []
for project_key, release_key in bases.items():
    if release_key not in release or project.get(project_key) != release[release_key]:
        bad.append(project_key)
for key, value in release.items():
    if key not in skip and project.get(key) != value:
        bad.append(key)
print(" ".join(sorted(bad)))
PY
)" || fail "не удалось сравнить $LOCK с $PLATFORM_LOCK"
  [[ -z "$platform_diff" ]] \
    || fail "$LOCK не равен lock выпуска платформы по: $platform_diff"
fi

REVISION="$(git -C "$ROOT" rev-parse --short=12 HEAD)"
if [[ -n "$(git -C "$ROOT" status --porcelain -- deploy tools 2>/dev/null)" ]]; then
  log "ВНИМАНИЕ: в deploy или tools есть незакоммиченные правки: в пакет они не попадут"
fi
mkdir -p "$OUT/tools"
show() { # show <путь в дереве> <куда>
  git -C "$ROOT" show "HEAD:$1" >"$2" || fail "в HEAD нет $1"
}
for f in "${SCRIPTS_PATCH[@]}"; do show "deploy/patch-9w/$f" "$OUT/$f"; done
for f in "${SCRIPTS_CUTOVER[@]}"; do show "deploy/cutover/$f" "$OUT/$f"; done
for f in "${SCRIPTS_TOOLS[@]}"; do show "tools/$f" "$OUT/$f"; done
chmod +x "$OUT/patch.sh" "$OUT/verify-signatures.sh" "$OUT/transfer-images-9w.sh"
for f in "${ROUTE_TOOLS[@]}"; do show "tools/$f" "$OUT/tools/$f"; done
chmod +x "$OUT/tools/check-routes.sh"
show deploy/cutover/routes.tsv "$OUT/routes.tsv"
grep -qxF "$PAGES_ROUTE_ROW" "$OUT/routes.tsv" \
  || fail "в HEAD:deploy/cutover/routes.tsv нет маршрута documents POST /docx/pages"
for f in "${DEPLOY_FILES[@]}"; do
  mkdir -p "$OUT/deploy/$(dirname "$f")"
  show "deploy/$f" "$OUT/deploy/$f"
done
for f in "${REFERENCE_FILES[@]}"; do
  mkdir -p "$OUT/reference/deploy/$(dirname "$f")"
  show "deploy/$f" "$OUT/reference/deploy/$f"
done
# Копия платформы: версия целевая, сумма compose.base.yml равна строке в PLATFORM-VERSION.
version_line="PLATFORM_PACKAGES_VERSION=$PLATFORM_VERSION"
grep -qx "$version_line" "$OUT/deploy/$PLATFORM_VERSION_FILE" \
  || fail "в HEAD:deploy/$PLATFORM_VERSION_FILE нет строки $version_line"
want_sum="$(awk '$1 == "sha256" && $3 == "compose.base.yml" { print $2 }' \
  "$OUT/deploy/$PLATFORM_VERSION_FILE")"
have_sum="$(sha256sum "$OUT/reference/deploy/$PLATFORM_BASE_FILE" | cut -d' ' -f1)"
[[ -n "$want_sum" && "$want_sum" == "$have_sum" ]] \
  || fail "в HEAD сумма deploy/$PLATFORM_BASE_FILE не сходится с $PLATFORM_VERSION_FILE"
cp "$LOCK" "$OUT/images.lock"
[[ -z "$SIGNATURES" ]] || cp "$SIGNATURES" "$OUT/signatures.txt"
cp "$COSIGN_PUB" "$OUT/cosign.pub"
[[ -z "$RUNBOOK" ]] || cp "$RUNBOOK" "$OUT/OWNER-RUNBOOK.md"
if [[ -n "$GATEWAY" ]]; then
  listing="$(tar -tzf "$GATEWAY")" || fail "архив шлюза $GATEWAY не читается как .tgz"
  [[ -n "$listing" ]] || fail "архив шлюза $GATEWAY пуст"
  bad="$(grep -E "$FORBIDDEN_RE" <<<"$listing" | grep -vE "$ALLOWED_RE" || true)"
  [[ -z "$bad" ]] || fail "в архиве шлюза запрещённые файлы: $(echo "$bad" | tr '\n' ' ')"
  # grep без -q: дочитывает поток, иначе pipefail принял бы обрыв tar за отсутствие находки.
  if tar -xzOf "$GATEWAY" | grep -aE "$SECRET_CONTENT_RE" >/dev/null; then
    fail "в архиве шлюза найдено закрытое ключевое содержимое"
  fi
  mkdir -p "$OUT/$GATEWAY_DIR"
  cp "$GATEWAY" "$OUT/$GATEWAY_DIR/$GATEWAY_NAME"
fi

bad="$(cd "$OUT" && find . -type f | sed 's|^\./||' \
  | grep -E "$FORBIDDEN_RE" | grep -vE "$ALLOWED_RE" || true)"
[[ -z "$bad" ]] || fail "в пакете запрещённые файлы: $(echo "$bad" | tr '\n' ' ')"
if grep -rIlE "$SECRET_CONTENT_RE" "$OUT" >/dev/null 2>&1; then
  fail "в пакете найдено закрытое ключевое содержимое"
fi
# Права как у обычной распаковки: файлы читаются всеми (секретов в пакете нет), скрипты
# исполняются.
find "$OUT" -type d -exec chmod 755 {} +
find "$OUT" -type f ! -perm -u+x -exec chmod 644 {} +
find "$OUT" -type f -perm -u+x -exec chmod 755 {} +
[[ ! -e "$OUT/db" && ! -e "$OUT/deploy/db" ]] \
  || fail "в патч-пакете не должно быть db (миграций у патча нет)"
# Из файлов дерева в пакете ровно разрешённые и эталоны (списки совпадают с patch.sh).
check_list() { # check_list <каталог пакета> <ожидаемые файлы...>
  local dir="$1" got want
  shift
  got="$(cd "$OUT/$dir" && find . -type f | sed 's|^\./||' | LC_ALL=C sort | tr '\n' ' ')"
  want="$(printf '%s\n' "$@" | LC_ALL=C sort | tr '\n' ' ')"
  [[ "$got" == "$want" ]] || fail "в пакете файлы $dir/ '$got', разрешено только '$want'"
}
check_list deploy "${DEPLOY_FILES[@]}"
check_list reference/deploy "${REFERENCE_FILES[@]}"

log "MANIFEST.sha256"
(cd "$OUT" && find . -type f ! -name MANIFEST.sha256 | sort | sed 's|^\./||' \
  | xargs -d '\n' sha256sum >MANIFEST.sha256)
chmod 644 "$OUT/MANIFEST.sha256"
if [[ -n "$TGZ" ]]; then
  parent="$(dirname "$(readlink -f "$OUT")")"
  base="$(basename "$(readlink -f "$OUT")")"
  tar -C "$parent" --transform "s|^$base|patch-package|" -czf "$TGZ" "$base"
  chmod 600 "$TGZ"
  log "архив: $TGZ ($(du -h "$TGZ" | cut -f1))"
fi
log "готово: $OUT ($(find "$OUT" -type f | wc -l) файлов, ревизия проекта $REVISION)"
