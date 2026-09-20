import type Database from "better-sqlite3";
import { unescapeText } from "../ai/escapes";

/**
 * Repairs text a model escaped twice, before anything looked for it.
 *
 * `unescapeModelJson` now catches this where model output enters the app, but
 * the rows written before it existed are still there: on 20 September 2026,
 * 23 entry bodies, 3 of the 10 briefs and 20 revision changelogs carried a
 * literal backslash-n where a line break belonged. The John Kennedy and Amy
 * Klobuchar entries each printed a section heading twice and ran everything
 * after it together into one block.
 *
 * Every column here holds markdown written by a model, where a literal `\n`
 * is always damage — except inside a fenced code block, which `unescapeText`
 * leaves alone. Re-running is harmless: a repaired row no longer matches.
 */
export function migrateEscapes(db: Database.Database) {
  const targets: { table: string; key: string; columns: string[] }[] = [
    { table: "entries", key: "entity_id", columns: ["body_md", "summary"] },
    { table: "entry_revisions", key: "id", columns: ["body_md", "changelog_md"] },
    { table: "briefs", key: "id", columns: ["body_md"] },
  ];

  let repaired = 0;
  for (const { table, key, columns } of targets) {
    for (const column of columns) {
      let rows: { k: number; v: string | null }[];
      try {
        // char(92) is a backslash. Written this way rather than as a LIKE
        // pattern because `LIKE '%\n%' ESCAPE '\'` reads as "an escaped n",
        // which matches every row holding the letter n.
        rows = db
          .prepare(
            `SELECT ${key} AS k, ${column} AS v FROM ${table}
              WHERE instr(${column}, char(92) || 'n') > 0`
          )
          .all() as { k: number; v: string | null }[];
      } catch {
        // A table or column this build does not have yet is not an error.
        continue;
      }
      const update = db.prepare(`UPDATE ${table} SET ${column}=? WHERE ${key}=?`);
      for (const row of rows) {
        const before = row.v ?? "";
        const after = unescapeText(before);
        if (after === before) continue;
        update.run(after, row.k);
        repaired++;
      }
    }
  }

  if (repaired > 0) {
    console.log(`[corpus] repaired escaped newlines in ${repaired} field${repaired === 1 ? "" : "s"}`);
  }
  return repaired;
}
