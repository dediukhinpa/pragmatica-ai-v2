#!/usr/bin/env bash
# Тест deploy/cutover/units-old-tree.sh на заглушке systemctl и временном «новом дереве»:
#   * ссылка на файл, который есть в новом дереве, даёт diff с заменой пути;
#   * ссылка на скрипт хоста, которого в новом дереве нет, помечается «оставить на старом дереве»;
#   * нет юнита - «нет юнита»; /opt/...-v2 за старое дерево не считается;
#   * секреты в Environment= скрыты; блок «Откат» есть;
#   * systemctl вызывается только с cat / is-active / is-enabled / show -p FragmentPath.
# Каталог скриптов можно подменить: CUTOVER_DIR (красный прогон: CUTOVER_DIR=/nonexistent).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
CUTOVER_DIR="${CUTOVER_DIR:-$ROOT/deploy/cutover}"
SCRIPT="$CUTOVER_DIR/units-old-tree.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP:?}"' EXIT
PASS=0
FAIL=0
LIMIT=100
EXIT_USAGE=2
EXIT_REFUSED=3
# «Старое дерево» теста - просто строка в юнитах (на диске его нет); новое - каталог в $TMP.
OLD_TREE="/opt/tp-old"
NEW_TREE="$TMP/new-tree"
SECRET_VALUE_1="sup3rs3cret-A"
SECRET_VALUE_2="hunter2-B"
SECRET_VALUE_3="quoted value C"
# Подкоманды systemctl, которые разрешены (остальное - нарушение «только чтение»).
NOTE_KEEP="в новом дереве нет: оставить на старом дереве"
NEW_EXEC="+ExecStart=/usr/bin/bash $NEW_TREE/deploy/cutover/probe.sh"
ALPHA_UNIT_FILE="/etc/systemd/system/tp-alpha.service"
MUTATING_SUBCMDS="start|stop|restart|enable|disable|daemon-reload|edit|mask|link|reload"
ALLOWED_RE='^(cat [^ ]+|is-active [^ ]+|is-enabled [^ ]+|show -p FragmentPath [^ ]+)$'

ok() { PASS=$((PASS + 1)); echo "PASS $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL $1"; }
assert() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

# --- Новое дерево: есть deploy/compose.yml, env и каталог; нет скриптов хоста -------------------
mkdir -p "$NEW_TREE/deploy/cutover" "$NEW_TREE/etc"
echo "x" >"$NEW_TREE/deploy/compose.yml"
echo "x" >"$NEW_TREE/deploy/cutover/probe.sh"

# --- Юниты заглушки (каталог файлов <имя>) -----------------------------------------------------
UNITS="$TMP/units"
mkdir -p "$UNITS"
# alpha: каталог дерева, файл в новом дереве, скрипт хоста, которого там нет; секреты в Environment.
cat >"$UNITS/tp-alpha.service" <<EOF
# /etc/systemd/system/tp-alpha.service
[Unit]
Description=Альфа
# $OLD_TREE/deploy/compose.yml - комментарий, не ссылка
[Service]
WorkingDirectory=$OLD_TREE
ExecStart=/usr/bin/bash $OLD_TREE/deploy/cutover/probe.sh --cfg $OLD_TREE/deploy/scripts/alpha.sh
Environment="API_TOKEN=$SECRET_VALUE_1" LANG=C
Environment=MODE=fast DB_PASSWORD=$SECRET_VALUE_2
Environment="MY_SECRET=$SECRET_VALUE_3" PATH=$OLD_TREE/bin:/usr/bin
EnvironmentFile=$OLD_TREE-v2/vars.env
EOF
# beta: только скрипт хоста, которого в новом дереве нет, - остаётся на старом дереве.
cat >"$UNITS/tp-beta.service" <<EOF
# /etc/systemd/system/tp-beta.service
[Service]
ExecStart=$OLD_TREE/deploy/scripts/beta.sh
EOF
# delta: .service без ссылок + .timer; ссылки только на /opt/tp-old-v2 (это не старое дерево).
cat >"$UNITS/tp-delta.service" <<EOF
# /etc/systemd/system/tp-delta.service
[Service]
ExecStart=$OLD_TREE-v2/deploy/run.sh
EOF
cat >"$UNITS/tp-delta.timer" <<EOF
# /etc/systemd/system/tp-delta.timer
[Timer]
OnCalendar=daily
EOF
# gamma: юнита нет (файла в заглушке нет).

