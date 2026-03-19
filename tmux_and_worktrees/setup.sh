#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN_SRC_DIR="$SCRIPT_DIR/bin"
BIN_DEST_DIR="$HOME/bin"
ZPROFILE="$HOME/.zprofile"
TMUX_CONF="$HOME/.tmux.conf"
TMUX_WORKTREE_LINK="$HOME/.tmux.worktree.conf"
BIN_COMMANDS=()

for command_path in "$BIN_SRC_DIR"/*; do
    [ -f "$command_path" ] || continue
    BIN_COMMANDS+=("$(basename "$command_path")")
done

mkdir -p "$BIN_DEST_DIR"

rm -f "$BIN_DEST_DIR/dev-wt-new" "$BIN_DEST_DIR/dev-wt-close" "$BIN_DEST_DIR/dev-wt-merge" "$BIN_DEST_DIR/dev-local"

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
ln -sfn "$SCRIPT_DIR/tmux-worktree.conf" "$TMUX_WORKTREE_LINK"

for command_name in "${BIN_COMMANDS[@]}"; do
    chmod +x "$BIN_SRC_DIR/$command_name"
done

if [ ! -f "$ZPROFILE" ]; then
    touch "$ZPROFILE"
fi

# Refresh alias block on every run so removed aliases get cleaned up.
tmp_file="$(mktemp)"
awk '
    BEGIN { skip = 0 }
    /^# >>> dev worktree aliases >>>$/ { skip = 1; next }
    /^# <<< dev worktree aliases <<</ { skip = 0; next }
    /^# >>> dev worktree dhome >>>$/ { skip = 1; next }
    /^# <<< dev worktree dhome <<</ { skip = 0; next }
    skip == 0 { print }
' "$ZPROFILE" > "$tmp_file"
mv "$tmp_file" "$ZPROFILE"

if ! grep -q "# >>> local bin path >>>" "$ZPROFILE"; then
    cat >> "$ZPROFILE" <<'EOF'
# >>> local bin path >>>
export PATH="$HOME/bin:$PATH"
# <<< local bin path <<<
EOF
fi

cat >> "$ZPROFILE" <<'EOF'

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

if [ ! -f "$TMUX_CONF" ]; then
    touch "$TMUX_CONF"
fi

if ! grep -q "source-file ~/.tmux.worktree.conf" "$TMUX_CONF"; then
    cat >> "$TMUX_CONF" <<'EOF'

# >>> dev worktree config >>>
source-file ~/.tmux.worktree.conf
# <<< dev worktree config <<<
EOF
fi

echo "Installed:"
for command_name in "${BIN_COMMANDS[@]}"; do
    echo "  $BIN_DEST_DIR/$command_name -> wrapper for $BIN_SRC_DIR/$command_name"
done
echo "  $TMUX_WORKTREE_LINK -> $SCRIPT_DIR/tmux-worktree.conf"
echo "Legacy alias block removed from $ZPROFILE (if present)."
echo "dhome shell function refreshed in $ZPROFILE."
echo "PATH update added to $ZPROFILE (if missing)."
echo "Tmux source line added to $TMUX_CONF (if missing)."
echo "Open a new shell or run: source ~/.zprofile"
echo "Reload tmux: tmux source-file ~/.tmux.conf"
