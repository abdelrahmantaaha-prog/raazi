// Builds a film from a scenes file: narration (if any), recording, the cut.
//
//   node make.mjs                         scenes.mjs (on-screen text, no voice)
//   node make.mjs --scenes=scenes-voice.mjs
//   node make.mjs --plan                  lengths only
//   node make.mjs --only=brief,entry      re-record these, reuse the rest
//   node make.mjs --no-record             re-cut from recorded scenes
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ffmpeg, duration } from "./lib/ffmpeg.mjs";
import { narrate } from "./lib/tts.mjs";
import { Camera, CURSOR_SCRIPT } from "./lib/camera.mjs";
import { overlayMain } from "./lib/overlay.mjs";
import { sceneCues, assDocument } from "./lib/captions.mjs";

const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const value = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const ONLY = value("only")?.split(",");
const SCENES_FILE = path.resolve(import.meta.dirname, value("scenes") ?? "scenes.mjs");
const { SCENES, VOICE, RATE, BASE, TITLE } = await import(pathToFileURL(SCENES_FILE).href);

const FILM = path.resolve(import.meta.dirname, "out", TITLE);
const LEAD = 0.5; // silence before a scene's narration
const TAIL = 0.6; // silence after it
const XF = 0.4; // crossfade between scenes
const CLEAR = 0.7; // on-screen text leaves this long before a scene ends
for (const d of ["tts", "scenes", "frames", "cards", "fonts"]) fs.mkdirSync(path.join(FILM, d), { recursive: true });

// ---------------------------------------------------------------- narration
for (const s of SCENES) {
  s.narr = s.say ? await narrate(s.say, { voice: VOICE, rate: RATE, dir: path.join(FILM, "tts") }) : null;
  s.length = Math.max(s.min ?? 0, s.narr ? LEAD + s.narr.duration + TAIL : 0);
}
const estimate = SCENES.reduce((t, s) => t + s.length, 0) - XF * (SCENES.length - 1);
console.table(SCENES.map((s) => ({ scene: s.id, voice: s.narr?.duration.toFixed(1) ?? "-", length: s.length.toFixed(1) })));
console.log(`estimated running time ${estimate.toFixed(1)}s`);
if (has("plan")) process.exit(0);

// ---------------------------------------------------------------- recording
function encode({ frames, t0, t1, dir }, out) {
  if (!frames.length) throw new Error("no frames captured");
  frames.sort((a, b) => a.t - b.t);
  const lines = [];
  frames.forEach((f, i) => {
    const from = i === 0 ? t0 : Math.max(f.t, t0);
    const to = i + 1 < frames.length ? Math.max(frames[i + 1].t, t0) : t1;
    lines.push(`file '${f.file}'`, `duration ${Math.max(to - from, 0.0005).toFixed(4)}`);
  });
  lines.push(`file '${frames.at(-1).file}'`);
  fs.writeFileSync(path.join(dir, "list.txt"), lines.join("\n"));
  ffmpeg(["-f", "concat", "-safe", "0", "-i", "list.txt", "-t", (t1 - t0).toFixed(3),
    "-vf", "fps=30,scale=1920:1080:flags=lanczos,setsar=1,format=yuv420p",
    "-c:v", "libx264", "-preset", "medium", "-crf", "16", path.resolve(out)], { cwd: dir });
}

