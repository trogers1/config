#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
assert_exists() { [ -e "$1" ] || [ -L "$1" ] || fail "expected $1 to exist"; }
assert_absent() { [ ! -e "$1" ] && [ ! -L "$1" ] || fail "expected $1 to be absent"; }
assert_equals() { [ "$1" = "$2" ] || fail "expected '$2', got '$1'"; }

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
[ "${1:-}" = install ] && [ "${2:-}" = --list ] && printf '/cache/ms-playwright/chromium-1234\n'
EOF
chmod +x "$FAKE_BIN/playwright"

run_shared() {
  HOME="$HOME_DIR" PATH="$FAKE_BIN:$PATH" PLAYWRIGHT_BIN="$FAKE_BIN/playwright" "$REPO_DIR/setup.sh" "$@"
}
run_personal() {
  HOME="$HOME_DIR" PATH="$FAKE_BIN:$PATH" "$REPO_DIR/setup-personal.sh" "$@"
}

# Shared install owns only its explicit resources and preserves user profiles.
mkdir -p "$HOME_DIR/.pi/agent/pi-guard" "$HOME_DIR/bin"
printf 'user profile\n' >"$HOME_DIR/.pi/agent/pi-guard/profiles.jsonc"
printf 'user pi command\n' >"$HOME_DIR/bin/pi"
run_shared >/dev/null
run_shared --verify >/dev/null
assert_equals "$(cat "$HOME_DIR/.pi/agent/pi-guard/profiles.jsonc")" 'user profile'
assert_equals "$(cat "$HOME_DIR/bin/pi")" 'user pi command'
assert_exists "$HOME_DIR/bin/dev"
assert_exists "$HOME_DIR/bin/tmux-status-action"
assert_absent "$HOME_DIR/bin/dnew"

# Verification is derived from every declared category and exact block content.
rm "$HOME_DIR/.pi/agent/packages/pi-usage"
if run_shared --verify >/dev/null 2>&1; then fail 'verify missed package drift'; fi
ln -s "$REPO_DIR/home/.pi/agent/packages/pi-usage" "$HOME_DIR/.pi/agent/packages/pi-usage"
printf 'drifted wrapper\n' >"$HOME_DIR/bin/tmux-status-action"
if run_shared --verify >/dev/null 2>&1; then fail 'verify missed wrapper drift'; fi
rm "$HOME_DIR/bin/tmux-status-action"
run_shared >/dev/null
python3 - "$HOME_DIR/.zshrc" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
path.write_text(path.read_text().replace('export PATH="$HOME/bin:$PATH"', 'export PATH="/drifted"'))
PY
if run_shared --verify >/dev/null 2>&1; then fail 'verify missed managed-block drift'; fi
# Reinstall replaces the drifted block only after preserving the old file.
rm -f "$HOME_DIR/.zshrc.bak"
# Noninteractive correctly refuses the required update; restore the known install for lifecycle testing.
if run_shared --non-interactive >/dev/null 2>&1; then fail 'drifted block was replaced noninteractively'; fi
rm "$HOME_DIR/.zshrc"
run_shared >/dev/null
run_shared --uninstall >/dev/null
assert_absent "$HOME_DIR/.pi/agent/settings.json"
assert_absent "$HOME_DIR/bin/dev"
assert_equals "$(cat "$HOME_DIR/.pi/agent/pi-guard/profiles.jsonc")" 'user profile'
rm "$HOME_DIR/.pi/agent/pi-guard/profiles.jsonc"

# Personal preflight examines all conflicts before creating the first link.
rm -f "$HOME_DIR/.zshrc" "$HOME_DIR/.tmux.conf"
printf 'foreign zsh\n' >"$HOME_DIR/.zshrc"
printf 'existing backup\n' >"$HOME_DIR/.zshrc.bak"
if run_personal --non-interactive >/dev/null 2>&1; then fail 'personal conflict unexpectedly succeeded'; fi
assert_absent "$HOME_DIR/.bash_profile"
assert_equals "$(cat "$HOME_DIR/.zshrc")" 'foreign zsh'
rm "$HOME_DIR/.zshrc" "$HOME_DIR/.zshrc.bak"

