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

   For Codex, Grok CLI or OpenCode, append it to `~/.codex/AGENTS.md`, `~/.grok/AGENTS.md` or `~/.config/opencode/AGENTS.md`. On Windows, copy and paste instead. The text is at the [end of this page](#the-instructions). If the same rules file is also read in T3 Code, use `snippet --host all` instead: it holds both hosts' instructions, and first tells your agent how to find where it runs.

3. **Start the orchestrator in herdr,** in a terminal of the herdr app, or with `hc run --bg --name lead claude` and then `hc attach lead`.

## How it works

1. **The orchestrator looks for the agent CLIs.** herdr knows nothing about agents or models, so on its first call the orchestrator runs

   ```sh
   sh -c 'for a in claude codex cursor-agent grok opencode opencode2 pi agy muse kiro-cli gemini; do command -v "$a"; done; true'
   ```

   which prints the path of each one installed, and passes that output to `recommend_model` as `capabilities`, with `host: "herdr"`, its `session` (its terminal id, the value of `$HC_TERMINAL_ID`, such as `t2`) and, as `orchestrator`, its own agent and model.

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

4. **The orchestrator starts the child.** It writes the brief to a file with its file tool, ending it with "Report with hc send t2 when done or stuck.": its own terminal id written out, never `$HC_TERMINAL_ID`, because the child runs that line in its own shell, where the variable is the child's id. Then it runs `launch.argv` as one shell command, each element in single quotes, with `{name}` replaced by a name for the child, `{cwd}` by its folder and `{brief}` by `"$(cat '<file>')"`, outside single quotes, in bash, zsh or another POSIX shell (PowerShell would pass the file's lines joined by spaces, and cmd.exe the text `$(cat …)` itself):

   ```sh
   'hc' 'run' '--bg' '--name' 'fix-login' '--cwd' '/src/app' 'claude' '--model' 'opus' '--effort' 'high' "$(cat '/tmp/fix-login.md')"
   ```

   The name follows hc's rule for names: 1 to 32 of `a-z`, `0-9`, `-`, `_` and `.`, starting with a letter or digit, and not shaped like a terminal id (`t7`, `t1b`). An agent that does not take the brief when it starts (Pi, Kiro, Muse, or one t3-autopilot does not know) comes with `launch.then`: `hc wait {name}` and then `hc send {name} {brief}`, run the same way.

5. **The child reports back** with `hc send`, and herdr tells the orchestrator when a child is blocked or exits. When it is blocked, the orchestrator reads its screen (`hc read fix-login`) and answers with `hc keys`: in a folder it has not seen, Claude Code first asks whether to trust it. The orchestrator then logs how it went (`log_delegation`, `log_outcome`) and, if the child could not start because of a usage limit, marks it with `mark_unavailable` and uses the next candidate.

Later calls can leave `capabilities` out: the server keeps the list per session (and on disk, for a restart), and builds it again on each call with the agent catalog in force, so an edit to `catalog.yaml` applies on the next call. Run the probe again when you install or remove an agent.

### `launch`

