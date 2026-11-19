# Contributing to t3-autopilot

Thanks for your interest. t3-autopilot is small on purpose: a stdio MCP server that recommends a provider, model and effort for T3 Code's `delegate_task`, driven by a YAML policy. Bug reports, model and provider updates, and focused pull requests are welcome.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report security problems privately as described in [SECURITY.md](SECURITY.md), not in an issue.

## Before you start

- Open an issue first for anything beyond a small, obvious fix. The templates ask for what is needed to reproduce a problem or to add a provider or model.
- Never paste secrets, API keys, emails or private paths into issues, fixtures or logs. `orchestrator_capabilities` output holds no credentials, but trim it to the providers that matter before sharing it.

## Setup

Development needs Node.js 22.12 or later (Vitest 5); the server itself runs on Node.js 20 or later.

```sh
git clone https://github.com/pablosalme/t3-autopilot.git
cd t3-autopilot
npm ci
```

## Checks

CI runs these on Linux, macOS and Windows with Node 20 and 22 (lint and the dependency audit once, Vitest on Node 22). Run them before opening a pull request:

```sh
npm run lint            # Biome: lint, format and import order (npm run format fixes them)
npm run typecheck
npm run test:coverage   # Vitest; fails below 90% statements, functions and lines or 85% branches
npm run build
npm run smoke           # the built server over stdio with several fixtures
npm run test:e2e        # end-to-end over stdio with the MCP SDK client (node:test)
npm run test:pack       # npm pack, install the tarball in a temporary project, run its bin
```

Tests never touch `~/.t3-autopilot`: they use temporary directories through `T3_AUTOPILOT_HOME`. Do the same when you try the server by hand.

Biome lints and formats TypeScript, the scripts and JSON config. It was chosen over ESLint with Prettier because it is one fast dev dependency with no plugins, and because typescript-eslint relies on the TypeScript JavaScript API, which the native TypeScript 7 compiler used here does not provide in the same form. Markdown, YAML and the JSON fixtures are not formatted.

## Project layout

| Path | What it is |
|---|---|
| `src/capabilities.ts` | Parses and merges `orchestrator_capabilities` output |
| `src/families.ts` | Resolves a model family to the newest matching model id |
| `src/recommend.ts` | Eligibility, candidate ranking, fallbacks and warnings |
| `src/effort.ts`, `src/usage.ts` | Effort options and usage thresholds |
| `src/policy.ts`, `policy/default.yaml` | Policy schema, merge rules and the bundled default |
| `src/log.ts` | JSONL delegation log and stats |
| `src/unavailable.ts` | Marks for providers and models that hit a usage limit or plan |
| `src/capabilitiesCache.ts`, `src/store.ts` | Capabilities saved for a restart; atomic JSON writes |
| `src/server.ts` | The five MCP tools |
| `src/cli.ts`, `src/cliMain.ts`, `src/snippet.ts` | CLI commands and the orchestrator snippet |
| `test/` | Vitest unit and in-memory MCP tests |
| `test/e2e/stdio.e2e.mjs` | End-to-end test over stdio (Node's test runner) |
| `test/fixtures/` | Invented `orchestrator_capabilities` outputs |
| `scripts/` | Smoke test and packed-tarball check |
| `docs/providers.md` | How each T3 Code driver is handled, with references to T3's source |

## Guidelines

- **Keep it a recommender.** No network requests, no reading provider credentials or T3 Code's files, no launching agents.
- **Families, not model ids.** Policy entries name families (regular expressions over model ids), so new versions are picked up without a release. Add a test in `test/families.test.ts` or `test/drivers.test.ts` for every new or changed pattern, including ids it must not match.
- **Default policy order.** The candidate order is an informed guess, not a benchmark. Explain a change in the pull request; data helps (`get_stats` from your own log, public evaluations).
- **New provider driver.** Add an invented fixture in `test/fixtures/drivers/` that follows the shape of a real `orchestrator_capabilities` output, cover it in `test/drivers.test.ts` and document it in `docs/providers.md`.
- **Invented model versions.** Fixtures and examples use made-up versions so they never read as claims about real models.
- **The snippet.** If you change `src/snippet.ts`, update the copy in the README; a test checks that they match.
- **Bug fixes come with a regression test.**

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `build:`, `ci:`, `chore:`, `style:`.
- Keep pull requests small and focused, fill in the template, and make sure CI passes.
- Add a line to [CHANGELOG.md](CHANGELOG.md) under **Unreleased** for changes users will notice.

## Releasing (maintainers)

The package is not on npm yet. To release:

1. Move the **Unreleased** entries in `CHANGELOG.md` under the new version and date.
2. Set the version in `package.json` and `VERSION` in `src/server.ts` (the end-to-end test checks that they match).
3. Tag `vX.Y.Z` on `main` and create the GitHub release.
4. `npm publish`: `prepublishOnly` runs the typecheck, tests and build, and `prepack` rebuilds `dist/` from scratch.
