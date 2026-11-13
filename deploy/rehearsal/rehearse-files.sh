#!/usr/bin/env bash
# Подготовка файлов репетиции: каталоги хоста боя -> копии в каталоге запуска, владелец копий,
# проверка «процесс контейнера читает смонтированное». Подключается через source из rehearse.sh
# (и из tools/rehearse-files.test.sh); сам ничего не выполняет и set -e не ставит.
#
# Почему отдельный файл. Отказ попытки 3 G6: app не читал ACCESS_POLICY_FILE, потому что копия
# правил брались из /etc/pragmatika/access, а на бою каталога правил там нет: путь хоста задаёт
# `ACCESS_POLICY_HOST_DIR` боевого .env (так же TEMPLATES_HOST_DIR, MAIL_HOST_DIR,
# DOCUMENTS_HOST_DIR, LOCAL_HOST_DIR). Теперь пути берутся из .env боя с теми же умолчаниями, что
# у compose v2.
#
# Права копий. Копии лежат в каталоге запуска (700), а процессы контейнеров работают не под
# root и не под владельцем копий: файлы получают владельца uid:gid процесса контейнера (узнаётся
# из образа, числа в коде нет) и режим 640, то есть читать их может только этот процесс. Каталоги
# остаются у запустившего (755: нужен обход, имён в них секретов нет), поэтому уборка работает
# и без root. Владелец меняется одноразовым контейнером под root (docker run --user 0): так
# работает и запуск от root, и запуск от обычного пользователя группы docker.

# Режим файлов и каталогов копий.
REH_FILE_MODE=640
REH_DIR_MODE=755
# Предел размера копии шаблонов, МиБ: больше - копия не снимается (шара документов целиком
# сюда не должна попадать, если TEMPLATES_HOST_DIR не задан и совпал с DOCUMENTS_HOST_DIR).
REH_TEMPLATES_MAX_MIB=${REH_TEMPLATES_MAX_MIB:-256}
# Предел размера каталога local, МиБ (шаблоны, правила доступа).
REH_LOCAL_MAX_MIB=${REH_LOCAL_MAX_MIB:-1024}
# Контейнеры одноразовых проверок: без сети и с малой памятью.
REH_ONESHOT_MEM=128m
REH_MIB_BYTES=1048576

