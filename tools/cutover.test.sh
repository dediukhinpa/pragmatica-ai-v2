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
DIGEST_C="cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
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
echo "SELECT 1;" >"$PKG/stack/db/app/rollback/021_down.sql"
echo "app/026_x" >"$PKG/expected-pending.txt"
printf '%s\n' "$FREEZE" >"$PKG/FREEZE_SRC"
# lock платформы 1.1.3: образ mask обязателен (сервис в базовом стеке без профиля).
printf 'BAI_VERSION=1.1.3\nBAI_IMAGE_APP=r/app@sha256:%s\nBAI_IMAGE_POSTGRES=r/pg@sha256:%s\n' \
  "$DIGEST_A" "$DIGEST_B" >"$PKG/images.lock"
printf 'BAI_IMAGE_MASK=r/mask@sha256:%s\n' "$DIGEST_C" >>"$PKG/images.lock"
echo "public-key" >"$PKG/cosign.pub"
cp "$ROOT/deploy/rehearsal/../cutover/expected-host-dirs.txt" "$PKG/" 2>/dev/null \
  || echo "ACCESS_POLICY_HOST_DIR=/opt/pragmatika/local/access" >"$PKG/expected-host-dirs.txt"
for f in cutover.sh rollback.sh lib.sh; do cp "$SRC_DIR/$f" "$PKG/$f"; done
(cd "$PKG" && find . -type f ! -name MANIFEST.sha256 | sort | sed 's|^\./||' \
  | xargs -d '\n' sha256sum >MANIFEST.sha256)

