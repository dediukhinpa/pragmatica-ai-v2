#!/usr/bin/env bash
# Тест deploy/cutover/{cutover,rollback,lib}.sh без настоящего Docker: вместо docker - заглушка,
# пишущая журнал вызовов. Проверяются: отказы по предусловиям (бой не тронут: ни одной изменяющей
# команды docker), шлюз подписей (молча пропустить нельзя), боевой .env, разбор подтверждения
# подписей, функции lib.sh, предохранители rollback.sh и стиль. Ход на настоящем Docker проверяет
# tools/cutover-synth.sh (синтетический бой на Fornex).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SRC_DIR="${CUTOVER_DIR:-$ROOT/deploy/cutover}"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP:?}"' EXIT
PASS=0
FAIL=0
LIMIT=100
EXIT_REFUSED=3
EXIT_USAGE=2
FREEZE="5ea7f2d308beb476fb8b6fe05e095587c9ee4f40"
DIGEST_A="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
DIGEST_B="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
# Изменяющие команды docker: ни одна не должна появиться при отказе.
MUTATING_RE='^(run|create|rm|stop|kill|start|restart|load|pull|volume rm|volume create|network'
MUTATING_RE+='|compose (up|run|stop|down|rm))'

ok() { PASS=$((PASS + 1)); echo "PASS $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL $1"; }
assert() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

# --- Заглушка docker -----------------------------------------------------------------------------
BIN="$TMP/bin"
mkdir -p "$BIN"
cat >"$BIN/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$DOCKER_LOG"
case "$1" in
  compose) [[ "${2:-}" == "version" ]] && echo "2.40.3"; exit 0 ;;
  inspect) echo "running"; exit 0 ;;
  exec) echo "1048576"; exit 0 ;;
  info) echo "$TMP_DOCKER_ROOT"; exit 0 ;;
  ps) echo "pragmatika-app-1"; exit 0 ;;
  *) exit 0 ;;
esac
STUB
chmod +x "$BIN/docker"

# --- Фальшивый пакет -----------------------------------------------------------------------------
PKG="$TMP/pkg"
mkdir -p "$PKG/stack/deploy/rehearsal" "$PKG/stack/db/app/rollback" "$PKG/tools"
echo "services: {}" >"$PKG/stack/deploy/compose.yml"
cp "$ROOT/deploy/rehearsal/rehearse-files.sh" "$PKG/stack/deploy/rehearsal/"
cp "$ROOT/deploy/rehearsal/env-retired.txt" "$PKG/stack/deploy/rehearsal/"
echo "SELECT 1;" >"$PKG/stack/db/app/rollback/026_down.sql"
echo "app/026_x" >"$PKG/expected-pending.txt"
printf '%s\n' "$FREEZE" >"$PKG/FREEZE_SRC"
printf 'BAI_VERSION=1.0.1\nBAI_IMAGE_APP=r/app@sha256:%s\nBAI_IMAGE_POSTGRES=r/pg@sha256:%s\n' \
  "$DIGEST_A" "$DIGEST_B" >"$PKG/images.lock"
echo "public-key" >"$PKG/cosign.pub"
cp "$ROOT/deploy/rehearsal/../cutover/expected-host-dirs.txt" "$PKG/" 2>/dev/null \
  || echo "ACCESS_POLICY_HOST_DIR=/opt/pragmatika/local/access" >"$PKG/expected-host-dirs.txt"
for f in cutover.sh rollback.sh lib.sh; do cp "$SRC_DIR/$f" "$PKG/$f"; done
(cd "$PKG" && find . -type f ! -name MANIFEST.sha256 | sort | sed 's|^\./||' \
  | xargs -d '\n' sha256sum >MANIFEST.sha256)

