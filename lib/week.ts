/**
 * The working week, which starts on a Friday.
 *
 * Not a preference: it is the shape of the job. The weekly brief is delivered
 * at work, the week it covers closes on a Thursday, and a page that reset on a
 * Sunday would be showing half of one brief and half of the next on the two
 * days you actually write it.
 *
 * "Resets on Friday" therefore means the window rolls on Friday morning, and
 * nothing is thrown away when it does: the week that just closed keeps its own
 * page and its own written brief. The reset is a new page, not an erasure —
 * which is also why it does not matter whether you write the brief late on
 * Thursday or first thing on Friday. Both are one click from the other.
 */

/** Friday. 0 is Sunday in JavaScript, so 5. */
export const WEEK_STARTS_ON = 5;

/** Midnight local at the start of the week containing `now`. */
export function weekStart(now = new Date()): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // How many days back to the most recent Friday, today included.
  const back = (d.getDay() - WEEK_STARTS_ON + 7) % 7;
  d.setDate(d.getDate() - back);
  return d;
}

export function weekEnd(now = new Date()): Date {
  const end = weekStart(now);
  end.setDate(end.getDate() + 7);
  return end;
}

/** The local calendar date of a day, which is the one you live in. */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * A week's key, which is its Friday with a prefix.
 *
 * The prefix is what lets a week and a day share the `briefs.day` column and
 * its UNIQUE constraint: "2026-09-04" is Friday's daily brief, and
 * "week:2026-09-04" is the brief for the week that Friday opened.
 */
export function weekKey(now = new Date()): string {
  return `week:${dayKey(weekStart(now))}`;
}

export function isWeekKey(key: string): boolean {
  return /^week:\d{4}-\d{2}-\d{2}$/.test(key);
}

/** The window a week key names, as real dates. */
export function weekRange(key: string): { from: Date; to: Date } {
  const [y, m, d] = key.replace("week:", "").split("-").map(Number);
  const from = new Date(y, m - 1, d);
  const to = new Date(y, m - 1, d + 7);
  return { from, to };
}

/** The key of the week before this one, for "last week". */
export function previousWeekKey(key: string): string {
  const { from } = weekRange(key);
  from.setDate(from.getDate() - 7);
  return `week:${dayKey(from)}`;
}

export function nextWeekKey(key: string): string {
  const { to } = weekRange(key);
  return `week:${dayKey(to)}`;
}

/** "5–11 September 2026", for a heading. */
export function describeWeek(key: string): string {
  const { from, to } = weekRange(key);
  const last = new Date(to.getTime() - 1);
  const month = (d: Date) => d.toLocaleDateString("en-GB", { month: "long" });
  const sameMonth = from.getMonth() === last.getMonth() && from.getFullYear() === last.getFullYear();
  return sameMonth
    ? `${from.getDate()}–${last.getDate()} ${month(last)} ${last.getFullYear()}`
    : `${from.getDate()} ${month(from)} – ${last.getDate()} ${month(last)} ${last.getFullYear()}`;
}

/** Whether this key names the week we are living in. */
export function isCurrentWeek(key: string, now = new Date()): boolean {
  return key === weekKey(now);
}

/** Days left before the window rolls, for a page that wants to say so. */
export function daysLeftInWeek(now = new Date()): number {
  return Math.max(0, Math.ceil((weekEnd(now).getTime() - now.getTime()) / 86_400_000));
}
