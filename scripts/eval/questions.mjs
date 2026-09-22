// Questions for scripts/eval-meaning.mjs. Each paraphrases one known passage
// (by chunk id) and avoids its distinctive words, so a hit means the meaning matched.
export const EVAL = [
  { id: 728, q: "what did the founders think a good government needed so that no single group could take over" },
  { id: 774, q: "a disabled woman who wrote a letter defending a radical labour organiser who had been thrown out" },
  { id: 184, q: "which party won the last time the occupied territories held a vote" },
  { id: 276, q: "a religious ruling that was used to justify killing an Israeli prime minister" },
  { id: 523, q: "children taken from arrested dissidents as a deliberate government policy" },
  { id: 569, q: "a cleric's movement fixing electricity and collecting rubbish after the state collapsed" },
  { id: 364, q: "military software that picks out targets from cameras on unmanned boats" },
  { id: 1092, q: "why do people feel they have to pay back a favour" },
  { id: 1138, q: "the assumption that all of human life comes down to trading for your own advantage" },
  { id: 682, q: "a consulting firm that sold former officials' access to arms companies" },
  { id: 1410, q: "were the communities getting along before the British arrived" },
  { id: 933, q: "an American president privately reassuring the Saudi leadership about the currency" },
  { id: 912, q: "Washington's doubts about whether the kingdom's rulers would last" },
  { id: 1297, q: "the bombardment of a capital city during the invasion of Lebanon" },
  { id: 456, q: "a job that only exists because of an anti-bribery law" },
  { id: 887, q: "the crown prince going after a rich relative's inheritance in the middle of the night" },
  { id: 1046, q: "how the kingdom paid its way before the oil money came in" },
  { id: 117, q: "why the oil minister was afraid of prices going up too fast" },
  { id: 1364, q: "the rich keep using up the environment simply because they always have" },
  { id: 410, q: "what the Palantir chief's childhood home was like" },
  { id: 2682, q: "the idea that each immigrant group should keep its own heritage inside America" },
  { id: 1263, q: "when did the anthropologist start calling himself an anarchist" },
  // Arabic question, Arabic passage.
  { id: 297, q: "كيف ساعد رئيس الوزراء الإسرائيلي الأنظمة العربية على إخماد الثورات" },
  // English question, Arabic passage: does meaning cross the language?
  { id: 297, q: "an Israeli leader helping Arab regimes put down the 2011 uprisings", xlang: true },
];
