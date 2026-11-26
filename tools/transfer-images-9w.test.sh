#!/usr/bin/env bash
# Тест tools/transfer-images-9w.sh (перенос образов патча G9w с Fornex на бой) без сети: вместо
# docker и ssh - заглушки. Проверяются разбор вызова, отказы до любых действий, --dry-run, вход в
# реестр только через stdin во временный DOCKER_CONFIG (удаляется при любом исходе, ключ не
# печатается), порядок pull -> tag -> save | ssh load -> проверка по digest и ID, ssh -n и
# BatchMode, повторный запуск, префикс команды docker, --images-tar и сбои на каждом шаге.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${TRANSFER9W_SCRIPT:-$HERE/transfer-images-9w.sh}"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP:?}"' EXIT
PASS=0
FAIL=0
LIMIT=100
IMAGES=4
EXIT_FAILED=1
EXIT_USAGE=2
EXIT_REFUSED=3
KEY_MARK="stub-registry-key-material-5501"

ok() { PASS=$((PASS + 1)); echo "PASS $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL $1"; }
assert() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
hex() { printf "%064d" 0 | tr 0 "$1"; }

BIN="$TMP/bin"
mkdir -p "$BIN"
# docker: метки - файл $STUB/tags (метка<TAB>ссылка), хост - $STUB/remote (ссылки).
cat >"$BIN/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$STUB/docker.log"
case "$1" in
  login)
    echo "${DOCKER_CONFIG:-<unset>}" >>"$STUB/login.config"
    cat >"$STUB/login.stdin"
    [[ "${STUB_LOGIN_FAIL:-0}" != 1 ]] || exit 1 ;;
  pull)
    echo "${DOCKER_CONFIG:-<unset>}" >>"$STUB/pull.config"
    [[ -z "${STUB_PULL_FAIL:-}" || "${*: -1}" != *"$STUB_PULL_FAIL"* ]] || exit 1 ;;
  tag)
    [[ "${STUB_TAG_FAIL:-0}" != 1 ]] || exit 1
    printf '%s\t%s\n' "$3" "$2" >>"$STUB/tags" ;;
  save)
    shift
    out=""
    if [[ "$1" == -o ]]; then out="$2"; shift 2; fi
    [[ "${STUB_SAVE_FAIL:-0}" != 1 ]] || { [[ -z "$out" ]] || echo part >"$out"; exit 1; }
    if [[ -n "$out" ]]; then
      mkdir -p "$STUB/pack"
      printf '%s\n' "$@" >"$STUB/pack/tags"
      if [[ "${STUB_TAR_GARBAGE:-0}" == 1 ]]; then echo garbage >"$out"
      else tar -cf "$out" -C "$STUB/pack" tags; fi
    else
      printf '%s\n' "$@"
    fi ;;
  image) echo "sha256:id-${*: -1}" ;;
esac
exit 0
STUB
cat >"$BIN/ssh" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$STUB/ssh.log"
while [[ "$1" == -* ]]; do
  if [[ "$1" == -o ]]; then shift; fi
  shift
done
shift # адрес
cmd="$*"
[[ "${STUB_SSH_DOWN:-0}" != 1 ]] || exit 255
case "$cmd" in
  *" info -f "*) echo "29.1.3" ;;
  *" load")
    [[ "${STUB_LOAD_FAIL:-0}" != 1 ]] || { cat >/dev/null; exit 1; }
    while IFS= read -r tag; do
      [[ "${STUB_LOAD_LOSES:-0}" == 1 ]] \
        || grep "^$tag"$'\t' "$STUB/tags" | tail -1 | cut -f2 >>"$STUB/remote"
    done ;;
  *" image inspect "*)
    ref="${cmd##* \'}"
    ref="${ref%\'}"
    grep -qxF "$ref" "$STUB/remote" || exit 1
    if [[ "${STUB_ID_MISMATCH:-0}" == 1 ]]; then echo "sha256:other"
    else echo "sha256:id-$ref"; fi ;;
  *) echo "неожиданная команда ssh: $cmd" >&2; exit 97 ;;
esac
exit 0
STUB
chmod +x "$BIN/docker" "$BIN/ssh"

