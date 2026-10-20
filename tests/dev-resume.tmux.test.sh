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
# Fresh initial input crosses the real tmux shell boundary. A deliberately
# nonstandard agent window and an unrelated shell must never receive raw input.
CHECK="$REPO_DIR/tests/fixtures/dev-launch-check.py"
export DEV_TEST_RECEIPTS="$TMP_DIR/receipts.jsonl"
: >"$DEV_TEST_RECEIPTS"
rm "$TMP_DIR/bin/pi"
for agent in pi claude; do
    printf '#!/usr/bin/env bash\nexec python3 %q %q "$@"\n' "$REPO_DIR/tests/fixtures/dev-launch-agent.py" "$agent" >"$TMP_DIR/bin/$agent"
    chmod +x "$TMP_DIR/bin/$agent"
done
cat >"$TMP_DIR/expected-prompt" <<'EOF'
--leading-option λ 雪 'single' "double" `touch "$TEST_DIR/injected-backtick"`
$(touch "$TEST_DIR/injected-substitution") ; touch "$TEST_DIR/injected-semicolon"

  preserve leading whitespace and a trailing newline
EOF
wait_for_receipt() {
    local i
    for i in {1..80}; do
        if python3 "$CHECK" receipts "$DEV_TEST_RECEIPTS" "$TMP_DIR/expected-prompt" "$1" "$2" "${3:-cockpit}" 2>/dev/null; then return; fi
        sleep 0.05
    done
    echo "FAIL: wrong/missing initial input for $2" >&2
    tmux capture-pane -p -t "$2:cockpit" >&2
    exit 1
}
assert_inert() {
    [ "$(wc -l <"$DEV_TEST_RECEIPTS" | tr -d ' ')" = "$1" ] || { echo 'FAIL: staged agent ran before Enter / duplicate invocation' >&2; exit 1; }
    if compgen -G "$TMP_DIR/injected-*" >/dev/null; then echo 'FAIL: prompt executed as shell code' >&2; exit 1; fi
}
assert_shell_clean() {
    local captured
    captured="$(tmux capture-pane -p -t "$1:shell")"
    if printf '%s' "$captured" | grep -Eq -- 'leading-option|injected-|dev_launch.py|prompt.txt'; then
        echo 'FAIL: initial input leaked to another pane' >&2
        exit 1
    fi
}
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com
count=0
for variant in pi claude claude-plain; do
    agent="${variant%-plain}"
    project="$TMP_DIR/staged-$variant"
    mkdir "$project"
    command="$agent"
    [ "$variant" != claude ] || command='claude --continue || claude'
    printf '{"defaultAgent":"%s","agents":{"%s":"%s"},"windows":[{"name":"cockpit","agent":true},{"name":"shell"}]}\n' "$agent" "$agent" "$command" >"$project/devConfig.jsonc"
    cp "$TMP_DIR/expected-prompt" "$TMP_DIR/source-prompt"
    case "$variant" in
        pi) "$DEV" new --no-attach --stage-agent --prompt-file "$TMP_DIR/source-prompt" "$project" >/dev/null; checkout="$project"; session="staged-$variant-dev" ;;
        claude) "$DEV" open --no-attach --stage-agent --prompt-file "$TMP_DIR/source-prompt" "$project" >/dev/null; checkout="$project"; session="staged-$variant-dev" ;;
        claude-plain)
            git init -q -b main "$project"
            git -C "$project" add . && git -C "$project" commit -qm fixture
            (cd "$project" && "$DEV" tree --no-attach --stage-agent --prompt-file "$TMP_DIR/source-prompt" task >/dev/null 2>&1)
            checkout="$project-worktrees/task"; session="staged-$variant-task" ;;
    esac
    manifest="$(python3 "$CHECK" manifest "$XDG_STATE_HOME/dev/sessions.json" "$checkout" "$TMP_DIR/expected-prompt")"
    printf 'changed source, not the initial assignment\n' >"$TMP_DIR/source-prompt"
    rm "$TMP_DIR/source-prompt"
    sleep 0.2
    assert_inert "$count"
    # A pending staged launch survives server loss with its immutable input.
    tmux kill-server
    "$DEV" resume-all >/dev/null
    [ "$manifest" = "$(python3 "$CHECK" manifest "$XDG_STATE_HOME/dev/sessions.json" "$checkout" "$TMP_DIR/expected-prompt")" ]
    sleep 0.2
    assert_inert "$count"
    assert_shell_clean "$session"
    tmux send-keys -t "$session:cockpit" Enter
    wait_for_receipt "$agent" "$session"
    assert_shell_clean "$session"
    count=$((count + 1))
    sleep 0.15
    assert_inert "$count"
    # No exact lifecycle identity exists: even a successful fake invocation
    # cannot authorize replay after an uncertain startup outcome.
    tmux kill-server
    if "$DEV" resume-all >/dev/null 2>"$TMP_DIR/replay-error"; then echo 'FAIL: attempted kickoff replayed' >&2; exit 1; fi
    grep -Fq 'already attempted' "$TMP_DIR/replay-error"
    assert_inert "$count"
    (cd "$checkout" && "$DEV" close >/dev/null)
    [ -f "$manifest" ] || { echo 'FAIL: close deleted retained launch input' >&2; exit 1; }
