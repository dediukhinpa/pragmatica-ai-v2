#!/usr/bin/env bash
# Сборка пакета gateway-9w.tgz: обновление pii-guard на шлюзе (deploy/patch-9w/gateway). Пакет
# самодостаточен: на шлюзе его распаковывают и запускают `bash update-guard.sh` (красная зона,
# запускает владелец).
#
# Использование:
#   bash tools/build-gateway-9w-package.sh [--platform-repo КАТАЛОГ] [--tag ТЕГ] [--out ФАЙЛ]
#        [--script ФАЙЛ] [--help]
#   --platform-repo  репозиторий платформы (по умолчанию ~/agent-platform-template); читаются
#                    только git-объекты тега, рабочая копия не используется
#   --tag            тег платформы (по умолчанию v1.1.12)
#   --out            архив пакета (по умолчанию ./gateway-9w.tgz)
#   --script         взять update-guard.sh из этого файла, а не из HEAD проекта (стенды)
#
# Состав (корень gateway-9w/):
#   update-guard.sh                    из HEAD проекта (незакоммиченное не попадает)
#   platform/gateway/pii-guard/        Dockerfile, Dockerfile.dockerignore, requirements.txt,
#                                      constraints.txt, agentplatform_guard/ (без тестов)
#   platform/vendor/labops-pii/        VERSION, LICENSE, labops_pii/ (то, что нужно образу)
#   platform/deploy/docker/config-env.sh
#   VERSION, MANIFEST.sha256
# Файлы платформы берутся из тега без правок. Хеши вендора сверяются с vendor/labops-pii/VERSION,
# источники всех COPY из Dockerfile обязаны быть в пакете. Секретов, .env и слов-исключений в
# пакете нет: слова скрипт читает на шлюзе из работающего guard.
set -euo pipefail
umask 022

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly HERE
ROOT="$(cd "$HERE/.." && pwd)"
readonly ROOT
readonly SCRIPT_REL="deploy/patch-9w/gateway/update-guard.sh"
readonly PACKAGE_NAME="gateway-9w"
readonly LIBRARY_TAG="v1.3.0"
readonly VENDOR_REL="vendor/labops-pii"
readonly DOCKERFILE_REL="gateway/pii-guard/Dockerfile"
readonly -a PLATFORM_PATHS=(
  gateway/pii-guard/Dockerfile
  gateway/pii-guard/Dockerfile.dockerignore
  gateway/pii-guard/requirements.txt
  gateway/pii-guard/constraints.txt
  gateway/pii-guard/agentplatform_guard
  vendor/labops-pii/VERSION
  vendor/labops-pii/LICENSE
  vendor/labops-pii/labops_pii
  deploy/docker/config-env.sh
)

PLATFORM_REPO="$HOME/agent-platform-template"
TAG="v1.1.12"
OUT="$PWD/$PACKAGE_NAME.tgz"
SCRIPT_FILE=""

log() { echo "==> $*"; }
die() {
  echo "ОШИБКА: $*" >&2
  exit 1
}

usage() {
  sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while (($# > 0)); do
  case "$1" in
    --platform-repo | --tag | --out | --script)
      (($# >= 2)) || { echo "нет значения у $1" >&2; exit 2; }
      case "$1" in
        --platform-repo) PLATFORM_REPO="$2" ;;
        --tag) TAG="$2" ;;
        --out) OUT="$2" ;;
        --script) SCRIPT_FILE="$2" ;;
      esac
      shift 2
      ;;
    --help | -h)
      usage
      exit 0
      ;;
    *)
      echo "неизвестный параметр: $1" >&2
      exit 2
      ;;
  esac
done

[[ -d "$PLATFORM_REPO" ]] || die "нет репозитория платформы: $PLATFORM_REPO"
commit="$(git -C "$PLATFORM_REPO" rev-parse --verify -q "refs/tags/$TAG^{commit}")" ||
  die "в репозитории платформы нет тега $TAG"
commit_time="$(git -C "$PLATFORM_REPO" show -s --format=%ct "$commit")"
[[ -d "$(dirname "$OUT")" ]] || die "нет каталога для архива: $(dirname "$OUT")"

