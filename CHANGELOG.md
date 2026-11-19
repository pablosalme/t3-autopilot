# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

First public version, planned as 0.1.0. Not tagged or published on npm yet.

### Added

- stdio MCP server with four tools: `recommend_model`, `log_delegation`, `log_outcome` and `get_stats`.
- Family-based policy (`policy/default.yaml`) with eight task types (`review`, `debug`, `plan`, `research`, `quick`, `code`, `design`, `writing`) and a user override in `~/.t3-autopilot/policy.yaml`, re-read on every call.
- Model families resolved to the newest matching model id on every eligible provider instance, for the eleven drivers T3 Code ships and several instances of the same driver.
- Up to three candidates per task, ready for `delegate_task.target`, with a reason each; policy fallback list, generic fallback (a provider's default model, low confidence) and the orchestrator's own model as a last resort.
- Reasoning effort per candidate, shifted by `size` and `criticality` and clamped to what each model supports.
- Ordering by usage limits passed in the call, and a different provider than the orchestrator's for independent reviews.
- Capabilities kept between calls, in memory and in `capabilities-cache.json` (written atomically) so a server restart between turns does not lose them; the saved copy is reused for `capabilitiesCacheTtlHours` (12 by default) and a result built on it says `capabilitiesFrom: "disk-cache"` with its age. Merging of `orchestrator_capabilities` `search` outputs, with warnings when T3 left models out of a short list.
- JSONL delegation log with outcomes, and statistics by task type and model.
- CLI: `snippet` (instructions for `CLAUDE.md` / `AGENTS.md`), `init-policy`, `--help` and `--version`.
- Tests: unit and in-memory MCP tests with coverage thresholds, an end-to-end test over stdio, and a check of the packed tarball; CI on Linux, macOS and Windows with Node 20 and 22, plus lint (Biome) and `npm audit`.

### Fixed

- The omitted-models warning of a provider stays while its latest list is truncated, including a `search` output with more than 8 matches, and suggests a narrower search; a candidate from a truncated list says "newest listed" instead of "latest".
- A model picked over others with the same version is no longer called the latest: its reason says how many share the version and that T3 lists it first. Merged outputs keep T3's model order, so that tie-break still follows the user's order.
- Default policy: Muse Spark and Muse Wonder are separate families (`muse-spark`, `muse-wonder`), so one tier's higher version number no longer hides the other; Gemini ids with a date at the end (`gemini-2.5-pro-preview-06-05`, `gemini-2.0-flash-001`) match their family, and the date never counts as a version.
- Merging a `search` output no longer clears the omitted-models warning of providers the search did not list.
- `mergeCapabilities: true` with nothing to merge into now reports `capabilitiesFrom: "call"` with a warning instead of claiming a merge.
- Policy validation errors name the user's policy file instead of listing both files.

[Unreleased]: https://github.com/pablosalme/t3-autopilot/commits/main