LOCK_SHA="$(sha256sum "$PKG/images.lock" | cut -d' ' -f1)"
PUB_SHA="$(sha256sum "$PKG/cosign.pub" | cut -d' ' -f1)"
make_sigs() { # make_sigs <файл> <result> [digest app]
  printf '# verify-signatures v1\nlock_sha256=%s\npubkey_sha256=%s\ncosign=v3\n' \
    "$LOCK_SHA" "$PUB_SHA" >"$1"
  printf 'verified_at=2026-11-14T08:00:00Z\n' >>"$1"
  printf 'image\tBAI_IMAGE_APP\tr/app@sha256:%s\tOK\n' "${3:-$DIGEST_A}" >>"$1"
  printf 'image\tBAI_IMAGE_POSTGRES\tr/pg@sha256:%s\tOK\n' "$DIGEST_B" >>"$1"
  printf 'result=%s\n' "$2" >>"$1"
}
make_sigs "$TMP/sigs.ok" OK
make_sigs "$TMP/sigs.fail" FAIL
make_sigs "$TMP/sigs.digest" OK "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"

# run <имя> [аргументы cutover.sh]: запуск в изолированном $HOME; код в RC, вывод в $TMP/out-<имя>.
run() {
  local name="$1"
  shift
  : >"$TMP/docker-$name.log"
  mkdir -p "$TMP/home-$name"
  RC=0
  env HOME="$TMP/home-$name" PATH="$BIN:$PATH" DOCKER_LOG="$TMP/docker-$name.log" \
    TMP_DOCKER_ROOT="$TMP" CUTOVER_COSIGN="${COSIGN_BIN:-/nonexistent-cosign}" \
    CUTOVER_ENV_FILE="${ENV_FILE:-$TMP/none.env}" \
    CUTOVER_EXPECTED_HOST_DIRS="${EXPECTED_DIRS:-}" \
    bash "$PKG/cutover.sh" "$@" >"$TMP/out-$name" 2>&1 || RC=$?
}
no_mutation() { ! grep -qE "$MUTATING_RE" "$TMP/docker-$1.log"; }

assert "cutover.sh на месте" "[[ -f '$SRC_DIR/cutover.sh' ]]"

# 1. Отказ: чужой FREEZE_SRC.
echo "0000000000000000000000000000000000000000" >"$PKG/FREEZE_SRC"
(cd "$PKG" && find . -type f ! -name MANIFEST.sha256 | sort | sed 's|^\./||' \
  | xargs -d '\n' sha256sum >MANIFEST.sha256)
run freeze --signatures-verified "$TMP/sigs.ok"
assert "чужой FREEZE_SRC - код 3" "[[ $RC -eq $EXIT_REFUSED ]]"
assert "чужой FREEZE_SRC - бой не тронут" "no_mutation freeze"
printf '%s\n' "$FREEZE" >"$PKG/FREEZE_SRC"
(cd "$PKG" && find . -type f ! -name MANIFEST.sha256 | sort | sed 's|^\./||' \
  | xargs -d '\n' sha256sum >MANIFEST.sha256)

# 2. Повреждённый манифест.
echo "tamper" >>"$PKG/expected-pending.txt"
run manifest --signatures-verified "$TMP/sigs.ok"
assert "изменённый файл пакета - код 3" "[[ $RC -eq $EXIT_REFUSED ]]"
assert "в сообщении MANIFEST" "grep -q 'MANIFEST' '$TMP/out-manifest'"
sed -i '/^tamper$/d' "$PKG/expected-pending.txt"

# 3. Шлюз подписей: нет cosign и нет подтверждения - отказ, пропустить нельзя.
run nosig
assert "нет cosign и подтверждения - код 3" "[[ $RC -eq $EXIT_REFUSED ]]"
assert "сообщение про --signatures-verified" "grep -q 'signatures-verified' '$TMP/out-nosig'"
assert "без подписей бой не тронут" "no_mutation nosig"
run sigfail --signatures-verified "$TMP/sigs.fail"
assert "result=FAIL - код 3" "[[ $RC -eq $EXIT_REFUSED ]]"
run sigdigest --signatures-verified "$TMP/sigs.digest"
assert "другой digest в подтверждении - код 3" "[[ $RC -eq $EXIT_REFUSED ]]"
assert "сообщение про digest" "grep -q 'digest' '$TMP/out-sigdigest'"
run sigmissing --signatures-verified "$TMP/none.txt"
assert "нет файла подтверждения - код 3" "[[ $RC -eq $EXIT_REFUSED ]]"

