// Exercises the launcher's whole update path against a scratch install:
//
//   npm run dist                        (first)
//   node scripts/check-auto-update.mjs
//
// By hand, not in npm test: it needs dist/client, and takes a minute or two.
// Everything is throwaway — a signing key made here, a test build of the
// launcher that trusts only that key, a folder in the temp directory, a loopback
// feed and a port of its own — so it can run beside a real Raazi and touches
// neither it nor its library.
//
// Checks the feed rules with --check-update, the swap with --apply-update /
// --undo-update (only the package's entries move, data\ and files beside the exe
// stay, and the undo brings back the old version AND the database), and then the
// real install with a running server: a good release is confirmed by /api/hello,
// and a release that will not start rolls back by itself.
import { createServer } from "node:http";
import { createSign, generateKeyPairSync } from "node:crypto";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const client = path.join(root, "dist", "client");
if (!fs.existsSync(path.join(client, "server", "server.js"))) throw new Error("dist/client is missing — run npm run dist");
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const parts = version.split(".").map(Number);
const older = parts[2] > 0 ? `${parts[0]}.${parts[1]}.${parts[2] - 1}` : `${parts[0]}.${parts[1] - 1}.99`;
const newer = `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
const zipName = `raazi-update-${version}.zip`;

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "raazi-autoupd-"));
const updates = path.join(scratch, "updates");
fs.mkdirSync(updates);

// -- a key of its own, and a launcher that trusts only it ---------------------
const keys = path.join(scratch, "keys");
fs.mkdirSync(keys);
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
fs.writeFileSync(path.join(keys, "update-private.pem"), privateKey.export({ type: "pkcs8", format: "pem" }));
fs.writeFileSync(path.join(keys, "update-public.pem"), publicKey.export({ type: "spki", format: "pem" }));
const modulus = Buffer.from(publicKey.export({ format: "jwk" }).n, "base64url").toString("base64");
const keysFile = path.join(scratch, "UpdateKeys.cs");
fs.writeFileSync(keysFile, `static class UpdateKeys { public const string Modulus1 = "${modulus}"; public const string Modulus2 = ""; }\n`);
const exe = path.join(scratch, "Raazi.exe");
execFileSync(
  "powershell",
  ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "launcher", "build.ps1"), "-Test", "-NoShortcut", "-Out", exe, "-KeysFile", keysFile],
  { stdio: ["ignore", "ignore", "inherit"] },
);

// make-update itself, against the throwaway key.
const made = spawnSync(process.execPath, [path.join(root, "scripts", "make-update.mjs"), "--out", updates], {
  encoding: "utf8",
  env: { ...process.env, RAAZI_KEYS_DIR: keys, RAAZI_UPDATE_PUBLIC: path.join(keys, "update-public.pem") },
});
if (made.status !== 0) throw new Error(`make-update failed: ${made.stdout}${made.stderr}`);

let manifest = "{}";
const server = createServer((req, res) => {
  const name = decodeURIComponent(req.url.slice(1));
  if (name === "manifest.json") return res.end(manifest);
  // "forged-<zip>": the real zip with a signature that is one byte off.
  if (name.startsWith("forged-")) {
    const real = name.slice("forged-".length);
    if (!real.endsWith(".sig")) return fs.createReadStream(path.join(updates, real)).pipe(res);
    const sig = Buffer.from(fs.readFileSync(path.join(updates, real), "utf8").trim(), "base64");
    sig[10] ^= 1;
    return res.end(sig.toString("base64"));
  }
  const file = path.join(updates, path.basename(name));
  if (!fs.existsSync(file)) {
    res.statusCode = 404;
    return res.end();
  }
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/`;

