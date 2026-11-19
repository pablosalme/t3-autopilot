# t3-autopilot reference

The technical side of t3-autopilot: the tools, the policy file, the data it keeps and how models are matched. For a plain introduction and the installation steps, read the [README](../README.md) ([en español](README.es.md)).

- [What it is, technically](#what-it-is-technically)
- [Example call](#example-call)
- [How it works](#how-it-works)
- [Command line](#command-line)
- [Registering the server](#registering-the-server)
- [Instructions for the orchestrator](#instructions-for-the-orchestrator)
- [Tools](#tools)
- [Supported providers](#supported-providers)
- [The policy](#the-policy)
- [Unavailable marks](#unavailable-marks)
- [Log and statistics](#log-and-statistics)
- [Data directory](#data-directory)
- [Capabilities and restarts](#capabilities-and-restarts)
- [FAQ and limitations](#faq-and-limitations)
- [Development](#development)
- [Roadmap](#roadmap)

## What it is, technically

t3-autopilot is an [MCP](https://modelcontextprotocol.io) server over stdio that tells a [T3 Code](https://github.com/pingdotgg/t3code) orchestrator which provider instance, model id and options (such as reasoning effort) to use for each child task.

In T3 Code, one agent thread (the *orchestrator*) can hand work to child threads that run on any provider you have connected: Claude, Codex, Cursor, Grok, OpenCode, Antigravity, Kiro, Pi, fx, Muse or an ACP agent. For every child it has to pick a provider instance, an exact model id and options. t3-autopilot answers one question before each delegation: *for this task, which of the models I actually have should I use?* You state your preferences once, per task type, as **model families** (`claude-opus`, `gpt`, `gemini`...) in a YAML policy. t3-autopilot resolves each family to the newest matching model id on the providers your T3 setup offers right now and returns targets ready for `delegate_task`, best first, with the reason for each.

It only recommends: it never launches agents, never proxies requests, makes no network requests and never reads provider tokens or T3's settings files.

## Example call

The orchestrator is about to delegate a review. It calls `recommend_model` (the first call of a thread also passes the output of T3's `orchestrator_capabilities`):

```json
{ "task": "Review the PR that moves auth checks into middleware", "taskType": "review", "criticality": "high", "capabilities": { "...": "output of orchestrator_capabilities" } }
```

t3-autopilot answers (real output, without the `classification`, `skipped` and `usageSource` fields; the setup is invented: Claude, Codex, Cursor, Grok and OpenCode, with the orchestrator on Claude, and the model names are made up):

```json
{
  "taskType": "review",
  "candidates": [
    {
      "providerInstanceId": "codex",
      "model": "gpt-6.2-codex",
      "options": [{ "id": "reasoningEffort", "value": "xhigh" }],
      "reason": "review #1: latest gpt on codex is gpt-6.2-codex, effort xhigh",
      "source": "taskType",
      "sameAsOrchestrator": false
    },
    {
      "providerInstanceId": "cursor",
      "model": "gemini-5.1-pro",
      "options": [{ "id": "reasoning_effort", "value": "high" }],
      "reason": "review #3 (any provider): newest listed gemini on cursor is gemini-5.1-pro, effort high (31 models left out of the list, so a newer one may exist; effort xhigh not supported, using high)",
      "source": "taskType",
      "sameAsOrchestrator": false
    },
    {
      "providerInstanceId": "grok",
      "model": "grok-6",
      "options": [{ "id": "reasoningEffort", "value": "xhigh" }],
      "reason": "review #4: latest grok on grok is grok-6, effort xhigh",
      "source": "taskType",
      "sameAsOrchestrator": false
    }
  ],
  "warnings": [
    "cursor: orchestrator_capabilities left out 31 models, so a newer model may be missing. Call orchestrator_capabilities with search \"cursor gpt\", \"cursor gemini\" and pass each output to recommend_model with mergeCapabilities: true.",
    "opencode: orchestrator_capabilities left out 52 models, so a newer model may be missing. Call orchestrator_capabilities with search \"opencode gpt\", \"opencode gemini\" and pass each output to recommend_model with mergeCapabilities: true."
  ],
  "capabilitiesFrom": "call"
}
```

The review goes to another provider than the orchestrator's (Claude's own candidate is moved down), `criticality: "high"` raised the effort one step, and Cursor's Gemini, which tops out at `high`, got that instead. Cursor and OpenCode list only part of their catalog, so the Gemini pick is the newest *listed* one and the warnings give the searches that would show the rest. The orchestrator then delegates with the first candidate as `delegate_task.target` and tells you in one line which model it picked and why.

## How it works

```text
orchestrator ── orchestrator_capabilities ─────────────────────▶ T3 Code
orchestrator ── recommend_model(task, taskType, capabilities) ─▶ t3-autopilot
orchestrator ◀─ candidates: providerInstanceId, model, options, reason
orchestrator ── delegate_task(target = first candidate) ───────▶ T3 Code
orchestrator ── log_delegation, later log_outcome ─────────────▶ t3-autopilot (log.jsonl)
orchestrator ── mark_unavailable (child hit a limit or plan) ──▶ t3-autopilot (unavailable.json)
```

1. T3 Code has no plugin or hook for delegation, so t3-autopilot is a separate stdio MCP server added to the CLI of the agent that acts as orchestrator. A short instruction in your `CLAUDE.md` / `AGENTS.md` tells the orchestrator to call it before every child task.
2. An MCP server cannot call T3's tools, so the orchestrator passes the output of `orchestrator_capabilities` (the providers and models your T3 setup offers) on the first call of a thread. The server keeps the last one, in memory and in a file in its data directory, so later calls omit it, even after the server restarts.
3. For the task type, t3-autopilot walks the policy's candidates in order, resolves each model family on every eligible provider instance and returns up to 3 candidates (`maxCandidates`). Free slots are filled from the policy's `fallback` list and, if needed, with a provider's default model (marked "low confidence"). If nothing at all resolves, the single candidate is the orchestrator's own provider, model and options (`source: "inherited"`).
4. The orchestrator logs each delegation and, after reviewing the child's work, its outcome. `get_stats` summarises that log so you can tune the policy with your own data.
5. When a child cannot start because of a usage limit or its plan, the orchestrator marks that provider instance (or only that model) unavailable, and until the mark expires its candidates come last with the reason. A `failure` outcome, by contrast, is about quality and moves nothing.

Candidates are ranked by, in this order: not marked unavailable, usage tier (see [Usage limits](#usage-limits)), not the orchestrator's provider when the task type asks for an independent review, and the order in the policy.

## Command line

The package installs one command, `t3-autopilot` (run it with `npx -y t3-autopilot`, or as `node dist/cli.js` in a source checkout). It needs Node.js 22 or later.

| Command | What it does | Exit code |
|---|---|---|
| `t3-autopilot` (or `t3-autopilot serve`) | Starts the MCP server on stdio. This is what your agent CLI runs. | `0` |
| `t3-autopilot snippet` | Prints the instructions to paste into `CLAUDE.md` / `AGENTS.md`. | `0` |
| `t3-autopilot init-policy` | Writes a commented override template to `policy.yaml` in the [data directory](#data-directory). Never overwrites an existing file. | `0`, or `1` if the file exists |
| `t3-autopilot --help` (`-h`, `help`) | Prints the usage text. | `0` |
| `t3-autopilot --version` (`-v`) | Prints the version. | `0` |

An unknown command prints the usage text on stderr and exits with `2`.

## Registering the server

Only the orchestrator needs the server; child agents do not. Register it at user scope so every project gets it, then restart the agent in T3 Code so it loads the new server.

**Claude Code**

```sh
claude mcp add --scope user t3-autopilot -- npx -y t3-autopilot
claude mcp list   # t3-autopilot: ... ✔ Connected
```

**Codex** (`codex mcp add t3-autopilot -- npx -y t3-autopilot`, or in `~/.codex/config.toml`):

```toml
[mcp_servers.t3-autopilot]
command = "npx"
args = ["-y", "t3-autopilot"]
```

**Grok CLI** (writes `~/.grok/config.toml`; `grok mcp doctor` checks the connection):

```sh
grok mcp add t3-autopilot -- npx -y t3-autopilot
```

**OpenCode** (writes the global `~/.config/opencode/opencode.json`):

```sh
opencode mcp add t3-autopilot --global -- npx -y t3-autopilot
```

**Other MCP clients** that read an `mcpServers` JSON block:

```json
{
  "mcpServers": {
    "t3-autopilot": { "command": "npx", "args": ["-y", "t3-autopilot"] }
  }
}
```

### From source

```sh
git clone https://github.com/pablosalme/t3-autopilot.git
cd t3-autopilot
npm ci            # installs dependencies and builds dist/ (prepare script)
```

After `git pull`, run `npm ci` again (or `npm run build`). Register the server with the absolute path to `dist/cli.js` instead of `npx -y t3-autopilot`, that is, command `node` with the argument `/path/to/t3-autopilot/dist/cli.js`:

```sh
claude mcp add --scope user t3-autopilot -- node /path/to/t3-autopilot/dist/cli.js
```

To give the server a different data directory, set `T3_AUTOPILOT_HOME` in the environment your MCP client starts it with (see [Data directory](#data-directory)).

## Instructions for the orchestrator

T3 Code tells orchestrators to use their native subagent tool for children on their own provider, and *"Provider or model unavailable: say so. Never switch unasked"*. The snippet that `t3-autopilot snippet` prints asks for a recommendation before every child, native ones too, and explicitly authorises the orchestrator to switch provider and model as recommended. Paste it into the orchestrator's `CLAUDE.md` or `AGENTS.md`; the full text is in the [README](../README.md#step-2-tell-your-agent-to-use-it).

In short, it tells the orchestrator to:

1. call `recommend_model` before every child task, always with `taskType`;
2. pass `capabilities` on the first call of the thread, after an error and when providers change;
3. use the first candidate (its native subagent tool if `sameAsOrchestrator` is `true`, otherwise `delegate_task`), and call `mark_unavailable` and take the next one if the child cannot start because of a usage limit or its plan;
4. tell the user in one line which provider and model it picked and why;
5. inherit its own provider and model if there is no candidate or the call fails;
6. run the `search` a warning suggests and merge it with `mergeCapabilities: true`;
7. use the provider or model the user names, when they name one;
8. call `log_delegation` after delegating and `log_outcome` after reviewing the result.

Whether the orchestrator follows it depends on the model; nothing enforces it. `get_stats` shows how often the first candidate was used.

## Tools

| Tool | Input | Output |
|---|---|---|
| `recommend_model` | `task`, `taskType` (always pass it), optional `capabilities` (required on the first call), `mergeCapabilities`, `size` (`small`/`medium`/`large`), `criticality` (`low`/`normal`/`high`), `usage` | `taskType`, `classification`, `candidates[]` (`providerInstanceId`, `model`, `options`, `reason`, `source`, `sameAsOrchestrator`), `skipped[]`, `warnings[]`, `usageSource`, `capabilitiesFrom` (`call`/`cache`/`disk-cache`/`merged`), `capabilitiesAgeMinutes` (unless `call`) |
| `log_delegation` | `taskType`, `providerInstanceId`, `model`, optional `options`, `recommendedRank` (1-based, or null), `childThreadId`, `summary` | `delegationId` and `logged` (the stored record) |
| `log_outcome` | `outcome` (`success`/`corrected`/`failure`), optional `note`, plus `delegationId` **or** `taskType` + `providerInstanceId` + `model` | `logged` (the stored record) |
| `mark_unavailable` | `providerInstanceId`, optional `model` (omit for every model), `reason` (required unless clearing), `until` (ISO date; 24 h by default), or `clear: true` to remove marks | `marked` (or `cleared`) and `active`, every mark in force |
| `get_stats` | optional `since` (ISO date), `taskType` | `log` (the file path), counts, success rate and pending delegations in total, per task type and per model; `followedFirstRecommendation`; the `unavailable` marks in force. With `taskType`: `stats` for that type only (or `null`) |

- `capabilities` accepts the object as T3 returns it, a JSON string, a bare `providers` array, or a list of several outputs (`[full, search1, ...]`), merged by `providerInstanceId`.
- `classification` says whether the task type was `given` by the caller or came from the keyword `classifier`, with the keywords that matched.
- `source` is `taskType`, `fallback`, `generic` (a provider's default model, low confidence) or `inherited` (the orchestrator's own model, used only when nothing else resolves).
- `sameAsOrchestrator` is `true` when the candidate is the orchestrator's own provider instance and model, so its native subagent tool does the same job.
- `skipped` says why providers or policy entries were left out (disabled, not signed in, excluded, marked unavailable); `warnings` are things the orchestrator can act on.
- `usageSource` is `none`, or `none+call` when the call passed `usage`.
- Errors (unknown `taskType`, no capabilities yet, no eligible provider, an invalid policy file) come back as tool errors with a message that says what to fix; the server keeps running.

## Supported providers

t3-autopilot works with whatever provider instances you have in T3 Code, in any combination, including several instances of the same driver (for example two Claude subscriptions). It knows the eleven drivers T3 ships: `claudeAgent`, `codex`, `cursor`, `grok`, `opencode`, `antigravity`, `kiro`, `pi`, `fx`, `muse` and `acpRegistry`. [providers.md](providers.md) lists each one's model ids, effort option and default model, with references to T3's source.

- **Eligibility.** Only instances with `canRunChildTask: true` (enabled for the project, installed and signed in) are recommended, minus the ones in `excludeProviders` and any instance that reports `canRunCrossProviderChildTask: false` and is not the orchestrator's own. If none is eligible, `recommend_model` fails with each instance's reason.
- **Families across drivers.** Most families match on any driver, so Claude Opus is found as `claude-opus-5-5` on Claude or Cursor, `claude-opus-5.5` on Kiro, or `anthropic/claude-opus-5-5` on OpenCode and Pi.
- **Short model lists.** For Cursor, OpenCode, Pi, Kiro, fx, Antigravity and ACP agents, T3 lists at most 8 models and counts the rest as `omittedModels`. Then the result has a `warnings` entry with the `search` to run (for example `orchestrator_capabilities` with `search: "cursor opus"`); passing that output with `mergeCapabilities: true` merges it into the kept capabilities, and the warning goes away for the providers the search listed models for. Without it, the newest model is chosen among the listed ones only. A search is capped at 8 matches too, in the user's order rather than by version, so when it still leaves models out the warning stays and suggests a narrower search (for example `"cursor gemini-9"` and `"cursor gemini-10"`). While a provider's latest list is truncated, its candidates say "newest listed" instead of "latest".
- **Unknown providers.** A provider no family covers (an unknown driver, an ACP agent with its own model names) still gets a candidate: its default model (`default`, `auto`, `grok-build`, `antigravity-default`) or, failing that, the first model T3 lists for it, marked "low confidence".

## The policy

The default policy is [`policy/default.yaml`](../policy/default.yaml). Override it in `~/.t3-autopilot/policy.yaml` (or `$T3_AUTOPILOT_HOME/policy.yaml`). It is re-read on every call, so no restart is needed; a broken file is reported by the tools that use it (file, entry and reason) and the server keeps running. `t3-autopilot init-policy` writes a short commented template there; uncomment only what you change, so future default updates still reach you.

Merge rules: entries under `families` and `taskTypes` replace the default entry with the same name as a whole (set one to `null` to remove it); `usage` and `effortShift` merge one level deep; every other key replaces the default.

### Keys

| Key | Default | Meaning |
|---|---|---|
| `version` | `1` | Policy format version. |
| `maxCandidates` | `3` | How many candidates `recommend_model` returns (1 to 3). |
| `defaultTaskType` | `code` | Task type used when none is given and no keyword matches. |
| `effortOptionIds` | `[effort, reasoningEffort, reasoning_effort, variant, thinking, reasoning, thought_level]` | Option ids that carry reasoning effort, in order of preference. |
| `effortShift` | `size: { small: -1, medium: 0, large: 1 }`, `criticality: { low: -1, normal: 0, high: 1 }` | Steps added to a candidate's effort for the call's `size` and `criticality`. |
| `usage.source` | `none` | Where usage comes from. `none`: only the `usage` passed in the call. |
| `usage.thresholds` | `{ session: 80, weekly: 75, monthly: 90, other: 90 }` | Percent used from which a provider is moved after the others. |
| `capabilitiesCacheTtlHours` | `12` | How long saved capabilities are reused after a restart. `0`: never. |
| `excludeProviders` | `[]` | Provider instance ids never recommended. |
| `genericFallback` | `true` | Whether to fill free slots with a provider's default model, low confidence. |
| `families` | see the file | Model families. |
| `taskTypes` | see the file | Task types with their candidates. |
| `fallback` | see the file | Candidates that fill the slots a task type leaves free. |

### Task types

`review`, `debug`, `plan`, `research`, `quick`, `code`, `design`, `writing`; the tool description lists them with one line each. The orchestrator is an LLM and should always pass `taskType`. If it does not, the task text is matched against each type's `keywords` (case-insensitive, whole words; a phrase scores its number of words); the highest score wins, ties go to the type listed first, and no match gives `defaultTaskType` (`code`). The keywords are a last resort, not a classifier.

A task type has an optional `description`, `keywords`, at least one entry in `candidates` and optionally `avoidInheritedProvider: true`: for independent reviews (set on the `review` type), the orchestrator's own provider is moved down so the review comes from a different one.

### Model families

A family maps driver kinds (`driverKind` in `orchestrator_capabilities`; `*` for any driver without its own entry) to a case-insensitive regular expression over model ids, plus an optional `exclude` regex and a `search` hint. When several ids match, the highest version wins (numeric capture groups compared in order; numbers of 5 or more digits are snapshot dates and are ignored); on a tie (`gemini-4-neon` and `gemini-4-argon` are both version 4), the model T3 lists first (your preferred order) wins, and its reason says "same version as N others, T3 lists this one first" instead of calling it the latest. A new version or a renamed tier that still matches the family (`claude-opus-5-5` → `claude-opus-5-6`, `gemini-4-carbon` → `gemini-4-neon`) is picked up with no change to code or policy.

```yaml
families:
  devstral:
    search: devstral
    match:
      '*': '^(?:[\w.-]+/)*devstral-(\d+)(?:\.(\d+))?$'

taskTypes:
  quick:
    keywords: [rename, typo, format, bump]
    candidates:
      - { provider: acpRegistry, family: devstral }
      - { provider: claudeAgent, family: claude-haiku, effort: low }
      - { provider: '*', family: gemini-flash, effort: low }

excludeProviders: [cursor-work]  # never recommend this provider instance
capabilitiesCacheTtlHours: 4     # reuse saved capabilities after a restart for 4 h (default 12, 0: never)
genericFallback: false           # never recommend a provider's default model with low confidence
usage:
  thresholds: { weekly: 60 }
```

### Candidates

A candidate names a driver kind (`provider`, matching every eligible instance of it), `'*'` (any eligible instance, in the order T3 lists them) or an exact provider instance (`instance`, which takes precedence over `provider`), and a `family`. Optional `effort`, optional `options` (for example `{ fastMode: true }`), set when the model supports them, and `noDemote: true`, which keeps a candidate in place when its provider is busy (below 100%).

The candidate order in the default policy is an unvalidated starting point, not a benchmark result. `claude-fable` is placed second for `writing`, and third for `design` and `plan`, because T3 gives it a fixed 1M-token context; that is a guess too. Use `get_stats` to see what works for you.

### Effort

Each candidate can set an `effort` on the scale `none < minimal < low < medium < high < xhigh < max`. `size` and `criticality` shift it (by default `small`/`low` one step down, `large`/`high` one step up, never below `low`). The value is written to the first effort option the model declares (`effort`, `reasoningEffort`, `reasoning_effort`, `variant`, `thinking`, `reasoning`, `thought_level`, or an ACP option whose id looks like one) and clamped to the values it supports; a boolean `thinking` toggle is never used for effort. Fallback candidates use the effort of the task type's first candidate, so a quick task does not get a fallback model at high effort.

### Usage limits

If you pass `usage` (percentages per provider instance, in the same shape as T3's own usage windows: `kind`, `usedPercent`, `resetsAt`, `modelIds`), a candidate whose provider is above a threshold (default: session 80%, weekly 75%, monthly 90%, other 90%) moves after the others, and one at 100% goes last; within each group the policy order stays. If every provider is exhausted you still get candidates, each marked as such. Unknown usage never penalises, and windows with an unknown `kind` or a percentage outside 0-100 are ignored.

```json
{ "usage": [{ "providerInstanceId": "codex", "windows": [{ "kind": "weekly", "usedPercent": 82, "resetsAt": "2026-01-05T00:00:00Z" }] }] }
```

## Unavailable marks

`mark_unavailable` records that a provider instance, or one of its models, cannot run children for a while (a usage limit, a plan that does not include the model). Until the mark's `until` (24 hours from now when not given; it must be in the future), `recommend_model` puts those candidates after every other one, with the reason in theirs, or in `skipped` when they do not make the list. A new mark for the same provider instance and model replaces the old one, and `clear: true` removes the marks of a provider instance (only one model's when `model` is given). Marks live in `unavailable.json`:

```json
{
  "version": 1,
  "marks": [
    { "providerInstanceId": "cursor", "model": "gemini-5.1-pro", "reason": "not included in your weekly usage", "markedAt": "2026-01-02T10:00:00.000Z", "until": "2026-01-03T10:00:00.000Z" }
  ]
}
```

A mark says nothing about quality. A poor result is a `failure` in `log_outcome`, which changes no ordering.

## Log and statistics

`log.jsonl` is a text file with one JSON record per line (JSONL), appended by `log_delegation` and `log_outcome`:

```json
{"kind":"delegation","id":"d_3f9a1c2b7e40","ts":"2026-01-02T10:00:00.000Z","taskType":"review","providerInstanceId":"codex","model":"gpt-6.2-codex","options":[{"id":"reasoningEffort","value":"xhigh"}],"recommendedRank":1,"childThreadId":"thread-123","summary":"Review the auth middleware PR"}
{"kind":"outcome","ts":"2026-01-02T10:20:00.000Z","delegationId":"d_3f9a1c2b7e40","outcome":"success","note":"accepted as is"}
```

- `summary` and `note` are cut to 200 characters. `options`, `recommendedRank`, `childThreadId`, `summary` and `note` are stored only when passed.
- `log_outcome` needs a `delegationId` that is in the log, or `taskType` + `providerInstanceId` + `model`; with those three and no id, the outcome is stored on its own with a new id.
- Lines that are not valid records are skipped when reading.

`get_stats` returns `total`, `byTaskType` (each with its own `byModel`) and `byModel` (keys are `providerInstanceId/model`). Each has `delegations`, `success`, `failure`, `corrected`, `pending` (delegations with no outcome yet) and `successRate` (`success` divided by the outcomes logged; `null` when there are none). The last outcome logged for a delegation wins. `followedFirstRecommendation` counts, among delegations that logged a `recommendedRank`, how many used rank 1. `since` keeps only the records from that date on.

## Data directory

Everything lives in `~/.t3-autopilot/` (or the directory named by the `T3_AUTOPILOT_HOME` environment variable, the only one t3-autopilot reads):

| File | Contents |
|---|---|
| `policy.yaml` | Your policy override. |
| `log.jsonl` | Delegations and outcomes. |
| `unavailable.json` | `mark_unavailable` marks: provider instance, model, a reason cut to 200 characters, until when. |
| `capabilities-cache.json` | The last `orchestrator_capabilities` output: provider and model ids, options, sign-in constraints, the orchestrator's thread, provider and model; no tokens. |

The task text passed to `recommend_model` is not stored; `log_delegation` stores a `summary` and `log_outcome` a `note` only if you pass them (cut to 200 characters). t3-autopilot makes no network requests. The JSON files are written atomically (to a temporary file, then renamed), so another server process never reads a half-written one.

## Capabilities and restarts

Agent CLIs can restart MCP servers between turns, so the last full `orchestrator_capabilities` output (and the searches merged into it) is also saved in `capabilities-cache.json` and reused for `capabilitiesCacheTtlHours` (12 by default) after it was received; merging a search does not reset that clock. A result built on it says `capabilitiesFrom: "disk-cache"`, its age in `capabilitiesAgeMinutes`, and a warning. The copy can be out of date: within those hours a provider may sign out or retire a model id, and every orchestrator that shares the data directory saves to the same file, so after a restart one may get another's capabilities (its own provider and model decide `sameAsOrchestrator` and the independent-review rule; the warning names them). A child that cannot start, or a rejected model id, is the sign to pass a fresh output. A copy older than the TTL is ignored, so the call fails with "No capabilities yet", like the first call of a thread; a lone search output passed with `mergeCapabilities` and nothing to merge into is used for that call only and not kept. Set `capabilitiesCacheTtlHours: 0` to keep capabilities in memory only.

## FAQ and limitations

**Does it know how much of my subscription quota is left?** No. T3 Code tracks usage limits per provider, but does not expose them over MCP, and t3-autopilot will not read provider tokens or cookies to find out. Usage only counts when the orchestrator passes `usage` in the call; otherwise every provider is treated as available.

**Why does the orchestrator have to pass `capabilities`?** An MCP server cannot call T3's tools, and t3-autopilot deliberately does not read T3's files: `settings.json` can hold API keys, and the provider cache is an internal format without sign-in or per-project status ([details](providers.md#local-autodetection-not-implemented)). The orchestrator passes `orchestrator_capabilities` once per thread; the server keeps it.

**A provider released or renamed a model. Do I need to update anything?** Not if the new id still matches its family (see [Model families](#model-families)); pass a fresh `orchestrator_capabilities` output and the new id is used. A new family or naming scheme needs a policy entry. A small model with a new suffix can be taken for the flagship of its family (a hypothetical `gpt-7-io` matches `gpt`); add the suffix to that family's `exclude`.

**Does it guarantee the orchestrator uses the recommendation?** No. The snippet asks for it and authorises switching, but the orchestrator is a language model. `log_delegation` records whether it used the first candidate (`recommendedRank`).

**Why can a warning about omitted models stay after a search?** It goes away once a merged search output lists models for that provider and leaves none out. A search with more than 8 matches is truncated as well, so the warning stays with a narrower search to run. If the search finds nothing for the provider, T3 returns it with no models, which looks the same as a provider the search did not select, so the warning stays too.

**Does it work without T3 Code?** It is built around T3's `orchestrator_capabilities` and `delegate_task`. Another host would have to pass data in the same shape.

**Are the model names in the examples real?** No. Fixtures and examples use invented versions so they never read as claims about real models.

## Development

```sh
npm ci
npm run lint            # Biome: lint and format check (npm run format fixes)
npm run typecheck
npm run test:coverage   # Vitest with coverage thresholds
npm run build
npm run smoke           # starts dist/cli.js over stdio and calls recommend_model with several fixtures
npm run test:e2e        # end-to-end over stdio with the MCP SDK client (node:test)
npm run test:pack       # npm pack, install the tarball in a temporary project, run its bin
```

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the requirements, the project layout and the workflow, [SECURITY.md](../SECURITY.md) to report a vulnerability and [CHANGELOG.md](../CHANGELOG.md) for changes.

## Roadmap

1. **Usage from T3 Code.** T3 already tracks session, weekly and monthly limits per provider but only exposes them over its internal WebSocket API. A `t3` usage source will follow if T3 exposes usage over MCP ([discussion #15137](https://github.com/pingdotgg/t3code/discussions/15137)).
2. **Third-party usage readers** (local usage aggregators) as additional usage sources. t3-autopilot itself will not read provider tokens or cookies.
3. **Policy proposals:** compare `orchestrator_capabilities` with the policy (new or retired families) and propose a policy diff for you to approve.
4. **Ordering from the log:** reorder candidates per task type by observed success rate once there is enough data.