# 4. Подтверждение принято: дальше упираемся в боевой .env (его нет), подпись пройдена.
run sigok --signatures-verified "$TMP/sigs.ok"
assert "верное подтверждение, нет .env - код 3" "[[ $RC -eq $EXIT_REFUSED ]]"
assert "подписи приняты" "grep -q 'подтверждены подписи 2 образов' '$TMP/out-sigok'"
assert "дальше отказ из-за .env" "grep -q 'нет боевого .env' '$TMP/out-sigok'"
assert "бой не тронут и здесь" "no_mutation sigok"

# 5. Боевой .env: ключи образов и чужие пути.
printf 'BAI_IMAGE_APP=evil@sha256:%s\n' "$DIGEST_A" >"$TMP/env.keys"
ENV_FILE="$TMP/env.keys" run envkeys --signatures-verified "$TMP/sigs.ok"
assert ".env с BAI_IMAGE_* - код 3" "[[ $RC -eq $EXIT_REFUSED ]]"
assert "в сообщении имя ключа" "grep -q 'BAI_IMAGE_APP' '$TMP/out-envkeys'"
# POSTGRES_IMAGE/NGINX_IMAGE есть в боевом .env, но база v2 их не читает: отказа по ним нет.
printf 'POSTGRES_IMAGE=pgvector/pgvector:0.8.6-pg16\nNGINX_IMAGE=nginx:1.27-alpine\n' \
  >"$TMP/env.legacy"
ENV_FILE="$TMP/env.legacy" run envlegacy --signatures-verified "$TMP/sigs.ok"
assert "POSTGRES_IMAGE/NGINX_IMAGE в .env не причина отказа" \
  "! grep -q 'перекрывающие образы' '$TMP/out-envlegacy'"
mkdir -p "$TMP/dirs"
cat >"$TMP/env.paths" <<EOF2
ACCESS_POLICY_HOST_DIR=/etc/pragmatika/access
TEMPLATES_HOST_DIR=$TMP/dirs
DOCUMENTS_HOST_DIR=$TMP/dirs
MAIL_HOST_DIR=$TMP/dirs
ACCESS_POLICY_FILE=/etc/pragmatika/access/access-policy.json
EOF2
ENV_FILE="$TMP/env.paths" run envpaths --signatures-verified "$TMP/sigs.ok"
assert ".env с путём из примера - код 3" "[[ $RC -eq $EXIT_REFUSED ]]"
assert "сообщение о пути правил" "grep -q 'ACCESS_POLICY_HOST_DIR' '$TMP/out-envpaths'"
assert ".env с чужим путём - бой не тронут" "no_mutation envpaths"