LOCK_SHA="$(sha256sum "$PKG/images.lock" | cut -d' ' -f1)"
PUB_SHA="$(sha256sum "$PKG/cosign.pub" | cut -d' ' -f1)"
make_sigs() { # make_sigs <файл> <result> [digest app] [lock]: строка на каждый образ lock
  local lock="${4:-$PKG/images.lock}" key ref
  printf '# verify-signatures v1\nlock_sha256=%s\npubkey_sha256=%s\ncosign=v3\n' \
    "$(sha256sum "$lock" | cut -d' ' -f1)" "$PUB_SHA" >"$1"
  printf 'verified_at=2026-11-14T08:00:00Z\n' >>"$1"
  while IFS='=' read -r key ref; do
    [[ "$key" == BAI_IMAGE_* ]] || continue
    if [[ "$key" == BAI_IMAGE_APP && -n "${3:-}" ]]; then ref="r/app@sha256:$3"; fi
    printf 'image\t%s\t%s\tOK\n' "$key" "$ref" >>"$1"
  done <"$lock"
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
    bash "${PKG_RUN:-$PKG}/cutover.sh" "$@" >"$TMP/out-$name" 2>&1 || RC=$?
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
assert "подписи приняты" "grep -q 'подтверждены подписи 3 образов' '$TMP/out-sigok'"
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

# 5d. Платформа 1.1.3: образ mask (BAI_IMAGE_MASK) обязателен в lock, отказ до любых изменений.
PKG_NOMASK="$TMP/pkg-nomask"
cp -a "$PKG" "$PKG_NOMASK"
grep -v '^BAI_IMAGE_MASK=' "$PKG/images.lock" >"$PKG_NOMASK/images.lock"
(cd "$PKG_NOMASK" && find . -type f ! -name MANIFEST.sha256 | sort | sed 's|^\./||' \
  | xargs -d '\n' sha256sum >MANIFEST.sha256)
make_sigs "$TMP/sigs.nomask" OK "" "$PKG_NOMASK/images.lock"
PKG_RUN="$PKG_NOMASK" run nomask --signatures-verified "$TMP/sigs.nomask"
assert "lock без BAI_IMAGE_MASK - код 3" "[[ $RC -eq $EXIT_REFUSED ]]"
assert "отказ называет BAI_IMAGE_MASK и платформу 1.1.3" \
  "grep -q 'BAI_IMAGE_MASK' '$TMP/out-nomask' && grep -q '1\.1\.3' '$TMP/out-nomask'"
assert "lock без mask: бой не тронут" "no_mutation nomask"
assert "lock без mask: отказ раньше проверки подписей и боевого .env" \
  "! grep -q 'подписи образов' '$TMP/out-nomask' && ! grep -q 'боевой .env' '$TMP/out-nomask'"
assert "lock с mask: проверка lock проходит" \
  "grep -q 'проверка images.lock и обратные' '$TMP/out-sigok'"
LOCK_LIB="$(bash -c "
source '$SRC_DIR/lib.sh'
printf 'BAI_VERSION=1\nBAI_IMAGE_MASK=r/m@sha256:$DIGEST_A\n' >'$TMP/m1'
printf 'BAI_VERSION=1\nBAI_IMAGE_APP=r/a@sha256:$DIGEST_A\n' >'$TMP/m2'
printf 'BAI_VERSION=1\nBAI_IMAGE_MASK=r/m:latest\n' >'$TMP/m3'
for n in 1 2 3; do cut_lock_has_mask '$TMP/m'\$n && echo -n ok || echo -n no; done; echo
" 2>&1 || true)"
assert "cut_lock_has_mask: с digest да, без ключа и с тегом нет" "[[ \"\$LOCK_LIB\" == *oknono ]]"

# 5e. MASK_TOKEN: платформа 1.1.3 требует его (compose без токена не стартует). Нет или пуст -
# генерируется в secrets.mask.env дерева выкатки (600), значение не печатается; заданное не
# меняется; в secrets.env боя токен переносится только после успешного хода.
# h_run <имя>: тело - со stdin; bash с lib.sh, каталог $TMP/h-<имя> (d), вывод в out-h-<имя>.
h_run() {
  local d="$TMP/h-$1"
  mkdir -p "$d/new/deploy" "$d/sec"
  {
    printf 'set -euo pipefail\nsource %q\n' "$SRC_DIR/lib.sh"
    printf 'd=%q; SRC_DIR=%q\ncut_init_run "$d/run"\n' "$d" "$SRC_DIR"
    printf 'CUTOVER_NEW_DIR="$d/new"; CUTOVER_SECRETS_DIR="$d/sec"; CUTOVER_EXTRA_ENV=""\n'
    printf 'CUTOVER_ENV_FILE="$d/battle.env"; touch "$CUTOVER_ENV_FILE"\n'
    cat
  } >"$d/h.sh"
  RC=0
  bash "$d/h.sh" >"$TMP/out-h-$1" 2>&1 || RC=$?
}
tok_of() { { sed -n 's/^MASK_TOKEN=//p' "$1" 2>/dev/null || true; } | tail -1; }
h_secrets() { # h_secrets <имя> <содержимое secrets.env>: файл боя и ссылка в дереве выкатки
  local d="$TMP/h-$1"
  mkdir -p "$d/new/deploy" "$d/sec"
  printf '%b' "$2" >"$d/sec/secrets.env"
  ln -sfn "$d/sec/secrets.env" "$d/new/deploy/secrets.env"
}
SIDE_NAME="secrets.mask.env"

h_run mt1 <<'BODY'
cut_ensure_mask_token
BODY
D="$TMP/h-mt1"; SIDE="$D/new/deploy/$SIDE_NAME"; T1="$(tok_of "$SIDE")"
assert "MASK_TOKEN нигде нет: токен сгенерирован в secrets.mask.env выкатки" \
  "[[ $RC -eq 0 && -f '$SIDE' ]]"
assert "сгенерированный токен: права 600, 64 hex-символа" \
  "[[ \"\$(stat -c %a '$SIDE')\" == 600 ]] && grep -qE '^MASK_TOKEN=[0-9a-f]{64}\$' '$SIDE'"
assert "значение токена не попало в журнал, проверки, состояние и вывод" \
  "[[ -n '$T1' ]] && ! grep -rqF '$T1' '$D/run/results' '$D/run/state.env' '$TMP/out-h-mt1'"
assert "значение токена внесено в список секретов (маскирование журнала и проверка архива)" \
  "[[ -n '$T1' ]] && grep -qxF '$T1' '$D/run/secrets.list'"
assert "в состоянии записан источник токена (без значения)" \
  "grep -q '^MASK_TOKEN_SOURCE=' '$D/run/state.env'"

h_secrets mt2 'POSTGRES_PASSWORD=pgpass-value-1234\nMASK_TOKEN=given-token-value-0123456789\n'
SHA_MT2="$(sha256sum "$TMP/h-mt2/sec/secrets.env" | cut -d' ' -f1)"
h_run mt2 <<'BODY'
cut_ensure_mask_token
BODY
assert "MASK_TOKEN задан в secrets.env: не генерируется, файла выкатки нет" \
  "[[ $RC -eq 0 && ! -e '$TMP/h-mt2/new/deploy/$SIDE_NAME' ]]"
assert "заданный secrets.env не изменён ни байтом" \
  "[[ \"\$(sha256sum '$TMP/h-mt2/sec/secrets.env' | cut -d' ' -f1)\" == '$SHA_MT2' ]]"
assert "заданное значение не печатается" \
  "! grep -rqF 'given-token-value' '$TMP/h-mt2/run/results' '$TMP/out-h-mt2'"

h_secrets mt3 'A=1\nMASK_TOKEN=\nB=2\n'
h_run mt3 <<'BODY'
cut_ensure_mask_token
BODY
assert "пустой MASK_TOKEN в secrets.env: токен генерируется" \
  "[[ $RC -eq 0 && -f '$TMP/h-mt3/new/deploy/$SIDE_NAME' ]]"
assert "до успеха хода secrets.env боя не тронут" \
  "[[ \"\$(cat '$TMP/h-mt3/sec/secrets.env')\" == \$'A=1\nMASK_TOKEN=\nB=2' ]]"

mkdir -p "$TMP/h-mt4/new/deploy"
printf 'MASK_TOKEN=from-env-value-0123456789\n' >"$TMP/h-mt4/new/deploy/.env"
h_run mt4 <<'BODY'
cut_ensure_mask_token
BODY
assert "MASK_TOKEN задан в .env выкатки: не генерируется" \
  "[[ $RC -eq 0 && ! -e '$TMP/h-mt4/new/deploy/$SIDE_NAME' ]]"

h_run mt5 <<'BODY'
cut_ensure_mask_token
BODY
T5="$(tok_of "$TMP/h-mt5/new/deploy/$SIDE_NAME")"
h_run mt5 <<'BODY'
cut_ensure_mask_token
BODY
assert "повторный запуск: токен выкатки переиспользуется, не меняется" \
  "[[ -n '$T5' && \"\$(tok_of '$TMP/h-mt5/new/deploy/$SIDE_NAME')\" == '$T5' \
   && \"\$(wc -l <'$TMP/h-mt5/new/deploy/$SIDE_NAME')\" -eq 1 ]]"
assert "повторный запуск: токен снова в списке секретов" \
  "[[ -n '$T5' ]] && grep -qxF '$T5' '$TMP/h-mt5/run/secrets.list'"

h_secrets mt6 'A=1\nMASK_TOKEN=\nB=2\n'
chmod 640 "$TMP/h-mt6/sec/secrets.env"
h_run mt6 <<'BODY'
cut_ensure_mask_token
cut_persist_mask_token
BODY
SEC6="$TMP/h-mt6/sec/secrets.env"; T6="$(tok_of "$SEC6")"
assert "перенос в secrets.env: пустая строка заменена, порядок и соседи целы" \
  "[[ $RC -eq 0 && \"\$(sed -n 1p '$SEC6')\" == A=1 && \"\$(sed -n 3p '$SEC6')\" == B=2 \
   && \"\$(sed -n 2p '$SEC6')\" =~ ^MASK_TOKEN=[0-9a-f]{64}\$ \
   && \"\$(grep -c '^MASK_TOKEN=' '$SEC6')\" -eq 1 ]]"
assert "перенос: права secrets.env сохранены, файл выкатки убран" \
  "[[ \"\$(stat -c %a '$SEC6')\" == 640 && ! -e '$TMP/h-mt6/new/deploy/$SIDE_NAME' ]]"
assert "перенос: значение не печатается" \
  "[[ -n '$T6' ]] && ! grep -rqF '$T6' '$TMP/h-mt6/run/results' '$TMP/h-mt6/run/state.env' \
   '$TMP/out-h-mt6'"

h_secrets mt7 'A=1'
h_run mt7 <<'BODY'
cut_ensure_mask_token
cut_persist_mask_token
BODY
assert "перенос: ключ дописан с новой строки, если файл без перевода строки" \
  "[[ \"\$(sed -n 1p '$TMP/h-mt7/sec/secrets.env')\" == A=1 \
   && \"\$(sed -n 2p '$TMP/h-mt7/sec/secrets.env')\" =~ ^MASK_TOKEN=[0-9a-f]{64}\$ ]]"

h_secrets mt8 'MASK_TOKEN=other-value-0123456789\n'
printf 'MASK_TOKEN=side-value-0123456789\n' >"$TMP/h-mt8/new/deploy/$SIDE_NAME"
h_run mt8 <<'BODY'
cut_persist_mask_token
BODY
assert "перенос: другой заданный токен в secrets.env не перезаписывается, файл выкатки цел" \
  "[[ $RC -eq 0 && \"\$(cat '$TMP/h-mt8/sec/secrets.env')\" == MASK_TOKEN=other-value-0123456789 \
   && -f '$TMP/h-mt8/new/deploy/$SIDE_NAME' ]]"
assert "перенос при расхождении: предупреждение в проверках" \
  "grep -q 'warn' '$TMP/h-mt8/run/results/checks.tsv'"

h_secrets mt9 'A=1\n'
printf 'MASK_TOKEN=side-value-0123456789\n' >"$TMP/h-mt9/new/deploy/$SIDE_NAME"
chmod 400 "$TMP/h-mt9/sec/secrets.env"
h_run mt9 <<'BODY'
cut_persist_mask_token
BODY
if [[ $EUID -ne 0 ]]; then
  assert "перенос: secrets.env не на запись - не сбой, токен остаётся в файле выкатки" \
    "[[ $RC -eq 0 && -f '$TMP/h-mt9/new/deploy/$SIDE_NAME' \
     && \"\$(cat '$TMP/h-mt9/sec/secrets.env')\" == A=1 ]] \
     && grep -q 'warn' '$TMP/h-mt9/run/results/checks.tsv'"
fi
chmod 600 "$TMP/h-mt9/sec/secrets.env"

h_secrets mt10 'A=1\nMASK_TOKEN=\n'
h_run mt10 <<'BODY'
cut_ensure_mask_token
cut_new_env_args
echo "ARGS:${NEW_ENV_ARGS[*]}"
BODY
assert "файл токена идёт в окружении compose после secrets.env (перекрывает пустую строку)" \
  "grep -qE 'ARGS:.*deploy/secrets\.env --env-file [^ ]*/secrets\.mask\.env' '$TMP/out-h-mt10'"

# Список секретов маскирования читает и файл токена выкатки (cutover.sh и rollback.sh).
h_secrets mc 'A=1\n'
printf 'MASK_TOKEN=side-value-0123456789\n' >"$TMP/h-mc/new/deploy/$SIDE_NAME"
h_run mc <<'BODY'
eval "$(sed -n '/^collect_secret_values() {/,/^}/p' "$SRC_DIR/cutover.sh")"
collect_secret_values
BODY
assert "cutover.sh: маскирование журнала знает токен из файла выкатки" \
  "grep -qxF 'side-value-0123456789' '$TMP/h-mc/run/secrets.list'"
h_run mr <<'BODY'
printf 'MASK_TOKEN=side-value-0123456789\n' >"$d/new/deploy/secrets.mask.env"
eval "$(sed -n '/^collect_secrets() {/,/^}/p' "$SRC_DIR/rollback.sh")"
collect_secrets
BODY
assert "rollback.sh: маскирование журнала знает токен из файла выкатки" \
  "grep -qxF 'side-value-0123456789' '$TMP/h-mr/run/secrets.list'"
assert "rollback.sh токен не удаляет и не правит: в коде нет операций над MASK_TOKEN" \
  "! grep -vE '^[[:space:]]*#' '$SRC_DIR/rollback.sh' | grep -qw 'MASK_TOKEN'"
assert "токен в secrets.env с прежним compose не мешает: dc_old читает файл как есть" \
  "grep -q 'secrets_dir/secrets.env' '$SRC_DIR/lib.sh'"

# Место вызовов в ходе: токен готов до проверки конфигурации, переносится после проверок.
assert "prepare_tree создаёт токен до записи метки выкатки" \
  "sed -n '/^prepare_tree() {/,/^}/p' '$SRC_DIR/cutover.sh' \
   | awk '/cut_ensure_mask_token/{a=NR} /DEPLOYED_MARK\"/{b=NR} END{exit !(a && b && a<b)}'"
assert "main: перенос токена в secrets.env только после verify_v2 и до RESULT OK" \
  "sed -n '/^main() {/,/^}/p' '$SRC_DIR/cutover.sh' \
   | awk '/^  verify_v2\$/{a=NR} /^  cut_persist_mask_token\$/{b=NR} /RESULT OK/{c=NR} \
          END{exit !(a && b && c && a<b && b<c)}'"

# 5f. Порядок старта и ожидание mask (в базовом стеке без профиля, healthcheck в compose нет).
h_run svc1 <<'BODY'
eval "$(sed -n '/^service_list() {/,/^}/p' "$SRC_DIR/cutover.sh")"
dc_new() { printf '%s\n' app mask indexer postgres pseudonymizer documents embeddings \
  gateway-mtls alloy docker-socket-proxy migrate; }
service_list | tr '\n' ' '; echo
BODY
POS_OK='{for (i = 1; i <= NF; i++) pos[$i] = i} END{exit !(pos["mask"] && pos["app"] == NF'
assert "service_list: mask запускается (без профиля) до indexer, app последним" \
  "awk '$POS_OK && pos[\"mask\"] < pos[\"indexer\"])}' '$TMP/out-h-svc1'"
h_run svc2 <<'BODY'
eval "$(sed -n '/^service_list() {/,/^}/p' "$SRC_DIR/cutover.sh")"
CUTOVER_SERVICES="postgres mask app"
service_list | tr '\n' ' '; echo
BODY
assert "урезанный стенд с mask: postgres, mask, app" \
  "grep -qx 'postgres mask app ' '$TMP/out-h-svc2'"
assert "start_v2 после mask ждёт его /health (в compose healthcheck у mask нет)" \
  "sed -n '/^start_v2() {/,/^}/p' '$SRC_DIR/cutover.sh' | grep -q 'cut_wait_mask_ready'"
# Заглушка docker: счётчик проб в файле (docker run вызывается в подоболочке).
MASK_STUB='sleep() { :; }; POLL_S=1
probes() { if [[ -f "$d/probes" ]]; then wc -l <"$d/probes"; else echo 0; fi; }
docker() { case "$1" in inspect) echo "${STATE:-running}" ;;
  run) echo x >>"$d/probes"
    if (($(probes) >= ${OK_AT:-3})); then echo "200 {}"; else echo "нет"; return 1; fi ;;
  esac; }'
