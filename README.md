# t3-autopilot

**What:** an MCP server that recommends the provider, model and effort for each `delegate_task` in [T3 Code](https://github.com/pingdotgg/t3code).
**For:** T3 Code users who orchestrate agents across several providers and subscriptions. T3 Code only.
**Status:** pre-alpha (0.1.0). Works from source; **not published on npm yet**.

## How it works

T3 Code has no plugin or hook for delegation, so t3-autopilot is a separate stdio MCP server that you add to the CLI of the agent acting as orchestrator (Claude Code, Codex, OpenCode, Grok...). A short instruction in your `CLAUDE.md` / `AGENTS.md` tells the orchestrator to ask it before each `delegate_task`.

1. The orchestrator calls T3's `orchestrator_capabilities` and passes its output to `recommend_model`, together with a one-line description of the task. (An external MCP server cannot call T3's tools itself.)
2. t3-autopilot classifies the task (or takes the `taskType` you pass), looks up the candidates for that task type in the policy, and resolves each **model family** (e.g. `claude-opus`) to the newest matching model id that your T3 setup actually offers. Providers with `canRunChildTask: false` are skipped.
3. It returns 1-3 candidates, best first, each with `providerInstanceId`, `model` and `options` ready to use as `delegate_task.target`, and a `reason`.
4. After reviewing the child's work, the orchestrator calls `log_outcome`. `get_stats` summarises that log so you can tune the policy with your own data.

t3-autopilot only recommends. It never launches agents, never acts as a proxy and never reads provider tokens.

## Install

Requires Node.js 20 or later.

Until the package is on npm, build it from source:

```sh
git clone https://github.com/pablosalme/t3-autopilot.git
cd t3-autopilot
npm install
npm run build
```

Then register it in the orchestrator's CLI, at user scope so every project gets it. Use `node /absolute/path/to/t3-autopilot/dist/cli.js` as the command. Once published, the command will be `npx -y t3-autopilot`, as in the examples below.

**Claude Code**

```sh
claude mcp add --scope user t3-autopilot -- npx -y t3-autopilot
```

**Codex** (`codex mcp add t3-autopilot -- npx -y t3-autopilot`, or in `~/.codex/config.toml`):

```toml
[mcp_servers.t3-autopilot]
command = "npx"
args = ["-y", "t3-autopilot"]
```

**Other CLIs** that read an `mcpServers` JSON block:

```json
{
  "mcpServers": {
    "t3-autopilot": { "command": "npx", "args": ["-y", "t3-autopilot"] }
  }
}
```

Only the orchestrator needs it; child agents do not. After adding it, restart the agent in T3 Code so it picks up the new server.

## Instructions for the orchestrator

T3 Code's built-in orchestration instructions say *"Provider or model unavailable: say so. Never switch unasked"*. The snippet below explicitly authorises the orchestrator to switch provider and model as recommended. Paste it into the orchestrator's `CLAUDE.md` or `AGENTS.md` (`t3-autopilot snippet` prints it):

```markdown
## Model selection for delegated tasks (t3-autopilot)

You are authorized to pick the provider, model and options of every child task you delegate in T3 Code, following the t3-autopilot MCP server. Switching provider or model as recommended by `recommend_model` counts as asked for by the user.

1. Before each `delegate_task`, call `recommend_model` with `task` (one line describing the child's job), `capabilities` (the full JSON output of `orchestrator_capabilities`; one call per thread is enough, call it again after an error) and, if you know them, `taskType`, `size` and `criticality`.
2. Use the first candidate: pass its `providerInstanceId`, `model` and `options` as `delegate_task.target`. If that child cannot start or stops on a usage limit, use the next candidate.
3. If the user names a provider or model for a task, use theirs instead.
4. After you review the child's result, call `log_outcome` with the `taskType` returned by `recommend_model`, the `providerInstanceId` and `model` you used, and `outcome`: `success` (accepted as is), `corrected` (you had to fix or redo part of it) or `failure`; add a short `note`.
```

Whether the orchestrator follows it depends on the model; nothing enforces it.

## Tools

| Tool | Input | Output |
|---|---|---|
| `recommend_model` | `task`, `capabilities`, optional `taskType`, `size` (`small`/`medium`/`large`), `criticality` (`low`/`normal`/`high`), `usage` | `taskType`, how it was classified, `candidates[]` (`providerInstanceId`, `model`, `options`, `reason`), `skipped[]` |
| `log_delegation` | `taskType`, `providerInstanceId`, `model`, optional `options`, `recommendedRank`, `childThreadId`, `summary` | `delegationId`. Optional; useful to track which recommendation rank was followed. |
| `log_outcome` | `outcome` (`success`/`corrected`/`failure`), optional `note`, plus `delegationId` **or** `taskType` + `providerInstanceId` + `model` | the stored record |
| `get_stats` | optional `since` (ISO date), `taskType` | counts and success rate per task type and per model |

Example `recommend_model` result (from `npm run smoke`, with an invented capabilities fixture where the Claude subscription is at 88% of its weekly window):

