/**
 * Scores the By meaning search against questions whose right passage is known.
 *
 * Run it after any change to how the search ranks, with Raazi running:
 *
 *   node scripts/eval-meaning.mjs
 *
 * It asks the running app, through its own endpoint, so what it scores is the
 * code actually shipped — no replica to drift from it. It spends one embedding
 * call per question (36) and nothing else.
 *
 * The questions are in scripts/eval/. Each paraphrases one passage in the
 * live library: the vague ones avoid that passage's distinctive words, so a
 * hit means the meaning matched rather than the vocabulary; the name ones use
 * a person, a company or a decree, which is what word matching is for. They
 * point at chunk ids, so re-reading one of those books will orphan its
 * question — a question whose passage is gone is reported, not scored.
 *
 * Baseline on 22 September 2026, after the ranking was rebuilt from these
 * measurements (see lib/meaning-search.ts):
 *
 *   VAGUE  MRR 0.824 · first 18/24 · top five 22/24
 *   NAMES  MRR 0.903 · first 10/12 · top five 12/12
 *
 * against 0.700 / 13 and 0.715 / 7 for the blend it replaced.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { EVAL } from "./eval/questions.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const NAMES = JSON.parse(fs.readFileSync("scripts/eval/names.json", "utf8"));
const config = JSON.parse(fs.readFileSync("data/config.json", "utf8"));
const token = config.lan?.enabled ? config.lan.token : null;
const port = process.env.PORT ?? 5400;

const db = new Database("data/corpus.db", { readonly: true, fileMustExist: true });
const exists = (id) => Boolean(db.prepare("SELECT 1 FROM chunks WHERE id=?").get(id));

async function ask(q) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`http://127.0.0.1:${port}/api/ask`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { "x-corpus-token": token } : {}) },
      body: JSON.stringify({ question: q, limit: 60 }),
    });
    const data = await res.json();
    if (res.ok) return data;
    if (attempt > 4) throw new Error(data.error ?? `HTTP ${res.status}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

let worst = 1;
for (const [label, set] of [["VAGUE", EVAL], ["NAMES", NAMES]]) {
  const live = set.filter((e) => exists(e.id));
  const orphaned = set.length - live.length;
  let mrr = 0, r1 = 0, r5 = 0;
  const ranks = [];
  for (const e of live) {
    const { results } = await ask(e.q);
    const at = results.findIndex((r) => r.chunkId === e.id);
    const rank = at < 0 ? Infinity : at + 1;
    ranks.push(rank === Infinity ? "—" : rank);
    mrr += rank === Infinity ? 0 : 1 / rank;
    if (rank <= 1) r1++;
    if (rank <= 5) r5++;
  }
  const n = live.length || 1;
  worst = Math.min(worst, mrr / n);
  console.log(
    `${label.padEnd(6)} MRR ${(mrr / n).toFixed(3)} · first ${r1}/${live.length} · top five ${r5}/${live.length}` +
      (orphaned ? ` · ${orphaned} question(s) whose passage is gone` : "")
  );
  console.log(`       ranks: ${ranks.join(" ")}`);
}
db.close();
// A floor well under today's numbers: this fails on a real regression, not on
// a library that has grown and moved a right answer from first to second.
process.exit(worst >= 0.65 ? 0 : 1);
