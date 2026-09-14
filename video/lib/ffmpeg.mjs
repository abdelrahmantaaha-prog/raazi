import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** ffmpeg as winget installed it, unless FFMPEG says otherwise. Not on PATH on purpose. */
export function ffmpegPath() {
  if (process.env.FFMPEG) return process.env.FFMPEG;
  const root = path.join(process.env.LOCALAPPDATA ?? "", "Microsoft/WinGet/Packages");
  if (!fs.existsSync(root)) return "ffmpeg";
  const pkg = fs.readdirSync(root).find((d) => d.startsWith("Gyan.FFmpeg"));
  if (!pkg) return "ffmpeg";
  const build = fs.readdirSync(path.join(root, pkg)).find((d) => d.startsWith("ffmpeg-"));
  return path.join(root, pkg, build, "bin/ffmpeg.exe");
}

function ffprobePath() {
  const f = ffmpegPath();
  return /ffmpeg\.exe$/i.test(f) ? f.replace(/ffmpeg\.exe$/i, "ffprobe.exe") : "ffprobe";
}

export function ffmpeg(args, opts = {}) {
  const r = spawnSync(ffmpegPath(), ["-y", "-hide_banner", "-loglevel", "error", ...args], {
    encoding: "utf8", maxBuffer: 256e6, ...opts,
  });
  if (r.status !== 0) throw new Error(`ffmpeg exited ${r.status}\n${r.stderr}`);
}

export function duration(file) {
  const r = spawnSync(ffprobePath(), ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file], { encoding: "utf8" });
  const d = parseFloat(r.stdout);
  if (!Number.isFinite(d)) throw new Error(`no duration for ${file}: ${r.stderr}`);
  return d;
}