const testPort = await new Promise((resolve) => {
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1", () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

// A scratch install of the release before this one.
const dir = path.join(scratch, "install");
fs.mkdirSync(dir);
for (const name of fs.readdirSync(client)) {
  if (name === "data") continue;
  fs.cpSync(path.join(client, name), path.join(dir, name), { recursive: true });
}
fs.copyFileSync(exe, path.join(dir, "Raazi.exe"));
const pkgFile = path.join(dir, "server", "package.json");
const setInstalled = (v) => {
  const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
  pkg.version = v;
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2));
};
const installed = () => JSON.parse(fs.readFileSync(pkgFile, "utf8")).version;
setInstalled(older);
// And its server must answer as the older release, or /api/hello could not tell
// the two apart: the number is baked into the build.
{
  const route = path.join(dir, "server", ".next-dist", "server", "app", "api", "hello", "route.js");
  const body = fs.readFileSync(route, "utf8");
  if (!body.includes(`version:"${version}"`)) throw new Error("the hello route no longer carries its version where this test expects");
  fs.writeFileSync(route, body.replace(`version:"${version}"`, `version:"${older}"`));
}
fs.mkdirSync(path.join(dir, "data"));
fs.writeFileSync(path.join(dir, "data", "corpus.db"), "OLD-DB");
fs.writeFileSync(path.join(dir, "data", "update-feed.txt"), base + "manifest.json");
fs.writeFileSync(path.join(dir, "notes.txt"), "the owner's own file beside the exe");

async function launch(args, resultFile, waitMs = 120000) {
  const out = path.join(dir, resultFile);
  fs.rmSync(out, { force: true });
  execFile(path.join(dir, "Raazi.exe"), args, { env: { ...process.env, RAAZI_TEST_PORT: String(testPort) } });
  const until = Date.now() + waitMs;
  while (!fs.existsSync(out) && Date.now() < until) await new Promise((r) => setTimeout(r, 300));
  await new Promise((r) => setTimeout(r, 300));
  return fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "(no result)";
}

async function check({ feed, early = false, failed, git = false, off = false }) {
  fs.rmSync(path.join(dir, "update-download"), { recursive: true, force: true });
  const ring = path.join(dir, "data", "update-ring.txt");
  if (early) fs.writeFileSync(ring, "early");
  else fs.rmSync(ring, { force: true });
  const offFile = path.join(dir, "data", "updates-off.txt");
  if (off) fs.writeFileSync(offFile, "x");
  else fs.rmSync(offFile, { force: true });
  if (failed) {
    fs.mkdirSync(path.join(dir, "update-download"), { recursive: true });
    fs.writeFileSync(path.join(dir, "update-download", `failed-${failed}.txt`), "x");
  }
  if (git) fs.mkdirSync(path.join(dir, ".git"));
  else fs.rmSync(path.join(dir, ".git"), { recursive: true, force: true });
  manifest = JSON.stringify(feed);
  const got = await launch(["--check-update"], "update-check.txt");
  fs.rmSync(path.join(dir, ".git"), { recursive: true, force: true });
  return got;
}

