# t3-autopilot reference

The technical side of t3-autopilot: the tools, the policy file, the data it keeps and how models are matched. For a plain introduction and the installation steps, read the [README](../README.md) ([en español](README.es.md)).

- [What it is, technically](#what-it-is-technically)
- [Example call](#example-call)
- [How it works](#how-it-works)
- [Command line](#command-line)
- [Registering the server](#registering-the-server)
- [Instructions for the orchestrator](#instructions-for-the-orchestrator)
- [Tools](#tools)
  - [Hosts](#hosts)
- [Supported providers](#supported-providers)
- [The policy](#the-policy)
- [Unavailable marks](#unavailable-marks)
- [Subscription profiles](#subscription-profiles)
- [Log and statistics](#log-and-statistics)
- [Data directory](#data-directory)
- [Capabilities and restarts](#capabilities-and-restarts)
  - [Merging outputs](#merging-outputs)
- [Agent catalog](#agent-catalog)
  - [Flags checked](#flags-checked)
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
orchestrator ── set_subscription (answers to setupNeeded) ─────▶ t3-autopilot (subscriptions.yaml)
```

1. T3 Code has no plugin or hook for delegation, so t3-autopilot is a separate stdio MCP server added to the CLI of the agent that acts as orchestrator. A short instruction in your `CLAUDE.md` / `AGENTS.md` tells the orchestrator to call it before every child task.
2. An MCP server cannot call T3's tools, so the orchestrator passes the complete output of `orchestrator_capabilities` (the providers and models your T3 setup offers) on the first call of a thread. The server keeps the last one, in memory and in a file in its data directory, so later calls omit it, even after the server restarts.
3. For the task type, t3-autopilot walks the policy's candidates in order, resolves each model family on every eligible provider instance and returns up to 3 candidates (`maxCandidates`). Free slots are filled from the policy's `fallback` list and, if needed, with a provider's default model (marked "low confidence"). If nothing at all resolves, the single candidate is the orchestrator's own provider, model and options (`source: "inherited"`).
4. The orchestrator logs each delegation and, after reviewing the child's work, its outcome. `get_stats` summarises that log so you can tune the policy with your own data.
5. When a child cannot start because of a usage limit or its plan, the orchestrator marks that provider instance (or only that model) unavailable, and until the mark expires its candidates go after every other one except models that [cost extra](#how-a-profile-changes-the-recommendation), which go after them, with the reason. A `failure` outcome, by contrast, is about quality and moves nothing.
6. Each provider instance can have a [subscription profile](#subscription-profiles): the plan behind it, how much quota it has, what the user keeps it for, which models it includes and whether it shares its quota with another instance. While an eligible provider has none, the result lists it in `setupNeeded` with the questions to ask the user, and the orchestrator saves the answers with `set_subscription`.

Candidates that break their provider's subscription profile, or cost extra on its plan, are dropped while any other candidate can run. The rest are ranked by, in this order: included in the plan before [costing extra](#how-a-profile-changes-the-recommendation), not marked unavailable, usage tier (see [Usage limits](#usage-limits)), the profile's tier (primary, then secondary or tight, experimental, lastResort), not the orchestrator's provider when the task type asks for an independent review, and the order in the policy.

## Command line

The package installs one command, `t3-autopilot` (run it with `npx -y t3-autopilot`, or as `node dist/cli.js` in a source checkout). It needs Node.js 22 or later.

| Command | What it does | Exit code |
|---|---|---|
| `t3-autopilot` (or `t3-autopilot serve`) | Starts the MCP server on stdio. This is what your agent CLI runs. | `0` |
| `t3-autopilot snippet` | Prints the instructions to paste into `CLAUDE.md` / `AGENTS.md`. | `0` |
| `t3-autopilot snippet --host <id>` | Prints the instructions for that [host](#hosts): `t3` or `herdr`; `all` prints every host's, after how to tell which one the orchestrator runs in. | `0`, or `2` without a host or with an unknown one |
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
2. pass `capabilities` on the first call of the thread, after an error and when providers change, whole and never trimmed (the server keeps that copy, and one without the models' `options` loses the effort settings);
3. use the first candidate (its native subagent tool if `sameAsOrchestrator` is `true`, otherwise `delegate_task`), and call `mark_unavailable` and take the next one if the child cannot start because of a usage limit or its plan;
4. tell the user in one line which provider and model it picked and why;
5. inherit its own provider and model if there is no candidate or the call fails;
6. run the `search` a warning suggests and merge it with `mergeCapabilities: true`;
7. use the provider or model the user names, when they name one;
8. call `log_delegation` after delegating and `log_outcome` after reviewing the result;
9. when the result has `setupNeeded`, ask the user its questions, all at once and without holding up the task, save the answers with `set_subscription`, and ask the user before delegating to a candidate that a warning says costs extra or is outside its profile.

Whether the orchestrator follows it depends on the model; nothing enforces it. `get_stats` shows how often the first candidate was used.

An orchestrator that runs in herdr gets its own instructions from `t3-autopilot snippet --host herdr`: the same steps, with herdr's probe as `capabilities` and the candidate's `launch` to start each child. They are in [hosts/herdr.md](hosts/herdr.md#the-instructions). For one rules file read by agents in several hosts (a single global `CLAUDE.md`), `t3-autopilot snippet --host all` prints every host's instructions, each under its name, after a first step that tells the orchestrator how to find its host: T3 Code if it has the `orchestrator_capabilities` tool, herdr if `HC_TERMINAL_ID` is set.

## Tools

| Tool | Input | Output |
|---|---|---|
| `recommend_model` | `task`, `taskType` (always pass it), optional `capabilities` (required on the first call), `mergeCapabilities`, `size` (`small`/`medium`/`large`), `criticality` (`low`/`normal`/`high`), `usage`, `host`, `session`, `orchestrator` | `host` (only outside T3 Code), `taskType` (the type used), `requestedTaskType` (only when `taskType` was an alias), `classification`, `candidates[]` (`providerInstanceId`, `model`, `options`, `reason`, `source`, `sameAsOrchestrator`; `launch` in a host that starts children with a command), `skipped[]`, `warnings[]`, `usageSource`, `capabilitiesFrom` (`call`/`cache`/`disk-cache`/`merged`/`catalog`), `capabilitiesAgeMinutes` (unless `call` or `catalog`), `setupNeeded` (only when an eligible provider has no subscription profile) |
| `log_delegation` | `taskType`, `providerInstanceId`, `model`, optional `options`, `recommendedRank` (1-based, or null), `childThreadId`, `summary`, `host` | `delegationId` and `logged` (the stored record; outside T3 Code with `host`, and its id without the host's prefix) |
| `log_outcome` | `outcome` (`success`/`corrected`/`failure`), optional `note`, plus `delegationId` **or** `taskType` + `providerInstanceId` + `model`; `host` | `logged` (the stored record) |
| `mark_unavailable` | `providerInstanceId`, optional `model` (omit for every model; `prefix*` for every id that starts with `prefix`), `reason` (required unless clearing), `until` (ISO date; by default the provider's `quotaWindow`, else 24 h), or `clear: true` to remove marks; `host` | `marked` and `untilFrom` (`until`, the `quotaWindow` used, or `default 24 h`), or `cleared`; `active`, every mark of the host in force |
| `set_subscription` | `providerInstanceId`, `plan`, `quota` (`generous`/`standard`/`tight`), optional `purpose`, `role`, `quotaPool`, `quotaWindow` (`5h`/`weekly`/`monthly`), `includedFamilies` or `paidFamilies`, `onlyFamilies` or `avoidFamilies`, `onlyTaskTypes`; or `remove: true` alone; `host` | `saved` (or `removed`, null if there was none), `file`, `subscriptions` (every profile of the host), `otherHosts` (only when other hosts have profiles), `missing` (eligible providers of the kept capabilities without a profile; null if none are kept), `warnings` |
| `get_subscriptions` | optional `host` | `file`, `subscriptions`, `otherHosts` (only when other hosts have profiles), `missing` |
| `get_stats` | optional `since` (ISO date), `taskType`, `host` | `log` (the file path), counts, success rate and pending delegations in total, per task type and per model; `followedFirstRecommendation`; the `unavailable` marks in force. With `taskType`: `stats` for that type only (or `null`). With `host`: only that host's records and marks, and `host` |

- `capabilities` accepts the object as T3 returns it, a JSON string, a bare `providers` array, or a list of several outputs (`[full, search1, ...]`), merged by `providerInstanceId` (see [Merging outputs](#merging-outputs)). Pass each output complete: the server keeps what it gets. In herdr it is the output of herdr's probe, or a list of program names (see [hosts/herdr.md](hosts/herdr.md#how-it-works)).
- `classification` says whether the task type was `given` by the caller or came from the keyword `classifier`, with the keywords that matched.
- `source` is `taskType`, `fallback`, `generic` (a provider's default model, low confidence) or `inherited` (the orchestrator's own model, used only when nothing else resolves).
- `sameAsOrchestrator` is `true` when the candidate is the orchestrator's own provider instance and model, so its native subagent tool does the same job.
- `skipped` says why providers or policy entries were left out (disabled, not signed in, excluded, marked unavailable); `warnings` are things the orchestrator can act on: models left out of a short list, capabilities read from the disk cache, an unknown key in the policy file.
- `usageSource` is `none`, or `none+call` when the call passed `usage`.
- `setupNeeded` has `providers[]` (`providerInstanceId`, `driverKind`, `displayName`, `families`: the policy families with a model listed on it, and `questions` for the user) and `instructions` for the orchestrator. It never blocks the recommendation.
- `host` is the [host](#hosts) the orchestrator runs in. Leave it out in T3 Code.
- `orchestrator` is the orchestrator itself, for hosts whose `capabilities` do not name it (herdr): `agent`, as the host names it (`claude`, or a program such as `cursor-agent`), and optional `model` and `options`. It decides `sameAsOrchestrator` and the independent-review rule. T3 Code's capabilities name the orchestrator, so it is ignored there.
- `launch` says how to start the candidate in a host that starts children with a command: `mode`, `agent`, `model` and `effort` (absent when the CLI's own default applies), `args` (the program and its selection flags), `argv` (the recommended command, one element per argument, with whole-element placeholders such as `{brief}`) and `then` (commands to run next). Never a shell string; a candidate whose command cannot be built is left out and named in `skipped`. herdr's is described in [hosts/herdr.md](hosts/herdr.md#launch).
- `capabilitiesFrom: "catalog"` means a host built the catalog from files alone, because the call brought no `capabilities` and none were kept (herdr, from `hosts.herdr.agents` in the [agent catalog](#agent-catalog)).
- `session` is the orchestrator session's id (in T3 Code, the `parentThreadId` of `orchestrator_capabilities`). The capabilities are kept per session, so after a restart a call with it gets its own back and never another orchestrator's (see [Capabilities and restarts](#capabilities-and-restarts)).
- Errors (unknown `taskType`, no capabilities yet, no eligible provider, an invalid policy file) come back as tool errors with a message that says what to fix; the server keeps running.

### Hosts

A host is the app the orchestrator runs in and starts children with: T3 Code (`t3`), the default, and [herdr](hosts/herdr.md) (`herdr`, through herdr-core's `hc`); support for Orca is coming. Every tool takes an optional `host`; a call without one is for the host of this server's last `recommend_model` call (a server process serves one agent session), else T3 Code. `recommend_model` also tells T3 Code's output from the shape of `capabilities`, and fails when `host` names one host and `capabilities` look like another's output. herdr's probe output is plain text, so herdr is never assumed: a call with it that names no host fails, asking for `host: "herdr"` (unless this server's last call was for herdr). Outside T3 Code the result says `host`, and in a host that starts children with a command each candidate has `launch`: the tokens and the command to start it, one element per argument.

What t3-autopilot keeps is kept per host: [marks](#unavailable-marks), [subscription profiles](#subscription-profiles), the [log](#log-and-statistics) and the ids of the policy's `excludeProviders` and `instance`. T3 Code's ids are stored as they are, as in every 0.1 version; another host's carry its prefix (`orca:codex`), so a `codex` in one host never meets the other's. Tools take and return ids without the prefix, in the calling host; a stored id with `:` is another host's, because T3's provider instance ids never have one. A quota shared across hosts is said with the same [`quotaPool`](#shared-quota-quotapool) on both profiles; nothing else is shared.

## Supported providers

t3-autopilot works with whatever provider instances you have in T3 Code, in any combination, including several instances of the same driver (for example two Claude subscriptions). It knows the eleven drivers T3 ships: `claudeAgent`, `codex`, `cursor`, `grok`, `opencode`, `antigravity`, `kiro`, `pi`, `fx`, `muse` and `acpRegistry`. [providers.md](providers.md) lists each one's model ids, effort option and default model, with references to T3's source.

- **Eligibility.** Only instances with `canRunChildTask: true` (enabled for the project, installed and signed in) are recommended, minus the ones in `excludeProviders` and any instance that reports `canRunCrossProviderChildTask: false` and is not the orchestrator's own. If none is eligible, `recommend_model` fails with each instance's reason.
- **Families across drivers.** Most families match on any driver, so Claude Opus is found as `claude-opus-5-5` on Claude or Cursor, `claude-opus-5.5` on Kiro, or `anthropic/claude-opus-5-5` on OpenCode and Pi.
- **Short model lists.** For Cursor, OpenCode, Pi, Kiro, fx, Antigravity and ACP agents, T3 lists at most 8 models and counts the rest as `omittedModels`. Then the result has a `warnings` entry with the `search` to run (for example `orchestrator_capabilities` with `search: "cursor opus"`); passing that output with `mergeCapabilities: true` merges it into the kept capabilities, and the warning goes away for the providers the search listed models for. Without it, the newest model is chosen among the listed ones only. A search is capped at 8 matches too, in the user's order rather than by version, so when it still leaves models out the warning stays and suggests a narrower search (for example `"cursor gemini-9"` and `"cursor gemini-10"`). While a provider's latest list is truncated, its candidates say "newest listed" instead of "latest".
- **Unknown providers.** A provider no family covers (an unknown driver, an ACP agent with its own model names) still gets a candidate: its default model (`default`, `auto`, `grok-build`, `antigravity-default`) or, failing that, the first model T3 lists for it, marked "low confidence".

## The policy

The default policy is [`policy/default.yaml`](../policy/default.yaml). Override it in `~/.t3-autopilot/policy.yaml` (or `$T3_AUTOPILOT_HOME/policy.yaml`). It is re-read on every call, so no restart is needed; a broken file is reported by the tools that use it (file, entry and reason) and the server keeps running. A key the policy does not know, at any level (a misspelt `maxCandidatez`, or `efort` in a candidate), is not an error: it is ignored, and every `recommend_model` result names it in `warnings` until the file is fixed. `t3-autopilot init-policy` writes a short commented template there; uncomment only what you change, so future default updates still reach you.

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
| `excludeProviders` | `[]` | Provider instance ids never recommended; another [host](#hosts)'s with its prefix (`orca:cursor`). |
| `genericFallback` | `true` | Whether to fill free slots with a provider's default model, low confidence. |
| `families` | see the file | Model families. |
| `taskTypes` | see the file | Task types with their candidates. |
| `fallback` | see the file | Candidates that fill the slots a task type leaves free. |

### Task types

`review`, `debug`, `plan`, `research`, `quick`, `code`, `design`, `writing`; the tool description lists them with one line each. The orchestrator is an LLM and should always pass `taskType`. If it does not, the task text is matched against each type's `keywords` (case-insensitive, whole words; a phrase scores its number of words); the highest score wins, ties go to the type listed first, and no match gives `defaultTaskType` (`code`). The keywords are a last resort, not a classifier.

`taskType` also accepts other spellings and common synonyms, and the result's `taskType` is the type used, with what was passed in `requestedTaskType` and `classification.reason`. Case, spaces and underscores do not matter (`Code Review` and `code_review` are `code-review`), and these aliases are resolved:

| Task type | Aliases |
|---|---|
| `code` | `implementation`, `implement`, `coding`, `feature`, `refactor`, `refactoring`, `development`, `programming`, `tests`, `testing` |
| `debug` | `bugfix`, `bug-fix`, `fix`, `hotfix`, `bug`, `debugging`, `troubleshooting` |
| `writing` | `docs`, `documentation`, `write`, `copywriting` |
| `review` | `code-review`, `pr-review`, `audit` |
| `plan` | `planning`, `architecture` |
| `research` | `investigation`, `analysis` |
| `quick` | `trivial`, `chore` |
| `design` | `ui`, `ux` |

A task type of your policy with the same name as an alias wins over it, and an alias of a task type your policy removed is not accepted. `log_delegation` and `log_outcome` resolve aliases too, so the log keeps the type's own name. An unknown name fails with the list of types and their aliases.

A task type has an optional `description`, `keywords`, at least one entry in `candidates` and optionally `avoidInheritedProvider: true`: for independent reviews (set on the `review` type), the orchestrator's own provider is moved down so the review comes from a different one. A [subscription profile](#how-a-profile-changes-the-recommendation)'s tier weighs more: a `secondary`, `tight`, `experimental` or `lastResort` provider does not move ahead of a `primary` one because the orchestrator runs on the primary.

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

A candidate names a driver kind (`provider`, matching every eligible instance of it), `'*'` (any eligible instance, in the order T3 lists them) or an exact provider instance (`instance`, which takes precedence over `provider`; another [host](#hosts)'s with its prefix), and a `family`. Optional `effort`, optional `options` (for example `{ fastMode: true }`), set when the model supports them, and `noDemote: true`, which keeps a candidate in place when its provider is busy (below 100%).

The candidate order in the default policy is an unvalidated starting point, not a benchmark result. `claude-fable` is placed second for `writing`, and third for `design` and `plan`, because T3 gives it a fixed 1M-token context; that is a guess too. Use `get_stats` to see what works for you.

### Effort

Each candidate can set an `effort` on the scale `none < minimal < low < medium < high < xhigh < max`. `size` and `criticality` shift it (by default `small`/`low` one step down, `large`/`high` one step up, never below `low`). The value is written to the first effort option the model declares (`effort`, `reasoningEffort`, `reasoning_effort`, `variant`, `thinking`, `reasoning`, `thought_level`, or an ACP option whose id looks like one) and clamped to the values it supports; a boolean `thinking` toggle is never used for effort. Each option is set once: if a candidate also names the model's effort option under `options` (`effort: high` with `options: { effort: low }`), `effort` wins. Fallback candidates use the effort of the task type's first candidate, so a quick task does not get a fallback model at high effort.

### Usage limits

If you pass `usage` (percentages per provider instance, in the same shape as T3's own usage windows: `kind`, `usedPercent`, `resetsAt`, `modelIds`), a candidate whose provider is above a threshold (default: session 80%, weekly 75%, monthly 90%, other 90%) moves after the others, and one at 100% goes last; within each group the policy order stays. If every provider is exhausted you still get candidates, each marked as such. Unknown usage never penalises, and windows with an unknown `kind` or a percentage outside 0-100 are ignored.

```json
{ "usage": [{ "providerInstanceId": "codex", "windows": [{ "kind": "weekly", "usedPercent": 82, "resetsAt": "2026-01-05T00:00:00Z" }] }] }
```

## Unavailable marks

`mark_unavailable` records that a provider instance, or one of its models, cannot run children for a while (a usage limit, a plan that does not include the model). A `model` that ends in `*` covers every model id that starts with what comes before it: `opencode-go/*` marks the OpenCode Go plan's models and leaves the instance's other models (`opencode/*` from Zen credits, `openai/*`) alone. For a model, its own mark wins over a `prefix*` one (the longest prefix first), and that over a mark on the whole instance. Until the mark's `until` (it must be in the future; when not given, the [`quotaWindow`](#subscription-profiles) of the provider's subscription profile or, failing that, of another instance of its quota pool: 5 hours, 7 days or 30 days; else 24 hours), `recommend_model` puts those candidates after every other one (except models that [cost extra](#how-a-profile-changes-the-recommendation), which go after them), with the reason in theirs, or in `skipped` when they do not make the list. A new mark for the same provider instance and model replaces the old one, and `clear: true` removes the marks of a provider instance (only one model's when `model` is given). Marks live in `unavailable.json`:

```json
{
  "version": 1,
  "marks": [
    { "providerInstanceId": "cursor", "model": "gemini-5.1-pro", "reason": "not included in your weekly usage", "markedAt": "2026-01-02T10:00:00.000Z", "until": "2026-01-03T10:00:00.000Z" }
  ]
}
```

A mark says nothing about quality. A poor result is a `failure` in `log_outcome`, which changes no ordering. A mark on a whole provider instance also applies to the instances that share its [quota pool](#shared-quota-quotapool), for the models their plan includes.

Marks are kept per [host](#hosts): another host's are stored with its prefix (`"providerInstanceId": "orca:codex"`), change nothing in T3 Code, and are not in its `active` list; `get_stats` lists every host's, with their prefix.

## Subscription profiles

The policy says which model families suit each task; a subscription profile says what each provider instance is worth to the user. Profiles are kept per `providerInstanceId` in `subscriptions.yaml` in the [data directory](#data-directory), written by `set_subscription` (atomically, mode `600`) and re-read on every call. Without the file, recommendations are what they were before, plus `setupNeeded`.

| Key | Required | Meaning |
|---|---|---|
| `plan` | yes | The plan in the user's words (`Claude Max`, `OpenCode Go`, `pay per use`), up to 100 characters. Shown in reasons. |
| `quota` | yes | `generous` (rarely hits the limit), `standard` or `tight` (runs out quickly). |
| `purpose` | no | What the user wants it for, in their words, up to 300 characters. Informative: the keys below are what the ranking reads. |
| `role` | no | `primary` (the default), `secondary`, `experimental` or `lastResort`. |
| `quotaPool` | no | A name shared by every instance that draws from one quota. |
| `quotaWindow` | no | How often the limit resets: `5h`, `weekly` or `monthly`. A `mark_unavailable` without `until` lasts that long (5 hours, 7 days, 30 days) instead of 24 hours; instances of a quota pool without their own use a pool mate's. The longest the limit can last: pass `until` when the reset time is known. |
| `includedFamilies` | no | Policy families the plan covers; every other family costs extra on this instance. |
| `paidFamilies` | no | Policy families billed apart from the plan. Can be combined with `includedFamilies` (no family in both). |
| `onlyFamilies` | no | The instance is only for these families. Not together with `avoidFamilies`. |
| `avoidFamilies` | no | Never these families on this instance. |
| `onlyTaskTypes` | no | The instance is only for these task types. |
| `updatedAt` | set by the server | When `set_subscription` saved it. |

Profiles are kept per [host](#hosts) in the same file: another host's under its prefix (the key `orca:codex`), with the same keys and `version: 1`. `subscriptions` lists the calling host's profiles; `otherHosts`, only when there are any, the other hosts' with their prefix (T3 Code's as `t3:<id>` seen from another host).

Family and task type names are checked against the policy in force (your override included) when the profile is saved; if the policy later drops one, `recommend_model` warns. Lists cannot be empty or repeat a name, and a profile with an unknown key is rejected. `set_subscription` replaces the instance's whole profile; `get_subscriptions` shows the current one. An invalid file (bad YAML, an unknown key, a wrong value) is never overwritten: `set_subscription` and `get_subscriptions` fail with the reason, and `recommend_model` ignores every profile, says so in `warnings` and omits `setupNeeded` until it is fixed.

### How a profile changes the recommendation

- **Rules.** A candidate breaks its profile when its family is not in `onlyFamilies`, is in `avoidFamilies`, or the task type is not in `onlyTaskTypes`. A generic-fallback model is checked under the first policy family it matches; one that matches none fails `onlyFamilies` and passes the rest.
- **Restricted instances.** With `quota: tight` or `role: experimental`, a candidate also breaks the profile when the task is `size: large` or `criticality: high`, or when its family is offered by another eligible instance that is not restricted, does not rule the family out, does not bill it apart and is not marked unavailable as a whole (the user "already has" it there). A family the profile names in `onlyFamilies` is exempt from that last check.
- **Extra cost.** A candidate whose family is in `paidFamilies`, or missing from `includedFamilies`, costs extra. A model of no policy family (a provider's `auto` or `default`) never counts as paid.
- **Only option.** Candidates that break their profile or cost extra are dropped, each named in `skipped`, while any other candidate is usable (not marked unavailable, usage below 100%). If none is, they stay, their reason ends with "Used only because no candidate within the subscription profiles can run", and `warnings` has one entry per listed provider instance (per model for extra cost) telling the orchestrator to ask the user first.
- **Paid models last.** The order is: what the plans include and is not marked; what they include but is marked unavailable or out of quota (it may fail to start, but costs nothing extra); and only then what costs extra, not marked before marked. A paid model, marked or not, never goes ahead of an included one that is only marked. When the included candidates that fill the list are all marked and a paid model could run, that model takes the last slot; paid models that do not make the list are named in `skipped`. Then `warnings` says which included candidates are marked, and that every candidate is marked or costs extra: the orchestrator asks the user whether to pay, wait until the earliest mark ends, or use another provider.
- **Tier.** Among the rest, `primary` and no role rank first, then `secondary` and `quota: tight`, then `experimental`, then `lastResort`. The tier goes before the independent-review rule, so a generic, low-confidence model on an experimental provider never comes ahead of a primary provider's policy model, even when that is the orchestrator's own.
- **Reasons.** When the profile changed anything (a tier, a rule it fits, a family it includes), the candidate's reason says so, starting with `subscription <plan>, quota <quota>` and the pool, window and role when set.

### Shared quota (`quotaPool`)

Instances with the same `quotaPool` draw from one quota: one plan that covers several apps. For the models their plan includes (not those that cost extra):

- a [mark](#unavailable-marks) on a whole instance of the pool applies to the others, with a reason that names it (`shares quota pool "x-premium" with grok, marked unavailable until ...`);
- usage windows passed for one instance (those not scoped to `modelIds`) count for the others.

A pool can join instances of different [hosts](#hosts) (the same ChatGPT plan behind `codex` in T3 Code and in Orca): a mark on one applies to the other, and its reason names the mate as the calling host sees it (`orca:codex`, or `t3:codex` from Orca). Without a shared `quotaPool`, nothing passes from one host to another.

### Example: the author's setup

Claude Max; an X Premium plan ($30) whose weekly quota covers the Grok apps and Cursor Pro, where only Grok and Composer are included and Claude, GPT and Gemini are billed at API prices (`paidFamilies` says so explicitly, although `includedFamilies` already implies it); and OpenCode Go, a cheap plan with a tight quota that resets every 5 hours, to try models the other plans lack. No ChatGPT or Gemini plan.

```yaml
version: 1
subscriptions:
  claudeAgent:
    plan: Claude Max
    quota: generous
    role: primary
  grok:
    plan: X Subscription Premium ($30)
    quota: standard
    purpose: main provider for Grok models
    role: primary
    quotaPool: x-premium
    quotaWindow: weekly
  cursor:
    plan: X Subscription Premium ($30), includes Cursor Pro
    quota: standard
    purpose: Grok and Composer from the shared weekly quota; Claude, GPT and Gemini cost extra
    quotaPool: x-premium
    quotaWindow: weekly
    includedFamilies: [composer, grok, grok-build, grok-fast]
    paidFamilies: [claude-opus, claude-sonnet, claude-haiku, claude-fable, gpt, gpt-mini, gemini, gemini-flash, gemini-flash-lite]
  opencode:
    plan: OpenCode Go
    quota: tight
    purpose: only models that are not in my other subscriptions
    role: experimental
    quotaWindow: 5h
```

For a `review`, with the orchestrator on Claude, the default policy without profiles proposes GPT on Cursor (billed at API prices), GPT on OpenCode (the tight quota) and Gemini on Cursor. With these profiles (invented model names; the fixture is `test/fixtures/subscriptions-setup.json`):

```json
{
  "candidates": [
    { "providerInstanceId": "grok", "model": "grok-8.1", "reason": "review #4: latest grok on grok is grok-8.1, effort high" },
    { "providerInstanceId": "cursor", "model": "grok-8", "reason": "review #7 (any provider): latest grok on cursor is grok-8 (model has no effort option; using its default; subscription X Subscription Premium ($30), includes Cursor Pro, quota standard, pool x-premium, resets weekly: fits its profile (included in the plan: grok))" },
    { "providerInstanceId": "grok", "model": "grok-8-build", "reason": "fallback #4 (any provider): latest grok-build on grok is grok-8-build, effort high" }
  ],
  "skipped": [
    "cursor/gpt-9.1-sol: left out by its subscription profile (X Subscription Premium ($30), includes Cursor Pro, quota standard, pool x-premium, resets weekly): extra cost: gpt is billed apart from the plan (paidFamilies)",
    "cursor/gemini-7-pro: left out by its subscription profile (...): extra cost: gemini is billed apart from the plan (paidFamilies)",
    "cursor/claude-opus-9-1: left out by its subscription profile (...): extra cost: claude-opus is billed apart from the plan (paidFamilies)",
    "opencode/anthropic/claude-sonnet-9-1: left out by its subscription profile (OpenCode Go, quota tight, resets 5h, experimental): claude-sonnet is also on claudeAgent"
  ]
}
```

OpenCode's GPT and Gemini still fit its profile (the user has them nowhere else at no extra cost), but rank after the unrestricted instances, so they come up only when those cannot fill the list, and never for a large or highly critical task. When OpenCode runs out of Zen credits and hits the Go plan's 5-hour limit, `mark_unavailable` with `model: "opencode/*"` and `model: "opencode-go/*"` (the second lasts 5 hours by default, from `quotaWindow`) moves those models to the end, and `skipped` names both marks.

## Log and statistics

`log.jsonl` is a text file with one JSON record per line (JSONL), appended by `log_delegation` and `log_outcome`:

```json
{"kind":"delegation","id":"d_3f9a1c2b7e40","ts":"2026-01-02T10:00:00.000Z","taskType":"review","providerInstanceId":"codex","model":"gpt-6.2-codex","options":[{"id":"reasoningEffort","value":"xhigh"}],"recommendedRank":1,"childThreadId":"thread-123","summary":"Review the auth middleware PR"}
{"kind":"outcome","ts":"2026-01-02T10:20:00.000Z","delegationId":"d_3f9a1c2b7e40","outcome":"success","note":"accepted as is"}
```

- `summary` and `note` are cut to 200 characters. `options`, `recommendedRank`, `childThreadId`, `summary` and `note` are stored only when passed.
- `log_outcome` needs a `delegationId` that is in the log, or `taskType` + `providerInstanceId` + `model`; with those three and no id, the outcome is stored on its own with a new id.
- Lines that are not valid records are skipped when reading.
- Outside T3 Code, records store the [host](#hosts)'s prefix in `providerInstanceId` (`orca:codex`) and a `host` field (an outcome only when it is logged on its own).

`get_stats` returns `total`, `byTaskType` (each with its own `byModel`) and `byModel` (keys are `providerInstanceId/model`). Each has `delegations`, `success`, `failure`, `corrected`, `pending` (delegations with no outcome yet) and `successRate` (`success` divided by the outcomes logged; `null` when there are none). The last outcome logged for a delegation wins. `followedFirstRecommendation` counts, among delegations that logged a `recommendedRank`, how many used rank 1. `since` keeps only the records from that date on, and `host` only that host's records and marks; rows keep the stored keys, so `orca:codex/gpt-6` and `codex/gpt-6` are different rows.

## Data directory

Everything lives in `~/.t3-autopilot/` (or the directory named by the `T3_AUTOPILOT_HOME` environment variable, the only one t3-autopilot reads). A leading `~` in that variable is expanded to your home directory (`~/autopilot-data`), because the `env` block of an MCP configuration is passed as written, with no shell to expand it:

| File | Contents |
|---|---|
| `policy.yaml` | Your policy override. |
| `log.jsonl` | Delegations and outcomes. |
| `unavailable.json` | `mark_unavailable` marks: provider instance, model, a reason cut to 200 characters, until when. |
| `capabilities-cache.json` | The last `orchestrator_capabilities` output saved, of any session: provider and model ids, options, sign-in constraints, the orchestrator's thread, provider and model; no tokens. The file every 0.1 version reads and writes. |
| `capabilities-cache.<host>.json` | A [host](#hosts)'s capabilities by session, as above (`capabilities-cache.t3.json` for T3 Code, `capabilities-cache.herdr.json` for herdr: the agents its probe found, with the program of each): the 32 sessions saved last, none older than `capabilitiesCacheTtlHours`. |
| `subscriptions.yaml` | [Subscription profiles](#subscription-profiles): plan, quota, purpose and rules per provider instance, as the user described them. |
| `catalog.yaml` | Your additions to the [agent catalog](#agent-catalog), read on every herdr call. |

Every [host](#hosts) shares these files: another host's ids carry its prefix (`orca:codex`), T3 Code's are stored as they are, so a 0.1 server and a newer one can use the same directory.

The task text passed to `recommend_model` is not stored; `log_delegation` stores a `summary` and `log_outcome` a `note` only if you pass them (cut to 200 characters). t3-autopilot makes no network requests.

On Linux and macOS, `log.jsonl`, `unavailable.json`, the `capabilities-cache` files and `subscriptions.yaml` are readable by their owner only (mode `600`); a log created with a wider mode is narrowed the next time it is written. `policy.yaml` is yours and keeps the mode you give it. The JSON files and `subscriptions.yaml` are written atomically (to a temporary file, then renamed), so another server process never reads a half-written one; on Windows, where a rename fails while another process has the file open, it is tried again a few times over 150 ms before the error is reported.

## Capabilities and restarts

Agent CLIs can restart MCP servers between turns, so the last full `orchestrator_capabilities` output (and the searches merged into it) is also saved in the [data directory](#data-directory) and reused for `capabilitiesCacheTtlHours` (12 by default) after it was received; merging a search does not reset that clock. A result built on it says `capabilitiesFrom: "disk-cache"`, its age in `capabilitiesAgeMinutes`, and a warning. The copy can be out of date: within those hours a provider may sign out or retire a model id. A child that cannot start, or a rejected model id, is the sign to pass a fresh output.

Capabilities are kept per [host](#hosts) and per session:

- **Saved.** In memory, every session's last capabilities and the last ones of each host. On disk, each host's in `capabilities-cache.<host>.json`, under the call's `session` or, when it names none, the session the output names (in T3 Code, its `parentThreadId`). T3 Code also writes `capabilities-cache.json`, the single copy every 0.1 version reads and writes: always the last capabilities saved, of any session.
- **With `session`.** A call gets that session's capabilities, from memory or from the host's file, and never another orchestrator's: with none saved for it, it fails with "No capabilities yet". After a restart, each orchestrator that passes its `session` gets its own back.
- **Without `session`.** As in 0.1: the last capabilities this server used for the host, else, after a restart, `capabilities-cache.json` in T3 Code, or the entry another host saved last. Every orchestrator that shares the data directory saves there too, so after a restart one may get another's capabilities (its own provider and model decide `sameAsOrchestrator` and the independent-review rule; the warning names them).

In herdr, the kept catalog is built again on every call that brings none, from the programs its probe found and the [agent catalog](#agent-catalog) in force, so an edit to `catalog.yaml` applies on the next call, and so does the call's `orchestrator`. With nothing kept, herdr uses the agents `catalog.yaml` lists under `hosts.herdr.agents`, if any (`capabilitiesFrom: "catalog"`), and never keeps them.

Capabilities are kept as soon as they are read, also when the call that brought them then fails for another reason (an unknown `taskType`, for example), so the calls sent with it still find them. A copy older than the TTL is ignored, so the call fails with "No capabilities yet", like the first call of a thread; a lone search output passed with `mergeCapabilities` and nothing to merge into is used for that call only and not kept. Set `capabilitiesCacheTtlHours: 0` to keep capabilities in memory only.

### Merging outputs

Outputs are merged by `providerInstanceId`, whether one is passed with `mergeCapabilities: true` or several as a list (a list passed with `mergeCapabilities: true` is merged into the kept capabilities as well). The later output is the newer one, so it decides what both say:

- **Models.** A model listed again takes its fields from the later output, its `options` above all; a field the later one leaves out stays. Models with a new id are added in T3's order.
- **Eligibility.** Every output lists every provider, a `search` too, so whether a provider can run a child task (`canRunChildTask`, `constraints`, `canRunCrossProviderChildTask`) is what the later one says: a provider that signed out stops being recommended, and one that was enabled comes back.
- **The orchestrator.** `inheritedProviderInstanceId`, `inheritedModel` and `inheritedOptions` come together from the last output that names a provider, so they are the caller's own and never one output's provider with another's model.
- **Short lists.** A provider the later output lists no models for (a search that did not select it) keeps its models, its `omittedModels` and its warning.

`recommend_model` calls are handled one at a time, in the order they arrive, so calls sent together see the capabilities the first one brought.

## Agent catalog

T3 Code lists the models of every provider in `orchestrator_capabilities`. The other hosts, herdr and (coming) Orca, only say which agent CLIs are installed, or nothing at all, so t3-autopilot ships its own catalog of agent CLIs, the models and efforts each takes and, for herdr, which starts a program with arguments and knows nothing about models, how to run it: [`catalog/agents.yaml`](../catalog/agents.yaml). herdr's calls read it, with your `catalog.yaml`, on every call ([hosts/herdr.md](hosts/herdr.md)); T3 Code never reads it.

Extend it in `~/.t3-autopilot/catalog.yaml` (or `$T3_AUTOPILOT_HOME/catalog.yaml`), with the same keys. Each agent there is merged one level deep onto the built-in one: a key you set (`models`, `efforts`, `hosts`...) replaces the built-in value as a whole, so repeat the entries you want to keep, and `null` removes an agent or one of its keys. Aliases under `hosts.<host>.aliases` are merged by alias (`null` removes one). As with the policy, a key the catalog does not know is ignored with a warning. So are a `family` that is not a policy family (the model is then matched by its id alone), a model listed twice (the first one stays) and an alias to an agent the catalog does not have, or with the name of one of its agents. Anything else that is wrong, such as a model id with a space, a shell character or a leading `-`, is an error that names the file.

```yaml
agents:
  codex:
    models: [gpt-9.2-codex]                  # replaces [default]
  claude:
    models:
      - { id: opus, family: claude-opus }
      - claude-opus-9-2                      # versioned: beats the alias `opus`
      - { id: sonnet, family: claude-sonnet }
  pi:
    models: [openai/gpt-9.1-sol, anthropic/claude-opus-9-2]
  goose: { driver: goose, models: [default] }  # an agent the catalog lacks
  gemini: null                               # never offer Gemini CLI
```

| Key | Meaning |
|---|---|
| `version` | `1`. |
| `updated` | When the catalog was last reviewed (informative). |
| `agents.<id>` | An agent CLI. The id is the host's id for it (Orca's `--agent`) and becomes the agent's provider instance id. Letters, digits, `-` and `_`, starting with a letter. |
| `driver` | Driver kind (`claudeAgent`, `codex`...) for policy families, `provider:` rules and per-driver `match`, so the policy works the same in every host. Default: the agent id. |
| `name` | Display name. |
| `models` | What the CLI takes as a model, best known first: `{ id, family?, efforts? }` or the id alone. `default` means starting the CLI without a model, so it uses the one set in its own config. |
| `models[].family` | Policy family of an id no family regex recognizes, such as the alias `opus` or Codex's `default`, which is always a GPT. The model belongs to that family only. |
| `models[].efforts` | This model's efforts, instead of the agent's; `[]` for none (Claude's `haiku`). |
| `efforts` | Efforts the agent takes. Values outside the policy's scale are ignored. |
| `hosts.<host>` in an agent | What changes in one host (`orca` or `herdr`): `model: false` (the host rejects a model at launch, so only `default` is offered), `models`, `efforts` and `note`. |
| `hosts.<host>.aliases` at the top level | Ids a host uses for an agent of the catalog (Orca's `opencode2` is `opencode`). In herdr they are program names, and the name found on `PATH` is the program run. |
| `hosts.herdr.agents` at the top level | The agents herdr can start, as agent ids or program names, for a call that brings no probe output when none is kept. |
| `exe` | herdr: the program to run. Default: the agent id. |
| `aliases` in an agent | herdr: other executable names of the agent, to recognize it on `PATH` (`opencode2` for OpenCode); the name found is the program run. |
| `args` | herdr: words always passed after the program (`--no-daemon` for Codex, `chat --tui` for Kiro). |
| `flags.model`, `flags.effort` | herdr: the words that pass a model or an effort, with `{model}` or `{effort}` as a whole word; `{effort}` may also go inside one (`model_reasoning_effort={effort}`). An agent without `flags.model` can only be started with `default`, and one without `flags.effort` with no effort. |
| `prompt` | herdr: how the agent takes the brief: `positional` (the last argument), `send` (start it, wait until it is ready, then send the brief; the default) or the words that carry it, with `{brief}` as a whole word (`[--prompt, "{brief}"]`). |
| `checked` | The CLI version whose `--help` these fields were checked against (informative). |

- **No versioned ids in the built-in catalog.** They go stale, which is the problem families solve: it lists aliases the CLI resolves to its newest model (`opus`, `sonnet`) and `default`, tied to a family where no regex would match them. Versioned ids (needed, for example, by CLIs that only take `provider/model`, like OpenCode and Pi) go in your `catalog.yaml`.
- **Aliases and versioned ids.** An alias has no version, so a versioned id of the same family wins over it (`claude-opus-9-2` over `opus`); between two aliases of a family, the one listed first wins.
- **Agents without models.** An agent with no models, an agent the catalog does not know, and an agent in a host that rejects a model at launch are offered `default` only, which the generic fallback reaches with low confidence, unless the agent's own `default` entry gives it a family.
- **Safe words.** Every model id, effort and alias is checked as one command-line word: letters, digits and `. _ : / @ + = , [ ] -`, at most 200 characters, not starting with `-`. So a model id cannot carry a space, a shell character or an option such as `--dangerously-skip-permissions`. `args` and the words of `flags` and `prompt` may also be options (`-m`, `--no-daemon`) or `--`, and a model or an effort is checked again once it is in its word.
- **A command is a list.** The command for an agent is a list of arguments, never a shell string, and the brief is a placeholder (`{brief}`) that the host fills in. With `positional`, a brief that starts with `-` can be read as an option; Grok's entry puts `--` before it for that reason.

### Flags checked

The herdr fields were checked on 2026-11-21 against the `--help` of the CLIs installed on the maintainer's machine; no agent session was started. The others come from Orca's agent catalogs, which Orca maintains, and are marked as not checked in the file.

| Agent | Version checked | Checked | Not checked |
|---|---|---|---|
| `claude` | Claude Code 2.1.327 | `--model` (aliases `fable`, `opus`, `sonnet`, or a full id), `--effort` with `low`, `medium`, `high`, `xhigh`, `max`, and the brief as a positional argument that starts an interactive session | the `haiku` alias |
| `codex` | codex-cli 0.158.0-alpha.2.1 | `-m`, `-c key=value`, `--no-daemon`, and the brief as a positional argument | the `model_reasoning_effort` key and its values |
| `grok` | grok 1.0.92 | `--model`, `--reasoning-effort` (alias `--effort`), and the brief as a positional argument of the interactive session | the effort values, and `--` before the brief |
| `opencode` | opencode 2.3.2 | `--prompt`; the main interface takes no model (`opencode mini` takes `-m provider/model`) and its positional argument is a directory | |
| `cursor`, `pi`, `antigravity`, `muse`, `kiro`, `gemini` | not installed | | all of their fields |

`agent` is not an alias of Cursor (its newer CLI name) because on some machines it is Grok's program: on the machine above, `agent --version` prints Grok's version. If yours is Cursor's, add `hosts: { herdr: { aliases: { agent: cursor } } }` to your `catalog.yaml`.

## FAQ and limitations

**Does it know how much of my subscription quota is left?** No. T3 Code tracks usage limits per provider, but does not expose them over MCP, and t3-autopilot will not read provider tokens or cookies to find out. Usage only counts when the orchestrator passes `usage` in the call; otherwise every provider is treated as available. What it can know is what the user says: a [subscription profile](#subscription-profiles) with `quota: tight` keeps a provider for what it is for, and `quotaPool` makes a limit on one app count for the others on the same plan.

**Why does the orchestrator have to pass `capabilities`?** An MCP server cannot call T3's tools, and t3-autopilot deliberately does not read T3's files: `settings.json` can hold API keys, and the provider cache is an internal format without sign-in or per-project status ([details](providers.md#local-autodetection-not-implemented)). The orchestrator passes `orchestrator_capabilities` once per thread; the server keeps it.

**A provider released or renamed a model. Do I need to update anything?** Not if the new id still matches its family (see [Model families](#model-families)); pass a fresh `orchestrator_capabilities` output and the new id is used. A new family or naming scheme needs a policy entry. A small model with a new suffix can be taken for the flagship of its family (a hypothetical `gpt-7-io` matches `gpt`); add the suffix to that family's `exclude`.

**Does it guarantee the orchestrator uses the recommendation?** No. The snippet asks for it and authorises switching, but the orchestrator is a language model. `log_delegation` records whether it used the first candidate (`recommendedRank`).

**Why can a warning about omitted models stay after a search?** It goes away once a merged search output lists models for that provider and leaves none out. A search with more than 8 matches is truncated as well, so the warning stays with a narrower search to run. If the search finds nothing for the provider, T3 returns it with no models, which looks the same as a provider the search did not select, so the warning stays too.

**Does it work without T3 Code?** Yes, in [herdr](hosts/herdr.md): the orchestrator passes what herdr's probe finds on `PATH`, t3-autopilot builds the models from its [agent catalog](#agent-catalog), and each candidate comes with the `hc run` command that starts it. Orca is coming.

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
