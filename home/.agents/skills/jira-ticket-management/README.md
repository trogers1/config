# jira-ticket

The `jira-ticket-management` skill uses this CLI to read, create and partially update live Jira tickets. Start with `jira-ticket --help` and the relevant subcommand's `--help`; this README is the detailed reference for installation, configuration, draft fields and recovery. In Pi, reload resources after renaming the skill and invoke it explicitly with `/skill:jira-ticket-management` if needed.

Portable, approval-driven Jira Cloud CLI. The package owns its Python dependencies, including pinned `jiratui==1.16.0`; it does not borrow another application's interpreter. It uses jiratui's public `ApplicationConfiguration` and preserves effective config discovery and YAML/environment precedence.

## Install and discover

Install uv yourself if it is not available. No global Python dependency installation or interpreter selection is needed:

```sh
uv tool install /absolute/path/to/skill
uv tool update-shell
```

From this repository's root, the equivalent install is:

```sh
uv tool install ./home/.agents/skills/jira-ticket-management
```

The package supports Python 3.12–3.14, matching the pinned jiratui release. uv selects or provisions a compatible interpreter; Homebrew is not required on other machines. Installation downloads dependencies once; normal CLI invocation does not reinstall them.

After changing the package source, refresh the installed copy explicitly:

```sh
uv tool install --force /absolute/path/to/skill
```

`setup.sh` links the skill and warns when this CLI is missing, but does not install it or uv automatically. Install the CLI once per machine.

Restart the shell if instructed by `uv tool update-shell`. Agents should discover the installed command through help, not inspect package internals:

```sh
jira-ticket                  # top-level help; offline
jira-ticket --help
jira-ticket --version        # offline
jira-ticket create --help
jira-ticket get --help
jira-ticket update --help
jira-ticket draft-example --update  # offline partial-update example
jira-ticket draft-example    # offline JSON format example, NOT an approved ticket
jira-ticket doctor           # local config/TLS/auth checks; no requests
```

If the command is missing, install it and follow uv's shell instructions. If configuration is missing, configure jiratui locally and run `doctor`; do not print configuration or tokens. Doctor failures are safely redacted. `doctor --connectivity` explicitly permits one read-only authenticated `GET /myself`; it is never a mutation. No command contacts Jira for help, version or draft-example.

### Agent guard policy

Installation does not change Pi guard profiles. Profiles must permit executing the installed `jira-ticket` command and reading the saved draft; sandboxed live operations also need network access and process access to the configured jiratui settings. Treat help, version, example, doctor, types, statuses, link-types, get, preflight and update --dry-run as read-only operations. Keep mutation approval for `create` and `update` rather than broadly authorizing Python or arbitrary inline API scripts. A guard denial is a policy issue, not a reason to choose another interpreter or bypass the CLI.

## Configuration and safety

