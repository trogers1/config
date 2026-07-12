# pi-usage

Tracks pi assistant token usage and derived accounting meters in a local SQLite database.

## Commands

```text
/usage                         # last 7 days
/usage today
/usage week | 7d | 7 days
/usage month | 30d | 1m | 1 month
/usage since YYYY-MM-DD
/usage provider <provider>
/usage model <model>
/usage import                  # reconcile all session history
/usage export [path.csv]
```

`/usage import` is repeatable. It inserts missing events, updates derived charges when rates change, and leaves unchanged events alone.

## Storage

Mutable state follows XDG conventions:

```text
${XDG_STATE_HOME:-~/.local/state}/pi/agent/pi-usage/usage.sqlite
```

Configuration remains under the pi agent directory:

```text
~/.pi/agent/models.json        # standard model cost overrides
~/.pi/agent/usage/usage.json   # meters, rate cards, limits, display policy
```

The schema separates raw facts from derived accounting:

- `usage_events`: provider, model, time, token categories, and session metadata.
- `usage_charges`: generic per-event meter results such as `cost` or `openai-enterprise-credits`.

When an incompatible database schema is found, pi-usage checkpoints it, renames it to `usage.sqlite.backup-<timestamp>`, and creates a fresh database. Run `/usage import` to reconstruct history.

## Standard model cost

Monetary model rates belong in pi's supported `models.json` overrides. Values are USD per one million tokens:

```json
{
	"providers": {
		"zai": {
			"modelOverrides": {
				"glm-5.2": {
					"cost": {
						"input": 1.4,
						"output": 4.4,
						"cacheRead": 0.26,
						"cacheWrite": 0
					}
				}
			}
		}
	}
}
```

pi-usage resolves these rates through `ctx.modelRegistry`, so built-in pricing and user overrides share one source of truth.

## Usage configuration

`usage.json` contains extension policy. An example with cost, token, and custom credit limits:

```json
{
	"yellowAt": 0.5,
	"redAt": 0.8,
	"rateCards": {
		"openai-enterprise-credits": {
			"unit": "credits",
			"provider": "openai-codex",
			"models": {
				"gpt-5.6-terra": {
					"input": 62.5,
					"cacheRead": 6.25,
					"cacheWrite": 0,
					"output": 375
				}
			}
		}
	},
	"limits": [
		{
			"name": "Monthly ZAI Cost",
			"provider": "zai",
			"meter": "cost",
			"period": "month",
			"maximum": 5,
			"shouldAlwaysDisplay": true
		},
		{
			"name": "Enterprise Credits",
			"meter": "openai-enterprise-credits",
			"period": "month",
			"maximum": 10000
		},
		{
			"name": "Daily Codex Tokens",
			"provider": "openai-codex",
			"meter": "tokens",
			"period": "day",
			"maximum": 130000
		}
	]
}
```

### Rate cards

Each custom rate card defines:

- `unit`: display unit, such as `credits`.
- `provider`: optional case-insensitive provider filter.
- `models`: array of model-specific rates--rates per one million input, output, cached-read, and cache-write tokens.

`cost` and `tokens` are reserved meter names. `cost` comes from pi's model registry; `tokens` is aggregated directly from raw events.

### Limits

| Field                 | Required | Description                                                 |
| --------------------- | -------- | ----------------------------------------------------------- |
| `meter`               | yes      | `cost`, `tokens`, or a configured rate-card name.           |
| `maximum`             | yes      | Maximum amount in the meter's unit.                         |
| `name`                | no       | Footer/report label.                                        |
| `provider`            | no       | Case-insensitive provider filter.                           |
| `model`               | no       | Case-insensitive model filter.                              |
| `period`              | no       | `day`, `week`, `month`, `7d`, or `30d`; defaults to `week`. |
| `startDate`           | no       | Repeating period anchor in `YYYY-MM-DD` form.               |
| `yellowAt` / `redAt`  | no       | Per-limit threshold overrides.                              |
| `shouldAlwaysDisplay` | no       | Show below the warning threshold in the footer.             |

Configuration and runtime errors are rendered in red in the limits footer rather than silently hidden.

## Accounting behavior

- Token-to-meter calculations are pure and provider-independent.
- Current model-registry rates override stale costs stored in session JSONL.
- If a model cannot be resolved, a non-zero cost stored in the session is retained as a fallback.
- One usage event can produce multiple charge meters without adding provider-specific database columns.
- Re-importing after a rate change deterministically recalculates existing charges.
- Local amounts are estimates; provider billing dashboards remain authoritative.

## Testing

```bash
npm test
```

Behavioral tests cover per-million arithmetic, request-wide pricing tiers, simultaneous cost/credit meters, import reconciliation, and idempotency.
