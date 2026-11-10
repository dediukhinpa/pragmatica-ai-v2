#!/usr/bin/env bash
# Тест целостности миграций и карты legacy-map.tsv (без PostgreSQL, секунды).
#
#   bash tools/check-migrations.test.sh
#
# Проверяет:
#   * карта: формат строк, существование файлов потоков app и platform, покрытие всех 42
#     прежних версий, отсутствие дублей, монотонность новой нумерации относительно старой;
#   * каждый файл db/app либо отображён из прежней версии, либо объявлен новым
#     (tools/check_migrations_new_app.txt);
#   * предметные миграции совпадают с прежними (если доступен старый репозиторий, только
#     git-объекты) и копия платформенных функций в app/026 совпадает с платформой;
#   * вспомогательный Python-модуль сравнения схем.
# Платформа берётся из git-объектов PLATFORM_REPO на PLATFORM_REF; если их нет, проверки с
# платформой пропускаются (SKIP) и это видно в выводе.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$ROOT/db/app"
MAP_FILE="$APP_DIR/legacy-map.tsv"
MAP_LINK="$ROOT/db/legacy-map.tsv"
OLD_VERSIONS="$ROOT/tools/check_migrations_old_versions.txt"
NEW_APP_FILE="$ROOT/tools/check_migrations_new_app.txt"
COMPAT_SQL="$APP_DIR/026_knowledge_scope_compat.sql"

PLATFORM_REPO="${PLATFORM_REPO:-$HOME/wt-bai-modular}"
PLATFORM_REF="${PLATFORM_REF:-0b172b9}"
SRC_REPO="${SRC_REPO:-$HOME/pragmatika-purchasing}"
SRC_COMMIT="${SRC_COMMIT:-5ea7f2d308beb476fb8b6fe05e095587c9ee4f40}"
# Ожидаемое число прежних миграций (001-042).
EXPECTED_OLD_COUNT=42
# Допустимый вид имён версий (как в раннере платформы).
NAME_RE='^[A-Za-z0-9_.-]+$'

export LC_ALL=C
PASS=0
FAILS=0
SKIPS=0
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP:?}"' EXIT

ok() { PASS=$((PASS + 1)); echo "ok   $*"; }
bad() { FAILS=$((FAILS + 1)); echo "FAIL $*"; }
skip() { SKIPS=$((SKIPS + 1)); echo "SKIP $*"; }

# --- Платформа из git-объектов -------------------------------------------------------------
PLATFORM_DIR=""
if git -C "$PLATFORM_REPO" cat-file -e "$PLATFORM_REF^{commit}" 2>/dev/null; then
  mkdir -p "$TMP/platform"
  git -C "$PLATFORM_REPO" archive "$PLATFORM_REF" db/platform | tar -x -C "$TMP/platform"
  PLATFORM_DIR="$TMP/platform/db/platform"
fi

# --- Чтение карты --------------------------------------------------------------------------
[[ -f "$MAP_FILE" ]] && ok "карта на месте: db/app/legacy-map.tsv" || bad "нет $MAP_FILE"
if [[ -L "$MAP_LINK" && "$(readlink "$MAP_LINK")" == "app/legacy-map.tsv" ]]; then
  ok "db/legacy-map.tsv - ссылка на app/legacy-map.tsv"
else
  bad "db/legacy-map.tsv должен быть символьной ссылкой на app/legacy-map.tsv"
fi

