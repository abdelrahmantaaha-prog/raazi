// Puts a signed update where installs' launchers look for it.
//
//   node scripts/publish-update.mjs              to the test install(s): the "early" ring
//   node scripts/publish-update.mjs --promote    then to every install: "stable" takes "early"
//   node scripts/publish-update.mjs --version 0.11.0
//
// Run make-update.mjs first. The package goes up as release v<version> of the
// public raazi-updates repository (zip + .sig only — never source, never data),
// and the feed (manifest.json on the release tagged "feed") is pointed at it.
// The repository is made the first time it is needed. Launchers look every six
// hours and ask before installing. They trust the signature, not the feed, so a
// wrong feed can only withhold an update.
//
// The feed itself is signed too (manifest.json.sig), with the update key or,
// `--sign-with 2`, the spare. Starters honour a feed's other requests only
// when it is:
//
//   --withdraw 0.11.1   no install is offered 0.11.1 again
//   --retire 1          every install stops trusting key 1 (sign with the spare)
import { createSign, createVerify } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { keysDir, loadPrivateKey } from "./lib/private-key.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = "abdelrahmantaaha-prog/raazi-updates";
const gh = (...args) => spawnSync("gh", args, { encoding: "utf8" });
const must = (r, what) => {
  if (r.status !== 0) {
    console.error(`[publish] ${what} failed: ${r.stderr || r.stdout}`);
    process.exit(1);
  }
  return r;
};

function readFeed() {
  const r = gh("release", "download", "feed", "--repo", repo, "--pattern", "manifest.json", "--output", "-");
  if (r.status !== 0) return {};
  try {
    return JSON.parse(r.stdout);
  } catch {
    return {};
  }
}

const argAt = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const signWith = argAt("--sign-with") === "2" ? "update-private-2.pem" : "update-private.pem";
const signingKey = await loadPrivateKey(path.join(keysDir(), signWith)).catch((e) => {
  console.error(`[publish] ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});

if (gh("repo", "view", repo).status !== 0) {
  must(
    gh("repo", "create", repo, "--public", "--description", "Signed update packages read by Raazi launchers. No source, no data."),
    "creating the public updates repository",
  );
  console.log(`[publish] created ${repo} (public)`);
}

async function saveFeed(feed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raazi-feed-"));
  const file = path.join(dir, "manifest.json");
  const bytes = Buffer.from(JSON.stringify(feed, null, 2) + "\n", "utf8");
  fs.writeFileSync(file, bytes);
  fs.writeFileSync(`${file}.sig`, createSign("RSA-SHA256").update(bytes).sign(signingKey).toString("base64"));
  if (gh("release", "view", "feed", "--repo", repo).status !== 0) {
    must(
      gh("release", "create", "feed", "--repo", repo, "--title", "Update feed", "--notes", "Read by Raazi launchers. Do not delete.", "--latest=false"),
      "creating the feed release",
    );
  }
  must(gh("release", "upload", "feed", file, `${file}.sig`, "--repo", repo, "--clobber"), "uploading the feed");
  fs.rmSync(dir, { recursive: true, force: true });
}

const feed = readFeed();

const withdraw = argAt("--withdraw");
const retire = argAt("--retire");
if (withdraw || retire) {
  if (withdraw) feed.revoked = [...new Set([...(feed.revoked ?? []), withdraw])];
  if (retire) {
    if (signWith !== "update-private-2.pem" || retire !== "1") {
      console.error("[publish] retire key 1 with a feed signed by the spare: --retire 1 --sign-with 2");
      process.exit(1);
    }
    feed.retire = [...new Set([...(feed.retire ?? []), 1])];
  }
  await saveFeed(feed);
  console.log(`[publish] the signed feed now withdraws ${JSON.stringify(feed.revoked ?? [])} and retires ${JSON.stringify(feed.retire ?? [])}`);
  process.exit(0);
}

if (process.argv.includes("--promote")) {
  if (!feed.early) {
    console.error("[publish] nothing on the early ring to promote");
    process.exit(1);
  }
  feed.stable = feed.early;
  await saveFeed(feed);
  console.log(`[publish] every install will be offered ${feed.early.version} within six hours`);
  process.exit(0);
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = argAt("--version") ?? pkg.version;
const zip = path.join(root, "updates", `raazi-update-${version}.zip`);
if (!fs.existsSync(zip) || !fs.existsSync(`${zip}.sig`)) {
  console.error(`[publish] updates/raazi-update-${version}.zip and its .sig are missing — run scripts/make-update.mjs first`);
  process.exit(1);
}
// Never publish something every launcher would refuse.
// Either trusted key: after the first is retired, packages are signed with the spare.
const zipBytes = fs.readFileSync(zip);
const zipSig = fs.readFileSync(`${zip}.sig`, "utf8").trim();
const ok = ["update-public.pem", "update-public-2.pem"]
  .map((n) => path.join(root, "keys", n))
  .some((pub) => fs.existsSync(pub) && createVerify("RSA-SHA256").update(zipBytes).verify(fs.readFileSync(pub), zipSig, "base64"));
if (!ok) {
  console.error("[publish] the signature does not verify — not publishing");
  process.exit(1);
}

const tag = `v${version}`;
if (gh("release", "view", tag, "--repo", repo).status !== 0) {
  must(gh("release", "create", tag, zip, `${zip}.sig`, "--repo", repo, "--title", `Raazi ${version}`, "--notes", "Signed update package."), `creating release ${tag}`);
}
feed.early = { version, zip: `https://github.com/${repo}/releases/download/${tag}/raazi-update-${version}.zip` };
await saveFeed(feed);
console.log(`[publish] test install(s) will be offered ${version} within six hours.`);
console.log("[publish] when it has run there for a few days:  node scripts/publish-update.mjs --promote");
