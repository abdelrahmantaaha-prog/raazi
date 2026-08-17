/**
 * What kind of tie a relation actually is.
 *
 * Extraction records relations as whatever verb phrase the passage used, which
 * gave a thousand distinct phrasings across two thousand relations — "led",
 * "headed", "was leader of", "served as head of" all separate. That is fine for
 * fidelity and useless for drawing: a graph of a thousand edge types is a
 * hairball.
 *
 * So phrasings are sorted into a small set of natures. The original wording is
 * never discarded — it is what gets shown — but the nature is what decides
 * colour, grouping and layout.
 */

export type Nature =
  | "kin"
  | "ownership"
  | "office"
  | "political"
  | "conflict"
  | "authorship"
  | "contact"
  | "membership"
  | "place"
  | "other";

export interface NatureSpec {
  id: Nature;
  label: string;
  /** How the group is described when you hover it. */
  note: string;
  colour: string;
  /**
   * SVG dash pattern, so the kinds stay apart when colour is not enough — on a
   * dark field, at one pixel wide, ten muted colours are not ten signals, and
   * an ally and an enemy reading the same is the one confusion that matters.
   * Undefined means a solid line.
   */
  dash?: string;
  /** Kin is the only nature with a natural direction worth drawing as a tree. */
  hierarchical: boolean;
}

export const NATURES: Record<Nature, NatureSpec> = {
  kin: {
    id: "kin",
    label: "Family",
    note: "Blood, marriage and succession.",
    colour: "#a8536b",
    hierarchical: true,
  },
  ownership: {
    id: "ownership",
    label: "Ownership & founding",
    note: "Who founded, owns, funds or controls what.",
    colour: "#7a4b2a",
    hierarchical: true,
  },
  office: {
    id: "office",
    label: "Office & employment",
    note: "Roles held, people served under, posts appointed to.",
    colour: "#2f6b5b",
    dash: "7 3",
    hierarchical: true,
  },
  political: {
    id: "political",
    label: "Alliance & politics",
    note: "Support, alignment, negotiation and treaties.",
    colour: "#4a5a8a",
    dash: "13 5",
    hierarchical: false,
  },
  conflict: {
    id: "conflict",
    label: "Conflict",
    note: "Opposition, accusation, prosecution and attack.",
    colour: "#a33b3b",
    dash: "3 4",
    hierarchical: false,
  },
  authorship: {
    id: "authorship",
    label: "Authored & built",
    note: "Works written, made, designed or produced.",
    colour: "#6b3a6b",
    dash: "1 5",
    hierarchical: false,
  },
  membership: {
    id: "membership",
    label: "Membership",
    note: "Belonging to a body, party, unit or profession.",
    colour: "#5f6b2a",
    dash: "9 3 2 3",
    hierarchical: true,
  },
  contact: {
    id: "contact",
    label: "Contact",
    note: "Meetings, correspondence and visits.",
    colour: "#7a6a52",
    dash: "2 6",
    hierarchical: false,
  },
  place: {
    id: "place",
    label: "Place",
    note: "Born, based, located or died at.",
    colour: "#3f6f7a",
    dash: "5 3 1 3",
    hierarchical: false,
  },
  other: {
    id: "other",
    label: "Other",
    note: "Ties that fit none of the above.",
    colour: "#6b665e",
    dash: "1 4",
    hierarchical: false,
  },
};

/**
 * The endings a stem is allowed to pick up.
 *
 * This exists because the first version of these rules wrapped every stem in
 * `\b…\b`, which quietly required the word to *end* at the stem: "oppos"
 * matched nothing, because "opposed" carries on. Fifty-six per cent of a real
 * library fell through to Other, and the drawing was a grey blob. Sources write
 * relations in the past tense, so tolerating inflection is the whole game.
 *
 * Bare letters are deliberately excluded — "y" alone would turn "Sony" into a
 * son and "sonar" into kin — so any stem needing an irregular ending is spelled
 * out in full instead.
 */
const INFLECT =
  "(?:e?[ds]|ing|ings|ion|ions|ment|ments|ement|ements|ence|ers?|ors?|ies|ied|ying|led|ling)?";