# 5b. Штатный бэкап настроен: нет BACKUP_AGE_RECIPIENT/S3 - отказ 3 до любых изменений боя
# (в том числе с --preflight-only); с --allow-unconfigured-backup - предупреждение и дальше.
mkdir -p "$TMP/bk/dirs" "$TMP/bk/secrets" "$TMP/bk/access"
echo '{}' >"$TMP/bk/access/access-policy.json"
cat >"$TMP/bk/expected.txt" <<EOF2
DOCUMENTS_HOST_DIR=$TMP/bk/dirs
ACCESS_POLICY_HOST_DIR=$TMP/bk/access
ACCESS_POLICY_FILE=/etc/pragmatika/access/access-policy.json
MAIL_HOST_DIR=$TMP/bk/dirs
TEMPLATES_HOST_DIR=$TMP/bk/dirs
LOCAL_HOST_DIR=$TMP/bk/dirs
EOF2
cat >"$TMP/bk/base.env" <<EOF2
SECRETS_DIR=$TMP/bk/secrets
DOCUMENTS_HOST_DIR=$TMP/bk/dirs
ACCESS_POLICY_HOST_DIR=$TMP/bk/access
ACCESS_POLICY_FILE=/etc/pragmatika/access/access-policy.json
MAIL_HOST_DIR=$TMP/bk/dirs
TEMPLATES_HOST_DIR=$TMP/bk/dirs
LOCAL_HOST_DIR=$TMP/bk/dirs
EOF2
BK_AGE="age1secretrecipientvalue"
BK_S3_ENV=$'BACKUP_S3_ENDPOINT=https://s3.example.invalid\nBACKUP_S3_BUCKET=bucket\n'
BK_S3_ENV+=$'BACKUP_S3_ACCESS_KEY_ID=accesskeyidvalue\n'
BK_S3_ENV+=$'BACKUP_S3_SECRET_ACCESS_KEY=secretaccesskeyvalue\n'
bk_run() { # bk_run <имя> <содержимое доп. .env> [аргументы cutover.sh]
  local name="$1" extra="$2"
  shift 2
  { cat "$TMP/bk/base.env"; printf '%s' "$extra"; } >"$TMP/bk/$name.env"
  ENV_FILE="$TMP/bk/$name.env" EXPECTED_DIRS="$TMP/bk/expected.txt" \
    run "$name" --signatures-verified "$TMP/sigs.ok" "$@"
}
BK_REFUSAL='штатный бэкап не настроен'
bk_run bknone ""
assert "бэкап не настроен - код 3" "[[ $RC -eq $EXIT_REFUSED ]]"
assert "отказ называет BACKUP_AGE_RECIPIENT/S3 и флаг" \
  "grep -q 'BACKUP_AGE_RECIPIENT/S3' '$TMP/out-bknone' \
   && grep -q -- '--allow-unconfigured-backup' '$TMP/out-bknone'"
assert "отказ перечисляет незаданные имена" \
  "grep -q 'не заданы: BACKUP_AGE_RECIPIENT BACKUP_S3_ENDPOINT' '$TMP/out-bknone'"
assert "бэкап не настроен - бой не тронут" "no_mutation bknone"
assert "до проверки бэкапа дошли: .env боя принят" \
  "grep -q 'проверка боевой .env: ok' '$TMP/out-bknone'"
bk_run bkpre "" --preflight-only
assert "бэкап не настроен, --preflight-only - тоже код 3" "[[ $RC -eq $EXIT_REFUSED ]]"
assert "--preflight-only: бой не тронут" "no_mutation bkpre"
bk_run bkempty $'BACKUP_AGE_RECIPIENT=\n'"$BK_S3_ENV"
assert "пустой BACKUP_AGE_RECIPIENT - код 3" "[[ $RC -eq $EXIT_REFUSED ]]"
assert "пустой ключ age назван в отказе" \
  "grep -q 'не заданы: BACKUP_AGE_RECIPIENT' '$TMP/out-bkempty'"
bk_run bkpart "BACKUP_AGE_RECIPIENT=$BK_AGE"$'\n'
assert "задан только ключ age (нет S3) - код 3" "[[ $RC -eq $EXIT_REFUSED ]]"
assert "частичная настройка: бой не тронут" "no_mutation bkpart"
# Настроен: отказа по бэкапу нет (дальше отказ или сбой по другим предусловиям - не наше дело).
bk_run bkok "BACKUP_AGE_RECIPIENT=$BK_AGE"$'\n'"$BK_S3_ENV"
assert "бэкап настроен (.env) - отказа по бэкапу нет" "! grep -q '$BK_REFUSAL' '$TMP/out-bkok'"
assert "бэкап настроен - проверка ok" "grep -q 'проверка штатный бэкап: ok' '$TMP/out-bkok'"
assert "значения BACKUP_* в выводе не печатаются" \
  "! grep -qE '$BK_AGE|accesskeyidvalue|secretaccesskeyvalue' '$TMP/out-bkok'"
