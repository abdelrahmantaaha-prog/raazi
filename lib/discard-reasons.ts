/**
 * The vocabulary of a discard, with no database behind it.
 *
 * Separate from lib/audit.ts for one reason: the picker that uses this list is a
 * client component, and a client component that imports anything touching the
 * database drags better-sqlite3 into the browser bundle and fails the build with
 * "Can't resolve 'fs'". That boundary has caught this codebase three times
 * (videoId, focusLayout, dirOf), so anything both sides need lives in a module
 * like this one, which imports nothing.
 */

export type DiscardReason =
  | "wrong-person"
  | "not-about-subject"
  | "wrong-context"
  | "misquoted"
  | "unsupported"
  | "trivial"
  | "duplicate";

/** 'entity' applies to one subject; 'library' is a standing correction. */
export type DiscardScope = "entity" | "library";

export interface ReasonSpec {
  id: DiscardReason;
  /** What you pick in the UI. */
  label: string;
  /** The distinction, for when two of them look close. */
  hint: string;
  /**
   * How this reads back to the model, phrased as an instruction rather than as
   * a complaint. Written in the second person because that is where it lands:
   * appended to the system prompt of the call that made the mistake.
   */
  teaches: string;
}

/**
 * The reasons on offer.
 *
 * A closed list rather than free text alone, because a category is something
 * the pipeline can act on and a sentence is not — "wrong person" is a different
 * failure from "misquoted" and deserves different words back. The free-text note
 * sits alongside and carries what the category cannot.
 */
export const DISCARD_REASONS: ReasonSpec[] = [
  {
    id: "wrong-person",
    label: "Different person, same name",
    hint: "The passage is about someone else who shares the name.",
    teaches:
      "Passages here have been filed under the wrong individual because the name matched. A shared name is not identity: check dates, offices, and relatives before attributing a passage to this subject.",
  },
  {
    id: "not-about-subject",
    label: "Not about this subject",
    hint: "The subject is named, but the passage is about something else.",
    teaches:
      "Passages have been collected here that merely mention the subject in passing while being about something else. A name appearing in a sentence does not make the sentence evidence about its bearer.",
  },
  {
    id: "wrong-context",
    label: "Back-reference resolved wrongly",
    hint: 'The "refers to" line points at the wrong thing.',
    teaches:
      "Back-references have been resolved incorrectly here. Where a quote leans on something named earlier, name what the text actually points at, and leave it unresolved rather than guessing.",
  },
  {
    id: "misquoted",
    label: "Not what the source says",
    hint: "The quote is altered, run together, or not in the passage.",
    teaches:
      "Quotes here have not matched the source text. Copy quotes character-for-character from the passage; never join separated sentences into one quote.",
  },
  {
    id: "unsupported",
    label: "Claim overreaches the quote",
    hint: "The quote is real; the claim drawn from it is not.",
    teaches:
      "Claims here have asserted more than their quotes support. State only what the quoted words establish.",
  },
  {
    id: "trivial",
    label: "Says nothing worth recording",
    hint: "Accurate, but carries no fact about the subject.",
    teaches:
      "Passages of no substance have been collected here. A passage earns a place only if it asserts something about the subject.",
  },
  {
    id: "duplicate",
    label: "Already covered",
    hint: "Another passage records the same thing.",
    teaches:
      "Duplicate evidence has been recorded here. Where several passages state the same fact, keep the fullest one.",
  },
];

const REASON_BY_ID = new Map(DISCARD_REASONS.map((r) => [r.id, r]));

export function reasonSpec(id: string): ReasonSpec | undefined {
  return REASON_BY_ID.get(id as DiscardReason);
}

/** What a reason is called on screen, falling back to the raw id. */
export function reasonLabel(id: string): string {
  return REASON_BY_ID.get(id as DiscardReason)?.label ?? id;
}

export function isReason(id: string): id is DiscardReason {
  return REASON_BY_ID.has(id as DiscardReason);
}

/**
 * How a quote is recognised again after its row has been destroyed and rebuilt.
 *
 * Whitespace and case only. Deliberately not the aggressive normalisation used
 * for names: two quotes differing by a word are different evidence and must not
 * collapse onto one verdict, while the same quote re-extracted with the line
 * breaks folded differently is the same evidence and must.
 */
export function quoteKeyOf(quote: string): string {
  return quote.replace(/\s+/g, " ").trim().toLowerCase();
}
