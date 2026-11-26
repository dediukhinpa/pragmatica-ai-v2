#!/usr/bin/env bash
# Перенос образов патча G9w на боевой хост. Запускает ВЛАДЕЛЕЦ на Fornex: у root боевого сервера
# нет входа в реестр cr.yandex, а patch.sh ничего не скачивает.
#
# Использование:
#   bash transfer-images-9w.sh --host root@ХОСТ [--docker "docker"] [--lock ФАЙЛ] [--dry-run]
#   bash transfer-images-9w.sh --images-tar ФАЙЛ [--lock ФАЙЛ] [--dry-run]
#
#   --host АДРЕС      ssh-адрес боя (или имя из ~/.ssh/config). Вход только по ключу: все вызовы
#                     идут с -o BatchMode=yes, пароль не запрашивается.
#   --docker "КОМАНДА"  как на хосте вызывается docker (по умолчанию "docker"), например
#                     "sudo -n docker".
#   --images-tar ФАЙЛ без ssh: сохранить все четыре образа одним архивом (600). Дальше владелец
#                     сам копирует его на бой и запускает `bash patch.sh --images-tar ФАЙЛ`.
#   --lock ФАЙЛ       images.lock пакета (по умолчанию images.lock рядом со скриптом).
#   --key ФАЙЛ        ключ чтения реестра (по умолчанию
#                     ~/.config/bai-registry/bai-pull-pragmatica.json). Ключ подаётся docker login
#                     только на stdin: в переменные не читается и не печатается.
#   --dry-run         только напечатать, что будет выполнено: без входа, скачивания и ssh.
#
# Права на хосте. Образы идут по каналу (docker save | ssh ... docker load), stdin занят архивом,
# поэтому sudo с паролем не работает. Два способа:
#   1) вход по ssh сразу под root (--host root@ХОСТ), docker вызывается без sudo;
#   2) обычный пользователь с временным правом: либо в группе docker (--docker docker), либо
#      с временной строкой sudoers NOPASSWD только на docker (--docker "sudo -n docker").
#      После переноса право убрать.
#
# Что делает для каждого образа lock из набора app, documents, pseudonymizer, mask (основы сборки
# не переносятся: контейнеры из них не запускаются, patch.sh их наличия не требует):
#   docker pull <репо>@sha256:… -> docker tag … <репо>:xfer-9w ->
#   docker save <репо>:xfer-9w | ssh ХОСТ docker load ->
#   проверка: на хосте образ находится по digest и его ID равен локальному.
# Образ, уже лежащий на хосте по digest с тем же ID, повторно не передаётся. Метки :xfer-9w на
# хосте не удаляйте: по ним containerd-хранилище держит образ и находит его по digest.
# Коды выхода: 0 - все образы на хосте (или архив записан); 1 - сбой переноса или проверки;
# 2 - неверный вызов; 3 - отказ по предусловиям, ничего не передавалось.
set -euo pipefail
umask 077

EXIT_FAILED=1
EXIT_USAGE=2
EXIT_REFUSED=3
REGISTRY="cr.yandex"
REGISTRY_USER="json_key"
TRANSFER_TAG="xfer-9w"
IMAGE_KEYS=(BAI_IMAGE_APP BAI_IMAGE_DOCUMENTS BAI_IMAGE_PSEUDONYMIZER BAI_IMAGE_MASK)
REF_RE="^${REGISTRY//./\\.}/[a-z0-9._/-]+@sha256:[0-9a-f]{64}\$"
HOST_RE='^[A-Za-z0-9_][A-Za-z0-9._@-]*$'
DOCKER_CMD_RE='^[A-Za-z0-9_./ -]+$'
SSH_OPTS=(-o BatchMode=yes)
MIB=1048576

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST=""
REMOTE_DOCKER="docker"
LOCK="$HERE/images.lock"
KEY_FILE="${HOME}/.config/bai-registry/bai-pull-pragmatica.json"
IMAGES_TAR=""
DRY_RUN=0
LOGIN_DIR=""
TAR_PART=""

usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }
say() { printf '%s %s\n' "$(date -u +%T)" "$*"; }
die() { # die <код> <сообщение...>
  local code="$1"
  shift
  echo "ОШИБКА: $*" >&2
  exit "$code"
}
cleanup() {
  [[ -z "$LOGIN_DIR" ]] || rm -rf -- "${LOGIN_DIR:?}"
  [[ -z "$TAR_PART" ]] || rm -f -- "${TAR_PART:?}"
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

while (($#)); do
  case "$1" in
    --host) HOST="${2:?--host АДРЕС}"; shift ;;
    --docker) REMOTE_DOCKER="${2:?--docker КОМАНДА}"; shift ;;
    --lock) LOCK="${2:?--lock ФАЙЛ}"; shift ;;
    --key) KEY_FILE="${2:?--key ФАЙЛ}"; shift ;;
    --images-tar) IMAGES_TAR="${2:?--images-tar ФАЙЛ}"; shift ;;
    --dry-run) DRY_RUN=1 ;;
    --help | -h) usage; exit 0 ;;
    *) echo "неизвестный аргумент: $1" >&2; usage >&2; exit "$EXIT_USAGE" ;;
  esac
  shift
done
[[ -n "$HOST" || -n "$IMAGES_TAR" ]] \
  || die "$EXIT_USAGE" "нужен --host АДРЕС или --images-tar ФАЙЛ (см. --help)"
[[ -z "$HOST" || -z "$IMAGES_TAR" ]] || die "$EXIT_USAGE" "--host и --images-tar несовместимы"
# Адрес и команда уходят в ssh и в оболочку хоста: допустимы только безопасные символы.
[[ -z "$HOST" || "$HOST" =~ $HOST_RE ]] || die "$EXIT_USAGE" "недопустимый адрес в --host"
[[ "$REMOTE_DOCKER" =~ $DOCKER_CMD_RE ]] || die "$EXIT_USAGE" "недопустимая команда в --docker"

[[ -f "$LOCK" ]] || die "$EXIT_REFUSED" "нет файла lock: $LOCK (--lock ФАЙЛ)"
REFS=()
for key in "${IMAGE_KEYS[@]}"; do
  ref="$(grep -E "^$key=" "$LOCK" | head -1 | cut -d= -f2- || true)"
  [[ "$ref" =~ $REF_RE ]] \
    || die "$EXIT_REFUSED" "в $LOCK нет ключа $key вида $REGISTRY/…@sha256:<digest>"
  REFS+=("$ref")
done
if [[ -n "$IMAGES_TAR" ]]; then
  [[ -d "$(dirname "$IMAGES_TAR")" ]] \
    || die "$EXIT_REFUSED" "нет каталога для архива $IMAGES_TAR"
  [[ ! -e "$IMAGES_TAR" ]] || die "$EXIT_REFUSED" "файл $IMAGES_TAR уже есть: не перезаписываю"
fi

tag_of() { printf '%s:%s' "${1%@*}" "$TRANSFER_TAG"; }
# remote <команда docker...>: без чтения stdin; ссылки проверены регулярным выражением.
remote() { ssh -n "${SSH_OPTS[@]}" "$HOST" "$REMOTE_DOCKER $*"; }
remote_id() { remote "image inspect -f '{{.Id}}' '$1'" 2>/dev/null || true; }
local_id() { docker image inspect -f '{{.Id}}' "$1" 2>/dev/null || true; }

if ((DRY_RUN)); then
  say "dry-run: ничего не выполняется"
  say "docker login $REGISTRY -u $REGISTRY_USER --password-stdin < $KEY_FILE" \
    "(временный DOCKER_CONFIG)"
  tags=()
  for ref in "${REFS[@]}"; do
    say "docker pull $ref"
    say "docker tag $ref $(tag_of "$ref")"
    tags+=("$(tag_of "$ref")")
    if [[ -n "$HOST" ]]; then
      say "docker save $(tag_of "$ref") | ssh ${SSH_OPTS[*]} $HOST $REMOTE_DOCKER load"
      say "ssh -n ${SSH_OPTS[*]} $HOST $REMOTE_DOCKER image inspect $ref"
    fi
  done
  [[ -z "$IMAGES_TAR" ]] || say "docker save -o $IMAGES_TAR ${tags[*]}"
  exit 0