# Значения из secrets.env (перекрывают .env) считаются так же, как у backup.sh.
printf 'BACKUP_AGE_RECIPIENT=%s\n%s' "$BK_AGE" "$BK_S3_ENV" >"$TMP/bk/secrets/secrets.env"
bk_run bksec ""
assert "бэкап настроен через secrets.env - отказа нет" "! grep -q '$BK_REFUSAL' '$TMP/out-bksec'"
assert "secrets.env: проверка ok" "grep -q 'проверка штатный бэкап: ok' '$TMP/out-bksec'"
rm -f "$TMP/bk/secrets/secrets.env"
# Флаг владельца: не настроен - предупреждение, отказа нет, шаг backup.sh будет пропущен.
bk_run bkflag "" --allow-unconfigured-backup
assert "--allow-unconfigured-backup: отказа по бэкапу нет" \
  "! grep -q '$BK_REFUSAL' '$TMP/out-bkflag'"
assert "--allow-unconfigured-backup: предупреждение в журнале" \
  "grep -q 'проверка штатный бэкап: warn - не настроен' '$TMP/out-bkflag' \
   && grep -q 'backup.sh --verify будет пропущен' '$TMP/out-bkflag'"
assert "--allow-unconfigured-backup: проверки идут дальше (ресурсы)" \
  "grep -q 'ресурсы и инструменты' '$TMP/out-bkflag'"
assert "флаг есть в справке" \
  "bash '$PKG/cutover.sh' --help | grep -q -- '--allow-unconfigured-backup'"
# Флаг не мешает настроенному бэкапу: проверка ok, а не warn.
bk_run bkflagok "BACKUP_AGE_RECIPIENT=$BK_AGE"$'\n'"$BK_S3_ENV" --allow-unconfigured-backup
assert "флаг при настроенном бэкапе: ok, не warn" \
  "grep -q 'проверка штатный бэкап: ok' '$TMP/out-bkflagok'"
# Шаг бэкапа: код 3 backup.sh не считается успехом, без настройки и с флагом шаг пропускается.
assert "make_backups: код 3 backup.sh = сбой, не успех" \
  "grep -q 'BACKUP_SH_NOT_CONFIGURED' '$SRC_DIR/cutover.sh' \
   && grep -q 'бэкап не настроен (код' '$SRC_DIR/cutover.sh'"
assert "make_backups: пропуск только при BACKUP_CONFIGURED=0" \
  "grep -q 'state_get BACKUP_CONFIGURED' '$SRC_DIR/cutover.sh'"
assert "порядок: проверка бэкапа до ресурсов и до остановки боя" \
  "awk '/^  check_battle_env\$/{a=NR} /^  check_backup_configured\$/{b=NR} \
        /^  check_resources\$/{c=NR} /^  make_backups\$/{d=NR} \
        END{exit !(a<b && b<c && c<d)}' '$SRC_DIR/cutover.sh'"
BK_VARS="$(bash -c "source '$SRC_DIR/lib.sh'; echo \"\${BACKUP_CONFIG_VARS[*]}\"")"
BK_VARS_WANT="BACKUP_AGE_RECIPIENT BACKUP_S3_ENDPOINT BACKUP_S3_BUCKET"
BK_VARS_WANT+=" BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY"
assert "BACKUP_CONFIG_VARS: ключ age и четыре переменные S3" "[[ '$BK_VARS' == '$BK_VARS_WANT' ]]"