# --- Заглушка systemctl ------------------------------------------------------------------------
BIN="$TMP/bin"
mkdir -p "$BIN"
cat >"$BIN/stub-systemctl" <<'STUB'
#!/usr/bin/env bash
# Заглушка: пишет вызов в журнал; cat отдаёт файл юнита из STUB_UNITS_DIR, иначе код 1.
printf '%s\n' "$*" >>"$SYSTEMCTL_LOG"
case "${1:-}" in
  cat) [[ -f "$STUB_UNITS_DIR/${2:-}" ]] && { cat "$STUB_UNITS_DIR/$2"; exit 0; }
       echo "No files found for ${2:-}." >&2; exit 1 ;;
  is-active) [[ -f "$STUB_UNITS_DIR/${2:-}" ]] && { echo active; exit 0; }
             echo inactive; exit 3 ;;
  is-enabled) [[ -f "$STUB_UNITS_DIR/${2:-}" ]] && { echo enabled; exit 0; }
              echo "not-found" >&2; exit 1 ;;
  show) echo "FragmentPath=/etc/systemd/system/${4:-}"; exit 0 ;;
  *) exit 0 ;;
esac
STUB
chmod +x "$BIN/stub-systemctl"

# run_units <имя> [аргументы скрипта]: stdout - $TMP/out-<имя>.txt, stderr - err-<имя>.txt, RC.
RC=0
run_units() {
  local name="$1"
  shift
  : >"$TMP/systemctl-$name.log"
  RC=0
  env PATH="$BIN:$PATH" UNIT_PREFIX=tp UNITS_SYSTEMCTL="$BIN/stub-systemctl" \
    SYSTEMCTL_LOG="$TMP/systemctl-$name.log" STUB_UNITS_DIR="$UNITS" \
    bash "$SCRIPT" "$@" >"$TMP/out-$name.txt" 2>"$TMP/err-$name.txt" || RC=$?
}

assert "скрипт существует и исполняемый" "[[ -x '$SCRIPT' ]]"

# 1. Справка и неверный вызов.
run_units help --help
assert "справка: код 0, описание и умолчания деревьев" \
  "[[ $RC -eq 0 ]] && grep -q 'Использование' '$TMP/out-help.txt' \
   && grep -q '/opt/pragmatika-v2' '$TMP/out-help.txt' \
   && grep -q 'UNITS_SYSTEMCTL' '$TMP/out-help.txt'"
run_units nonsense --nonsense
assert "неизвестный аргумент: код 2" "[[ $RC -eq $EXIT_USAGE ]]"
run_units badname --units 'a;b'
assert "недопустимое имя юнита: код 2" "[[ $RC -eq $EXIT_USAGE ]]"
run_units sametree --old-tree /opt/x --new-tree /opt/x/
assert "одинаковые деревья: код 2" "[[ $RC -eq $EXIT_USAGE ]]"
run_units relative --old-tree opt/x
assert "относительное старое дерево: код 2" "[[ $RC -eq $EXIT_USAGE ]]"
RC=0
env PATH="$BIN:$PATH" UNITS_SYSTEMCTL="$TMP/нет-systemctl" bash "$SCRIPT" >/dev/null 2>&1 || RC=$?
assert "нет systemctl: отказ с кодом 3" "[[ $RC -eq $EXIT_REFUSED ]]"

# 2. Основной прогон.
run_units main --units alpha,beta,gamma,delta --old-tree "$OLD_TREE" --new-tree "$NEW_TREE"
OUT="$TMP/out-main.txt"
assert "прогон: код 0, stderr пуст" "[[ $RC -eq 0 && ! -s '$TMP/err-main.txt' ]]"
assert "печатается текст юнита (systemctl cat)" "grep -q '^WorkingDirectory=$OLD_TREE\$' '$OUT'"
assert "печатается и текст .timer" "grep -q '^OnCalendar=daily\$' '$OUT'"
assert "показаны строки со старым деревом (номер строки и текст)" \
  "grep -q '^  стр\. [0-9]*: ExecStart=/usr/bin/bash $OLD_TREE/deploy/cutover/probe.sh' '$OUT'"
assert "diff: unified-формат с метками" \
  "grep -q '^--- tp-alpha.service (сейчас)' '$OUT' \
   && grep -q '^+++ tp-alpha.service (предлагается)' '$OUT'"
