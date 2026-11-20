# Using t3-autopilot in Orca

[Orca](https://github.com/stablyai/orca) runs several coding agents (Claude, Codex, Cursor, Grok, OpenCode...) side by side and starts them from its CLI. t3-autopilot can pick the agent, model and effort for each child agent an Orca orchestrator starts, the same way it does for T3 Code.

## What is different from T3 Code

| | T3 Code | Orca |
|---|---|---|
| What the orchestrator passes as `capabilities` | `orchestrator_capabilities` output | `orca agent installed --json` output, plus `orchestrator` |
| Where models come from | T3 lists them | `~/.t3-autopilot/orca-models.yaml`, or `models` in the call |
| How the child starts | `delegate_task` | the candidate's `orca.command` (`orca agent launch ...`) |

`orca agent installed --json` lists the agents that can start, but not their models. Without declared models each agent can still be recommended, with its CLI's default model (`model: "default"`, launched without `--model`) and low confidence; declare models to get the policy's families (newest Claude Opus for code, GPT on Codex for reviews, and so on).

## Setup

1. Add the server to the orchestrator agent, as in the README (Step 1).
2. Add the Orca instructions to its rules file:

   ```sh
   npx -y t3-autopilot snippet --host orca >> ~/.claude/CLAUDE.md
   ```

3. Optionally, list your models in `~/.t3-autopilot/orca-models.yaml`, best known first. Keys are Orca agent ids (`orca agent installed --json`); entries are model ids the agent's CLI accepts with `--model`, or `{ id, efforts }` to set the `--effort` levels it takes:

   ```yaml
   claude: [claude-opus-9-2, claude-sonnet-9-1, claude-haiku-9-1]
   codex:
     - { id: gpt-9.1-codex, efforts: [low, medium, high, xhigh] }
     - gpt-9.1-codex-mini
   ```

   Without `efforts`, `claude` takes `low` to `max`, `codex` `minimal` to `xhigh` and `pi` `off` to `max`; other agents get no `--effort`. The file is read on every call that passes `capabilities`.

## What the orchestrator sends

```json
{
  "task": "Review the PR that moves auth checks",
  "taskType": "review",
  "capabilities": {
    "result": { "agents": [{ "id": "claude" }, { "id": "codex" }] },
    "orchestrator": { "agent": "claude", "model": "claude-opus-9-2" }
  }
}
```

The raw output of `orca agent installed --json` can be passed as is, with `orchestrator` (and optionally `models`) added next to `result`; `{ "agents": [...] }` works too. `orchestrator` lets t3-autopilot mark `sameAsOrchestrator` and send reviews to another provider.

Each candidate then carries:

```json
"orca": {
  "agent": "codex",
  "model": "gpt-9.1-codex",
  "effort": "high",
  "command": "orca agent launch --agent codex --model gpt-9.1-codex --effort high --prompt \"<task brief>\" --json"
}
```

Agent ids map to T3 drivers for the family patterns: `claude` is `claudeAgent`; `codex`, `cursor`, `grok`, `opencode`, `pi` and `kiro` keep their name. Any other agent (Goose, Hermes...) is reached by families with a `"*"` pattern or by the generic fallback. Everything else (policy, subscriptions, `mark_unavailable`, the log) works as in T3 Code, with the Orca agent id as `providerInstanceId`.
