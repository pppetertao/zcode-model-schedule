[简体中文](README.md) | English

# zcode-model-schedule

Time-based model switching for [ZCode](https://zcode.ai): keep your coding-plan model at night and on weekends, and restore your everyday setup automatically during work hours.

> **Disclaimer:** This is a personal, community tool. It is **not** an official ZCode project and is not affiliated with or endorsed by ZCode.

## Features

- **Scheduled switching** — a `dayWindows` schedule decides when to switch (outside the window) and when to restore (inside the window).
- **Availability gate** — before switching to the target model, it can check your plan's billing endpoint and skip the switch when the plan is unavailable or expired.
- **Snapshot restore** — your pre-switch model settings are captured once and restored byte-for-byte when the day window opens.
- **Hot reload** — ZCode watches its own config files, so changes made by this tool take effect within ~1–2 seconds, no restart needed.
- **Dual trigger** — a launchd agent fires at window boundaries (plus a 5-minute safety-net interval), and a ZCode `SessionStart` hook runs the tool on every session start.
- **Idempotent and lock-protected** — repeated runs do nothing unless the mode actually changed; an exclusive lock with stale-lock detection prevents concurrent runs from corrupting state.

## Requirements

- **macOS** (scheduling uses launchd; the hook and `apply.mjs` also work without launchd)
- **Node.js >= 18**
- **ZCode** installed with at least one provider configured in `~/.zcode/v2/config.json`
- For custom agents: agent definition files (e.g. `~/.zcode/agents/implementer.md`) with a YAML frontmatter containing `model:` and optionally `thoughtLevel:` lines

## How it works

ZCode watches its own configuration files (`~/.zcode/v2/agents-state.json` and your custom agent `.md` files) and hot-reloads them within ~1–2 seconds of a change.

`apply.mjs` evaluates the schedule on every run:

1. **Outside the day window** (nights, weekends): if not already switched, it snapshots the current model settings, then points every configured agent at the **target** model — builtin agents via `builtInModelSelectionOverrides` in `~/.zcode/v2/agents-state.json`, custom agents by rewriting the `model:` / `thoughtLevel:` lines in their frontmatter.
2. **Inside the day window** (your working hours): if a switch is active, it restores the snapshotted values exactly and clears the snapshot.
3. If the desired mode is already active, it does nothing (idempotent). If availability checking is enabled and the plan is not usable, switching to target is skipped with a reason.

Triggers:

- **launchd** (`node install.mjs`): one calendar entry per window boundary (from/to of every `dayWindow`), plus `StartInterval=300` so a missed trigger (e.g. laptop asleep at the boundary) is caught within 5 minutes. Each run invokes `apply.mjs --if-due`.
- **ZCode SessionStart hook** (`node install.mjs --register-hook`): runs `apply.mjs --if-due` when a session starts, so a machine that was off all night switches as soon as you start working.

All state lives next to the scripts (the directory you cloned this repo into), so the tool can be installed anywhere.

## Quick start

```bash
git clone https://github.com/pppetertao/zcode-model-schedule.git
cd zcode-model-schedule

# 1. Create your config from the example
cp schedule.example.json schedule.json

# 2. Edit schedule.json: set target (provider/model/reasoning level) and the agents to manage
#    (see Configuration below)

# 3. Preview what would change (writes no files except the logs/runs.jsonl run record)
node apply.mjs --dry-run

# 4. Check current state and availability
node apply.mjs --status

# 5. Register the SessionStart hook so every new ZCode session applies the schedule
node install.mjs --register-hook

# 6. (optional) Install the launchd agent for time-of-day switching without relying on session starts
node install.mjs
```

`node apply.mjs` performs a switch immediately; validation errors are printed as `[invalid] <scope>: <reason>` with exit code 1.

## Configuration

The config file is `schedule.json` in the project root (see `schedule.example.json`). `$schema` must be `"zcode-model-schedule/v2"`.

| Field | Type | Description |
|---|---|---|
| `timezone` | string | IANA timezone used to evaluate the schedule, e.g. `"Asia/Shanghai"`. |
| `target.providerId` | string | Provider ID to switch to, e.g. `"account:your-plan-provider"`. Must exist in `~/.zcode/v2/config.json`. |
| `target.modelId` | string | Model ID to switch to. Must be offered by that provider (or exist globally for `account:*` aliases). |
| `target.reasoningLevel` | string | One of `low`, `medium`, `high`, `xhigh`, `max`; must be supported by the target model. |
| `agents` | array | Agents to manage. Each entry: `{ "name": "...", "kind": "builtin" \| "custom", "path": "..." }`. |
| `agents[].kind` | string | `builtin` — a ZCode builtin agent (switched via `agents-state.json`). `custom` — your own agent `.md` file (frontmatter lines rewritten). |
| `agents[].path` | string | Custom agents only. Path to the `.md` file; `~` is expanded. Defaults to `~/.zcode/agents/<name>.md`. |
| `dayWindows` | array | Windows during which your **original** setup is active. Outside any window the **target** model applies. |
| `dayWindows[].days` | number[] | Weekdays as integers, `1=Mon` … `7=Sun`. |
| `dayWindows[].from` / `.to` | string | `HH:MM` boundaries; `to` must be later than `from` (overnight windows are not supported; `to` itself is exclusive). |
| `availability.enabled` | boolean | Master switch for the plan check. Set `false` to skip it entirely (treated as always available). |
| `availability.endpoint` | string | Billing/plan URL to GET when enabled. |
| `availability.provider` | string | Provider ID in `~/.zcode/v2/config.json` whose `options.apiKey` is used for the request. |
| `availability.model` | string | Capability name that must appear in the active plan's entitlements for the switch to proceed. |
| `availability.timeout` | number | Request timeout in milliseconds (positive integer). |

The agent `name` for `kind: "custom"` entries is also used in state snapshots and log lines; for `kind: "builtin"` it must match the builtin agent ID as it appears in `~/.zcode/v2/agents-state.json` (e.g. `Explore`).

## CLI reference

### `apply.mjs`

```
node apply.mjs [--config <path>] [--status] [--dry-run] [--force] [--if-due] [--logs [-n <N>]] [--trigger <name>]
```

| Flag | Behavior |
|---|---|
| `--config <path>` | Path to the schedule file. Default: `schedule.json` in the script's own directory. `~` is expanded. |
| `--status` | Print timezone, current mode, desired mode, availability, and the active snapshot. Writes no files other than the `logs/runs.jsonl` run record. |
| `--dry-run` | Print a JSON report `{ desiredMode, available, changes }` of what would change. Writes no files other than the `logs/runs.jsonl` run record. |
| `--force` | Re-apply the target values even when nothing differs (target mode only; no-op otherwise). |
| `--if-due` | Act only when the recorded mode differs from the desired mode. Used by launchd and the hook; prints `no mode change` otherwise. |
| `--logs [-n <N>]` | Inspect run logs: print the latest N entries (default 10), newest first, as one-line summaries from `logs/runs.jsonl` (including the `.1` rotated file). The query itself does not append to the run log. |
| `--trigger <name>` | Trigger annotation, stored in the run record's `trigger` field. launchd installs pass `launchd`, the SessionStart hook passes `hook`; default `manual`. |

Exit codes:

| Code | Meaning |
|---|---|
| `0` | Success — applied, no change needed, skipped (unavailable), skipped (`--if-due`), or dry run. |
| `1` | Validation, argument, or runtime error (details on stderr, prefixed `[invalid]` or `[error]`). |
| `2` | Lock busy — another `apply.mjs` run holds `.apply.lock`. |

### `install.mjs`

```
node install.mjs [--config <path>] [--dry-run] [--uninstall] [--register-hook]
```

| Flag | Behavior |
|---|---|
| (no flags) | Full install: write `~/Library/LaunchAgents/com.zcode.model-schedule.plist`, record the current Node binary in `node-path`, and bootstrap the agent with `launchctl`. |
| `--config <path>` | Schedule file used to generate the plist. Default: `schedule.json` in the script's own directory. |
| `--dry-run` | Print the generated plist XML to stdout without writing or bootstrapping anything. |
| `--uninstall` | Bootout the launchd agent and delete the plist (skipped gracefully if absent). |
| `--register-hook` | Idempotently add the `SessionStart` hook entry to `~/.zcode/cli/config.json` (a timestamped backup is written before the first change). |

The plist, `node-path`, and launchd logs are all resolved relative to the script's own directory, so the project can live anywhere in your home directory.

## Availability check

When `availability.enabled` is `true`, `apply.mjs` gates the switch to target on a plan check:

1. Read the API key for `availability.provider` from `~/.zcode/v2/config.json` (`provider.<id>.options.apiKey`). The key is kept **in memory only** — it is never written to disk and never appears in logs or output.
2. `GET availability.endpoint` with `Authorization: Bearer <apiKey>` and the configured timeout.
3. Parse the response: find plans with `status: "active"` whose `[starts_at, ends_at)` window contains the server's `server_time`.
4. Among those, require at least one plan whose `entitlements[].capabilities` includes `availability.model`.

If any step fails, the switch is skipped (`apply.mjs` exits 0 and prints `skipped: <reason>`). Possible reasons: `http-error`, `non-200`, `no-active-plan`, `not-in-window`, `no-entitlement`, `timeout`, `parse-error`. With `enabled: false` the check is skipped entirely (reason `disabled`).

The default endpoint, `https://zcode.z.ai/api/v1/zcode-plan/billing/current`, is the ZCode plan billing API. If you use a different provider, point `endpoint` / `provider` / `model` at the equivalent values — or just disable the check.

## Logs & state

All files below live in the project directory:

| File | Purpose |
|---|---|
| `state.json` | Current mode (`original`/`target`), `switchedAt`, the snapshot of pre-switch values, `lastCheck`. |
| `history.jsonl` | One JSON line per switch/restore: `{ time, mode, reason: "switch"\|"restore", agents }`. |
| `logs/` | `launchd.out.log` / `launchd.err.log` (launchd runs), `hook.out.log` / `hook.err.log` (SessionStart hook runs). |
| `logs/runs.jsonl` | One JSON record appended per run (schema `zcode-model-schedule/run-log/v1`: time, trigger, window decision, availability, action, change details, duration, exit code); rotated to `runs.jsonl.1` at 1 MiB (one backup kept). Records contain only error types and codes — never API keys or error messages. |

A corrupted `state.json` is treated as "not switched" (with a `[warn]` on stderr), so the tool self-heals by re-evaluating the schedule.

After upgrading to a version with trigger annotations, re-run `node install.mjs` (launchd) and `node install.mjs --register-hook` (SessionStart hook) to update the `--trigger` arguments; existing installs that are not re-installed keep recording `manual`.

## Security notes

- The API key is read from `~/.zcode/v2/config.json`, used only for the availability request header, and never persisted, logged, or echoed. Error paths deliberately log only the file path and error type.
- File writes are atomic (temp file + rename) and preserve file permissions.
- The tool modifies only these files:
  - `~/.zcode/v2/agents-state.json` — keys inside `builtInModelSelectionOverrides` (other top-level keys are untouched);
  - your custom agent `.md` files — only the `model:` / `thoughtLevel:` lines inside the YAML frontmatter;
  - `~/.zcode/cli/config.json` — appends the hook entry, with a timestamped `.bak-<ISO>` backup before the first change.
- No telemetry; the only outbound network call is the availability endpoint, and only when `availability.enabled` is `true`.
- The tool runs with your user privileges (via launchd or the hook). Read the source before installing — it is small and dependency-free (Node built-ins only).

## Troubleshooting

- **`[invalid] target: ...` / model not found** — `target.providerId` or `target.modelId` does not match `~/.zcode/v2/config.json`, or `target.reasoningLevel` is not in the model's supported list. Check the exact provider/model IDs in ZCode's config.
- **`[invalid] agents[n]: custom agent "..." 文件不存在`** — the `.md` file for a custom agent is missing. Fix `agents[].path` or create the file (it needs a frontmatter with a `model:` line).
- **`applied` fails with `[error] ... frontmatter`** — a custom agent file is missing its frontmatter markers or `model:` line. Repair the file and re-run; the pre-switch snapshot is preserved, so nothing is lost.
- **Plan expired / `skipped: no-active-plan` / `skipped: not-in-window`** — the billing endpoint reports no active plan for now. The tool stays on your original setup; it will switch on a later trigger when the plan is usable again.
- **Node path invalid after upgrading/moving Node** — launchd runs the binary recorded in `node-path`. Re-run `node install.mjs` to refresh it. The hook script falls back to `$NODE` or `node` from `PATH` when `node-path` is missing.
- **Stale lock / exit code 2** — a previous run crashed while holding `.apply.lock`. The tool removes the lock automatically if it is older than 10 minutes or its owning process no longer exists. Otherwise, make sure no `apply.mjs` is running, then delete `.apply.lock`.
- **ZCode changes its config format** — the tool depends on the current shape of `~/.zcode/v2/agents-state.json` and `~/.zcode/cli/config.json`. If a ZCode update changes those schemas, switching may fail or warn; check `logs/` for `[warn]` lines and open an issue.

## Uninstall

```bash
# 1. Remove the launchd agent
node install.mjs --uninstall

# 2. Remove the SessionStart hook: edit ~/.zcode/cli/config.json and delete the
#    SessionStart entry whose command mentions model-schedule-apply.sh
#    (a .bak-<timestamp> backup was created when the hook was first registered)

# 3. Delete the project directory (state.json, history.jsonl and logs/ live inside it)
```

## License

[MIT](LICENSE) © 2026 pppetertao
