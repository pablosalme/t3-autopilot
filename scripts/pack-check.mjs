// Checks the package as npm would publish it: packs it, checks the file
// list, installs the tarball in an empty temporary project and runs the
// installed `t3-autopilot` bin, including the end-to-end stdio test
// (test/e2e/stdio.e2e.mjs) against it. Needs network access for the
// dependencies of the installed package.
// Usage: npm run build && npm run test:pack
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const win = process.platform === "win32";
const work = mkdtempSync(join(tmpdir(), "t3-autopilot-pack-"));

function fail(message) {
  console.error(`FAIL ${message}\n(temporary files kept in ${work})`);
  process.exit(1);
}

/** Run npm with the same npm that runs this script when there is one (no shell needed on Windows). */
function npm(args, cwd) {
  const execPath = process.env.npm_execpath;
  const res =
    execPath && /\.c?js$/.test(execPath)
      ? spawnSync(process.execPath, [execPath, ...args], { cwd, encoding: "utf8" })
      : spawnSync("npm", args, { cwd, encoding: "utf8", shell: win });
  if (res.error) fail(`npm ${args.join(" ")}: ${res.error.message}`);
  if (res.status !== 0) fail(`npm ${args.join(" ")} exited with ${res.status}:\n${res.stdout}\n${res.stderr}`);
  return res.stdout;
}

if (!existsSync(join(root, "dist", "cli.js"))) fail("dist/cli.js is missing: run `npm run build` first.");

// 1. Pack. Scripts are skipped: dist/ is built already and their output would mix with the JSON.
const [packed] = JSON.parse(npm(["pack", "--json", "--ignore-scripts", "--pack-destination", work], root));
const files = packed.files.map((f) => f.path.replace(/\\/g, "/")).sort();
console.log(`packed ${packed.filename}: ${files.length} files, ${(packed.size / 1024).toFixed(1)} kB`);

const required = [
  "LICENSE",
  "README.md",
  "CHANGELOG.md",
  "package.json",
  "policy/default.yaml",
  "dist/cli.js",
  "dist/index.js",
  "dist/index.d.ts",
  "dist/hosts/index.js",
  "dist/hosts/t3.js",
  // Every file listed in "files" that exists in the repository.
  ...pkg.files.filter((f) => existsSync(join(root, f)) && !statSync(join(root, f)).isDirectory()),
];
for (const f of new Set(required)) if (!files.includes(f)) fail(`the package lacks ${f}`);
// Nothing else: no sources, tests, coverage or source maps (they would point at local paths). And one README
// only: npm packs every README.* at the root whatever "files" says, and takes the first one its directory
// listing returns as the package's front page, so a translation next to README.md (README.es.md) could
// replace it on npmjs.com. Translations live in docs/.
const unexpected = files.filter(
  (f) =>
    !/^(?:LICENSE|README\.md|CHANGELOG\.md|package\.json|policy\/default\.yaml|dist\/(?:hosts\/)?[\w.-]+\.(?:js|d\.ts))$/.test(
      f,
    ),
);
if (unexpected.length) fail(`the package has unexpected files: ${unexpected.join(", ")}`);
// The bin must start with a shebang, or the installed command would not run on Unix.
if (!/^#!\/usr\/bin\/env node\r?\n/.test(readFileSync(join(root, pkg.bin["t3-autopilot"]), "utf8"))) {
  fail(`${pkg.bin["t3-autopilot"]} does not start with "#!/usr/bin/env node"`);
}
console.log("ok   file list");

// 2. Install the tarball in an empty project, as a user would install it from npm.
const app = join(work, "app");
mkdirSync(app);
writeFileSync(join(app, "package.json"), `${JSON.stringify({ name: "pack-check", private: true }, null, 2)}\n`);
npm(["install", join(work, packed.filename), "--no-audit", "--no-fund", "--prefer-offline", "--loglevel=error"], app);
const installed = JSON.parse(readFileSync(join(app, "node_modules", "t3-autopilot", "package.json"), "utf8"));
if (installed.version !== pkg.version) fail(`installed version ${installed.version}, expected ${pkg.version}`);
const bin = join(app, "node_modules", ".bin", win ? "t3-autopilot.cmd" : "t3-autopilot");
if (!existsSync(bin)) fail(`npm did not link the bin at ${bin}`);
console.log(`ok   installed t3-autopilot@${installed.version} with its bin`);

// 3. The installed bin answers, and the end-to-end test passes against it.
const version = spawnSync(win ? `"${bin}"` : bin, ["--version"], { encoding: "utf8", shell: win });
if (version.status !== 0 || version.stdout.trim() !== pkg.version) {
  fail(`t3-autopilot --version: status ${version.status}, output ${JSON.stringify(version.stdout)} ${version.stderr}`);
}
console.log(`ok   t3-autopilot --version prints ${pkg.version}`);

const e2e = spawnSync(process.execPath, ["--test", join(root, "test", "e2e", "stdio.e2e.mjs")], {
  cwd: root,
  env: { ...process.env, T3_AUTOPILOT_E2E_BIN: bin },
  stdio: "inherit",
});
if (e2e.status !== 0) fail("the end-to-end test failed against the installed bin");

rmSync(work, { recursive: true, force: true });
console.log("\npack check passed");