APP="cr.yandex/crpx/pragmatika-app@sha256:$(hex 1)"
DOCS="cr.yandex/crpx/pragmatika-documents@sha256:$(hex 2)"
PSEUDO="cr.yandex/crpy/bai-pseudonymizer@sha256:$(hex 3)"
MASK="cr.yandex/crpy/bai-mask@sha256:$(hex 4)"
BASE="cr.yandex/crpx/pragmatika-app-base@sha256:$(hex 5)"
write_lock() {
  printf '%s\n' "BAI_VERSION=1.1.12-pragmatika.1" "BAI_IMAGE_APP=$APP" \
    "BAI_IMAGE_APP_BASE=$BASE" "BAI_IMAGE_DOCUMENTS=$DOCS" "BAI_IMAGE_PSEUDONYMIZER=$PSEUDO" \
    "BAI_IMAGE_MASK=$MASK" >"$1"
}
write_lock "$TMP/images.lock"
echo "$KEY_MARK" >"$TMP/key.json"

reset() {
  STUB="$TMP/stub"
  rm -rf "${STUB:?}"
  mkdir -p "$STUB/tmp"
  : >"$STUB/docker.log"
  : >"$STUB/ssh.log"
  : >"$STUB/remote"
  : >"$STUB/tags"
}
# run <аргументы>: код в RC, вывод в $TMP/out.
run() {
  RC=0
  env PATH="$BIN:$PATH" STUB="$STUB" HOME="$TMP/home" TMPDIR="$STUB/tmp" \
    timeout 60 bash "$SCRIPT" "$@" >"$TMP/out" 2>&1 || RC=$?
}
full() { run --lock "$TMP/images.lock" --key "$TMP/key.json" "$@"; }
count() { grep -cE -- "$2" "$STUB/$1" || true; }
quiet() { [[ ! -s "$STUB/docker.log" && ! -s "$STUB/ssh.log" ]]; }
no_login_left() { [[ -z "$(find "$STUB/tmp" -mindepth 1)" ]]; }

assert "bash -n" "bash -n '$SCRIPT'"
assert "строки не длиннее $LIMIT" \
  "LC_ALL=C.UTF-8 awk -v n=$LIMIT 'length(\$0) > n { bad = 1 } END { exit bad }' '$SCRIPT'"
reset
run --help
assert "--help: код 0, два способа получить права и --images-tar" \
  "[[ $RC -eq 0 ]] && grep -q 'NOPASSWD' '$TMP/out' && grep -q 'под root' '$TMP/out' \
   && grep -q -- '--images-tar' '$TMP/out' && ! grep -q 'set -euo' '$TMP/out'"

for args in "" "--bogus" "--host h --images-tar /tmp/x.tar" "--host -oProxyCommand=x" \
  "--host h;true" "--host h --docker docker;true" '--host h --docker $(true)'; do
  reset
  read -r -a argv <<<"$args"
  full "${argv[@]}"
  assert "вызов '$args': код 2, ничего не выполнялось" "[[ $RC -eq $EXIT_USAGE ]] && quiet"
done
reset
run --host root@h --lock "$TMP/none.lock"
assert "нет lock: код 3" "[[ $RC -eq $EXIT_REFUSED ]] && quiet"
for case_name in nokey tag registry quote; do
  write_lock "$TMP/bad.lock"
  case "$case_name" in
    nokey) sed -i '/^BAI_IMAGE_MASK=/d' "$TMP/bad.lock" ;;
    tag) sed -i 's|^BAI_IMAGE_APP=.*|BAI_IMAGE_APP=cr.yandex/crpx/app:latest|' "$TMP/bad.lock" ;;
    registry) sed -i "s|^BAI_IMAGE_APP=.*|BAI_IMAGE_APP=evil.example/app@sha256:$(hex 1)|" \
      "$TMP/bad.lock" ;;
    quote) sed -i "s|^BAI_IMAGE_APP=.*|BAI_IMAGE_APP=cr.yandex/a';x@sha256:$(hex 1)|" \
      "$TMP/bad.lock" ;;
  esac
  reset
  run --host root@h --lock "$TMP/bad.lock" --key "$TMP/key.json"
  assert "негодный lock ($case_name): код 3, ничего не выполнялось" \
    "[[ $RC -eq $EXIT_REFUSED ]] && quiet"
done

# --dry-run: ни одного вызова, ключ не нужен.
reset
run --host root@h --lock "$TMP/images.lock" --key "$TMP/none.json" --dry-run
assert "dry-run: код 0 без вызовов" "[[ $RC -eq 0 ]] && quiet"
assert "dry-run: четыре pull и проверки" \
  "[[ \$(grep -c 'docker pull ' '$TMP/out') -eq $IMAGES \
   && \$(grep -c 'image inspect' '$TMP/out') -eq $IMAGES ]]"
