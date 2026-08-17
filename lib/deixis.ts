/**
 * Deciding whether a quote can stand on its own.
 *
 * A quote lifted out of a book keeps its words and loses its bearings.
 * "Immediately, Steve Bechtel knew he was being rebuffed" is a perfectly good
 * sentence and a useless piece of evidence: rebuffed by whom, over what? The
 * answer was in the paragraph above, and the paragraph above is not in the
 * entry.
 *
 * The extractor is asked to record that answer and mostly does not — across a
 * real library, 6% of its quotes came back with one, against 33% that open with
 * a plain backward reference. And the zero-token sweep, which supplies about an
 * eighth of all evidence by matching names against sentences, cannot record one
 * at all: it never reads anything but the sentence it matched.
 *
 * So detection is done here, mechanically, rather than left to a model's
 * judgement about its own output. This module answers one question — does this
 * sentence lean on something outside itself? — and the answer decides which
 * quotes are worth spending a resolution call on.
 *
 * It is deliberately a *screen*, not a verdict. Over-selecting costs one entry
 * in a batched call and gets the answer "it stands alone"; under-selecting
 * leaves a dangling quote in an entry for good. So the rules lean towards
 * catching too much, and the resolver is allowed to say no.
 *
 * No database, no model: it is a pure function of a string, which is what makes
 * it testable against the library rather than argued about.
 */

/** Why a quote was judged to need its surroundings. Shown in the UI and logs. */
export type DeixisCue =
  | "connective"
  | "pronoun"
  | "demonstrative"
  | "definite"
  | "unnamed-agent";

export interface DeixisVerdict {
  needs: boolean;
  cues: DeixisCue[];
  /** The words that triggered it, for reporting and for tuning these rules. */
  matched: string[];
}

/**
 * Openers that point backwards.
 *
 * All of these are only cues when they *start* the quote. "But" mid-sentence is
 * ordinary contrast; "But" as the first word means the sentence is answering
 * something it does not contain. The list is long because this is the cue that
 * caught the Bechtel case, which no pronoun rule would have.
 */
const CONNECTIVES = [
  "immediately", "then", "thereafter", "afterward", "afterwards", "subsequently",
  "meanwhile", "instead", "however", "but", "yet", "so", "thus", "therefore",
  "consequently", "as a result", "in response", "in return", "following",
  "after that", "after this", "in the midst of", "at the same time", "nevertheless",
  "nonetheless", "still", "again", "eventually", "later", "by then", "by now",
  "for this reason", "for that reason", "because of this", "because of that",
  "despite this", "despite that", "in spite of this", "even so", "either way",
  "on the contrary", "in the end", "at last", "finally", "once more",
  // Arabic
  "ثم", "بعد ذلك", "إثر ذلك", "على إثر", "وعندئذ", "عندئذ", "حينئذ", "لذلك",
  "ولذلك", "من ثم", "ومن ثم", "غير أن", "إلا أن", "بيد أن", "ومع ذلك", "مع ذلك",
  "في تلك الأثناء", "في هذه الأثناء", "وفي المقابل", "نتيجة لذلك", "وبناء على ذلك",
];

/**
 * Nouns that are almost always pointing at something already introduced when
 * they arrive with a definite article and no describing words of their own.
 * "the agreement" is a reference; "the agreement signed at Taif in 1934" is not.
 */
const DEFINITE_NOUNS = [
  "incident", "agreement", "deal", "meeting", "massacre", "attack", "war",
  "company", "plan", "project", "contract", "decision", "offer", "proposal",
  "visit", "trip", "letter", "report", "crisis", "affair", "fiasco", "dispute",
  "negotiation", "negotiations", "talks", "conference", "treaty", "coup",
  "revolt", "uprising", "revolution", "battle", "raid", "operation", "scheme",
  "arrangement", "settlement", "episode", "event", "matter", "issue", "case",
  "accident", "disaster", "killing", "assassination", "bombing", "invasion",
  "withdrawal", "ceasefire", "truce", "conflict", "quarrel", "row", "scandal",
];

/** Verbs whose doer is routinely left in the previous sentence. */
const UNNAMED_AGENT =
  /\b(?:was|were|had been|has been|being)\s+(?:\w+ly\s+)?(?:rebuffed|rejected|refused|denied|turned down|told|informed|warned|summoned|dismissed|removed|replaced|overruled|persuaded|convinced|approached|offered|granted|awarded|accused|blamed|criticized|criticised|attacked|arrested|detained|released|appointed|promoted|sacked|fired|ousted|deposed)\b/i;

const PRONOUNS = new Set(
  ("he she they it his her their its him them himself herself themselves " +
    "هو هي هم هن هما له لها لهم بها به إليه إليها").split(" ")
);

const DEMONSTRATIVES = new Set(
  "this that these those هذا هذه ذلك تلك هؤلاء أولئك".split(" ")
);

/**
 * Prepositions after which a demonstrative is pointing at something earlier:
 * "after this meeting", "during that visit". Everywhere else "that" is usually
 * a relative pronoun — "a population that would never accept" — which refers
 * forward, inside the sentence, and is not a gap at all. Counting those was
 * flagging a third of the library.
 */
const DEIXIS_PREPS = new Set(
  ("after before in on at by with from during despite following since until " +
    "throughout amid amidst upon over under through against toward towards").split(" ")
);

/**
 * Capitalised words that open sentences without being names.
 *
 * Needed because the first word of a quote is capitalised whatever it is, so
 * position alone cannot tell "Herzl, the acknowledged leader…" from "However,
 * the leader…". Without this list the first case looked like it had no name in
 * it, and every later pronoun read as unbound.
 */
