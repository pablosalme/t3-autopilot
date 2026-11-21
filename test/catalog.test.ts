import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { Provider } from "../src/capabilities.js";
import {
  type AgentCatalog,
  agentProvider,
  agentView,
  builtinCatalogPath,
  checkCatalog,
  isToken,
  loadCatalog,
  mergeCatalog,
  resolveAgent,
  userCatalogPath,
} from "../src/catalog.js";
import { declaredFamily, resolveFamily, resolveFamilyDetail } from "../src/families.js";
import { defaultPolicy, tempDir } from "./helpers.js";

const policy = defaultPolicy();
const families = Object.keys(policy.families);

/** The built-in catalog, with no user file. */
function builtin(): AgentCatalog {
  return loadCatalog({ userPath: join(tempDir(), "missing.yaml"), families }).catalog;
}

/** The built-in catalog with `user` written as the user's catalog.yaml. */
function withUser(user: string) {
  const dir = tempDir();
  const userPath = join(dir, "catalog.yaml");
  writeFileSync(userPath, user);
  return loadCatalog({ userPath, families });
}

const builtinRaw = () => parse(readFileSync(builtinCatalogPath(), "utf8")) as Record<string, unknown>;
const family = (name: string) => policy.families[name]!;
/** The model a policy family resolves to on a provider, with the catalog hook on. */
const pick = (p: Provider, name: string) => resolveFamily(family(name), p, name)?.id;