assert "dry-run: основы сборки не переносятся" "! grep -q 'app-base' '$TMP/out'"
reset
full --images-tar "$TMP/dry.tar" --dry-run
assert "dry-run с --images-tar: код 0, файла нет" \
  "[[ $RC -eq 0 && ! -e '$TMP/dry.tar' ]] && quiet && grep -q 'docker save -o' '$TMP/out'"

# Успешный перенос.
reset
full --host root@h
assert "перенос: код 0" "[[ $RC -eq 0 ]]"
assert "вход: cr.yandex, json_key, --password-stdin" \
  "grep -qx 'login cr.yandex -u json_key --password-stdin' '$STUB/docker.log'"
assert "вход: ключ подан на stdin" "cmp -s '$TMP/key.json' '$STUB/login.stdin'"
assert "ключ не в аргументах и не в выводе" \
  "! grep -qF '$KEY_MARK' '$STUB/docker.log' '$STUB/ssh.log' '$TMP/out'"
LOGIN_CONFIG="$(head -1 "$STUB/login.config")"
assert "вход во временный DOCKER_CONFIG, pull с ним же" \
  "[[ '$LOGIN_CONFIG' == '$STUB/tmp/'* ]] \
   && [[ \"\$(sort -u '$STUB/pull.config')\" == '$LOGIN_CONFIG' ]]"
assert "временный DOCKER_CONFIG удалён" "[[ ! -e '$LOGIN_CONFIG' ]] && no_login_left"
assert "четыре pull по digest" "[[ \$(count docker.log '^pull -q cr.yandex/.*@sha256:') -eq 4 ]]"
assert "метки :xfer-9w" "[[ \$(count docker.log '^tag .*@sha256:[0-9a-f]+ .*:xfer-9w$') -eq 4 ]]"
assert "четыре save по метке и четыре load" \
  "[[ \$(count docker.log '^save .*:xfer-9w$') -eq 4 && \$(count ssh.log ' docker load$') -eq 4 ]]"
assert "на хосте все четыре образа" \
  "[[ \"\$(sort '$STUB/remote')\" \
    == \"\$(printf '%s\n' '$APP' '$DOCS' '$PSEUDO' '$MASK' | sort)\" ]]"
assert "основы не передаются" "! grep -q 'app-base' '$STUB/docker.log' '$STUB/ssh.log'"
assert "все ssh с BatchMode=yes" \
  "[[ \$(grep -vc -- '-o BatchMode=yes' '$STUB/ssh.log' || true) -eq 0 ]]"
assert "ssh без -n только у docker load" \
  "! grep -v ' docker load$' '$STUB/ssh.log' | grep -qv '^-n ' \
   && ! grep ' docker load$' '$STUB/ssh.log' | grep -q '^-n '"
assert "проверка по digest после каждой загрузки" \
  "[[ \$(count ssh.log \"image inspect -f '\\{\\{.Id\\}\\}' 'cr.yandex\") -eq 8 ]]"

# Повторный запуск: всё уже на хосте.
: >"$STUB/docker.log"
: >"$STUB/ssh.log"
full --host root@h
assert "повтор: код 0, без pull, save и load" \
  "[[ $RC -eq 0 && \$(count docker.log '^(pull|save|tag) ') -eq 0 \
   && \$(count ssh.log ' load$') -eq 0 ]] && grep -q 'уже на хосте' '$TMP/out'"
# Один образ пропал на хосте: передаётся только он.
sed -i "\|^$MASK\$|d" "$STUB/remote"
: >"$STUB/docker.log"
full --host root@h
assert "повтор после пропажи mask: передан только он" \
  "[[ $RC -eq 0 && \$(count docker.log '^save ') -eq 1 \
   && \$(count docker.log '^save .*bai-mask:xfer-9w') -eq 1 ]]"

reset
full --host deploy@h --docker "sudo -n docker"
assert "префикс sudo: код 0, все команды хоста через него" \
  "[[ $RC -eq 0 ]] && ! grep -qv 'deploy@h sudo -n docker ' '$STUB/ssh.log'"

