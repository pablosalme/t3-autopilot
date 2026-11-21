import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ALL_HOSTS, allHostsSnippet, DEFAULT_HOST, HOSTS } from "./hosts/index.js";
import type { HostAdapter } from "./hosts/types.js";
import { userPolicyPath } from "./paths.js";
import { createServer, VERSION } from "./server.js";

/**
 * What `init-policy` writes: a short commented template. Everything not set
 * here comes from the bundled default, so future default updates still apply.
 */
export const POLICY_TEMPLATE = `# t3-autopilot policy override. Keys here replace the bundled default
# (policy/default.yaml in the package); everything else comes from it.
# Merge rules: entries under families and taskTypes replace the default entry
# with the same name (null removes it); usage and effortShift merge one level
# deep; any other key replaces the default. Re-read on every call.

# Never recommend these provider instances (ids from orchestrator_capabilities):
# excludeProviders: [cursor-work]

# Return fewer candidates:
# maxCandidates: 2

# Demote a provider earlier when its weekly window is busy:
# usage:
#   thresholds: { weekly: 60 }

# Add a model family (a regex over model ids; "*" = any driver):
# families:
#   my-model:
#     search: my-model
#     match:
#       '*': '^(?:[\\w.-]+/)*my-model-(\\d+)(?:\\.(\\d+))?$'

# Change the candidates of a task type (the whole entry is replaced):
# taskTypes:
#   quick:
#     description: Small mechanical edits.
#     keywords: [rename, typo, bump]
#     candidates:
#       - { provider: opencode, family: opencode-free }
#       - { provider: '*', family: claude-haiku, effort: low }
`;

/** The usage text. `snippet --host` is listed once there is a host besides the default one. */
export function helpText(hosts: readonly HostAdapter[] = HOSTS): string {
  const others = hosts.slice(1).map((h) => h.id);
  const snippetHost = others.length
    ? `  t3-autopilot snippet --host <id> Print another host's instructions (${others.join(", ")}), or every host's (${ALL_HOSTS}).\n`
    : "";
  return `t3-autopilot ${VERSION}: model selection MCP server for T3 Code orchestrators.

Usage:
  t3-autopilot [serve]             Start the MCP server on stdio (what your agent CLI runs).
  t3-autopilot snippet             Print the instructions to paste into CLAUDE.md / AGENTS.md.
${snippetHost}  t3-autopilot init-policy         Write a commented override template to the user policy path.
  t3-autopilot --help | -h | help  Print this text.
  t3-autopilot --version | -v      Print the version.

Data directory: $T3_AUTOPILOT_HOME or ~/.t3-autopilot (policy.yaml, log.jsonl,
capabilities-cache.json, unavailable.json).
`;
}

export const HELP = helpText();

export interface CliIo {
  out: (s: string) => void;
  err: (s: string) => void;
}

const stdio: CliIo = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) };

/** Run one CLI command; returns the exit code. `serve` keeps running. `hosts`: the registry's, for tests. */
export async function runCli(
  argv: string[],
  io: CliIo = stdio,
  hosts: readonly HostAdapter[] = HOSTS,
): Promise<number> {
  const cmd = argv[0];
  switch (cmd) {
    case undefined:
    case "serve": {
      const server = createServer();
      await server.connect(new StdioServerTransport());
      return 0;
    }
    case "snippet": {
      if (argv[1] !== "--host") {
        io.out((hosts[0] ?? DEFAULT_HOST).snippet);
        return 0;
      }
      const id = argv[2];
      if (id === ALL_HOSTS) {
        io.out(allHostsSnippet(hosts));
        return 0;
      }
      const host = hosts.find((h) => h.id === id);
      if (!host) {
        const known = `${hosts.map((h) => h.id).join(", ")}, or ${ALL_HOSTS} for every host`;
        io.err(
          id === undefined
            ? `snippet --host needs a host: ${known}.\n`
            : `Unknown host "${id}". Known hosts: ${known}.\n`,
        );
        return 2;
      }
      io.out(host.snippet);
      return 0;
    }
    case "init-policy": {
      const target = userPolicyPath();
      if (existsSync(target)) {
        io.err(`${target} already exists; not overwritten.\n`);
        return 1;
      }
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, POLICY_TEMPLATE, "utf8");
      io.out(`Wrote ${target}. Uncomment what you want to change; the rest comes from the default policy.\n`);
      return 0;
    }
    case "--version":
    case "-v":
      io.out(`${VERSION}\n`);
      return 0;
    case "--help":
    case "-h":
    case "help":
      io.out(helpText(hosts));
      return 0;
    default:
      io.err(`Unknown command "${cmd}".\n\n${helpText(hosts)}`);
      return 2;
  }
}
