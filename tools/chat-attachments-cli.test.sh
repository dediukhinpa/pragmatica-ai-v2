#!/usr/bin/env bash
# Тест обёртки tools/chat-attachments-cli.sh на подмене docker (боевого docker не нужно).
set -euo pipefail

readonly HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT="$HERE/chat-attachments-cli.sh"
TMP="$(mktemp -d)"
readonly TMP
trap 'rm -rf "${TMP:?}"' EXIT
PASS=0
FAIL=0

ok() { PASS=$((PASS + 1)); }
bad() { FAIL=$((FAIL + 1)); echo "ПРОВАЛ: $*"; }
check() { if [[ "$1" == "$2" ]]; then ok; else bad "$3: ждали [$2], получили [$1]"; fi; }
contains() { if [[ "$1" == *"$2"* ]]; then ok; else bad "$3: нет [$2] в [$1]"; fi; }

mkdir -p "$TMP/bin" "$TMP/dest"
# Подмена docker: пишет вызовы в журнал, на `path` отвечает абсолютным путём.
cat >"$TMP/bin/docker" <<'STUB'
#!/usr/bin/env bash
echo "docker $*" >>"$DOCKER_LOG"
if [[ "$1" == "exec" && "$*" == *" path "* ]]; then
  if [[ "$*" == *"missing"* ]]; then exit 1; fi
  echo "/var/lib/pragmatika/intake/chat-attachments/files/aa/bb_file.pdf"
elif [[ "$1" == "cp" ]]; then
  : >"$3/$(basename "${2#*:}")"
fi
STUB
chmod 755 "$TMP/bin/docker"
export DOCKER_LOG="$TMP/docker.log"
export PATH="$TMP/bin:$PATH"

: >"$DOCKER_LOG"
bash "$SCRIPT" find --user 5 --date 2026-11-05 >/dev/null
contains "$(cat "$DOCKER_LOG")" "docker exec pragmatika-app-1 bun run src/chat-attachments-cli.ts find --user 5" "find"

: >"$DOCKER_LOG"
APP_CONTAINER=other-app-1 bash "$SCRIPT" stats >/dev/null
contains "$(cat "$DOCKER_LOG")" "docker exec other-app-1 bun run" "имя контейнера"

: >"$DOCKER_LOG"
out="$(bash "$SCRIPT" export files/aa/bb_file.pdf "$TMP/dest")"
contains "$out" "Готово" "export: итог"
[[ -f "$TMP/dest/bb_file.pdf" ]] && ok || bad "export: файл не скопирован"
contains "$(cat "$DOCKER_LOG")" "docker cp pragmatika-app-1:/var/lib/pragmatika/intake" "export: docker cp"

if bash "$SCRIPT" export missing "$TMP/dest" >/dev/null 2>&1; then bad "export: удалённый файл"; else ok; fi
if bash "$SCRIPT" export >/dev/null 2>&1; then bad "export без пути"; else ok; fi
if bash "$SCRIPT" export x /нет/такого >/dev/null 2>&1; then bad "export: нет каталога"; else ok; fi
if bash "$SCRIPT" >/dev/null 2>&1; then bad "без команды"; else ok; fi

# Стиль: строгий режим и кавычки; ничего секретного.
head -n 20 "$SCRIPT" | grep -q 'set -euo pipefail' && ok || bad "нет set -euo pipefail"
grep -qiE 'claude|anthropic' "$SCRIPT" && bad "упоминание ИИ" || ok

echo "chat-attachments-cli.test.sh: $PASS проверок, $FAIL провалов"
[[ "$FAIL" -eq 0 ]]
