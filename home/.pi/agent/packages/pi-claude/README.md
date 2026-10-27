# Pi Claude provider

Repo-owned `claude-bridge` provider for Pi 0.99.1 or newer. Uses the official
Claude Agent SDK with the user's explicitly resolved installed Claude executable;
never silently uses the SDK-packaged runtime or falls back to API transport.

## Prompt ownership

The SDK uses the supported `claude_code` native base preset, with Pi-managed
instructions appended. This is **not native project/skill discovery**:
`settingSources: []`, empty native tools/skills, verbatim input, and the existing
hook/skill-shell restrictions remain unchanged. Project context, user additions,
skill descriptions/file references, tool guidance, guard/subagent instructions,
and custom extension sections remain Pi-owned. Reading a referenced skill file
is a Pi tool action subject to pi-guard, not native Skill execution. Already
expanded snippets remain literal user content; the provider does not expand them.

Only structured preamble/docs sections exactly matching the installed host's own
stock builder output are omitted. Customized sections and opaque forced/payload
rewrites are preserved additively, without parsing section-like text or fuzzy
deduplication. Payload hooks still inspect the complete Pi instruction string;
a rewritten string is appended verbatim to the native base.

Pi does not publicly export its prompt builder in 1.3.0. An isolated compatibility
adapter resolves only `dist/core/system-prompt.js` beneath the directory returned
by the host's public `getPackageDir()`, validates its builder/output, and fails
explicitly on incompatibility. The host honors `PI_PACKAGE_DIR`; deployments using
that override must supply a compatible builder there. The adapter does not
independently verify that this directory contains the loaded host implementation.
No copied stock prompt text or machine-specific host path is embedded here.
Prompt mode, source instructions, and effective payload instructions participate
in checkpoint matching; changed instructions require reconstruction rather than
reusing stale native context. Native preset/managed-instruction runtime fidelity
still requires separately authorized live verification.

## Trust and component policy

Claude's native external-action tools are disabled. Owned in-process MCP carries
model tool requests into real Pi tools and pi-guard; MCP itself does not perform
the actions. Authentication, session identity, tool and MCP ownership checks all
remain fail-closed.

Initialization must advertise **no skills**, and either no plugins or exactly one
native `cc-plugin-sec-default` record with source
`cc-plugin-sec-default@builtin` and path exactly `builtin` (the native registry
sentinel, not a filesystem path). An optional version must be a bounded nonempty
string and is informational only, never proof of provenance.
Missing/foreign sources, wrong names/paths, duplicates, additional fields in that
plugin record, additional plugins and malformed inventories are rejected before
Pi tool execution. There is no general `@builtin` whitelist.

Invocation-scoped settings disable exactly these optional plugins:

- `cc-plugin-agents-md@builtin`
- `cc-plugin-telemetry@builtin`
- `cc-plugin-plugin-authoring@builtin`

They also set `skillOverrides` to `off` for `design`, `doctor` and
`plugin-authoring`, in addition to the existing non-managed hooks, skill-shell,
bundled/synced skill/plugin, memory, connector and native feature restrictions.
The same settings are applied to the metadata-only auth-status command and SDK
query. They do not mutate global settings or remove installed files. Disabling
the telemetry plugin does not promise that native CLI telemetry/network ceases.

**Security-default is trusted executable runtime security interposition**, not
inert metadata and not a Pi-guarded action tool. The provider never disables or
seats it, changes managed plugin ordering, or overrides managed policy. Managed
instructions/policy remain preserved and trusted; non-managed instruction files
are excluded by invocation settings. If managed policy forces any additional
plugin or advertised skill, the bridge remains incompatible and rejects it.
Native startup hooks/model work may occur before host-side initialization
validation; this is not a comprehensive sandbox or a zero-usage guarantee.

## Verification and explicit opt-ins

Offline tests use real Pi sessions, real guard wiring and an external fake SDK
(and a metadata-only fake executable). They cover the approved native singleton
through actual guarded write/read and protected-read denial, plus malformed,
forged, duplicate and managed-forced additional inventories. Run the configured
`npm test` script with `PI_TEST_AGENT_PACKAGE` pointing to the installed Pi package,
and **unset all four flags below** for offline verification. `pretest` runs types,
lint, dependency boundaries, unused-code and formatting checks.

These live opt-ins are separate, require fresh explicit user authorization and
are **not** enabled by component-policy approval:

- `PI_CLAUDE_INIT_PROBE=1`: metadata-only initialization, no user prompt; cannot
  establish the complete loaded component inventory.
- `PI_CLAUDE_INIT_DIAGNOSTIC=1`: one harmless prompt, one request, no Pi actions;
  captures only bounded/escaped plugin identities and advertised skill names.
  Stops deliberately at either approved empty or approved singleton init; other
  inventories reject. It is an identity diagnostic, not bridge acceptance.
- `PI_CLAUDE_LIVE_SMOKE=1`: bounded guarded-write then protected-read acceptance;
  the protected read only runs if the write succeeds.
- `PI_CLAUDE_DIRECT_SDK=1`: separately authorized live direct-SDK diagnostic;
  sends a bounded prompt through the official SDK without Pi actions. This is
  diagnostic isolation, not bridge acceptance.

The exact security-default exception and optional-component suppression are
**offline-verified only**, not live-compatible/acceptance verified. Previous live
attempts rejected the broader component inventory. No subsequent runtime call is
implied or authorized by these changes. Claude.ai authentication-route checks
are not proof of Enterprise entitlement, administrator permission, quota or
billing treatment; no Enterprise billing claim is made.