work="$(mktemp -d)"
trap 'rm -rf "${work:?}"' EXIT
pkg="$work/$PACKAGE_NAME"
mkdir -p "$pkg/platform"

log "файлы платформы из тега $TAG ($commit)"
git -C "$PLATFORM_REPO" archive --format=tar "$commit" -- "${PLATFORM_PATHS[@]}" \
  >"$work/platform.tar" || die "в теге $TAG нет нужных файлов"
tar -xf "$work/platform.tar" -C "$pkg/platform"

log "сверка вендора labops-pii с VERSION"
vendor="$pkg/platform/$VENDOR_REL"
grep -qx "tag: $LIBRARY_TAG" "$vendor/VERSION" || die "в теге не labops-pii $LIBRARY_TAG"
# Строки списка файлов: «  <sha256>  <путь>»; проверяются только пути, входящие в пакет
awk '$1 ~ /^[0-9a-f]{64}$/ && ($2 == "LICENSE" || $2 ~ /^labops_pii\//) { print $1 "  " $2 }' \
  "$vendor/VERSION" >"$work/vendor.sha256"
[[ -s "$work/vendor.sha256" ]] || die "в VERSION нет списка файлов библиотеки"
(cd "$vendor" && sha256sum --quiet -c "$work/vendor.sha256") ||
  die "файлы вендора не совпадают с VERSION"
listed="$(awk '{ print $2 }' "$work/vendor.sha256" | LC_ALL=C sort)"
present="$(cd "$vendor" && find . -type f ! -name VERSION | sed 's|^\./||' | LC_ALL=C sort)"
[[ "$listed" == "$present" ]] || die "в вендоре есть файлы вне списка VERSION (или наоборот)"

log "источники COPY из Dockerfile"
copies=0
while read -r -a words; do
  [[ "${words[1]}" == --* ]] && die "COPY с параметрами: проверьте состав пакета вручную"
  for ((i = 1; i < ${#words[@]} - 1; i++)); do
    [[ -e "$pkg/platform/${words[i]}" ]] || die "Dockerfile копирует ${words[i]}, в пакете нет"
    copies=$((copies + 1))
  done
done < <(grep -E '^COPY ' "$pkg/platform/$DOCKERFILE_REL")
((copies > 0)) || die "в Dockerfile не найдено ни одного COPY"

log "update-guard.sh"
if [[ -n "$SCRIPT_FILE" ]]; then
  [[ -f "$SCRIPT_FILE" ]] || die "нет файла $SCRIPT_FILE"
  cp "$SCRIPT_FILE" "$pkg/update-guard.sh"
  script_source="файл $(basename "$SCRIPT_FILE")"
else
  git -C "$ROOT" show "HEAD:$SCRIPT_REL" >"$pkg/update-guard.sh" 2>/dev/null ||
    die "в HEAD проекта нет $SCRIPT_REL (сначала коммит)"
  script_source="проект $(git -C "$ROOT" rev-parse HEAD)"
fi
bash -n "$pkg/update-guard.sh" || die "update-guard.sh не разбирается bash"
chmod 755 "$pkg/update-guard.sh"

{
  echo "$PACKAGE_NAME: pii-guard платформы $TAG, labops-pii $LIBRARY_TAG"
  echo "platform_tag=$TAG"
  echo "platform_commit=$commit"
  echo "$(grep -m 1 '^commit: ' "$vendor/VERSION" | sed 's/^commit: /library_commit=/')"
  echo "script_source=$script_source"
} >"$pkg/VERSION"

log "MANIFEST.sha256"
(cd "$pkg" && find . -type f ! -name MANIFEST.sha256 | sed 's|^\./||' | LC_ALL=C sort |
  xargs -d '\n' sha256sum >MANIFEST.sha256)

# Архив воспроизводим: порядок, владелец и время файлов не зависят от сборщика
tar -C "$work" --sort=name --owner=0 --group=0 --numeric-owner --mtime="@$commit_time" \
  -cf - "$PACKAGE_NAME" | gzip -n >"$work/package.tgz"
cp "$work/package.tgz" "$OUT"
chmod 600 "$OUT"
log "готово: $OUT ($(find "$pkg" -type f | wc -l) файлов)"
log "sha256: $(sha256sum "$OUT" | cut -d' ' -f1)"
