#!/usr/bin/env node
import { runCli } from "./cliMain.js";

runCli(process.argv.slice(2)).then(
  (code) => {
    if (code !== 0) process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(`t3-autopilot: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  },
);
