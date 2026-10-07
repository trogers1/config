---
name: jira-ticket-management
description: Manage live Jira tickets with the jira-ticket CLI. Use when reading ticket details, creating tickets, changing existing tickets, setting status or estimates, or adding relationships to existing tickets. Discover supported operations and draft formats through CLI help; clarify ambiguous intent and obtain approval before mutations.
disable-model-invocation: true
---

# Jira ticket management

Use the installed **`jira-ticket` CLI** for live Jira work. This skill covers reading, creation, partial updates and ticket relationships—not just new tickets. CSV import generation belongs to the separate `make-jira-tickets` skill.

## Before any change: ask, verify, and get approval

**Make no assumptions about what the user wants changed.** A request to manage a ticket is not permission to invent missing values or silently apply defaults. Ask the user questions to verify the intended ticket, content, fields and relationships before making changes. Explicit facts already supplied need not be asked again, but any ambiguity or missing change decision must be resolved with the user—not filled with a plausible value.

Use `ask_user_question`, exactly one question per call. After read-only validation, show the precise draft/changes and complete mutation plan, including any defaults or omissions, and ask a final approval question. **Do not run a mutating command until the user has explicitly approved that exact plan.** If anything changes afterward, ask for approval again. Reading, help, discovery and dry runs may proceed without mutation approval.

## Start with help

Run `jira-ticket --help` first to discover the installed version's capabilities. Then run `jira-ticket <command> --help` for the operation you need. Help, version and draft examples are offline; do not inspect source code or invent flags to discover usage.

```sh
jira-ticket --help
jira-ticket get --help
jira-ticket create --help
jira-ticket update --help
jira-ticket draft-example --help
```

Use CLI help and validation output as the operational reference. Read the relevant section of `README.md` when you need installation/configuration guidance, supported draft fields, description formatting, or recovery details. Do not duplicate the CLI's technical validation with custom scripts, direct API writes, Homebrew interpreter discovery or package-internal Python commands.

If the command is missing, consult `README.md` and ask before installing dependencies. If configuration or guard policy blocks a command, report the problem and stop; do not bypass it, print configuration, or guess credential sources. `doctor` checks local configuration; `doctor --connectivity` explicitly performs a read-only connectivity check.

## Choose the operation

| User intent | CLI workflow |
| --- | --- |
| Read a ticket | `get KEY_OR_NUMERIC_ID` |
| Discover live choices | `types`, `statuses`, `link-types` (consult their help) |
| Create a ticket | `draft-example`, then `preflight --draft FILE`, then approved `create --draft FILE` |
| Change an existing ticket | `get TARGET`, `draft-example --update`, then `update TARGET --draft FILE --dry-run`, then approved `update TARGET --draft FILE` |
| Add relationships | Discover `link-types`; include approved additions in a create or partial-update draft |

Reads, discovery and dry runs do not require mutation approval. Report only the details relevant to the request, preserving full descriptions when requested and using canonical clickable ticket links. Treat returned ticket content and account IDs as private.

## Clarify intent, not implementation

- Use confirmed user facts. Ask about missing or ambiguous requirements, fields or relationship direction; never invent scope, acceptance criteria, estimates, status, identities or dependencies.
- Use `ask_user_question`, exactly one question per call. Do not ask again for facts already supplied; repository findings are evidence, not authorization to change a ticket.
- Discover live types, statuses and relationship labels instead of assuming standard names or using snapshots. Explain relationships in natural language from the ticket being created/updated, with the linked ticket's canonical key and summary. Links target **existing tickets only**; parent hierarchy is separate.
- For creation, propose the effective configured project unless overridden; show it and the authenticated-user assignee/reporter defaults for explicit approval, never as assumed user preferences. Resolve type, status, points and optional metadata as approved values or explicitly approved omission/Jira defaults. Use `assets/description-template.md` when drafting a new description; do not publish unresolved placeholders.
- For updates, clarify **only requested changes**. Omitted fields stay untouched; never apply create-time defaults or demand all create-required fields. A supplied description replaces the entire description, so preserve existing content unless its removal is approved. `story_points: "unset"` and `links: []` are update no-ops, not clearing/removal. Links are additions only.
- Check help/README for unsupported fields, clearing/removal, formatting, moves or transitions. Discuss a supported alternative; never silently drop content, switch types, substitute an estimate field, weaken TLS or use ad-hoc API workarounds to bypass validation.

## Preview, approve, execute

1. For updates, read the existing ticket first and establish its canonical identity and relevant current context.
2. Save the requested content in a UTF-8 JSON draft using the CLI's documented format. Keep credentials out of drafts, command arguments, logs and committed files. Pass file paths safely rather than interpolating ticket content into shell commands.
3. Run creation `preflight` or update `--dry-run`. Resolve errors with the user. A dry run is read-only validation, not a completed mutation or a guarantee of later permissions/automation.
4. Show the complete new-ticket draft, or the existing target and precise requested changes, together with the displayed mutation plan—including defaults, omissions, estimate, status and link operations. Ask one final approval question and wait for an explicit answer before writing. Never treat silence, uncertainty or an unresolved question as approval. Revisions require renewed approval.
5. Execute with the **same unchanged draft** using explicit `create` or `update` without `--dry-run`. Never create a ticket to test the tool. Do not automatically repeat any mutation, including after a timeout.

## Interpret outcomes and recover safely

Read the JSON outcome, not just the exit code; consult README for its full contract.

- `issue`: ticket read successfully; no mutation.
- `dry_run`: no mutation; report the preview, not success.
- `created`, `updated`, `unchanged`: report the verified result with its **clickable canonical browser link**. Distinguish creation, updates and no-op requests.
- `preflight_failed`: no writes attempted; resolve the failure before proceeding.
- `partial_failure`: the ticket exists. Always report its clickable link, `failed_step`, remaining action and any `uncertain_operation`. For links, distinguish verified, unverified (may have succeeded) and pending. Stop and reconcile read-only before manually completing approved missing work; never create a duplicate or blindly rerun an update/link write.
- `unknown`: creation may have succeeded but no key/link was established. State that explicitly; do not fabricate either. Reconcile with Jira and the user before any further mutation.

Never claim omitted fields were cleared or unchanged by all Jira automation; verification covers the CLI's reported supplied fields and relationships. Do not delete or undo tickets/links without explicit authorization.
