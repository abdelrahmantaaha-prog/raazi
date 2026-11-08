// Makes a SIGNED update package from the client folder `npm run dist` built:
//
//   npm run dist                  (first)
//   node scripts/make-update.mjs
//
// Output: updates/raazi-update-<version>.zip + .zip.sig. The package holds what
// a release replaces — server/, the readme — and an update.json carrying the
// version. Never data/, never a key: the same scan dist.mjs runs is run again
// on exactly what goes into the zip. The launcher travels inside, as
// starter/Raazi.exe, for an install to replace itself with after a good update.
//
// An install applies it from the automatic check (publish-update.mjs puts it
// where installs look), from the tray's "Update from a file…", or by hand with
// `Raazi.exe --apply-update <zip>`.
//
//   --out <dir>        write there instead of updates/
//   --sign-with 2      the spare key, once the first is retired
//
// RAAZI_UPDATE_PUBLIC names the public key to check the signature against, for
// scripts/check-auto-update.mjs and its throwaway key.
import { createSign, createVerify } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { secretsOf, fileContainsAny } from "./dist.mjs";
import { keysDir, loadPrivateKey } from "./lib/private-key.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = pkg.version;
const client = path.join(root, "dist", "client");
const refuse = (why) => {
  console.error(`[update] REFUSING: ${why}`);
  process.exit(1);
};
const argAt = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};

const spare = argAt("--sign-with") === "2";
const keyPath = path.join(keysDir(), spare ? "update-private-2.pem" : "update-private.pem");
const publicPem = process.env.RAAZI_UPDATE_PUBLIC || path.join(root, "keys", spare ? "update-public-2.pem" : "update-public.pem");
if (!fs.existsSync(keyPath)) refuse(`${keyPath} is missing — run scripts/gen-update-keys.mjs once, or restore it from the backup`);
const signingKey = await loadPrivateKey(keyPath).catch((e) => refuse(e instanceof Error ? e.message : String(e)));

const serverPkg = path.join(client, "server", "package.json");
if (!fs.existsSync(serverPkg)) refuse("dist/client has no server — run npm run dist first");
const built = JSON.parse(fs.readFileSync(serverPkg, "utf8")).version;
if (built !== version) refuse(`dist/client is ${built}, package.json is ${version} — run npm run dist again`);

// Stage exactly what an install's swap will see at the top of the zip.
const stage = fs.mkdtempSync(path.join(os.tmpdir(), "raazi-update-"));
try {
  for (const name of fs.readdirSync(client)) {
    if (name === "data" || name.toLowerCase() === "raazi.exe") continue;
    fs.cpSync(path.join(client, name), path.join(stage, name), { recursive: true });
  }
  const starter = path.join(client, "Raazi.exe");
  if (!fs.existsSync(starter)) refuse("dist/client has no Raazi.exe — run npm run dist first");
  fs.mkdirSync(path.join(stage, "starter"), { recursive: true });
  fs.copyFileSync(starter, path.join(stage, "starter", "Raazi.exe"));
  fs.writeFileSync(
    path.join(stage, "update.json"),
    JSON.stringify({ app: "raazi", version, builtAt: new Date().toISOString() }, null, 2) + "\n",
  );

  const offenders = [];
  const secrets = secretsOf();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      const rel = path.relative(stage, full).replace(/\\/g, "/");
      if (e.isDirectory()) {
        if (e.name === "data") offenders.push(rel + "/");
        else walk(full);
      } else if (/config\.json$|^shared\.json$|^\.env|\.pem$|\.db(-wal|-shm)?$/.test(e.name)) offenders.push(rel);
      else if (secrets.length && fileContainsAny(full, secrets)) offenders.push(`${rel} (contains a key)`);
    }
  };
  walk(stage);
  if (offenders.length) refuse(`private files in the package: ${offenders.slice(0, 10).join(", ")}`);

  const outDir = argAt("--out") ? path.resolve(argAt("--out")) : path.join(root, "updates");
  fs.mkdirSync(outDir, { recursive: true });
  const zip = path.join(outDir, `raazi-update-${version}.zip`);
  fs.rmSync(zip, { force: true });
  fs.rmSync(`${zip}.sig`, { force: true });
  // .NET's ZipFile, never `tar -a`: tar's ./ entries make Explorer call the zip invalid.
  execFileSync("powershell", [
    "-NoProfile",
    "-Command",
    `Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::CreateFromDirectory('${stage.replace(/'/g, "''")}', '${zip.replace(/'/g, "''")}')`,
  ]);

  const data = fs.readFileSync(zip);
  const sig = createSign("RSA-SHA256").update(data).sign(signingKey).toString("base64");
  if (!fs.existsSync(publicPem)) refuse(`${publicPem} is missing`);
  const ok = createVerify("RSA-SHA256").update(data).verify(fs.readFileSync(publicPem), sig, "base64");
  if (!ok) refuse(`the signature does not verify against ${path.basename(publicPem)} — the key pair is mismatched`);
  fs.writeFileSync(`${zip}.sig`, sig);

  console.log(`[update] ${zip} (${(data.length / 1048576).toFixed(0)} MB) + .sig`);
  console.log("[update] next: node scripts/publish-update.mjs   (test installs first)");
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
