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
    local from_dir="${1:-.}"
    local git_common_dir=""

    git_common_dir="$(cd "$from_dir" && git rev-parse --git-common-dir)"
    (cd "$from_dir" && cd "${git_common_dir}/.." && pwd)
}

# The main checkout that owns a branch-or-path target: a directory names its
# own repository, so `dev kill <path>` works from anywhere; a branch is looked
# up in the repository of the current directory.
tmux_worktree_main_repo_root_for_target() {
    local target="$1"

    if [ -d "$target" ]; then
        if ! git -C "$target" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
            echo "Not inside a git worktree: $target" >&2
            return 1
        fi
        tmux_worktree_main_repo_root "$target"
    else
        tmux_worktree_require_git_repo
        tmux_worktree_main_repo_root
    fi
}

tmux_worktree_default_root() {
    local repo_root="$1"
    local repo_parent=""
    local repo_name=""

    repo_parent="$(dirname "$repo_root")"
    repo_name="$(basename "$repo_root")"

    printf '%s\n' "$repo_parent/${repo_name}-worktrees"
}

tmux_worktree_default_path() {
    local repo_root="$1"
    local branch="$2"

    printf '%s\n' "$(tmux_worktree_default_root "$repo_root")/$branch"
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

    # Unmanaged sessions have no recorded path, so an empty target would match
    # every one of them.
    if [ -z "$target_path" ]; then
        echo "tmux_worktree_collect_sessions_for_worktree_path: empty worktree path" >&2
        return 1
    fi

    while IFS= read -r session_name; do
        [ -n "$session_name" ] || continue

        session_path="$(tmux_worktree_get_session_worktree_path "$session_name" || true)"
        if [ "$session_path" = "$target_path" ] || { [ -n "$preferred_session_name" ] && [ "$session_name" = "$preferred_session_name" ]; }; then
            printf '%s\n' "$session_name"
        fi
    done < <(tmux list-sessions -F '#{session_name}' 2>/dev/null || true)
}

tmux_worktree_session_is_excluded() {
    local target_session="$1"
    shift || true

    local excluded_session=""
    for excluded_session in "$@"; do
        if [ "$target_session" = "$excluded_session" ]; then
            return 0
        fi
    done

    return 1
}

tmux_worktree_find_last_used_managed_session() {
    local excluded_sessions=("$@")
    local session_name=""
    local session_last_attached=""
    local session_path=""
    local best_session_name=""
    local best_last_attached="-1"

    while IFS=$'\t' read -r session_name session_last_attached; do
        [ -n "$session_name" ] || continue

        if tmux_worktree_session_is_excluded "$session_name" "${excluded_sessions[@]}"; then
            continue
        fi

        session_path="$(tmux_worktree_get_session_worktree_path "$session_name" || true)"
        if [ -z "$session_path" ]; then
            continue
        fi

        session_last_attached="${session_last_attached:-0}"
        if [ "$session_last_attached" -gt "$best_last_attached" ]; then
            best_session_name="$session_name"
            best_last_attached="$session_last_attached"
        fi
    done < <(tmux list-sessions -F '#{session_name}	#{session_last_attached}' 2>/dev/null || true)

    if [ -n "$best_session_name" ]; then
        printf '%s\n' "$best_session_name"
        return 0
    fi

    return 1
}

