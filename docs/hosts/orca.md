# t3-autopilot in Orca

[Orca](https://orca.dev) is an IDE that runs coding agents side by side, each in its own workspace, and lets one agent start others as supervised workers and hear back from them. t3-autopilot tells that agent, the orchestrator (Orca calls it the coordinator), which agent CLI, model and effort to use for each worker, and gives it the `orca orchestration worker-start` command that starts the worker.

Orca's terminals and chats set `ORCA_TERMINAL_HANDLE` (a terminal) or `ORCA_AGENT_SESSION_ID` (a chat), which is how an orchestrator knows it runs there.

## What you need

- Orca, with the orchestrator running in one of its terminals or chats. Its orchestration commands (`orca orchestration …`) are marked Experimental in Orca.
- At least one agent CLI turned on in Orca's Settings → Agents. t3-autopilot knows Claude Code, Codex, Cursor Agent, Grok, OpenCode, Pi, Antigravity, Muse, Kiro and Gemini CLI; others work with less precision (see [Agents t3-autopilot does not know](#agents-t3-autopilot-does-not-know)).
- [Node.js](https://nodejs.org) 22 or later.

T3 Code is not needed.

## Install

1. **Add t3-autopilot to the agent you use as the orchestrator,** with the same command as in T3 Code, for example for Claude Code:

   ```sh
   claude mcp add --scope user t3-autopilot -- npx -y t3-autopilot
   ```

   The other agents' commands are in the [README](../../README.md#step-1-add-it-to-your-agent).

2. **Add Orca's instructions to its rules file:**

   ```sh
   npx -y t3-autopilot snippet --host orca >> ~/.claude/CLAUDE.md
   ```

   For Codex, Grok CLI or OpenCode, append it to `~/.codex/AGENTS.md`, `~/.grok/AGENTS.md` or `~/.config/opencode/AGENTS.md`. On Windows, copy and paste instead. The text is at the [end of this page](#the-instructions). If the same rules file is also read in T3 Code or herdr, use `snippet --host all` instead: it holds every host's instructions, and first tells your agent how to find where it runs.

3. **Start the orchestrator in Orca,** in a terminal or a chat of the workspace you work in (restart it if it was running, so it loads t3-autopilot).

## How it works

1. **The orchestrator lists Orca's agents.** Orca knows which agent CLIs are installed and turned on, but not their models, so on its first call the orchestrator runs

   ```sh
   orca agent installed --environment local --json
   ```

   with Orca's command in place of `orca` (see [Orca's command](#orcas-command)), and passes the output to `recommend_model` as `capabilities`, exactly as printed, with `host: "orca"`, its `session` (the value of `$ORCA_TERMINAL_HANDLE`, or of `$ORCA_AGENT_SESSION_ID` in a chat) and, as `orchestrator`, its own Orca agent id and model. The output looks like this (Orca 1.4.269 on macOS):

   ```json
   {
     "id": "9d2f4c1a-6b7e-4a58-8c3d-2e1f0a9b8c7d",
     "ok": true,
     "result": {
       "agents": [
         { "id": "claude", "name": "Claude", "default": false },
         { "id": "opencode2", "name": "OpenCode 2", "default": false },
         { "id": "grok", "name": "Grok", "default": false }
       ]
     },
     "_meta": { "runtimeId": "4e8a1b2c-3d5f-4a6b-9c7d-8e0f1a2b3c4d" }
   }
   ```

   `--environment local` keeps the command on this machine's Orca, as Orca's own orchestration guide does for every worker it starts here.

2. **t3-autopilot builds the list of agents,** one per agent Orca lists, keyed by the id the [agent catalog](../reference.md#agent-catalog) gives it: Orca's `opencode2` is OpenCode. The models and efforts of each come from that catalog: aliases that do not go stale, such as Claude Code's `opus` and `sonnet`, or `default` for the model set in the CLI's own configuration (Codex, Grok). Your additions go in `catalog.yaml` in the data directory (`~/.t3-autopilot`). Orca checks the model and effort of every worker it starts, and t3-autopilot follows the same rules, so it never recommends a launch Orca would refuse:

   - **An effort needs a model.** `default` starts the CLI without `--model`, so it gets no `--effort` either (Codex's and Grok's built-in entry). List their model ids in `catalog.yaml` to choose an effort.
   - **Only some agents take a model.** Orca's `worker-start` takes `--model` for Claude Code, Codex, Cursor Agent, Antigravity, Grok, Muse, Pi, OpenCode (`opencode`), OMP and CodeBuddy. Every other agent, Gemini CLI, Kiro and Orca's `opencode2` among them, starts with the model set in its own configuration, so it is offered `default` only, whatever `catalog.yaml` lists for it.
   - **Pi takes `provider/id` models** (`openai/gpt-9.1-sol`); other ids for it are left out, with a warning.
   - **Claude Code's `haiku` takes no effort**, as in Orca's own catalog.

3. **It recommends, as in T3 Code,** with the same policy, subscription profiles and marks: up to three candidates, best first, each with its reason. In Orca the result also says `"host": "orca"`, and each candidate has `launch`, the command that starts it:

   ```json
   {
     "providerInstanceId": "claude",
     "model": "opus",
     "options": [{ "id": "effort", "value": "high" }],
     "reason": "code #1: latest claude-opus on claude is opus, effort high",
     "source": "taskType",
     "sameAsOrchestrator": false,
     "launch": {
       "mode": "supervised",
       "agent": "claude",
       "model": "opus",
       "effort": "high",
       "args": ["--agent", "claude", "--model", "opus", "--effort", "high"],
       "argv": ["orca", "orchestration", "worker-start", "--environment", "local",
                "--agent", "claude", "--model", "opus", "--effort", "high",
                "--worktree", "current", "--spec-file", "{briefFile}", "--json"],
       "notes": ["If ORCA_CLI_COMMAND is set, run its value in place of orca; in an Orca dev checkout (ORCA_DEV_REPO_ROOT set), orca-dev."]
     }
   }
   ```

4. **The orchestrator starts the worker.** It writes the brief to a file with its file tool, then runs `launch.argv` as one shell command, with the first element replaced by Orca's command and `{briefFile}` by the file's absolute path, and each element in single quotes, a `'` inside one written `'\''`, as bash, zsh and the other POSIX shells take it (Git Bash on Windows too):

   ```sh
   'orca' 'orchestration' 'worker-start' '--environment' 'local' '--agent' 'claude' '--model' 'opus' '--effort' 'high' '--worktree' 'current' '--spec-file' '/tmp/fix-login.md' '--json'
   ```

   In PowerShell, the line starts with `&`, the call operator (there, a line that starts with a quoted word is an expression, not a command), and a single quote inside an element is doubled, as is a curly one (`’`), which PowerShell also takes for a quote. In cmd.exe, each element goes in double quotes, which a Windows path never holds:

   ```powershell
   & 'orca' 'orchestration' 'worker-start' '--environment' 'local' '--agent' 'claude' '--model' 'opus' '--effort' 'high' '--worktree' 'current' '--spec-file' 'C:\Users\O''Brien\fix-login.md' '--json'
   ```

   ```bat
   "orca" "orchestration" "worker-start" "--environment" "local" "--agent" "claude" "--model" "opus" "--effort" "high" "--worktree" "current" "--spec-file" "C:\Users\O'Brien\fix-login.md" "--json"
   ```

   Orca reads the brief from the file itself, so its text never goes through a shell. `--worktree current` runs the worker in the orchestrator's workspace, as Orca's guide recommends; when the worker's changes would clash with the orchestrator's or another worker's, the orchestrator writes `new-child` instead and adds `--name <short-name>`, and Orca makes the worker a checkout of its own. Orca prints a receipt, one line of JSON, such as:

   ```json
   {"ok":true,"result":{"dispatchId":"ctx_f2dddf04e3e7","taskId":"task_6f686b808f34","runId":"run_79eed699c471","runCreated":true,"state":"ready","agent":"claude","model":"opus","effort":"high","mode":"terminal","next":"Orca wakes you when workers report; end your turn when you're done."}}
   ```

   The orchestrator then ends its turn: Orca never needs polling.

5. **The worker reports back.** Orca gives the worker a preamble with its task and dispatch ids, and the worker sends `worker_done` exactly once, with `--outcome succeeded` or `failed` and a short summary. Orca wakes the orchestrator: in a chat the message arrives whole, and in a terminal Orca writes a note to run `orca orchestration check`, which prints it:

   ```json
   {"ok":true,"result":{"messages":[{"id":"msg_b4bfa3c30984","type":"worker_done","subject":"Done","body":"…","payload":{"taskId":"task_6f686b808f34","dispatchId":"ctx_f2dddf04e3e7","outcome":"succeeded"}}]}}
   ```

   `orca orchestration worker-read --dispatch <dispatchId>` shows the worker's output. The orchestrator logs how it went with `log_delegation` (its `childThreadId` is the `dispatchId`) and `log_outcome`. If `worker-start` fails, or the worker stops at once (Orca sends an `escalation` with a `stopReason`), because of a usage limit, it marks the agent with `mark_unavailable` and uses the next candidate.

Later calls can leave `capabilities` out: the server keeps the list per session (and on disk, for a restart), and builds it again on each call with the agent catalog in force, so an edit to `catalog.yaml` applies on the next call. Run `orca agent installed` again when you install or turn on an agent. A terminal's handle changes when Orca restarts, so a call after that, with the new handle, asks for the list again.

### `launch`

| Field | What it is |
|---|---|
| `mode` | `supervised`: the worker reports back to the orchestrator with `worker_done`. |
| `agent` | The id Orca's `--agent` takes. It is the candidate's `providerInstanceId`, except for an agent Orca names otherwise (`opencode2` for OpenCode 2). |
| `model` | The model passed with `--model`. Absent for `default`: the CLI uses the model set in its own configuration. |
| `effort` | The effort passed with `--effort`. Absent when there is no model, or the model takes none. |
| `args` | `--agent`, `--model` and `--effort` with their values: what to use with another Orca command that starts an agent (`orca agent launch` or `orca worktree create --agent`, for a handoff with nothing expected back). |
| `argv` | The command, one element per argument. `{briefFile}` is a whole element to replace. The orchestrator runs it as one shell command, each element in single quotes (after `&` in PowerShell, in double quotes in cmd.exe) and the first one replaced by Orca's command (see step 4 above). |
| `notes` | What the orchestrator should know: Orca's command, an option it cannot pass, OpenCode's worktree and, on Windows, how to quote in PowerShell and cmd.exe, in the words of the instructions. |

A candidate whose command Orca would refuse is left out, and `skipped` says why.

### Orca's command

Orca's own rule, which t3-autopilot's instructions repeat: `$ORCA_CLI_COMMAND` if it is set, else `orca-dev` if `$ORCA_DEV_REPO_ROOT` is set (an Orca developer's checkout), else `orca-ide` on Linux, where `orca` is GNOME's screen reader, and `orca` elsewhere. `launch.argv` starts with `orca-ide` on Linux and `orca` elsewhere, and its note says to run `$ORCA_CLI_COMMAND` in its place when it is set. Orca puts its command on the `PATH` of its terminals, so in the run described [below](#checked-against), in a terminal of Orca on macOS where `ORCA_CLI_COMMAND` was not set, `orca` worked as it is.

## Models

| Agent (Orca id) | Models the catalog offers | Effort | What to add |
|---|---|---|---|
| Claude Code (`claude`) | `opus`, `sonnet`, `haiku`, `fable` | Yes, except `haiku` | A versioned id (`claude-opus-9-2`) wins over its alias. |
| Codex (`codex`) | `default` (the model set in Codex, always a GPT) | Only with a model id | Your model ids (`gpt-9.2-codex`), to get an effort. |
| Grok (`grok`) | `default` (its coding model) | Only with a model id | Grok's ids (`grok models` lists them). |
| Cursor Agent (`cursor`) | `auto` | Part of the model id | Cursor's ids, which carry the effort (`gpt-9.3-codex-high`). |
| OpenCode (`opencode`) | `default` | None | `provider/model` ids. Orca takes them only in a workspace that exists (`--worktree current` or an existing one). |
| Pi (`pi`) | `default` | Only with a model id | `provider/id` ids. |
| Antigravity (`antigravity`), Muse (`muse`) | `default` | Only with a model id | The ids your account offers. |
| Gemini CLI (`gemini`), Kiro (`kiro`), OpenCode 2 (`opencode2`) | `default` only | None | Nothing: Orca starts them with the model set in their own configuration. |

An agent with only `default` is reached by the generic fallback, with low confidence, and a warning says where to list its models when Orca can take one. For example:

```yaml
agents:
  codex:
    models: [gpt-9.2-codex, { id: default, family: gpt }]
  pi:
    models: [openai/gpt-9.1-sol, anthropic/claude-opus-9-2]
```

Orca checks an effort against its own menu for the model, so an effort it does not list for that model is refused at start. If that happens with a model you declared, give it its own `efforts` in `catalog.yaml` (`{ id: grok-9-mini, efforts: [low, medium, high] }`). The [agent catalog](../reference.md#agent-catalog) section of the reference has every key.

### Agents t3-autopilot does not know

An agent Orca lists that is not in the catalog (Goose, Hermes, Droid…) is offered with its default model only, under Orca's name for it, by the generic fallback, and starts with `--agent <id>` and nothing else. To place it in the policy, describe it in `catalog.yaml` with its `driver` and a `default` model tied to a family (`{ id: default, family: claude-sonnet }`).

## What is kept, and where

Orca's marks, subscription profiles and log records are kept in the same files as T3 Code's, under the prefix `orca:` (`orca:codex`), so a usage limit reached in Orca never demotes Codex in T3 Code or herdr, and the other way round. To say that two of them share one plan, give both profiles the same `quotaPool`. Its capabilities are kept per session in `capabilities-cache.orca.json`. Tools take and return ids without the prefix when the call says `host: "orca"`.

## Safety

- **Never a shell string from t3-autopilot.** `launch.argv` is a list, one element per argument. An orchestrator's shell tool takes a command line, so the instructions have it write each element in single quotes, which keep every character as it is in a POSIX shell and in PowerShell, or in double quotes in cmd.exe; the elements t3-autopilot makes never hold a quote.
- **The brief goes in a file.** The orchestrator writes it with its file tool and passes its path with `--spec-file`; Orca reads the file, so a `$()`, a backquote or a quote in the brief never reaches a shell. The path goes in single quotes, with a `'` in it written as `'\''` (doubled in PowerShell, curly ones too), or in double quotes in cmd.exe. A test runs this recipe through `sh`, with all of these in the file's path and in the brief, against a stand-in for Orca's command, and checks the arguments and the text it receives; the run described below did the same with Orca itself. Another runs the PowerShell form through PowerShell wherever it is installed (CI has it on Linux, macOS and Windows), and the cmd.exe form through cmd.exe on Windows.
- **Every word is checked.** Model ids, efforts and agent ids must be one word of letters, digits and `. _ : / @ + = , [ ] -`, not starting with `-`, so a model id cannot carry a space, a shell character or an option such as `--dangerously-skip-permissions`. A candidate with one that is not is left out.
- **Orca's own defaults.** Orca starts agents with the permission settings of its Settings → Agents, which by default skip the agents' permission prompts (`--dangerously-skip-permissions` for Claude Code), and in Orca's words "a worktree is an isolated checkout, not a security sandbox". When it starts, Orca also adds its hooks to the agents' settings, such as Claude Code's `~/.claude/settings.json`. Both come from Orca, not from t3-autopilot.

## Limitations

- **Orchestration is Experimental in Orca,** whose commands change with the app. `launch.args` (`--agent`, `--model`, `--effort`) are the stable part; `launch.argv` follows the recipe of Orca's orchestration guide at the version below. If it fails, the orchestrator can fall back on Orca's skill with the same `args`.
- **Other machines are not covered:** workers on a paired Orca server (`--on`), and workspaces on SSH hosts or WSL, whose agents `orca agent installed` without `--worktree` does not list. The recipe pins `worker-start` to this machine's Orca (`--environment local`).
- **One account per agent CLI.** Orca's account for an agent is global, not chosen per worker, so there is one provider, and one subscription profile, per agent.
- **Usage limits are shown only in Orca's interface.** Signs that a worker hit one: `worker-start` fails, or the orchestrator gets an `escalation` with `stopReason` `errored` or `exited` right after the start. Then call `mark_unavailable`.
- **Which agents take `--model` is t3-autopilot's copy of Orca's list** at the version below. An agent that a later Orca lets pick a model is offered its default model until t3-autopilot's list follows.
- **OpenCode with a model** needs a workspace that exists and an OpenCode that Orca has verified; otherwise Orca refuses the model, and the orchestrator moves on to the next candidate.
- **Windows** was not tried with Orca itself, only the quoting of the instructions, against a stand-in for Orca's command. In cmd.exe, a `%` in a path can still expand an environment variable, so keep the brief file's path free of `%` there.
- **`sameAsOrchestrator`** is true only when the orchestrator's `model` is written as the catalog writes it (`opus`, not `claude-opus-9-2`).

## Checked against

The adapter follows Orca's source at commit `e955bff` (2026-11-21): `orca agent installed` and its output (`src/cli/agents/installed-agents.ts`), `worker-start` and its flags (`src/cli/specs/orchestration-worker-specs.ts`, `src/cli/orchestration/workers/worker-launch-handler.ts`), the checks of model and effort at start (`src/shared/agent-launch/choices/agent-launch-model-preferences.ts` and the catalogs in `src/shared/agent-session/options/catalog-providers/`), the rule for Orca's command (`src/cli/orchestration/recovery/orchestration-recovery-command.ts`), the worker's preamble and `worker_done` (`src/main/runtime/orchestration/workers/launch/worker-dispatch-preamble.ts`), and Orca's orchestration guide (`skill-guides/orchestration.md`).

On 2026-11-21, Orca 1.4.269, the official notarized macOS build, was run for real on macOS, without a window (`orca serve`) and with a home folder of its own:

- `orca agent installed --environment local --json` printed the output in `test/fixtures/orca/agent-installed-macos.json` (its two uuids replaced), and, with Orca stopped, the error in `test/fixtures/orca/agent-installed-error.json`.
- From a terminal of Orca, `worker-start` with the command from `launch` started a worker, with a brief file whose path and text held `'`, spaces, `$HOME`, backquotes and `$(...)`. Orca typed the brief into the worker unchanged, nothing in it ran, and the worker's `worker_done` reached the orchestrator through `orca orchestration check`, with the `dispatchId` of the receipt. In that terminal, `ORCA_TERMINAL_HANDLE` was set and `ORCA_CLI_COMMAND` was not.
- Orca refused `--model` for an agent without model selection (Goose and `opencode2`) and `--effort` without `--model`, before starting anything, as t3-autopilot expects.

The worker was a stand-in for an agent CLI, in Orca's slot for Goose: no real agent was started as a worker, because Orca writes its hooks into each agent's own settings (`~/.claude/settings.json` for Claude Code), which the test was not to touch. A worker that runs Claude Code, Codex or another real agent in Orca is not verified yet.

## The instructions

`npx -y t3-autopilot snippet --host orca` prints:

```markdown
## Model selection for delegated tasks in Orca (t3-autopilot)

You are authorized to pick the agent, model and effort of every worker you start in Orca following the t3-autopilot MCP server. Switching agent or model as recommended by `recommend_model` counts as asked for by the user, and these steps take precedence over the Orca skills where they differ, such as their rule to add `--model` only when the user named one.

1. Before every worker, call `recommend_model` with `host: "orca"`, `session` (the value of `$ORCA_TERMINAL_HANDLE`, or of `$ORCA_AGENT_SESSION_ID` in an Orca chat), `task` (one line), `taskType` (always; choose from the types listed in the tool description) and, if you know them, `size` and `criticality`.
2. Orca's command is `$ORCA_CLI_COMMAND` if that is set, else `orca-dev` if `$ORCA_DEV_REPO_ROOT` is set, else `orca-ide` on Linux and `orca` elsewhere; use it wherever `orca` appears below. On the first call, and again after an error or when agents change, pass as `capabilities` the output of `orca agent installed --environment local --json`, exactly as printed, and as `orchestrator` your own Orca `agent` id (`claude`, `codex`, ...) and `model`. If a call fails with "No Orca catalog yet", run it again and pass its output.
3. Use the first candidate. Write its brief to a file with your file tool (never `echo` or a heredoc), self-contained: what to change, what the worker may edit and what proves it is done. Run its `launch.argv` as one shell command, with its first element replaced by Orca's command and `{briefFile}` by the file's absolute path, and each element in single quotes, a `'` inside one written `'\''`, as bash, zsh and the other POSIX shells take it (Git Bash on Windows too). For example: `'orca' 'orchestration' 'worker-start' '--environment' 'local' '--agent' 'codex' '--worktree' 'current' '--spec-file' '/tmp/review-auth.md' '--json'`. In PowerShell, start the line with `&` and a space, and double each single quote inside an element, straight or curly; in cmd.exe, put each element in double quotes instead. `--worktree current` runs the worker in your workspace; when its changes would clash with yours or another worker's, write `new-child` instead and add `--name <short-name>`. Follow `launch.notes`. Then end your turn: Orca wakes you when the worker reports with `worker_done`, asks or stops; never poll. If it has `sameAsOrchestrator: true`, your native subagent tool works too.
4. If `worker-start` fails, or the worker stops at once (an `escalation`), because of a usage limit or its plan, call `mark_unavailable` with `host: "orca"`, its `providerInstanceId`, its `model` (omit it if the whole agent is out), a short `reason` and `until` if you know when the limit resets; then use the next candidate. For any other failure, do what Orca prints, and never rerun the same command on your own.
5. Tell the user in one line which agent and model you picked, and why (the candidate's `reason`).
6. If `recommend_model` returns no candidate or fails, start the worker on your own agent without `--model`, and say so. If the user names an agent or model for a task, use theirs instead.
7. Right after starting the worker, call `log_delegation` with `host: "orca"`, the `taskType`, `providerInstanceId`, `model` and `options` you used, `recommendedRank` (1-based rank of the candidate, or null if you chose something else) and `childThreadId` (the `dispatchId` that `worker-start` printed); keep the `delegationId`. When its `worker_done` arrives, review the result (`orca orchestration worker-read --dispatch <dispatchId>` shows its output) and call `log_outcome` with that `delegationId`, `outcome` (`success`, `corrected` or `failure`) and a short `note`.
8. If the result has `setupNeeded`, ask the user its questions for every agent listed, all at once, without holding up the current task, and save each answer with `set_subscription` (`host: "orca"`). If a warning says an agent has no models declared, tell the user once where to list them; if one says a candidate costs extra or is outside its subscription profile, ask the user before starting it.
```
