#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { defaultPolicyPath, userPolicyPath } from "./paths.js";
import { createServer, VERSION } from "./server.js";
import { INSTRUCTIONS_SNIPPET } from "./snippet.js";

const HELP = `t3-autopilot ${VERSION}: model selection MCP server for T3 Code orchestrators.

Usage:
  t3-autopilot              Start the MCP server on stdio (what your agent CLI runs).
  t3-autopilot snippet      Print the instructions to paste into CLAUDE.md / AGENTS.md.
  t3-autopilot init-policy  Copy the default policy to ${userPolicyPath()} for editing.
  t3-autopilot --help | --version

Data directory: $T3_AUTOPILOT_HOME or ~/.t3-autopilot (policy.yaml, log.jsonl).
`;

async function main(argv: string[]): Promise<void> {
  const cmd = argv[0];
  switch (cmd) {
    case undefined:
    case "serve": {
      const server = createServer();
      await server.connect(new StdioServerTransport());
      return;
    }
    case "snippet":
      process.stdout.write(INSTRUCTIONS_SNIPPET);
      return;
    case "init-policy": {
      const target = userPolicyPath();
      if (existsSync(target)) {
        process.stderr.write(`${target} already exists; not overwritten.\n`);
        process.exitCode = 1;
        return;
      }
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(defaultPolicyPath(), target);
      process.stdout.write(`Wrote ${target}. Delete the entries you do not change; the rest comes from the default.\n`);
      return;
    }
    case "--version":
    case "-v":
      process.stdout.write(`${VERSION}\n`);
      return;
    case "--help":
    case "-h":
    case "help":
      process.stdout.write(HELP);
      return;
    default:
      process.stderr.write(`Unknown command "${cmd}".\n\n${HELP}`);
      process.exitCode = 2;
  }
}

main(process.argv.slice(2)).catch((e: unknown) => {
  process.stderr.write(`t3-autopilot: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
