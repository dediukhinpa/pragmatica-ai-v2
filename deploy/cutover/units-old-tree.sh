#!/usr/bin/env bash
# Юниты systemd, ссылающиеся на СТАРОЕ дерево Прагматики: что в них стоит и что предлагается
# заменить на новое дерево (v2). ТОЛЬКО ЧТЕНИЕ: скрипт ничего не меняет и не копирует, не
# пишет в /etc, не вызывает sudo; предложения печатает текстом для владельца.
#
# Использование:
#   bash units-old-tree.sh [--units a,b,c] [--old-tree КАТАЛОГ] [--new-tree КАТАЛОГ] [--help]
#
#   --units a,b,c     имена юнитов БЕЗ префикса (по умолчанию cert-expiry,telemetry-probe,
#                     container-metrics); полное имя - <UNIT_PREFIX>-<имя>.service/.timer
#   --old-tree КАТ.   старое дерево (по умолчанию /opt/pragmatika); совпадением считается
#                     /opt/pragmatika/... либо /opt/pragmatika в конце слова, но НЕ
#                     /opt/pragmatika-v2 и подобные
#   --new-tree КАТ.   новое дерево (по умолчанию /opt/pragmatika-v2)
#
# Переменные: UNIT_PREFIX (по умолчанию pragmatika), UNITS_SYSTEMCTL (команда systemctl,
# подменяется в тестах). Вызываются только `systemctl cat`, `is-active`, `is-enabled`,
# `show -p FragmentPath`; start/stop/restart/enable/disable/daemon-reload/edit - никогда.
#
# Что печатается по каждому юниту: текст `systemctl cat` (.service и, если есть, .timer);
# строки с путями старого дерева; для ссылок, чья цель СУЩЕСТВУЕТ в новом дереве, - unified diff
# (diff -u) с заменой на новое дерево; для ссылок, чьей цели в новом дереве нет (скрипты хоста
# deploy/scripts/*.sh), - пометка «в новом дереве нет: оставить на старом дереве». Строки
# комментариев (# и ;) в разбор ссылок не входят. Значения в Environment= для имён с
# KEY/TOKEN/PASSWORD/SECRET печатаются как <скрыто>. Итог по юниту: оставить | переписать путь
# | нет юнита. В конце блок «Откат»: команды для владельца (копия файлов юнита в
# ~/backups/... ДО правки и возврат из неё); сам скрипт ничего не копирует.
#
# Коды выхода: 0 - отчёт напечатан; 2 - неверный вызов; 3 - отказ (нет systemctl или diff).
set -euo pipefail

# ---------------------------------------------------------------------------------------------
# Константы
# ---------------------------------------------------------------------------------------------
EXIT_OK=0 EXIT_USAGE=2 EXIT_REFUSED=3
DEFAULT_OLD_TREE="/opt/pragmatika"
DEFAULT_NEW_TREE="/opt/pragmatika-v2"
DEFAULT_UNITS="cert-expiry,telemetry-probe,container-metrics"
DEFAULT_UNIT_DIR="/etc/systemd/system"
UNIT_PREFIX="${UNIT_PREFIX:-pragmatika}"
SYSTEMCTL="${UNITS_SYSTEMCTL:-systemctl}"
VERDICT_KEEP="оставить"
VERDICT_REWRITE="переписать путь"
VERDICT_ABSENT="нет юнита"
NOTE_KEEP_OLD="в новом дереве нет: оставить на старом дереве"
HIDDEN="<скрыто>"
SECRET_NAME_RE='[A-Za-z0-9_]*(KEY|TOKEN|PASSWORD|SECRET)[A-Za-z0-9_]*'
# Допустимые символы пути, который можно проверять и подставлять автоматически.
SAFE_TOKEN_RE='^[A-Za-z0-9_./@%+~-]+$'
NAME_RE='^[A-Za-z0-9_.@-]+$'
TREE_RE='^/[A-Za-z0-9_./-]+$'
# Концы пути в строке юнита: пробел, кавычки, ; , ) : =
PATH_STOP_CLASS="[:space:]\"';,):="
# Символ слева от пути, после которого /opt/... считается началом пути (не частью другого).
LEFT_BOUNDARY_CLASS="A-Za-z0-9_./-"
SUBSTITUTION_PASSES=2

