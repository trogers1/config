# Shared by the worktree hooks: reads one required string field from the hook's
# JSON input, and finds Homebrew tools. Sourced, not run.

hook_input_field() {
    local input="$1"
    local field="$2"

    python3 -c '
import json, sys
value = json.loads(sys.argv[1]).get(sys.argv[2])
if not isinstance(value, str) or not value:
    sys.exit(f"hook input has no {sys.argv[2]!r} string")
print(value)
' "$input" "$field"
}

# The Claude desktop app runs hooks with the GUI's PATH, which usually lacks
# Homebrew, so tmux would not be found. Put each existing Homebrew bin directory
# that PATH lacks at its front, $HOMEBREW_PREFIX's first. A PATH that already
# has them, such as a terminal's, keeps its order.
hook_add_homebrew_to_path() {
    local dir=""
    local missing=""

    for dir in ${HOMEBREW_PREFIX:+"$HOMEBREW_PREFIX/bin"} /opt/homebrew/bin /usr/local/bin; do
        case ":$PATH:$missing" in
            *":$dir:"*) ;;
            *) if [ -d "$dir" ]; then missing="$missing$dir:"; fi ;;
        esac
    done
    PATH="$missing$PATH"
    export PATH
}
