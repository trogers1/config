tmux_worktree_require_command() {
    local command_name="$1"

    if ! command -v "$command_name" >/dev/null 2>&1; then
        echo "$command_name is required"
        exit 1
    fi
}

tmux_worktree_require_git() {
    tmux_worktree_require_command git
}

tmux_worktree_require_tmux() {
    tmux_worktree_require_command tmux
}

tmux_worktree_require_git_repo() {
    if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        echo "Run this from inside a git repository or worktree."
        exit 1
    fi
}

tmux_worktree_git_current_branch() {
    git symbolic-ref --quiet --short HEAD || true
}

tmux_worktree_main_repo_root() {
    local git_common_dir=""

    git_common_dir="$(git rev-parse --git-common-dir)"
    (cd "${git_common_dir}/.." && pwd)
}

tmux_worktree_resolve_project_path() {
    local target_path="$1"
    local project_path=""

    project_path="$(cd "$target_path" && pwd)"
    if command -v git >/dev/null 2>&1 && git -C "$project_path" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        git -C "$project_path" rev-parse --show-toplevel
    else
        printf '%s\n' "$project_path"
    fi
}

tmux_worktree_make_session_name() {
    printf '%s\n' "$1" | tr '/:.' '---'
}

tmux_worktree_preferred_local_session_name() {
    local project_path="$1"
    local project_name=""

    project_name="$(basename "$project_path")"
    tmux_worktree_make_session_name "${project_name}-dev"
}

tmux_worktree_preferred_worktree_session_name() {
    local repo_name="$1"
    local branch="$2"

    tmux_worktree_make_session_name "${repo_name}-${branch}"
}

tmux_worktree_path_checksum() {
    local input_path="$1"
    local checksum=""

    checksum="$(printf '%s' "$input_path" | cksum)"
    printf '%s\n' "${checksum%% *}"
}

tmux_worktree_attach_or_switch() {
    local session_name="$1"

    if [ -n "${TMUX:-}" ]; then
        tmux switch-client -t "$session_name"
    else
        tmux attach-session -t "$session_name"
    fi
}

tmux_worktree_current_session_name() {
    if [ -n "${TMUX:-}" ]; then
        tmux display-message -p '#S' 2>/dev/null || true
    fi
}

tmux_worktree_get_session_env() {
    local session_name="$1"
    local env_name="$2"
    local env_line=""

    env_line="$(tmux show-environment -t "$session_name" "$env_name" 2>/dev/null || true)"
    case "$env_line" in
        "$env_name"=*)
            printf '%s\n' "${env_line#*=}"
            return 0
            ;;
    esac

    return 1
}

tmux_worktree_get_session_worktree_path() {
    tmux_worktree_get_session_env "$1" DTREE_WORKTREE_PATH
}

tmux_worktree_set_session_metadata() {
    local session_name="$1"
    local worktree_path="$2"
    local branch="${3:-}"

    tmux set-environment -t "$session_name" DTREE_WORKTREE_PATH "$worktree_path"
    if [ -n "$branch" ]; then
        tmux set-environment -t "$session_name" DTREE_BRANCH "$branch"
    else
        tmux set-environment -u -t "$session_name" DTREE_BRANCH 2>/dev/null || true
    fi
}

tmux_worktree_find_session_for_worktree_path() {
    local target_path="$1"
    local session_name=""
    local session_path=""

    while IFS= read -r session_name; do
        [ -n "$session_name" ] || continue

        session_path="$(tmux_worktree_get_session_worktree_path "$session_name" || true)"
        if [ "$session_path" = "$target_path" ]; then
            printf '%s\n' "$session_name"
            return 0
        fi
    done < <(tmux list-sessions -F '#{session_name}' 2>/dev/null || true)

    return 1
}

tmux_worktree_collect_sessions_for_worktree_path() {
    local target_path="$1"
    local preferred_session_name="${2:-}"
    local session_name=""
    local session_path=""

    while IFS= read -r session_name; do
        [ -n "$session_name" ] || continue

        session_path="$(tmux_worktree_get_session_worktree_path "$session_name" || true)"
        if [ "$session_path" = "$target_path" ] || { [ -n "$preferred_session_name" ] && [ "$session_name" = "$preferred_session_name" ]; }; then
            printf '%s\n' "$session_name"
        fi
    done < <(tmux list-sessions -F '#{session_name}' 2>/dev/null || true)
}

tmux_worktree_kill_sessions_for_worktree_path() {
    local target_path="$1"
    local preferred_session_name="${2:-}"
    local current_session_name="${3:-}"
    local session_name=""
    local matches=()

    while IFS= read -r session_name; do
        [ -n "$session_name" ] || continue
        matches+=("$session_name")
    done < <(tmux_worktree_collect_sessions_for_worktree_path "$target_path" "$preferred_session_name")

    if [ "${#matches[@]}" -eq 0 ]; then
        return 1
    fi

    for session_name in "${matches[@]}"; do
        if [ "$session_name" != "$current_session_name" ]; then
            tmux kill-session -t "$session_name" 2>/dev/null || true
        fi
    done

    for session_name in "${matches[@]}"; do
        if [ "$session_name" = "$current_session_name" ]; then
            tmux kill-session -t "$session_name" 2>/dev/null || true
        fi
    done
}

tmux_worktree_create_standard_session() {
    local session_name="$1"
    local worktree_path="$2"
    local branch="${3:-}"

    tmux new-session -d -s "$session_name" -n nvim -c "$worktree_path"
    tmux_worktree_set_session_metadata "$session_name" "$worktree_path" "$branch"
    tmux send-keys -t "$session_name:nvim" "nvim" C-m

    tmux new-window -t "$session_name:" -n opencode -c "$worktree_path"
    tmux send-keys -t "$session_name:opencode" "opencode" C-m

    tmux new-window -t "$session_name:" -n lazygit -c "$worktree_path"
    tmux send-keys -t "$session_name:lazygit" "lazygit" C-m

    tmux new-window -t "$session_name:" -n term -c "$worktree_path"
    tmux select-window -t "$session_name:nvim"
}

tmux_worktree_path_for_branch() {
    local repo_root="$1"
    local branch="$2"

    git -C "$repo_root" worktree list --porcelain | awk -v target="refs/heads/$branch" '
        $1 == "worktree" { path = $2 }
        $1 == "branch" && $2 == target { print path; exit }
    '
}
