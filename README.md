**English** · [Español](docs/README.es.md)

# t3-autopilot

[![CI](https://github.com/pablosalme/t3-autopilot/actions/workflows/ci.yml/badge.svg)](https://github.com/pablosalme/t3-autopilot/actions/workflows/ci.yml)

Picks the right AI model for every task your agent hands off, so you don't have to.

**Works with [T3 Code](https://github.com/pingdotgg/t3code), [Orca](https://orca.dev) and [herdr](https://herdr.dev).**

## What it is

In T3 Code, the agent you talk to can hand parts of a job to helper agents, and each helper can run on any of the AI subscriptions you have connected: Claude, Codex, Cursor, Grok and others. t3-autopilot is a small add-on that tells your agent which of your models to use for each of those tasks.

Think of the person who hands out the work in a workshop: the delicate job goes to the most experienced hand, sweeping up goes to the apprentice, and the inspection is done by someone who did not make the piece. t3-autopilot does that with your AI models:

| You ask for | It suggests | Why |
|---|---|---|
| A new feature | Your newest Claude Opus, thinking hard | It is a demanding job |
| A review of that feature | Your newest GPT, on Codex | A second opinion should come from someone else |
| Renaming a few files | Your newest Claude Haiku, thinking little | Small and fast is enough |

(This is what the built-in preferences give if you have Claude and Codex connected and your agent runs on Claude. You can change them.)

It works the same way in Orca, where your agents run side by side in their own workspaces, and in herdr, where they run in terminals that stay alive: there, each answer also brings the command that starts the helper (see [In Orca](#in-orca) and [In herdr](#in-herdr)).

It is an independent project, not part of T3 Code, Orca or herdr.

## Why it helps

Left alone, an agent tends to:

- use its own model for everything, even when another subscription you pay for suits the task better;
- remember model names that go out of date as soon as a new version comes out;
- ask the model that wrote the code to review it.

With t3-autopilot:

- **Each kind of task goes to a model that suits it.** There is a ready-made list for eight kinds of task: coding, reviewing, debugging, planning, research, quick edits, design and writing.
- **You always get the newest version you have.** Preferences say "Claude Opus", not a version number, so a new version is used as soon as your account offers it.
- **Reviews get a real second opinion,** from a different provider than the one your agent runs on.
- **Your plans are respected.** A cheap plan with little room is kept for what you bought it for, and models your plan charges extra for are left alone while something included can do the job.
- **A subscription that runs out does not stop the work.** If a helper cannot start because a limit was reached, your agent moves on to the next option.
- **You are told what was chosen.** Your agent says in one line which model it picked and why.

It only gives advice. It never starts agents itself and never sees your passwords or account tokens.

## How it works

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/pablosalme/t3-autopilot/main/docs/assets/how-it-works-en-dark.gif">
  <img src="https://raw.githubusercontent.com/pablosalme/t3-autopilot/main/docs/assets/how-it-works-en-light.gif" alt="Animation in three steps. 1, Ask: your agent, running on Claude, has the task 'Review the PR that moves auth checks' and asks t3-autopilot which model to use. 2, Decide: for reviews you prefer GPT, then Gemini, then Grok; of the models you have, Claude is left out because it is your agent's own, and Cursor, out of quota, moves to the end. 3, Answer: three options, best first, each with its reason: Codex with gpt-6.2-codex, Grok with grok-6 and Cursor with gemini-5.1-pro; the helper starts on the first one. Model names are made up." width="880">
</picture>

1. **Your agent asks.** Before it hands off a task, it tells t3-autopilot what kind of task it is and which models you have in T3 Code.
2. **t3-autopilot answers.** It checks your preferences and returns up to three options, best first, each with its reason.
3. **Your agent uses the first one** and tells you in one line which model it picked and why. If that one cannot start, it goes on to the next.

Your agent can also note how each handoff went (accepted as is, needed fixes, or not usable), so later you can see which models work best for you.

## Install

You need:

- T3 Code, with at least one provider signed in; or Orca, or herdr's `hc` (herdr-core or the herdr app), with at least one agent CLI installed (Claude Code, Codex, Cursor Agent, Grok, OpenCode and others).
- [Node.js](https://nodejs.org) 22 or later. To check, run `node --version` in a terminal.

There is nothing to download by hand: `npx`, a tool that comes with Node.js, fetches t3-autopilot and runs it.

### Step 1. Add it to your agent

Only the agent you talk to needs it (the *orchestrator*); the helpers do not. The commands are the same in T3 Code, Orca and herdr. Copy the line for the agent you use and paste it into a terminal:

**Claude Code**

```sh
claude mcp add --scope user t3-autopilot -- npx -y t3-autopilot
```

**Codex**

```sh
codex mcp add t3-autopilot -- npx -y t3-autopilot
```

**Grok CLI**

```sh
grok mcp add t3-autopilot -- npx -y t3-autopilot
```

**OpenCode**

```sh
opencode mcp add t3-autopilot --global -- npx -y t3-autopilot
```

These lines register t3-autopilot as an *MCP server*, the standard way of giving an AI agent an extra tool.

<details>
<summary>Another agent, or one that asks for a JSON configuration</summary>

Add this block to its MCP configuration:

```json
{
  "mcpServers": {
    "t3-autopilot": { "command": "npx", "args": ["-y", "t3-autopilot"] }
  }
}
```

</details>

### Step 2. Tell your agent to use it

Agents read a rules file every time they start: `CLAUDE.md` for Claude Code, `AGENTS.md` for most others. t3-autopilot prints the paragraph to add to it. In T3 Code:

```sh
npx -y t3-autopilot snippet
```

In Orca and in herdr, the paragraph is a different one:

```sh
npx -y t3-autopilot snippet --host orca
npx -y t3-autopilot snippet --host herdr
```

If the same rules file is read in more than one (one `CLAUDE.md` for every project, say), use the one for every host, which first tells your agent how to find where it runs:

```sh
npx -y t3-autopilot snippet --host all
```

Copy what it prints and paste it at the end of your rules file. Or let the terminal do it (on macOS and Linux only; on Windows, copy and paste, because PowerShell can save the added text in a different encoding from the rest of the file). The lines below add T3 Code's; for Orca or herdr, write `snippet --host orca` or `snippet --host herdr` (or `snippet --host all`) instead of `snippet`. For Claude Code:

```sh
npx -y t3-autopilot snippet >> ~/.claude/CLAUDE.md
```

For Codex:

```sh
npx -y t3-autopilot snippet >> ~/.codex/AGENTS.md
```

For Grok CLI:

```sh
npx -y t3-autopilot snippet >> ~/.grok/AGENTS.md
```

For OpenCode:

```sh
npx -y t3-autopilot snippet >> ~/.config/opencode/AGENTS.md
```

Do not skip this step. Without it, your agent has the tool but does not know when to use it. The paragraph also gives your agent permission to switch model, which T3 Code otherwise tells it not to do on its own.

<details>
<summary>See the paragraph it adds for T3 Code</summary>

```markdown
## Model selection for delegated tasks (t3-autopilot)

You are authorized to pick the provider, model and options of every child task in T3 Code following the t3-autopilot MCP server. Switching provider or model as recommended by `recommend_model` counts as asked for by the user.

1. For every child task, including the ones you would start with your native subagent tool, call `recommend_model` first with `task` (one line), `taskType` (always; choose from the types listed in the tool description) and, if you know them, `size` and `criticality`.
2. Pass `capabilities` (the full output of `orchestrator_capabilities`) on the first call of the thread and again after an error or when providers change; the server keeps the last one, so other calls can omit it. Pass it whole, exactly as returned, never trimmed or summarised: a copy without each model's `options` loses the effort settings. If a call fails with "No capabilities yet", call `orchestrator_capabilities` and pass its full output again.
3. Use the first candidate. If it has `sameAsOrchestrator: true`, your native subagent tool is fine; otherwise call `delegate_task` with its `providerInstanceId`, `model` and `options` as `target`. If that child cannot start, or stops at once, because of a usage limit or its plan (for example "not included in your weekly usage"), call `mark_unavailable` with its `providerInstanceId`, its `model` (omit it if the whole provider is out), a short `reason` and `until` if you know when the limit resets, then use the next candidate.
4. Tell the user in one line which provider and model you picked, and why (the candidate's `reason`).
5. If `recommend_model` returns no candidate or fails, delegate inheriting your own provider and model, and say so.
6. If the result has `warnings` about omitted models, call `orchestrator_capabilities` with the `search` they suggest and pass that output to `recommend_model` as `capabilities` with `mergeCapabilities: true`.
7. If the user names a provider or model for a task, use theirs instead.
8. Right after delegating, call `log_delegation` with the `taskType`, `providerInstanceId`, `model` and `options` you used, `recommendedRank` (1-based rank of the candidate, or null if you chose something else) and `childThreadId`; keep the `delegationId`. After you review the child's result, call `log_outcome` with that `delegationId` and `outcome`: `success` (accepted as is), `corrected` (you had to fix or redo part of it) or `failure` (not usable; a child that could not start goes to `mark_unavailable` instead); add a short `note`.
9. If the result has `setupNeeded`, ask the user its questions for every provider listed, all at once, without holding up the current task, and save each answer with `set_subscription` (plan, quota, purpose and, if they apply, quotaWindow, quotaPool, includedFamilies or paidFamilies, role, onlyFamilies or avoidFamilies, onlyTaskTypes). If a `warnings` entry says a candidate costs extra or is outside its subscription profile, ask the user before delegating to it.
```

</details>

### Step 3. Restart your agent

Restart your agent, in T3 Code, Orca or herdr, so it loads t3-autopilot and reads the new rules. Orca's paragraph is in [docs/hosts/orca.md](docs/hosts/orca.md#the-instructions), and herdr's in [docs/hosts/herdr.md](docs/hosts/herdr.md#the-instructions).

### Alternative: install from the source code

If you prefer not to use `npx`, download the code and build it:

```sh
git clone https://github.com/pablosalme/t3-autopilot.git
cd t3-autopilot
npm ci
```

Then follow the same steps, writing `node /path/to/t3-autopilot/dist/cli.js` wherever they say `npx -y t3-autopilot` (replace `/path/to` with the folder you downloaded it to). For example, for Claude Code:

```sh
claude mcp add --scope user t3-autopilot -- node /path/to/t3-autopilot/dist/cli.js
```

To update later, run `git pull` and then `npm ci` again.

## Check that it works

1. **The program runs.** This prints a version number:

   ```sh
   npx -y t3-autopilot --version
   ```

2. **Your agent sees it.** In Claude Code, `claude mcp list` shows a line like `t3-autopilot: ... ✔ Connected`. In Grok CLI, `grok mcp doctor` checks the connection.
3. **It is used.** In T3 Code, Orca or herdr, ask your agent for something it has to hand off, for example: *"Delegate a review of the README to a child task."* Before it starts, it should tell you in one line which provider and model it picked and why, something like *"review #1: latest gpt on codex is gpt-6.2-codex, effort xhigh"* (the model name is made up).

After the first handoff, a folder called `.t3-autopilot` appears in your home folder. If none of this happens, see [the questions below](#questions).

## In Orca

In [Orca](https://orca.dev), your agents run side by side, each in its own workspace, and the one you talk to can start others as workers that report back when they finish. Orca says which agent CLIs you have turned on, but not their models, so the first time, your agent passes that list to t3-autopilot, and t3-autopilot fills in the models from a list it carries (with names that do not go stale, such as Claude Code's `opus`). Each recommendation then comes with the `orca orchestration worker-start` command that starts the worker, with the task always in a file, never pasted into the command, and only with the choices Orca accepts for that agent. Install it as above, with Orca's paragraph in step 2:

```sh
npx -y t3-autopilot snippet --host orca >> ~/.claude/CLAUDE.md
```

What a limit or a subscription profile does, and the log, work as in T3 Code, but each host keeps its own: a limit reached in Orca does not hold back the same provider in T3 Code. How it works, which agents Orca lets pick a model, and what to add for agents whose models it cannot guess (Codex's model ids, to choose an effort, for example), is in [docs/hosts/orca.md](docs/hosts/orca.md).

## In herdr

In [herdr](https://herdr.dev), `hc` runs your agents in terminals that stay alive, and one agent can start others. herdr knows nothing about models, so the first time, your agent tells t3-autopilot which agent CLIs it finds on your computer, and t3-autopilot fills in their models from a list it carries (with names that do not go stale, such as Claude Code's `opus`). Each recommendation then comes with the `hc run` command that starts the helper, with the task always in a file, never pasted into the command. Install it as above, with herdr's paragraph in step 2:

```sh
npx -y t3-autopilot snippet --host herdr >> ~/.claude/CLAUDE.md
```

What a limit or a subscription profile does, and the log, work as in T3 Code, but each host keeps its own: a limit reached in herdr does not hold back the same provider in T3 Code. How it works, and what to add for agents whose models it cannot guess (OpenCode and Pi, for example), is in [docs/hosts/herdr.md](docs/hosts/herdr.md).

## Make it yours

t3-autopilot works with no configuration. To change its preferences, create your own settings file:

```sh
npx -y t3-autopilot init-policy
```

This writes `policy.yaml` in the `.t3-autopilot` folder of your home folder. It is a plain text file with ready-made examples, all switched off with a `#` at the start of the line. Open it with any text editor, remove the `#` from the lines you want and save. Changes apply on the next task; there is nothing to restart.

The most common changes:

```yaml
# Never use this provider (for example, one you keep for yourself):
excludeProviders: [cursor-work]

# Get two options instead of three:
maxCandidates: 2
```

`cursor-work` is an example: use the provider name your agent shows when it explains its pick.

You can also change which models are preferred for each kind of task, or add a model family that is not in the list. Both are explained in the [reference](docs/reference.md#the-policy).

If you make a mistake in the file, nothing breaks: your agent gets a message that says what to fix, and carries on with its own model in the meantime. A setting whose name it does not know (a typo, for example) is ignored, and your agent is told which one.

## Your subscriptions

Not every subscription is the same. One has plenty of room, another runs out in minutes, and some apps charge extra for certain models. The first time your agent meets a provider t3-autopilot knows nothing about, it asks you a few short questions: which plan you have, whether its limit is generous or tight and how often it resets (every 5 hours, weekly or monthly), whether it shares that limit with another app, which models it includes, and what you want it for. Your answers are saved, and from then on:

- **A plan with a tight limit is kept for what you said it is for.** It is not used for big or delicate tasks, nor for models you already have elsewhere.
- **Models your plan charges extra for are left alone** while an included one can do the job. If one is the only option, your agent asks you first.
- **Two apps on one plan share one limit.** When one runs out, the other also drops behind the included ones that can still run.
- **A provider that runs out waits as long as its limit lasts:** 5 hours, a week or a month, as you said, instead of a guess of 24 hours.

Until you answer, everything works as before. For example, with Claude Max, an X Premium plan that covers both Grok and Cursor (in Cursor only Grok and Composer are included; Claude, GPT and Gemini are charged apart) and OpenCode Go to try models you have nowhere else, the saved answers look like this:

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

They live in `subscriptions.yaml`, in the `.t3-autopilot` folder. To change one, tell your agent, or edit the file. The details are in the [reference](docs/reference.md#subscription-profiles).

## Privacy

Everything t3-autopilot keeps is in one folder on your computer: `.t3-autopilot`, inside your home folder.

| File | What it holds |
|---|---|
| `policy.yaml` | Your preferences. Only there if you created it. |
| `log.jsonl` | The handoffs your agent noted: kind of task, provider, model, the settings used, the id of the helper's conversation and how it went. A short summary or note only if your agent adds one (200 characters at most). |
| `unavailable.json` | Providers or models that are out for a while because a limit was reached, with the reason and until when. |
| `capabilities-cache.json` | The last list of providers and models T3 Code gave your agent, and whether each can be used. No passwords or tokens. |
| `capabilities-cache.t3.json` | The same lists, one per conversation of your agent, so that after a restart each one gets its own back. |
| `capabilities-cache.orca.json` | In Orca, the agent CLIs Orca listed, one list per conversation. |
| `capabilities-cache.herdr.json` | In herdr, the agent CLIs your agent found, one list per conversation. |
| `catalog.yaml` | The models you added for agents in Orca and herdr. Only there if you created it. |
| `subscriptions.yaml` | What you told your agent about each subscription: the plan, how much room it has, what it is for and which models it includes. |

What it never does:

- **It never connects to the internet.** Nothing leaves your computer. (`npx` downloads the program from npm; the program itself contacts nobody.)
- **It never reads passwords, API keys, tokens or cookies,** nor T3 Code's settings files.
- **It never stores the task descriptions** your agent sends when it asks for a recommendation.
- **It never starts agents or changes anything in T3 Code.** It only recommends; your agent decides.

## Uninstall

1. Remove it from your agent:
   - Claude Code: `claude mcp remove t3-autopilot`
   - Grok CLI: `grok mcp remove t3-autopilot`
   - Codex: delete the `t3-autopilot` block from `~/.codex/config.toml`.
   - OpenCode: delete the `t3-autopilot` entry from `~/.config/opencode/opencode.json`.
2. Delete the paragraph whose title starts with "Model selection for delegated tasks" and ends with "(t3-autopilot)" from your rules file (`CLAUDE.md` or `AGENTS.md`).
3. Delete the `.t3-autopilot` folder in your home folder, if you do not want to keep your preferences and the log.

That is all. If you installed from the source code, delete that folder too.

## Questions

**Does it cost anything or use up my subscriptions?**
No. It is free and open source, and it never calls an AI model: it only answers your agent's question.

**Do I need T3 Code?**
No. It works in T3 Code, Orca and herdr (see [In Orca](#in-orca) and [In herdr](#in-herdr)).

**Which providers does it work with?**
In T3 Code, all the ones it offers: Claude, Codex, Cursor, Grok, OpenCode, Antigravity, Kiro, Pi, fx, Muse and ACP agents. Any combination works, including two accounts of the same provider. [docs/providers.md](docs/providers.md) has the details of each. In Orca and herdr, the agent CLIs Claude Code, Codex, Cursor Agent, Grok, OpenCode, Pi, Antigravity, Muse, Kiro and Gemini CLI, and others with less precision.

**Does it know how much of my subscription is left?**
No. T3 Code does not share that with add-ons, and t3-autopilot will not read your account tokens to find out. What it does: when a helper cannot start because a limit was reached, your agent notes it, and that provider drops behind the ones that can still run until the limit resets (24 hours if the date is not known; only models your plan charges extra for stay behind it). If you told it how often a plan's limit resets, it waits that long instead (see [Your subscriptions](#your-subscriptions)), and you can tell it which plans run out quickly.

**A new model came out. Do I have to update anything?**
Usually not. Preferences name families ("Claude Opus", "GPT", "Gemini"), and the newest version you have is picked each time. Only a brand-new family needs a line in your settings file.

**Will my agent always follow the recommendation?**
Almost always, but nothing forces it: your agent is an AI model following written instructions. If you name a model yourself for a task, yours wins.

**My agent does not seem to use it. What do I check?**
That step 1 worked (see [Check that it works](#check-that-it-works)), that the paragraph from step 2 is in the rules file your agent reads, that you restarted your agent afterwards, and that `node --version` says 22 or later.

**Can I see how it is going?**
Yes. Ask your agent for the t3-autopilot statistics: how many tasks went to each model and how they turned out.

**Are the model names in the examples real?**
No. Examples use made-up versions so that they never read as claims about real models.

**Where is the technical detail?**
In the [reference](docs/reference.md): the tools, every setting, the file formats and how models are matched.

## More

- [Reference](docs/reference.md): everything technical.
- [Providers](docs/providers.md): how each T3 Code provider is handled.
- [Contributing](CONTRIBUTING.md), [security](SECURITY.md) and [changelog](CHANGELOG.md).

## License

[MIT](LICENSE)
