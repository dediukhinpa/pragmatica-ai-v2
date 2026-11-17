#!/usr/bin/env bash
# Сборка патч-пакета G8 (маршруты /docx/* в образе documents, лимит alloy 448m, снятие обхода):
# каталог, который переносят на боевой хост и запускают там `bash patch.sh` (см. OWNER-RUNBOOK.md).
# Красная зона: запускает владелец.
#
# Использование:
#   bash tools/build-patch-package.sh --out КАТАЛОГ --lock ФАЙЛ --signatures ФАЙЛ
#        [--cosign-pub ФАЙЛ] [--runbook ФАЙЛ] [--tgz ФАЙЛ] [--help]
#
# Состав (копии закоммиченного дерева, git show HEAD; незакоммиченное не попадает):
#   patch.sh, lib.sh, verify-signatures.sh   сценарий патча и общие функции (deploy/patch,
#                                            deploy/cutover)
#   smoke_contract.py                        смоук сборки договора по HTTP на синтетическом docx
#   tools/check-routes.sh, check-image-routes.sh, route-flags.tsv, routes.tsv   проверка маршрутов
#   deploy/                                  только файлы, которые патч вправе заменить (список в
#                                            patch.sh): compose.yml, compose.project.yml,
#                                            compat.env, platform/compose.base.yml,
#                                            platform/PLATFORM-VERSION
#   images.lock, signatures.txt, cosign.pub  образы по digest, подтверждение подписей, открытый ключ
#   RUNBOOK.md                               инструкция владельцу (если дан --runbook)
#   MANIFEST.sha256                          контрольные суммы всех файлов пакета
# Секретов, .env и ключей в пакет не кладётся: проверяется перед записью манифеста. Подтверждение
# подписей обязано относиться к ЭТОМУ lock (sha256) и всем его образам: проверяется при сборке.
# С --tgz пакет упаковывается в архив (режим 600, корень patch-package/).
#
# Коды выхода: 0 - готово; 1 - ошибка сборки; 2 - неверный вызов.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${BAI_PROJECT_DIR:-$(cd "$HERE/.." && pwd)}"
EXIT_FAILED=1
EXIT_USAGE=2
SCRIPTS_PATCH=(patch.sh smoke_contract.py)
SCRIPTS_CUTOVER=(lib.sh verify-signatures.sh)
ROUTE_TOOLS=(check-routes.sh check-image-routes.sh route-flags.tsv)
# Файлы дерева, которые патч вправе заменить: ДОЛЖНО совпадать с PATCH_FILE_ALLOW в patch.sh.
DEPLOY_FILES=(compose.yml compose.project.yml compat.env platform/compose.base.yml
  platform/PLATFORM-VERSION)
FORBIDDEN_RE='(^|/)(\.env|\.env\..*|secrets\.env|.*\.key|.*\.pem|.*\.bak.*)$'
ALLOWED_RE='(^|/)\.env\.example$'
OUT=""
LOCK=""
SIGNATURES=""
COSIGN_PUB="${BAI_SIGNING_PUBKEY:-$HOME/.config/bai-signing/cosign.pub}"
RUNBOOK=""
TGZ=""

usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }
log() { echo "[build-patch-package] $(date -u +%T) $*"; }
fail() { echo "[build-patch-package] ОШИБКА: $*" >&2; exit "$EXIT_FAILED"; }

while (($#)); do
  case "$1" in
    --out) OUT="${2:?--out КАТАЛОГ}"; shift ;;
    --lock) LOCK="${2:?--lock ФАЙЛ}"; shift ;;
    --signatures) SIGNATURES="${2:?--signatures ФАЙЛ}"; shift ;;
    --cosign-pub) COSIGN_PUB="${2:?}"; shift ;;
    --runbook) RUNBOOK="${2:?}"; shift ;;
    --tgz) TGZ="${2:?}"; shift ;;
    --help | -h) usage; exit 0 ;;
    *) echo "неизвестный аргумент: $1" >&2; usage >&2; exit "$EXIT_USAGE" ;;
  esac
  shift