done
# Immediate launches run once. Claude deliberately fails: the configured
# continue/fallback expression must not retry the prompt-bearing fresh launch.
for agent in pi claude; do
    project="$TMP_DIR/immediate-$agent"
    mkdir "$project"
    command="$agent"
    # Index 0 named "1" used to address the unrelated shell at index 1.
    # Metacharacters must likewise never be parsed as tmux target syntax.
    window=1
    if [ "$agent" = claude ]; then command='claude --continue || claude'; window='chat:.*[x]'; fi
    printf '{"defaultAgent":"%s","agents":{"%s":"%s"},"windows":[{"name":"%s","agent":true},{"name":"shell"}]}\n' "$agent" "$agent" "$command" "$window" >"$project/devConfig.jsonc"
    prompt="$(<"$TMP_DIR/expected-prompt")"; prompt+=$'\n'
    DEV_TEST_AGENT_FAIL=true "$DEV" new --no-attach --prompt "$prompt" "$project" >/dev/null
    wait_for_receipt "$agent" "immediate-$agent-dev" "$window"
    assert_shell_clean "immediate-$agent-dev"
    count=$((count + 1))
    sleep 0.2
    assert_inert "$count"
    (cd "$project" && "$DEV" close >/dev/null)
done
# Every observed process ran in its configured pane, never the shell pane.
[ "$(wc -l <"$DEV_TEST_RECEIPTS" | tr -d ' ')" = "$count" ]
# Startup profiles cross the same real tmux shell boundary without granting
# access to the user's Pi installation, credentials, policy, or tmux server.
export PI_CODING_AGENT_DIR="$TMP_DIR/profile-agent-dir"
export DEV_TEST_GUARD_CONFIG="$TMP_DIR/guard-config.json"
export DEV_TEST_AGENT_RECEIPT="$TMP_DIR/profile-receipt.json"
export DEV_TEST_GUARD_LOG="$TMP_DIR/profile-validator.jsonl"
unset PI_SUBAGENT_PROFILE
mkdir -p "$PI_CODING_AGENT_DIR/packages/pi-guard/extensions"
python3 - "$REPO_DIR" "$PI_CODING_AGENT_DIR" <<'PY'
import json
from pathlib import Path
import sys
repo, agent = map(Path, sys.argv[1:])
manifest = json.loads((repo / 'home/.pi/agent/packages/pi-guard/package.json').read_text())
(agent / 'packages/pi-guard/package.json').write_text(json.dumps({'name': manifest['name'], 'pi': manifest['pi']}))
(agent / 'settings.json').write_text(json.dumps({'packages': ['./packages/pi-guard']}))
(agent / 'packages/pi-guard/extensions/guard.ts').write_text('export default function() {}\n')
PY
cp "$REPO_DIR/tests/fixtures/dev-guard-profile.mjs" "$PI_CODING_AGENT_DIR/packages/pi-guard/guard-profile.mjs"
printf '{"profiles":["planning","coding"]}\n' >"$DEV_TEST_GUARD_CONFIG"
printf '#!/usr/bin/env bash\nexec python3 %q "$@"\n' "$REPO_DIR/tests/fixtures/dev-profile-agent.py" >"$TMP_DIR/bin/pi"
chmod +x "$TMP_DIR/bin/pi"
for variant in staged immediate; do
    project="$TMP_DIR/profile-$variant"
    mkdir "$project"
    printf '{"defaultAgent":"pi","agents":{"pi":"pi"},"windows":[{"name":"cockpit","agent":true},{"name":"shell"}]}\n' >"$project/devConfig.jsonc"
    rm -f "$DEV_TEST_AGENT_RECEIPT"
    if [ "$variant" = staged ]; then
        "$DEV" new --no-attach --stage-agent --agent-profile planning "$project" >/dev/null
        sleep 0.2
        [ ! -e "$DEV_TEST_AGENT_RECEIPT" ] || { echo 'FAIL: profile-only staging started an agent' >&2; exit 1; }
        tmux kill-server
        "$DEV" resume-all >/dev/null
        sleep 0.2
        [ ! -e "$DEV_TEST_AGENT_RECEIPT" ] || { echo 'FAIL: pending profile started during staged recovery' >&2; exit 1; }
        tmux send-keys -t "profile-$variant-dev:cockpit" Enter
    else
        "$DEV" open --no-attach --agent-profile planning --prompt-file "$TMP_DIR/expected-prompt" "$project" >/dev/null
    fi
    for i in {1..80}; do [ -f "$DEV_TEST_AGENT_RECEIPT" ] && break; sleep 0.05; done
    python3 - "$DEV_TEST_AGENT_RECEIPT" "$variant" "$TMP_DIR/expected-prompt" <<'PY'
import json
from pathlib import Path
import sys
receipt = json.loads(Path(sys.argv[1]).read_text())
assert receipt['profile'] == 'planning' and receipt['subagent_profile'] is None, receipt
assert receipt['prompt'] == (None if sys.argv[2] == 'staged' else Path(sys.argv[3]).read_text()), receipt
PY
    assert_shell_clean "profile-$variant-dev"
    (cd "$project" && "$DEV" close >/dev/null)
done
printf 'real tmux dev resume and fresh-launch tests passed\n'
