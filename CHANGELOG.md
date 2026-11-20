# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `taskType` accepts common synonyms and other spellings, resolved to the policy's type: `implementation`, `implement`, `coding` and `feature` are `code`, `bugfix` and `fix` are `debug`, `docs` is `writing`, and so on (the full list is in the reference). Case, spaces and underscores do not matter. The result says what was resolved in `requestedTaskType` and `classification.reason`; `log_delegation` and `log_outcome` store the type's own name. Before, `"implementation"` failed with "Unknown taskType". An unknown name now lists the aliases as well.

### Fixed

- With subscription profiles, a model that costs extra no longer comes ahead of one the plan includes that is only marked unavailable (a shared quota at its weekly limit, for example): included and not marked first, then included but marked, then paid, and a paid and marked model last. When the included candidates in the list are all marked and a paid one could run, it takes the last slot. A new warning names the marked included candidates, and another, when only marked or paid candidates are left, tells the orchestrator to ask the user before paying, with the time the earliest mark ends; paid models left out of the list are named in `skipped`.
- A provider's subscription tier now weighs more than the independent-review rule: for a `review` with the orchestrator on its primary provider and the other primary provider marked, a generic, low-confidence model on an experimental or tight-quota provider (`opencode-go/beam-free` on OpenCode Go) no longer comes ahead of the primary provider's Claude Opus.
- The reason of a candidate marked unavailable, or sharing a quota pool with a marked provider, no longer ends in "moved to the end", which was wrong when it headed the list: it ends in "ranked after available candidates" when one that is not marked ranks higher, and otherwise in "quota may be exhausted; no available candidate ranks higher".

## [0.1.2] - 2026-11-20

### Added

- Subscription profiles per provider instance, in `subscriptions.yaml` in the data directory (mode `600`, written atomically): `plan`, `quota` (`generous`, `standard`, `tight`), `purpose`, `role` (`primary`, `secondary`, `experimental`, `lastResort`), `quotaPool`, `quotaWindow` (`5h`, `weekly`, `monthly`), `includedFamilies` or `paidFamilies`, `onlyFamilies` or `avoidFamilies`, and `onlyTaskTypes`. `recommend_model` applies them: a provider with a tight quota or the experimental role is not proposed for a model family the user has on another provider, nor for large or highly critical tasks; models billed apart from the plan (Claude, GPT or Gemini on a Cursor plan that only includes Grok and Composer, for example) and anything outside a profile's rules are used only when nothing else can run, and then with a warning; providers with the same `quotaPool` share unavailable marks and usage; each candidate's reason says when its profile changed anything. Without profiles the ranking is unchanged.
- `setupNeeded` in the `recommend_model` result: the eligible providers without a subscription profile, with the questions the orchestrator should ask the user (plan, quota and how often it resets, a shared quota, models billed apart, purpose). It never blocks the recommendation.
- `mark_unavailable` without `until` lasts the provider's `quotaWindow` (5 hours, 7 days or 30 days; a quota pool mate's when it has none) instead of 24 hours, and says which in `untilFrom`.
- `mark_unavailable` accepts a `model` that ends in `*` to mark every model id that starts with it, such as `opencode-go/*` for the OpenCode Go plan's models inside the `opencode` instance. Before, such a mark matched no model.
- Two tools: `set_subscription` saves (or, with `remove: true`, deletes) a provider's profile with strict validation against the policy's families and task types, and `get_subscriptions` reads them back with the providers still missing one.
- The orchestrator snippet has a ninth step: ask the user about the providers in `setupNeeded`, save the answers with `set_subscription`, and ask before delegating to a candidate that costs extra or is outside its profile. Paste the new snippet (`npx -y t3-autopilot snippet`) over the old one in your rules file.
- An animated GIF in both READMEs (light and dark, English and Spanish) that shows how a recommendation is made, generated from `docs/assets/animation/` with `npm run build:animation`.

## [0.1.1] - 2026-11-19

### Changed

- The release workflow publishes on npm with [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC) instead of an npm access token. The package is still published with provenance.

## [0.1.0] - 2026-11-19

First public version.

Requires Node.js 22 or later.

### Added