done
[[ -n "$OUT" && -n "$LOCK" && -n "$SIGNATURES" ]] || { usage >&2; exit "$EXIT_USAGE"; }
for f in "$LOCK" "$SIGNATURES" "$COSIGN_PUB"; do
  [[ -f "$f" ]] || { echo "нет файла $f" >&2; exit "$EXIT_USAGE"; }
done
[[ -z "$RUNBOOK" || -f "$RUNBOOK" ]] || { echo "нет файла $RUNBOOK" >&2; exit "$EXIT_USAGE"; }
if [[ -e "$OUT" ]] && [[ -n "$(ls -A "$OUT" 2>/dev/null)" ]]; then
  echo "каталог $OUT не пуст" >&2
  exit "$EXIT_USAGE"
fi

# Подтверждение подписей относится к этому lock, этому ключу и покрывает все образы lock.
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
grep -qE '^BAI_IMAGE_MASK=[^@[:space:]]+@sha256:[0-9a-f]{64}$' "$LOCK" \
  || fail "в $LOCK нет BAI_IMAGE_MASK (образ по digest): нужен lock платформы 1.1.3"

REVISION="$(git -C "$ROOT" rev-parse --short=12 HEAD)"
if [[ -n "$(git -C "$ROOT" status --porcelain -- deploy tools 2>/dev/null)" ]]; then
  log "ВНИМАНИЕ: в deploy или tools есть незакоммиченные правки: в пакет они не попадут"
fi
mkdir -p "$OUT/tools" "$OUT/deploy/platform"
show() { # show <путь в дереве> <куда>
  git -C "$ROOT" show "HEAD:$1" >"$2" || fail "в HEAD нет $1"
}
for f in "${SCRIPTS_PATCH[@]}"; do show "deploy/patch/$f" "$OUT/$f"; done
for f in "${SCRIPTS_CUTOVER[@]}"; do show "deploy/cutover/$f" "$OUT/$f"; done
chmod +x "$OUT/patch.sh" "$OUT/verify-signatures.sh"
for f in "${ROUTE_TOOLS[@]}"; do show "tools/$f" "$OUT/tools/$f"; done
chmod +x "$OUT/tools/check-routes.sh" "$OUT/tools/check-image-routes.sh"
show deploy/cutover/routes.tsv "$OUT/routes.tsv"
for f in "${DEPLOY_FILES[@]}"; do show "deploy/$f" "$OUT/deploy/$f"; done
cp "$LOCK" "$OUT/images.lock"
cp "$SIGNATURES" "$OUT/signatures.txt"
cp "$COSIGN_PUB" "$OUT/cosign.pub"
[[ -z "$RUNBOOK" ]] || cp "$RUNBOOK" "$OUT/RUNBOOK.md"

bad="$(cd "$OUT" && find . -type f | sed 's|^\./||' \
  | grep -E "$FORBIDDEN_RE" | grep -vE "$ALLOWED_RE" || true)"
[[ -z "$bad" ]] || fail "в пакете запрещённые файлы: $(echo "$bad" | tr '\n' ' ')"
if grep -rIlE '^(-----BEGIN [A-Z ]*PRIVATE KEY-----|AGE-SECRET-KEY-)' "$OUT" >/dev/null 2>&1; then
  fail "в пакете найдено закрытое ключевое содержимое"
fi
[[ ! -e "$OUT/db" ]] || fail "в патч-пакете не должно быть db (миграций у патча нет)"

log "MANIFEST.sha256"
(cd "$OUT" && find . -type f ! -name MANIFEST.sha256 | sort | sed 's|^\./||' \
  | xargs -d '\n' sha256sum >MANIFEST.sha256)
if [[ -n "$TGZ" ]]; then
  parent="$(dirname "$(readlink -f "$OUT")")"
  base="$(basename "$(readlink -f "$OUT")")"
  tar -C "$parent" --transform "s|^$base|patch-package|" -czf "$TGZ" "$base"
  chmod 600 "$TGZ"
  log "архив: $TGZ ($(du -h "$TGZ" | cut -f1))"
fi
log "готово: $OUT ($(find "$OUT" -type f | wc -l) файлов, ревизия проекта $REVISION)"