h_run mw1 <<BODY
$MASK_STUB
cut_wait_mask_ready pragmatika-mask-1 r/app 30 && echo "rc=0 probes=\$(probes)"
BODY
assert "ожидание mask: ответ 200 на /health после нескольких проб - успех" \
  "grep -q 'rc=0 probes=3' '$TMP/out-h-mw1'"
h_run mw2 <<BODY
$MASK_STUB
OK_AT=99
cut_wait_mask_ready pragmatika-mask-1 r/app 5 || echo "rc=1 probes=\$(probes)"
BODY
assert "ожидание mask: нет ответа за срок - отказ (не пропускается молча)" \
  "grep -q 'rc=1 probes=5' '$TMP/out-h-mw2'"
h_run mw3 <<BODY
$MASK_STUB
STATE=exited
cut_wait_mask_ready pragmatika-mask-1 r/app 30 || echo "rc=1 probes=\$(probes)"
BODY
assert "ожидание mask: контейнер упал - отказ сразу, без проб" \
  "grep -q 'rc=1 probes=0' '$TMP/out-h-mw3'"

# 5g. Память: лимит mask 1536 МиБ входит в запас (порог CUTOVER_MIN_AVAILABLE_MIB не менялся).
DEFAULTS_LIB="$(bash -c "source '$SRC_DIR/lib.sh'; cut_defaults
  echo \"\$CUTOVER_MIN_AVAILABLE_MIB \$CUTOVER_MASK_MEM_MIB\"" 2>&1 || true)"
