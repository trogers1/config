# pi-usage

Tracks pi assistant token usage and cost in a local SQLite database and provides `/usage` reports.

## Commands

```text
/usage                         # last 7 days
/usage today
/usage week | 7d | 7 days
/usage month | 30d | 1m | 1 month
/usage since YYYY-MM-DD
/usage provider <provider>
/usage model <model>
/usage import                  # backfill from ~/.pi/agent/sessions
/usage export [path.csv]
```

## Storage

Usage data is runtime state and is stored at:

```text
~/.local/state/pi/agent/pi-usage/usage.sqlite
```

If `XDG_STATE_HOME` is set, pi-usage uses:

```text
$XDG_STATE_HOME/pi/agent/pi-usage/usage.sqlite
```

SQLite may also create adjacent runtime files such as `usage.sqlite-wal` and `usage.sqlite-shm`.

Limit configuration is user config and is read from:

```text
~/.pi/agent/usage/limits.json
```

## Usage limits

`limits.json` is optional. If present, `/usage` prints a `Limits:` line showing current usage as a percentage of each configured provider limit.

Example:

```json
{
  "yellowAt": 0.5,
  "redAt": 0.8,
  "limits": [
    {
      "name": "OpenAI",
      "provider": "openai-codex",
      "period": "week",
      "tokens": 1400000
    },
    {
      "name": "Moonshot",
      "provider": "moonshot",
      "period": "week",
      "tokens": 1000000,
      "startDate": "2026-07-01"
    },
    {
      "name": "Anthropic Cost",
      "provider": "anthropic",
      "period": "month",
      "cost": 50
    }
  ]
}
```

Example output:

```text
Limits:
OpenAI: 89% (~1.2M/1.4M) | Moonshot: 15% (~30K/1M) | Anthropic Cost: 42% (~$21.00/$50.00)
```

### Top-level fields

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `limits` | array | `[]` | Provider limits to display. |
| `yellowAt` | number | `0.5` | Global warning threshold as a fraction of the limit. `0.5` means 50%. |
| `redAt` | number | `0.8` | Global critical threshold as a fraction of the limit. `0.8` means 80%. |

### Limit fields

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `provider` | string | yes | Provider value to match in the usage DB. Matching is case-insensitive but otherwise exact. Use `/usage` to see provider names currently recorded. |
| `name` | string | no | Display label. If omitted, `provider` is shown. |
| `period` | string | no | One of `day`, `week`, `month`, `7d`, or `30d`. Defaults to `week`. |
| `tokens` | number | if no `cost` | Token limit. Use raw numbers, e.g. `1400000`, not `"1.4M"`. |
| `cost` | number | if no `tokens` | Cost limit in dollars. Use raw numbers, e.g. `50`, not `"$50"`. |
| `startDate` | string | no | Optional anchor date as `YYYY-MM-DD`. Periods repeat from this date. |
| `yellowAt` | number | no | Per-limit warning threshold override. |
| `redAt` | number | no | Per-limit critical threshold override. |

Each limit should specify either `tokens` or `cost`. If both are specified, `tokens` wins.

### Period behavior

- `day`: current local calendar day, unless `startDate` is set.
- `week` / `7d`: rolling last 7 days by default.
- `month`: current local calendar month by default.
- `30d`: rolling last 30 days by default.
- With `startDate`, the period is anchored and repeats from that date. For example, a weekly limit with `startDate: "2026-07-01"` tracks 7-day windows starting on 2026-07-01, 2026-07-08, 2026-07-15, etc.

### Colors

Colors are applied with ANSI escape codes:

- below `yellowAt`: no color
- at or above `yellowAt`: yellow
- at or above `redAt`: red

Thresholds are fractions, not percentages:

```json
{
  "yellowAt": 0.5,
  "redAt": 0.8
}
```

means yellow at 50% and red at 80%.

### Installing a limits file

Copy the example and edit it:

```bash
mkdir -p ~/.pi/agent/usage
cp ~/.pi/agent/packages/pi-usage/limits.example.json ~/.pi/agent/usage/limits.json
$EDITOR ~/.pi/agent/usage/limits.json
```

Then reload pi and run:

```text
/usage
```