run_personal >/dev/null
run_personal --verify >/dev/null
assert_equals "$(readlink "$HOME_DIR/.zshrc")" "$REPO_DIR/home/.zshrc"
assert_equals "$(readlink "$HOME_DIR/.config/nvim")" "$REPO_DIR/xdg/nvim"
assert_equals "$(readlink "$HOME_DIR/.pi/agent/pi-guard/profiles.jsonc")" "$REPO_DIR/home/.pi/agent/pi-guard/profiles.jsonc"
assert_equals "$(readlink "$HOME_DIR/.pi/agent/pi-guard/prompts")" "$REPO_DIR/home/.pi/agent/pi-guard/prompts"
# Shared setup recognizes personal shell links and never edits their repository targets.
zsh_before="$(cksum "$REPO_DIR/home/.zshrc")"
tmux_before="$(cksum "$REPO_DIR/home/.tmux.conf")"
run_shared >/dev/null
run_shared --verify >/dev/null
assert_equals "$(cksum "$REPO_DIR/home/.zshrc")" "$zsh_before"
assert_equals "$(cksum "$REPO_DIR/home/.tmux.conf")" "$tmux_before"
run_personal --uninstall >/dev/null
assert_absent "$HOME_DIR/.config/nvim"

# Exact wrapper and block ownership includes executable mode and unique markers.
chmod -x "$HOME_DIR/bin/dev"
if run_shared --verify >/dev/null 2>&1; then fail 'verify accepted a non-executable wrapper'; fi
chmod +x "$HOME_DIR/bin/dev"
printf '\n' >>"$HOME_DIR/bin/dev"
if run_shared --verify >/dev/null 2>&1; then fail 'verify accepted trailing wrapper bytes'; fi
rm "$HOME_DIR/bin/dev"
run_shared >/dev/null
run_shared >/dev/null
printf '%s\nduplicate\n%s\n' '# >>> setup shared zsh >>>' '# <<< setup shared zsh <<<' >>"$HOME_DIR/.zshrc"
if run_shared --verify >/dev/null 2>&1; then fail 'verify accepted duplicate managed block markers'; fi
rm "$HOME_DIR/.zshrc"
run_shared >/dev/null
# An arbitrary later .bak is never promoted during uninstall.
printf 'foreign backup\n' >"$HOME_DIR/bin/dev.bak"
BLOCK_BACKUP_TARGET="$TMP_DIR/external-zsh-backup"
printf 'external backup\n' >"$BLOCK_BACKUP_TARGET"
rm -f "$HOME_DIR/.zshrc.bak"
ln -s "$BLOCK_BACKUP_TARGET" "$HOME_DIR/.zshrc.bak"
run_shared --uninstall >/dev/null
assert_absent "$HOME_DIR/bin/dev"
assert_equals "$(cat "$HOME_DIR/bin/dev.bak")" 'foreign backup'
[ -L "$HOME_DIR/.zshrc.bak" ] || fail 'block backup symlink was promoted or removed'
assert_equals "$(cat "$BLOCK_BACKUP_TARGET")" 'external backup'

# Nested resources are never inspected through a foreign symlink ancestor.
ANCESTOR_HOME="$TMP_DIR/ancestor-home"
FOREIGN_PACKAGES="$TMP_DIR/foreign-packages"
mkdir -p "$ANCESTOR_HOME/.pi/agent" "$FOREIGN_PACKAGES"
printf 'sentinel\n' >"$FOREIGN_PACKAGES/pi-usage"
ln -s "$FOREIGN_PACKAGES" "$ANCESTOR_HOME/.pi/agent/packages"
if HOME="$ANCESTOR_HOME" PATH="$FAKE_BIN:$PATH" PLAYWRIGHT_BIN="$FAKE_BIN/playwright" "$REPO_DIR/setup.sh" >/dev/null 2>&1; then
  fail 'shared setup accepted a foreign symlink ancestor'
