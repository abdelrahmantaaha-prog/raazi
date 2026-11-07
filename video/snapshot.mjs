// Copies the live library into out/library for filming: a consistent database
// snapshot taken while Raazi keeps running, plus the files pages display.
// config.json is deliberately left behind, so the copy has no API keys (it can
// never spend anything) and no LAN mode (it stays on loopback, no token).
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(path.resolve(import.meta.dirname, "../package.json"));
const Database = require("better-sqlite3");

const LIVE = path.resolve(import.meta.dirname, "../data");
const COPY = path.resolve(import.meta.dirname, "out/library");
const DIRS = ["sources", "covers", "portraits", "tiles", "__network__"];

fs.rmSync(COPY, { recursive: true, force: true });
fs.mkdirSync(COPY, { recursive: true });

const started = Date.now();
const live = new Database(path.join(LIVE, "corpus.db"), { readonly: true, fileMustExist: true });
await live.backup(path.join(COPY, "corpus.db"));
live.close();
console.log(`database: ${(fs.statSync(path.join(COPY, "corpus.db")).size / 1e6).toFixed(1)} MB`);

for (const dir of DIRS) {
  const from = path.join(LIVE, dir);
  if (!fs.existsSync(from)) continue;
  fs.cpSync(from, path.join(COPY, dir), { recursive: true });
  console.log(`copied ${dir}`);
}
console.log(`snapshot ready in ${((Date.now() - started) / 1000).toFixed(0)}s -> ${COPY}`);
