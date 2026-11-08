// The starter's update rules (launcher/UpdateFeed.cs), driven by
// launcher/tests/UpdateFeedTest.cs against throwaway files: two signing keys
// and retiring one, withdrawn versions, HTTPS only, capped downloads, the
// Node check before installing. Compiled with the C#
// compiler that ships with Windows; skipped elsewhere. Never runs Raazi.exe.
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

let failed = 0;
const check = (name, ok) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}`);
  if (!ok) failed++;
};

const out = fs.mkdtempSync(path.join(os.tmpdir(), "update-feed-test-"));
const exe = path.join(out, "UpdateFeedTest.exe");
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
    path.join(root, "launcher", "UpdateFeed.cs"),
    path.join(root, "launcher", "tests", "UpdateFeedTest.cs"),
  ],
  { encoding: "utf8" },
);
if (build.status !== 0) {
  console.log(build.stdout, build.stderr);
  console.log("FAIL  the update-feed test did not compile");
  process.exit(1);
}
const run = spawnSync(exe, [], { encoding: "utf8", env: { ...process.env, TEMP: out, TMP: out } });
const lines = (run.stdout ?? "").split(/\r?\n/);
for (const l of lines) if (l) console.log(l);
process.stderr.write(run.stderr ?? "");
if (run.status !== 0) failed++;

// The release build carries none of the test-only addresses.
const src = fs.readFileSync(path.join(root, "launcher", "UpdateFeed.cs"), "utf8");
const lax = src.indexOf("Uri.UriSchemeHttp && uri.IsLoopback");
check("plain-HTTP feeds exist only in the test build", lax > src.indexOf("#if UPDATE_TESTS") && lax < src.indexOf("#endif"));
const build1 = fs.readFileSync(path.join(root, "launcher", "build.ps1"), "utf8");
check(
  "the release build compiles the feed rules in, without the test switch",
  build1.includes("UpdateFeed.cs") && build1.includes('$defines = if ($Test) { "/define:UPDATE_TESTS" } else { "/define:RELEASE" }'),
);

try {
  fs.rmSync(out, { recursive: true, force: true });
} catch {
  /* a handle still open on Windows */
}
process.exit(failed ? 1 : 0);
