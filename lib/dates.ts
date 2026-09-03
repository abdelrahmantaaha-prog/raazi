/**
 * Dates, said the same way everywhere.
 *
 * Every page used to trim the raw column its own way — `slice(0, 10)` here,
 * `slice(0, 16)` there, `toLocaleString()` on a third — so the same moment read
 * differently depending on which screen you were on, and none of them were in
 * your own time zone. SQLite stamps rows with `datetime('now')`, which is UTC
 * written without saying so: "2026-09-03 14:05:11". Parsed as-is, JavaScript
 * takes that for local time and the morning routine appears to have run in the
 * afternoon.
 *
 * No database and no React, so both sides of the client boundary can use it.
 */

export type DateInput = string | number | Date | null | undefined;

/** `YYYY-MM-DD HH:MM:SS`, with or without fractional seconds — SQLite's own. */
const SQLITE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/;
/** A bare day, which is a calendar fact rather than an instant. */
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Turns whatever a row or an API handed over into a Date, or null when it is
 * not one. A SQLite stamp is read as UTC; anything carrying its own zone (an
 * ISO string with a Z or an offset) is trusted; a bare day is taken at local
 * midnight so it prints as the day it names.
 */
export function parseDate(value: DateInput): Date | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const s = value.trim();
  let d: Date;
  const sqlite = SQLITE.exec(s);
  if (sqlite) d = new Date(`${sqlite[1]}T${sqlite[2]}Z`);
  else if (DAY.test(s)) d = new Date(`${s}T00:00:00`);
  else d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

const DAY_FORMAT: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" };
const TIME_FORMAT: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hour12: false };

/** "3 Sep 2026", or with `time` "3 Sep 2026, 14:05". Empty for nothing. */
export function formatDate(value: DateInput, opts: { time?: boolean } = {}): string {
  const d = parseDate(value);
  if (!d) return "";
  const day = d.toLocaleDateString("en-GB", DAY_FORMAT);
  if (!opts.time) return day;
  return `${day}, ${d.toLocaleTimeString("en-GB", TIME_FORMAT)}`;
}

export function formatDateTime(value: DateInput): string {
  return formatDate(value, { time: true });
}

/**
 * "just now", "4 min ago", "3 h ago", "yesterday", "5 days ago" — and past a
 * fortnight the plain date, because "23 days ago" is harder to place than the
 * day itself. Works forwards too: "in 2 h" for a run that retries later.
 */
export function relativeDate(value: DateInput, now: DateInput = new Date()): string {
  const d = parseDate(value);
  const ref = parseDate(now);
  if (!d || !ref) return "";

  const diff = d.getTime() - ref.getTime();
  const past = diff <= 0;
  const abs = Math.abs(diff);
  const minutes = Math.round(abs / 60_000);
  const hours = Math.round(abs / 3_600_000);
  const days = Math.round(abs / 86_400_000);

  const say = (s: string) => (past ? `${s} ago` : `in ${s}`);
  if (abs < 45_000) return "just now";
  if (minutes < 60) return say(`${minutes} min`);
  if (hours < 24) return say(`${hours} h`);
  if (days === 1) return past ? "yesterday" : "tomorrow";
  if (days < 14) return say(`${days} days`);
  return formatDate(d);
}

/** True when the moment is more than `minutes` old. */
export function olderThan(value: DateInput, minutes: number, now: DateInput = new Date()): boolean {
  const d = parseDate(value);
  const ref = parseDate(now);
  if (!d || !ref) return false;
  return ref.getTime() - d.getTime() > minutes * 60_000;
}
