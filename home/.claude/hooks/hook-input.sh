# Shared by the worktree hooks: reads one required string field from the hook's
# JSON input. Sourced, not run.

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