# reh_host_dir <файл .env боя> <ИМЯ> <умолчание>: значение ИМЯ из .env боя; пусто - умолчание.
# Относительный путь отсчитывается от каталога deploy боя (как у compose), если он известен.
reh_host_dir() {
  local value
  value="$(env_value "$1" "$2")"
  [[ -n "$value" ]] || value="$3"
  if [[ "$value" != /* && -n "${BATTLE_DEPLOY_DIR:-}" ]]; then
    value="$BATTLE_DEPLOY_DIR/$value"
  fi
  printf '%s' "$value"
}

# reh_image_ids <образ>: «uid gid» процесса образа по умолчанию (USER образа), одной строкой.
reh_image_ids() {
  local uid gid
  uid="$(docker run --rm --network none --entrypoint id "$1" -u 2>/dev/null)" || return 1
  gid="$(docker run --rm --network none --entrypoint id "$1" -g 2>/dev/null)" || return 1
  [[ "$uid" =~ ^[0-9]+$ && "$gid" =~ ^[0-9]+$ ]] || return 1
  printf '%s %s' "$uid" "$gid"
}

# reh_dir_size_mib <каталог>: размер в МиБ (с разыменованием ссылок), округлённый вверх.
reh_dir_size_mib() {
  local bytes
  bytes="$(du -sbL "$1" 2>/dev/null | cut -f1)"
  echo $(((${bytes:-0} + REH_MIB_BYTES - 1) / REH_MIB_BYTES))
}

# reh_copy_dir <источник> <приёмник>: копия содержимого каталога с разыменованием ссылок
# (симлинк правил внутри каталога боя иначе указывал бы на путь, которого нет в контейнере).
# Права берутся по умолчанию, владельца ставит reh_own_for_image. Вывод ошибки - в stderr.
reh_copy_dir() {
  mkdir -p "$2"
  cp -rL --no-preserve=all "$1/." "$2/"
}

# Скрипт внутри контейнера под root: режим и владелец файлов. Файлы делает контейнер, а не
# хост: запуск от обычного пользователя не может сменить владельца, а файлы после запуска от
# root уже принадлежат root (хост не смог бы изменить их режим). Каталоги готовит хост.
REH_FIX_SCRIPT='cd /own || exit 1
if [ -n "$3" ]; then chmod "$1" "$3" && chown "$2" "$3"; exit $?; fi
find . -type f -exec chmod "$1" {} + && find . -type f -exec chown "$2" {} +'

# reh_fix_in_container <образ> <каталог> <uid:gid> [имя файла]: без имени - все обычные файлы
# каталога (рекурсивно), с именем - один файл. Владельца каталогов не меняем (уборка не должна
# требовать root).
reh_fix_in_container() {
  docker run --rm --network none --user 0:0 --cap-drop ALL --cap-add CHOWN --cap-add FOWNER \
    --security-opt no-new-privileges:true --memory "$REH_ONESHOT_MEM" \
    --entrypoint sh -v "$2:/own" "$1" -c "$REH_FIX_SCRIPT" sh "$REH_FILE_MODE" "$3" "${4:-}"
}

# reh_own_for_image <образ> <путь>...: файлы получают владельца uid:gid процесса образа и режим
# 640, каталоги - 755. Путь может быть каталогом (все файлы внутри) или файлом. Ошибка - код 1
# и сообщение в stderr.
reh_own_for_image() {
  local image="$1" ids uid gid path
  shift
  ids="$(reh_image_ids "$image")" || {
    echo "не узнан uid:gid процесса образа $image" >&2
    return 1
  }
  read -r uid gid <<<"$ids"
  for path in "$@"; do
    # Каталоги создал запустивший (при umask 077 они 700): контейнеру под root без
    # DAC_OVERRIDE нужен обход, поэтому режим каталогов ставит хост, а файлов - контейнер.
    if [[ -d "$path" ]]; then
      find "$path" -type d -exec chmod "$REH_DIR_MODE" {} +
      reh_fix_in_container "$image" "$path" "$uid:$gid" ""
    elif [[ -f "$path" ]]; then
      chmod "$REH_DIR_MODE" "$(dirname "$path")"
      reh_fix_in_container "$image" "$(dirname "$path")" "$uid:$gid" "$(basename "$path")"
    else
      continue
    fi || { echo "не сменён владелец: $(basename "$path")" >&2; return 1; }
  done
}

# Скрипт проверки чтения внутри контейнера (sh). Аргумент `@ИМЯ` - переменная окружения с путём
# к файлу (должна быть задана, файл обычный и читаемый); любой другой аргумент - путь (должен
# существовать и читаться). Печатает по строке «имя ok|нет файла|нет прав|не файл», путь
# внутри контейнера - в сообщении, содержимое не читается. Код 1, если хоть одно условие нарушено.
REH_READ_SCRIPT='rc=0
for a in "$@"; do
  case "$a" in
    @*) name="${a#@}"; p="$(printenv "$name" || true)"; kind=file
        [ -n "$p" ] || { echo "$name не задана"; continue; } ;;
    *) name="$a"; p="$a"; kind=any ;;
  esac
  if [ ! -e "$p" ]; then echo "$name нет файла: $p"; rc=1
  elif [ ! -r "$p" ]; then echo "$name нет прав: $p"; rc=1
  elif [ "$kind" = file ] && [ ! -f "$p" ]; then echo "$name не файл: $p"; rc=1
  else echo "$name ok"; fi
done
exit $rc'

# reh_readable_by_image <образ> <каталог:путь_в_контейнере>... -- <аргументы скрипта>...:
# одноразовый контейнер образа (его uid, не root) с монтированиями только чтение; без сети.
# Нужен тестам и разведке; сама репетиция проверяет через compose (reh_service_reads в rehearse.sh).
reh_readable_by_image() {
  local image="$1" mount_args=()
  shift
  while (($#)) && [[ "$1" != "--" ]]; do
    mount_args+=(-v "$1:ro")
    shift
  done
  shift
  docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges:true \
    --memory "$REH_ONESHOT_MEM" "${mount_args[@]}" --entrypoint sh "$image" \
    -c "$REH_READ_SCRIPT" sh "$@"
}
