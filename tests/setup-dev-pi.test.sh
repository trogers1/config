#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
assert_exists() { [ -e "$1" ] || [ -L "$1" ] || fail "expected $1 to exist"; }
assert_absent() { [ ! -e "$1" ] && [ ! -L "$1" ] || fail "expected $1 to be absent"; }
assert_equals() { [ "$1" = "$2" ] || fail "expected '$1', got '$2'"; }

FAKE_BIN="$TMP_DIR/tool-bin"
HOME_DIR="$TMP_DIR/home"
mkdir -p "$FAKE_BIN" "$HOME_DIR"
for command_name in uname git python3 tmux pi node npm npx nvim lazygit; do
  cat >"$FAKE_BIN/$command_name" <<EOF
#!/usr/bin/env bash
case "$command_name" in
  uname) echo Darwin ;;
  pi) echo 0.85.0 ;;
  node) echo v22.19.0 ;;
  *) exit 0 ;;
esac
EOF
  chmod +x "$FAKE_BIN/$command_name"
done

cat >"$FAKE_BIN/playwright" <<'EOF'
#!/usr/bin/env bash
[ "$1" = install ] && [ "$2" = --list ] && printf 'chromium 1234\n'
EOF
chmod +x "$FAKE_BIN/playwright"

run_setup() {
  HOME="$HOME_DIR" PATH="$FAKE_BIN:$PATH" PLAYWRIGHT_BIN="$FAKE_BIN/playwright" "$REPO_DIR/setup-dev-pi.sh" "$@"
}

mkdir -p "$HOME_DIR/bin"
printf 'user-owned Pi wrapper\n' >"$HOME_DIR/bin/pi"
run_setup
assert_equals "$(readlink "$HOME_DIR/.pi/agent/settings.json")" "$REPO_DIR/home/.pi/agent/settings.json"
assert_equals "$(cat "$HOME_DIR/bin/pi")" 'user-owned Pi wrapper'
assert_exists "$HOME_DIR/bin/dnew"
assert_absent "$HOME_DIR/bin/wnew"
grep -Fq '# >>> dev-pi installer zsh >>>' "$HOME_DIR/.zshrc" || fail 'missing zsh block'
grep -Fq '# >>> dev-pi installer tmux >>>' "$HOME_DIR/.tmux.conf" || fail 'missing tmux block'

# A rerun must not create backups or mutate ownership.
run_setup
assert_absent "$HOME_DIR/bin/dnew.bak"

# Uninstall removes owned artifacts created without prior conflicts.
run_setup --uninstall
assert_absent "$HOME_DIR/.pi/agent/settings.json"
assert_absent "$HOME_DIR/bin/dnew"
grep -Fq '# >>> dev-pi installer zsh >>>' "$HOME_DIR/.zshrc" && fail 'zsh block was not removed'

# Dry-run reports actions but does not create a target.
rm -f "$HOME_DIR/bin/pi"
run_setup --dry-run >/dev/null
assert_absent "$HOME_DIR/bin/dnew"

# A noninteractive conflict must fail without replacing the user's file.
mkdir -p "$HOME_DIR/.pi/agent"
printf 'original settings\n' >"$HOME_DIR/.pi/agent/settings.json"
if run_setup --non-interactive >/dev/null 2>&1; then
  fail 'noninteractive conflict unexpectedly succeeded'
fi
assert_equals "$(cat "$HOME_DIR/.pi/agent/settings.json")" 'original settings'
assert_absent "$HOME_DIR/.pi/agent/settings.json.bak"

printf 'setup-dev-pi tests passed\n'