const pkg = (v, file = zipName) => ({ version: v, zip: base + file });
const results = [];
const expect = (name, got, ok) => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ->  ${got}`);
};

// -- the feed --
let got = await check({ feed: { stable: pkg(version) } });
expect("newer stable is fetched and verified", got, got === `ready: ${version}`);
got = await check({ feed: { stable: pkg(older) } });
expect("nothing newer: left alone", got, got.startsWith("up to date"));
got = await check({ feed: { stable: pkg(older), early: pkg(version) } });
expect("regular install ignores the early ring", got, got.startsWith("up to date"));
got = await check({ early: true, feed: { stable: pkg(older), early: pkg(version) } });
expect("test install takes the early ring", got, got === `ready: ${version}`);
got = await check({ feed: { stable: pkg(newer) } });
expect("feed lying about the version is refused", got, got.startsWith(`refused ${newer}: package says ${version}`));
got = await check({ feed: { stable: pkg(version, "forged-" + zipName) } });
expect("wrong signature is refused", got, got === `refused ${version}: bad signature`);
got = await check({ failed: version, feed: { stable: pkg(version) } });
expect("a version that failed here is not offered again", got, got.startsWith(`skipping ${version}`));
got = await check({ feed: { stable: { version, zip: "http://example.com/x.zip" } } });
expect("plain http to another host is refused", got, got.startsWith("refused package address"));
got = await check({ git: true, feed: { stable: pkg(version) } });
expect("a checkout never updates itself", got, got === "skip: not a packaged install");
got = await check({ off: true, feed: { stable: pkg(version) } });
expect("switched off in Settings, it does not look", got, got.startsWith("skip: switched off"));

// -- the swap --
const zip = path.join(updates, zipName);
got = await launch(["--apply-update", zip], "update-result.txt");
const backup = path.join(dir, "update-backup");
const swapLog = fs.existsSync(path.join(backup, "update-swapped.txt")) ? fs.readFileSync(path.join(backup, "update-swapped.txt"), "utf8") : "";
expect("apply swaps in the new release", got, got === `OK version=${version}` && installed() === version);
expect(
  "files beside the exe and data\\ are left alone",
  "notes.txt, corpus.db",
  fs.existsSync(path.join(dir, "notes.txt")) && fs.readFileSync(path.join(dir, "data", "corpus.db"), "utf8") === "OLD-DB" && fs.existsSync(path.join(dir, "Raazi.exe")),
);
expect(
  "old release and database copy kept for undo",
  swapLog.trim().split(/\r?\n/).join(" | "),
  fs.existsSync(path.join(backup, "server", "server.js")) &&
    fs.readFileSync(path.join(backup, "update-database", "corpus.db"), "utf8") === "OLD-DB" &&
    /complete \d+\s*$/.test(swapLog),
);

fs.writeFileSync(path.join(dir, "data", "corpus.db"), "NEW-DB"); // the new release migrated it
got = await launch(["--undo-update"], "update-result.txt");
expect(
  "undo brings back the old release and database",
  got,
  got === `OK version=${older}` && installed() === older && fs.readFileSync(path.join(dir, "data", "corpus.db"), "utf8") === "OLD-DB" && !fs.existsSync(backup) && fs.existsSync(path.join(dir, "notes.txt")),
);

setInstalled(version);
got = await launch(["--apply-update", zip], "update-result.txt");
expect("the same release is not applied again", got, got === "FAIL not newer");
setInstalled(older);

// -- the real thing: a server running, stopped, replaced, judged --
// A real database from here on: the server opens and migrates it.
for (const f of ["corpus.db", "corpus.db-wal", "corpus.db-shm"]) fs.rmSync(path.join(dir, "data", f), { force: true });

// A package whose server cannot start, signed like any other.
const stage = path.join(scratch, "broken");
fs.mkdirSync(path.join(stage, "server"), { recursive: true });
fs.writeFileSync(path.join(stage, "server", "server.js"), "process.exit(1);\n");
fs.writeFileSync(path.join(stage, "server", "package.json"), JSON.stringify({ version: newer }));
fs.writeFileSync(path.join(stage, "update.json"), JSON.stringify({ app: "raazi", version: newer }));
const brokenZip = path.join(updates, `raazi-update-${newer}.zip`);
execFileSync("powershell", ["-NoProfile", "-Command", `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory('${stage}', '${brokenZip}')`]);
fs.writeFileSync(`${brokenZip}.sig`, createSign("RSA-SHA256").update(fs.readFileSync(brokenZip)).sign(privateKey).toString("base64"));

got = await launch(["--install-update", brokenZip], "update-result.txt", 240000);
expect(
  "a release that will not start rolls back by itself",
  got,
  got.startsWith(`installed=${older}`) && got.includes(`answering=${older}`) && got.includes("pending=False") &&
    fs.existsSync(path.join(dir, "update-download", `failed-${newer}.txt`)) &&
    fs.existsSync(path.join(dir, "data", "corpus.db")),
);

got = await launch(["--install-update", zip], "update-result.txt", 240000);
expect(
  "a good release is installed, answers as itself, and is settled",
  got,
  got === `installed=${version} answering=${version} pending=False` && fs.existsSync(path.join(dir, "data", `pre-update-${older}.db`)),
);

server.close();
await new Promise((r) => setTimeout(r, 1500));
fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
const failed = results.filter((ok) => !ok).length;
console.log(failed ? `${failed} FAILED` : "all passed");
process.exit(failed ? 1 : 0);
