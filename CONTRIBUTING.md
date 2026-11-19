# Contributing to t3-autopilot

Thanks for your interest. t3-autopilot is small on purpose: a stdio MCP server that recommends a provider, model and effort for T3 Code's `delegate_task`, driven by a YAML policy. Bug reports, model and provider updates, and focused pull requests are welcome.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Report security problems privately as described in [SECURITY.md](SECURITY.md), not in an issue.

## Before you start

- Open an issue first for anything beyond a small, obvious fix. The templates ask for what is needed to reproduce a problem or to add a provider or model.
- Never paste secrets, API keys, emails or private paths into issues, fixtures or logs. `orchestrator_capabilities` output holds no credentials, but trim it to the providers that matter before sharing it.

## Setup

You need Node.js 22 or later, the same as the server; use the latest 22 or 24 release, because Vitest 5 needs 22.12 or later.

```sh
git clone https://github.com/pablosalme/t3-autopilot.git
cd t3-autopilot
npm ci
```

## Checks

CI runs these on Linux, macOS and Windows with Node 22 and 24 (lint and the dependency audit once, on Linux with Node 24). Run them before opening a pull request:

```sh
npm run lint            # Biome: lint, format and import order (npm run format fixes them)
npm run typecheck
npm run test:coverage   # Vitest; fails below 90% statements, functions and lines or 85% branches
npm run build           # removes dist/ and compiles src/ again
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
| `.github/workflows/` | CI (`ci.yml`) and the npm release (`release.yml`) |
| `docs/reference.md` | The technical reference: tools, policy, data files |
| `docs/providers.md` | How each T3 Code driver is handled, with references to T3's source |
| `docs/README.es.md` | The README in Spanish |

## Guidelines

- **Keep it a recommender.** No network requests, no reading provider credentials or T3 Code's files, no launching agents.
- **Families, not model ids.** Policy entries name families (regular expressions over model ids), so new versions are picked up without a release. Add a test in `test/families.test.ts` or `test/drivers.test.ts` for every new or changed pattern, including ids it must not match.
- **Default policy order.** The candidate order is an informed guess, not a benchmark. Explain a change in the pull request; data helps (`get_stats` from your own log, public evaluations).
- **New provider driver.** Add an invented fixture in `test/fixtures/drivers/` that follows the shape of a real `orchestrator_capabilities` output, cover it in `test/drivers.test.ts` and document it in `docs/providers.md`.
- **Invented model versions.** Fixtures and examples use made-up versions so they never read as claims about real models.
- **The snippet.** If you change `src/snippet.ts`, update its two copies, in `README.md` and in `docs/README.es.md` (in English in both); a test in `test/cli.test.ts` checks that they match word for word.
- **One README at the root.** Translations go in `docs/` (`docs/README.es.md`). npm packs every `README.*` at the root and takes the first one its directory listing returns as the package's front page, so a `README.es.md` next to `README.md` could replace it on npmjs.com; `npm run test:pack` fails if the package has one.
- **Bug fixes come with a regression test.**

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `build:`, `ci:`, `chore:`, `style:`.
- Keep pull requests small and focused, fill in the template, and make sure CI passes.
- Add a line to [CHANGELOG.md](CHANGELOG.md) for changes users will notice: under **Unreleased**. When the version is released, that heading becomes `## [X.Y.Z] - YYYY-MM-DD` (see Releasing below).

## Releasing (maintainers)

Releases are published on npm by `.github/workflows/release.yml` when a `v*` tag is pushed. The workflow signs in with [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC): it uses no npm token and the repository holds no npm secret. On npmjs.com, the settings of `t3-autopilot` list a trusted publisher for GitHub Actions with the user `pablosalme`, the repository `t3-autopilot`, the workflow file `release.yml`, no environment, and `npm publish` among the allowed actions. Those values must match exactly, so renaming the workflow file or moving the repository means setting up the trusted publisher again. Trusted publishing needs npm 11.5.1 or later, which the workflow checks before it publishes.

1. Move the **Unreleased** entries in `CHANGELOG.md` under the new version and date, and update the links at the end of the file.
2. Set the version in `package.json` and `package-lock.json` (`npm version X.Y.Z --no-git-tag-version`) and `VERSION` in `src/server.ts` (the end-to-end test checks that they match).
3. Merge that into `main` and wait for CI to pass.
4. Tag `vX.Y.Z` on `main` and push the tag. The workflow checks that the tag matches `package.json`, is on `main` and has a dated entry in `CHANGELOG.md` (`## [X.Y.Z] - YYYY-MM-DD`), runs every check and then `npm publish --access public`. npm attaches the provenance statement on its own, because the repository and the package are public.
5. Create the GitHub release for the tag with the changelog entry.

To publish by hand instead, run `npm publish --access public` from a clean checkout of the tag: `prepublishOnly` runs the lint, the typecheck and the unit tests, and `prepare` rebuilds `dist/` from scratch before npm packs it. A package published by hand has no provenance.
