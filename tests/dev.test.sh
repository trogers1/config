#!/usr/bin/env bash
# Behavior tests for the dev CLI and the Claude Code worktree hooks. They run
# real git against throwaway repositories and a fake tmux that records sessions
# in files, so they never touch the user's tmux server.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEV="$REPO_DIR/tmux_and_worktrees/bin/dev"
CREATE_HOOK="$REPO_DIR/home/.claude/hooks/worktree-create.sh"
REMOVE_HOOK="$REPO_DIR/home/.claude/hooks/worktree-remove.sh"
CONFIG_READER="$REPO_DIR/tmux_and_worktrees/bin/lib/read_dev_config_windows.py"
TMP_DIR="$(cd "$(mktemp -d)" && pwd -P)"
trap 'chmod -R u+w "$TMP_DIR"; rm -rf "$TMP_DIR"' EXIT
export HOME="$TMP_DIR/home" XDG_STATE_HOME="$TMP_DIR/state"
mkdir -p "$HOME/bin"
printf '#!/usr/bin/env bash\nexec "%s" "$@"\n' "$DEV" >"$HOME/bin/dev"
chmod +x "$HOME/bin/dev"
"$REPO_DIR/home/.pi/agent/packages/pi-guard-subagents/node_modules/.bin/tsc" -p "$REPO_DIR/tests/dev-session.tsconfig.json"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
assert_exists() { [ -e "$1" ] || fail "expected $1 to exist"; }
assert_absent() { [ ! -e "$1" ] || fail "expected $1 to be absent"; }
assert_equals() { [ "$1" = "$2" ] || fail "expected '$2', got '$1'"; }
assert_contains() { printf '%s' "$1" | grep -Fq -- "$2" || fail "expected output to contain '$2', got: $1"; }

# Fake tmux: sessions are files under $FAKE_TMUX_DIR/sessions, each session's
# environment is a directory of files, and every call is appended to the log.
FAKE_BIN="$TMP_DIR/bin"
export FAKE_TMUX_DIR="$TMP_DIR/tmux"
mkdir -p "$FAKE_BIN" "$FAKE_TMUX_DIR/sessions"
cat >"$FAKE_BIN/tmux" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
dir="$FAKE_TMUX_DIR"
case "$1" in
    new-session|new-window|attach-session|switch-client)
        [ -z "${DEV_LIFECYCLE_LOCK_FD:-}" ] || { echo 'lock marker leaked into tmux' >&2; exit 1; }
        python3 - <<'PY'
import os
from pathlib import Path
lock = (Path(os.environ["XDG_STATE_HOME"]) / "dev/lifecycle.lock").stat()
for fd in range(3, 64):
    try:
        inherited = os.fstat(fd)
    except OSError:
        continue
    assert (inherited.st_dev, inherited.st_ino) != (lock.st_dev, lock.st_ino), "lock descriptor leaked into tmux"
PY
        ;;
esac
printf '%s\n' "$*" >>"$dir/log"
if [ -f "$dir/fail-once" ] && [ "$(<"$dir/fail-once")" = "$1" ]; then
    rm "$dir/fail-once"
    echo "injected tmux transport failure: $1" >&2
    exit 1
fi
target=""
window=""
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
    case "${args[i]}" in
        -t|-s) target="${args[i + 1]}" ;;
        -n) window="${args[i + 1]}" ;;
    esac
