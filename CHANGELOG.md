# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - Unreleased

First public version. Not tagged or published on npm yet: the date replaces "Unreleased" on release day.

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

[Unreleased]: https://github.com/pablosalme/t3-autopilot/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/pablosalme/t3-autopilot/releases/tag/v0.1.0