fi

command -v docker >/dev/null || die "$EXIT_REFUSED" "нет docker"
if [[ -n "$HOST" ]]; then
  command -v ssh >/dev/null || die "$EXIT_REFUSED" "нет ssh"
  remote "info -f '{{.ServerVersion}}'" >/dev/null \
    || die "$EXIT_REFUSED" "docker на $HOST недоступен по ssh без пароля" \
      "(проверьте ключ ssh и права: --help, раздел «Права на хосте»)"
  say "docker на $HOST доступен"
fi

[[ -f "$KEY_FILE" ]] || die "$EXIT_REFUSED" "нет ключа реестра $KEY_FILE (--key ФАЙЛ)"
LOGIN_DIR="$(mktemp -d)"
# Вход только во временный каталог настроек: он удаляется при любом выходе. Контекст docker по
# умолчанию из прежнего каталога настроек не нужен: перенос идёт локальным демоном.
DOCKER_CONFIG="$LOGIN_DIR" docker login "$REGISTRY" -u "$REGISTRY_USER" --password-stdin \
  <"$KEY_FILE" >/dev/null || die "$EXIT_REFUSED" "вход в $REGISTRY не удался"
say "вход в $REGISTRY выполнен (временный DOCKER_CONFIG)"

tags=()
for ref in "${REFS[@]}"; do
  name="${ref%@*}"
  name="${name##*/}"
  if [[ -n "$HOST" ]]; then
    have="$(remote_id "$ref")"
    if [[ -n "$have" && "$have" == "$(local_id "$ref")" ]]; then
      say "$name: уже на хосте (${ref##*@}), пропускаю"
      continue
    fi
  fi
  say "$name: скачиваю ${ref##*@}"
  DOCKER_CONFIG="$LOGIN_DIR" docker pull -q "$ref" >/dev/null \
    || die "$EXIT_FAILED" "$name: docker pull не удался"
  docker tag "$ref" "$(tag_of "$ref")" || die "$EXIT_FAILED" "$name: docker tag не удался"
  tags+=("$(tag_of "$ref")")
  [[ -n "$HOST" ]] || continue
  say "$name: передаю на $HOST"
  # pipefail: сбой любой стороны канала - сбой переноса.
  docker save "$(tag_of "$ref")" | ssh "${SSH_OPTS[@]}" "$HOST" "$REMOTE_DOCKER load" \
    || die "$EXIT_FAILED" "$name: передача не удалась (docker save | ssh docker load)"
  want="$(local_id "$ref")"
  got="$(remote_id "$ref")"
  [[ -n "$got" ]] \
    || die "$EXIT_FAILED" "$name: после загрузки образ на хосте не находится по digest" \
      "(на хосте нужно containerd-хранилище образов Docker)"
  [[ -n "$want" && "$got" == "$want" ]] \
    || die "$EXIT_FAILED" "$name: ID образа на хосте отличается от локального"
  say "$name: на хосте, digest находится, ID совпал"
done

if [[ -n "$IMAGES_TAR" ]]; then
  TAR_PART="$IMAGES_TAR.part"
  say "записываю архив $IMAGES_TAR"
  docker save -o "$TAR_PART" "${tags[@]}" || die "$EXIT_FAILED" "docker save не удался"
  tar -tf "$TAR_PART" >/dev/null || die "$EXIT_FAILED" "архив не читается"
  chmod 600 "$TAR_PART"
  mv "$TAR_PART" "$IMAGES_TAR"
  TAR_PART=""
  size="$(stat -c %s "$IMAGES_TAR")"
  say "готово: $IMAGES_TAR, $((size / MIB)) МиБ, sha256" \
    "$(sha256sum "$IMAGES_TAR" | cut -d' ' -f1)"
  say "скопируйте файл на бой, сверьте sha256 и запустите:" \
    "bash patch.sh --preflight-only --images-tar <путь к архиву на бою>"
else
  say "готово: все образы lock (${#REFS[@]}) на $HOST"
fi