fi
assert_equals "$(cat "$FOREIGN_PACKAGES/pi-usage")" sentinel

# Personal lifecycle operations also reject linked target ancestors.
PERSONAL_ANCESTOR_HOME="$TMP_DIR/personal-ancestor-home"
PERSONAL_FOREIGN_CONFIG="$TMP_DIR/personal-foreign-config"
mkdir -p "$PERSONAL_ANCESTOR_HOME" "$PERSONAL_FOREIGN_CONFIG"
ln -s "$PERSONAL_FOREIGN_CONFIG" "$PERSONAL_ANCESTOR_HOME/.config"
ln -s "$REPO_DIR/xdg/nvim" "$PERSONAL_FOREIGN_CONFIG/nvim"
if HOME="$PERSONAL_ANCESTOR_HOME" PATH="$FAKE_BIN:$PATH" "$REPO_DIR/setup-personal.sh" --uninstall >/dev/null 2>&1; then
  fail 'personal uninstall accepted a foreign symlink ancestor'
fi
[ -L "$PERSONAL_FOREIGN_CONFIG/nvim" ] || fail 'personal uninstall removed an external link'

# Migration validates every file and backup before splitting the guard link.
BAD_HOME="$TMP_DIR/bad-legacy-home"
mkdir -p "$BAD_HOME/.pi/agent"
ln -s "$REPO_DIR/home/.pi/agent/pi-guard" "$BAD_HOME/.pi/agent/pi-guard"
printf '%s\nunterminated\n' '# >>> dev worktree shell integration >>>' >"$BAD_HOME/.zshrc"
if HOME="$BAD_HOME" "$REPO_DIR/scripts/setup/migrate-legacy.sh" >/dev/null 2>&1; then fail 'migration accepted malformed markers'; fi
[ -L "$BAD_HOME/.pi/agent/pi-guard" ] || fail 'malformed migration partially split guard link'
printf '%s\n' '# >>> dev worktree shell integration <<<' >"$BAD_HOME/.zshrc"
if HOME="$BAD_HOME" "$REPO_DIR/scripts/setup/migrate-legacy.sh" >/dev/null 2>&1; then fail 'migration accepted crossed marker syntax'; fi
[ -L "$BAD_HOME/.pi/agent/pi-guard" ] || fail 'crossed marker migration partially split guard link'
printf '%s\nold\n%s\n' '# >>> dev worktree shell integration >>>' '# <<< dev worktree shell integration <<<' >"$BAD_HOME/.zshrc"
printf '%s\nold\n%s\n' '# >>> dev worktree config >>>' '# <<< dev worktree config <<<' >"$BAD_HOME/.tmux.conf"
printf 'occupied\n' >"$BAD_HOME/.tmux.conf.legacy.bak"
if HOME="$BAD_HOME" "$REPO_DIR/scripts/setup/migrate-legacy.sh" >/dev/null 2>&1; then fail 'migration overwrote an existing backup'; fi
[ -L "$BAD_HOME/.pi/agent/pi-guard" ] || fail 'backup conflict partially split guard link'
grep -Fq 'dev worktree shell integration' "$BAD_HOME/.zshrc" || fail 'backup conflict partially edited zsh'

MIGRATION_ANCESTOR_HOME="$TMP_DIR/migration-ancestor-home"
MIGRATION_EXTERNAL_BIN="$TMP_DIR/migration-external-bin"
mkdir -p "$MIGRATION_ANCESTOR_HOME" "$MIGRATION_EXTERNAL_BIN"
ln -s "$MIGRATION_EXTERNAL_BIN" "$MIGRATION_ANCESTOR_HOME/bin"
printf 'external wrapper\n' >"$MIGRATION_EXTERNAL_BIN/dnew"
if HOME="$MIGRATION_ANCESTOR_HOME" "$REPO_DIR/scripts/setup/migrate-legacy.sh" >/dev/null 2>&1; then
  fail 'migration accepted a linked bin ancestor'