const stems = (...alts: string[]) => new RegExp(`\\b(?:${alts.join("|")})${INFLECT}\\b`, "i");

/**
 * Order matters: the first pattern to match wins, so the more specific and
 * more consequential natures are tested first. "founded the party" should read
 * as founding, not as membership.
 */
const RULES: [Nature, RegExp][] = [
  [
    "kin",
    stems(
      "son", "daughter", "father", "mother", "parent", "child", "children",
      "brother", "sister", "sibling", "wife", "husband", "spouse", "married",
      "marri", "widow", "cousin", "uncle", "aunt", "nephew", "niece",
      "grand(son|daughter|father|mother)", "heir", "succeeded by", "descendant",
      "dynasty", "family of", "in-law", "fianc"
    ),
  ],
  [
    "ownership",
    stems(
      "found(ed|er)", "co-found", "establish", "own", "acquir", "bought",
      "purchas", "sold", "sell", "stake", "shareholder", "invest", "financ",
      "fund", "bankroll", "donat", "endow", "subsidiary", "subsidiaries",
      "parent company", "merg", "control", "partner", "underwr", "profit",
      "client of", "supplier", "contractor", "deals? (in|with)", "contract"
    ),
  ],
  [
    "office",
    stems(
      "work(ed|s|ing)? (for|at|with|under|alongside)", "employ",
      "serv", "appoint", "hired", "deput", "assistant",
      "advis", "aide", "chief of staff", "minister", "secretary", "ambassador",
      "governor", "ceo", "cfo", "cto", "chairman", "chair", "president of",
      "director", "head", "led", "leader of", "command", "manag", "supervis",
      "report(ed|s) to", "succeeded", "resign", "dismiss", "promoted",
      "staffer", "spokes(man|woman|person)", "mentor", "studied under",
      "chairwoman", "preceded by", "predecessor", "seconded", "tasked",
      "selected", "protege", "acolyte of", "disciple of"
    ),
  ],
  [
    "conflict",
    stems(
      "oppos", "against", "fought", "attack", "bomb", "invad", "kill",
      "assassinat", "accus", "indict", "prosecut", "sued", "convict", "arrest",
      "detain", "expel", "expell", "purg", "overthrew", "overthrow", "coup",
      "denounc", "condemn", "criticis", "criticiz", "rival", "defeat", "besieg",
      "sanction", "boycott", "protest", "threaten", "raided", "clash", "feud",
      "occupied", "occupy", "seiz", "blockad", "displac"
    ),
  ],
  [
    "authorship",
    stems(
      "wrote", "written", "author", "co-author", "publish", "edit(ed|or)",
      "produc", "direct(ed)? the film", "creat", "design", "develop", "built",
      "build", "invent", "compos", "film", "document", "report(ed)? (in|for)",
      "contribut", "launch", "commission", "found(ed)? the (paper|journal)",
      "narrat", "translat", "illustrat"
    ),
  ],
  [
    "political",
    stems(
      "alli", "ally", "support", "back", "endors", "negotiat", "treaty",
      "agreement", "pact", "accord", "coalition", "recogni[sz]", "aid", "armed",
      "supplied", "lobb", "lobbied", "pressur", "persuad", "vot(ed)? for",
      "champion", "cooperat", "collaborat", "influenc", "brokered", "mediat",
      "diplomat", "relations with", "ties with", "commitment to", "peace talks"
    ),
  ],
  [
    "membership",
    stems(
      "member", "joined", "belong", "part of", "affiliat", "enrol", "enroll",
      "recruit", "officer of", "serves? on", "sat on", "board of", "delegate",
      "represent", "graduate", "studied at", "alumn",
      "attend(ed)? (the )?(university|college|school)"
    ),
  ],
  [
    "contact",
    stems(
      "met", "meet", "visit", "travell?ed", "correspond", "wrote to", "telephon",
      "call", "spoke", "talk", "interview", "dined", "attended", "accompan",
      "convey", "introduc", "host", "greet", "featured alongside",
      "connected with"
    ),
  ],
  [
    "place",
    stems(
      "born (in|at)", "died (in|at)", "based (in|at)", "locat", "headquarter",
      "lives? in", "lived in", "moved to", "exiled", "buried", "from",
      "operations in", "presence in"
    ),
  ],
];

