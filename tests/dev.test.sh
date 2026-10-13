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
trap 'rm -rf "$TMP_DIR"' EXIT

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
printf '%s\n' "$*" >>"$dir/log"
target=""
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
    case "${args[i]}" in -t|-s) target="${args[i + 1]}" ;; esac
done
target="${target%%:*}"
case "$1" in
    new-session) mkdir -p "$dir/sessions/$target" ;;
    has-session) [ -d "$dir/sessions/$target" ] ;;
    kill-session) rm -rf "${dir:?}/sessions/$target" ;;
    list-sessions)
        for session in "$dir/sessions"/*; do
            [ -d "$session" ] || continue
            case "$*" in
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
unset TMUX
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

printf 'dev tests passed\n'