OLD_TREE="$DEFAULT_OLD_TREE"
NEW_TREE="$DEFAULT_NEW_TREE"
UNITS_ARG="$DEFAULT_UNITS"

usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }
die_usage() { echo "ошибка вызова: $1" >&2; echo "см. --help" >&2; exit "$EXIT_USAGE"; }

# ---------------------------------------------------------------------------------------------
# Разбор аргументов
# ---------------------------------------------------------------------------------------------
while (($# > 0)); do
  case "$1" in
    --units) UNITS_ARG="${2:?--units требует список}"; shift 2 ;;
    --old-tree) OLD_TREE="${2:?--old-tree требует каталог}"; shift 2 ;;
    --new-tree) NEW_TREE="${2:?--new-tree требует каталог}"; shift 2 ;;
    --help | -h) usage; exit "$EXIT_OK" ;;
    *) die_usage "неизвестный аргумент: $1" ;;
  esac
done
# Хвостовые слэши не нужны: граница пути проверяется по следующему символу.
OLD_TREE="${OLD_TREE%/}"
NEW_TREE="${NEW_TREE%/}"
[[ "$OLD_TREE" =~ $TREE_RE ]] || die_usage "--old-tree: нужен абсолютный путь без спецсимволов"
[[ "$NEW_TREE" =~ $TREE_RE ]] || die_usage "--new-tree: нужен абсолютный путь без спецсимволов"
[[ "$OLD_TREE" != "$NEW_TREE" ]] || die_usage "старое и новое дерево совпадают"
[[ "$UNIT_PREFIX" =~ $NAME_RE ]] || die_usage "UNIT_PREFIX: недопустимые символы"
IFS=',' read -r -a UNIT_BASES <<<"$UNITS_ARG"
((${#UNIT_BASES[@]} > 0)) || die_usage "--units: пустой список"
for base in "${UNIT_BASES[@]}"; do
  [[ "$base" =~ $NAME_RE ]] || die_usage "--units: недопустимое имя юнита: '$base'"
done
if ! command -v "$SYSTEMCTL" >/dev/null 2>&1; then
  echo "отказ: нет команды systemctl ($SYSTEMCTL)" >&2
  exit "$EXIT_REFUSED"
fi
command -v diff >/dev/null 2>&1 || { echo "отказ: нет команды diff" >&2; exit "$EXIT_REFUSED"; }

# Точка в пути старого дерева - буквальная (в регулярных выражениях экранируется).
OLD_RE="${OLD_TREE//./\\.}"

# ---------------------------------------------------------------------------------------------
# Разбор текста юнита
# ---------------------------------------------------------------------------------------------
# Прячет значения секретных переменных в строках Environment=.
mask_secrets() {
  sed -E "/^[[:space:]]*Environment=/{
s/\"(${SECRET_NAME_RE})=[^\"]*\"/\"\\1=${HIDDEN}\"/gI
s/(${SECRET_NAME_RE})=[^[:space:]\"]+/\\1=${HIDDEN}/gI
}"
}

# Пути старого дерева в одной строке (по одному на строку вывода): граница слева - не символ
# пути, справа - конец пути; /opt/pragmatika-v2 и /opt/pragmatikaX не совпадают.
refs_in_line() {
  local line="$1" m rest
  while IFS= read -r m; do
    [[ -n "$m" ]] || continue
    [[ "${m:0:1}" == "/" ]] || m="${m:1}"
    rest="${m#"$OLD_TREE"}"
    [[ -z "$rest" || "${rest:0:1}" == "/" ]] || continue
    printf '%s\n' "$m"
  done < <(grep -oE "(^|[^$LEFT_BOUNDARY_CLASS])${OLD_RE}[^$PATH_STOP_CLASS]*" <<<"$line" || true)
}

# Замена путей из списка (аргументы 2..) на новое дерево во всём тексте (аргумент 1).
rewrite_text() {
  local text="$1" tok re new pass
  shift
  local -a script=()
  for tok in "$@"; do
    re="${tok//./\\.}"
    re="${re//+/\\+}"
    new="$NEW_TREE${tok#"$OLD_TREE"}"
    script+=(-e "s#(^|[^$LEFT_BOUNDARY_CLASS])${re}([$PATH_STOP_CLASS]|\$)#\\1${new}\\2#g")
  done
  # Два прохода: соседние пути делят один символ-разделитель, за один проход его съедает первый.
  for ((pass = 0; pass < SUBSTITUTION_PASSES; pass++)); do
    text="$(sed -E "${script[@]}" <<<"$text")"
  done
  printf '%s\n' "$text"
}

# Глобальные результаты разбора одного текста (функции вызываются не в подоболочке).
TEXT_REWRITES=0
BACKUP_FILES=()

# report_text <метка> <текст>: печатает текст, ссылки на старое дерево и diff замены.
report_text() {
  local label="$1" masked="$2" line n=0 tok new found=0
  local -a toks=() existing=()
  local -A seen=()
  printf '\n--- %s ---\n' "$label"
  printf '%s\n' "$masked"
  while IFS= read -r line; do
    n=$((n + 1))
    [[ "$line" =~ ^[[:space:]]*[#\;] ]] && continue
    mapfile -t toks < <(refs_in_line "$line")
    ((${#toks[@]} > 0)) || continue
    if ((found == 0)); then
      printf '\nСсылки на старое дерево (%s) в %s:\n' "$OLD_TREE" "$label"
      found=1
    fi
    printf '  стр. %d: %s\n' "$n" "$line"
    for tok in "${toks[@]}"; do
      new="$NEW_TREE${tok#"$OLD_TREE"}"
      if [[ ! "$tok" =~ $SAFE_TOKEN_RE ]]; then
        printf '    %s -> нестандартный путь: проверить вручную\n' "$tok"
      elif [[ -e "$new" ]]; then
        printf '    %s -> есть в новом дереве: %s\n' "$tok" "$new"
        if [[ -z "${seen[$tok]:-}" ]]; then existing+=("$tok"); fi
        seen[$tok]=1
      else
        printf '    %s -> %s\n' "$tok" "$NOTE_KEEP_OLD"
      fi
    done
  done <<<"$masked"
  ((found == 1)) || printf '\nСсылок на старое дерево (%s) в %s нет.\n' "$OLD_TREE" "$label"
  if ((${#existing[@]} > 0)); then
    TEXT_REWRITES=$((TEXT_REWRITES + 1))
    printf '\nПредлагаемая замена (только пути, существующие в новом дереве), diff -u:\n'
    diff -u --label "$label (сейчас)" --label "$label (предлагается)" \
      <(printf '%s\n' "$masked") <(rewrite_text "$masked" "${existing[@]}") || true
  fi
}

# Файлы юнита из заголовков `# /путь` в выводе systemctl cat (сам юнит и drop-in'ы).
collect_backup_files() {
  local text="$1" path
  while IFS= read -r path; do
    BACKUP_FILES+=("$path")
  done < <(sed -nE 's/^# (\/[^[:space:]]+)$/\1/p' <<<"$text")
}

# ---------------------------------------------------------------------------------------------
# Обход юнитов
# ---------------------------------------------------------------------------------------------
UNIT_NAMES=()
UNIT_VERDICTS=()
UNIT_STATES=()
UNIT_BACKUPS=()

process_unit() {
  local base="$1" unit="$UNIT_PREFIX-$1" svc="" tim="" have_svc=0 have_tim=0
  local active enabled frag verdict
  if svc="$("$SYSTEMCTL" cat "$unit.service" 2>/dev/null)"; then have_svc=1; fi
  if tim="$("$SYSTEMCTL" cat "$unit.timer" 2>/dev/null)"; then have_tim=1; fi
  printf '\n==============================================================================\n'
  printf 'Юнит: %s\n' "$unit"
  UNIT_NAMES+=("$unit")
  if ((have_svc == 0 && have_tim == 0)); then
    printf 'Итог: %s (systemctl cat не нашёл ни %s.service, ни %s.timer)\n' \
      "$VERDICT_ABSENT" "$unit" "$unit"
    UNIT_VERDICTS+=("$VERDICT_ABSENT")
    UNIT_STATES+=("")
    UNIT_BACKUPS+=("")
    return 0
  fi
  active="$("$SYSTEMCTL" is-active "$unit.service" 2>/dev/null || true)"
  enabled="$("$SYSTEMCTL" is-enabled "$unit.service" 2>/dev/null || true)"
  frag="$("$SYSTEMCTL" show -p FragmentPath "$unit.service" 2>/dev/null || true)"
  frag="${frag#FragmentPath=}"
  printf 'Состояние: is-active=%s is-enabled=%s FragmentPath=%s\n' \
    "${active:-?}" "${enabled:-?}" "${frag:-?}"
  TEXT_REWRITES=0
  BACKUP_FILES=()
  if ((have_svc == 1)); then
    report_text "$unit.service" "$(mask_secrets <<<"$svc")"
    collect_backup_files "$svc"
  fi
  if ((have_tim == 1)); then
    report_text "$unit.timer" "$(mask_secrets <<<"$tim")"
    collect_backup_files "$tim"
  fi
  if ((TEXT_REWRITES > 0)); then verdict="$VERDICT_REWRITE"; else verdict="$VERDICT_KEEP"; fi
  printf '\nИтог: %s\n' "$verdict"
  # Файлы для копии: из заголовков `# /путь`; нет их - FragmentPath, иначе стандартный каталог.
  if ((${#BACKUP_FILES[@]} == 0)); then
    BACKUP_FILES+=("${frag:-$DEFAULT_UNIT_DIR/$unit.service}")
  fi
  UNIT_VERDICTS+=("$verdict")
  UNIT_STATES+=("is-active=${active:-?} is-enabled=${enabled:-?}")
  UNIT_BACKUPS+=("$(printf '%s\n' "${BACKUP_FILES[@]}" | sort -u)")
}

printf 'Юниты старого дерева (%s) -> новое дерево (%s). Только чтение.\n' "$OLD_TREE" "$NEW_TREE"
for base in "${UNIT_BASES[@]}"; do
  process_unit "$base"
done

# ---------------------------------------------------------------------------------------------
# Итоги и откат
# ---------------------------------------------------------------------------------------------
printf '\n==============================================================================\n'
printf 'ИТОГ ПО ЮНИТАМ\n'
for i in "${!UNIT_NAMES[@]}"; do
  printf '  %s: %s\n' "${UNIT_NAMES[$i]}" "${UNIT_VERDICTS[$i]}"
done

printf '\n==============================================================================\n'
printf 'Откат (скрипт ничего не копирует и не меняет; команды выполняет владелец)\n'
printf '%s\n' \
  '  Если ни один юнит не правится - откатывать нечего.' \
  '  ПЕРЕД правкой любого юнита со строкой «переписать путь» (путь каталога запомнить):' \
  '    BK="$HOME/backups/cutover-units-$(date +%Y%m%d-%H%M%S)" && mkdir -p "$BK"'
for i in "${!UNIT_NAMES[@]}"; do
  printf '\n  %s: %s\n' "${UNIT_NAMES[$i]}" "${UNIT_VERDICTS[$i]}"
  if [[ "${UNIT_VERDICTS[$i]}" != "$VERDICT_REWRITE" ]]; then
    printf '    откат: ничего, юнит не менялся\n'
    continue
  fi
  printf '    копия ДО правки:\n'
  while IFS= read -r path; do
    printf '      cp -a --parents "%s" "$BK/"\n' "$path"
  done <<<"${UNIT_BACKUPS[$i]}"
  printf '    возврат прежнего вида:\n'
  while IFS= read -r path; do
    printf '      sudo cp -a "$BK%s" "%s"\n' "$path" "$path"
  done <<<"${UNIT_BACKUPS[$i]}"
  printf '      sudo systemctl daemon-reload\n'
  printf '    состояние до правки: %s (после возврата сверить: systemctl is-active/is-enabled)\n' \
    "${UNIT_STATES[$i]}"
done
exit "$EXIT_OK"
