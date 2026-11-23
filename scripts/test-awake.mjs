// Staying awake for a phone (launcher/Awake.cs, lib/presence.ts).
//
// Two halves, tested where each lives: the server's note of when another
// device last used the library, and the launcher's power request, driven by
// launcher/tests/AwakeTest.cs. The C# half is compiled with the compiler that
// ships with Windows and skipped elsewhere. Never runs Raazi.exe.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let failed = 0;
const check = (name, ok) => {
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}`);
  if (!ok) failed++;
};

// -- the server's half ------------------------------------------------------
const presence = await import("../lib/presence.ts");

check("this computer by IPv4 is this computer", presence.isLoopback("127.0.0.1"));
check("this computer by IPv6 is this computer", presence.isLoopback("::1"));
check("an IPv4 caller on a dual-stack socket is still this computer", presence.isLoopback("::ffff:127.0.0.1"));
check("a phone on the Wi-Fi is not", !presence.isLoopback("192.168.100.34"));
check("a phone on Tailscale is not", !presence.isLoopback("100.105.1.2"));
check("a dual-stack phone is not", !presence.isLoopback("::ffff:192.168.100.34"));
check("an address that merely starts like loopback is not", !presence.isLoopback("127.0.0.1.evil.example"));

check("the address this server wrote is the last one", presence.callerAddress("10.0.0.9, 192.168.100.34") === "192.168.100.34");
check("no header is no address", presence.callerAddress(null) === null);

globalThis.__corpusRemoteSeenAt = undefined;
check("nobody yet", presence.remoteSeenAgoMs() === null);
presence.noteRequest("127.0.0.1", 1_000);
check("this computer's own window does not count", presence.remoteSeenAgoMs(2_000) === null);
presence.noteRequest(null, 1_000);
check("a request with no address does not count", presence.remoteSeenAgoMs(2_000) === null);
presence.noteRequest("192.168.100.34", 5_000);
check("a phone does", presence.remoteSeenAgoMs(5_750) === 750);
// A caller cannot pass itself off as this computer by claiming a loopback hop.
presence.noteRequest("127.0.0.1, 192.168.100.35", 9_000);
check("the claimed hops before the real address are ignored", presence.remoteSeenAgoMs(9_000) === 0);
presence.noteRequest("192.168.100.35, 127.0.0.1", 20_000);
check("and this computer stays this computer whatever it claims", presence.remoteSeenAgoMs(20_000) === 11_000);

const middleware = fs.readFileSync(path.join(root, "middleware.ts"), "utf8");
const notes = [...middleware.matchAll(/noteRequest\(req/g)].map((m) => m.index);
const openRoute = middleware.indexOf('pathname === "/api/hello"');
check("the middleware notes requests, in two places", notes.length === 2);
check(
  "never for the open discovery route: a sweep of the Wi-Fi must not hold the computer awake",
  openRoute > 0 && notes.every((at) => at > openRoute),
);
check(
  "a sign-in that matched is noted",
  /if \(offered && tokenMatches\(offered, token\)\) \{[\s\S]{0,120}noteRequest\(/.test(middleware),
);
check(
  "and every request whose token matched",
  /if \(tokenMatches\(tokenFrom\(req\), token\)\) \{[\s\S]{0,300}noteRequest\(/.test(middleware),
);

// -- the launcher's half ----------------------------------------------------
const windir = process.env.WINDIR ?? "C:\\Windows";
const csc = [
  path.join(windir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
  path.join(windir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
].find((p) => fs.existsSync(p));

if (process.platform !== "win32" || !csc) {
  console.log("skip  no .NET Framework C# compiler here; the power request was not tested");
} else {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "awake-test-"));
  const exe = path.join(out, "AwakeTest.exe");
  const build = spawnSync(
    csc,
    [
      "/nologo",
      "/target:exe",
      "/codepage:65001",
      `/out:${exe}`,
      "/reference:System.dll",
      path.join(root, "launcher", "Awake.cs"),
      path.join(root, "launcher", "tests", "AwakeTest.cs"),
    ],
    { encoding: "utf8" },
  );
  if (build.status !== 0) {
    console.log(build.stdout, build.stderr);
    check("the awake test compiles", false);
  } else {
    const run = spawnSync(exe, [], { encoding: "utf8" });
    for (const l of (run.stdout ?? "").split(/\r?\n/)) if (l) console.log(l);
    process.stderr.write(run.stderr ?? "");
    if (run.status !== 0) failed++;
  }
  fs.rmSync(out, { recursive: true, force: true });

  const launcher = fs.readFileSync(path.join(root, "launcher", "Launcher.cs"), "utf8");
  const build1 = fs.readFileSync(path.join(root, "launcher", "build.ps1"), "utf8");
  check("the launcher is built with Awake.cs", build1.includes('"$awakeSrc"'));
  check("and starts the watch", launcher.includes("StartAwakeWatch();"));
  check("only for a shared server", /lanMode && server != null[\s\S]{0,120}\/api\/presence/.test(launcher));
}

console.log(failed === 0 ? "\nall passed" : `\n${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
