# Shared options and prompt preflight for fresh dev sessions.
# Callers supply usage() and consume the resolved globals below.
tmux_worktree_parse_launch_options() {
    local entry_point="$1"
    shift
    agent=""
    stage_agent=false
    no_attach=false
    nvim_command=""
    launch_manifest=""
    launch_prepared_windows=""
    launch_prepared_agent=""
    launch_prompt_args=()
    launch_context_args=()
    launch_profile=""
    positionals=()
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --agent|--agent-profile|--prompt|--prompt-file|--nvim-command)
                if [ "$#" -lt 2 ]; then
                    echo "Missing value for $1" >&2
                    return 1
                fi
                case "$1" in
                    --agent)
                        [ -n "$2" ] || { echo 'Missing value for --agent' >&2; return 1; }
                        agent="$2"
                        ;;
                    --agent-profile)
                        [ -n "$2" ] || { echo 'Missing value for --agent-profile' >&2; return 1; }
                        [ -z "$launch_profile" ] || { echo 'Supply --agent-profile only once.' >&2; return 1; }
                        launch_profile="$2"
                        ;;
                    --prompt|--prompt-file)
                        if [ "${#launch_prompt_args[@]}" -ne 0 ]; then
                            echo 'Supply only one of --prompt TEXT or --prompt-file PATH.' >&2
                            return 1
                        fi
                        launch_prompt_args=("$1=$2")
                        ;;
                    --nvim-command)
                        [ "$entry_point" = new ] || { echo "Unknown option: $1" >&2; return 1; }
                        nvim_command="$2"
                        ;;
                esac
                shift 2
                ;;
            --stage-agent) stage_agent=true; shift ;;
            --no-attach) no_attach=true; shift ;;
            --) shift; positionals+=("$@"); break ;;
            --help|-h) usage; exit 0 ;;
            -*) echo "Unknown option: $1" >&2; return 1 ;;
            *) positionals+=("$1"); shift ;;
        esac
    done
}

tmux_worktree_launch_helper() {
    python3 "$(dirname "${BASH_SOURCE[0]}")/dev_launch.py" "$@"
}

tmux_worktree_reject_existing_launch() {
    local session_name="$1"
    if [ -n "$session_name" ] && tmux_worktree_has_launch_options; then
        echo "Session $session_name already exists; prompt/profile options require a fresh session. Use dev close first or choose another worktree." >&2
        return 1
    fi
}

tmux_worktree_has_launch_options() {
    [ "${#launch_prompt_args[@]}" -ne 0 ] || [ -n "$launch_profile" ]
}

# Validate without publication before asking permission to replace a workspace.
tmux_worktree_validate_launch() {
    local launch_args=(--agent="$session_agent")
    [ "${#launch_prompt_args[@]}" -eq 0 ] || launch_args+=("${launch_prompt_args[@]}")
    [ -z "$launch_profile" ] || launch_args+=(--agent-profile="$launch_profile")
    if tmux_worktree_has_launch_options; then
        printf '%s\n' "$windows" | tmux_worktree_launch_helper validate "${launch_args[@]}" "${launch_context_args[@]}"
    fi
}

# Snapshot only after workspace consent, before checkout or startup scripts.
# No prompt text enters a tmux shell.
tmux_worktree_prepare_launch() {
    local launch_args=(--agent="$session_agent")
    [ "${#launch_prompt_args[@]}" -eq 0 ] || launch_args+=("${launch_prompt_args[@]}")
    [ -z "$launch_profile" ] || launch_args+=(--agent-profile="$launch_profile")
    if ! tmux_worktree_has_launch_options; then
        return 0
    fi
    if [ -n "$launch_manifest" ]; then
        if [ "$launch_prepared_agent" != "$session_agent" ]; then
            echo 'Selected agent changed while resolving the launch; retry with an explicit --agent.' >&2
            return 1
        fi
        # Revalidate the actual chosen ref without rereading mutable input.
        printf '%s\n' "$windows" | tmux_worktree_launch_helper windows "$launch_manifest" "${launch_context_args[@]}" >/dev/null || return 1
    else
        launch_manifest="$(printf '%s\n' "$windows" | tmux_worktree_launch_helper prepare "${launch_args[@]}" "${launch_context_args[@]}")" || return 1
    fi
    tmux_worktree_launch_helper command "$launch_manifest" >/dev/null || return 1
    launch_prepared_windows="$windows"
    launch_prepared_agent="$session_agent"
}