```json
{
  "taskType": "debug",
  "classification": { "source": "classifier", "reason": "keywords matched: fix, flaky", "matched": ["fix", "flaky"] },
  "candidates": [
    { "providerInstanceId": "codex", "model": "gpt-6.2-codex", "options": [{ "id": "reasoningEffort", "value": "xhigh" }],
      "reason": "debug #2: latest gpt on codex is gpt-6.2-codex, effort xhigh" },
    { "providerInstanceId": "cursor", "model": "claude-opus-7", "options": [{ "id": "effort", "value": "xhigh" }],
      "reason": "debug #3: latest claude-opus on cursor is claude-opus-7, effort xhigh" },
    { "providerInstanceId": "claudeAgent", "model": "claude-opus-7-1", "options": [{ "id": "effort", "value": "xhigh" }],
      "reason": "debug #1: latest claude-opus on claudeAgent is claude-opus-7-1, effort xhigh (weekly usage 88% >= 75%; demoted for usage)" }
  ],
  "skipped": ["antigravity: Provider instance is disabled."],
  "usageSource": "none+call"
}
```

### Task classification

If `taskType` is not given, the task text is matched against each task type's `keywords` (case-insensitive, whole words, each keyword counted once). The type with the most matches wins; ties go to the type listed first in the policy; no match gives `defaultTaskType` (`code`). It is a deliberately simple heuristic: pass `taskType` when you know it.

Default types: `review`, `debug`, `plan`, `research`, `writing`, `design`, `quick`, `code`.

### Effort

Each candidate can set an `effort` on the scale `none < minimal < low < medium < high < xhigh < max`. `size` and `criticality` shift it (by default `small`/`low` -1, `large`/`high` +1). The value is written to whichever effort option the model declares (`effort`, `reasoningEffort`, `reasoning_effort` or `variant`) and clamped to the values it supports. Models without an effort option get none.

### Usage-aware balancing

A candidate whose provider instance is above a threshold (default: session 80%, weekly 75%, monthly 90%) moves after the others; at 100% it goes last. Unknown usage never penalises. Candidates marked `noDemote: true` keep their place below 100%.

T3 Code does not expose usage over MCP today, so in this version percentages only come from the optional `usage` argument of `recommend_model` (same shape as T3's own usage windows: `kind`, `usedPercent`, `resetsAt`, `modelIds`). The `UsageSource` interface is in place for automatic sources; the only built-in one is `none`.

For independent reviews (`avoidInheritedProvider: true` on the `review` type), the orchestrator's own provider is moved down so the review comes from a different one.

## Editing the policy

The default policy is [`policy/default.yaml`](policy/default.yaml). Override it in `~/.t3-autopilot/policy.yaml` (or `$T3_AUTOPILOT_HOME/policy.yaml`); it is re-read on every call, so no restart is needed. `t3-autopilot init-policy` copies the default there; keep only what you change, so future default updates still reach you.

Merge rules: entries under `families` and `taskTypes` override the default entry with the same name as a whole (set one to `null` to remove it); `usage` and `effortShift` merge one level deep; every other key replaces the default.

**Families, not model ids.** A family maps driver kinds (`driverKind` in `orchestrator_capabilities`; `*` for any) to a regular expression over model ids. When several ids match, the highest version wins (numeric capture groups compared in order). When a provider ships `claude-opus-7-2`, it is picked up with no change to code or policy.

```yaml
families:
  kimi:
    match:
      opencode: '^opencode(?:-go)?/kimi-(\d+)(?:\.(\d+))?$'

taskTypes:
  quick:
    keywords: [rename, typo, format, bump]
    candidates:
      - { provider: opencode, family: kimi }
      - { provider: claudeAgent, family: claude-haiku, effort: low }
  writing:
    keywords: [write, draft, post]
    candidates:
      - { provider: claudeAgent, family: claude-opus, effort: high, noDemote: true }

excludeProviders: [cursor]       # never recommend this provider instance
usage:
  thresholds: { weekly: 60 }
```

A candidate names a driver kind (`provider`, matching every enabled instance of it, so two subscriptions of the same provider are both considered) or an exact provider instance (`instance`). Optional `options` (e.g. `{ fastMode: true }`) are set when the model supports them.

The candidate order in the default policy is an unvalidated starting point, not a benchmark result. Use `get_stats` to see what works for you.

## Data

Everything lives in `~/.t3-autopilot/` (or `$T3_AUTOPILOT_HOME`): `policy.yaml` (your override) and `log.jsonl` (delegations and outcomes). The task text passed to `recommend_model` is not stored; `log_delegation` stores a `summary` only if you pass one (cut to 200 characters). Nothing is sent over the network.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
npm run smoke   # starts dist/cli.js over stdio and calls recommend_model with test/fixtures/capabilities.json
```

The capabilities fixture is invented; model ids in it are not real products.

## Roadmap

Not implemented yet:

1. **Usage from T3 Code.** T3 already tracks session/weekly/monthly limits per provider, but only exposes them over its internal, undocumented WebSocket API. A `t3` usage source will follow if T3 exposes usage over MCP ([discussion #15137](https://github.com/pingdotgg/t3code/discussions/15137)); reading the internal API is a possible stopgap.
2. **Third-party usage readers** (local usage aggregators) as additional `UsageSource`s. t3-autopilot will not read provider tokens or cookies itself.
3. **Policy proposals:** compare `orchestrator_capabilities` with the policy (new or retired families) and public leaderboards, and propose a policy diff for you to approve.
4. **Ordering from the log:** reorder candidates per task type by observed success rate once there is enough data.
5. **Publish on npm.**

## License

[MIT](LICENSE)
