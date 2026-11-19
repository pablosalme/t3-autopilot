// Builds the "How it works" GIFs of the READMEs from docs/assets/animation/index.html:
// docs/assets/how-it-works-{en,es}-{light,dark}.gif.
//
// The page draws every frame from a time t (window.renderAt). This script opens it in headless Chromium at
// device scale factor 2, takes one screenshot per frame and lets ffmpeg scale them down to 880 px (lanczos)
// and encode a GIF with its own palette (palettegen + paletteuse).
//
// Needs ffmpeg on the PATH and Chromium for Playwright. playwright-core is a pinned devDependency (it downloads
// no browser on install and is never published with the package); if Chromium is missing, run
// `npx playwright-core install chromium` once.
//
// Usage: npm run build:animation [-- --only en-dark] [-- --fps 12]
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("..", import.meta.url));
const page = join(root, "docs", "assets", "animation", "index.html");
const outDir = join(root, "docs", "assets");
const WIDTH = 880;
const HEIGHT = 500;

const { values } = parseArgs({
  options: {
    only: { type: "string", multiple: true },
    fps: { type: "string", default: "12" },
    colors: { type: "string", default: "128" },
    keep: { type: "boolean", default: false },
  },
});
const fps = Number(values.fps);
const variants = ["en", "es"]
  .flatMap((lang) => ["light", "dark"].map((theme) => ({ lang, theme, name: `${lang}-${theme}` })))
  .filter((v) => !values.only || values.only.includes(v.name));
if (variants.length === 0) throw new Error(`--only matches no variant (en-light, en-dark, es-light, es-dark)`);

const ffmpegCheck = spawnSync("ffmpeg", ["-version"], { encoding: "utf8" });
if (ffmpegCheck.error) throw new Error("ffmpeg is not on the PATH");

const work = mkdtempSync(join(tmpdir(), "t3-autopilot-animation-"));
const browser = await chromium.launch();
try {
  for (const v of variants) {
    const frames = join(work, v.name);
    mkdirSync(frames);
    const ctx = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 2 });
    const tab = await ctx.newPage();
    const url = new URL(pathToFileURL(page));
    url.search = new URLSearchParams({ lang: v.lang, theme: v.theme, capture: "1" }).toString();
    await tab.goto(url.href);
    await tab.evaluate(() => document.fonts.ready);
    const duration = await tab.evaluate(() => window.DURATION);
    const count = Math.round(duration * fps);
    for (let i = 0; i < count; i++) {
      await tab.evaluate((t) => window.renderAt(t), i / fps);
      await tab.screenshot({ path: join(frames, `${String(i).padStart(4, "0")}.png`) });
    }
    await ctx.close();

    const gif = join(outDir, `how-it-works-${v.name}.gif`);
    const filter =
      `scale=${WIDTH}:-1:flags=lanczos,split[a][b];` +
      `[a]palettegen=max_colors=${values.colors}:stats_mode=full[p];` +
      `[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;
    const res = spawnSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-y",
        "-framerate",
        String(fps),
        "-i",
        join(frames, "%04d.png"),
        "-vf",
        filter,
        "-loop",
        "0",
        gif,
      ],
      { encoding: "utf8" },
    );
    if (res.status !== 0) throw new Error(`ffmpeg failed for ${v.name}:\n${res.stderr}`);
    console.log(`${gif}: ${count} frames at ${fps} fps, ${(statSync(gif).size / 1024).toFixed(0)} kB`);
  }
} finally {
  await browser.close();
  if (values.keep) console.log(`frames kept in ${work}`);
  else rmSync(work, { recursive: true, force: true });
}