assert "diff: каталог дерева заменён на новое дерево" \
  "grep -qx -- '-WorkingDirectory=$OLD_TREE' '$OUT' \
   && grep -qx -- '+WorkingDirectory=$NEW_TREE' '$OUT'"
assert "diff: файл из нового дерева заменён, скрипт хоста в той же строке не тронут" \
  "grep -qxF -- '$NEW_EXEC --cfg $OLD_TREE/deploy/scripts/alpha.sh' '$OUT'"
assert "diff: путь в списке PATH не заменён, если цели в новом дереве нет" \
  "! grep -q '^+.*PATH=$NEW_TREE/bin' '$OUT'"
assert "ссылка на скрипт хоста помечена «оставить на старом дереве»" \
  "grep -q '$OLD_TREE/deploy/scripts/alpha.sh -> $NOTE_KEEP' '$OUT' \
   && grep -q '$OLD_TREE/deploy/scripts/beta.sh -> $NOTE_KEEP' '$OUT'"
assert "ссылка на существующий файл помечена «есть в новом дереве»" \
  "grep -q '$OLD_TREE/deploy/cutover/probe.sh -> есть в новом дереве: $NEW_TREE/deploy/' '$OUT'"
assert "комментарий со старым деревом ссылкой не считается" \
  "! grep -q 'стр\. [0-9]*: # ' '$OUT'"
assert "$OLD_TREE-v2 за старое дерево не считается (нет в списке ссылок и в diff)" \
  "! grep -q 'стр\. [0-9]*: .*$OLD_TREE-v2' '$OUT' && ! grep -q '^[-+].*$OLD_TREE-v2' '$OUT'"
assert "итог alpha: переписать путь" "grep -qx '  tp-alpha: переписать путь' '$OUT'"
assert "итог beta (скрипт хоста, цели нет): оставить" "grep -qx '  tp-beta: оставить' '$OUT'"
assert "итог gamma (нет юнита): нет юнита" "grep -qx '  tp-gamma: нет юнита' '$OUT'"
assert "итог delta (только -v2 и timer): оставить" "grep -qx '  tp-delta: оставить' '$OUT'"
assert "beta: diff не печатается" "! grep -q 'tp-beta.service (предлагается)' '$OUT'"
assert "секреты скрыты: значений в выводе нет" \
  "! grep -qF -e '$SECRET_VALUE_1' -e '$SECRET_VALUE_2' -e '$SECRET_VALUE_3' '$OUT'"
assert "секреты скрыты: имена остаются, значение - <скрыто>" \
  "grep -q 'API_TOKEN=<скрыто>' '$OUT' && grep -q 'DB_PASSWORD=<скрыто>' '$OUT' \
   && grep -q 'MY_SECRET=<скрыто>' '$OUT'"
assert "нессекретные значения Environment= видны" "grep -q 'MODE=fast' '$OUT' \
   && grep -q 'LANG=C' '$OUT'"

# 3. Блок «Откат».
assert "есть блок «Откат»" "grep -q '^Откат' '$OUT'"
assert "откат: для менявшегося юнита - копия cp -a в ~/backups ДО правки" \
  "grep -q 'BK=\"\$HOME/backups/cutover-units-' '$OUT' \
   && grep -q 'cp -a --parents \"/etc/systemd/system/tp-alpha.service\" \"\$BK/\"' '$OUT'"
assert "откат: команда возврата копии и daemon-reload только текстом" \
  "grep -q 'sudo cp -a \"\$BK$ALPHA_UNIT_FILE\" \"$ALPHA_UNIT_FILE\"' '$OUT' \
   && grep -q 'daemon-reload' '$OUT'"
assert "откат: для неменявшихся юнитов - «ничего»" \
  "[[ \"\$(grep -c 'откат: ничего, юнит не менялся' '$OUT')\" -eq 3 ]]"
assert "откат: копия не делается для юнита без правки (нет cp для beta)" \
  "! grep -q 'cp -a.*tp-beta' '$OUT'"
assert "откат: состояние до правки записано" \
  "grep -q 'состояние до правки: is-active=active' '$OUT'"
assert "ничего не скопировано и не создано: каталога backups в TMP нет" \
  "[[ ! -e '$TMP/backups' && ! -e '$HOME/backups/cutover-units-' ]]"

