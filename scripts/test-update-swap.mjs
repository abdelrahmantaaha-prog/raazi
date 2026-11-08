// The launcher's update swap and its undo (launcher/UpdateSwap.cs), driven by
// launcher/tests/UpdateSwapTest.cs against throwaway folders. Compiled with the
// C# compiler that ships with Windows; skipped elsewhere. Never runs Raazi.exe.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const windir = process.env.WINDIR ?? "C:\\Windows";
const csc = [
  path.join(windir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
  path.join(windir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
].find((p) => fs.existsSync(p));

if (process.platform !== "win32" || !csc) {
  console.log("skip  no .NET Framework C# compiler here");
  process.exit(0);
}

const out = fs.mkdtempSync(path.join(os.tmpdir(), "update-swap-test-"));
const exe = path.join(out, "UpdateSwapTest.exe");
const build = spawnSync(
  csc,
  [
    "/nologo",
    "/target:exe",
    "/codepage:65001",
    `/out:${exe}`,
    "/reference:System.dll",
    "/reference:System.IO.Compression.dll",
    "/reference:System.IO.Compression.FileSystem.dll",
    path.join(root, "launcher", "UpdateSwap.cs"),
    path.join(root, "launcher", "tests", "UpdateSwapTest.cs"),
  ],
  { encoding: "utf8" },
);
if (build.status !== 0) {
  console.log(build.stdout, build.stderr);
  console.log("FAIL  the update-swap test did not compile");
  process.exit(1);
}
const run = spawnSync(exe, [], { encoding: "utf8", env: { ...process.env, TEMP: out, TMP: out } });
process.stdout.write(run.stdout ?? "");
process.stderr.write(run.stderr ?? "");
try {
  fs.rmSync(out, { recursive: true, force: true });
} catch {
  /* a handle still open on Windows */
}
process.exit(run.status ?? 1);
