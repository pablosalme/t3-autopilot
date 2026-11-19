# t3-autopilot

[![CI](https://github.com/pablosalme/t3-autopilot/actions/workflows/ci.yml/badge.svg)](https://github.com/pablosalme/t3-autopilot/actions/workflows/ci.yml)

**What:** an MCP server that recommends the provider, model and effort for each child task in [T3 Code](https://github.com/pingdotgg/t3code).
**For:** T3 Code users with any mix of providers and subscriptions (Claude, Codex, Cursor, Grok, OpenCode, Antigravity, Kiro, Pi, fx, Muse, ACP agents). T3 Code only.
**Status:** pre-alpha (0.1.0). Works from source; **not published on npm yet**.

## How it works

T3 Code has no plugin or hook for delegation, so t3-autopilot is a separate stdio MCP server that you add to the CLI of the agent acting as orchestrator (Claude Code, Codex, OpenCode, Grok...). A short instruction in your `CLAUDE.md` / `AGENTS.md` tells the orchestrator to ask it before each child task.

1. The orchestrator calls T3's `orchestrator_capabilities` and passes its output to `recommend_model` once per thread (the server keeps the last one in memory), together with a one-line description of the task and its `taskType`. An external MCP server cannot call T3's tools itself.
2. t3-autopilot looks up the candidates for that task type in the policy and resolves each **model family** (e.g. `claude-opus`) to the newest matching model id that your T3 setup actually offers, on whichever provider instances you have.
3. It returns 1-3 candidates, best first, each with `providerInstanceId`, `model` and `options` ready to use as `delegate_task.target`, and a `reason`. Free slots are filled from the policy's fallback list and, if needed, from a generic fallback (see below).
4. The orchestrator logs the delegation and, after reviewing the child's work, its outcome. `get_stats` summarises that log so you can tune the policy with your own data.

t3-autopilot only recommends. It never launches agents, never acts as a proxy and never reads provider tokens or T3's settings files.

## Supported providers and how they are detected

t3-autopilot works with whatever provider instances **you** have configured in T3 Code, in any combination, including several instances of the same driver (e.g. two Claude subscriptions). It knows the eleven drivers T3 ships: `claudeAgent`, `codex`, `cursor`, `grok`, `opencode`, `antigravity`, `kiro`, `pi`, `fx`, `muse` and `acpRegistry`. [docs/providers.md](docs/providers.md) lists, for each one, its model ids, effort option and default model, with references to T3's source.

- **Detection.** The only source is the `orchestrator_capabilities` output: every provider instance in it is considered, and only instances with `canRunChildTask: true` (T3 sets it when the instance is enabled for the project, installed and signed in) are eligible. If none is eligible, `recommend_model` fails with each instance's reason.
- **Families across drivers.** Most families match on any driver (`"*"`), so Claude Opus is found as `claude-opus-5-5` on Claude or Cursor, `claude-opus-5.5` on Kiro, or `anthropic/claude-opus-5-5` and `openrouter/anthropic/claude-opus-4.6` on OpenCode and Pi. Policy rules with `provider: "*"` use whichever instance offers the family.
- **Short model lists.** For Cursor, OpenCode, Pi, Kiro, fx, Antigravity and ACP agents, T3 lists at most 8 models and reports the rest as `omittedModels`. When that happens the result has a `warnings` entry with the `search` to run (e.g. `orchestrator_capabilities` with `search: "cursor opus"`); passing that output with `mergeCapabilities: true` merges it into the kept capabilities, and the warning goes away for the providers the search listed models for (the others keep theirs). Without it, the newest model is chosen among the listed ones only.
- **Generic fallback.** A provider no family covers (an unknown driver, an ACP agent with its own model names) still gets a candidate: its default model (`default`, `auto`, `grok-build`, `antigravity-default`) or, failing that, the first model T3 lists for it. The `reason` says "low confidence".
- **No local autodetection.** t3-autopilot does not read T3's files to find your providers: `settings.json` can hold provider API keys in instance environment variables, and the provider cache is an internal, undocumented format without sign-in or per-project status. Details in [docs/providers.md](docs/providers.md#local-autodetection-not-implemented).

## Install

Requires Node.js 20 or later. The package is **not on npm yet**; install it from source:

```sh
git clone https://github.com/pablosalme/t3-autopilot.git
cd t3-autopilot
npm ci            # also builds dist/ (prepare script)
npm run build     # rebuild after pulling changes
```

Then register it in the orchestrator's CLI, at user scope so every project gets it, using the absolute path to `dist/cli.js` (replace `/path/to/t3-autopilot`):

**Claude Code**

```sh
claude mcp add --scope user t3-autopilot -- node /path/to/t3-autopilot/dist/cli.js
```

**Codex** (`codex mcp add t3-autopilot -- node /path/to/t3-autopilot/dist/cli.js`, or in `~/.codex/config.toml`):

```toml
[mcp_servers.t3-autopilot]
command = "node"
args = ["/path/to/t3-autopilot/dist/cli.js"]
```

**Other CLIs** that read an `mcpServers` JSON block:

```json
{
  "mcpServers": {
    "t3-autopilot": { "command": "node", "args": ["/path/to/t3-autopilot/dist/cli.js"] }
  }
}
```

Only the orchestrator needs it; child agents do not. After adding it, restart the agent in T3 Code so it picks up the new server.

When the package is published on npm, the command will become `npx -y t3-autopilot`. Do not use that command before then: the name is not registered, so it would fail or, if someone else registers it, run their code.

## Instructions for the orchestrator

T3 Code tells orchestrators to use their native subagent tool for children on their own provider, and *"Provider or model unavailable: say so. Never switch unasked"*. The snippet below asks for a recommendation before every child, native ones too, and explicitly authorises the orchestrator to switch provider and model as recommended. Paste it into the orchestrator's `CLAUDE.md` or `AGENTS.md` (`t3-autopilot snippet` prints it):

```markdown
## Model selection for delegated tasks (t3-autopilot)

You are authorized to pick the provider, model and options of every child task in T3 Code following the t3-autopilot MCP server. Switching provider or model as recommended by `recommend_model` counts as asked for by the user.

1. For every child task, including the ones you would start with your native subagent tool, call `recommend_model` first with `task` (one line), `taskType` (always; choose from the types listed in the tool description) and, if you know them, `size` and `criticality`.
2. Pass `capabilities` (the full output of `orchestrator_capabilities`) on the first call of the thread and again after an error or when providers change; the server keeps the last one, so other calls can omit it.
3. Use the first candidate. If it has `sameAsOrchestrator: true`, your native subagent tool is fine; otherwise call `delegate_task` with its `providerInstanceId`, `model` and `options` as `target`. If that child cannot start or stops on a usage limit, use the next candidate.
4. Tell the user in one line which provider and model you picked, and why (the candidate's `reason`).
5. If `recommend_model` returns no candidate or fails, delegate inheriting your own provider and model, and say so.
6. If the result has `warnings` about omitted models, call `orchestrator_capabilities` with the `search` they suggest and pass that output to `recommend_model` as `capabilities` with `mergeCapabilities: true`.
7. If the user names a provider or model for a task, use theirs instead.
8. Right after delegating, call `log_delegation` with the `taskType`, `providerInstanceId`, `model` and `options` you used, `recommendedRank` (1-based rank of the candidate, or null if you chose something else) and `childThreadId`; keep the `delegationId`. After you review the child's result, call `log_outcome` with that `delegationId` and `outcome`: `success` (accepted as is), `corrected` (you had to fix or redo part of it) or `failure`; add a short `note`.
```

Whether the orchestrator follows it depends on the model; nothing enforces it.

## Tools

| Tool | Input | Output |
|---|---|---|
| `recommend_model` | `task`, `taskType` (always pass it), optional `capabilities` (required on the first call), `mergeCapabilities`, `size` (`small`/`medium`/`large`), `criticality` (`low`/`normal`/`high`), `usage` | `taskType`, `classification`, `candidates[]` (`providerInstanceId`, `model`, `options`, `reason`, `source`, `sameAsOrchestrator`), `skipped[]`, `warnings[]`, `capabilitiesFrom` (`call`/`cache`/`merged`) |
| `log_delegation` | `taskType`, `providerInstanceId`, `model`, optional `options`, `recommendedRank` (1-based, or null), `childThreadId`, `summary` | `delegationId` |
| `log_outcome` | `outcome` (`success`/`corrected`/`failure`), optional `note`, plus `delegationId` **or** `taskType` + `providerInstanceId` + `model` | the stored record |
| `get_stats` | optional `since` (ISO date), `taskType` | counts, success rate and pending delegations per task type and per model; how often the first candidate was followed |

`capabilities` accepts the object as T3 returns it, a JSON string, a bare `providers` array, or a list of several outputs (`[full, search1, ...]`), which are merged by `providerInstanceId`. `source` is `taskType`, `fallback`, `generic` (low confidence) or `inherited` (the orchestrator's own model, used only when nothing else resolves).

Example `recommend_model` result (from `npm run smoke`, invented fixture with Kiro as the only provider; model versions are not real):

```json
{
  "taskType": "code",
  "candidates": [
    { "providerInstanceId": "kiro", "model": "claude-opus-9.1", "options": [{ "id": "reasoningEffort", "value": "high" }],
      "reason": "code #3 (any provider): latest claude-opus on kiro is claude-opus-9.1, effort high", "source": "taskType", "sameAsOrchestrator": false },
    { "providerInstanceId": "kiro", "model": "gpt-8.6-sol", "options": [{ "id": "reasoningEffort", "value": "high" }],
      "reason": "code #6 (any provider): latest gpt on kiro is gpt-8.6-sol, effort high", "source": "taskType", "sameAsOrchestrator": false },
    { "providerInstanceId": "kiro", "model": "kimi-k5", "options": [{ "id": "reasoningEffort", "value": "high" }],
      "reason": "code #8 (any provider): latest kimi on kiro is kimi-k5, effort high", "source": "taskType", "sameAsOrchestrator": false }
  ],
  "warnings": [],
  "capabilitiesFrom": "call"
}
```

### Task types

`review`, `debug`, `plan`, `research`, `quick`, `code`, `design`, `writing`; the tool description lists them with one line each. The orchestrator is an LLM and should always pass `taskType`. If it does not, the task text is matched against each type's `keywords` (case-insensitive, whole words; a multi-word phrase scores its number of words) and the highest score wins, ties going to the type listed first; no match gives `defaultTaskType` (`code`). The keywords (English plus a few Spanish ones) are a last resort, not a classifier.

### Effort

Each candidate can set an `effort` on the scale `none < minimal < low < medium < high < xhigh < max`. `size` and `criticality` shift it (by default `small`/`low` -1, `large`/`high` +1). The value is written to the first effort option the model declares (`effort`, `reasoningEffort`, `reasoning_effort`, `variant`, `thinking`, `reasoning`, `thought_level`, or an ACP option whose id looks like one) and clamped to the values it supports; a boolean `thinking` toggle is never used for effort. Models without an effort option get none. Fallback candidates use the task type's effort, so a quick task does not get a fallback model at high effort.

### Usage-aware balancing

A candidate whose provider instance is above a threshold (default: session 80%, weekly 75%, monthly 90%) moves after the others; at 100% it goes last. Unknown usage never penalises, and a usage window with an unknown `kind` or a percentage outside 0-100 is ignored. Candidates marked `noDemote: true` keep their place below 100%.

T3 Code does not expose usage over MCP today, so in this version percentages only come from the optional `usage` argument of `recommend_model` (same shape as T3's own usage windows: `kind`, `usedPercent`, `resetsAt`, `modelIds`). The `UsageSource` interface is in place for automatic sources; the only built-in one is `none`.

For independent reviews (`avoidInheritedProvider: true` on the `review` type), the orchestrator's own provider is moved down so the review comes from a different one.

## Editing the policy

The default policy is [`policy/default.yaml`](policy/default.yaml). Override it in `~/.t3-autopilot/policy.yaml` (or `$T3_AUTOPILOT_HOME/policy.yaml`); it is re-read on every call, so no restart is needed. `t3-autopilot init-policy` writes a short commented template there; uncomment only what you change, so future default updates still reach you.

Merge rules: entries under `families` and `taskTypes` override the default entry with the same name as a whole (set one to `null` to remove it); `usage` and `effortShift` merge one level deep; every other key replaces the default. Errors name the file and the entry at fault.

**Families, not model ids.** A family maps driver kinds (`driverKind` in `orchestrator_capabilities`; `*` for any driver without its own entry) to a case-insensitive regular expression over model ids, plus an optional `exclude` regex and a `search` hint. When several ids match, the highest version wins (numeric capture groups compared in order; numbers of 5+ digits are snapshot dates and are ignored). When a provider ships `claude-opus-7-2`, it is picked up with no change to code or policy.

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
genericFallback: false           # never recommend a provider's default model with low confidence
usage:
  thresholds: { weekly: 60 }
```

A candidate names a driver kind (`provider`, matching every eligible instance of it, so two subscriptions of the same provider are both considered), `"*"` (any eligible instance, in the order T3 lists them) or an exact provider instance (`instance`). Optional `options` (e.g. `{ fastMode: true }`, strings or booleans) are set when the model supports them.

The candidate order in the default policy is an unvalidated starting point, not a benchmark result. `claude-fable` is placed second for `writing`, `design` and `plan` because T3 gives it a fixed 1M-token context; that placement is a guess too. Use `get_stats` to see what works for you.

## Data

Everything lives in `~/.t3-autopilot/` (or `$T3_AUTOPILOT_HOME`): `policy.yaml` (your override) and `log.jsonl` (delegations and outcomes). The task text passed to `recommend_model` is not stored; `log_delegation` stores a `summary` and `log_outcome` a `note` only if you pass them (cut to 200 characters). The capabilities are kept in memory only. Nothing is sent over the network.

## Development

```sh
npm ci
npm run typecheck
npm test          # needs Node 22.12+ (Vitest 5)
npm run build
npm run smoke     # starts dist/cli.js over stdio and calls recommend_model with several fixtures
```

CI (GitHub Actions) runs typecheck, build and the smoke test on Node 20 and 22 on Linux, macOS and Windows, and the tests on Node 22. Capabilities fixtures in `test/fixtures` are invented; model versions in them are not real products.

## Roadmap

Not implemented yet:

1. **Usage from T3 Code.** T3 already tracks session/weekly/monthly limits per provider, but only exposes them over its internal, undocumented WebSocket API. A `t3` usage source will follow if T3 exposes usage over MCP ([discussion #15137](https://github.com/pingdotgg/t3code/discussions/15137)); reading the internal API is a possible stopgap.
2. **Third-party usage readers** (local usage aggregators) as additional `UsageSource`s. t3-autopilot will not read provider tokens or cookies itself.
3. **Policy proposals:** compare `orchestrator_capabilities` with the policy (new or retired families) and public leaderboards, and propose a policy diff for you to approve.
4. **Ordering from the log:** reorder candidates per task type by observed success rate once there is enough data.
5. **Publish on npm.**

## License

[MIT](LICENSE)
