#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN_SRC_DIR="$SCRIPT_DIR/bin"
BIN_DEST_DIR="$HOME/bin"
ZSHRC="$HOME/.zshrc"
TMUX_CONF="$HOME/.tmux.conf"
TMUX_WORKTREE_LINK="$HOME/.tmux.worktree.conf"
BIN_COMMANDS=()
ZSHRC_MARKER="# >>> dev worktree dhome >>>"
TMUX_CONF_MARKER="# >>> dev worktree config >>>"

printf '\nSetting up your tmux-worktree flow...\n'

warn_red() {
  printf '\033[31m%s\033[0m\n' "$1" >&2
}

resolve_target_path() {
  python3 -c 'import os, sys; path = sys.argv[1]; print(os.path.realpath(path) if os.path.lexists(path) else path)' "$1"
}

prompt_backup_or_skip() {
  local target_path="$1"
  local backup_path="$2"
  local label="$3"
  local reply

  if [ ! -r /dev/tty ]; then
    warn_red "Found pre-existing $label config at $target_path, but no interactive prompt is available. Skipping."
    return 1
  fi

  while true; do
    printf 'Found pre-existing %s config at %s. Shall I back it up to %s and still update this config (y/Y) or skip this one (n/N)? ' "$label" "$target_path" "$backup_path" > /dev/tty
    read -r reply < /dev/tty

    case "$reply" in
      y|Y)
        return 0
        ;;
      n|N)
        return 1
        ;;
      *)
        printf 'Please answer y or n.\n' > /dev/tty
        ;;
    esac
  done
}

prepare_edit_target() {
  local target_path="$1"
  local marker="$2"
  local label="$3"
  local backup_path

  if [ ! -e "$target_path" ]; then
    touch "$target_path"
    return 0
  fi

  if grep -Fq "$marker" "$target_path"; then
    return 0
  fi

  backup_path="$target_path.bak"

  if ! prompt_backup_or_skip "$target_path" "$backup_path" "$label"; then
    return 1
  fi

  if [ -e "$backup_path" ] || [ -L "$backup_path" ]; then
    warn_red "Failed to update $target_path: backup path already exists at $backup_path"
    return 1
  fi

  cp -p "$target_path" "$backup_path"
  printf 'Backed up existing %s to %s\n' "$target_path" "$backup_path"
}

safe_symlink() {
  local source_path="$1"
  local target_path="$2"

  if [ -e "$target_path" ] && [ ! -L "$target_path" ]; then
    printf '\033[31m%s\033[0m\n' "Failed to symlink $source_path -> $target_path: destination already exists and is not a symlink" >&2
    exit 1
  fi

  ln -sfn "$source_path" "$target_path"

  if [ ! -L "$target_path" ]; then
    printf '\033[31m%s\033[0m\n' "Failed to symlink $source_path -> $target_path: destination is not a symlink after linking" >&2
    exit 1
  fi
}

for command_path in "$BIN_SRC_DIR"/*; do
  [ -f "$command_path" ] || continue
  BIN_COMMANDS+=("$(basename "$command_path")")
done

mkdir -p "$BIN_DEST_DIR"

rm -f "$BIN_DEST_DIR/dev-wt-new" "$BIN_DEST_DIR/dev-wt-close" "$BIN_DEST_DIR/dev-wt-merge" "$BIN_DEST_DIR/dev-local" "$BIN_DEST_DIR/pi"

for command_name in "${BIN_COMMANDS[@]}"; do
  rm -f "$BIN_DEST_DIR/$command_name"
  cat > "$BIN_DEST_DIR/$command_name" <<EOF
#!/bin/bash
set -euo pipefail

# Wrapper script so the real command runs from the repo path,
# which keeps shared helper sourcing simple and symlink-free.
exec "$BIN_SRC_DIR/$command_name" "\$@"
EOF
chmod +x "$BIN_DEST_DIR/$command_name"
done
safe_symlink "$SCRIPT_DIR/tmux-worktree.conf" "$TMUX_WORKTREE_LINK"

for command_name in "${BIN_COMMANDS[@]}"; do
  chmod +x "$BIN_SRC_DIR/$command_name"
done

ZSHRC_TARGET="$(resolve_target_path "$ZSHRC")"
TMUX_CONF_TARGET="$(resolve_target_path "$TMUX_CONF")"

if prepare_edit_target "$ZSHRC_TARGET" "$ZSHRC_MARKER" "zshrc"; then
  # Refresh alias block on every run so removed aliases get cleaned up.
  tmp_file="$(mktemp)"
  awk '
BEGIN { skip = 0 }
/^# >>> dev worktree aliases >>>$/ { skip = 1; next }
/^# <<< dev worktree aliases <<</ { skip = 0; next }
/^# >>> dev worktree dhome >>>$/ { skip = 1; next }
/^# <<< dev worktree dhome <<</ { skip = 0; next }
skip == 0 { print }
' "$ZSHRC_TARGET" > "$tmp_file"
  mv "$tmp_file" "$ZSHRC_TARGET"

  if ! grep -q "# >>> local bin path >>>" "$ZSHRC_TARGET"; then
    cat >> "$ZSHRC_TARGET" <<'EOF'
# >>> local bin path >>>
export PATH="$HOME/bin:$PATH"
# <<< local bin path <<<
EOF
  fi

  cat >> "$ZSHRC_TARGET" <<'EOF'
# >>> dev worktree dhome >>>
dhome() {
    local env_line=""
    local target=""

    if [ -z "${TMUX:-}" ]; then
        echo "dhome is only available in a tmux dev session"
        return 1
    fi

    env_line="$(tmux show-environment DTREE_WORKTREE_PATH 2>/dev/null || true)"
    case "$env_line" in
      DTREE_WORKTREE_PATH=*)
            target="${env_line#DTREE_WORKTREE_PATH=}"
            ;;
        esac

    if [ -z "$target" ]; then
        echo "dhome is only available in a tmux dev session"
        return 1
    fi

    cd "$target"
}
# <<< dev worktree dhome <<<
EOF
else
  echo "Skipped updates to $ZSHRC"
fi

if prepare_edit_target "$TMUX_CONF_TARGET" "$TMUX_CONF_MARKER" "tmux"; then
  if ! grep -q "source-file ~/.tmux.worktree.conf" "$TMUX_CONF_TARGET"; then
    cat >> "$TMUX_CONF_TARGET" <<'EOF'

# >>> dev worktree config >>>
source-file ~/.tmux.worktree.conf
# <<< dev worktree config <<<
EOF
  fi
else
  echo "Skipped updates to $TMUX_CONF"
fi

echo "Installed:"
for command_name in "${BIN_COMMANDS[@]}"; do
  echo "  $BIN_DEST_DIR/$command_name -> wrapper for $BIN_SRC_DIR/$command_name"
done
echo "  $TMUX_WORKTREE_LINK -> $SCRIPT_DIR/tmux-worktree.conf"
echo "Legacy alias block removed from $ZSHRC (if present)."
echo "dhome shell function refreshed in $ZSHRC."
echo "PATH update added to $ZSHRC (if missing)."
echo "Tmux source line added to $TMUX_CONF (if missing)."
echo "Open a new shell or run: source ~/.zshrc"
echo "Reload tmux: tmux source-file ~/.tmux.conf"