tmux_worktree_kill_sessions_for_worktree_path() {
    local target_path="$1"
    local preferred_session_name="${2:-}"
    local current_session_name="${3:-}"
    local session_name=""
    local matches=()
    local fallback_session_name=""

    while IFS= read -r session_name; do
        [ -n "$session_name" ] || continue
        matches+=("$session_name")
    done < <(tmux_worktree_collect_sessions_for_worktree_path "$target_path" "$preferred_session_name")

    if [ "${#matches[@]}" -eq 0 ]; then
        return 1
    fi

    if [ -n "$current_session_name" ] && tmux_worktree_session_is_excluded "$current_session_name" "${matches[@]}"; then
        fallback_session_name="$(tmux_worktree_find_last_used_managed_session "${matches[@]}" || true)"
        if [ -n "$fallback_session_name" ]; then
            tmux switch-client -t "$fallback_session_name"
        fi
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

tmux_worktree_default_dev_config_path() {
    local lib_dir=""

    lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    printf '%s\n' "$(cd "$lib_dir/../.." && pwd)/devConfig.jsonc"
}

tmux_worktree_dev_config_path() {
    local worktree_path="$1"
    local project_config="$worktree_path/devConfig.jsonc"
    local default_config=""

    if [ -f "$project_config" ]; then
        printf '%s\n' "$project_config"
        return 0
    fi

    default_config="$(tmux_worktree_default_dev_config_path)"
    if [ -f "$default_config" ]; then
        printf '%s\n' "$default_config"
        return 0
    fi

    return 1
}

tmux_worktree_read_dev_config_windows() {
    local config_path="$1"
    local agent="${2:-}"
    local lib_dir=""

    lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    if [ -n "$agent" ]; then
        python3 "$lib_dir/read_dev_config_windows.py" "$config_path" "$agent"
    else
        python3 "$lib_dir/read_dev_config_windows.py" "$config_path"
    fi
}

tmux_worktree_create_standard_session() {
    local session_name="$1"
    local worktree_path="$2"
    local branch="${3:-}"
    local nvim_command="${4:-}"
    local agent="${5:-}"
    local stage_agent="${6:-false}"
    local config_path=""
    local windows=""
    local window_kind=""
    local window_name=""
    local window_command=""
    local first_window_name=""
    local created_first_window=false

    if ! config_path="$(tmux_worktree_dev_config_path "$worktree_path")"; then
        echo "No devConfig.jsonc found for $worktree_path" >&2
        exit 1
    fi
    # Read the whole config before creating anything so an invalid config or
    # agent fails without leaving a partial session behind.
    windows="$(tmux_worktree_read_dev_config_windows "$config_path" "$agent")"

    while IFS=$'\t' read -r window_kind window_name window_command; do
        [ -n "$window_name" ] || continue

        if [ -n "$nvim_command" ] && [ "$window_name" = "nvim" ]; then
            window_command="$nvim_command"
        fi

        if [ "$created_first_window" = false ]; then
            tmux new-session -d -s "$session_name" -n "$window_name" -c "$worktree_path"
            tmux_worktree_set_session_metadata "$session_name" "$worktree_path" "$branch"
            first_window_name="$window_name"
            created_first_window=true
        else
            tmux new-window -t "$session_name:" -n "$window_name" -c "$worktree_path"
        fi

        if [ -z "$window_command" ]; then
            :
        elif [ "$window_kind" = agent ] && [ "$stage_agent" = true ]; then
            # Typed at the prompt but not run, so the agent starts only when
            # someone presses Enter in that window.
            tmux send-keys -t "$session_name:$window_name" "$window_command"
        else
            tmux send-keys -t "$session_name:$window_name" "$window_command" C-m
        fi
    done <<<"$windows"

    if [ "$created_first_window" = false ]; then
        echo "No windows configured in $config_path"
        exit 1
    fi

    tmux select-window -t "$session_name:$first_window_name"
}

# Prints one "<path>\t<branch>" line per worktree git knows about, including the
# primary checkout. Detached and bare worktrees have an empty branch. This is
# the source of truth for worktree locations: worktrees created by other tools
# (for example Claude Code's .claude/worktrees/) need not follow dev's layout.
tmux_worktree_list_worktrees() {
    local repo_root="$1"

    git -C "$repo_root" worktree list --porcelain | awk '
        /^worktree / { if (seen) print path "\t" branch; path = substr($0, 10); branch = ""; seen = 1 }
        /^branch refs\/heads\// { branch = substr($0, 19) }
        END { if (seen) print path "\t" branch }
    '
}

tmux_worktree_path_for_branch() {
    local repo_root="$1"
    local branch="$2"
    local wt_path=""
    local wt_branch=""

    while IFS=$'\t' read -r wt_path wt_branch; do
        if [ -n "$wt_branch" ] && [ "$wt_branch" = "$branch" ]; then
            printf '%s\n' "$wt_path"
            return 0
        fi
    done < <(tmux_worktree_list_worktrees "$repo_root")
}

tmux_worktree_physical_path() {
    (cd "$1" 2>/dev/null && pwd -P)
}

# Resolves a branch name or a path inside a worktree to "<path>\t<branch>",
# using the worktree's path exactly as git records it. Fails when the target
# names no worktree, or when it is both a directory and a different branch's
# worktree.
tmux_worktree_resolve_worktree() {
    local repo_root="$1"
    local target="$2"
    local branch_path=""
    local dir_top=""
    local dir_real=""
    local wt_path=""
    local wt_branch=""
    local dir_match=""
    local dir_match_branch=""

    branch_path="$(tmux_worktree_path_for_branch "$repo_root" "$target")"

    if [ -d "$target" ]; then
        if ! dir_top="$(git -C "$target" rev-parse --show-toplevel 2>/dev/null)"; then
            echo "Not inside a git worktree: $target" >&2
            return 1
        fi
        dir_real="$(tmux_worktree_physical_path "$dir_top")"
        while IFS=$'\t' read -r wt_path wt_branch; do
            if [ "$(tmux_worktree_physical_path "$wt_path")" = "$dir_real" ]; then
                dir_match="$wt_path"
                dir_match_branch="$wt_branch"
                break
            fi
        done < <(tmux_worktree_list_worktrees "$repo_root")

        if [ -z "$dir_match" ]; then
            echo "$target is not a worktree of $repo_root" >&2
            return 1
        fi
        if [ -n "$branch_path" ] && [ "$branch_path" != "$dir_match" ]; then
            echo "'$target' is ambiguous: it is the directory $dir_match and the branch checked out at $branch_path" >&2
            return 1
        fi
        printf '%s\t%s\n' "$dir_match" "$dir_match_branch"
        return 0
    fi

    if [ -z "$branch_path" ]; then
        echo "No worktree found for branch '$target'." >&2
        return 1
    fi
    printf '%s\t%s\n' "$branch_path" "$target"
}
