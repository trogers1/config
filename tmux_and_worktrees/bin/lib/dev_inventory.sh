# Shared, read-only inventory for dev --list and dev switch.
# Rows: kind<TAB>session<TAB>branch<TAB>checkout-status<TAB>absolute-path.
# Nonempty placeholders keep Bash's tab-delimited read from shifting fields.
tmux_worktree_checkout_info() {
    local checkout_path="$1"
    local branch="${2:--}"
    local checkout_root=""
    local status=""
    local detail="${3:-detailed}"

    if [ ! -d "$checkout_path" ]; then
        printf '%s\tmissing\n' "$branch"
        return
    fi
    if ! command -v git >/dev/null 2>&1 || ! checkout_root="$(git -C "$checkout_path" rev-parse --show-toplevel 2>/dev/null)"; then
        printf '%s\tnot-git\n' "$branch"
        return
    fi
    if [ "$(tmux_worktree_physical_path "$checkout_root")" != "$(tmux_worktree_physical_path "$checkout_path")" ]; then
        printf '%s\tunavailable\n' "$branch"
        return
    fi
    branch="$(git -C "$checkout_path" symbolic-ref --quiet --short HEAD || true)"
    if [ "$detail" = picker ]; then
        printf '%s\tready\n' "${branch:-(detached)}"
        return
    fi
    status="$(git --no-optional-locks -C "$checkout_path" status --porcelain)" || return 1
    if [ -n "$status" ]; then status=dirty; else status=clean; fi
    printf '%s\t%s\n' "${branch:-(detached)}" "$status"
}

