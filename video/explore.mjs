// Screenshots pages of the filming instance at recording size, to plan shots.
//   node explore.mjs [path ...]
import { chromium } from "playwright";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.FILM_URL ?? "http://127.0.0.1:5410";
const OUT = path.resolve(import.meta.dirname, "out/explore");
fs.mkdirSync(OUT, { recursive: true });

const require = createRequire(path.resolve(import.meta.dirname, "../package.json"));
const Database = require("better-sqlite3");
const db = new Database(path.resolve(import.meta.dirname, "out/library/corpus.db"), { readonly: true });
const book = db.prepare("select id, title from sources where kind in ('epub','pdf') and status='ready' order by id limit 1").get();
const draft = db.prepare("select id from drafts order by id limit 1").get();
db.close();

const paths = process.argv.slice(2).length ? process.argv.slice(2) : [
  "/brief", "/week", "/calendar", "/inbox", "/stories", "/stories/103", "/feeds",
  "/", `/sources/${book.id}`, "/quotes", "/tags", "/pedia", "/pedia/20336",
  "/pedia/20336?tab=history", "/network", `/write?draft=${draft.id}`, "/search", "/settings",
];
console.log(`book: ${book.id} ${book.title} · draft: ${draft.id}`);

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1.2 });
const page = await context.newPage();
for (const p of paths) {
  const name = p.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "") || "library";
  try {
    await page.goto(BASE + p, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    console.log(`ok ${p} -> ${name}.png`);
  } catch (e) {
    console.log(`fail ${p}: ${e.message.split("\n")[0]}`);
  }
}
await browser.close();