assert "умолчания: порог 2048 прежний, mask 1536" "[[ \"\$DEFAULTS_LIB\" == '2048 1536' ]]"
mem_run() { # mem_run <имя> <MemAvailable МиБ> [сервисы] [CUTOVER_MASK_MEM_MIB]
  H_MEM="$2" H_SERVICES="${3:-}" H_MASKMEM="${4:-}" h_run "$1" <<'BODY'
eval "$(sed -n '/^version_ge() {/p;/^check_resources() {/,/^}/p' "$SRC_DIR/cutover.sh")"
MIN_COMPOSE_VERSION=2.24; DISK_FACTOR_FOR_DB=3
refuse() { echo "REFUSE: $*"; exit 3; }
docker() { case "$1" in compose) echo 2.40.3 ;; exec) echo 1048576 ;; info) echo / ;; esac; }
dir_free_mib() { echo 999999; }
mem_available_mib() { echo "$H_MEM"; }
[[ -z "$H_MASKMEM" ]] || CUTOVER_MASK_MEM_MIB="$H_MASKMEM"
CUTOVER_SERVICES="$H_SERVICES"
cut_defaults
touch "$d/backup.sh" "$d/old.yml"
CUTOVER_BACKUP_SCRIPT="$d/backup.sh"; CUTOVER_OLD_COMPOSE="$d/old.yml"
CUTOVER_BACKUP_ROOT="$d/bk"; PG_USER=u; PG_DB=d
check_resources
BODY
}
mem_run mem1 3000
assert "память 3000 МиБ при полном стеке: отказ (порог 2048 + mask 1536)" "[[ $RC -eq 3 ]]"
assert "отказ называет mask и 1536" \
  "grep -q 'mask' '$TMP/out-h-mem1' && grep -q '1536' '$TMP/out-h-mem1'"
