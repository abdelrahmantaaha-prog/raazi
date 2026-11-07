// Proves the chain end to end: Playwright records an animated page, ffmpeg
// turns it into an MP4, and a still is pulled back out to check by eye.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve(import.meta.dirname, "out/smoke");
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

function findFfmpeg() {
  if (process.env.FFMPEG) return process.env.FFMPEG;
  const root = path.join(process.env.LOCALAPPDATA, "Microsoft/WinGet/Packages");
  const pkg = fs.readdirSync(root).find((d) => d.startsWith("Gyan.FFmpeg"));
  if (!pkg) return "ffmpeg";
  const build = fs.readdirSync(path.join(root, pkg)).find((d) => d.startsWith("ffmpeg-"));
  return path.join(root, pkg, build, "bin/ffmpeg.exe");
}

const card = `<body style="margin:0;height:100vh;display:grid;place-items:center;background:#faf7f2;font-family:Georgia,serif">
  <h1 style="font-size:72px;color:#3b2a1a;opacity:0;animation:in 1.2s ease-out .3s forwards">Raazi</h1>
  <style>@keyframes in{from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:none}}</style></body>`;

const size = { width: 1920, height: 1080 };
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: size, recordVideo: { dir: OUT, size } });
const page = await context.newPage();
await page.setContent(card);
await page.waitForTimeout(2500);
await context.close();
await browser.close();

const webm = fs.readdirSync(OUT).find((f) => f.endsWith(".webm"));
const ffmpeg = findFfmpeg();
const mp4 = path.join(OUT, "smoke.mp4");
execFileSync(ffmpeg, ["-y", "-loglevel", "error", "-i", path.join(OUT, webm),
  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", mp4]);
execFileSync(ffmpeg, ["-y", "-loglevel", "error", "-ss", "2", "-i", mp4, "-frames:v", "1", path.join(OUT, "frame.png")]);
console.log(`ffmpeg: ${ffmpeg}\nmp4: ${mp4} (${fs.statSync(mp4).size} bytes)`);