describe("built-in agent catalog", () => {
  it("is valid with no warnings, and every family it names is a policy family", () => {
    const loaded = loadCatalog({ userPath: join(tempDir(), "missing.yaml"), families });
    expect(loaded.warnings).toEqual([]);
    expect(loaded.sources).toEqual([builtinCatalogPath()]);
    expect(Object.keys(loaded.catalog.agents)).toEqual(
      expect.arrayContaining(["claude", "codex", "cursor", "grok", "opencode", "pi", "kiro", "gemini"]),
    );
    expect(loaded.catalog.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("has no model id with a version: aliases and `default` only", () => {
    const catalog = builtin();
    for (const [id, agent] of Object.entries(catalog.agents)) {
      const models = [
        ...(agent.models ?? []),
        ...(agent.hosts?.orca?.models ?? []),
        ...(agent.hosts?.herdr?.models ?? []),
      ];
      for (const model of models) expect(model.id, `${id}: ${model.id}`).not.toMatch(/\d/);
    }
  });

  it("uses safe command-line words for every model id and effort", () => {
    for (const agent of Object.values(builtin().agents)) {
      for (const model of agent.models ?? []) {
        expect(isToken(model.id)).toBe(true);
        for (const e of model.efforts ?? []) expect(isToken(e)).toBe(true);
      }
      for (const e of agent.efforts ?? []) expect(isToken(e)).toBe(true);
    }
  });

  it("is in the package files", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { files: string[] };
    expect(pkg.files).toContain("catalog/agents.yaml");
  });
});

describe("isToken", () => {
  it("accepts model ids, aliases and provider/model ids", () => {
    for (const ok of [
      "opus",
      "opus[1m]",
      "claude-opus-9-2",
      "openai/gpt-9.1-sol",
      "us.anthropic.claude-opus-9-2-v1:0",
    ]) {
      expect(isToken(ok), ok).toBe(true);
    }
  });

  it("rejects spaces, shell characters, a leading dash and long values", () => {
    for (const bad of [
      "",
      "a b",
      "--dangerously-skip-permissions",
      "-m",
      "$(id)",
      "a;b",
      "a|b",
      "a&b",
      "`x`",
      "a'b",
      'a"b',
    ]) {
      expect(isToken(bad), bad).toBe(false);
    }
    expect(isToken("a".repeat(200))).toBe(true);
    expect(isToken("a".repeat(201))).toBe(false);
  });
});

describe("user catalog.yaml", () => {
  it("is read from the data directory ($T3_AUTOPILOT_HOME)", () => {
    // test/setup.ts points T3_AUTOPILOT_HOME at a temporary directory.
    const home = process.env.T3_AUTOPILOT_HOME!;
    expect(userCatalogPath()).toBe(join(home, "catalog.yaml"));
    mkdirSync(home, { recursive: true });
    writeFileSync(userCatalogPath(), "agents:\n  codex:\n    models: [gpt-9.2-codex]\n");
    try {
      const loaded = loadCatalog({ families });
      expect(loaded.sources).toEqual([builtinCatalogPath(), userCatalogPath()]);
      expect(loaded.catalog.agents.codex?.models).toEqual([{ id: "gpt-9.2-codex" }]);
    } finally {
      writeFileSync(userCatalogPath(), "");
    }
    expect(loadCatalog({ families }).catalog.agents.codex?.models).toEqual([{ id: "default", family: "gpt" }]);
  });

  it("merges each agent one level deep: a key replaces the built-in value, the rest stays", () => {
    const { catalog, warnings } = withUser(
      [
        "agents:",
        "  claude:",
        "    models: [opus, { id: claude-opus-9-2, efforts: [high, max] }]",
        "  codex:",
        "    efforts: [low, high]",
        "  goose: { driver: goose, models: [default] }",
      ].join("\n"),
    );
    expect(warnings).toEqual([]);
    expect(catalog.agents.claude).toMatchObject({
      driver: "claudeAgent",
      name: "Claude Code",
      models: [{ id: "opus" }, { id: "claude-opus-9-2", efforts: ["high", "max"] }],
      efforts: ["low", "medium", "high", "xhigh", "max"],
    });
    expect(catalog.agents.codex).toMatchObject({
      models: [{ id: "default", family: "gpt" }],
      efforts: ["low", "high"],
    });
    expect(catalog.agents.goose).toEqual({ driver: "goose", models: [{ id: "default" }] });
  });

  it("removes an agent, a key of an agent or an alias set to null", () => {
    const { catalog } = withUser(
      [
        "agents:",
        "  gemini: null",
        "  kiro:",
        "    hosts: null",
        "hosts:",
        "  orca:",
        "    aliases: { opencode2: null }",
      ].join("\n"),
    );
    expect(catalog.agents.gemini).toBeUndefined();
    expect(catalog.agents.kiro).toEqual({ driver: "kiro", name: "Kiro" });
    expect(catalog.hosts.orca?.aliases).toEqual({});
  });

  it("adds host aliases next to the built-in ones and replaces other host keys", () => {
    const base = builtinRaw();
    const merged = mergeCatalog(base, {
      hosts: { orca: { aliases: { oc: "opencode" } }, herdr: { aliases: { "kiro-cli": "kiro" } } },
    });
    expect((merged.hosts as Record<string, unknown>).orca).toEqual({
      aliases: { opencode2: "opencode", oc: "opencode" },
    });
    expect((merged.hosts as Record<string, unknown>).herdr).toEqual({ aliases: { "kiro-cli": "kiro" } });
    // A host section that is not a mapping, or aliases that are not one, replace what was there (and fail validation).
    expect(mergeCatalog(base, { hosts: { orca: { aliases: [] } } }).hosts).toMatchObject({ orca: { aliases: [] } });
    expect(mergeCatalog(base, { hosts: { orca: null } }).hosts).toEqual({});
    expect(mergeCatalog(base, { agents: { claude: "x" } }).agents).toMatchObject({ claude: "x" });
    // The base is not modified.
    expect(base).toEqual(builtinRaw());
  });

  it("ignores __proto__ keys", () => {
    const merged = mergeCatalog(
      { agents: {}, hosts: { orca: { aliases: {} } } },
      JSON.parse(
        '{"__proto__": {"x": 1}, "agents": {"__proto__": {}}, "hosts": {"__proto__": {}, "orca": {"aliases": {"__proto__": "a"}}}}',
      ),
    );
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(merged).toEqual({ agents: {}, hosts: { orca: { aliases: {} } } });
  });

  it("warns about unknown keys and ignores them", () => {
    const { catalog, warnings } = withUser(
      ["agentz: {}", "agents:", "  codex:", "    modles: [gpt-9.2-codex]", "    models: [{ id: x, famly: gpt }]"].join(
        "\n",
      ),
    );
    expect(warnings).toHaveLength(3);
    expect(warnings.join("\n")).toMatch(/unknown key "agentz" at the top level is ignored/);
    expect(warnings.join("\n")).toMatch(/unknown key "modles" under agents\.codex is ignored/);
    expect(warnings.join("\n")).toMatch(/unknown key "famly" under agents\.codex\.models\[0\] is ignored/);
    for (const w of warnings) expect(w).toMatch(/^Agent catalog \(.*catalog\.yaml, on top of the built-in catalog\): /);
    expect(catalog.agents.codex?.models).toEqual([{ id: "x" }]);
  });

  it("drops a family that is not in the policy, so the model is matched by its id", () => {
    const { catalog, warnings } = withUser("agents:\n  claude:\n    models: [{ id: opus, family: claude-opuss }]\n");
    expect(warnings).toEqual([
      expect.stringMatching(/agents\.claude\.models\[0\]: "claude-opuss" is not a policy family/),
    ]);
    expect(catalog.agents.claude?.models).toEqual([{ id: "opus" }]);
    // Without the policy's families there is nothing to check against.
    expect(
      checkCatalog({ version: 1, agents: { a: { models: [{ id: "m", family: "nope" }] } } }, "test").warnings,
    ).toEqual([]);
  });

  it("keeps the first of a model listed twice, in an agent or a host override", () => {
    const { catalog, warnings } = withUser(
      "agents:\n  pi:\n    models: [openai/gpt-9.1-sol, openai/gpt-9.1-sol]\n    hosts: { orca: { models: [a, a] } }\n",
    );
    expect(warnings).toEqual([
      expect.stringMatching(/agents\.pi\.models\[1\]: model "openai\/gpt-9\.1-sol" is listed twice/),
      expect.stringMatching(/agents\.pi\.hosts\.orca\.models\[1\]: model "a" is listed twice/),
    ]);
    expect(catalog.agents.pi?.models).toEqual([{ id: "openai/gpt-9.1-sol" }]);
    expect(catalog.agents.pi?.hosts?.orca?.models).toEqual([{ id: "a" }]);
  });

  it("ignores an alias to an agent the catalog does not have, or one that hides an agent", () => {
    const { catalog, warnings } = withUser("hosts:\n  orca:\n    aliases: { goose2: goose, codex: claude }\n");
    expect(warnings).toEqual([
      expect.stringMatching(/hosts\.orca\.aliases\.goose2: "goose" is not an agent of the catalog/),
      expect.stringMatching(/hosts\.orca\.aliases\.codex: "codex" is an agent of the catalog/),
    ]);
    expect(catalog.hosts.orca?.aliases).toEqual({ opencode2: "opencode" });
  });

  it("rejects model ids and efforts that are not one safe word", () => {
    for (const bad of [
      "agents:\n  codex:\n    models: [--dangerously-bypass-approvals-and-sandbox]\n",
      'agents:\n  codex:\n    models: ["gpt 6"]\n',
      'agents:\n  codex:\n    models: ["$(touch x)"]\n',
      'agents:\n  codex:\n    efforts: ["high;rm"]\n',
      "agents:\n  codex:\n    hosts: { orca: { models: [-x] } }\n",
      "agents:\n  bad:id: {}\n",
      "hosts:\n  orca:\n    aliases: { '-x': codex }\n",
    ]) {
      expect(() => withUser(bad), bad).toThrow(
        /Invalid agent catalog \(.*catalog\.yaml, on top of the built-in catalog\)/,
      );
    }
  });

  it("rejects a wrong version, a malformed date and a wrong type, even next to an unknown key", () => {
    expect(() => withUser("version: 2\n")).toThrow(/Invalid agent catalog/);
    expect(() => withUser("updated: yesterday\n")).toThrow(/must be a date/);
    expect(() => withUser("agents:\n  claude:\n    models: opus\n    modles: []\n")).toThrow(/Invalid agent catalog/);
    expect(() => withUser("hosts:\n  orca: { aliases: [opencode] }\n")).toThrow(/Invalid agent catalog/);
  });

  it("accepts an empty file, and rejects a file that is not a YAML mapping or not YAML", () => {
    expect(withUser("").warnings).toEqual([]);
    expect(() => withUser("- a\n- b\n")).toThrow(/expected a YAML mapping at the top level/);
    expect(() => withUser("agents: [\n")).toThrow(/cannot read agent catalog YAML/);
  });
});

describe("resolveAgent and agentView", () => {
  const catalog = builtin();

  it("resolves an agent id, and a host's alias in that host only", () => {
    expect(resolveAgent(catalog, "orca", "codex")).toBe("codex");
    expect(resolveAgent(catalog, "orca", "opencode2")).toBe("opencode");
    expect(resolveAgent(catalog, "herdr", "opencode2")).toBeUndefined();
    expect(resolveAgent(catalog, "orca", "goose")).toBeUndefined();
    expect(resolveAgent(catalog, "orca", "__proto__")).toBeUndefined();
  });

  it("offers only `default` where the host rejects a model at launch", () => {
    expect(agentView(catalog, "orca", "kiro")).toMatchObject({ selectsModel: false, models: [{ id: "default" }] });
    expect(agentView(catalog, "herdr", "kiro")).toMatchObject({ selectsModel: true, models: [{ id: "default" }] });
    // A declared `default` keeps its family and efforts when it is the only model left.
    const { catalog: c } = withUser(
      "agents:\n  kiro:\n    models: [{ id: default, family: claude-sonnet }, { id: claude-sonnet-9 }]\n",
    );
    expect(agentView(c, "orca", "kiro").models).toEqual([{ id: "default", family: "claude-sonnet" }]);
    expect(agentView(c, "herdr", "kiro").models).toHaveLength(2);
  });

  it("applies the host's models, efforts and note", () => {
    const { catalog: c } = withUser(
      "agents:\n  codex:\n    hosts: { orca: { models: [gpt-9.2-codex], efforts: [high], note: pinned } }\n",
    );
    expect(agentView(c, "orca", "codex")).toEqual({
      id: "codex",
      known: true,
      driver: "codex",
      name: "Codex",
      models: [{ id: "gpt-9.2-codex" }],
      efforts: ["high"],
      selectsModel: true,
      note: "pinned",
    });
    expect(agentView(c, "herdr", "codex").models).toEqual([{ id: "default", family: "gpt" }]);
  });

  it("gives an agent the catalog does not know only `default`, with its own id as driver", () => {
    expect(agentView(catalog, "herdr", "goose")).toEqual({
      id: "goose",
      known: false,
      driver: "goose",
      name: "goose",
      models: [{ id: "default" }],
      efforts: [],
      selectsModel: true,
    });
    const { catalog: c } = withUser("agents:\n  amp: {}\n");
    expect(agentView(c, "herdr", "amp")).toMatchObject({
      known: true,
      driver: "amp",
      name: "amp",
      models: [{ id: "default" }],
    });
  });
});

describe("agentProvider", () => {
  const catalog = builtin();

  it("builds a provider whose models carry their family and an effort option", () => {
    const claude = agentProvider(catalog, "orca", "claude");
    expect(claude).toMatchObject({
      providerInstanceId: "claude",
      driverKind: "claudeAgent",
      displayName: "Claude Code",
      omittedModels: 0,
      canRunChildTask: true,
      constraints: [],
    });
    expect(claude.models.map((m) => m.id)).toEqual(["opus", "sonnet", "haiku", "fable"]);
    expect(claude.models[0]).toEqual({
      id: "opus",
      policyFamily: "claude-opus",
      options: [{ id: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
    });
    // haiku takes no effort; Cursor writes it into the model id.
    expect(claude.models[2]).toEqual({ id: "haiku", policyFamily: "claude-haiku" });
    expect(agentProvider(catalog, "herdr", "cursor").models).toEqual([{ id: "auto" }]);
  });

  it("resolves an alias to its agent", () => {
    expect(agentProvider(catalog, "orca", "opencode2")).toMatchObject({
      providerInstanceId: "opencode",
      driverKind: "opencode",
      models: [{ id: "default" }],
    });
  });
});

describe("catalog aliases and policy families (the policyFamily hook)", () => {
  const catalog = builtin();

  it("resolve each alias to its family", () => {
    const claude = agentProvider(catalog, "orca", "claude");
    expect(pick(claude, "claude-opus")).toBe("opus");
    expect(pick(claude, "claude-sonnet")).toBe("sonnet");
    expect(pick(claude, "claude-haiku")).toBe("haiku");
    expect(pick(claude, "claude-fable")).toBe("fable");
    expect(pick(agentProvider(catalog, "orca", "codex"), "gpt")).toBe("default");
    expect(pick(agentProvider(catalog, "herdr", "grok"), "grok-build")).toBe("default");
    // A declared family is the model's only one: `default` on Codex is not a small GPT.
    expect(pick(agentProvider(catalog, "orca", "codex"), "gpt-mini")).toBeUndefined();
    expect(pick(agentProvider(catalog, "orca", "cursor"), "composer")).toBeUndefined();
  });

  it("are invisible without the family name, as T3 calls it today", () => {
    expect(resolveFamily(family("claude-opus"), agentProvider(catalog, "orca", "claude"))).toBeUndefined();
    expect(resolveFamily(family("gpt"), agentProvider(catalog, "orca", "codex"))).toBeUndefined();
  });

  it("lose to a versioned id of the same family, in either order", () => {
    for (const models of [
      "[{ id: opus, family: claude-opus }, claude-opus-9-2]",
      "[claude-opus-9-2, { id: opus, family: claude-opus }]",
    ]) {
      const { catalog: c } = withUser(`agents:\n  claude:\n    models: ${models}\n`);
      const p = agentProvider(c, "orca", "claude");
      expect(resolveFamilyDetail(family("claude-opus"), p, "claude-opus")).toEqual({
        model: {
          id: "claude-opus-9-2",
          options: [{ id: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
        },
        ties: 0,
      });
    }
    // A versioned id that also declares the family keeps its version: the newest still wins.
    const { catalog: c } = withUser(
      "agents:\n  claude:\n    models: [opus, { id: claude-opus-8-1, family: claude-opus }, claude-opus-9-2]\n",
    );
    expect(pick(agentProvider(c, "orca", "claude"), "claude-opus")).toBe("claude-opus-9-2");
  });

  it("tie with each other: the first listed wins and the rest count as ties", () => {
    const p: Provider = {
      providerInstanceId: "claude",
      driverKind: "claudeAgent",
      canRunChildTask: true,
      models: [
        { id: "opus", policyFamily: "claude-opus" },
        { id: "opus[1m]", policyFamily: "claude-opus" },
      ],
    };
    expect(resolveFamilyDetail(family("claude-opus"), p, "claude-opus")).toEqual({ model: p.models[0], ties: 1 });
  });

  it("take a model out of the family its id would match when it declares another one", () => {
    const p: Provider = {
      providerInstanceId: "codex",
      driverKind: "codex",
      canRunChildTask: true,
      models: [
        { id: "gpt-9.2-codex", policyFamily: "gpt-mini" },
        { id: "gpt-9-luna", policyFamily: "gpt" },
      ],
    };
    // gpt-9.2-codex would be a gpt and gpt-9-luna (excluded from gpt) a gpt-mini; what they declare wins.
    expect(resolveFamilyDetail(family("gpt"), p, "gpt")).toEqual({ model: p.models[1], ties: 0 });
    expect(resolveFamilyDetail(family("gpt-mini"), p, "gpt-mini")).toEqual({ model: p.models[0], ties: 0 });
    // Without the name, the regex alone decides, as before.
    expect(resolveFamily(family("gpt"), p)?.id).toBe("gpt-9.2-codex");
    expect(resolveFamily(family("gpt-mini"), p)?.id).toBe("gpt-9-luna");
  });

  it("read only a string policyFamily", () => {
    expect(declaredFamily({ id: "x" })).toBeUndefined();
    expect(declaredFamily({ id: "x", policyFamily: 3 })).toBeUndefined();
    expect(declaredFamily({ id: "x", policyFamily: "gpt" })).toBe("gpt");
  });
});