tmux_worktree_inventory_row() {
    local kind="$1" session="$2" checkout_path="$3" branch="${4:--}"
    local info="" value="" mode="${5:-detailed}"
    # The existing Git/tmux helpers exchange line-oriented paths. Reject
    # unsupported delimiters explicitly rather than connecting to a wrong path.
    case "$checkout_path" in
        /*) ;;
        *) echo "dev inventory: expected an absolute checkout path: $checkout_path" >&2; return 1 ;;
    esac
    for value in "$session" "$checkout_path" "$branch"; do
        if printf '%s' "$value" | LC_ALL=C grep -q '[[:cntrl:]]'; then
            echo 'dev inventory: control characters in names or paths are unsupported' >&2
            return 1
        fi
    done
    if [ "$mode" != detailed ] && [ "$kind" = open ]; then
        info="$(printf '%s\t-' "$branch")"
    elif [ "$mode" != detailed ] && [ "$kind" = available ]; then
        if [ -d "$checkout_path" ]; then info="$(printf '%s\tready' "$branch")"
        else info="$(printf '%s\tmissing' "$branch")"; fi
    else
        info="$(tmux_worktree_checkout_info "$checkout_path" "$branch" "$mode")" || return 1
    fi
    printf '%s\t%s\t%s\t%s\n' "$kind" "$session" "$info" "$checkout_path"
}

tmux_worktree_inventory() {
    local LC_ALL=C # Bash 3.2 read must preserve multibyte path bytes exactly.
    local mode="${1:-detailed}"
    local session="" checkout_path="" branch="" repo_root=""
    local sessions="" records="" worktrees="" created="" session_id="" index="" live_index=""
    local seen_paths=("") # Keep expansion safe under Bash 3.2's nounset.
    local live_paths=("") live_sessions=("") live_branches=("")

    # Only path-tagged sessions are managed; never infer ownership from names.
    # Creation time/id gives pre-registry sessions a deterministic opening order.
    if command -v tmux >/dev/null 2>&1; then
        sessions="$(tmux list-sessions -F $'#{session_created}\t#{session_id}\t#{session_name}' 2>/dev/null | sort -t $'\t' -k1,1n -k2.2,2n || true)"
        while IFS=$'\t' read -r created session_id session; do
            [ -n "$session" ] || continue
            checkout_path="$(tmux_worktree_get_session_worktree_path "$session" || true)"
            [ -n "$checkout_path" ] || continue
            branch="$(tmux_worktree_get_session_env "$session" DTREE_BRANCH || true)"
            live_paths+=("$checkout_path")
            live_sessions+=("$session")
            live_branches+=("${branch:--}")
        done <<<"$sessions"
    fi

    # The small registry defines opening order for both scopes. OPEN still never
    # probes Git or discovers available worktrees, even for missing saved paths.
    records="$(tmux_worktree_registry list)" || return 1
    while IFS=$'\t' read -r checkout_path session; do
        [ -n "$checkout_path" ] || continue
        live_index=""
        for index in "${!live_paths[@]}"; do
            if [ "${live_paths[$index]}" = "$checkout_path" ]; then live_index="$index"; break; fi
        done
        if [ -n "$live_index" ]; then
            tmux_worktree_inventory_row open "${live_sessions[$live_index]}" "$checkout_path" "${live_branches[$live_index]}" "$mode" || return 1
        elif [ "$mode" != open ]; then
            tmux_worktree_inventory_row saved "$session" "$checkout_path" - "$mode" || return 1
        fi
        seen_paths+=("$checkout_path")
    done <<<"$records"

    # Never hide live tagged sessions that predate persistent tracking.
    for index in "${!live_paths[@]}"; do
        checkout_path="${live_paths[$index]}"
        [ -n "$checkout_path" ] || continue
        if tmux_worktree_session_is_excluded "$checkout_path" "${seen_paths[@]}"; then continue; fi
        tmux_worktree_inventory_row open "${live_sessions[$index]}" "$checkout_path" "${live_branches[$index]}" "$mode" || return 1
        seen_paths+=("$checkout_path")
    done
    [ "$mode" != open ] || return 0

    if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        repo_root="$(tmux_worktree_main_repo_root)" || return 1
        worktrees="$(tmux_worktree_list_worktrees "$repo_root")" || return 1
        while IFS=$'\t' read -r checkout_path branch; do
            [ -n "$checkout_path" ] || continue
            if tmux_worktree_session_is_excluded "$checkout_path" "${seen_paths[@]}"; then continue; fi
            tmux_worktree_inventory_row available - "$checkout_path" "${branch:-(detached)}" "$mode" || return 1
        done <<<"$worktrees"
    fi
}

tmux_worktree_print_inventory() {
    local LC_ALL=C
    local kind="" session="" branch="" status="" checkout_path="" repo_root=""
    if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        repo_root="$(tmux_worktree_main_repo_root)" || return 1
        printf 'Repository: %s\nDefault worktree directory: %s\n\n' "$repo_root" "$(tmux_worktree_default_root "$repo_root")"
    else
        printf 'Outside a Git checkout; showing managed sessions only.\n\n'
    fi
    if [ ! -s "$1" ]; then
        printf 'No managed sessions or available worktrees.\n'
        return
    fi
    while IFS=$'\t' read -r kind session branch status checkout_path; do
        printf '%s: %s\n  path: %s\n  branch: %s\n  status: %s\n' "$kind" "$session" "$checkout_path" "$branch" "$status"
        case "$kind" in
            open)
                if [ -n "${TMUX:-}" ]; then
                    printf '  connect: tmux switch-client -t %q\n' "=$session"
                else
                    printf '  connect: tmux attach-session -t %q\n' "=$session"
                fi
                ;;
            saved) printf '  connect: dev switch (select this saved session; exact resume only)\n' ;;
            available)
                case "$status" in
                    clean|dirty) printf '  connect: dev new %q\n' "$checkout_path" ;;
                    *) printf '  connect: unavailable; restore this checkout first\n' ;;
                esac
                ;;
        esac
        printf '\n'
    done <"$1"
}

# A snapshot is shared by display and selection validation. Temporary state is
# removed before connecting; no picker text is ever interpreted as shell code.
tmux_worktree_list_inventory() (
    local snapshot=""
    snapshot="$(mktemp)" || return 1
    trap 'rm -f "$snapshot"' EXIT
    tmux_worktree_inventory >"$snapshot" || return 1
    tmux_worktree_print_inventory "$snapshot"
)

tmux_worktree_switch_inventory() (
    local LC_ALL=C
    local snapshot="" selection="" row="" found=false code=0 index="" toggle=""
    local snapshot_raw="" snapshot_display=""
    local kind="" session="" branch="" status="" checkout_path=""
    local picker_args=(--no-multi --delimiter=$'\t' --with-nth=2..
        --header-lines=1 --prompt='OPEN> '
        --header='OPEN sessions | Ctrl+A: show ALL sessions/worktrees | Esc: cancel')
    if ! command -v fzf >/dev/null 2>&1; then
        echo 'dev switch requires fzf; install fzf and retry.' >&2
        return 1
    fi
    snapshot="$(mktemp -d)" || return 1
    trap 'rm -rf "$snapshot"' EXIT
    tmux_worktree_inventory open >"$snapshot/open.raw" || return 1
    python3 "$SCRIPT_DIR/lib/dev_picker_format.py" "$snapshot/open.raw" o >"$snapshot/open" || return 1
    # Fixed commands only: no query or inventory text is interpreted by a shell.
    # reload (not execute) lets fzf render Loading immediately, show its native
    # spinner, and cancel the entire discovery process group on toggle or exit.
    toggle='if [ "$FZF_PROMPT" = "OPEN> " ]; then printf '\''%s'\'' '\''change-prompt(ALL> )+change-header(Loading available sessions/worktrees… | Ctrl+A: show OPEN sessions | Esc: cancel)+reload(exec bash "$DEV_PICKER_HELPER")'\''; else printf '\''%s'\'' '\''change-prompt(OPEN> )+change-header(OPEN sessions | Ctrl+A: show ALL sessions/worktrees | Esc: cancel)+reload(rm -f "$DEV_PICKER_DIR/error"; cat "$DEV_PICKER_OPEN")'\''; fi'
    local loaded='if [ "$FZF_PROMPT" = "ALL> " ]; then if [ -f "$DEV_PICKER_DIR/error" ]; then printf '\''%s'\'' '\''change-header(ALL discovery failed — Esc: cancel and run dev --list for details | Ctrl+A: show OPEN sessions)'\''; else printf '\''%s'\'' '\''change-header(ALL sessions/worktrees | Ctrl+A: show OPEN sessions | Esc: cancel)'\''; fi; fi'
    picker_args+=(--bind="ctrl-a:transform:$toggle" --bind="load:transform:$loaded")
    if [ -n "${TMUX:-}" ]; then picker_args+=(--tmux=center,80%,70%); fi
    # Do not inherit user defaults that can execute actions, enable multi-select,
    # or change output format. fzf gets only this read-only inventory.
    selection="$(FZF_DEFAULT_OPTS= FZF_DEFAULT_OPTS_FILE=/dev/null \
        DEV_PICKER_DIR="$snapshot" DEV_PICKER_ALL="$snapshot/all" DEV_PICKER_OPEN="$snapshot/open" \
        DEV_PICKER_HELPER="$SCRIPT_DIR/lib/dev_picker_reload.sh" \
        fzf "${picker_args[@]}" <"$snapshot/open")" || code=$?
    if [ -f "$snapshot/error" ]; then
        echo 'dev switch: unable to load available sessions/worktrees; fix discovery and retry (dev --list for details).' >&2
        cat "$snapshot/error" >&2
        return 1
    fi
    case "$code" in
        0) ;;
        1|130) return 0 ;;
        *) echo "dev switch: fzf failed (exit $code)" >&2; return "$code" ;;
    esac
    [ -n "$selection" ] || return 0
    index="${selection%%$'\t'*}"
    case "$index" in
        o*) snapshot_raw="$snapshot/open.raw"; snapshot_display="$snapshot/open" ;;
        a*) snapshot_raw="$snapshot/all.raw"; snapshot_display="$snapshot/all" ;;
        *) snapshot_raw=""; snapshot_display="" ;;
    esac
    if [ -f "$snapshot_display" ]; then
        while IFS= read -r row; do
            if [ "$selection" = "$row" ]; then found=true; break; fi
        done <"$snapshot_display"
    fi
    if [ "$found" != true ]; then
        echo 'dev switch: invalid picker selection (not an inventory entry)' >&2
        return 1
    fi
    index="${index#?}"
    row="$(awk -v selected="$index" 'NR == selected' "$snapshot_raw")" || return 1
    IFS=$'\t' read -r kind session branch status checkout_path <<<"$row"
    rm -rf "$snapshot"
    trap - EXIT
    case "$kind" in
        open) ;;
        saved)
            # Wait for the lifecycle wrapper to exit and release its lock BEFORE
            # attaching (which can remain blocked for the client's lifetime).
            tmux_worktree_registry run python3 "$SCRIPT_DIR/lib/dev_registry.py" resume "$checkout_path" || return 1
            session="$(tmux_worktree_find_session_for_worktree_path "$checkout_path")" || return 1
            if [ -z "$session" ]; then
                echo "dev switch: restored session not found for $checkout_path" >&2
                return 1
            fi
            ;;
        available)
            case "$status" in
                ready) "$SCRIPT_DIR/dev" new "$checkout_path"; return ;;
                *) echo "dev switch: checkout unavailable ($status): $checkout_path" >&2; return 1 ;;
            esac
            ;;
        *) echo "dev switch: invalid inventory kind: $kind" >&2; return 1 ;;
    esac
    if [ -n "${TMUX:-}" ]; then
        tmux switch-client -t "=$session"
    else
        tmux attach-session -t "=$session"
    fi
)