# Сбои.
reset
STUB_SSH_DOWN=1 full --host root@h
assert "хост недоступен: код 3, входа в реестр нет" \
  "[[ $RC -eq $EXIT_REFUSED ]] && [[ ! -s '$STUB/docker.log' ]]"
reset
run --host root@h --lock "$TMP/images.lock" --key "$TMP/none.json"
assert "нет ключа: код 3, входа нет" \
  "[[ $RC -eq $EXIT_REFUSED && \$(count docker.log '^login') -eq 0 ]]"
# fail_case <описание> <код> <фрагмент>: переменные STUB_* заданы перед вызовом.
fail_case() {
  reset
  full --host root@h
  assert "$1: код $2" "[[ $RC -eq $2 ]]"
  assert "$1: причина названа" "grep -q -- '$3' '$TMP/out'"
  assert "$1: временный DOCKER_CONFIG удалён" "no_login_left"
  assert "$1: нет сообщения об успехе" "! grep -q 'готово' '$TMP/out'"
}
STUB_LOGIN_FAIL=1 fail_case "вход не удался" "$EXIT_REFUSED" "вход в cr.yandex не удался"
STUB_PULL_FAIL=bai-mask fail_case "pull mask не удался" "$EXIT_FAILED" "docker pull"
STUB_TAG_FAIL=1 fail_case "tag не удался" "$EXIT_FAILED" "docker tag"
STUB_SAVE_FAIL=1 fail_case "save не удался" "$EXIT_FAILED" "передача не удалась"
STUB_LOAD_FAIL=1 fail_case "load на хосте не удался" "$EXIT_FAILED" "передача не удалась"
STUB_LOAD_LOSES=1 fail_case "по digest не находится" "$EXIT_FAILED" "не находится по digest"
STUB_ID_MISMATCH=1 fail_case "ID отличается" "$EXIT_FAILED" "ID образа на хосте отличается"

# --images-tar: один архив, без ssh.
reset
full --images-tar "$TMP/images-9w.tar"
assert "--images-tar: код 0, файл 600" \
  "[[ $RC -eq 0 && \$(stat -c %a '$TMP/images-9w.tar') == 600 ]]"
assert "--images-tar: один save -o с четырьмя метками, без ssh" \
  "[[ \$(count docker.log '^save ') -eq 1 && ! -s '$STUB/ssh.log' ]] \
   && [[ \$(tar -xOf '$TMP/images-9w.tar' tags | grep -c ':xfer-9w') -eq 4 ]]"
assert "--images-tar: sha256 и команда для боя" \
  "grep -q \"\$(sha256sum '$TMP/images-9w.tar' | cut -d' ' -f1)\" '$TMP/out' \
   && grep -q 'patch.sh --preflight-only --images-tar' '$TMP/out'"
assert "--images-tar: временных файлов нет" \
  "[[ ! -e '$TMP/images-9w.tar.part' ]] && no_login_left"
reset
full --images-tar "$TMP/images-9w.tar"
assert "--images-tar: существующий файл не перезаписывается" \
  "[[ $RC -eq $EXIT_REFUSED ]] && quiet"
reset
full --images-tar "$TMP/нет-каталога/x.tar"
assert "--images-tar: нет каталога - код 3" "[[ $RC -eq $EXIT_REFUSED ]] && quiet"
for knob in STUB_SAVE_FAIL STUB_TAR_GARBAGE; do
  reset
  export "$knob=1"
  full --images-tar "$TMP/$knob.tar"
  unset "$knob"
  assert "--images-tar, $knob: код 1, нет ни файла, ни части" \
    "[[ $RC -eq $EXIT_FAILED && ! -e '$TMP/$knob.tar' && ! -e '$TMP/$knob.tar.part' ]]"
done

# lock по умолчанию - рядом со скриптом (раскладка пакета).
mkdir -p "$TMP/pkg"
cp "$SCRIPT" "$TMP/pkg/transfer-images-9w.sh"
write_lock "$TMP/pkg/images.lock"
reset
RC=0
env PATH="$BIN:$PATH" STUB="$STUB" bash "$TMP/pkg/transfer-images-9w.sh" --host root@h --dry-run \
  >"$TMP/out" 2>&1 || RC=$?
assert "lock рядом со скриптом" "[[ $RC -eq 0 ]] && grep -q 'bai-mask@sha256' '$TMP/out'"

echo "----"
echo "PASS=$PASS FAIL=$FAIL"
((FAIL == 0))