- stdio MCP server with five tools: `recommend_model`, `log_delegation`, `log_outcome`, `mark_unavailable` and `get_stats`.
- Family-based policy (`policy/default.yaml`) with eight task types (`review`, `debug`, `plan`, `research`, `quick`, `code`, `design`, `writing`) and a user override in `~/.t3-autopilot/policy.yaml`, re-read on every call. A mistake in the override is reported with the name of that file, and the server keeps running. A key the policy does not know, at any level (a misspelling, for example), is ignored and named in the `warnings` of `recommend_model`.
- Model families resolved to the newest matching model id on every eligible provider instance, for the eleven drivers T3 Code ships and several instances of the same driver. Muse Spark and Muse Wonder are separate families (`muse-spark`, `muse-wonder`), and Gemini ids with a date at the end (`gemini-2.5-pro-preview-06-05`, `gemini-2.0-flash-001`) match their family without the date counting as a version. When several models share the highest version, the one T3 lists first (the user's order) wins, and its reason says so instead of calling it the latest.
- Up to three candidates per task, ready for `delegate_task.target`, with a reason each; policy fallback list, generic fallback (a provider's default model, low confidence) and the orchestrator's own model as a last resort.
- Reasoning effort per candidate, shifted by `size` and `criticality` and clamped to what each model supports. The effort option is set once, also when a policy candidate names it under `options` as well.
- Ordering by usage limits passed in the call (the windows of a provider add up when they come in several entries), and a different provider than the orchestrator's for independent reviews.
- Capabilities kept between calls, in memory and in `capabilities-cache.json`, so a server restart between turns does not lose them; the saved copy is reused for `capabilitiesCacheTtlHours` (12 by default) and a result built on it says `capabilitiesFrom: "disk-cache"` with its age. They are kept as soon as they are read, also when the call that brought them then fails (an unknown `taskType`, for example).
- Merging of `orchestrator_capabilities` outputs, passed with `mergeCapabilities: true` or as a list (also as one JSON string). The later output decides what both say: the options of a model listed again, whether each provider can run a child task, and the provider and model the orchestrator is on. Merged outputs keep T3's model order. `mergeCapabilities: true` with nothing to merge into reports `capabilitiesFrom: "call"` with a warning instead of claiming a merge.
- Warnings when T3 left models out of a short list, with the `search` to run. A provider's warning stays while its latest list is truncated, including a `search` output with more than 8 matches, and then suggests a narrower search; merging a search leaves the warning of the providers it did not list. A candidate from a truncated list says "newest listed" instead of "latest".
- `recommend_model` calls are handled one at a time, in the order they arrive, so calls sent together use the capabilities the first one brought.
- JSONL delegation log with outcomes, and statistics by task type and model. An empty provider or model is rejected instead of being logged and never counted.
- `mark_unavailable`: when a child cannot start because of a usage limit or its plan, the orchestrator marks the provider instance, or one model, until a given time (24 h by default). Marked candidates go after every other one, with the reason in theirs (or in `skipped` when they do not make the list); marks are saved in `unavailable.json` and listed by `get_stats`. A `failure` outcome still means poor quality and demotes nothing.
- One data directory, `~/.t3-autopilot` or `T3_AUTOPILOT_HOME` (a leading `~` is expanded, because MCP configurations pass it as written). On Linux and macOS the log, the marks and the capabilities cache are readable by their owner only. The JSON files are written atomically, with a short retry on Windows when another process has the file open.
- CLI: `snippet` (instructions for `CLAUDE.md` / `AGENTS.md`), `init-policy`, `--help` (`-h`, `help`) and `--version` (`-v`). The snippet asks for the complete `orchestrator_capabilities` output, never a trimmed copy: one without the models' options loses the effort settings.
- npm package `t3-autopilot`: the `t3-autopilot` command, the bundled default policy and the same functions as a typed ES module. A release workflow publishes it with provenance when a `v*` tag is pushed.
- Documentation: a plain-language README in English (`README.md`) and Spanish (`docs/README.es.md`) that installs with `npx -y t3-autopilot` and gives the rules file of Claude Code, Codex, Grok CLI and OpenCode, the technical reference in `docs/reference.md` and the drivers in `docs/providers.md`.
- Tests: unit and in-memory MCP tests with coverage thresholds, an end-to-end test over stdio, and a check of the packed tarball; CI on Linux, macOS and Windows with Node 22 and 24, plus lint (Biome) and `npm audit`.

### Changed

For those who ran it from a source checkout before this version:

- Node.js 22 or later is required (it was 20).
- The instructions snippet changed. Replace the paragraph in your `CLAUDE.md` / `AGENTS.md` with the output of `t3-autopilot snippet`.
- The technical part of the README moved to `docs/reference.md`.

[Unreleased]: https://github.com/pablosalme/t3-autopilot/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/pablosalme/t3-autopilot/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/pablosalme/t3-autopilot/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/pablosalme/t3-autopilot/releases/tag/v0.1.0
