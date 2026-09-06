import { db, tx } from "./db";
import { createRun, enqueue } from "./queue";
import { getConfig, saveConfig } from "./config";

/**
 * The morning routine: maintenance that should happen daily without being asked.
 *
 * Two jobs, both chosen because they compound quietly if left alone:
 *
 *  - Entries carrying more than one verification flag are regenerated. A flag
 *    means a sentence its own citations do not carry; one can be the verifier
 *    being fussy, but two or more means the entry genuinely drifted from its
 *    evidence — and nothing else ever rewrites it, because a flagged entry is
 *    `fresh` in the staleness sense (its evidence has not changed; its honesty
 *    has). The rewrite receives the verdicts (see pastFailures in
 *    lib/pipeline/entry.ts) and investigates each one.
 *
 *  - The picture hunt runs. plan_portraits costs no tokens — it is Wikidata
 *    lookups — and entities that earned an entry since yesterday deserve their
 *    photograph without anyone remembering to press the button.
 *
 * Scheduling is deliberately humble. There is no cron here: Corpus is a tray
 * app on a laptop that sleeps, so "every morning at seven" really means "the
 * first opportunity after seven, once per day" — checked from the worker's idle
 * loop and from a daily timer, with the day claimed in config *before* any work
 * is queued so two triggers cannot both run it.
 *
 * Chores never run against a scratch library (CORPUS_DATA_DIR set): every test
 * opens one, and a test suite that quietly queued token-spending rewrites in
 * its sandbox would be measuring the wrong thing.
 */

/** "More than one comment", as asked: two flags is where fussiness ends. */
export const MIN_FLAGS_FOR_REWRITE = 2;

const todayKey = (now: Date) =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

/** Today at the configured hour, or tomorrow's if that has already passed. */
export function nextMorningAt(now: Date, hour = getConfig().morningHour): Date {
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, 0, 0, 0);
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at;
}

export function choresDue(now = new Date()): boolean {
  // A scratch library is a test. Unattended spending stays out of it.
  if (process.env.CORPUS_DATA_DIR) return false;

  const cfg = getConfig();
  if (!cfg.morningChores) return false;
  if (cfg.lastChores === todayKey(now)) return false;

  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), cfg.morningHour, 0, 0, 0);
  return now.getTime() >= at.getTime();
}

/**
 * The entries whose flags have crossed the line.
 *
 * An entry is required, not just an entity — the point is rewriting prose that
 * exists — and the worst offenders go first, so if quota runs out partway the
 * morning fixed the entries most in need of it.
 */
export function flaggedForRewrite(min = MIN_FLAGS_FOR_REWRITE): { entityId: number; name: string; flags: number }[] {
  return (
    db()
      .prepare(
        `SELECT f.entity_id AS entityId, e.canonical_name AS name, COUNT(*) AS flags
           FROM entry_flags f
           JOIN entities e ON e.id = f.entity_id AND e.merged_into IS NULL
           JOIN entries en ON en.entity_id = f.entity_id
          -- An entry already rewritten twice for its flags, on the same
          -- evidence, is not rewritten a third time: at that point the flags
          -- are the verifier's opinion of the evidence, not of the prose, and
          -- the morning routine was rewriting the same entries every day.
          WHERE en.flag_rewrites < ?
          -- And not more than once a week whatever the evidence does. The
          -- counter above resets the moment the evidence changes, which for a
          -- subject a news beat is actually about — Donald Trump, the Trump
          -- administration, Canada — is every single day. So the cap never
          -- engaged for exactly the entries that cost the most: six rewrites
          -- of one entry in two days, each with a verification pass behind it,
          -- was most of a $20 bill. New evidence still refreshes an entry; it
          -- is chasing the verifier's flags that is rationed.
            AND (en.flag_rewritten_at IS NULL
                 OR en.flag_rewritten_at < datetime('now', ?))
          GROUP BY f.entity_id
         HAVING COUNT(*) >= ?
          ORDER BY COUNT(*) DESC, f.entity_id`
      )
      .all(MAX_FLAG_REWRITES, `-${FLAG_REWRITE_COOLDOWN_DAYS} days`, min) as {
        entityId: number;
        name: string;
        flags: number;
      }[]
  );
}

/** How many flag-driven rewrites one evidence set may receive. */
export const MAX_FLAG_REWRITES = 2;

/** And how long an entry rests afterwards, whatever new evidence arrives. */
export const FLAG_REWRITE_COOLDOWN_DAYS = 7;

/**
 * Queues the morning's work as one run, and says what it queued.
 *
 * Separate from the due-check on purpose: this is the testable half, and also
 * what a future "run the morning routine now" button would call.
 */
export function queueMorningRun(): { runId: number; rewrites: number } {
  const flagged = flaggedForRewrite();

  return tx(() => {
    const runId = createRun({
      kind: "morning",
      label:
        flagged.length > 0
          ? `Morning routine — the feeds, then ${flagged.length} flagged entr${flagged.length === 1 ? "y" : "ies"}, then pictures`
          : "Morning routine — the feeds, then pictures",
      budgetCap: getConfig().defaultBudget,
    });

    // The feeds first: an entry rewritten before the morning's articles are in
    // is an entry that will be stale by the time you read it.
    if (getConfig().feedPolling) {
      enqueue(runId, [{ kind: "plan_polls" as const, payload: {} }]);
    }

    if (flagged.length > 0) {
      enqueue(
        runId,
        flagged.map((f) => ({
          // force: a flagged entry is fresh by the evidence hash, and without
          // force the handler would answer "already current" and skip it. The
          // rewrite receives the flag verdicts and investigates each one.
          kind: "entry" as const,
          payload: { entityId: f.entityId, force: true, fromFlags: true },
        }))
      );
    }

    // Free, and it finds photographs for whatever earned an entry yesterday.
    enqueue(runId, [{ kind: "plan_portraits" as const, payload: {} }]);

    return { runId, rewrites: flagged.length };
  });
}

/**
 * Runs the routine if it is due. Returns what was queued, or null.
 *
 * The day is claimed before anything is queued: the idle loop and the daily
 * timer can both arrive here within a tick of each other, and a run queued
 * twice would rewrite every flagged entry twice.
 */
export function runMorningChores(now = new Date()): { runId: number; rewrites: number } | null {
  if (!choresDue(now)) return null;
  saveConfig({ lastChores: todayKey(now) });

  const queued = queueMorningRun();
  console.log(
    `[corpus] morning routine: ${queued.rewrites} flagged entr${queued.rewrites === 1 ? "y" : "ies"} to rewrite, and the picture hunt`
  );
  return queued;
}