const NOT_NAMES = new Set(
  ("the a an this that these those it he she they his her their its him them and but or " +
    "in on at by with from for to of as if when while after before during since until " +
    "through following immediately still however yet so thus therefore meanwhile instead " +
    "although though because despite between among against about over under within " +
    "there here what which who whom whose why how all both each every many most some " +
    "no not nor only even just perhaps such rather more less other another one two three " +
    "first second third last next then now once again finally later eventually")
    .split(" ")
);

/**
 * Connectives that are only backward-pointing when a comma follows.
 *
 * "Still others were exiled" opens a list; "Still, others were exiled" answers
 * something before it. Same word, different job, and without this distinction
 * the rule fired on every sentence beginning "Still others" — which is how it
 * was found.
 */
const NEEDS_COMMA = new Set(["still", "again", "so", "yet", "finally", "later"]);

/**
 * Strips what sits in front of the first real word: quotation marks, brackets,
 * and the footnote numbers this library's PDFs carry into the middle of the
 * text ("22 After this initial meeting…"), which would otherwise hide the
 * opening word from every rule here.
 */
function opening(quote: string): string {
  return quote
    .replace(/^[\s"“”'‘’«»\-–—(\[]+/, "")
    .replace(/^\d{1,3}\s+(?=[A-Za-z؀-ۿ])/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Words in the quote, stripped of punctuation, keeping their case. */
function tokens(text: string): string[] {
  return text.split(/[\s,;:.—–\-("“”')\[\]]+/).filter(Boolean);
}

/**
 * Where the first word that could *bind* a reference appears.
 *
 * A name, in other words: a capitalised word that is not merely the sentence's
 * first word and is not itself a pronoun. The test that matters is positional —
 * a pronoun standing before any name has nothing inside the quote to refer to,
 * while one standing after a name usually refers to it. That single comparison
 * replaced a pile of special cases, and it is why "Immediately, Steve Bechtel
 * knew he was being rebuffed" is not flagged as a loose pronoun (it is caught
 * by its opener instead, which is the honest reason it fails).
 */
function firstNameAt(words: string[]): number {
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const lower = w.toLowerCase();
    if (PRONOUNS.has(lower)) continue;
    // A capital in first position proves nothing on its own, so the word itself
    // has to be one that would not ordinarily open a sentence.
    if (i === 0 && NOT_NAMES.has(lower)) continue;
    if (/^[A-Z؀-ۿ]/.test(w) && w.length > 1) return i;
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * Does this quote need its surroundings to be understood?
 *
 * Returns every cue found rather than the first, because the cues are how these
 * rules get tuned: a rule that fires alone on a thousand quotes and never with
 * another is a rule to look at again.
 */
export function needsContext(quote: string): DeixisVerdict {
  const cues: DeixisCue[] = [];
  const matched: string[] = [];
  const text = opening(quote);
  if (!text) return { needs: false, cues, matched };

  const lower = text.toLowerCase();
  const words = tokens(text);
  const nameAt = firstNameAt(words);

  // 1. A backward-pointing opener.
  for (const c of CONNECTIVES) {
    if (!lower.startsWith(c)) continue;
    const after = lower.slice(c.length);
    if (!/^[\s,;:]/.test(after)) continue;
    // The ambiguous ones only count when punctuation marks them as an aside.
    if (NEEDS_COMMA.has(c) && !/^[,;:]/.test(after)) continue;
    cues.push("connective");
    matched.push(c);
    break;
  }

  // 2. A pronoun or a demonstrative standing before any name that could bind
  //    it. Scanned across the opening clause rather than only at position zero,
  //    because an adverbial phrase in front of it changes nothing: "Through
  //    persistence, he found a position" is exactly as unmoored as "He found a
  //    position", and only the second was being caught.
  const reach = Math.min(words.length, Math.max(6, nameAt));
  for (let i = 0; i < reach; i++) {
    const w = words[i].toLowerCase();
    if (i >= nameAt) break;
    if (PRONOUNS.has(w)) {
      cues.push("pronoun");
      matched.push(words[i]);
      break;
    }
  }
  for (let i = 0; i < reach; i++) {
    const w = words[i].toLowerCase();
    if (i >= nameAt) break;
    if (!DEMONSTRATIVES.has(w)) continue;
    // Only where it is genuinely pointing outward: opening the sentence, or
    // governed by a preposition. Anywhere else "that" is a relative pronoun.
    const governed = i > 0 && DEIXIS_PREPS.has(words[i - 1].toLowerCase());
    if (i !== 0 && !governed) continue;
    cues.push("demonstrative");
    matched.push(words[i]);
    break;
  }

  // 4. A bare definite reference: "the agreement", but not "the agreement that
  //    ended the war", which describes itself.
  for (const noun of DEFINITE_NOUNS) {
    const re = new RegExp(`\\bthe\\s+${noun}\\b(?!\\s+(?:that|which|who|of|between|with|signed|made|reached|struck|to\\s))`, "i");
    if (re.test(lower)) {
      cues.push("definite");
      matched.push(`the ${noun}`);
      break;
    }
  }

  // 5. Something was done to someone by nobody named.
  if (UNNAMED_AGENT.test(text)) {
    cues.push("unnamed-agent");
    matched.push(UNNAMED_AGENT.exec(text)![0]);
  }

  return { needs: cues.length > 0, cues, matched };
}

/**
 * A short phrase naming what is missing, for the UI.
 *
 * Deliberately plain: someone reading an entry wants to know that a quote leans
 * on something, not to be taught the word "deixis".
 */
export function cueLabel(cue: DeixisCue): string {
  switch (cue) {
    case "connective":
      return "opens by referring back";
    case "pronoun":
      return "opens with a pronoun";
    case "demonstrative":
      return "opens with “this” or “that”";
    case "definite":
      return "names something not introduced here";
    case "unnamed-agent":
      return "does not say by whom";
  }
}