# 5c. Шаг make_backups на заглушках (функция берётся из cutover.sh как есть): без настройки и с
# флагом backup.sh не вызывается, остальные архивы делаются; код 3 backup.sh - сбой, не успех.
mk_run() { # mk_run <имя> <BACKUP_CONFIGURED> <код backup.sh>; код выхода - в RC
  local name="$1" cfg="$2" bcode="$3" d
  d="$TMP/mk-$name"
  mkdir -p "$d/old" "$d/backups"
  printf '#!/usr/bin/env bash\necho called >>"%s/backup.called"\nexit %s\n' "$d" "$bcode" \
    >"$d/backup.sh"
  cat >"$d/harness.sh" <<EOF2
set -euo pipefail
source '$SRC_DIR/lib.sh'
cut_init_run '$d/run'
RUN_ID=t1
$(grep -m1 '^BACKUP_SH_NOT_CONFIGURED=' "$SRC_DIR/cutover.sh")
BACKUP_PREFIX=pragmatika-before-v2
PG_USER=u; PG_DB=d; LOCK_SRC='$PKG/images.lock'
CUTOVER_BACKUP_ROOT='$d/backups'; CUTOVER_ENV_FILE='$d/env'; CUTOVER_SECRETS_DIR='$d/sec'
CUTOVER_OLD_DIR='$d/old'; CUTOVER_PG_CONTAINER=pg; CUTOVER_PSEUDO_VOLUME=vol
CUTOVER_BACKUP_SCRIPT='$d/backup.sh'
touch '$d/env'; : >"\$RES/containers-before.tsv"; : >"\$RES/images-before.tsv"
state_set BACKUP_CONFIGURED $cfg
die() { log "ОШИБКА: \$2"; exit "\$1"; }
stop_service_containers() { :; }
docker() { case "\$1" in run) : >'$d/backups/pragmatika-before-v2-t1/pseudonymizer-data.tgz'
  tar -czf '$d/backups/pragmatika-before-v2-t1/pseudonymizer-data.tgz' -T /dev/null ;; esac; }
$(sed -n '/^make_backups() {/,/^}/p' "$SRC_DIR/cutover.sh")
make_backups
EOF2
  RC=0
  bash "$d/harness.sh" >"$TMP/out-mk-$name" 2>&1 || RC=$?
}
mk_run skip 0 0
assert "make_backups, не настроен + флаг: успех" "[[ $RC -eq 0 ]]"
assert "backup.sh не вызывался" "[[ ! -e '$TMP/mk-skip/backup.called' ]]"
assert "в журнале ПРОПУЩЕН" "grep -q 'ПРОПУЩЕН' '$TMP/out-mk-skip'"
assert "pg_dump-архивы на месте при пропуске" \
  "[[ -e '$TMP/mk-skip/backups/pragmatika-before-v2-t1/old-tree.tgz' ]]"
mk_run ok 1 0
assert "make_backups, настроен: backup.sh вызван и успех" \
  "[[ $RC -eq 0 && -e '$TMP/mk-ok/backup.called' ]]"
mk_run nc 1 3
assert "backup.sh вернул 3 («не настроено») - сбой хода, не успех" "[[ $RC -eq 1 ]]"
assert "сообщение: бэкап не настроен, копии нет" "grep -q 'копии нет' '$TMP/out-mk-nc'"
mk_run fail 1 1
assert "backup.sh вернул 1 - сбой хода" "[[ $RC -eq 1 ]]"
assert "сообщение обычного сбоя backup.sh" "grep -q 'завершился с ошибкой' '$TMP/out-mk-fail'"

# 6. Неверный вызов.
run usage --nonsense
assert "неизвестный аргумент - код 2" "[[ $RC -eq $EXIT_USAGE ]]"
run soak --soak-seconds abc
assert "--soak-seconds не число - код 2" "[[ $RC -eq $EXIT_USAGE ]]"

# 7. rollback.sh: предохранители.
rb() { RC=0; env HOME="$TMP/home-rb" PATH="$BIN:$PATH" DOCKER_LOG="$TMP/docker-rb.log" \
  TMP_DOCKER_ROOT="$TMP" bash "$PKG/rollback.sh" "$@" >"$TMP/out-rb" 2>&1 || RC=$?; }
