#!/usr/bin/env bash
# Exercise setup's official-installer boundary with no network or real installs.
set -euo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
REAL_NODE="$(command -v node)"
REAL_PYTHON="$(command -v python3)"
REAL_ZSH="$(command -v zsh)"
PI_MINIMUM="$("$REAL_PYTHON" -c 'import re,sys; print(re.search(r"pi_minimum=\"([^\"]+)\"", open(sys.argv[1]).read())[1])' "$REPO_DIR/setup.sh")"
export PI_MINIMUM
BIN="$TEMP/bin"
mkdir -p "$BIN"
# Controlled PATH cannot accidentally find the developer's real global Pi.
for directory in /usr/bin /bin; do
  for command in "$directory"/*; do
    name="${command##*/}"
    [ "$name" = pi ] || [ -e "$BIN/$name" ] || ln -s "$command" "$BIN/$name"
  done
done
for name in node python3 uname npm tmux curl sh; do rm -f "$BIN/$name"; done
ln -s "$REAL_PYTHON" "$BIN/python3"
cat >"$BIN/node" <<EOF
#!/bin/bash
[ "\${1:-}" != --version ] || { echo "\${TEST_NODE_VERSION:-v22.19.0}"; exit 0; }
exec "$REAL_NODE" "\$@"
EOF
cat >"$BIN/uname" <<'EOF'
#!/bin/bash
echo "${TEST_PLATFORM:-Linux}"
EOF
cat >"$BIN/npm" <<'EOF'
#!/bin/bash
exit 0
EOF
cat >"$BIN/tmux" <<'EOF'
#!/bin/bash
echo 'tmux 3.5a'
EOF
cat >"$BIN/playwright" <<'EOF'
#!/bin/bash
echo /cache/chromium-1234
EOF
cat >"$BIN/curl" <<'EOF'
#!/bin/bash
printf 'download\n' >>"$HOME/calls"
[ "${TEST_DOWNLOAD_FAIL:-0}" = 0 ] || exit 22
[ "$5" = https://pi.dev/install.sh ] && [ "$6" = --output ] || exit 2
printf '%s\n' "$7" >"$HOME/download-path"
printf 'fake official installer\n' >"$7"
EOF
cat >"$BIN/sh" <<'EOF'
#!/bin/bash
printf 'install\n' >>"$HOME/calls"
[ "$(<"$1")" = 'fake official installer' ] || exit 2
[ "$PI_LEGACY_INSTALL" = 0 ] || exit 3
[ "${TEST_INSTALL_FAIL:-0}" = 0 ] || exit 4
[ "${TEST_INSTALL_NOOP:-0}" = 0 ] || exit 0
mkdir -p "$PI_CODING_AGENT_DIR/bin" "$PI_CODING_AGENT_DIR/install"
printf '#!/bin/bash\necho %s\n' "$PI_MINIMUM" >"$PI_CODING_AGENT_DIR/bin/pi"
chmod +x "$PI_CODING_AGENT_DIR/bin/pi"
printf '{"kind":"pi-managed-install","schemaVersion":1,"layout":"releases-v1"}\n' >"$PI_CODING_AGENT_DIR/install/managed-install.json"
printf '%s\n' "$PI_MINIMUM" >"$PI_CODING_AGENT_DIR/install/current-version"
EOF
chmod +x "$BIN"/{node,uname,npm,tmux,playwright,curl,sh}
run_setup() {
  HOME="$CASE_HOME" TMPDIR="$CASE_HOME/tmp" PATH="$BIN" PLAYWRIGHT_BIN="$BIN/playwright" XDG_STATE_HOME="$CASE_HOME/state" /bin/bash "$REPO_DIR/setup.sh" "$@" >"$TEMP/output" 2>&1
}
new_case() { CASE_HOME="$TEMP/$1"; mkdir -p "$CASE_HOME/tmp"; }
check_cleaned() {
  [ -z "$(/bin/ls -A "$CASE_HOME/tmp")" ] || fail 'installer temporary directory was not cleaned up'
}

new_case existing
printf '#!/bin/bash\necho %s\n' "$PI_MINIMUM" >"$BIN/pi"
chmod +x "$BIN/pi"
run_setup --dry-run || { /bin/cat "$TEMP/output"; fail 'existing Pi rejected'; }
[ ! -e "$CASE_HOME/calls" ] || fail 'existing Pi triggered installer'
printf '#!/bin/bash\necho 0.85.0\n' >"$BIN/pi"
if run_setup; then fail 'outdated existing Pi accepted'; fi
[ ! -e "$CASE_HOME/calls" ] || fail 'outdated Pi was replaced'
rm "$BIN/pi"

new_case dry-run
run_setup --dry-run || { /bin/cat "$TEMP/output"; fail 'missing Pi dry-run failed'; }
[ ! -e "$CASE_HOME/calls" ] || fail 'dry-run downloaded installer'
[ ! -e "$CASE_HOME/.pi" ] || fail 'dry-run installed Pi'

new_case node-too-old
if TEST_NODE_VERSION=v20.0.0 run_setup; then fail 'obsolete Node accepted'; fi
[ ! -e "$CASE_HOME/calls" ] || fail 'installer ran before Node preflight'

new_case missing-node
mv "$BIN/node" "$TEMP/node"
if run_setup; then fail 'missing Node accepted'; fi
mv "$TEMP/node" "$BIN/node"
[ ! -e "$CASE_HOME/calls" ] || fail 'installer ran without Node'

new_case missing-npm
mv "$BIN/npm" "$TEMP/npm"
if run_setup; then fail 'missing npm accepted'; fi
mv "$TEMP/npm" "$BIN/npm"
[ ! -e "$CASE_HOME/calls" ] || fail 'installer ran without npm'

new_case conflict
mkdir -p "$CASE_HOME/.pi/agent/bin"
printf 'foreign executable\n' >"$CASE_HOME/.pi/agent/bin/pi"
if run_setup; then fail 'off-PATH conflict accepted'; fi
[ ! -e "$CASE_HOME/calls" ] || fail 'conflicting executable was replaced'
[ "$(<"$CASE_HOME/.pi/agent/bin/pi")" = 'foreign executable' ] || fail 'foreign executable changed'

new_case partial-install
mkdir -p "$CASE_HOME/.pi/agent/install"
if run_setup; then fail 'partial managed installation accepted'; fi
[ ! -e "$CASE_HOME/calls" ] || fail 'partial installation was replaced'

new_case download-failure
if TEST_DOWNLOAD_FAIL=1 run_setup; then fail 'failed download accepted'; fi
[ "$(<"$CASE_HOME/calls")" = download ] || fail 'installer executed after download failed'
check_cleaned
[ ! -e "$CASE_HOME/.pi/agent/settings.json" ] || fail 'configuration changed after download failure'

new_case installer-failure
if TEST_INSTALL_FAIL=1 run_setup; then fail 'failed installer accepted'; fi
check_cleaned
[ ! -e "$CASE_HOME/.pi/agent/settings.json" ] || fail 'configuration changed after installer failure'

new_case installer-noop
if TEST_INSTALL_NOOP=1 run_setup; then fail 'installer without launcher accepted'; fi
check_cleaned
[ ! -e "$CASE_HOME/.pi/agent/settings.json" ] || fail 'configuration changed after installer no-op'

new_case unsupported
if TEST_PLATFORM=FreeBSD run_setup; then fail 'unsupported platform accepted'; fi
[ ! -e "$CASE_HOME/calls" ] || fail 'unsupported platform ran installer'

for platform in Darwin Linux; do
  new_case "installed-$platform"
  TEST_PLATFORM="$platform" run_setup --non-interactive || { /bin/cat "$TEMP/output"; fail 'managed installation failed'; }
  [ "$(<"$CASE_HOME/calls")" = $'download\ninstall' ] || fail 'expected one official installer invocation'
  [ -L "$CASE_HOME/.pi/agent/settings.json" ] || fail 'setup did not continue after installation'
  check_cleaned
  # A new interactive shell must load only the installed shared .zshrc, not
  # inherit setup's PATH or depend on the personal .zshenv configuration.
  [ ! -e "$CASE_HOME/.zshenv" ] || fail 'fresh fixture unexpectedly has personal zshenv'
  HOME="$CASE_HOME" ZDOTDIR="$CASE_HOME" PATH="$BIN" PI_CODING_AGENT_DIR= "$REAL_ZSH" -ic '
    set -eu
    managed="$HOME/.pi/agent/bin"
    [[ "$(command -v pi)" == "$managed/pi" ]]
    [[ "$(pi --version)" == "$PI_MINIMUM" ]]
    for version in old new; do
      node_bin="$HOME/node-$version"
      mkdir -p "$node_bin"
      printf "#!/bin/sh\\nexit 0\\n" >"$node_bin/node"
      cp "$node_bin/node" "$node_bin/pi"
      chmod +x "$node_bin/node" "$node_bin/pi"
      path=("$node_bin" "${path[@]}")
      # Directory changes exercise the installed hook after an nvm-like switch.
      cd "$HOME"
      [[ "$(command -v pi)" == "$managed/pi" ]]
      [[ "$(command -v node)" == "$node_bin/node" ]]
    done
    export PI_CODING_AGENT_DIR="$HOME/custom-agent"
    mkdir -p "$PI_CODING_AGENT_DIR/bin"
    cp "$managed/pi" "$PI_CODING_AGENT_DIR/bin/pi"
    cd "$HOME"
    [[ "$(command -v pi)" == "$PI_CODING_AGENT_DIR/bin/pi" ]]
    [[ "$(command -v node)" == "$node_bin/node" ]]
  ' >"$TEMP/shell-output" 2>&1 || { /bin/cat "$TEMP/shell-output"; fail 'fresh shared shell did not preserve managed Pi PATH'; }
done
printf 'managed Pi setup tests passed\n'