mem_run mem2 4000
assert "память 4000 МиБ при полном стеке: проходит" \
  "[[ $RC -eq 0 ]] && grep -q 'проверка ресурсы: ok' '$TMP/out-h-mem2'"
mem_run mem3 3000 "postgres pseudonymizer app"
assert "урезанный стенд без mask: 3000 МиБ проходит (1536 не требуется)" "[[ $RC -eq 0 ]]"
mem_run mem4 3000 "" 0
assert "CUTOVER_MASK_MEM_MIB=0 отключает добавку (решение владельца)" "[[ $RC -eq 0 ]]"

# 5h. IMAGE_SEND_PHOTO: пакет его не задаёт (умолчание проекта v2 - false), только сообщает.
bk_run ispset "IMAGE_SEND_PHOTO=false"$'\n'
assert "IMAGE_SEND_PHOTO в боевом .env: значение названо, переносится как есть" \
  "grep -q 'проверка IMAGE_SEND_PHOTO: ok - задан в боевом .env: false' '$TMP/out-ispset'"
bk_run ispunset ""
assert "IMAGE_SEND_PHOTO не задан: названо умолчание проекта v2 false" \
  "grep -q 'проверка IMAGE_SEND_PHOTO: ok - не задан' '$TMP/out-ispunset' \
   && grep -q 'умолчание проекта v2 false' '$TMP/out-ispunset'"