declare -a OLDS=() NEWS=()
declare -A PAIR_SEEN=() OLD_TARGETS=()
line_no=0
format_errors=0
while IFS=$'\t' read -r old new extra || [[ -n "${old:-}" ]]; do
  line_no=$((line_no + 1))
  [[ -z "$old" || "$old" == \#* ]] && { old=""; continue; }
  if [[ -n "${extra:-}" || -z "${new:-}" ]]; then
    bad "карта:$line_no: ожидаются два поля через табуляцию"; format_errors=$((format_errors + 1)); continue
  fi
  if ! [[ "$old" =~ $NAME_RE ]] || ! [[ "$new" =~ ^(platform|app)/[A-Za-z0-9_.-]+$ ]]; then
    bad "карта:$line_no: недопустимое имя ($old -> $new)"; format_errors=$((format_errors + 1)); continue
  fi
  if [[ -n "${PAIR_SEEN["$old	$new"]:-}" ]]; then
    bad "карта:$line_no: повтор пары $old -> $new"; format_errors=$((format_errors + 1)); continue
  fi
  PAIR_SEEN["$old	$new"]=1
  OLDS+=("$old"); NEWS+=("$new")
  OLD_TARGETS["$old"]="${OLD_TARGETS[$old]:+${OLD_TARGETS[$old]} }$new"
done <"$MAP_FILE"
[[ "$format_errors" -eq 0 ]] && ok "формат строк карты (${#OLDS[@]} пар)"

# --- Покрытие 42 прежних версий ------------------------------------------------------------
mapfile -t EXPECTED_OLDS < <(grep -v '^#' "$OLD_VERSIONS" | grep -v '^$')
[[ "${#EXPECTED_OLDS[@]}" -eq "$EXPECTED_OLD_COUNT" ]] \
  && ok "список прежних версий: $EXPECTED_OLD_COUNT" \
  || bad "в $OLD_VERSIONS ${#EXPECTED_OLDS[@]} версий, ожидалось $EXPECTED_OLD_COUNT"
missing_old=""
for v in "${EXPECTED_OLDS[@]}"; do
  [[ -n "${OLD_TARGETS[$v]:-}" ]] || missing_old+=" $v"
done
[[ -z "$missing_old" ]] && ok "все прежние версии покрыты картой" || bad "не покрыты:$missing_old"
extra_old=""
for v in "${!OLD_TARGETS[@]}"; do
  found=0
  for e in "${EXPECTED_OLDS[@]}"; do [[ "$e" == "$v" ]] && found=1; done
  [[ "$found" -eq 1 ]] || extra_old+=" $v"
done
[[ -z "$extra_old" ]] && ok "в карте нет лишних прежних версий" || bad "лишние в карте:$extra_old"

# Смешанные: ровно по одной версии в каждом потоке.
for v in 001_core 018_supplier_cards 020_knowledge_fts_query_suppliers_hnsw; do
  targets="${OLD_TARGETS[$v]:-}"
  n_plat=$(grep -o 'platform/' <<<"$targets" | wc -l)
  n_app=$(grep -o 'app/' <<<"$targets" | wc -l)
  [[ "$n_plat" -eq 1 && "$n_app" -eq 1 ]] \
    && ok "смешанная $v: platform + app" || bad "смешанная $v: ожидалось по одной версии в потоках ($targets)"
done

# --- Файлы потоков -------------------------------------------------------------------------
declare -A NEW_TARGETED=()
missing_files=""
for new in "${NEWS[@]}"; do
  NEW_TARGETED["$new"]=1
  stream="${new%%/*}"; name="${new#*/}"
  if [[ "$stream" == "app" ]]; then
    [[ -f "$APP_DIR/$name.sql" ]] || missing_files+=" $new"
  elif [[ -n "$PLATFORM_DIR" ]]; then
    [[ -f "$PLATFORM_DIR/$name.sql" ]] || missing_files+=" $new"
  fi
done
[[ -z "$missing_files" ]] && ok "каждая строка карты ссылается на существующий файл" \
  || bad "нет файлов:$missing_files"
[[ -n "$PLATFORM_DIR" ]] || skip "платформенные файлы не проверены (нет $PLATFORM_REPO@$PLATFORM_REF)"

mapfile -t NEW_APP < <(grep -v '^#' "$NEW_APP_FILE" | grep -v '^$')
orphan=""
shopt -s nullglob
for file in "$APP_DIR"/*.sql; do
  name="$(basename "$file" .sql)"
  [[ "$name" =~ $NAME_RE ]] || bad "недопустимое имя файла: $file"
  version="app/$name"
  declared=0
  for n in "${NEW_APP[@]}"; do [[ "$n" == "$version" ]] && declared=1; done
  if [[ -z "${NEW_TARGETED[$version]:-}" && "$declared" -eq 0 ]]; then
    orphan+=" $version"
  fi
  if [[ -n "${NEW_TARGETED[$version]:-}" && "$declared" -eq 1 ]]; then
    bad "$version объявлена новой, но есть в карте"
  fi
done
shopt -u nullglob
[[ -z "$orphan" ]] && ok "новых app-версий без прообраза нет (кроме объявленных: ${NEW_APP[*]})" \
  || bad "app-версии без прообраза:$orphan"

# Нумерация app: непрерывная 001..N, без дублей.
mapfile -t APP_NAMES < <(find "$APP_DIR" -maxdepth 1 -name '*.sql' -printf '%f\n' | sort)
expected=1
numbering_ok=1
for f in "${APP_NAMES[@]}"; do
  prefix="${f%%_*}"
  if [[ "$((10#$prefix))" -ne "$expected" ]]; then
    numbering_ok=0; bad "нумерация app: ожидалась $(printf '%03d' "$expected"), найден $f"
    break
  fi
  expected=$((expected + 1))
done
[[ "$numbering_ok" -eq 1 ]] && ok "нумерация app непрерывна: ${#APP_NAMES[@]} файлов"

# --- Монотонность: порядок новых номеров повторяет порядок прежних -------------------------
for stream in platform app; do
  prev=0
  mono_ok=1
  while IFS=$'\t' read -r old new; do
    [[ "${new%%/*}" == "$stream" ]] || continue
    num="${new#*/}"; num="$((10#${num%%_*}))"
    if [[ "$num" -lt "$prev" ]]; then
      mono_ok=0; bad "порядок $stream: $old -> $new идёт раньше предыдущего номера $prev"
    fi
    prev="$num"
  done < <(for i in "${!OLDS[@]}"; do printf '%s\t%s\n' "${OLDS[$i]}" "${NEWS[$i]}"; done | sort -t$'\t' -k1,1 -k2,2)
  [[ "$mono_ok" -eq 1 ]] && ok "порядок потока $stream повторяет порядок прежних миграций"
done

# --- Совпадение с прежним репозиторием (только git-объекты) --------------------------------
declare -A MIXED=([001_core]=1 [018_supplier_cards]=1 [020_knowledge_fts_query_suppliers_hnsw]=1)
if git -C "$SRC_REPO" cat-file -e "$SRC_COMMIT^{commit}" 2>/dev/null; then
  bad_origin=""
  for i in "${!OLDS[@]}"; do
    old="${OLDS[$i]}"; new="${NEWS[$i]}"
    [[ "${new%%/*}" == "app" ]] || continue
    file="$APP_DIR/${new#*/}.sql"
    git -C "$SRC_REPO" show "$SRC_COMMIT:db/migrations/$old.sql" >"$TMP/old.sql"
    if [[ -n "${MIXED[$old]:-}" ]]; then
      # Смешанная: каждая строка кода предметной половины есть в прежнем файле.
      if grep -v '^--' "$file" | grep -v '^[[:space:]]*$' | grep -vxFf "$TMP/old.sql" >"$TMP/extra.txt" \
        && [[ -s "$TMP/extra.txt" ]]; then
        bad_origin+=" $new(строки вне прежнего файла)"
      fi
    else
      cmp -s "$TMP/old.sql" "$file" || bad_origin+=" $new"
    fi
  done
  [[ -z "$bad_origin" ]] && ok "предметные миграции совпадают с прежними на $SRC_COMMIT" \
    || bad "расхождение с прежним репозиторием:$bad_origin"
else
  skip "прежний репозиторий недоступен: совпадение с $SRC_COMMIT не проверено"
fi

# --- Копия платформенных функций в app/026 совпадает с платформой --------------------------
if [[ -n "$PLATFORM_DIR" ]]; then
  awk '/^CREATE OR REPLACE FUNCTION knowledge_fts_query/{f=1} f' \
    "$PLATFORM_DIR/015_knowledge_fts_query.sql" | grep -v '^$' >"$TMP/plat015.txt"
  if grep -vxFf "$COMPAT_SQL" "$TMP/plat015.txt" >"$TMP/diff015.txt" && [[ -s "$TMP/diff015.txt" ]]; then
    bad "app/026: строки platform/015 отсутствуют в копии ($(wc -l <"$TMP/diff015.txt") шт.)"
  else
    ok "app/026 содержит платформенные knowledge_fts_query и hybrid_search без изменений"
  fi
else
  skip "app/026: сверка с platform/015 пропущена"
fi

# --- Прочее --------------------------------------------------------------------------------
bash -n "$ROOT/tools/check-migrations.sh" && ok "check-migrations.sh: синтаксис bash" \
  || bad "check-migrations.sh: ошибка синтаксиса"
if python3 -I "$ROOT/tools/check_migrations_schema_test.py" >"$TMP/py.log" 2>&1; then
  ok "check_migrations_schema_test.py"
else
  bad "check_migrations_schema_test.py"; tail -n 20 "$TMP/py.log"
fi

echo "---"
echo "итог: ok $PASS, FAIL $FAILS, SKIP $SKIPS"
[[ "$FAILS" -eq 0 ]]
