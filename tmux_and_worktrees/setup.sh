#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BIN_SRC_DIR="$SCRIPT_DIR/bin"
BIN_DEST_DIR="$HOME/bin"
ZPROFILE="$HOME/.zprofile"
TMUX_CONF="$HOME/.tmux.conf"
TMUX_WORKTREE_LINK="$HOME/.tmux.worktree.conf"

mkdir -p "$BIN_DEST_DIR"

ln -sfn "$BIN_SRC_DIR/dev-wt-new" "$BIN_DEST_DIR/dev-wt-new"
ln -sfn "$BIN_SRC_DIR/dev-wt-merge" "$BIN_DEST_DIR/dev-wt-merge"
ln -sfn "$BIN_SRC_DIR/dev-local" "$BIN_DEST_DIR/dev-local"
ln -sfn "$BIN_SRC_DIR/dev-local" "$BIN_DEST_DIR/dnew"

ln -sfn "$BIN_SRC_DIR/dev-wt-new" "$BIN_DEST_DIR/dtree"
ln -sfn "$SCRIPT_DIR/tmux-worktree.conf" "$TMUX_WORKTREE_LINK"

chmod +x "$BIN_SRC_DIR/dev-wt-new"
chmod +x "$BIN_SRC_DIR/dev-wt-merge"
chmod +x "$BIN_SRC_DIR/dev-local"

if [ ! -f "$ZPROFILE" ]; then
    touch "$ZPROFILE"
fi

# Refresh alias block on every run so changes stay in sync.
tmp_file="$(mktemp)"
awk '
    BEGIN { skip = 0 }
    /^# >>> dev worktree aliases >>>$/ { skip = 1; next }
    /^# <<< dev worktree aliases <<</ { skip = 0; next }
    skip == 0 { print }
' "$ZPROFILE" > "$tmp_file"
mv "$tmp_file" "$ZPROFILE"

cat >> "$ZPROFILE" <<'EOF'
# >>> dev worktree aliases >>>
alias dnew='dev-local'
alias dtree='dev-wt-new'
alias dmerge='dev-wt-merge'
# <<< dev worktree aliases <<<
EOF

if ! grep -q "# >>> local bin path >>>" "$ZPROFILE"; then
    cat >> "$ZPROFILE" <<'EOF'
# >>> local bin path >>>
export PATH="$HOME/bin:$PATH"
# <<< local bin path <<<
EOF
fi

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
echo "  $BIN_DEST_DIR/dev-wt-new -> $BIN_SRC_DIR/dev-wt-new"
echo "  $BIN_DEST_DIR/dev-wt-merge -> $BIN_SRC_DIR/dev-wt-merge"
echo "  $BIN_DEST_DIR/dev-local -> $BIN_SRC_DIR/dev-local"
echo "  $BIN_DEST_DIR/dnew -> $BIN_SRC_DIR/dev-local"
echo "  $BIN_DEST_DIR/dtree -> $BIN_SRC_DIR/dev-wt-new"
echo "  $TMUX_WORKTREE_LINK -> $SCRIPT_DIR/tmux-worktree.conf"
echo "Aliases added to $ZPROFILE (if missing)."
echo "PATH update added to $ZPROFILE (if missing)."
echo "Tmux source line added to $TMUX_CONF (if missing)."
echo "Open a new shell or run: source ~/.zprofile"
echo "Reload tmux: tmux source-file ~/.tmux.conf"
