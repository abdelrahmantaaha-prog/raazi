/**
 * Entity naming and keys — the three problems the audit turned up.
 *
 *   npx tsx scripts/test-names.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const SANDBOX = path.join(root, "data", "__names__");
fs.rmSync(SANDBOX, { recursive: true, force: true });
process.env.CORPUS_DATA_DIR = SANDBOX;

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) {
    passed++;
    console.log(`  ok    ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
};
const section = (t) => console.log(`\n${t}`);

const { normalize } = await import("../lib/normalize.ts");
const { bestName } = await import("../lib/canonical.ts");

// ---------------------------------------------------------------------------
section("A rank belongs to a person, not to a company");
// ---------------------------------------------------------------------------
check('"General Motors" keeps its first word', normalize("General Motors", "org") === "general motors",
  normalize("General Motors", "org"));
check('"General Electric" too', normalize("General Electric", "org") === "general electric");
check('"King Fahd University" too',
  normalize("King Fahd University", "institution") === "king fahd university",
  normalize("King Fahd University", "institution"));
check('"Prince Sultan Air Base" too',
  normalize("Prince Sultan Air Base", "place") === "prince sultan air base");
check('but "General Donahue" is still a person named Donahue',
  normalize("General Donahue", "person") === "donahue", normalize("General Donahue", "person"));
check('and "President Truman" still folds onto Truman',
  normalize("President Truman", "person") === "truman");
check("Arabic titles still fold for people",
  normalize("الرئيس جمال عبد الناصر", "person") === normalize("جمال عبد الناصر", "person"));
check("company suffixes still drop, whatever the type",
  normalize("Palantir Technologies Inc", "org") === "palantir technologies");

// ---------------------------------------------------------------------------
section("The heading is chosen, not whichever name arrived first");
// ---------------------------------------------------------------------------
check(
  "a full name beats the titled short form",
  bestName("President Truman", ["President Truman", "Harry S. Truman"], "person") === "Harry S. Truman"
);
check(
  "and beats a rank",
  bestName("General Donahue", ["General Donahue", "Chris Donahue", "Christopher Donahue"], "person") ===
    "Christopher Donahue"
);
check(
  "a catalogue inversion is not a heading",
  bestName("Sidhwa, Feroze", ["Sidhwa, Feroze", "Feroze Sidhwa"], "person") === "Feroze Sidhwa"
);
check(
  "shouting is not a heading either",
  bestName("DR. FEROZE SIDHWA", ["DR. FEROZE SIDHWA", "Feroze Sidhwa"], "person") === "Feroze Sidhwa"
);
check(
  "a lone surname loses to the full name",
  bestName("Nasser", ["Nasser", "Gamal Abdel Nasser"], "person") === "Gamal Abdel Nasser"
);
check(
  "a whole descriptive clause is not a name",
  bestName(
    "Nehru",
    ["Nehru", "Jawaharlal Nehru", "Jawaharlal Nehru the first prime minister of independent India"],
    "person"
  ) === "Jawaharlal Nehru"
);
check(
  "an organisation keeps its rank word",
  bestName("General Motors", ["General Motors", "GM"], "org") === null ||
    bestName("General Motors", ["General Motors", "GM"], "org") === "General Motors"
);
check("nothing to choose between means no change", bestName("Cairo", ["Cairo"], "place") === null);
check(
  "a rank comes off even when it is the only form we have",
  bestName("Dr. Caryl Haskins", ["Dr. Caryl Haskins"], "person") === "Caryl Haskins",
  String(bestName("Dr. Caryl Haskins", ["Dr. Caryl Haskins"], "person"))
);
check(
  "but never down to a bare surname",
  bestName("General Donahue", ["General Donahue"], "person") === null,
  String(bestName("General Donahue", ["General Donahue"], "person"))
);
check(
  "and an organisation is never trimmed",
  bestName("General Motors", ["General Motors"], "org") === null
);
check(
  "a stacked style comes off too",
  bestName("Crown Prince Abdullah bin Abdulaziz", ["Crown Prince Abdullah bin Abdulaziz"], "person") ===
    "Abdullah bin Abdulaziz",
  String(bestName("Crown Prince Abdullah bin Abdulaziz", ["Crown Prince Abdullah bin Abdulaziz"], "person"))
);
check(
  "a tie leaves the name alone rather than churning it",
  bestName("Gamal Nasser", ["Gamal Nasser", "Nasser Gamal"], "person") === null
);

// ---------------------------------------------------------------------------
section("Folding a bare surname — only when it is unambiguous");
// ---------------------------------------------------------------------------
const { db } = await import("../lib/db/index.ts");
const { foldBareNames } = await import("../lib/pipeline/resolve.ts");

const src = (title) =>
  Number(db().prepare("INSERT INTO sources (title, kind, status) VALUES (?, 'text','ready')").run(title)
    .lastInsertRowid);
const chunkIn = (sourceId) =>
  Number(db().prepare("INSERT INTO chunks (source_id, seq, text) VALUES (?, 0, 'x')").run(sourceId)
    .lastInsertRowid);
const person = (name) =>
  Number(
    db()
      .prepare("INSERT INTO entities (type, canonical_name, normalized) VALUES ('person', ?, ?)")
      .run(name, normalize(name, "person")).lastInsertRowid
  );
const mention = (entityId, chunkId, sourceId) =>
  db()
    .prepare("INSERT INTO mentions (entity_id, chunk_id, source_id, surface, quote) VALUES (?,?,?,?,?)")
    .run(entityId, chunkId, sourceId, "x", "quote");

// One book, one Nasser: the bare surname must fold in.
const bookA = src("Book A");
const cA = chunkIn(bookA);
const nasserFull = person("Gamal Abdel Nasser");
const nasserBare = person("Nasser");
mention(nasserFull, cA, bookA);
mention(nasserFull, cA, bookA);
mention(nasserFull, cA, bookA);
mention(nasserBare, cA, bookA);

// Same book, two Abduls: the bare name must be left alone.
const abdulOne = person("Abdul Aziz");
const abdulTwo = person("Abdul Malik");
const abdulBare = person("Abdul");
mention(abdulOne, cA, bookA);
mention(abdulTwo, cA, bookA);
mention(abdulBare, cA, bookA);

// A surname met only in a different book is not the same person by default.
const bookB = src("Book B");
const cB = chunkIn(bookB);
const eden = person("Anthony Eden");
mention(eden, cB, bookB);
const edenBare = person("Eden");
mention(edenBare, cA, bookA);

// The fold is the deterministic half of resolution; the LLM adjudication that
// follows it needs a key and is covered elsewhere.
foldBareNames(
  db()
    .prepare(
      `SELECT e.id, e.canonical_name, e.normalized, e.disambiguator, e.embedding,
              (SELECT COUNT(*) FROM mentions m WHERE m.entity_id = e.id) AS mentions
         FROM entities e WHERE e.type='person' AND e.merged_into IS NULL
        ORDER BY mentions DESC`
    )
    .all()
);

const gone = (id) =>
  (db().prepare("SELECT merged_into FROM entities WHERE id=?").get(id) ?? {}).merged_into;

check("a lone surname folds into the only full name in that source", gone(nasserBare) === nasserFull,
  String(gone(nasserBare)));
check("the full name keeps every quote",
  db().prepare("SELECT COUNT(*) n FROM mentions WHERE entity_id=?").get(nasserFull).n === 4);
check("two candidates in one source means it is left alone", !gone(abdulBare));
check("neither Abdul was touched", !gone(abdulOne) && !gone(abdulTwo));
check("a name from another book is not folded in", !gone(edenBare));

// ---------------------------------------------------------------------------
section("A merge is always between survivors");
// ---------------------------------------------------------------------------
// "United Arab Emirates (UAE)" was judged the same as "UAE" and, in the same
// pass, as "United Arab Emirates". The second merge used to move the already
// folded entity again, so the two survivors stayed apart and the second took
// the absorbed name as an alias with none of its evidence.
{
  const { mergeEntities } = await import("../lib/pipeline/resolve.ts");
  const place = (name) =>
    Number(
      db()
        .prepare("INSERT INTO entities (type, canonical_name, normalized) VALUES ('place', ?, ?)")
        .run(name, normalize(name, "place")).lastInsertRowid
    );
  const bookC = src("Book C");
  const cC = chunkIn(bookC);
  const uae = place("UAE");
  const full = place("United Arab Emirates");
  const both = place("United Arab Emirates (UAE)");
  mention(uae, cC, bookC);
  mention(full, cC, bookC);
  mention(both, cC, bookC);

  mergeEntities(uae, both, "first", "auto");
  mergeEntities(full, both, "second", "auto");

  const survivors = [uae, full].filter((id) => !gone(id));
  check("the two survivors end up as one", survivors.length === 1, `${gone(uae)} / ${gone(full)}`);
  const rootOf = (id) => { let cur = id; while (gone(cur)) cur = gone(cur); return cur; };
  check("the absorbed entity leads to that one survivor", rootOf(both) === survivors[0], `${rootOf(both)}`);
  check(
    "every quote lands on it",
    db().prepare("SELECT COUNT(*) n FROM mentions WHERE entity_id=?").get(survivors[0]).n === 3
  );
  check(
    "and the log records a merge of survivors, not of the shell again",
    db().prepare("SELECT COUNT(*) n FROM merge_log WHERE merged_entity=?").get(both).n === 1
  );
}

db().close();
fs.rmSync(SANDBOX, { recursive: true, force: true });

// ---------------------------------------------------------------------------
section("A lone name may stand for a fuller one — but only as a family name");
// ---------------------------------------------------------------------------
{
  const { canStandFor, nameableTogether } = await import("../lib/pipeline/resolve.ts");
  const { normalize } = await import("../lib/normalize.ts");

  let nextId = 1;
  const row = (name) => ({
    id: nextId++,
    canonical_name: name,
    normalized: normalize(name, "person"),
    disambiguator: null,
    mentions: 1,
    embedding: null,
  });

  // The failure that prompted all of this: a bare "Ahmed" folded into "Ahmed
  // Razi" in one book and was separately judged to be Prince Ahmed bin
  // Abdulaziz in another, so a journalist and the brother of Mohammed bin
  // Salman became one person carrying both men's quotes.
  {
    const ahmed = row("Ahmed");
    const razi = row("Ahmed Razi");
    const prince = row("Ahmed bin Abdulaziz");
    const all = [ahmed, razi, prince];

    check("a bare given name cannot stand for anyone", !canStandFor(ahmed, razi, all));
    check("not even for a prince", !canStandFor(ahmed, prince, all));
    check("and the pair is refused outright", !nameableTogether(ahmed, razi, all));
    check("in either direction", !nameableTogether(prince, ahmed, all));
  }

  // The folds that were always right must keep working.
  {
    const yamani = row("Yamani");
    const full = row("Ahmed Zaki Yamani");
    const all = [yamani, full];
    check("a family name still stands for the whole name", canStandFor(yamani, full, all));
    check("and the pair is allowed through", nameableTogether(yamani, full, all));
  }

  // "Surname, Given" inverts the token order, which a positional rule gets
  // exactly backwards — it proposed separating Joe Biden from himself.
  {
    const biden = row("Biden");
    const inverted = row("Biden, Joe");
    const all = [biden, inverted];
    check("an inverted form is read by its comma, not its last word",
      canStandFor(biden, inverted, all));
  }
  {
    const naji = row("Naji");
    const inverted = row("Tamimi, Naji");
    const all = [naji, inverted];
    check("so a given name after the comma is still refused",
      !canStandFor(naji, inverted, all));
  }

  // Two people share a family name: the lone word picks out neither.
  {
    const tamimi = row("Tamimi");
    const bassem = row("Bassem Tamimi");
    const nariman = row("Nariman Tamimi");
    const all = [tamimi, bassem, nariman];
    check("an ambiguous family name folds into nobody",
      !canStandFor(tamimi, bassem, all) && !canStandFor(tamimi, nariman, all));
  }

  // Two full names are compared on their merits, as before.
  {
    const a = row("Gamal Abdel Nasser");
    const b = row("Gamal Nasser");
    check("two full names are still open to judgement", nameableTogether(a, b, [a, b]));
  }
}

// ---------------------------------------------------------------------------
section("A heading in capitals is folded, not merely penalised");
// ---------------------------------------------------------------------------
{
  const { foldShouting } = await import("../lib/canonical.ts");
  check('"WILLIAM SCHABAS" becomes "William Schabas"',
    bestName("WILLIAM SCHABAS", [], "person") === "William Schabas",
    String(bestName("WILLIAM SCHABAS", [], "person")));
  check("particles stay lower-case", foldShouting("ABDULLAH AL-SAUD", "person") === "Abdullah al-Saud",
    foldShouting("ABDULLAH AL-SAUD", "person"));
  check("so do European ones", foldShouting("LUDWIG VAN BEETHOVEN", "person") === "Ludwig van Beethoven");
  check("but a particle opening the name is capitalised", foldShouting("VAN MORRISON", "person") === "Van Morrison");
  check("an Irish apostrophe keeps its capital", foldShouting("SEAN O'BRIEN", "person") === "Sean O'Brien",
    foldShouting("SEAN O'BRIEN", "person"));
  check("an Arabic hamza does not", foldShouting("SA'AD HARIRI", "person") === "Sa'ad Hariri",
    foldShouting("SA'AD HARIRI", "person"));
  check("acronyms inside a shouted name keep their capitals",
    foldShouting("UN SECURITY COUNCIL", "institution") === "UN Security Council",
    foldShouting("UN SECURITY COUNCIL", "institution"));
  check("a lone acronym is not shouting", foldShouting("UNRWA", "org") === "UNRWA");
  check("nor is a short one", foldShouting("NATO", "org") === "NATO");
  check("a multi-word organisation is folded", foldShouting("ROYAL NAVY", "org") === "Royal Navy");
  check("a mixed-case name is left alone", foldShouting("McDonald", "person") === "McDonald");
  check("a folded form outranks the shouted alias",
    bestName("WILLIAM SCHABAS", ["WILLIAM SCHABAS"], "person") === "William Schabas");
  check("a name already right is not rewritten", bestName("William Schabas", ["WILLIAM SCHABAS"], "person") === null);
}

console.log(`\n${failed === 0 ? "All passed" : "FAILURES PRESENT"}: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