done
full_target="$target"
target="${target#=}"
target="${target%%:*}"
case "$1" in
    new-session|new-window)
        mkdir -p "$dir/sessions/$target" "$dir/panes"
        count=0
        if [ -f "$dir/next-pane" ]; then read -r count <"$dir/next-pane"; fi
        printf '%s\n' "$((count + 1))" >"$dir/next-pane"
        printf '%s\t%s\n' "$target" "$window" >"$dir/panes/%$count"
        ;;
    display-message)
        pane=""
        session=""
        for file in "$dir/panes"/*; do
            [ -f "$file" ] || continue
            IFS=$'\t' read -r s w <"$file"
            if [ "$(basename "$file")" = "$full_target" ] || [ "$s:$w" = "$full_target" ] || [ "$s" = "$full_target" ]; then
                pane="$(basename "$file")"; session="$s"
                break
            fi
        done
        [ -n "$pane" ] || exit 1
        case "${args[${#args[@]} - 1]}" in
            '#{pane_id}') printf '%s\n' "$pane" ;;
            *) printf '%s\t%s\t/fake/tmux\t%s\n' "$session" "$pane" "${FAKE_TMUX_SERVER_ID:-111}" ;;
        esac
        ;;
    rename-session)
        renamed="${args[${#args[@]} - 1]}"
        mv "$dir/sessions/$target" "$dir/sessions/$renamed"
        for file in "$dir/panes"/*; do
            IFS=$'\t' read -r s w <"$file"
            if [ "$s" = "$target" ]; then printf '%s\t%s\n' "$renamed" "$w" >"$file"; fi
        done
        ;;
    has-session) [ -d "$dir/sessions/$target" ] ;;
    kill-session)
        rm -rf "${dir:?}/sessions/$target"
        for file in "$dir/panes"/*; do
            [ -f "$file" ] || continue
            IFS=$'\t' read -r s w <"$file"
            if [ "$s" = "$target" ]; then rm "$file"; fi
        done
        ;;
    list-sessions)
        for session in "$dir/sessions"/*; do
            [ -d "$session" ] || continue
            case "$*" in
                *session_created*) printf '0\t$0\t%s\n' "$(basename "$session")" ;;
                *last_attached*) printf '%s\t0\n' "$(basename "$session")" ;;
                *) basename "$session" ;;
            esac
        done
        ;;
    set-environment)
        if [ "$2" = -u ]; then
            rm -f "$dir/sessions/$target/$5"
        else
            printf '%s' "$5" >"$dir/sessions/$target/$4"
        fi
        ;;
    show-environment)
        [ -f "$dir/sessions/$target/$4" ] || exit 1
        printf '%s=%s\n' "$4" "$(cat "$dir/sessions/$target/$4")"
        ;;
esac
EOF
chmod +x "$FAKE_BIN/tmux"
export PATH="$FAKE_BIN:$PATH"
unset TMUX TMUX_PANE PI_SUBAGENT_DEPTH DEV_LIFECYCLE_LOCK_FD
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1

session_env() { cat "$FAKE_TMUX_DIR/sessions/$1/$2"; }
reset_log() { : >"$FAKE_TMUX_DIR/log"; }

PROJ="$TMP_DIR/proj"
WT_ROOT="$TMP_DIR/proj-worktrees"
git init -q -b main "$PROJ"
# The init script writes noise to stdout to prove --no-attach keeps stdout clean.
cat >"$PROJ/.worktree-init.sh" <<'EOF'
echo "init noise on stdout"
printf '%s\n' "$REPO_ROOT" >"$WORKTREE_PATH/.init-ran"
EOF
printf '.init-ran\n' >"$PROJ/.gitignore"
git -C "$PROJ" add . && git -C "$PROJ" commit -qm init

# --no-attach prints only the worktree path, runs init, and records a detached
# session with the default agent.
reset_log
out="$(cd "$PROJ" && "$DEV" tree --no-attach feat 2>/dev/null)"
assert_equals "$out" "$WT_ROOT/feat"
assert_equals "$(cat "$WT_ROOT/feat/.init-ran")" "$PROJ"
assert_equals "$(session_env proj-feat DTREE_WORKTREE_PATH)" "$WT_ROOT/feat"
assert_equals "$(session_env proj-feat DTREE_BRANCH)" feat
grep -Fqx 'send-keys -t proj-feat:agent pi C-m' "$FAKE_TMUX_DIR/log" || fail 'default agent window did not run pi'
if grep -Eq '^(attach-session|switch-client)' "$FAKE_TMUX_DIR/log"; then fail '--no-attach attached'; fi

# Rerunning reuses the worktree and session without rerunning init.
rm "$WT_ROOT/feat/.init-ran"
out="$(cd "$PROJ" && "$DEV" tree --no-attach feat 2>/dev/null)"
assert_equals "$out" "$WT_ROOT/feat"
assert_absent "$WT_ROOT/feat/.init-ran"
assert_equals "$(find "$FAKE_TMUX_DIR/sessions" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')" 1

# --agent picks the agent window's command per run; --stage-agent types it
# without pressing Enter, and leaves the other windows running.
reset_log
(cd "$PROJ" && "$DEV" tree --no-attach --agent claude feat-claude >/dev/null 2>&1)
grep -Fqx 'send-keys -t proj-feat-claude:agent claude --continue || claude C-m' "$FAKE_TMUX_DIR/log" || fail '--agent claude did not run claude --continue'
reset_log
(cd "$PROJ" && "$DEV" tree --no-attach --agent claude --stage-agent feat-staged >/dev/null 2>&1)
grep -Fqx 'send-keys -t proj-feat-staged:agent claude --continue || claude' "$FAKE_TMUX_DIR/log" || fail '--stage-agent did not type the agent command unrun'
grep -Fqx 'send-keys -t proj-feat-staged:nvim nvim C-m' "$FAKE_TMUX_DIR/log" || fail '--stage-agent stopped other windows from running'
# An agent the config does not define warns and leaves the agent window empty.
reset_log
(cd "$PROJ" && "$DEV" tree --no-attach --agent bogus feat-bogus >/dev/null 2>"$TMP_DIR/err") || fail 'unknown agent failed'
assert_contains "$(cat "$TMP_DIR/err")" "warning: agent 'bogus' is not available"
grep -Fqx "new-window -t proj-feat-bogus: -n agent -c $WT_ROOT/feat-bogus" "$FAKE_TMUX_DIR/log" || fail 'unknown agent dropped the agent window'
if grep -Fq 'send-keys -t proj-feat-bogus:agent' "$FAKE_TMUX_DIR/log"; then fail 'unknown agent window ran a command'; fi

# Interactive mode still attaches.
reset_log
(cd "$PROJ" && "$DEV" tree feat >/dev/null 2>&1)
grep -Fqx 'attach-session -t proj-feat' "$FAKE_TMUX_DIR/log" || fail 'interactive dev tree did not attach'

# dev new accepts --agent too.
mkdir "$TMP_DIR/plain"
reset_log
"$DEV" new --agent claude "$TMP_DIR/plain" >/dev/null
grep -Fqx 'send-keys -t plain-dev:agent claude --continue || claude C-m' "$FAKE_TMUX_DIR/log" || fail 'dev new --agent did not pick claude'

# --no-attach fails instead of prompting to move a branch out of the primary checkout.
git -C "$PROJ" checkout -qb topic
if out="$(cd "$PROJ" && "$DEV" tree --no-attach topic 2>"$TMP_DIR/err" </dev/null)"; then fail 'primary checkout branch succeeded'; fi
assert_equals "$out" ''
assert_contains "$(cat "$TMP_DIR/err")" '--no-attach never moves it'
assert_equals "$(git -C "$PROJ" branch --show-current)" topic
git -C "$PROJ" checkout -q main

# --no-attach never fetches, and refuses to shadow a known remote branch.
git init -q --bare "$TMP_DIR/origin.git"
git -C "$PROJ" remote add origin "$TMP_DIR/origin.git"
git -C "$PROJ" branch remote-only
git -C "$PROJ" push -q origin remote-only
git -C "$PROJ" branch -qD remote-only
if (cd "$PROJ" && "$DEV" tree --no-attach remote-only >/dev/null 2>"$TMP_DIR/err" </dev/null); then fail 'known remote branch was shadowed'; fi
assert_contains "$(cat "$TMP_DIR/err")" 'origin/remote-only exists'
assert_absent "$WT_ROOT/remote-only"
out="$(cd "$PROJ" && "$DEV" tree --no-attach fresh 2>"$TMP_DIR/err" </dev/null)"
assert_equals "$out" "$WT_ROOT/fresh"
assert_contains "$(cat "$TMP_DIR/err")" 'does not fetch origin'

# --no-attach refuses a directory at the default path that is not the branch's worktree.
mkdir -p "$WT_ROOT/stray"
if (cd "$PROJ" && "$DEV" tree --no-attach stray >/dev/null 2>&1); then fail 'stray directory was adopted'; fi

# Commands resolve worktrees from git, so a worktree outside dev's layout works
# by branch or by path, and a detached worktree works by path.
CLAUDE_WT="$PROJ/.claude/worktrees/side"
git -C "$PROJ" worktree add -q -b claude/side "$CLAUDE_WT"
out="$(cd "$PROJ" && "$DEV" tree --no-attach claude/side 2>/dev/null)"
assert_equals "$out" "$CLAUDE_WT"
"$DEV" close "$CLAUDE_WT" >/dev/null
assert_absent "$FAKE_TMUX_DIR/sessions/proj-claude-side"
(cd "$PROJ" && "$DEV" kill --yes claude/side >/dev/null)
assert_absent "$CLAUDE_WT"
if git -C "$PROJ" show-ref --verify --quiet refs/heads/claude/side; then fail 'dev kill kept a merged branch'; fi

git -C "$PROJ" worktree add -q --detach "$TMP_DIR/detached"
(cd "$TMP_DIR/detached" && "$DEV" kill --yes >/dev/null)
assert_absent "$TMP_DIR/detached"

# dev kill refuses a dirty worktree, and keeps an unmerged branch after
# removing the worktree and its session.
printf 'dirty\n' >"$WT_ROOT/feat/dirty.txt"
if (cd "$PROJ" && "$DEV" kill --yes feat >/dev/null 2>&1); then fail 'dirty worktree was killed'; fi
assert_exists "$WT_ROOT/feat"
git -C "$WT_ROOT/feat" add dirty.txt && git -C "$WT_ROOT/feat" commit -qm work
if (cd "$PROJ" && "$DEV" kill --yes "$WT_ROOT/feat" >/dev/null 2>"$TMP_DIR/err"); then fail 'unmerged branch delete reported success'; fi
assert_absent "$WT_ROOT/feat"
assert_absent "$FAKE_TMUX_DIR/sessions/proj-feat"
git -C "$PROJ" show-ref --verify --quiet refs/heads/feat || fail 'unmerged branch was deleted'
assert_contains "$(cat "$TMP_DIR/err")" "kept branch 'feat'"

# Merging a branch that has no worktree leaves unrelated, unmanaged sessions alone.
mkdir -p "$FAKE_TMUX_DIR/sessions/unmanaged"
(cd "$PROJ" && "$DEV" merge feat main >/dev/null 2>&1)
assert_exists "$FAKE_TMUX_DIR/sessions/unmanaged"
assert_exists "$PROJ/dirty.txt"

# The Claude Code hooks create a dev-layout worktree with claude typed but not
# run in the agent window, and remove it again, printing nothing but the path.
reset_log
out="$(printf '{"name":"hooked","cwd":"%s","hook_event_name":"WorktreeCreate"}' "$PROJ" | bash "$CREATE_HOOK" 2>/dev/null)"
assert_equals "$out" "$WT_ROOT/hooked"
assert_exists "$WT_ROOT/hooked/.init-ran"
assert_equals "$(session_env proj-hooked DTREE_WORKTREE_PATH)" "$WT_ROOT/hooked"
grep -Fqx 'send-keys -t proj-hooked:agent claude --continue || claude' "$FAKE_TMUX_DIR/log" || fail 'hook did not stage claude unrun'
if grep -Fq 'send-keys -t proj-hooked:agent claude --continue || claude C-m' "$FAKE_TMUX_DIR/log"; then fail 'hook started an agent'; fi
out="$(printf '{"worktree_path":"%s","hook_event_name":"WorktreeRemove"}' "$WT_ROOT/hooked" | bash "$REMOVE_HOOK" 2>/dev/null)"
assert_equals "$out" ''
assert_absent "$WT_ROOT/hooked"
assert_absent "$FAKE_TMUX_DIR/sessions/proj-hooked"
if git -C "$PROJ" show-ref --verify --quiet refs/heads/hooked; then fail 'remove hook kept the branch'; fi

# Hook failures are non-zero with nothing on stdout.
if out="$(printf '{"cwd":"%s"}' "$PROJ" | bash "$CREATE_HOOK" 2>/dev/null)"; then fail 'create hook accepted input without a name'; fi
assert_equals "$out" ''
if printf '{"name":"x","cwd":"%s"}' "$TMP_DIR/plain" | bash "$CREATE_HOOK" >/dev/null 2>&1; then fail 'create hook succeeded outside a repository'; fi
if printf '{"worktree_path":"%s"}' "$TMP_DIR/missing" | bash "$REMOVE_HOOK" >/dev/null 2>&1; then fail 'remove hook accepted a missing path'; fi

# --no-attach never prints the primary checkout, even when run from a linked
# worktree while the branch is checked out in the primary checkout.
git -C "$PROJ" checkout -q topic
if out="$(cd "$WT_ROOT/fresh" && "$DEV" tree --no-attach topic 2>"$TMP_DIR/err" </dev/null)"; then fail 'primary checkout returned from a linked worktree'; fi
assert_equals "$out" ''
assert_contains "$(cat "$TMP_DIR/err")" '--no-attach never moves it'
git -C "$PROJ" checkout -q main

# A bare name is a branch, not a directory that happens to exist in the
# current worktree.
mkdir "$WT_ROOT/fresh/docs" "$WT_ROOT/fresh/tests"
touch "$WT_ROOT/fresh/docs/a" "$WT_ROOT/fresh/tests/a"
git -C "$WT_ROOT/fresh" add docs tests && git -C "$WT_ROOT/fresh" commit -qm dirs
git -C "$PROJ" branch docs main
git -C "$PROJ" worktree add -q "$TMP_DIR/docs-wt" docs
git -C "$TMP_DIR/docs-wt" commit -q --allow-empty -m docs
docs_commit="$(git -C "$TMP_DIR/docs-wt" rev-parse HEAD)"
git -C "$PROJ" worktree remove "$TMP_DIR/docs-wt"
(cd "$WT_ROOT/fresh" && "$DEV" merge docs main >/dev/null 2>&1) || fail 'dev merge docs failed'
git -C "$PROJ" merge-base --is-ancestor "$docs_commit" main || fail 'dev merge docs did not merge the docs branch'
assert_exists "$WT_ROOT/fresh"
git -C "$PROJ" show-ref --verify --quiet refs/heads/fresh || fail 'dev merge docs deleted the current branch'
if (cd "$WT_ROOT/fresh" && "$DEV" kill -f tests >/dev/null 2>"$TMP_DIR/err"); then fail 'dev kill -f tests succeeded'; fi
assert_contains "$(cat "$TMP_DIR/err")" "No worktree found for branch 'tests'"
assert_exists "$WT_ROOT/fresh"

# A process the init script leaves in the background does not hold stdout
# open, so --no-attach returns as soon as the worktree is ready.
BG="$TMP_DIR/bgproj"
git init -q -b main "$BG"
cat >"$BG/.worktree-init.sh" <<'EOF'
sleep 20 >/dev/null 2>&1 &
printf '%s\n' "$!" >"$WORKTREE_PATH/.bg-pid"
EOF
printf '.bg-pid\n' >"$BG/.gitignore"
git -C "$BG" add . && git -C "$BG" commit -qm init
start="$SECONDS"
out="$(cd "$BG" && "$DEV" tree --no-attach bg 2>/dev/null)"
elapsed=$((SECONDS - start))
kill "$(cat "$TMP_DIR/bgproj-worktrees/bg/.bg-pid")" 2>/dev/null || true
assert_equals "$out" "$TMP_DIR/bgproj-worktrees/bg"
[ "$elapsed" -lt 10 ] || fail "--no-attach waited ${elapsed}s for a backgrounded init process"

# The project's devConfig.jsonc is read before anything is created, so an
# invalid one leaves no worktree or branch behind. One without the claude agent
# still gets a Claude worktree, with a warning and an empty agent window.
config_repo() {
    git init -q -b main "$TMP_DIR/$1"
    printf '%s' "$2" >"$TMP_DIR/$1/devConfig.jsonc"
    git -C "$TMP_DIR/$1" add . && git -C "$TMP_DIR/$1" commit -qm init
}
config_repo badconfig '{"windows":[{"name":"agent","agent":true,"command":"x"}]}'
if (cd "$TMP_DIR/badconfig" && "$DEV" tree --no-attach orphan >/dev/null 2>"$TMP_DIR/err"); then fail 'invalid devConfig.jsonc was accepted'; fi
assert_contains "$(cat "$TMP_DIR/err")" 'main:devConfig.jsonc windows[0] sets both agent and command'
assert_absent "$TMP_DIR/badconfig-worktrees/orphan"
if git -C "$TMP_DIR/badconfig" show-ref --verify --quiet refs/heads/orphan; then fail 'invalid devConfig.jsonc left a branch behind'; fi
config_repo noagent '{"windows":[{"name":"nvim"},{"name":"term"}]}'
config_repo piagent '{"defaultAgent":"pi","agents":{"pi":"pi"},"windows":[{"name":"agent","agent":true},{"name":"term"}]}'
for repo in noagent piagent; do
    reset_log
    out="$(printf '{"name":"hooked","cwd":"%s"}' "$TMP_DIR/$repo" | bash "$CREATE_HOOK" 2>"$TMP_DIR/err")"
    assert_equals "$out" "$TMP_DIR/$repo-worktrees/hooked"
    assert_contains "$(cat "$TMP_DIR/err")" "warning: agent 'claude' is not available in main:devConfig.jsonc"
    grep -Fqx "new-window -t $repo-hooked: -n term -c $TMP_DIR/$repo-worktrees/hooked" "$FAKE_TMUX_DIR/log" || fail "$repo hook did not open the configured windows"
    if grep -Fq 'send-keys' "$FAKE_TMUX_DIR/log"; then fail "$repo hook sent a command to a window"; fi
done

# The remove hook succeeds once the worktree is gone, even when git keeps its
# unmerged branch, and reports the kept branch.
printf '{"name":"unmerged","cwd":"%s"}' "$PROJ" | bash "$CREATE_HOOK" >/dev/null 2>&1
git -C "$WT_ROOT/unmerged" commit -q --allow-empty -m work
printf '{"worktree_path":"%s"}' "$WT_ROOT/unmerged" | bash "$REMOVE_HOOK" >/dev/null 2>"$TMP_DIR/err" || fail 'remove hook failed after removing the worktree'
assert_absent "$WT_ROOT/unmerged"
git -C "$PROJ" show-ref --verify --quiet refs/heads/unmerged || fail 'remove hook deleted an unmerged branch'
assert_contains "$(cat "$TMP_DIR/err")" "kept branch 'unmerged'"

# The Claude desktop app runs hooks with a GUI PATH that lacks Homebrew, so the
# hooks add it themselves.
mkdir -p "$TMP_DIR/brew/bin"
ln -s "$FAKE_BIN/tmux" "$TMP_DIR/brew/bin/tmux"
gui_hook() { env PATH=/usr/bin:/bin HOMEBREW_PREFIX="$TMP_DIR/brew" bash "$1"; }
out="$(printf '{"name":"gui","cwd":"%s"}' "$PROJ" | gui_hook "$CREATE_HOOK" 2>"$TMP_DIR/err")" || fail "create hook failed with a GUI PATH: $(cat "$TMP_DIR/err")"
assert_equals "$out" "$WT_ROOT/gui"
printf '{"worktree_path":"%s"}' "$WT_ROOT/gui" | gui_hook "$REMOVE_HOOK" >/dev/null 2>&1 || fail 'remove hook failed with a GUI PATH'
assert_absent "$WT_ROOT/gui"

# devConfig agent validation fails loudly on ambiguous or incomplete configs.
config_error() {
    printf '%s' "$1" >"$TMP_DIR/devConfig.jsonc"
    if python3 "$CONFIG_READER" "$TMP_DIR/devConfig.jsonc" ${2:+--agent "$2"} >/dev/null 2>"$TMP_DIR/err"; then
        fail "config was accepted: $1"
    fi
    assert_contains "$(cat "$TMP_DIR/err")" "$3"
}
config_error '{"windows":[{"name":"a","agent":true,"command":"x"}]}' '' 'sets both agent and command'
config_error '{"defaultAgent":"pi","windows":[]}' '' "defaultAgent 'pi' is not defined"
config_error '{"windows":[]}' '' 'No windows configured'
printf '%s' '{"windows":[{"name":"a","agent":true}]}' >"$TMP_DIR/devConfig.jsonc"
assert_equals "$(python3 "$CONFIG_READER" "$TMP_DIR/devConfig.jsonc" 2>"$TMP_DIR/err")" "$(printf 'agent\ta\t')"
assert_contains "$(cat "$TMP_DIR/err")" 'no defaultAgent; opening no agent'

# Persistent sessions: exercise dev plus the actual Pi factory and declarative
# Claude SessionStart hook. A separate isolated server/state makes every record
# below resumable and avoids any user's tmux, HOME, or XDG state.
export XDG_STATE_HOME="$TMP_DIR/registry-state"
export FAKE_TMUX_DIR="$TMP_DIR/registry-tmux"
mkdir -p "$FAKE_TMUX_DIR/sessions"
REGISTRY="$XDG_STATE_HOME/dev/sessions.json"
APP="$TMP_DIR/pi-app"
CHAT="$TMP_DIR/claude-app"
STAGED="$TMP_DIR/staged-app"
mkdir -p "$APP" "$CHAT"
cat >"$APP/devConfig.jsonc" <<'EOF'
{"defaultAgent":"pi","agents":{"pi":"pi --offline","claude":"claude --continue || claude"},"windows":[{"name":"nvim","command":"nvim"},{"name":"chat","agent":true},{"name":"terminal"}]}
EOF
cp "$APP/devConfig.jsonc" "$CHAT/devConfig.jsonc"
"$DEV" new --nvim-command 'nvim writing.md' "$APP" >/dev/null
"$DEV" open --agent claude "$CHAT" >/dev/null
pane_for() { tmux display-message -p -t "$1:$2" '#{pane_id}'; }
PI_PANE="$(pane_for pi-app-dev chat)"
CLAUDE_PANE="$(pane_for claude-app-dev chat)"
PI_FIRST="$TMP_DIR/pi-first.jsonl"
PI_EXACT="$TMP_DIR/pi-exact.jsonl"
CLAUDE_FILE="$TMP_DIR/claude-exact.jsonl"
printf 'synthetic transcript fixture\n' >"$PI_FIRST"
printf 'synthetic transcript fixture\n' >"$PI_EXACT"
printf 'synthetic transcript fixture\n' >"$CLAUDE_FILE"
pi_event() { TMUX=/fake/tmux,111,0 TMUX_PANE="$1" node "$REPO_DIR/tests/dev-session.test.mjs" "${@:2}"; }
claude_event() {
    printf '{"hook_event_name":"SessionStart","source":"%s","session_id":"%s","transcript_path":"%s","cwd":"%s"}' "$1" "$2" "$CLAUDE_FILE" "$CHAT" |
        TMUX=/fake/tmux,111,0 TMUX_PANE="$CLAUDE_PANE" bash "$REPO_DIR/home/.claude/hooks/dev-session.sh"
}
pi_event "$PI_PANE" "$PI_FIRST" "$PI_EXACT"
claude_event startup claude-first
claude_event clear claude-exact
cp "$REGISTRY" "$TMP_DIR/registered-before-invalid.json"
if printf '{"hook_event_name":"SessionStart","source":"startup","session_id":123,"transcript_path":"/tmp/fake.jsonl"}' |
    TMUX=/fake/tmux,111,0 TMUX_PANE="$CLAUDE_PANE" bash "$REPO_DIR/home/.claude/hooks/dev-session.sh" >/dev/null 2>"$TMP_DIR/err"; then
    fail 'Claude metadata accepted a non-string session_id'
fi
assert_contains "$(cat "$TMP_DIR/err")" 'conversation.session_id'
cmp "$REGISTRY" "$TMP_DIR/registered-before-invalid.json" || fail 'invalid metadata changed registry'
# Extra panes, headless processes, and subagents must never replace the main
# configured pane's exact identity, even when cwd/session are the same.
tmux new-window -t pi-app-dev: -n manual -c "$APP"
pi_event "$(pane_for pi-app-dev manual)" "$PI_FIRST"
PI_SUBAGENT_DEPTH=1 pi_event "$PI_PANE" "$PI_FIRST"
TEST_PI_MODE=json pi_event "$PI_PANE" "$PI_FIRST"
printf '{"hook_event_name":"SessionStart","source":"startup","agent_id":"worker","session_id":"child"}' |
    TMUX=/fake/tmux,111,0 TMUX_PANE="$CLAUDE_PANE" bash "$REPO_DIR/home/.claude/hooks/dev-session.sh"
python3 - "$REGISTRY" "$APP" "$CHAT" "$PI_EXACT" <<'PY'
import json, sys
records = json.load(open(sys.argv[1]))["sessions"]
assert records[sys.argv[2]]["conversation"]["transcript_path"] == sys.argv[4]
assert records[sys.argv[3]]["conversation"]["session_id"] == "claude-exact"
PY
# Staged agents that have never run restore the configured command, still
# unexecuted. Agent selection is retained, not re-selected from the default.
git init -q -b main "$STAGED"
printf '' >"$STAGED/.worktree-init.sh"
git -C "$STAGED" add . && git -C "$STAGED" commit -qm init
(cd "$STAGED" && "$DEV" tree --no-attach --agent claude --stage-agent task >/dev/null 2>&1)
rm -rf "$FAKE_TMUX_DIR/sessions" "$FAKE_TMUX_DIR/panes"
mkdir -p "$FAKE_TMUX_DIR/sessions"
export FAKE_TMUX_SERVER_ID=222
reset_log
"$DEV" resume-all >"$TMP_DIR/resume-out"
assert_contains "$(cat "$TMP_DIR/resume-out")" 'Resumed detached: pi-app-dev'
grep -Fq "then pi --session $PI_EXACT; else" "$FAKE_TMUX_DIR/log" || fail 'Pi did not resume the exact active file'
grep -Eq '^send-keys -t pi-app-dev:chat .* C-m$' "$FAKE_TMUX_DIR/log" || fail 'Pi resume was unexpectedly staged'
grep -Fqx 'send-keys -t pi-app-dev:nvim nvim writing.md C-m' "$FAKE_TMUX_DIR/log" || fail 'resume lost writing/nvim override'
grep -Eq '^send-keys -t claude-app-dev:chat .*then claude --resume claude-exact; .* C-m$' "$FAKE_TMUX_DIR/log" || fail 'Claude did not resume exact ID'
grep -Fqx 'send-keys -t staged-app-task:agent claude --continue || claude' "$FAKE_TMUX_DIR/log" || fail 'resume lost staged-agent intent'
if grep -Eq '^(attach-session|switch-client)|-n manual' "$FAKE_TMUX_DIR/log"; then fail 'resume attached or restored extra panes'; fi
# Registry registration during recreation must not erase the saved identity.
python3 - "$REGISTRY" "$APP" <<'PY'
import json, sys
assert json.load(open(sys.argv[1]))["sessions"][sys.argv[2]]["conversation"]["session_id"] == "pi-test-1"
PY
reset_log
rm "$PI_EXACT"
"$DEV" resume-all >/dev/null
if grep -Eq '^(new-session|new-window|send-keys|select-window)' "$FAKE_TMUX_DIR/log"; then fail 'resume touched an already-open session'; fi
# Once missing, an exact transcript cannot be substituted by the older one.
tmux kill-session -t pi-app-dev
if "$DEV" resume-all >"$TMP_DIR/resume-out" 2>"$TMP_DIR/err"; then fail 'missing exact Pi transcript silently resumed'; fi
assert_contains "$(cat "$TMP_DIR/err")" 'exact pi transcript missing/empty'
assert_absent "$FAKE_TMUX_DIR/sessions/pi-app-dev"
assert_exists "$REGISTRY"
printf 'restored fixture\n' >"$PI_EXACT"
"$DEV" resume-all >/dev/null
# A staged conversation that has since started resumes exactly, still staged.
STAGE_PANE="$(pane_for staged-app-task agent)"
printf '{"hook_event_name":"SessionStart","source":"resume","session_id":"staged-exact","transcript_path":"%s"}' "$CLAUDE_FILE" |
    TMUX=/fake/tmux,222,0 TMUX_PANE="$STAGE_PANE" bash "$REPO_DIR/home/.claude/hooks/dev-session.sh"
tmux kill-session -t staged-app-task
reset_log
"$DEV" resume-all >/dev/null
grep -Eq '^send-keys -t staged-app-task:agent .*then claude --resume staged-exact; .*; fi$' "$FAKE_TMUX_DIR/log" || fail 'started staged conversation was not resumed exactly'
(cd "$STAGED" && "$DEV" merge task main --keep >/dev/null 2>&1)
python3 - "$REGISTRY" "$TMP_DIR/staged-app-worktrees/task" <<'PY'
import json, sys
assert sys.argv[2] in json.load(open(sys.argv[1]))["sessions"]
PY
(cd "$STAGED" && "$DEV" merge task main >/dev/null 2>&1)
python3 - "$REGISTRY" "$TMP_DIR/staged-app-worktrees/task" <<'PY'
import json, sys
assert sys.argv[2] not in json.load(open(sys.argv[1]))["sessions"]
PY
(cd "$STAGED" && "$DEV" tree --no-attach --stage-agent offline >/dev/null 2>&1)
tmux kill-session -t staged-app-offline
(cd "$STAGED" && "$DEV" kill --yes offline >/dev/null 2>&1)
python3 - "$REGISTRY" "$TMP_DIR/staged-app-worktrees/offline" <<'PY'
import json, sys
assert sys.argv[2] not in json.load(open(sys.argv[1]))["sessions"]
PY
# Missing paths and missing Claude transcripts retain records with actionable
# failures; intentional dev close works even with no running tmux session.
tmux kill-session -t claude-app-dev
mv "$CHAT" "$CHAT-moved"
if "$DEV" resume-all >/dev/null 2>"$TMP_DIR/err"; then fail 'missing path resumed'; fi
assert_contains "$(cat "$TMP_DIR/err")" 'checkout missing:'
mv "$CHAT-moved" "$CHAT"
rm "$CLAUDE_FILE"
if "$DEV" resume-all >/dev/null 2>"$TMP_DIR/err"; then fail 'missing Claude transcript resumed'; fi
assert_contains "$(cat "$TMP_DIR/err")" 'exact claude transcript missing/empty'
(cd "$CHAT" && "$DEV" close >/dev/null)
python3 - "$REGISTRY" "$CHAT" <<'PY'
import json, sys
assert sys.argv[2] not in json.load(open(sys.argv[1]))["sessions"]
PY
# Non-staged sessions without lifecycle metadata never guess latest/start fresh.
UNTRACKED="$TMP_DIR/untracked"
mkdir "$UNTRACKED"
"$DEV" new "$UNTRACKED" >/dev/null
tmux kill-session -t untracked-dev
if "$DEV" resume-all >/dev/null 2>"$TMP_DIR/err"; then fail 'unrecorded agent started fresh'; fi
assert_contains "$(cat "$TMP_DIR/err")" 'exact agent conversation was never recorded'
(cd "$UNTRACKED" && "$DEV" close >/dev/null)
# Concurrent public new/open calls serialize without lost records.
pids=()
for i in 1 2 3 4 5 6; do
    mkdir "$TMP_DIR/concurrent-$i"
    printf '{"windows":[{"name":"shell"}]}' >"$TMP_DIR/concurrent-$i/devConfig.jsonc"
    "$DEV" new "$TMP_DIR/concurrent-$i" >/dev/null &
    pids+=("$!")
done
for pid in "${pids[@]}"; do wait "$pid" || fail 'concurrent dev new failed'; done
pids=()
export TEST_REGISTRY_LIB="$REPO_DIR/tmux_and_worktrees/bin/lib"
python3 - "$REGISTRY" <<'PY' &
import importlib.util, json, os, sys, time
spec = importlib.util.spec_from_file_location("dev_registry", os.path.join(os.environ["TEST_REGISTRY_LIB"], "dev_registry.py"))
registry = importlib.util.module_from_spec(spec)
spec.loader.exec_module(registry)
for _ in range(300):
    with open(sys.argv[1]) as source:
        registry.validate(data=json.load(source))
    time.sleep(0.005)
PY
pids+=("$!")
CURRENT_PI_PANE="$(pane_for pi-app-dev chat)"
for i in 1 2 3 4 5 6; do
    pi_event "$CURRENT_PI_PANE" "$PI_EXACT" >/dev/null &
    pids+=("$!")
done
for pid in "${pids[@]}"; do wait "$pid" || fail 'concurrent lifecycle write/read failed'; done
python3 - "$REGISTRY" "$TMP_DIR" <<'PY'
import json, sys
records = json.load(open(sys.argv[1]))["sessions"]
assert all(f"{sys.argv[2]}/concurrent-{i}" in records for i in range(1, 7))
PY
# Failure/identity regressions use another isolated registry/server.
export XDG_STATE_HOME="$TMP_DIR/failure-state" FAKE_TMUX_DIR="$TMP_DIR/failure-tmux"
REGISTRY="$XDG_STATE_HOME/dev/sessions.json"
mkdir -p "$FAKE_TMUX_DIR/sessions" "$TMP_DIR/rename-pi" "$TMP_DIR/rename-claude"
PI_RENAME="$TMP_DIR/rename-pi"
CHAT="$TMP_DIR/rename-claude"
CLAUDE_FILE="$TMP_DIR/renamed-claude.jsonl"
printf 'synthetic Claude transcript\n' >"$CLAUDE_FILE"
"$DEV" new "$PI_RENAME" >/dev/null
"$DEV" new --agent claude "$CHAT" >/dev/null
PI_PANE="$(pane_for rename-pi-dev agent)"
CLAUDE_PANE="$(pane_for rename-claude-dev agent)"
pi_event "$PI_PANE" "$PI_FIRST"
claude_event startup before-rename
tmux rename-session -t rename-pi-dev renamed-pi
tmux rename-session -t rename-claude-dev renamed-claude
pi_event "$PI_PANE" "$PI_FIRST" "$PI_EXACT"
claude_event resume after-rename
rm -rf "$FAKE_TMUX_DIR/sessions" "$FAKE_TMUX_DIR/panes"
mkdir -p "$FAKE_TMUX_DIR/sessions"
export FAKE_TMUX_SERVER_ID=333
reset_log
"$DEV" resume-all >/dev/null
assert_exists "$FAKE_TMUX_DIR/sessions/renamed-pi"
assert_exists "$FAKE_TMUX_DIR/sessions/renamed-claude"
grep -Fq "then pi --session $PI_EXACT; else" "$FAKE_TMUX_DIR/log" || fail 'rename froze Pi conversation'
grep -Fq 'then claude --resume after-rename; else' "$FAKE_TMUX_DIR/log" || fail 'rename froze Claude conversation'
# A post-registration transport error rolls back only the newly created
# session and restores the exact previous recovery record. Retry must create.
for failure in send-keys select-window; do
    tmux kill-session -t renamed-pi
    cp "$REGISTRY" "$TMP_DIR/before-rollback.json"
    printf '%s\n' "$failure" >"$FAKE_TMUX_DIR/fail-once"
    if "$DEV" resume-all >/dev/null 2>"$TMP_DIR/err"; then fail 'partial resume reported success'; fi
    assert_contains "$(cat "$TMP_DIR/err")" 'injected tmux transport failure'
    assert_absent "$FAKE_TMUX_DIR/sessions/renamed-pi"
    assert_exists "$FAKE_TMUX_DIR/sessions/renamed-claude"
    cmp "$REGISTRY" "$TMP_DIR/before-rollback.json" || fail 'failed resume lost the prior recovery record'
    reset_log
    "$DEV" resume-all >/dev/null
    grep -Fq "then pi --session $PI_EXACT; else" "$FAKE_TMUX_DIR/log" || fail 'retry skipped failed partial resume'
done
mkdir "$TMP_DIR/partial-new"
printf '{"windows":[{"name":"editor","command":"nvim"}]}' >"$TMP_DIR/partial-new/devConfig.jsonc"
printf 'send-keys\n' >"$FAKE_TMUX_DIR/fail-once"
if "$DEV" new "$TMP_DIR/partial-new" >/dev/null 2>"$TMP_DIR/err"; then fail 'partial new reported success'; fi
assert_absent "$FAKE_TMUX_DIR/sessions/partial-new-dev"
cmp "$REGISTRY" "$TMP_DIR/before-rollback.json" >/dev/null || python3 - "$REGISTRY" "$TMP_DIR/partial-new" <<'PY'
import json, sys
assert sys.argv[2] not in json.load(open(sys.argv[1]))["sessions"]
PY
# Invalid or unwritable intent must stop dev close before any session switch /
# destruction, including the no-live-session case.
cp "$REGISTRY" "$TMP_DIR/before-close-failure.json"
printf '{invalid\n' >"$REGISTRY"
reset_log
if (cd "$PI_RENAME" && "$DEV" close >/dev/null 2>"$TMP_DIR/err"); then fail 'close accepted invalid registry'; fi
assert_exists "$FAKE_TMUX_DIR/sessions/renamed-pi"
if grep -Eq '^(kill-session|switch-client)' "$FAKE_TMUX_DIR/log"; then fail 'failed close destroyed/switched sessions'; fi
if (cd "$TMP_DIR/partial-new" && "$DEV" close >/dev/null 2>"$TMP_DIR/err"); then fail 'close without live session hid registry failure'; fi
cp "$TMP_DIR/before-close-failure.json" "$REGISTRY"
chmod a-w "$XDG_STATE_HOME/dev"
if (cd "$PI_RENAME" && "$DEV" close >/dev/null 2>"$TMP_DIR/err"); then fail 'close accepted unwritable registry'; fi
chmod u+w "$XDG_STATE_HOME/dev"
assert_exists "$FAKE_TMUX_DIR/sessions/renamed-pi"
cmp "$REGISTRY" "$TMP_DIR/before-close-failure.json" || fail 'failed close changed durable intent'
# Validate before destructive Git work. If persistence fails only after Git
# removal, branch/session cleanup still completes and the command fails loudly.
FAIL_REPO="$TMP_DIR/destructive"
git init -q -b main "$FAIL_REPO"
printf ':\n' >"$FAIL_REPO/.worktree-init.sh"
git -C "$FAIL_REPO" add . && git -C "$FAIL_REPO" commit -qm init
(cd "$FAIL_REPO" && "$DEV" tree --no-attach --stage-agent victim >/dev/null 2>&1)
VICTIM="$TMP_DIR/destructive-worktrees/victim"
printf 'victim\n' >"$VICTIM/file"
git -C "$VICTIM" add . && git -C "$VICTIM" commit -qm victim
before_main="$(git -C "$FAIL_REPO" rev-parse main)"
cp "$REGISTRY" "$TMP_DIR/before-git-failure.json"
printf '{invalid\n' >"$REGISTRY"
if (cd "$FAIL_REPO" && "$DEV" kill --force victim >/dev/null 2>"$TMP_DIR/err"); then fail 'kill accepted invalid registry'; fi
assert_exists "$VICTIM"
assert_exists "$FAKE_TMUX_DIR/sessions/destructive-victim"
git -C "$FAIL_REPO" show-ref --verify --quiet refs/heads/victim || fail 'invalid registry allowed branch deletion'
if (cd "$FAIL_REPO" && "$DEV" merge victim main >/dev/null 2>"$TMP_DIR/err"); then fail 'merge accepted invalid registry'; fi
assert_equals "$(git -C "$FAIL_REPO" rev-parse main)" "$before_main"
assert_exists "$VICTIM"
assert_exists "$FAKE_TMUX_DIR/sessions/destructive-victim"
cp "$TMP_DIR/before-git-failure.json" "$REGISTRY"
export DEV_REAL_GIT="$(command -v git)"
cat >"$FAKE_BIN/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
"$DEV_REAL_GIT" "$@"
case " $* " in
    *' worktree remove '*)
        if [ "${DEV_TEST_BLOCK_REGISTRY_WRITE:-}" = true ]; then chmod a-w "$XDG_STATE_HOME/dev"; fi
        ;;
esac
EOF
chmod +x "$FAKE_BIN/git"
export DEV_TEST_BLOCK_REGISTRY_WRITE=true
if (cd "$FAIL_REPO" && "$DEV" kill --force victim >/dev/null 2>"$TMP_DIR/err"); then fail 'kill hid post-removal persistence failure'; fi
chmod u+w "$XDG_STATE_HOME/dev"
unset DEV_TEST_BLOCK_REGISTRY_WRITE
assert_contains "$(cat "$TMP_DIR/err")" 'Session/branch cleanup will continue'
assert_absent "$VICTIM"
assert_absent "$FAKE_TMUX_DIR/sessions/destructive-victim"
if git -C "$FAIL_REPO" show-ref --verify --quiet refs/heads/victim; then fail 'persistence failure skipped branch cleanup'; fi
python3 - "$REGISTRY" "$VICTIM" <<'PY'
import json, sys
assert sys.argv[2] in json.load(open(sys.argv[1]))["sessions"]
PY
(cd "$FAIL_REPO" && "$DEV" tree --no-attach --stage-agent merged >/dev/null 2>&1)
MERGED="$TMP_DIR/destructive-worktrees/merged"
printf 'merged\n' >"$MERGED/merged-file"
git -C "$MERGED" add . && git -C "$MERGED" commit -qm merged
export DEV_TEST_BLOCK_REGISTRY_WRITE=true
if (cd "$FAIL_REPO" && "$DEV" merge merged main >/dev/null 2>"$TMP_DIR/err"); then fail 'merge hid post-removal persistence failure'; fi
chmod u+w "$XDG_STATE_HOME/dev"
unset DEV_TEST_BLOCK_REGISTRY_WRITE
assert_contains "$(cat "$TMP_DIR/err")" 'Session/branch cleanup will continue'
assert_exists "$FAIL_REPO/merged-file"
assert_absent "$MERGED"
assert_absent "$FAKE_TMUX_DIR/sessions/destructive-merged"
if git -C "$FAIL_REPO" show-ref --verify --quiet refs/heads/merged; then fail 'merge persistence failure skipped branch cleanup'; fi
python3 - "$REGISTRY" "$MERGED" <<'PY'
import json, sys
assert sys.argv[2] in json.load(open(sys.argv[1]))["sessions"]
PY
# --no-attach initializers cannot leak a bypass marker to descendants. A stale
# marker (even fd 3) must not authorize a second public lifecycle operation.
wait_for_file() {
    local i
    for i in {1..100}; do [ -f "$1" ] && return; sleep 0.05; done
    fail "timed out waiting for $1"
}
LOCK_REPO="$TMP_DIR/lock-repo"
export DEV_TEST_LOCK_ROOT="$TMP_DIR/lock-signals" DEV_TEST_LOCK_PLAIN="$TMP_DIR/lock-plain" DEV_TEST_BIN="$DEV"
mkdir -p "$DEV_TEST_LOCK_ROOT" "$DEV_TEST_LOCK_PLAIN"
printf '{"windows":[{"name":"shell"}]}' >"$DEV_TEST_LOCK_PLAIN/devConfig.jsonc"
git init -q -b main "$LOCK_REPO"
cat >"$LOCK_REPO/.worktree-init.sh" <<'EOF'
case "$WORKTREE_PATH" in
    */seed)
        (
            while [ ! -f "$DEV_TEST_LOCK_ROOT/go" ]; do sleep 0.05; done
            printf '%s' "${DEV_LIFECYCLE_LOCK_FD:-}" >"$DEV_TEST_LOCK_ROOT/inherited-marker"
            python3 - <<'PY' >"$DEV_TEST_LOCK_ROOT/inherited-fd"
import os
from pathlib import Path
lock = (Path(os.environ["XDG_STATE_HOME"]) / "dev/lifecycle.lock").stat()
for fd in range(3, 64):
    try:
        inherited = os.fstat(fd)
    except OSError:
        continue
    if (inherited.st_dev, inherited.st_ino) == (lock.st_dev, lock.st_ino):
        print("open")
        break
else:
    print("closed")
PY
            touch "$DEV_TEST_LOCK_ROOT/attempted"
            DEV_LIFECYCLE_LOCK_FD=3 "$DEV_TEST_BIN" open "$DEV_TEST_LOCK_PLAIN" >"$DEV_TEST_LOCK_ROOT/out" 2>"$DEV_TEST_LOCK_ROOT/err"
            printf '%s\n' "$?" >"$DEV_TEST_LOCK_ROOT/done"
        ) >/dev/null 2>&1 &
        ;;
    */nested)
        "$DEV_TEST_BIN" open "$DEV_TEST_LOCK_PLAIN" >"$DEV_TEST_LOCK_ROOT/nested-out" 2>"$DEV_TEST_LOCK_ROOT/nested-err"
        ;;
    */hold)
        touch "$DEV_TEST_LOCK_ROOT/holding"
        while [ ! -f "$DEV_TEST_LOCK_ROOT/release" ]; do sleep 0.05; done
        ;;