assert "пакет не записывает IMAGE_SEND_PHOTO в .env v2" \
  "! grep -E 'printf.*IMAGE_SEND_PHOTO|IMAGE_SEND_PHOTO.*>>' \
   '$SRC_DIR/cutover.sh' '$SRC_DIR/lib.sh'"

# 5i. Документы пакета: что добавилось с платформой 1.1.3.
CK="$SRC_DIR/CHECKLIST.md"
RD="$SRC_DIR/README.md"
assert "CHECKLIST/README: платформа 1.1.3, прежней 1.1.2 нет" \
  "grep -q '1\.1\.3' '$CK' && grep -q '1\.1\.3' '$RD' && ! grep -q '1\.1\.2' '$CK' '$RD'"
assert "CHECKLIST: mask, MASK_TOKEN без печати, +1536 МиБ" \
  "grep -q 'BAI_IMAGE_MASK' '$CK' && grep -q 'MASK_TOKEN' '$CK' && grep -q '1536' '$CK' \
   && grep -q 'не печата' '$CK'"
assert "CHECKLIST: строка решения владельца про IMAGE_SEND_PHOTO с пустым местом" \
  "grep -q 'значение IMAGE_SEND_PHOTO решено владельцем: ' '$CK' \
   && grep -q 'false = прежнее поведение текстом' '$CK'"
assert "CHECKLIST: VISION_ROUTE_ENABLED касается только шлюза pragmatika-gw" \
  "grep -q 'VISION_ROUTE_ENABLED' '$CK' && grep -q 'pragmatika-gw' '$CK'"
assert "README: mask в составе стека и порядок запуска" \
  "grep -q 'mask' '$RD' && grep -q 'MASK_TOKEN' '$RD'"

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
