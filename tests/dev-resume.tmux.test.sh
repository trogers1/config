#!/usr/bin/env bash
# Real tmux transport + public dev CLI + actual lifecycle adapters. No LLM.
set -euo pipefail
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV="$REPO_DIR/tmux_and_worktrees/bin/dev"
REAL_TMUX="$(command -v tmux)"
TMP_DIR="$(cd "$(mktemp -d)" && pwd -P)"
export HOME="$TMP_DIR/home" XDG_STATE_HOME="$TMP_DIR/state"
export TEST_REPO_DIR="$REPO_DIR" TEST_DIR="$TMP_DIR"
SOCKET="dev-resume-test-$$"
cleanup() { "$REAL_TMUX" -L "$SOCKET" kill-server 2>/dev/null || true; rm -rf "$TMP_DIR"; }
trap cleanup EXIT
unset TMUX TMUX_PANE PI_SUBAGENT_DEPTH DEV_LIFECYCLE_LOCK_FD
mkdir -p "$HOME/bin" "$TMP_DIR/bin" "$TMP_DIR/project"
printf '#!/usr/bin/env bash\nexec "%s" "$@"\n' "$DEV" >"$HOME/bin/dev"
printf '#!/usr/bin/env bash\nexec "%s" -L "%s" -f "%s/tmux.conf" "$@"\n' "$REAL_TMUX" "$SOCKET" "$TMP_DIR" >"$TMP_DIR/bin/tmux"
printf 'set-option -g default-shell /bin/bash\n' >"$TMP_DIR/tmux.conf"
export PATH="$TMP_DIR/bin:$HOME/bin:$PATH"
printf 'export PATH=%q\n' "$PATH" >"$HOME/.bash_profile"
cat >"$TMP_DIR/bin/pi" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[ -z "${DEV_LIFECYCLE_LOCK_FD:-}" ] || { echo 'lifecycle lock marker leaked into agent' >&2; exit 1; }
if [ "$#" -ne 0 ]; then
    [ "$#" -eq 2 ] && [ "$1" = --session ] && [ "$2" = "$TEST_DIR/exact conversation.jsonl" ] || exit 1
fi
printf '%s\n' "$*" >"$TEST_DIR/pi-argv"
if [ "$#" -eq 0 ]; then
    node "$TEST_REPO_DIR/tests/dev-session.test.mjs" "$TEST_DIR/exact conversation.jsonl"
else
    node "$TEST_REPO_DIR/tests/dev-session.test.mjs" "$TEST_DIR/exact conversation.jsonl" "$TEST_DIR/post-resume.jsonl"
fi
EOF
chmod +x "$HOME/bin/dev" "$TMP_DIR/bin/tmux" "$TMP_DIR/bin/pi"
printf 'synthetic transcript fixture\n' >"$TMP_DIR/exact conversation.jsonl"
printf 'synthetic switched conversation fixture\n' >"$TMP_DIR/post-resume.jsonl"
cat >"$TMP_DIR/project/devConfig.jsonc" <<'EOF'
{"defaultAgent":"pi","agents":{"pi":"pi"},"windows":[{"name":"agent","agent":true},{"name":"shell"}]}
EOF
# Public new normally attaches. Supply a fake attach client only; every other
# tmux operation, including pane metadata and agent startup, reaches real tmux.
cp "$TMP_DIR/bin/tmux" "$TMP_DIR/bin/tmux-real"
cat >"$TMP_DIR/bin/tmux" <<'EOF'
#!/usr/bin/env bash
case "$1" in attach-session|switch-client) exit 0 ;; esac
exec "$(dirname "$0")/tmux-real" "$@"
EOF
chmod +x "$TMP_DIR/bin/tmux"
"$DEV" new "$TMP_DIR/project" >/dev/null
wait_for_binding() {
    local i
    for i in {1..100}; do
        if python3 - "$XDG_STATE_HOME/dev/sessions.json" "$TMP_DIR/project" "$1" <<'PY'
import json, sys
record = json.load(open(sys.argv[1]))["sessions"][sys.argv[2]]
raise SystemExit(0 if record["conversation"] is not None and record["conversation"]["session_id"] == sys.argv[3] else 1)
PY
        then return; fi
        sleep 0.1
    done
    echo 'FAIL: real tmux Pi lifecycle metadata not recorded' >&2
    tmux capture-pane -p -t project-dev:agent >&2
    exit 1
}
wait_for_binding pi-test-0
cp "$XDG_STATE_HOME/dev/sessions.json" "$TMP_DIR/before.json"
tmux kill-server
cmp "$TMP_DIR/before.json" "$XDG_STATE_HOME/dev/sessions.json"
rm "$TMP_DIR/pi-argv"
"$DEV" resume-all >/dev/null
wait_for_binding pi-test-1
python3 - "$XDG_STATE_HOME/dev/sessions.json" "$TMP_DIR/project" "$TMP_DIR/post-resume.jsonl" <<'PY'
import json, sys
assert json.load(open(sys.argv[1]))["sessions"][sys.argv[2]]["conversation"]["transcript_path"] == sys.argv[3]
PY
for i in {1..100}; do [ -f "$TMP_DIR/pi-argv" ] && break; sleep 0.1; done
[ "$(<"$TMP_DIR/pi-argv")" = "--session $TMP_DIR/exact conversation.jsonl" ] || { echo 'FAIL: wrong real tmux resume argv' >&2; exit 1; }
[ "$(tmux list-windows -t project-dev -F '#{window_name}' | wc -l | tr -d ' ')" = 2 ]
(cd "$TMP_DIR/project" && "$DEV" close >/dev/null)
python3 - "$XDG_STATE_HOME/dev/sessions.json" <<'PY'
import json, sys
assert not json.load(open(sys.argv[1]))["sessions"]
PY
printf 'real tmux dev resume tests passed\n'
