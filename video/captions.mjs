// Turns a voice sample's word timings into Arabic captions and burns them onto
// a plain card with the narration underneath — the check that shaping and
// right-to-left layout survive ffmpeg.
//   node captions.mjs [voice]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const voice = process.argv[2] ?? "ar-SA-HamedNeural";
const SAMPLE = path.resolve(import.meta.dirname, "out/voices", voice);
const OUT = path.resolve(import.meta.dirname, "out/captions", voice);
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, "fonts"), { recursive: true });

const LINE =
  "الرازي موسوعةٌ تنمو مع مصادرك. كلُّ جملةٍ فيها تعود إلى اقتباسٍ في صفحةٍ محدَّدة، " +
  "وحين يصل كتابٌ جديد، تُراجِع المداخلُ نفسَها وتخبرك بما تغيَّر.";

function findFfmpeg() {
  if (process.env.FFMPEG) return process.env.FFMPEG;
  const root = path.join(process.env.LOCALAPPDATA, "Microsoft/WinGet/Packages");
  const pkg = fs.readdirSync(root).find((d) => d.startsWith("Gyan.FFmpeg"));
  if (!pkg) return "ffmpeg";
  const build = fs.readdirSync(path.join(root, pkg)).find((d) => d.startsWith("ffmpeg-"));
  return path.join(root, pkg, build, "bin/ffmpeg.exe");
}

// Offsets and durations arrive in 100-nanosecond ticks.
const raw = fs.readFileSync(path.join(SAMPLE, "metadata.json"), "utf8");
const words = [...raw.matchAll(/"Offset":\s*(\d+),\s*"Duration":\s*(\d+),\s*"text":\s*\{\s*"Text":\s*"([^"]*)"/g)]
  .map((m) => ({ start: +m[1] / 1e7, end: (+m[1] + +m[2]) / 1e7, text: m[3] }));

// Break a caption after punctuation in the script, or at six words.
const cues = [];
let cue = [], cursor = 0;
for (const w of words) {
  const at = LINE.indexOf(w.text, cursor);
  if (at >= 0) cursor = at + w.text.length;
  cue.push(w);
  const pause = at >= 0 && /^[.،,؟!؛]/.test(LINE.slice(cursor));
  if (pause || cue.length === 6) { cues.push(cue); cue = []; }
}
if (cue.length) cues.push(cue);

const stamp = (s) => {
  const cs = Math.round(s * 100);
  const h = Math.floor(cs / 360000), m = Math.floor(cs / 6000) % 60, sec = Math.floor(cs / 100) % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
};

const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,Noto Sans Arabic,72,&H001A2A3B,&H001A2A3B,&H00F2F7FA,&H00000000,-1,0,0,0,100,100,0,0,1,4,0,2,120,120,140,178

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${cues.map((c, i) => {
  const end = cues[i + 1] ? Math.min(cues[i + 1][0].start, c.at(-1).end + 0.6) : c.at(-1).end + 0.8;
  return `Dialogue: 0,${stamp(c[0].start)},${stamp(end)},Caption,,0,0,0,,${c.map((w) => w.text).join(" ")}`;
}).join("\n")}
`;
fs.writeFileSync(path.join(OUT, "captions.ass"), ass);
for (const f of ["NotoSansArabic-Bold.ttf", "NotoSansArabic-Regular.ttf"]) {
  fs.copyFileSync(path.join(process.env.WINDIR, "Fonts", f), path.join(OUT, "fonts", f));
}

// Relative paths inside the filter graph, so Windows drive letters never need escaping.
const ffmpeg = findFfmpeg();
const duration = words.at(-1).end + 1.2;
execFileSync(ffmpeg, ["-y", "-loglevel", "error",
  "-f", "lavfi", "-i", `color=c=0xfaf7f2:s=1920x1080:r=30:d=${duration}`,
  "-i", path.join(SAMPLE, "audio.mp3"),
  "-vf", "subtitles=captions.ass:fontsdir=fonts",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-c:a", "aac", "-b:a", "160k",
  "-shortest", "sample.mp4"], { cwd: OUT });

cues.forEach((c, i) => {
  const t = ((c[0].start + c.at(-1).end) / 2).toFixed(2);
  execFileSync(ffmpeg, ["-y", "-loglevel", "error", "-ss", t, "-i", "sample.mp4", "-frames:v", "1", `cue-${i + 1}.png`], { cwd: OUT });
});
console.log(`${words.length} words, ${cues.length} captions, ${duration.toFixed(1)}s -> ${path.join(OUT, "sample.mp4")}`);
cues.forEach((c, i) => console.log(`  ${i + 1}. ${stamp(c[0].start)}  ${c.map((w) => w.text).join(" ")}`));