| Field | What it is |
|---|---|
| `mode` | `supervised`: the child reports back to the orchestrator. |
| `agent` | The agent, as in `providerInstanceId`. |
| `model` | The model passed to the CLI. Absent for `default`: the CLI uses the model set in its own configuration. |
| `effort` | The effort passed to the CLI. Absent when the model takes none. |
| `args` | The program and its flags for model and effort, without the brief: what to use with another launch command (an `hc` template's `command`, for example). |
| `argv` | The command, one element per argument. `{name}`, `{cwd}` and `{brief}` are whole elements to replace. The orchestrator runs it as one shell command, each element in single quotes and `{brief}` as `"$(cat '<file>')"` (see step 4 above). |
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

- **Never a shell string from t3-autopilot.** `launch.argv` is a list, one element per argument. An orchestrator's shell tool takes a command line, so the instructions have it write each element in single quotes, which keep every character as it is; the elements t3-autopilot makes never hold a `'`.
- **The brief goes in a file.** The orchestrator writes it with its file tool and passes it as `"$(cat '<file>')"`: in a POSIX shell, the output of a command substitution in double quotes is one argument and is not expanded again, so a `$()`, a backquote or a quote in the brief never runs. The file's path and `{cwd}` go in single quotes, with a `'` in them written as `'\''`. A test runs this recipe through `sh` with all of these in the brief, the folder and the file name, and checks what `hc` receives.
- **The report goes to the orchestrator.** The brief names the orchestrator's terminal id written out (`hc send t2`), never `$HC_TERMINAL_ID`: the child runs that command in its own shell, where the variable is the child's own id, so the report would go to the child itself.
- **Every word is checked.** Model ids, efforts and program names must be one word of letters, digits and `. _ : / @ + = , [ ] -`, not starting with `-`, so a model id cannot carry a space, a shell character or an option such as `--dangerously-skip-permissions`. A candidate with one that is not is left out.
- **`hc` itself.** `hc run` treats everything after the program as the program's own arguments, and sends a single argument with spaces or shell characters to the shell as a line; the recipe never produces one. Its own flags (`--bg`, `--name`, `--cwd`) come before the program.

## Limitations

- **Windows** is not covered: `"$(cat '<file>')"` needs a POSIX shell, and herdr's terminals there run PowerShell, which would pass the brief's lines joined by spaces (cmd.exe would pass the text `$(cat …)` itself). The instructions say to use a POSIX shell (step 3), and on Windows the result's `notes` say it in the same words.
- **The older `herdr` multiplexer** is not covered (see the top of this page), nor other machines (`hc run --on`).
- **A template named like a program wins.** `hc run` looks up `~/.config/herdr-core/templates/<name>.md` before running a program of that name, so a template called `claude` replaces Claude Code in the recipe, and the arguments after it change meaning: hc starts the template's own `command` (with the model written there), takes any of its own flags among them (`--name`, `--cwd`, `--timeout`, `--rm`...) as flags of `hc run`, and sends the rest, `--model`, `--effort` and the brief included, as plain text in the template's first message. Give such a template another name; to start a candidate through a template on purpose, put `launch.args` in its `command`.
- **Claude Code asks whether to trust a folder it has not seen.** A child started there stops at that question before it reads its brief, and herdr reports it blocked. The orchestrator reads its screen with `hc read` and answers with `hc keys`, as the instructions say: Claude Code 2.1.330 offers "No, exit" first, so `hc keys <name> down enter` picks "Yes, I trust this folder" (`enter` alone would end the child). It asks the user about any other question. Codex and Cursor Agent ask something similar the first time they run in a folder.
- **An `exe` set in `catalog.yaml` is not probed.** The probe looks for the built-in program names only, so it can never find a program you renamed or a wrapper. When it finds an agent whose `exe` your `catalog.yaml` changes (for example `claude` with `exe: claude-work`), the candidate runs your `exe`, unchecked: if it is not installed, `hc run` fails with `spawn_failed`, and the orchestrator moves on to the next candidate.
- **Usage limits are not reported by herdr.** It only passes on what an agent reports. Signs that a child hit a limit: it exits at once, herdr tells the orchestrator it hit an error, or `hc read` shows a limit message. Then call `mark_unavailable`.
- **Waiting for an agent that reports no status.** `hc wait` waits until the agent says it stopped working; one that never reports status is waited on until it exits, with a check-in every 180 seconds.

## Checked against

The recipe follows herdr-core's own manual (`hc --skill`) and command line, read in its source at commit `c751780` (version 0.1.21): `hc run` with `--bg`, `--name`, `--cwd` and the program's arguments after it, the task as the program's last argument, and `hc wait` plus `hc send` for an agent started without one.

On 2026-11-21, `hc` 0.1.21, built from that commit, was run for real on macOS, with a core of its own (its own `HC_SESSION`, state folder and socket): the probe, `recommend_model` with its output, `hc run` with the command from `launch` (Claude Code 2.1.327 with `--model haiku`, which started Haiku), the child's report back with `hc send`, a child that could not start (an `exe` in `catalog.yaml` naming a program that does not exist: `spawn_failed`, `mark_unavailable`, then the next candidate), and herdr's marks staying out of T3 Code's results. That run found that a brief naming `$HC_TERMINAL_ID` sends the report to the child itself, and Claude Code's question about trusting a new folder; both are handled above.

The instructions as they are now were then run the same way, with Claude Code 2.1.330: the orchestrator's terminal (`t1`) ran the shell command they describe, with a space, single quotes and `$HOME` in the brief file's path and a single quote in the folder's. `hc get` showed the brief as one argument, word for word; Claude Code asked whether to trust the new folder, with "No, exit" selected, and hc reported the child blocked until `hc keys probe down enter`; then Haiku ran `hc send t1 "OK"`, and the report reached the orchestrator's terminal. A brief holding `$HOME`, backquotes and `$(...)` reached a plain program through `hc run` as one argument, unchanged. No other agent was run in `hc`.

## The instructions

`npx -y t3-autopilot snippet --host herdr` prints:

```markdown
## Model selection for delegated tasks in herdr (t3-autopilot)

You are authorized to pick the agent, model and effort of every child you start in herdr following the t3-autopilot MCP server. Switching agent or model as recommended by `recommend_model` counts as asked for by the user, and these steps take precedence over the `hc` skill where they differ.

1. Before every child, call `recommend_model` with `host: "herdr"`, `session` (your terminal id: the value of `$HC_TERMINAL_ID`, such as `t2`, which `printenv HC_TERMINAL_ID` prints), `task` (one line), `taskType` (always; choose from the types listed in the tool description) and, if you know them, `size` and `criticality`.
2. On the first call, and again after an error or when agents change, pass as `capabilities` the output of `sh -c 'for a in claude codex cursor-agent grok opencode opencode2 pi agy muse kiro-cli gemini; do command -v "$a"; done; true'`, exactly as printed, and as `orchestrator` your own `agent` (`claude`, `codex`, ...) and `model`. If a call fails with "No herdr catalog yet", run it again and pass its output.
3. Use the first candidate. Write its brief to a file with your file tool (never `echo` or a heredoc), starting with a word and ending with "Report with hc send <id> when done or stuck.", where `<id>` is your terminal id written out (`t2`), never `$HC_TERMINAL_ID`: the child runs that line in its own shell, where the variable is the child's own id. Run its `launch.argv` as one shell command, each element in single quotes, with `{name}` replaced by a name for the child (1 to 32 of a-z, 0-9, `-`, `_` and `.`, starting with a letter or digit, not shaped like an id such as `t7`: `fix-login`, say), `{cwd}` by its working folder (an absolute path), and `{brief}`, without single quotes, by `"$(cat '<file>')"`, which passes the file's text as one argument and runs nothing in it. A `'` in a path is written `'\''` inside single quotes. For example: `'hc' 'run' '--bg' '--name' 'fix-login' '--cwd' '/src/app' 'claude' '--model' 'opus' "$(cat '/tmp/fix-login.md')"`. Then run each command of `launch.then`, if there is one, the same way. Run these commands in bash, zsh or another POSIX shell: in PowerShell or cmd.exe, `"$(cat '<file>')"` does not pass the brief file's text as it is. If it has `sameAsOrchestrator: true`, your native subagent tool works too.
4. If hc reports the child blocked, read its screen with `hc read <name>` and answer it with `hc keys <name>` and the keys it needs. In a folder it has not seen, Claude Code first asks whether to trust it, with "No, exit" selected: `hc keys <name> down enter` picks "Yes, I trust this folder", which you may do for a folder you chose. Ask the user about anything else, such as a permission request.
5. If the child cannot start, or stops at once, because of a usage limit or its plan, call `mark_unavailable` with `host: "herdr"`, its `providerInstanceId`, its `model` (omit it if the whole agent is out), a short `reason` and `until` if you know when the limit resets; then use the next candidate.
6. Tell the user in one line which agent and model you picked, and why (the candidate's `reason`).
7. If `recommend_model` returns no candidate or fails, start the child on your own agent and model, and say so. If the user names an agent or model for a task, use theirs instead.
8. Right after starting the child, call `log_delegation` with `host: "herdr"`, the `taskType`, `providerInstanceId`, `model` and `options` you used, `recommendedRank` (1-based rank of the candidate, or null if you chose something else) and `childThreadId` (the name you gave the child, such as `fix-login`); keep the `delegationId`. After you review its result, call `log_outcome` with that `delegationId`, `outcome` (`success`, `corrected` or `failure`) and a short `note`.
9. If the result has `setupNeeded`, ask the user its questions for every agent listed, all at once, without holding up the current task, and save each answer with `set_subscription` (`host: "herdr"`). If a warning says an agent has no models declared, tell the user once where to list them; if one says a candidate costs extra or is outside its subscription profile, ask the user before starting it.
```