# 4. systemctl: только разрешённые вызовы.
LOG="$TMP/systemctl-main.log"
assert "systemctl вызывался (журнал непуст)" "[[ -s '$LOG' ]]"
assert "systemctl: только cat / is-active / is-enabled / show -p FragmentPath" \
  "! grep -vE '$ALLOWED_RE' '$LOG' | grep -q ."
assert "systemctl: нет start/stop/restart/enable/disable/daemon-reload/edit" \
  "! grep -qE '(^| )($MUTATING_SUBCMDS)( |\$)' '$LOG'"
assert "systemctl cat спрашивался для .service и .timer каждого юнита" \
  "grep -qx 'cat tp-alpha.service' '$LOG' && grep -qx 'cat tp-alpha.timer' '$LOG' \
   && grep -qx 'cat tp-gamma.service' '$LOG'"

# 5. Умолчания: три юнита старого дерева, префикс из UNIT_PREFIX; нет юнитов - три «нет юнита».
run_units defaults --old-tree "$OLD_TREE" --new-tree "$NEW_TREE"
assert "умолчание: три юнита cert-expiry, telemetry-probe, container-metrics" \
  "grep -qx '  tp-cert-expiry: нет юнита' '$TMP/out-defaults.txt' \
   && grep -qx '  tp-telemetry-probe: нет юнита' '$TMP/out-defaults.txt' \
   && grep -qx '  tp-container-metrics: нет юнита' '$TMP/out-defaults.txt'"
assert "умолчание: код 0 и systemctl только читает" \
  "[[ $RC -eq 0 ]] && ! grep -vE '$ALLOWED_RE' '$TMP/systemctl-defaults.log' | grep -q ."

# 6. Умолчание дерева: /opt/pragmatika не совпадает с /opt/pragmatika-v2 (граница пути).
cat >"$UNITS/tp-epsilon.service" <<'EOF'
[Service]
ExecStart=/opt/pragmatika-v2/deploy/x.sh
WorkingDirectory=/opt/pragmatika
ExecStartPost=/opt/pragmatika/deploy/scripts/post.sh
EOF
mkdir -p "$TMP/new2"
run_units default_trees --units epsilon --new-tree "$TMP/new2"
assert "умолчание старого дерева /opt/pragmatika: -v2 не считается, каталог и скрипт - да" \
  "grep -q 'стр\. 3: WorkingDirectory=/opt/pragmatika\$' '$TMP/out-default_trees.txt' \
   && grep -q 'стр\. 4: ExecStartPost=/opt/pragmatika/deploy/scripts/post.sh' \
     '$TMP/out-default_trees.txt' && ! grep -q 'стр\. 2:' '$TMP/out-default_trees.txt'"
assert "умолчание: каталог дерева есть в новом - заменён, скрипт хоста - оставлен" \
  "grep -qx -- '+WorkingDirectory=$TMP/new2' '$TMP/out-default_trees.txt' \
   && ! grep -q '^+ExecStartPost' '$TMP/out-default_trees.txt'"

# 7. Сам скрипт: синтаксис, длина, строгий режим, нет мутаций.
assert "bash -n" "bash -n '$SCRIPT'"
assert "строки скрипта не длиннее $LIMIT" \
  "! LC_ALL=C.UTF-8 grep -qE '^.{$((LIMIT + 1)),}' '$SCRIPT'"
assert "set -euo pipefail" "grep -q '^set -euo pipefail' '$SCRIPT'"
assert "в коде нет вызовов systemctl с изменяющими подкомандами" \
  "! grep -vE '^[[:space:]]*#' '$SCRIPT' \
     | grep -qE '\"\\\$SYSTEMCTL\" (start|stop|restart|enable|disable|daemon-reload|edit|mask)'"
assert "sudo - только в печатаемом тексте (printf), не в исполняемых командах" \
  "! grep -vE '^[[:space:]]*#' '$SCRIPT' | grep sudo | grep -qv printf"
assert "скрипт не пишет в /etc (нет перенаправлений и tee в /etc)" \
  "! grep -vE '^[[:space:]]*#' '$SCRIPT' | grep -E '(>|tee|cp|mv|sed -i).*/etc/' | grep -qv printf"

echo "ИТОГО: ok $PASS / fail $FAIL"
[[ $FAIL -eq 0 ]]
