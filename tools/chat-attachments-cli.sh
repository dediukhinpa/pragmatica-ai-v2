#!/usr/bin/env bash
# Поиск и выгрузка файлов, которые сотрудники присылали ботам в чат (этап 9s). Запускать на
# боевом хосте владельцем; файлы читает только сервис app, поэтому команды идут через
# `docker exec` в контейнер app (имя неизменно: pragmatika-app-1).
#
#   bash chat-attachments-cli.sh find  [--user ID] [--bot КЛЮЧ] [--date ГГГГ-ММ-ДД] ...
#   bash chat-attachments-cli.sh stats
#   bash chat-attachments-cli.sh export <path из find> [КАТАЛОГ_НАЗНАЧЕНИЯ]   (docker cp на хост)
#   bash chat-attachments-cli.sh purge
# Переменная APP_CONTAINER меняет имя контейнера (по умолчанию pragmatika-app-1).
# Содержимое файлов и имена в журналы не пишутся: вывод идёт только на экран.
set -euo pipefail

readonly APP_CONTAINER="${APP_CONTAINER:-pragmatika-app-1}"
readonly CLI="src/chat-attachments-cli.ts"

die() {
  echo "ОШИБКА: $*" >&2
  exit 2
}

[[ $# -ge 1 ]] || die "укажите команду: find | stats | export | purge (или --help)"
command -v docker >/dev/null 2>&1 || die "нет docker"

run_cli() {
  docker exec "$APP_CONTAINER" bun run "$CLI" "$@"
}

if [[ "$1" == "export" ]]; then
  [[ $# -ge 2 ]] || die "export: укажите path из вывода find"
  rel="$2"
  dest="${3:-.}"
  [[ -d "$dest" ]] || die "каталог назначения не существует: $dest"
  # Абсолютный путь внутри контейнера выдаёт сама команда (проверка корня и симлинков).
  abs="$(run_cli path "$rel")" || die "файл не найден или удалён по сроку"
  echo "Копирую из контейнера $APP_CONTAINER в $dest"
  docker cp "$APP_CONTAINER:$abs" "$dest/"
  echo "Готово: $dest/$(basename "$abs")"
  exit 0
fi

run_cli "$@"
