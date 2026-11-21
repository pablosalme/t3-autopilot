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
| `src/capabilities.ts` | The canonical catalog the engine reads (the shape of `orchestrator_capabilities`); parses and merges T3's outputs |
| `src/hosts/` | The hosts: `types.ts` (the `HostAdapter` contract), `index.ts` (the registry), `t3.ts` (T3 Code). See [Adding a host](#adding-a-host) |
| `src/families.ts` | Resolves a model family to the newest matching model id |
| `src/recommend.ts` | Eligibility, candidate ranking, fallbacks and warnings |
| `src/effort.ts`, `src/usage.ts` | Effort options and usage thresholds |
| `src/policy.ts`, `policy/default.yaml` | Policy schema, merge rules and the bundled default |
| `src/catalog.ts`, `catalog/agents.yaml` | Agent catalog for hosts that do not list models (Orca, herdr): schema, merge rules and the bundled catalog |
| `src/log.ts` | JSONL delegation log and stats |
| `src/unavailable.ts` | Marks for providers and models that hit a usage limit or plan |
| `src/subscriptions.ts` | Subscription profiles per provider instance (`subscriptions.yaml`) and how they rank candidates |
| `src/capabilitiesCache.ts`, `src/store.ts` | Capabilities saved for a restart; atomic JSON writes |
| `src/server.ts` | The seven MCP tools |
| `src/cli.ts`, `src/cliMain.ts`, `src/snippet.ts` | CLI commands and the orchestrator snippet |
| `test/` | Vitest unit and in-memory MCP tests; `test/fakeHost.ts` is a host that exists only in the tests |
| `test/compat/` | The schemas 0.1.3 reads its data files with, and checks that both versions can share a data directory |
| `test/golden.test.ts`, `test/golden/` | Golden snapshots of what a T3 Code orchestrator gets: tool results, errors, tool schemas, files written, CLI output |
| `test/e2e/stdio.e2e.mjs` | End-to-end test over stdio (Node's test runner) |
| `test/fixtures/` | Invented `orchestrator_capabilities` outputs |
| `scripts/` | Smoke test and packed-tarball check |
| `.github/workflows/` | CI (`ci.yml`) and the npm release (`release.yml`) |
| `docs/reference.md` | The technical reference: tools, policy, data files |
| `docs/providers.md` | How each T3 Code driver is handled, with references to T3's source |
| `docs/README.es.md` | The README in Spanish |

## Adding a host

A host is the app the orchestrator runs in and starts children with. T3 Code is the only one so far. The engine (`recommend.ts`, `families.ts`, `effort.ts`, `subscriptions.ts`, `unavailable.ts`, `log.ts`) does not know which host it serves: whatever is specific to one goes through its `HostAdapter` (`src/hosts/types.ts`). A new host is a file in `src/hosts/` that exports its adapter, and one line in the `HOSTS` list of `src/hosts/index.ts`; from there the tools accept it as `host`, `recommend_model` recognises its payload, and `t3-autopilot snippet --host <id>` prints its snippet (the help lists `--host` once there are two hosts). The first host in that list (T3 Code) serves every call that names no host and that no payload tells apart, as in every 0.1 version.

| Member | What it is |
|---|---|
| `id` | Short lower-case id (`t3`). |
| `name` | The host's name for people (`T3 Code`), used in messages. |
| `keyPrefix` | What its ids carry in the data files: `""` for T3 Code only (its ids are stored as in 0.1), `<id>:` for every other host. |
| `cacheFile` | `capabilities-cache.<id>.json`: the file in the data directory where the server keeps the host's capabilities for a restart, one entry per session. |
| `legacyCacheFile` | T3 Code only: `capabilities-cache.json`, the single copy 0.1 reads and writes, kept as the last entry saved and read by a call that names no session. Leave it out for any other host: such a call gets the entry the host saved last. |
| `merges` | Whether the host sends its catalog in several outputs that the server merges (T3's short lists plus `search`). When `false`, `mergeCapabilities` is ignored with a warning. |
| `text` | The phrases of the results that name the host or its tools: how to get the catalog (`capture`), the error when there is none (`noCatalog`), the warning for `mergeCapabilities` with nothing to merge into (`nothingToMerge`), the last catalog in a warning (`lastCatalog`), and the four phrases of the engine (`noProviders`, `enable`, `listOrder`, `firstListed`, from `RecommendText` in `src/recommend.ts`). |
| `snippet` | The instructions the user pastes into the orchestrator's `CLAUDE.md` or `AGENTS.md`. |
| `detect(payload)` | Whether a `capabilities` payload has this host's shape. It must not accept another host's payload. |
| `catalog(input, ctx)` | Turns the host's payload (`input.capabilities`, exactly as the orchestrator passed it) into the canonical catalog: `{ capabilities, outputs, session, notes }`; `session` is the orchestrator session the payload names, if any (T3: `parentThreadId`), under which the server saves the capabilities when the call names none. It throws, with a message that says what to pass, when the payload is not valid. `ctx` has the data directory, the clock, the policy in force and the platform. |
| `launch(candidate, ctx)` | Optional. For a host that starts children with a command: a `Launch` added to each candidate as `launch` (`mode`, `agent`, `model`, `effort`, the selection tokens in `args`, the recommended command in `argv`, one element per argument, never a shell string; the brief goes in a file). Throw to leave a candidate out (a token that fails validation); the message goes into `skipped`. T3 Code has none: its candidate is already `delegate_task.target`. |

The canonical catalog is `Capabilities` in `src/capabilities.ts`, the shape of T3's `orchestrator_capabilities` output: one provider per agent the host can start, with `providerInstanceId` (the id the orchestrator passes back to start it), `driverKind` (the policy's driver, such as `claudeAgent` or `codex`, so families and `provider:` rules apply), `models` (each with its options; an effort option has an id from the policy's `effortOptionIds`), `canRunChildTask` and `constraints`, and the orchestrator's own agent and model in `inheritedProviderInstanceId` and `inheritedModel`. `outputs` is the number of outputs a list held (0 for one), and `notes` go into the result's `warnings`.

The server keeps each host apart, so an adapter never handles prefixes or state: marks, subscription profiles, log records and the policy's `excludeProviders` and `instance` ids are stored with the host's `keyPrefix`, and before the engine runs they are shown as the host sees them (`viewOf`, `viewItems` and `viewPolicy` in `src/hosts/index.ts`): its own ids bare, the other hosts' with their prefix (T3's as `t3:<id>`). The engine then recommends only the host's providers, yet sees the quota pool mates of other hosts. Tool results outside T3 Code carry `host`; every new field stays out of T3's results, which the golden snapshots check.

`detect` runs in the order of `HOSTS`, and T3's takes any array (a bare `providers` list), so a host whose payload is a list cannot be told apart: its snippet must always pass `host`. Inputs that only hosts without a model list need, such as the orchestrator's own agent and model or models declared in the call, are not in `CallInput` yet: the first adapter that reads one adds it there and to `recommend_model`'s schema, as an optional parameter.

A host's tests use an anonymized fixture of its real output, cover `detect`, `catalog` and `launch`, and leave the T3 [golden snapshots](#guidelines) as they are. `test/hosts.test.ts` runs the server with an adapter, `test/host-scope.test.ts` checks that a host's marks, profiles, log and policy ids stay apart from T3's with the fake host of `test/fakeHost.ts`, and `test/compat/` checks the files against the schemas of 0.1.3.

## Guidelines

- **Keep it a recommender.** No network requests, no reading provider credentials or T3 Code's files, no launching agents.
- **Families, not model ids.** Policy entries name families (regular expressions over model ids), so new versions are picked up without a release. Add a test in `test/families.test.ts` or `test/drivers.test.ts` for every new or changed pattern, including ids it must not match.
- **No versioned model ids in the agent catalog.** `catalog/agents.yaml` lists only aliases the CLI resolves to its newest model (`opus`) and `default`, tied with `family` to a policy family when no family regex matches them. Versioned ids go stale; they belong in the user's `catalog.yaml`. A test in `test/catalog.test.ts` fails on any model id with a digit.
- **Agent CLI flags.** Check every `exe`, `args`, `flags` or `prompt` you add or change in `catalog/agents.yaml` against the CLI's `--help` (only `--help` and `--version`: never start an agent session), set the agent's `checked` to the version you read, update `updated`, and the "Flags checked" table in `docs/reference.md`. Leave `checked` out, and say so in a comment, for flags taken from another source.
- **Default policy order.** The candidate order is an informed guess, not a benchmark. Explain a change in the pull request; data helps (`get_stats` from your own log, public evaluations).
- **New provider driver.** Add an invented fixture in `test/fixtures/drivers/` that follows the shape of a real `orchestrator_capabilities` output, cover it in `test/drivers.test.ts` and document it in `docs/providers.md`.
- **Invented model versions.** Fixtures and examples use made-up versions so they never read as claims about real models.
- **The snippet.** If you change `src/snippet.ts`, update its two copies, in `README.md` and in `docs/README.es.md` (in English in both); a test in `test/cli.test.ts` checks that they match word for word.
- **One README at the root.** Translations go in `docs/` (`docs/README.es.md`). npm packs every `README.*` at the root and takes the first one its directory listing returns as the package's front page, so a `README.es.md` next to `README.md` could replace it on npmjs.com; `npm run test:pack` fails if the package has one.
- **Golden snapshots.** `test/golden/` freezes what a T3 Code orchestrator gets: the results of a series of tool calls, the error messages, each tool's description and 0.1.3 parameters, the files the server writes and the CLI's output. A change that is not meant to alter T3's behaviour leaves them byte for byte as they are. Update them (`npx vitest run test/golden.test.ts -u`) only in a pull request that says what changes for T3 and why.
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
