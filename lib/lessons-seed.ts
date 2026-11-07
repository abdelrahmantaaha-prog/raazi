/**
 * The lessons Raazi starts with.
 *
 * Every one of these was learned the hard way on 16 September 2026, reading
 * the 15 September brief and the ten most-cited entries against their own
 * sources: background written as the day's news, "on Monday night" in a
 * reference entry, one pledge reported twice from two wire copies, an index
 * line written up as a fact, a topic heading that was the tail of one
 * article. The rules were put into the prompts; they are also here, where
 * you can read them, add to them, and switch one off if it turns out to be
 * wrong for your library.
 *
 * Pure data, imported by the migration that seeds them and by nothing that
 * touches the database, so there is no cycle. `key` is what makes seeding
 * idempotent: a lesson already present by key is left as you last edited it.
 */
export interface SeedLesson {
  key: string;
  stage: string;
  text: string;
  why?: string;
}

export const SEED_LESSONS: SeedLesson[] = [
  {
    key: "all.only-the-passages",
    stage: "all",
    text: "Use only the passages supplied. What you know from elsewhere does not go in, however true it is; a true unsourced sentence is the failure this tool exists to prevent.",
  },

  // --- the entry writer -----------------------------------------------------
  {
    key: "entry.absolute-dates",
    stage: "entry",
    text: "Dates are absolute. Resolve \"on Monday\", \"last year\", \"this April\", \"a decade ago\" against the passage's publication date or its \"dated:\" line and write the date itself (\"on 14 September 2026\"). A reference entry is read months later, when \"Monday\" means nothing.",
    why: "The Trump entry said the Supreme Court ruled \"on Monday night\" and an order was signed \"last year\".",
  },
  {
    key: "entry.one-fact-once",
    stage: "entry",
    text: "One fact, once. Several passages reporting the same thing — two accounts of one pledge, three of one ruling — are one sentence carrying all their markers, never one sentence each.",
    why: "The $5,000 dividend pledge and a March executive order were each written twice from two wire copies.",
  },
  {
    key: "entry.no-apparatus",
    stage: "entry",
    text: "A sentence whose only content is that the subject is mentioned, listed, indexed, referenced or \"associated with\" someone is not a fact and is not written. Nor is a source's own apparatus: an index line, a note, a contents entry, a credit, a byline.",
    why: "\"Index entries list references specifically to Palestinians\" was a cited sentence in the Palestinians entry.",
  },
  {
    key: "entry.short-paragraphs",
    stage: "entry",
    text: "Paragraphs run four to six sentences on one subject. A section with more to say is several paragraphs, each on its own episode or aspect, in time order. A twenty-sentence paragraph is a list wearing prose.",
    why: "The United States entry had a 26-sentence paragraph running from 1917 to 2026.",
  },
  {
    key: "entry.summary-is-the-subject",
    stage: "entry",
    text: "The summary describes the subject (\"Ramallah is a city in the West Bank…\"), never the entry (\"This entry details…\", \"An overview of…\").",
  },
  {
    key: "entry.episodes-for-office-holders",
    stage: "entry",
    text: "For someone in office now, each episode the sources follow — a war, a court fight, a trade dispute, an election — is its own dated section in time order, and the most consequential is the lead. Not a section per continent with the episodes shuffled together.",
  },
  {
    key: "entry.attribute-reported-claims",
    stage: "entry",
    text: "A claim the passage attributes to someone (\"according to the report\", \"officials said\") is written attributed, never as a settled fact; an allegation, opinion, forecast or denial stays what it is.",
  },

  // --- the brief ------------------------------------------------------------
  {
    key: "brief.background-is-not-news",
    stage: "brief",
    text: "A passage marked BEFORE THIS WINDOW is background the article was reminding its readers of. It may support a subordinate clause and no more: never an item, never a sentence of its own, never the headline. An order signed last year, a hearing in July, a primary lost in June are not today's developments.",
    why: "The 15 September brief reported a 2025 executive order, a July hearing and a 2016 precedent as the day's news.",
  },
  {
    key: "brief.one-heading-per-marker",
    stage: "brief",
    text: "Every passage was assigned to exactly one heading. Cite a marker only under that heading, and never write the same development twice under two topics because it touches both.",
    why: "A Saudi–CENTCOM meeting was written under both \"US-Iran War\" and \"Middle East diplomacy\".",
  },
  {
    key: "brief.what-a-disagreement-is",
    stage: "brief",
    text: "A disagreement is two outlets asserting incompatible things about the same fact. Earlier reporting overtaken by later reporting is a sequence; two passages from one article are never a disagreement; a claim and its denial are one item (\"X said, Y denied\").",
    why: "The brief invented a \"disagreement\" from one article's two mentions of where tankers were struck.",
  },
  {
    key: "brief.headline",
    stage: "brief",
    text: "The headline names the most widely carried development that happened inside the window, and nothing that is background.",
  },
  {
    key: "brief.no-credits",
    stage: "brief",
    text: "A passage that is only a credit, a byline, a programme note or publisher's boilerplate gets no line, however many such passages an article produced.",
    why: "\"visuals designed by Chris Eichberger and web development by Martin Tenev\" appeared under \"Elections\".",
  },

  // --- extraction -----------------------------------------------------------
  {
    key: "extract.precision-of-dates",
    stage: "extract",
    text: "Give dateIso only the precision the words allow. \"Last week\", \"this weekend\", \"a few days after\" are not a day: give the month with precision \"month\", or leave dateIso empty with precision \"unknown\". Never round vague wording to a day.",
    why: "\"Last week\" arrived as 2026-09-07 and the calendar printed it as a day a reporter could ring someone about.",
  },
  {
    key: "extract.yearless-past-dates",
    stage: "extract",
    text: "A day and month with no year, for something already done, is the true year if it is well known (\"the October 7 attack\" is 2023-10-07) and otherwise \"--MM-DD\" with precision \"day\". Never the publication year: a past event dated in the future is the one mistake the calendar cannot forgive.",
  },
  {
    key: "extract.context-for-every-quote",
    stage: "extract",
    text: "Fill \"context\" for every quote with what the passage is about — the episode, the moment, the person. A quote that only says something happened at some time is worthless without it.",
  },
  {
    key: "extract.no-apparatus",
    stage: "extract",
    text: "An index line, a note, a table of contents, a credit or a copyright page is not evidence. Do not extract entities or claims from a source's apparatus.",
  },

  // --- the verifier ---------------------------------------------------------
  {
    key: "verify.absolute-date-conversion",
    stage: "verify",
    text: "An absolute date in the entry where the passage says \"on Monday\" or \"last year\" is supported when it matches the passage's publication date. Do not flag the conversion; the writer is told to make it.",
  },
  {
    key: "verify.true-but-absent",
    stage: "verify",
    text: "A sentence that is true in the world but absent from its cited passages is unsupported. That is the case that matters most and the easiest to wave through.",
  },
  {
    key: "verify.attributed-disagreement",
    stage: "verify",
    text: "Where the entry names two accounts that differ and attributes each to its outlet, that is supported, not overstated.",
  },

  // --- grouping the inbox ---------------------------------------------------
  {
    key: "group.same-event-not-same-subject",
    stage: "group",
    text: "Group accounts of the same event or development, never of the same subject: five pieces about one hearing are one story; five pieces about one senator that week are not. When in doubt, leave them apart.",
  },

  // --- filing ---------------------------------------------------------------
  {
    key: "tag.prefer-existing",
    stage: "tag",
    text: "Prefer the topics already in use. A near-duplicate of an existing topic (\"Egyptian History\" beside \"Egypt\") is the existing topic.",
  },
  {
    key: "tag.facet-prefix",
    stage: "tag",
    text: "A proposed topic's description opens with its facet — \"Region:\", \"Theme:\", \"Actor:\" or \"Story:\" — because the brief files an article under its most specific facet (Story before Region before Theme, Actor last).",
  },
];