export function natureOf(type: string): NatureSpec {
  for (const [nature, re] of RULES) {
    if (re.test(type)) return NATURES[nature];
  }
  return NATURES.other;
}

/**
 * What the *first* party in a kin phrase is: "son of" makes them a child,
 * "father of" makes them a parent. Ordered so the compounds are tested before
 * the words they contain — "grandson" must not read as "son".
 */
const KIN_ROLES: [RegExp, string][] = [
  [/\bgrand(son|daughter|child)\b/i, "grandchild"],
  [/\bgrand(father|mother|parent)\b/i, "grandparent"],
  [/\b(son|daughter|child) (of|to)\b|\bborn to\b/i, "child"],
  [/\b(father|mother|parent) (of|to)\b|\bsired\b/i, "parent"],
  [/\b(brother|sister|sibling)\b/i, "sibling"],
  [/\b(wife|husband|spouse|married|marri|widow)\b/i, "spouse"],
  [/\bfianc/i, "betrothed"],
  [/\b(nephew|niece)\b/i, "nephew or niece"],
  [/\b(uncle|aunt)\b/i, "uncle or aunt"],
  [/\bcousin\b/i, "cousin"],
  [/\bdescendant\b/i, "descendant"],
  [/\bheir\b/i, "heir"],
  [/\bin-law\b/i, "in-law"],
];

/** Each role seen from the other end of the same tie. */
const OPPOSITE: Record<string, string> = {
  child: "parent",
  parent: "child",
  grandchild: "grandparent",
  grandparent: "grandchild",
  sibling: "sibling",
  spouse: "spouse",
  betrothed: "betrothed",
  cousin: "cousin",
  "in-law": "in-law",
  "nephew or niece": "uncle or aunt",
  "uncle or aunt": "nephew or niece",
  descendant: "ancestor",
  ancestor: "descendant",
  heir: "predecessor",
};

/**
 * What the *other* person is to this entity — "parent", "spouse", "child".
 *
 * The stored wording runs one way ("is the son of") and a family tree labels
 * the other end of it, so printing the phrase beside the other person says the
 * opposite of what the source said: a father captioned "is the son of". The
 * kin vocabulary is small enough to invert outright, so it is.
 *
 * Inverses are gender-neutral on purpose. "X is the son of Y" does not say
 * whether Y is a father or a mother, and a tree should not invent one.
 *
 * Returns null for phrasings outside the vocabulary; the caller falls back to
 * the source's own words, which are at least never wrong.
 */
export function kinRole(type: string, direction: "in" | "out"): string | null {
  for (const [re, role] of KIN_ROLES) {
    if (!re.test(type)) continue;
    // `out` means this entity is the first party, so the other end takes the
    // opposite role. `in` means the other party is already the first party.
    return direction === "out" ? (OPPOSITE[role] ?? null) : role;
  }
  return null;
}

/** Kin phrasings that put the other party a generation above or below. */
const UP = /\b(son|daughter|child of|born to|descendant|grand(son|daughter)|heir of|succeeded)\b/i;
const DOWN = /\b(father|mother|parent|grand(father|mother)|sired|predecessor of|succeeded by)\b/i;
const SIDE = /\b(brother|sister|sibling|wife|husband|spouse|married|marri|cousin)\b/i;

/**
 * Which generation the other party sits in, relative to this entity: -1 above,
 * 0 alongside, +1 below. Used only for the family tree, and deliberately
 * conservative — anything ambiguous sits alongside rather than being guessed
 * into the wrong generation.
 */
export function generation(type: string, direction: "in" | "out"): -1 | 0 | 1 {
  const flip = direction === "in" ? -1 : 1;
  if (SIDE.test(type)) return 0;
  if (UP.test(type)) return (-1 * flip) as -1 | 1;
  if (DOWN.test(type)) return (1 * flip) as -1 | 1;
  return 0;
}
