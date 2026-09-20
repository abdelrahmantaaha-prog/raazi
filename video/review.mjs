// Contact sheets for checking a finished film by eye: two stills from every
// recorded scene (what the camera shows), and a still in the middle of every
// burned-in caption (that the Arabic is shaped, whole and legible).
//
//   node review.mjs --scenes=scenes-narrated.mjs
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ffmpeg, duration } from "./lib/ffmpeg.mjs";

const args = process.argv.slice(2);
const value = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const SCENES_FILE = path.resolve(import.meta.dirname, value("scenes") ?? "scenes-narrated.mjs");
const { SCENES, TITLE } = await import(pathToFileURL(SCENES_FILE).href);
const FILM = path.resolve(import.meta.dirname, "out", TITLE);
const OUT = path.join(FILM, "review");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, "stills"), { recursive: true });

const grab = (input, t, file) =>
  ffmpeg(["-ss", t.toFixed(2), "-i", input, "-frames:v", "1", "-vf", "scale=640:-1", path.join(OUT, "stills", file)]);

/** Tiles numbered stills into sheets of `cols` x `rows`. */
function sheets(prefix, cols, rows) {
  const n = fs.readdirSync(path.join(OUT, "stills")).filter((f) => f.startsWith(prefix)).length;
  for (let s = 0; s * cols * rows < n; s++) {
    ffmpeg(["-start_number", String(s * cols * rows), "-i", path.join(OUT, "stills", `${prefix}%03d.png`),
      "-frames:v", "1", "-vf", `tile=${cols}x${rows}:padding=6:color=white`, path.join(OUT, `${prefix}sheet-${s + 1}.png`)]);
  }
}

let i = 0;
for (const s of SCENES) {
  const clip = path.join(FILM, "scenes", `${s.id}.mp4`);
  if (!fs.existsSync(clip)) continue;
  const d = duration(clip);
  for (const f of [0.4, 0.85]) grab(clip, d * f, `scene-${String(i++).padStart(3, "0")}.png`);
}
sheets("scene-", 4, 4);

// Cue midpoints from the burned-in subtitle file.
const final = path.join(FILM, `${TITLE}.mp4`);
const ass = fs.existsSync(path.join(FILM, "captions.ass")) ? fs.readFileSync(path.join(FILM, "captions.ass"), "utf8") : "";
const secs = (h, m, s) => +h * 3600 + +m * 60 + +s;
const cues = [...ass.matchAll(/^Dialogue: 0,(\d+):(\d+):([\d.]+),(\d+):(\d+):([\d.]+),Caption,,0,0,0,,(.*)$/gm)]
  .map((m) => ({ mid: (secs(m[1], m[2], m[3]) + secs(m[4], m[5], m[6])) / 2, text: m[7] }));
if (fs.existsSync(final)) {
  cues.forEach((c, k) => grab(final, c.mid, `cue-${String(k).padStart(3, "0")}.png`));
  sheets("cue-", 3, 4);
}
fs.writeFileSync(path.join(OUT, "cues.txt"), cues.map((c, k) => `${k}\t${c.mid.toFixed(2)}\t${c.text}`).join("\n"));
console.log(`${i} scene stills, ${cues.length} caption stills -> ${OUT}`);
