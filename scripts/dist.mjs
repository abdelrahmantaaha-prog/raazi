// Packages Raazi into a folder that can be zipped and handed over.
//
//   dist/client/  — a self-contained copy, empty library
//
// The folder carries Raazi.exe, a self-contained server, and its own data/.
// There is no checkout and no `npm install` at the other end: Next's standalone
// output brings the node_modules it actually uses. Node itself is still required
// on the machine — the launcher says so plainly if it is missing.
//
// Run: npm run dist
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");

const say = (m) => console.log(`[dist] ${m}`);

/** Anything that belongs to THIS machine and must not travel: the key ring,
 *  your library, the stored source files. */
const PRIVATE = /(^|\/)(\.next\/standalone\/)?(data|\.env[^/]*)(\/|$)/;

/** Nothing leaves without this passing. A key or a source inside a folder meant
 *  to be handed to someone else is not a bug you get to find later. */
function assertClean(out, flavour) {
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
        continue;
      }
      const rel = path.relative(out, full).replace(/\\/g, "/");
      if (rel.startsWith("data/")) continue;
      if (/config\.json|\.env/.test(e.name)) offenders.push(rel);
    }
  };
  walk(out);

  // And the keys themselves, wherever they hid. Since disciplines, the ring
  // (keys[].key), the research keys and the LAN token live in data/shared.json;
  // an install that predates them keeps the ring, or a single apiKey, in
  // data/config.json. Reading only that one found nothing on a current install,
  // and a check with nothing to look for passes everything.
  const stores = ["shared.json", "config.json"]
    .map((f) => path.join(root, "data", f))
    .filter((f) => fs.existsSync(f))
    .map((f) => JSON.parse(fs.readFileSync(f, "utf8")));
  {
    const keys = stores
      .flatMap((stored) => [
        ...(stored.keys ?? []).map((k) => k.key),
        stored.apiKey,
        ...Object.values(stored.researchKeys ?? {}),
        stored.lan?.token,
      ])
      .filter((k) => typeof k === "string" && k.length >= 16);
    const scan = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) scan(full);
        else if (/\.(json|js|txt|db)$/.test(e.name) && fs.statSync(full).size < 8_000_000) {
          const body = fs.readFileSync(full, "utf8");
          if (keys.some((k) => body.includes(k))) {
            offenders.push(path.relative(out, full).replace(/\\/g, "/") + " (contains a key)");
          }
        }
      }
    };
    if (keys.length) scan(out);
  }

  if (offenders.length) {
    console.error(`[dist] REFUSING to ship ${flavour}: private files inside the package`);
    for (const o of offenders.slice(0, 10)) console.error(`         ${o}`);
    process.exit(1);
  }
}

/**
 * Next's standalone output is only produced by a production build, and only
 * when CORPUS_DIST=1 — see next.config.ts. The everyday build deliberately
 * omits it, because `next start` (which the launcher uses) exits on its own
 * when standalone output is present. Dist runs through server.js instead, so
 * it is the one build that asks for it.
 */
function build() {
  say("building…");
  execFileSync("npm", ["run", "build"], {
    cwd: root,
    stdio: ["ignore", "ignore", "inherit"],
    shell: process.platform === "win32",
    env: { ...process.env, CORPUS_DIST: "1" },
  });
}

function assemble(flavour) {
  const out = path.join(dist, flavour);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  const server = path.join(out, "server");
  // NEVER copy this machine's own data. Next's file tracing reaches it —
  // lib/db reads data/config.json, so nft follows — and that file holds every
  // API key on the ring, beside your whole library in data/. It is excluded on
  // the way in and checked for again on the way out.
  fs.cpSync(path.join(root, ".next", "standalone"), server, {
    recursive: true,
    filter: (src) => !PRIVATE.test(path.relative(root, src).replace(/\\/g, "/")),
  });
  fs.rmSync(path.join(server, "data"), { recursive: true, force: true });
  // Files the server loads by a path it computes, so tracing cannot see them.
  // Each is listed in next.config.ts's outputFileTracingIncludes; a copy that
  // lacks one starts fine and fails the first time it is needed (every PDF,
  // for the pdfjs worker), so the package is refused instead.
  for (const rel of ["node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"]) {
    if (!fs.existsSync(path.join(server, rel))) {
      console.error(`[dist] REFUSING to ship ${flavour}: server/${rel} is missing`);
      process.exit(1);
    }
  }
  // Static assets and public files are deliberately NOT traced into the
  // standalone output — Next expects them to be copied alongside it.
  fs.cpSync(path.join(root, ".next", "static"), path.join(server, ".next", "static"), {
    recursive: true,
  });
  // The research tool server a web check starts beside Claude Code. It runs as
  // a program of its own, so nothing imports it and file tracing never finds it.
  fs.cpSync(path.join(root, "research"), path.join(server, "research"), { recursive: true });
  const pub = path.join(root, "public");
  if (fs.existsSync(pub)) {
    fs.cpSync(pub, path.join(server, "public"), { recursive: true });
  }

  const exe = path.join(root, "Raazi.exe");
  if (fs.existsSync(exe)) fs.copyFileSync(exe, path.join(out, "Raazi.exe"));
  else say("WARNING: Raazi.exe is missing — run npm run build:exe first");

  return out;
}

function readme(out) {
  fs.writeFileSync(
    path.join(out, "READ ME.txt"),
    [
      "Raazi",
      "",
      "A research pedia that grows with your sources, and a newsroom that",
      "watches your beat. Runs on your machine.",
      "",
      "Running it:",
      "  1. Install Node.js (the LTS build) from nodejs.org if it isn't already.",
      "  2. Run Raazi.exe.",
      "  3. Raazi opens in its own window (Brave, Chrome or Edge in app mode).",
      "",
      "It sits in the notification area — right-click the tray icon to reopen it,",
      "open the data folder, or quit. Opening it again brings the window already",
      "open to the front rather than opening another. Closing the window leaves it",
      "running, so a long ingest keeps going; quitting from the tray stops it.",
      "",
      "Using a Raazi on another computer:",
      "  Turn on Settings → LAN mode on that computer. Then, on this one, right-click",
      "  the tray icon → Connect to another Raazi…, paste its address and token,",
      "  and Connect. The window opens that computer's Raazi, and this one keeps",
      "  a quiet copy of its library in step. If that computer stops answering, you",
      "  are told so and can carry on here; what you did comes back to it when it",
      "  answers again, and if both changed you are asked which to keep.",
      "",
      "Your whole library and your API key live in the data folder beside this",
      "file. Copy it to move your work; delete it to start fresh.",
      "",
      "Paste a Gemini (or Anthropic, or OpenAI-compatible) key into Settings to",
      "let it read sources. Everything else works offline.",
    ].join("\n") + "\n",
    "utf8",
  );
}

// ---------------------------------------------------------------------------

build();

const flavour = "client";
const out = assemble(flavour);
const data = path.join(out, "data");
// Empty, but present: the first run then has somewhere to write without asking
// anything of whoever unzipped it.
fs.mkdirSync(data, { recursive: true });
fs.writeFileSync(path.join(data, ".keep"), "");
readme(out);
assertClean(out, flavour);

const size = (dir) => {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) n += fs.statSync(path.join(e.parentPath ?? e.path, e.name)).size;
  }
  return n;
};
say(`${flavour}: ${(size(out) / 1024 / 1024).toFixed(0)} MB at dist/${flavour}`);
say("done — zip dist/client and hand it over");