fi
assert_equals "$(cat "$MIGRATION_EXTERNAL_BIN/dnew")" 'external wrapper'

# Legacy state is rejected without mutation, then migrated explicitly.
LEGACY_HOME="$TMP_DIR/legacy-home"
mkdir -p "$LEGACY_HOME/.pi/agent" "$LEGACY_HOME/bin"
ln -s "$REPO_DIR/home/.pi/agent/pi-guard" "$LEGACY_HOME/.pi/agent/pi-guard"
printf '%s\nold\n%s\n' '# >>> dev worktree shell integration >>>' '# <<< dev worktree shell integration <<<' >"$LEGACY_HOME/.zshrc"
printf '%s\nold\n%s\n' '# >>> dev worktree config >>>' '# <<< dev worktree config <<<' >"$LEGACY_HOME/.tmux.conf"
cat >"$LEGACY_HOME/bin/dnew" <<EOF
#!/bin/bash
set -euo pipefail

# Wrapper script so the real command runs from the repo path,
# which keeps shared helper sourcing simple and symlink-free.
exec "$REPO_DIR/tmux_and_worktrees/bin/dnew" "\$@"
EOF
profile_before="$(cksum "$REPO_DIR/home/.pi/agent/pi-guard/profiles.jsonc")"
if HOME="$LEGACY_HOME" PATH="$FAKE_BIN:$PATH" PLAYWRIGHT_BIN="$FAKE_BIN/playwright" "$REPO_DIR/setup.sh" >/dev/null 2>&1; then
  fail 'shared setup accepted legacy state'
fi
[ -L "$LEGACY_HOME/.pi/agent/pi-guard" ] || fail 'legacy detection mutated the guard link'
HOME="$LEGACY_HOME" "$REPO_DIR/scripts/setup/migrate-legacy.sh" >/dev/null
[ ! -L "$LEGACY_HOME/.pi/agent/pi-guard" ] || fail 'migration did not split the guard link'
assert_exists "$LEGACY_HOME/.pi/agent/pi-guard/profiles.jsonc"
assert_absent "$LEGACY_HOME/bin/dnew"
assert_exists "$LEGACY_HOME/.zshrc.legacy.bak"
grep -Fq 'dev worktree' "$LEGACY_HOME/.zshrc" && fail 'legacy zsh block remained'
assert_equals "$(cksum "$REPO_DIR/home/.pi/agent/pi-guard/profiles.jsonc")" "$profile_before"

# Empty legacy profiles are files too and must survive the split.
MIGRATION_REPO="$TMP_DIR/migration-repo"
EMPTY_HOME="$TMP_DIR/empty-profile-home"
mkdir -p "$MIGRATION_REPO/scripts/setup" "$MIGRATION_REPO/home/.pi/agent/pi-guard" "$EMPTY_HOME/.pi/agent"
cp "$REPO_DIR/scripts/setup/migrate-legacy.sh" "$MIGRATION_REPO/scripts/setup/migrate-legacy.sh"
: >"$MIGRATION_REPO/home/.pi/agent/pi-guard/profiles.jsonc"
ln -s "$MIGRATION_REPO/home/.pi/agent/pi-guard" "$EMPTY_HOME/.pi/agent/pi-guard"
HOME="$EMPTY_HOME" "$MIGRATION_REPO/scripts/setup/migrate-legacy.sh" >/dev/null
[ -f "$EMPTY_HOME/.pi/agent/pi-guard/profiles.jsonc" ] || fail 'empty profile file was lost'
[ ! -s "$EMPTY_HOME/.pi/agent/pi-guard/profiles.jsonc" ] || fail 'empty profile file changed'

printf 'setup tests passed\n'
