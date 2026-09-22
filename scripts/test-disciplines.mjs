/**
 * More than one discipline, with a wall between them.
 *
 * A discipline is a separate library rather than a filter over one, so the
 * thing to prove is that two of them share no data at all — and that what is
 * deliberately shared, the API keys and which model does which job, really is
 * shared rather than copied into each.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/test-disciplines.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const SANDBOX = path.join(root, "data", "__disciplines__");
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(SANDBOX, { recursive: true });
// The root that holds every discipline — not CORPUS_DATA_DIR, which would
// pin this run to one library and switch disciplines off.
process.env.CORPUS_ROOT_DIR = SANDBOX;
delete process.env.CORPUS_DATA_DIR;

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

const {
  SWITCH_EXIT,
  activeDir,
  activeDiscipline,
  addDiscipline,
  chooseDiscipline,
  forgetDiscipline,
  listDisciplines,
  renameDiscipline,
  slugOf,
} = await import("../lib/disciplines.ts");

// Imported now, with the first discipline open, exactly as the server imports
// it at startup: the library a process works in is settled the moment this
// module is first loaded and never re-read.
const { DATA_DIR: OPENED } = await import("../lib/db/index.ts");

// ---------------------------------------------------------------------------
section("The library you already had is the first discipline");
// ---------------------------------------------------------------------------
check("there is one discipline before anything is added", listDisciplines().length === 1);
check("and it is the open one", activeDiscipline().id === listDisciplines()[0].id);
check("its library is the data folder itself, so nothing moves on disk", activeDir() === SANDBOX, activeDir());

// ---------------------------------------------------------------------------
section("A second discipline is a second folder");
// ---------------------------------------------------------------------------
const history = addDiscipline("Islamic history");
check("it is listed", listDisciplines().length === 2);
check("with the name you gave it", listDisciplines().some((d) => d.name === "Islamic history"));
check("its folder is made straight away", fs.existsSync(path.join(SANDBOX, "disciplines", history.id)));
check("and it is empty — a new subject has no sources", fs.readdirSync(path.join(SANDBOX, "disciplines", history.id)).length === 0);
check("adding one does not open it", activeDiscipline().id !== history.id);
check("the first discipline is still where it was", activeDir() === SANDBOX);

let threw = null;
try {
  addDiscipline("islamic HISTORY");
} catch (e) {
  threw = e.message;
}
check("two disciplines cannot share a name", Boolean(threw), String(threw));
threw = null;
try {
  addDiscipline("   ");
} catch (e) {
  threw = e.message;
}
check("and one needs a name at all", Boolean(threw));

check("a name becomes a safe folder name", slugOf("Islamic history & law!") === "islamic-history-law");
check("even in Arabic", /[؀-ۿ]|discipline-/.test(slugOf("تاريخ إسلامي")), slugOf("تاريخ إسلامي"));

// ---------------------------------------------------------------------------
section("Choosing one is a note for the next start, not a switch");
// ---------------------------------------------------------------------------
chooseDiscipline(history.id);
check("the registry says which to open", JSON.parse(fs.readFileSync(path.join(SANDBOX, "disciplines.json"), "utf8")).active === history.id);
check("and the exit code that asks for the restart is the agreed one", SWITCH_EXIT === 7);

// The guarantee: a process settles which database it is working in when it
// starts, and choosing another discipline cannot move it. The registry reader
// follows the choice at once — it has to, so the page can say what is open
// next — but the library this process has open does not budge until restart.
check("the database this process opened does not move when another is chosen", OPENED === SANDBOX, OPENED);
check("while the registry already names the one to open next", activeDiscipline().id === history.id);

// ---------------------------------------------------------------------------
section("Two disciplines share no data");
// ---------------------------------------------------------------------------
// A child process per discipline, because the library a process works in is
// fixed when it starts — which is exactly what is being tested.
let nth = 0;
const inDiscipline = (_unused, code) => {
  // A file rather than --eval: tsx compiles an eval to CommonJS, which has no
  // top-level await, and every one of these has to import the app.
  // Written beside the app rather than in the sandbox, so the imports below
  // resolve the way they would in any script here.
  const file = path.join(root, `.discipline-child-${nth++}.mjs`);
  fs.writeFileSync(file, code);
  try {
    const res = spawnSync(process.execPath, [path.join(root, "node_modules", "tsx", "dist", "cli.mjs"), file], {
      env: { ...process.env, CORPUS_ROOT_DIR: SANDBOX },
      encoding: "utf8",
      cwd: root,
    });
    if (res.status !== 0) throw new Error(res.stderr?.slice(0, 600) || "child failed");
    return res.stdout.trim().split("\n").pop();
  } finally {
    fs.rmSync(file, { force: true });
  }
};

const WRITE = `
  const { db } = await import("./lib/db/index.ts");
  db().prepare("INSERT INTO sources (title, kind, status) VALUES (?, 'text', 'ready')").run(process.env.TITLE);
  console.log(db().prepare("SELECT COUNT(*) n FROM sources").get().n);
`;
const COUNT = `
  const { db } = await import("./lib/db/index.ts");
  console.log(db().prepare("SELECT group_concat(title) t FROM sources").get().t ?? "");
`;

// The child picks its library from the registry, so point the registry at
// each in turn — the same thing the restart does.
chooseDiscipline(listDisciplines()[0].id);
process.env.TITLE = "A political source";
inDiscipline("", WRITE);
chooseDiscipline(history.id);
process.env.TITLE = "A history source";
inDiscipline("", WRITE);

chooseDiscipline(listDisciplines()[0].id);
const first = inDiscipline("", COUNT);
chooseDiscipline(history.id);
const second = inDiscipline("", COUNT);

check("the first discipline holds only its own source", first === "A political source", first);
check("the second holds only its own", second === "A history source", second);
check("neither can see the other's", !first.includes("history") && !second.includes("political"));
check(
  "because they are different database files",
  fs.existsSync(path.join(SANDBOX, "corpus.db")) &&
    fs.existsSync(path.join(SANDBOX, "disciplines", history.id, "corpus.db"))
);

// ---------------------------------------------------------------------------
section("The keys are shared, and counted once");
// ---------------------------------------------------------------------------
const ADD_KEY = `
  const { addKey, listKeys } = await import("./lib/keys.ts");
  addKey("AIzaSyTESTKEYTESTKEYTESTKEYTESTKEY00", "Shared", { provider: "gemini" });
  console.log(listKeys().length);
`;
const SEE_KEYS = `
  const { listKeys } = await import("./lib/keys.ts");
  console.log(listKeys().map((k) => k.label).join(","));
`;
chooseDiscipline(listDisciplines()[0].id);
inDiscipline("", ADD_KEY);
chooseDiscipline(history.id);
const keysThere = inDiscipline("", SEE_KEYS);
check("a key added in one discipline is there in the other", keysThere === "Shared", keysThere);
check(
  "and lives beside the disciplines rather than inside one",
  fs.existsSync(path.join(SANDBOX, "shared.json")) &&
    !fs.existsSync(path.join(SANDBOX, "disciplines", history.id, "config.json")),
  fs.readdirSync(path.join(SANDBOX, "disciplines", history.id)).join(" ")
);

// What is about the subject stays with the subject.
const SET_HOUR = `
  const { saveConfig, getConfig } = await import("./lib/config.ts");
  saveConfig({ morningHour: Number(process.env.HOUR) });
  console.log(getConfig().morningHour);
`;
const GET_HOUR = `
  const { getConfig } = await import("./lib/config.ts");
  console.log(getConfig().morningHour);
`;
chooseDiscipline(listDisciplines()[0].id);
process.env.HOUR = "7";
inDiscipline("", SET_HOUR);
chooseDiscipline(history.id);
process.env.HOUR = "19";
inDiscipline("", SET_HOUR);
chooseDiscipline(listDisciplines()[0].id);
check("the brief's hour belongs to the discipline it was set in", inDiscipline("", GET_HOUR) === "7");
chooseDiscipline(history.id);
check("and the other keeps its own", inDiscipline("", GET_HOUR) === "19");

// And routing, which is about the tooling, does not.
const SET_ROUTE = `
  const { saveConfig } = await import("./lib/config.ts");
  saveConfig({ routing: { entry: "anthropic" } });
  console.log("set");
`;
const GET_ROUTE = `
  const { getConfig } = await import("./lib/config.ts");
  console.log(getConfig().routing.entry ?? "none");
`;
inDiscipline("", SET_ROUTE);
chooseDiscipline(listDisciplines()[0].id);
check("which model does which job is shared", inDiscipline("", GET_ROUTE) === "anthropic");

// ---------------------------------------------------------------------------
section("Housekeeping");
// ---------------------------------------------------------------------------
renameDiscipline(history.id, "Early Islam");
check("a discipline can be renamed", listDisciplines().some((d) => d.name === "Early Islam"));

threw = null;
try {
  forgetDiscipline(activeDiscipline().id);
} catch (e) {
  threw = e.message;
}
check("the open discipline cannot be removed from under you", Boolean(threw), String(threw));

chooseDiscipline(listDisciplines()[0].id);
forgetDiscipline(history.id);
check("another can be", listDisciplines().length === 1);
check(
  "and removing it leaves its library on disk",
  fs.existsSync(path.join(SANDBOX, "disciplines", history.id, "corpus.db"))
);

threw = null;
try {
  forgetDiscipline(listDisciplines()[0].id);
} catch (e) {
  threw = e.message;
}
check("the last one cannot be removed", Boolean(threw));

fs.rmSync(SANDBOX, { recursive: true, force: true });

console.log(`\n${failed === 0 ? "All passed" : "FAILURES PRESENT"}: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