mkdir -p "$TMP/home-rb" "$TMP/rundir"
: >"$TMP/docker-rb.log"
rb --run-dir "$TMP/rundir"
assert "rollback без cutover.conf - код 2" "[[ $RC -eq $EXIT_USAGE ]]"
echo "CUTOVER_PROJECT=pragmatika" >"$TMP/rundir/cutover.conf"
rb --run-dir "$TMP/rundir" --restore-db
assert "--restore-db без подтверждения - код 2" "[[ $RC -eq $EXIT_USAGE ]]"
assert "предупреждение о потере данных" "grep -q 'ПРЕДУПРЕЖДЕНИЕ' '$TMP/out-rb'"
assert "без подтверждения docker не вызывался" "[[ ! -s '$TMP/docker-rb.log' ]]"
rb --run-dir "$TMP/none"
assert "rollback: нет каталога запуска - код 2" "[[ $RC -eq $EXIT_USAGE ]]"

# 8. Функции lib.sh.
LIBTEST="$(bash -c "
set -euo pipefail
source '$SRC_DIR/lib.sh'
printf 'BAI_VERSION=1\nBAI_IMAGE_X=r/x@sha256:$DIGEST_A\n' >'$TMP/l1'
printf 'BAI_VERSION=1\nBAI_IMAGE_X=r/x:tag\n' >'$TMP/l2'
printf 'BAI_VERSION=1\nBAI_IMAGE_X=r/x@sha256:$DIGEST_A\n' >'$TMP/l3'
printf 'BAI_IMAGE_X=r/x@sha256:$DIGEST_A\n' >>'$TMP/l3'
printf 'BAI_IMAGE_X=r/x@sha256:$DIGEST_A\n' >'$TMP/l4'
for n in 1 2 3 4; do cut_lock_format '$TMP/l'\$n && echo -n ok || echo -n no; done; echo
ready_bots '200 {\"status\":\"ready\",\"bots\":{\"ready\":4}}'
ready_bots '200 {\"status\":\"ready\"}'
mail_summary '200 {\"mail\":{\"state\":\"ok\",\"mailboxes\":7,\"authBlocked\":0}}'
mail_summary '200 {\"status\":\"ready\"}'
printf 'CUTOVER_A=file\nCUTOVER_B=file\n' >'$TMP/c.conf'
export CUTOVER_A=env
cut_load_config '$TMP/c.conf'
echo \"\$CUTOVER_A \$CUTOVER_B\"
")"
line() { sed -n "$1p" <<<"$LIBTEST" | tr '\n' ' '; }
assert "lock: верный да, тег/повтор/без версии нет" "[[ \"\$(line 1)\" == 'oknonono ' ]]"
assert "ready_bots: число и 0 без поля" "[[ \"\$(line 2)\$(line 3)\" == '4 0 ' ]]"
assert "mail_summary" "[[ \"\$(line 4)\$(line 5)\" == 'ok/7/0 - ' ]]"
assert "cut_load_config: окружение сильнее файла" "[[ \"\$(line 6)\" == 'env file ' ]]"

# 9. Стиль всех скриптов пакета.
for f in cutover.sh rollback.sh lib.sh; do
  assert "bash -n $f" "bash -n '$SRC_DIR/$f'"
  assert "$f: строки до $LIMIT знаков" "! awk 'length > $LIMIT' '$SRC_DIR/$f' | grep -q ."
done
for f in cutover.sh rollback.sh; do
  assert "set -euo pipefail в $f" "grep -q '^set -euo pipefail' '$SRC_DIR/$f'"
done
assert "строки теста до $LIMIT знаков" "! awk 'length > $LIMIT' '$0' | grep -q ."
SUDO_RE='curl[^|]*\| *(ba)?sh|^[^#]*\bsudo\b'
assert "в скриптах нет curl|sh и sudo" \
  "! grep -nE '$SUDO_RE' '$SRC_DIR'/cutover.sh '$SRC_DIR'/rollback.sh '$SRC_DIR'/lib.sh"

echo "проверок: $((PASS + FAIL)), провалено: $FAIL"
[[ "$FAIL" -eq 0 ]]