if (!has("no-record")) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1.2, colorScheme: "light" });
  await context.addInitScript(CURSOR_SCRIPT);
  await context.addInitScript(overlayMain);
  const page = await context.newPage();
  // A missing element should cost a scene seconds, not Playwright's default thirty.
  page.setDefaultTimeout(6000);
  const cam = new Camera(page);

  for (const s of SCENES) {
    const file = path.join(FILM, "scenes", `${s.id}.mp4`);
    if (ONLY && !ONLY.includes(s.id) && fs.existsSync(file)) continue;

    if (s.card) {
      const html = path.join(FILM, "cards", `${s.id}.html`);
      fs.writeFileSync(html, s.card);
      await page.goto(pathToFileURL(html).href);
    } else {
      await page.goto(BASE + s.url, { waitUntil: "domcontentloaded", timeout: 90_000 });
    }
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(s.settle ?? 2500);
    if (s.prep) await s.prep(page, cam);
    await cam.park();

    await cam.start(path.join(FILM, "frames", s.id));
    try {
      if (s.run) await s.run(cam, page, s);
    } catch (err) {
      console.warn(`  ! ${s.id}: ${err.message.split("\n")[0]}`);
    }
    const over = cam.now() - s.length;
    if (!s.card) {
      await cam.until(s.length - CLEAR);
      await cam.hideCaption();
      await cam.unfocus();
    }
    await cam.until(s.length);
    const shot = await cam.stop();
    encode(shot, file);
    fs.rmSync(shot.dir, { recursive: true, force: true });
    console.log(`recorded ${s.id}: ${duration(file).toFixed(1)}s, ${shot.frames.length} frames${over > 0 ? `, actions ran ${over.toFixed(1)}s long` : ""}`);
  }
  await browser.close();
}

// ---------------------------------------------------------------- the cut
const clips = SCENES.map((s) => {
  const file = path.join(FILM, "scenes", `${s.id}.mp4`);
  if (!fs.existsSync(file)) throw new Error(`scene not recorded: ${s.id}`);
  return { s, file, length: duration(file) };
});
const starts = [];
let t = 0;
for (const c of clips) { starts.push(t); t += c.length - XF; }
const total = t + XF;

const cues = clips.flatMap((c, i) => c.s.narr ? sceneCues(c.s.narr.words, c.s.say, starts[i] + LEAD) : []);
if (cues.length) {
  fs.writeFileSync(path.join(FILM, "captions.ass"), assDocument(cues));
  for (const f of ["NotoSansArabic-Bold.ttf", "NotoSansArabic-Regular.ttf"]) {
    fs.copyFileSync(path.join(process.env.WINDIR, "Fonts", f), path.join(FILM, "fonts", f));
  }
}

const inputs = clips.flatMap((c) => ["-i", path.relative(FILM, c.file)]);
const voiced = clips.map((c, i) => ({ ...c, i })).filter((c) => c.s.narr);
for (const v of voiced) inputs.push("-i", path.relative(FILM, v.s.narr.audio));

const graph = [];
let last = "[0:v]";
for (let k = 1; k < clips.length; k++) {
  graph.push(`${last}[${k}:v]xfade=transition=fade:duration=${XF}:offset=${starts[k].toFixed(3)}[v${k}]`);
  last = `[v${k}]`;
}
graph.push(`${last}${cues.length ? "subtitles=captions.ass:fontsdir=fonts," : ""}fade=t=out:st=${(total - 0.6).toFixed(3)}:d=0.6,format=yuv420p[vout]`);
const maps = ["-map", "[vout]"];
if (voiced.length) {
  voiced.forEach((v, j) => {
    graph.push(`[${clips.length + j}:a]adelay=${Math.round((starts[v.i] + LEAD) * 1000)}:all=1[a${j}]`);
  });
  graph.push(`${voiced.map((_, j) => `[a${j}]`).join("")}amix=inputs=${voiced.length}:normalize=0:duration=longest,` +
    `apad,atrim=0:${total.toFixed(3)},afade=t=out:st=${(total - 1).toFixed(3)}:d=1[aout]`);
  maps.push("-map", "[aout]", "-c:a", "aac", "-b:a", "192k");
} else {
  maps.push("-an");
}

const out = `${TITLE}.mp4`;
ffmpeg([...inputs, "-filter_complex", graph.join(";"), ...maps,
  "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-r", "30", "-movflags", "+faststart", out], { cwd: FILM });
console.log(`\n${path.join(FILM, out)} — ${duration(path.join(FILM, out)).toFixed(1)}s${cues.length ? `, ${cues.length} captions` : ""}`);
