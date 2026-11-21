# t3-autopilot in herdr

[herdr](https://herdr.dev) runs coding agents in terminals that stay alive, and lets one agent start others and hear back from them. t3-autopilot tells that agent, the orchestrator, which agent CLI, model and effort to use for each child, and gives it the command that starts the child.

This page is about **herdr-core**, whose command line is `hc` (the herdr desktop app runs on it too). The older `herdr` terminal multiplexer (`herdr agent start …`) is not covered yet: its children start in a pane with `--kind`, another recipe. Inside a terminal of `hc`, the variable `HC_TERMINAL_ID` is set.

## What you need

- `hc` (herdr-core, or the herdr app), with your agents running in its terminals.
- At least one agent CLI that t3-autopilot knows: Claude Code (`claude`), Codex (`codex`), Cursor Agent (`cursor-agent`), Grok (`grok`), OpenCode (`opencode`), Pi (`pi`), Antigravity (`agy`), Muse (`muse`), Kiro (`kiro-cli`) or Gemini CLI (`gemini`). Others work with less precision (see [Agents t3-autopilot does not know](#agents-t3-autopilot-does-not-know)).
- [Node.js](https://nodejs.org) 22 or later.

T3 Code is not needed.

## Install

1. **Add t3-autopilot to the agent you use as the orchestrator,** with the same command as in T3 Code, for example for Claude Code:

   ```sh
   claude mcp add --scope user t3-autopilot -- npx -y t3-autopilot
   ```

   The other agents' commands are in the [README](../../README.md#step-1-add-it-to-your-agent).

2. **Add herdr's instructions to its rules file:**

   ```sh
   npx -y t3-autopilot snippet --host herdr >> ~/.claude/CLAUDE.md
   ```

   For Codex, Grok CLI or OpenCode, append it to `~/.codex/AGENTS.md`, `~/.grok/AGENTS.md` or `~/.config/opencode/AGENTS.md`. On Windows, copy and paste instead. The text is at the [end of this page](#the-instructions).

3. **Start the orchestrator in herdr,** in a terminal of the herdr app, or with `hc run --bg --name lead claude` and then `hc attach lead`.

## How it works

1. **The orchestrator looks for the agent CLIs.** herdr knows nothing about agents or models, so on its first call the orchestrator runs

   ```sh
   sh -c 'for a in claude codex cursor-agent grok opencode opencode2 pi agy muse kiro-cli gemini; do command -v "$a"; done; true'
   ```

   which prints the path of each one installed, and passes that output to `recommend_model` as `capabilities`, with `host: "herdr"`, its `session` (`$HC_TERMINAL_ID`) and, as `orchestrator`, its own agent and model.

2. **t3-autopilot builds the list of agents** from the programs found: `cursor-agent` is Cursor, `agy` Antigravity, `kiro-cli` Kiro, and `opencode2` OpenCode. The models and efforts of each come from t3-autopilot's [agent catalog](../reference.md#agent-catalog): aliases that do not go stale, such as Claude Code's `opus` and `sonnet`, or `default` for the model set in the CLI's own configuration (Codex, Grok). Your additions go in `catalog.yaml` in the data directory (`~/.t3-autopilot`).

3. **It recommends, as in T3 Code,** with the same policy, subscription profiles and marks: up to three candidates, best first, each with its reason. In herdr the result also says `"host": "herdr"`, and each candidate has `launch`, the command that starts it:

   ```json
   {
     "providerInstanceId": "claude",
     "model": "opus",
     "options": [{ "id": "effort", "value": "high" }],
     "reason": "code #1: latest claude-opus on claude is opus, effort high",
     "source": "taskType",
     "sameAsOrchestrator": true,
     "launch": {
       "mode": "supervised",
       "agent": "claude",
       "model": "opus",
       "effort": "high",
       "args": ["claude", "--model", "opus", "--effort", "high"],
       "argv": ["hc", "run", "--bg", "--name", "{name}", "--cwd", "{cwd}",
                "claude", "--model", "opus", "--effort", "high", "{brief}"]
     }
   }
   ```

4. **The orchestrator starts the child.** It writes the brief to a file, ending it with "Report with hc send $HC_TERMINAL_ID when done or stuck.", and runs `launch.argv` one element per argument, with `{name}` replaced by a name for the child, `{cwd}` by its folder and `{brief}` by `"$(cat <file>)"`. An agent that does not take the brief when it starts (Kiro, Muse, or one t3-autopilot does not know) comes with `launch.then`: `hc wait {name}` and then `hc send {name} {brief}`, run the same way.

5. **The child reports back** with `hc send`, and herdr tells the orchestrator when a child is blocked or exits. The orchestrator then logs how it went (`log_delegation`, `log_outcome`) and, if the child could not start because of a usage limit, marks it with `mark_unavailable` and uses the next candidate.

Later calls can leave `capabilities` out: the server keeps the list per session (and on disk, for a restart), and builds it again on each call with the agent catalog in force, so an edit to `catalog.yaml` applies on the next call. Run the probe again when you install or remove an agent.

### `launch`

| Field | What it is |
|---|---|
| `mode` | `supervised`: the child reports back to the orchestrator. |
| `agent` | The agent, as in `providerInstanceId`. |
| `model` | The model passed to the CLI. Absent for `default`: the CLI uses the model set in its own configuration. |
| `effort` | The effort passed to the CLI. Absent when the model takes none. |
| `args` | The program and its flags for model and effort, without the brief: what to use with another launch command (an `hc` template's `command`, for example). |
| `argv` | The command, one element per argument. `{name}`, `{cwd}` and `{brief}` are whole elements to replace. |
| `then` | Commands to run next, the same way, for an agent that gets the brief once it is ready. |
| `notes` | Anything the orchestrator should know: an option the CLI takes no flag for, Windows. |

A candidate whose command cannot be built (a model for an agent whose catalog entry has no flag for it, say) is left out, and `skipped` says why.

### Without the probe

To skip the probe, list your agents in `catalog.yaml`:

```yaml
hosts:
  herdr:
    agents: [claude, codex, cursor-agent]
```

When a call brings no `capabilities` and the server keeps none for the session, it uses that list (the result says `capabilitiesFrom: "catalog"`). It is read again on every call and never kept. An agent on the list that is not installed fails to start, so the probe is the safer option.

## Models

| Agent | Models the catalog offers | What to add |
|---|---|---|
| Claude Code | `opus`, `sonnet`, `haiku`, `fable` | A versioned id (`claude-opus-9-2`) wins over its alias. |
| Codex | `default` (the model set in Codex, always a GPT) | Your model ids, to pick one per task. |
| Grok | `default` (its coding model) | |
| Cursor Agent | `auto` | Cursor's ids, which carry the effort (`gpt-9.3-codex-high`). |
| OpenCode, Pi, Antigravity, Muse, Kiro, Gemini CLI | `default` only | The ids you use. OpenCode and Pi take `provider/model` ids. OpenCode's main interface takes no model at start: add `args: [mini]` and `flags: { model: [-m, "{model}"] }` to use `opencode mini`. |

An agent with only `default` is reached by the generic fallback, with low confidence, and a warning says where to list its models. For example:

```yaml
agents:
  pi:
    models: [openai/gpt-9.1-sol, anthropic/claude-opus-9-2]
  codex:
    models: [gpt-9.2-codex, { id: default, family: gpt }]
```

The [agent catalog](../reference.md#agent-catalog) section of the reference has every key, and which CLI flags were checked against which version.

### Agents t3-autopilot does not know

A program that is not in the catalog (`goose`, passed in a list of names, or listed under `hosts.herdr.agents`) is offered with its default model only, by the generic fallback: it starts with no flags and gets the brief once it is ready. To do better, describe it in `catalog.yaml` with its `exe`, `models`, `flags` and `prompt`.

## What is kept, and where

herdr's marks, subscription profiles and log records are kept in the same files as T3 Code's, under the prefix `herdr:` (`herdr:codex`), so a usage limit reached in herdr never demotes Codex in T3 Code, and the other way round. To say that two of them share one plan, give both profiles the same `quotaPool`. Its capabilities are kept per session in `capabilities-cache.herdr.json`. Tools take and return ids without the prefix when the call says `host: "herdr"`.

## Safety

- **Never a shell string.** `launch.argv` is a list, one element per argument, and the orchestrator passes each element as one argument.
- **The brief goes in a file.** The orchestrator writes it with its file tool and passes it as `"$(cat <file>)"`: in a POSIX shell, the output of a command substitution in double quotes is not expanded again, so a `$()` or a backquote in the brief never runs.
- **Every word is checked.** Model ids, efforts and program names must be one word of letters, digits and `. _ : / @ + = , [ ] -`, not starting with `-`, so a model id cannot carry a space, a shell character or an option such as `--dangerously-skip-permissions`. A candidate with one that is not is left out.
- **`hc` itself.** `hc run` treats everything after the program as the program's own arguments, and sends a single argument with spaces or shell characters to the shell as a line; the recipe never produces one. Its own flags (`--bg`, `--name`, `--cwd`) come before the program.

## Limitations

- **Windows** is not covered: `"$(cat <file>)"` needs a POSIX shell. The result says so in `notes`.
- **The older `herdr` multiplexer** is not covered (see the top of this page), nor other machines (`hc run --on`).
- **A template named like a program wins.** `hc run` looks up `~/.config/herdr-core/templates/<name>.md` before running a program of that name, so a template called `claude` replaces Claude Code in the recipe.
- **Usage limits are not reported by herdr.** It only passes on what an agent reports. Signs that a child hit a limit: it exits at once, herdr tells the orchestrator it hit an error, or `hc read` shows a limit message. Then call `mark_unavailable`.
- **Waiting for an agent that reports no status.** `hc wait` waits until the agent says it stopped working; one that never reports status is waited on until it exits, with a check-in every 180 seconds.

## Checked against

The recipe follows herdr-core's own manual (`hc --skill`) and command line, read in its source at commit `c751780` (version 0.1.21): `hc run` with `--bg`, `--name`, `--cwd` and the program's arguments after it, the task as the program's last argument, and `hc wait` plus `hc send` for an agent started without one. `hc` was not run: it was not installed on the machine where this was written, which had only the `herdr` multiplexer (0.9.4).

## The instructions

`npx -y t3-autopilot snippet --host herdr` prints:

```markdown
## Model selection for delegated tasks in herdr (t3-autopilot)

You are authorized to pick the agent, model and effort of every child you start in herdr following the t3-autopilot MCP server. Switching agent or model as recommended by `recommend_model` counts as asked for by the user, and these steps take precedence over the `hc` skill where they differ.

1. Before every child, call `recommend_model` with `host: "herdr"`, `session` (your `$HC_TERMINAL_ID`), `task` (one line), `taskType` (always; choose from the types listed in the tool description) and, if you know them, `size` and `criticality`.
2. On the first call, and again after an error or when agents change, pass as `capabilities` the output of `sh -c 'for a in claude codex cursor-agent grok opencode opencode2 pi agy muse kiro-cli gemini; do command -v "$a"; done; true'`, exactly as printed, and as `orchestrator` your own `agent` (`claude`, `codex`, ...) and `model`. If a call fails with "No herdr catalog yet", run it again and pass its output.
3. Use the first candidate. Write its brief to a file with your file tool (never `echo` or a heredoc), starting with a word and ending with "Report with hc send $HC_TERMINAL_ID when done or stuck." Run its `launch.argv`, one element per argument, with `{name}` replaced by a short name for the child (a-z, 0-9, -), `{cwd}` by its working folder and `{brief}` by `"$(cat <file>)"`; then run each command of `launch.then`, if there is one, the same way. If it has `sameAsOrchestrator: true`, your native subagent tool works too.
4. If the child cannot start, or stops at once, because of a usage limit or its plan, call `mark_unavailable` with `host: "herdr"`, its `providerInstanceId`, its `model` (omit it if the whole agent is out), a short `reason` and `until` if you know when the limit resets; then use the next candidate.
5. Tell the user in one line which agent and model you picked, and why (the candidate's `reason`).
6. If `recommend_model` returns no candidate or fails, start the child on your own agent and model, and say so. If the user names an agent or model for a task, use theirs instead.
7. Right after starting the child, call `log_delegation` with `host: "herdr"`, the `taskType`, `providerInstanceId`, `model` and `options` you used, `recommendedRank` (1-based rank of the candidate, or null if you chose something else) and `childThreadId` (the child's address, such as `t7`); keep the `delegationId`. After you review its result, call `log_outcome` with that `delegationId`, `outcome` (`success`, `corrected` or `failure`) and a short `note`.
8. If the result has `setupNeeded`, ask the user its questions for every agent listed, all at once, without holding up the current task, and save each answer with `set_subscription` (`host: "herdr"`). If a warning says an agent has no models declared, tell the user once where to list them; if one says a candidate costs extra or is outside its subscription profile, ask the user before starting it.
```