`--config PATH` selects `JIRA_TUI_CONFIG_FILE` temporarily inside the process. Otherwise public jiratui configuration uses `JIRA_TUI_CONFIG_FILE`, then its XDG/HOME discovery (`$XDG_CONFIG_HOME/jiratui/config.yaml`, normally `$HOME/.config/jiratui/config.yaml`). In the pinned version YAML precedes environment: do not assume environment overrides win. Project defaults to effective `default_project_key_or_id` (this user's configured default is RI, not a hardcoded CLI default).

Only Jira Cloud Basic auth and verified HTTPS are supported. Configured CA bundles are respected; disabled TLS verification, client certificates, credential-bearing URLs and bearer auth are rejected. Credentials are read only inside the process, **never accepted in CLI arguments or draft JSON**. Error responses, exceptions and authentication settings are not echoed. Preflight output contains approved content and account IDs; treat it as private.

**Only explicit `create` or `update` without `--dry-run` authorizes writes.** GET, preflight, discovery, dry-runs and doctor are read-only. Review and approve the complete final draft first. There are no automatic retries of any mutation (including issue/estimate PUTs and create/transition/link POSTs), no deletion/cleanup and no test-ticket mode. Never create a ticket to test the workflow.

## Read and partially update an existing ticket (0.3.0)

```sh
jira-ticket get RI-123                 # read-only, no mutation approval needed
jira-ticket get 123456                 # numeric issue ID; returns canonical key/link
jira-ticket draft-example --update     # offline partial format discovery
jira-ticket update --help              # offline
jira-ticket update RI-123 --draft changes.json --dry-run
# Only after approval of current target context and the complete change plan:
jira-ticket update RI-123 --draft changes.json
```

`get` returns `outcome: issue`, `read_only: true`, immutable `id`, canonical `key`, HTTPS browser `link`, and `details`: summary, full ADF description, project, type, status, assignee, reporter, parent, exact story points, and oriented existing links. Identity details contain account IDs/display names, not authentication or raw configuration. Unassigned/no-parent/no-estimate may be null on **read**; null is never an update instruction. Description is read in full even if its existing ADF uses nodes outside the writable subset. GET never requests approval; its output is private ticket content. Invalid keys/IDs fail locally before configuration discovery.

A partial draft uses the **same allowed keys as create**, but none is required individually. Supply at least one key. Omit everything not approved to change. There are **no create-time defaults**: no configured project, `/myself`, assignee/reporter replacement, status reset, estimate reset or implicit parent removal. Unknown/duplicate keys, nulls, booleans, empty content, numeric strings for points, unsupported ADF and malformed links fail before configuration/network access. `story_points: "unset"` and `links: []` are valid no-ops, never clearing/removal; an empty object is invalid. An already-equal request can produce `unchanged` with no writes.

Example (only if all listed changes are explicitly approved):

```json
{
  "summary": "Approved replacement summary",
  "description": "Complete approved replacement description.\n\nAcceptance criteria:\n- Approved criterion.",
  "story_points": 2,
  "status": "VERIFIED_STATUS_ID_OR_NAME",
  "links": [{"type": "VERIFIED_LINK_TYPE_ID_OR_NAME", "direction": "outward", "issue": "EXISTING-123"}]
}
```

### Supported field table

| Draft key | Create | Partial update / limitations |
| --- | --- | --- |
| `summary` | Required nonempty string, max 255 | Complete replacement only when supplied |
| `description` | Required literal text or supported ADF | Complete replacement only when supplied; not append/patch/file reference |
| `project` | Optional effective configured project override | Omitted retains current project; supplied live project must be writable with `set` on editmeta. No move API fallback |
| `type` | Required live unique ID/name | Omitted retains current type; supplied type must belong to resulting project and be writable on editmeta. No type substitution |
| `status` | Required live unique ID/name; post-create direct transition | Only if supplied; exact resulting project/type status plus unique existing-issue direct transition preflight. No intermediate transitions or guessed required values |
| `assignee` | Omitted defaults to authenticated user | Omitted unchanged; explicit `id:ACCOUNT_ID` or unique exact active name/email. Changed assignee must be assignable in resulting project |
| `reporter` | Omitted defaults to authenticated user | Omitted unchanged; explicit active unique identity, edit writability/allowed values. No `/myself` default |
| `parent` | Optional immediate same-project hierarchy parent; required for subtask | Supplied immediate hierarchy and resulting-project check. Existing parent revalidated on actual project/type change; no implicit removal. Subtasks need a verified parent |
| `story_points` | Required number or `"unset"` | Optional finite nonnegative JSON number; `"unset"` no-op. Exact numeric `customfield_10004` catalog validation; inline edit if writable, otherwise only verified Agile estimator |
| `board` | Optional numeric string for Agile numeric estimate | Context only; requires requested numeric points, only when Agile fallback needed. Not itself a ticket field |
| `links` | Optional array of existing-target additions | Additions only, same exact type/direction/issue schema; direction from **current target ticket** perspective. `[]` no-op; no link deletion/replacement |

All requested inline edits require matching schemas, an advertised `set` operation and any allowed values on **GET issue/ID/editmeta**. This endpoint returns an **unpaginated fields object**, not create-field pages. Additional required edit fields are not filled or defaulted: existing nonempty values are respected; absent required values fail closed. Unsupported moves, fields, clearing, deletion, labels, priority and dates need a separately approved Jira UI/supported extension workflow; never invent ad-hoc API calls.

The dry-run displays the complete `current` target context, canonical ID/key/link, `requested_fields`, changed-only `payload.fields`, optional `estimate`, `requested_status`, direct `transition`, and `links` with natural relationship labels and verified/pending progress. Review the complete target context and approved **changes/plan**, not a synthetic create draft. Updating repeats all read-only preparation from live state/metadata; a prior dry-run is not a cached authorization or frozen snapshot.

Numeric estimates retain the exact Story Points Estimates field/catalog/board validation described below. Inline points require edit-screen writability. Otherwise, preparation verifies the exact project board estimator **and existing issue Agile estimation field/membership/readback**, before any write. Existing Agile and issue values must agree. No generic edit bypass or alternate estimate field. Inline edit, optional Agile estimate, optional direct transition, then links execute sequentially. Supplied transition availability/ambiguity/required-field checks happen **before even the inline PUT** and are checked again before transition execution if preceding writes changed state. Supplied project/type edits cannot silently discard an existing parent or reset an omitted status; current parent consistency and omitted status membership in the resulting type are checked first.

Updates use the immutable issue **ID** for issue/editmeta/estimate/transition/readback requests and link POST endpoints, even if editing the project changes the key. Canonical readbacks refresh the key/browser URL and relationship labels. Links reuse verified metadata, dedup automation-supplied exact relationships, reject self-links anywhere in the plan **before all writes**, and verify exact type/direction/target ID and key after each addition. Targets' canonical keys are refreshed by ID before writing.

`updated` means performed writes and verified **only supplied fields**, estimate/status and requested links. `unchanged` means no writes needed; omission/`unset` is not claimed empty. Both retain ID/key/link and `verified_fields`. Update never POSTs an issue, never reports `created`, and never retries a PUT/POST.

Any execution failure stops later writes and returns `partial_failure` for the **established existing issue**, with ID/key/link, `failed_step`, precise `remaining_action`, and each link's `verified` / `unverified` / `pending` progress. `uncertain_operation` identifies an attempted mutation not yet verified (including timeout/HTTP error); it may have succeeded. A best-effort read-only canonical refresh can follow failure but never resumes writes. If that refresh fails, the last verified key/link remain; no unknown-key/create outcome. Report the clickable link, reconcile the uncertain operation first, then manually finish only missing approved changes. Do not blindly rerun update or repeat any uncertain mutation. Live workflows are not atomic: metadata/automation may change after preparation; verified readbacks detect mismatches but cannot prevent every concurrent change.

## Creation workflow

Enumerate live metadata (never substitute a snapshot):

```sh
jira-ticket types
jira-ticket statuses --type VERIFIED_TYPE_ID_OR_NAME
jira-ticket link-types       # GET /rest/api/3/issueLinkType; IDs/names/inward/outward labels
```

`link-types --help` is discoverable offline; running `link-types` reads live metadata. It accepts `--config PATH`, needs no selected project and validates the entire non-paginated catalog fail-closed. Types/statuses accept `--project KEY_OR_ID` and `--config PATH`. Names or IDs must resolve uniquely. Metadata discovery is read-only and fully paginated where the API paginates.

Save the **entire approved draft** in a UTF-8 JSON file. `assets/example-draft.json` and `jira-ticket draft-example` are non-sensitive format examples, not authorized tickets. Example shape:

```json
{
  "summary": "Complete approved summary",
  "description": "Complete approved description.\n\nAcceptance criteria:\n- Approved criterion.",
  "type": "VERIFIED_TYPE_ID_OR_NAME",
  "status": "VERIFIED_STATUS_ID_OR_NAME",
  "story_points": "unset",
  "links": []
}
```

Required keys: `summary`, `description`, `type`, `status`, `story_points`. Optional keys: `project`, `assignee`, `reporter`, `parent`, `board`, `links`. Except for the optional `links` array, all selectors and summary must be nonempty JSON strings; omit unused optional keys instead of supplying null. Unknown keys, duplicate JSON keys, credentials, prepared payloads and unsupported extra Jira fields are rejected. There is no prepared-payload acceptance bypass. Draft paths use normal `pathlib.Path` semantics, including relative paths, platform-native paths and spaces; quote paths in a shell. Config paths additionally support user-home expansion.

- `story_points`: explicit finite nonnegative **JSON number**, e.g. `0`, `2`, `3.5`, or exactly `"unset"`. Booleans, null and numeric strings are rejected. `unset` means approved omission/Jira defaults, not clearing a default. Never replace a requested estimate with unset to bypass errors.
- `description`: complete literal string or supported ADF object (below), not a path or reference to a separate file.
- `project`: override the effective default in the saved draft, so preflight and create use identical content.
- `assignee`/`reporter`: omit for authenticated `/myself` defaults, not configured account ID or git identity. Overrides accept `id:ACCOUNT_ID` or an exact uniquely resolved active display name/email. Assignee must be assignable; reporter must be writable and meet allowed values.
- `parent`: existing same-project parent key/ID, with verified hierarchy immediately above the chosen type. Required for sub-tasks. Parent hierarchy is separate from issue links; never substitute one for the other.
- `links`: optional array, including `[]`. Each entry must have **exactly** `type`, `direction`, `issue`, all nonempty strings. Type is a verified link type ID or unique name from `link-types`; direction is exactly `inward` or `outward` **from the NEW ticket's perspective**. Issue is an **existing** Jira key or numeric ID; cross-project targets are allowed. Synthetic references, other drafts, batch aliases and future tickets are not supported. Unknown keys, directions and types fail; nothing is guessed.
- `board`: numeric ID **string**, only for a numeric estimate requiring Agile fallback. Must appear in fully paginated project boards and use the exact estimator. Without an override exactly one eligible board is required.

Preflight the saved draft, then after user approval create from the **same unchanged file**:

```sh
jira-ticket preflight --draft /path/to/approved-draft.json
# After complete draft and displayed plan approval only:
jira-ticket create --draft /path/to/approved-draft.json
```

Read-only aliases: `jira-ticket dry-run --draft FILE`, `jira-ticket --dry-run --draft FILE`, and `jira-ticket create --draft FILE --dry-run`. None can mutate. Prefer `preflight` for agents. Preflight does not freeze live Jira metadata; create repeats preparation and fails closed if circumstances have changed.

Local input errors return `preflight_failed` with an `errors` array: stable `code`, safe `message`, documented `fields`, and remediation. Missing fields are listed. Unsupported keys return an allowed-key list and count; arbitrary key names/values are redacted because they may contain secrets. Invalid types are identified without echoing values. Correct the saved file and rerun preflight. Configuration/remote failures remain safely redacted; inspect locally without sharing raw errors.

### Existing-ticket relationships and approval

Discover live link types before choosing relationships. For example, **only if verified** `Blocks` has outward `blocks` and inward `is blocked by`, an approved optional entry could be:

```json
"links": [{"type": "VERIFIED_LINK_TYPE_ID_OR_UNIQUE_NAME", "direction": "outward", "issue": "EXISTING-123"}]
```

Replace example values with verified metadata and a real existing target. Ask for approval using the natural label, e.g. **“NEW ticket blocks EXISTING-123 — existing target summary”**, rather than asking the user to reason about endpoint orientation. Inward would mean **“NEW ticket is blocked by EXISTING-123”** for that verified type. Do not infer directions from a generic type name or invent dependency decisions.

Preflight reads the type catalog and each target (`GET issue/KEY_OR_ID?fields=summary,project`) and displays `post_create_links` separately from the create payload. Each plan entry includes verified `type` (ID/name/labels), `direction`, canonical `issue` ID/key/summary, and a readable `relationship` from the NEW ticket perspective. Duplicate canonical `(type ID, direction, issue ID)` entries fail, including name vs ID selectors and aliases resolving to the same target. Missing/inaccessible targets, malformed metadata or read failures prevent **all mutations**. This is best-effort safety, not a guarantee of later link permission or stable automation behavior.

After estimate, status and requested-field verification, links are applied sequentially. Before each link POST the CLI reads the created issue's `issuelinks` to skip an exact relationship already supplied by automation. Missing/malformed `issuelinks` is a failure, **not an empty list**. Self-links against the created key/ID are rejected. An outward request POSTs `inwardIssue=new` and `outwardIssue=target`; an inward request reverses those endpoints, always using the verified type ID and canonical target key. On created-issue GET, an `outwardIssue` entry means the new ticket has the outward relationship to the target; an `inwardIssue` entry means it has the inward relationship. Every write is followed by exact type ID, direction, target ID **and** key readback verification. No extra create-screen field or unverified edit route is invented.

The first failure stops link processing: no retries, no subsequent link writes, no second create. Results with requested links have a `links` progress array initialized as soon as the created key is established, even when an earlier estimate/status/field step fails:

- `verified`: exact relationship read back, either already present or after one POST.
- `unverified`: link write was attempted but its result is uncertain (including HTTP error, timeout or mismatched/failed readback); it may have succeeded. Reconcile in Jira before considering another write.
- `pending`: no write for this link was attempted. Later entries stay untouched after failure.

Partial results retain the key/browser link, `failed_step` (`link_precheck`, `link_update`, `link_verification`, or an earlier step), and `remaining_action` listing readable relationships and progress. Open the existing ticket, reconcile unverified relationships first, and manually complete pending approved work only after review. Never rerun `create` as recovery or blindly repeat a link POST. An unknown create outcome has no established key and attempts no links. Drafts without links (or with `[]`) keep their previous outcome shape.

### Description formats

Literal strings preserve content and Markdown punctuation visibly; they **do not render Markdown**. CRLF/CR normalize to LF, then each line becomes an ADF paragraph, including blank lines. Nothing is trimmed or silently discarded.

For rendered headings/lists, use a JSON ADF object (`type: doc`, integer `version: 1`). Supported subset: paragraphs, headings (levels 1–6), bullet/ordered lists, list items, blockquotes, code blocks, text and hard breaks. Text marks: strong, em, code, strike. Attributes: heading `level`, ordered list `order`, code block `language`. Unsupported nodes, marks, attributes or nesting fail, never disappear. No links/tables/media in this subset; discuss a supported workflow rather than discarding requested content. ADF content is preserved verbatim; server-normalized readback differences conservatively fail verification.

### Preflight and estimate safety

Preparation reads project/type/status metadata, **all pages** of create fields, `/myself`, identity/assignability metadata and requested parent/field metadata. It validates required fields/defaults, schemas, set operations and allowed values. Issue type is the verified creation selector, so an empty `operations` list for `issuetype` is valid; writable checks still apply to other fields. Additional unsupported required fields fail without inventing values.

Story points use the **exact** numeric `Story Points Estimates`, verified as `customfield_10004`. Never substitute `Story point estimate` (`customfield_14308`) or similarly named fields. If writable on the paginated create screen, points are inline. Otherwise preparation fully paginates project Agile boards and verifies configuration estimator ID/name, requiring one eligible board or an explicitly verified board override. Preflight displays `post_create_estimate` separately from the payload. A populated estimate on an existing issue does not prove create/edit writability; no generic edit API bypass is supported.

After creation, **before transitioning**, the helper reads Agile issue estimation on the verified board and checks the exact field, PUTs a string-valued estimate (e.g. `{"value":"2"}`), then verifies Agile and issue field readback. Post-create availability/permissions/write/readback failures retain the existing key/link for manual recovery; writes are never retried.

Status belongs to the selected project's type, but typically cannot be set in the create payload. After one create POST, the helper reads status, skips transitioning if already at target, otherwise requires exactly one direct transition with no unsupplied required fields. No guessed intermediate transitions. Preflight cannot guarantee post-create board membership or a unique transition; such failures are partial success, not permission to create a duplicate.

## Outcomes and reporting

All operational results are JSON. Exit 0 means `doctor_ok`, `types`, `statuses`, `link_types`, `issue`, `dry_run`, `created`, `updated` or `unchanged`; failures exit 1. Help/version/example exit 0; argparse usage errors exit 2.

- `doctor_ok`: local configuration passed; `connectivity` is `not_checked` or explicitly `verified`. No settings or account ID printed.
- `doctor_failed`: safe diagnostic only; no mutations.
- `types` / `statuses`: live IDs/names and selected project/type.
- `link_types`: live verified `link_types` array with ID/name/inward/outward labels; read-only.
- `dry_run`: no writes; `payload`, `requested_status` and any `post_create_estimate` / `post_create_links` plans.
- `issue`: read-only existing-ticket details with canonical ID/key/link.
- `updated` / `unchanged`: existing-ticket supplied changes verified, with writes / without writes.
- `preflight_failed`: no mutation attempted. Resolve with the user.
- `created`: requested fields/status verified; key and full HTTPS browser `link`.
- `partial_failure`: issue exists; key, full link, `failed_step`, safe message and `remaining_action`. Always report its clickable link and exact manual recovery. Do not create again or repeat uncertain writes.
- `unknown`: create outcome has no established key/link; explicitly state neither is available. Reconcile with Jira/user before any further mutation; never fabricate a link or retry POST.

Render known URLs as clickable Markdown, e.g. `[RI-123](https://your-site.atlassian.net/browse/RI-123)`, for success **and every partial failure**. Verification covers project, type, summary, full description, assignee, reporter, supplied parent/estimate, final status and all requested issue relationships. Omitted defaults are not claimed empty.

## Development tests (no real Jira or credentials)

From this directory, use an isolated development environment, not global pip:

```sh
uv run --locked python -m unittest discover -s tests -v
uv build
```

The unittest suite uses `httpx.MockTransport` and fake effective config; no actual config or Jira is read. It covers the retained creation workflow, exact estimator and pagination safety, identities, required fields/parents, transition/verification/unknown outcomes, public CLI validation, help/version/example discovery, doctor redaction, read-only aliases and no mutation retries. Link tests cover catalog/schema validation, existing cross-project targets, canonical duplicates, both Jira orientations, sequential and automation-supplied relationships, fail-closed readback, uncertain writes and per-link partial recovery. Existing-ticket tests additionally cover public get/update key/ID/canonical context, offline discovery, partial local validation before config, omitted/default preservation, no-op unset, literal/ADF replacement, explicit identities, exact inline/Agile estimates, editmeta object shape, required existing fields, parent/project/type edit restrictions, transition preflight before mutation, canonical IDs across key moves, read-only full plans, link additions/dedup/self-link safety, supplied-only verification, timeout/HTTP partial outcomes with progress and no retries/later writes, revalidation and no issue POST. Never use live tickets to verify packaging.