esac
EOF
git -C "$LOCK_REPO" add . && git -C "$LOCK_REPO" commit -qm init
out="$(cd "$LOCK_REPO" && "$DEV" tree --no-attach --stage-agent seed 2>/dev/null)"
assert_equals "$out" "$TMP_DIR/lock-repo-worktrees/seed"
(cd "$LOCK_REPO" && "$DEV" tree --no-attach --stage-agent hold >/dev/null 2>"$TMP_DIR/hold-err") &
hold_pid=$!
wait_for_file "$DEV_TEST_LOCK_ROOT/holding"
touch "$DEV_TEST_LOCK_ROOT/go"
wait_for_file "$DEV_TEST_LOCK_ROOT/attempted"
sleep 0.3
assert_absent "$DEV_TEST_LOCK_ROOT/done"
assert_absent "$FAKE_TMUX_DIR/sessions/lock-plain-dev"
touch "$DEV_TEST_LOCK_ROOT/release"
wait "$hold_pid" || fail 'holding lifecycle operation failed'
wait_for_file "$DEV_TEST_LOCK_ROOT/done"
assert_equals "$(cat "$DEV_TEST_LOCK_ROOT/inherited-marker")" ''
assert_equals "$(cat "$DEV_TEST_LOCK_ROOT/inherited-fd")" closed
assert_equals "$(cat "$DEV_TEST_LOCK_ROOT/done")" 0
assert_exists "$FAKE_TMUX_DIR/sessions/lock-plain-dev"
# Synchronous nested lifecycle calls fail explicitly instead of waiting for
# their own initializer. A live but unrelated PID cannot trigger that error.
if (cd "$LOCK_REPO" && "$DEV" tree --no-attach --stage-agent nested >/dev/null 2>"$TMP_DIR/nested-err"); then
    fail 'synchronous nested lifecycle command succeeded'
fi
assert_contains "$(cat "$DEV_TEST_LOCK_ROOT/nested-err")" 'cannot run synchronously inside an active worktree initializer'
assert_absent "$FAKE_TMUX_DIR/sessions/lock-repo-nested"
sleep 30 &
unrelated_pid=$!
DEV_INITIALIZER_PID="$unrelated_pid" "$DEV" open "$DEV_TEST_LOCK_PLAIN" >/dev/null
kill "$unrelated_pid"
wait "$unrelated_pid" 2>/dev/null || true
python3 "$REPO_DIR/tests/dev-workspace.test.py"
printf 'dev tests passed\n'
