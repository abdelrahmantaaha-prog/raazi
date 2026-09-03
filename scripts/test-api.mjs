/**
 * The API's own guarantees, from the 2026-09 audit's section C.
 *
 * The routes themselves are Next handlers and need a server to exercise, so
 * what is tested here is everything they were fixed by: the request helpers
 * they all now share, the ownership checks pushed down into the libraries, the
 * in-flight guard that stops a double click paying twice, and the LAN token
 * that is the difference between "bound to every interface" and "open to
 * everyone on the Wi-Fi".
 *
 * Runs against a scratch database and a scratch config. No API key needed.
 *
 *   node scripts/test-api.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const SANDBOX = path.join(root, "data", "__test_api__");
fs.rmSync(SANDBOX, { recursive: true, force: true });
process.env.CORPUS_DATA_DIR = SANDBOX;
delete process.env.CORPUS_LAN;

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

const { db } = await import("../lib/db/index.ts");
const {
  asId,
  optionalId,
  optionalString,
  readBody,
  queryId,
  exists,
  attachment,
  inFlight,
} = await import("../lib/http.ts");
const { createRun, enqueue } = await import("../lib/queue.ts");

/** A Request carrying a JSON body, as Next would hand one to a route. */
const jsonReq = (body, url = "http://localhost/api/x") =>
  new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

/* --------------------------------------------------------------- bodies */

section("A body is an object or it is a bad request");
{
  check("an object parses", (await readBody(jsonReq({ a: 1 })))?.a === 1);
  check("malformed JSON is null, not a throw", (await readBody(jsonReq("{oops"))) === null);
  // A bare scalar parses as JSON and is not a body any route can read; letting
  // it through is how `body.title.trim()` on `42` became a 500.
  check("a bare number is refused", (await readBody(jsonReq("42"))) === null);
  check("a bare string is refused", (await readBody(jsonReq('"hello"'))) === null);
  check("null is refused", (await readBody(jsonReq("null"))) === null);
  check("an array is refused", (await readBody(jsonReq("[1,2]"))) === null);
}

section("Ids are ids, whatever they arrive as");
{
  check("a route id passes", asId("41") === 41);
  check("junk is null, not NaN", asId("abc") === null);
  check("zero is not a row", asId("0") === null);

  // The body/query form has to tell "absent" from "wrong", or an optional
  // foreign key and a typo become the same thing.
  check("an absent optional id is undefined", optionalId(undefined) === undefined);
  check("an explicit null is undefined", optionalId(null) === undefined);
  check("a real one comes back", optionalId(7) === 7);
  check("a wrong one is null", optionalId("x") === null);
  check("a float is null", optionalId(2.5) === null);
  check("an object is null", optionalId({}) === null);

  check("a string field passes", optionalString("t") === "t");
  check("an absent string field is undefined", optionalString(undefined) === undefined);
  check("a number in a string field is null", optionalString(42) === null);

  const req = new Request("http://localhost/api/x?note=12&bad=abc");
  check("a query id parses", queryId(req, "note") === 12);
  check("a bad query id is null", queryId(req, "bad") === null);
  check("a missing query id is null", queryId(req, "nope") === null);
}

/* ------------------------------------------------------------ existence */

section("Writes to things that are not there are 404s, not 200s or 500s");
{
  const sourceId = Number(
    db()
      .prepare("INSERT INTO sources (title, kind, status) VALUES ('A book','text','ready')")
      .run().lastInsertRowid
  );
  check("a row that exists is found", exists("sources", sourceId));
  check("one that never did is not", !exists("sources", sourceId + 5000));
  check("nor is a tag id that is a source id", !exists("tags", sourceId));

  let threw = false;
  try {
    exists("sqlite_master", 1);
  } catch {
    threw = true;
  }
  check("the table name cannot be anything a caller chose", threw);
}

/* ----------------------------------------------------------- ownership */

section("A nested thing must belong to the thing in the URL");
{
  const { addPoint, createIdea, pointOf } = await import("../lib/ideas.ts");
  const mine = createIdea("Mine");
  const yours = createIdea("Yours");
  const point = addPoint(mine, "A point");

  check("a point is found under its own idea", pointOf(mine, point)?.id === point);
  // The outline route names the idea in the URL and the point in the body; it
  // used to act on the point alone, so any idea's URL reached any point.
  check("and not under another", pointOf(yours, point) === undefined);
  check("nor does a point that never existed", pointOf(mine, point + 999) === undefined);

  const { markRead, markReadThrough, readPassages, recordPosition } = await import("../lib/reading.ts");
  const book = Number(
    db().prepare("INSERT INTO sources (title, kind, status) VALUES ('Book','text','ready')").run()
      .lastInsertRowid
  );
  const other = Number(
    db().prepare("INSERT INTO sources (title, kind, status) VALUES ('Other','text','ready')").run()
      .lastInsertRowid
  );
  const chunk = (sourceId, seq) =>
    Number(
      db()
        .prepare("INSERT INTO chunks (source_id, seq, text, locator_json) VALUES (?, ?, 'text', '{}')")
        .run(sourceId, seq).lastInsertRowid
    );
  const a1 = chunk(book, 0);
  const a2 = chunk(book, 1);
  const b1 = chunk(other, 0);

  check("a passage of this book counts as read", markRead(book, [a1], "read") === 1);
  // The spend path: a foreign chunk marked read here made read-along hand
  // that other book to the model.
  check("a passage of another book does not", markRead(book, [b1], "read") === 0);
  check("and is not on the record", !readPassages(book).includes(b1));
  check("a chunk id that is not a chunk is ignored", markRead(book, [999999], "read") === 0);

  markReadThrough(book, a2);
  check("marking through covers this book only", readPassages(book).length === 2);
  check("and leaves the other book untouched", readPassages(other).length === 0);
  markReadThrough(other, a2);
  check("marking through a foreign passage marks nothing", readPassages(other).length === 0);

  recordPosition(book, { chunkId: b1, offset: 0, read: [] });
  const bookmarked = db().prepare("SELECT bookmark_chunk FROM sources WHERE id=?").get(book);
  check("a position in another book is not a position in this one", bookmarked.bookmark_chunk !== b1);
}

/* ------------------------------------------------------------ in-flight */

section("A second click does not pay twice");
{
  const runId = createRun({ kind: "factcheck", label: "Check" });
  enqueue(runId, [{ kind: "factcheck", payload: { draftId: 5 } }]);

  check("the run doing it is found", inFlight("factcheck", { draftId: 5 }) === runId);
  // The audit's S-06: a LIKE on '%"draftId":5%' also matched 50 and 512, so
  // one draft showed a spinner while another was being checked.
  check("draft 50 is not draft 5", inFlight("factcheck", { draftId: 50 }) === null);
  check("nor is draft 512", inFlight("factcheck", { draftId: 512 }) === null);
  check("another kind of work is not this one", inFlight("entry", { draftId: 5 }) === null);

  db().prepare("UPDATE tasks SET state='done' WHERE run_id=?").run(runId);
  check("a finished task is not in flight", inFlight("factcheck", { draftId: 5 }) === null);

  const doneRun = createRun({ kind: "entry", label: "Entry" });
  enqueue(doneRun, [{ kind: "entry", payload: { entityId: 3 } }]);
  db().prepare("UPDATE runs SET state='done' WHERE id=?").run(doneRun);
  check("a task in a closed run is not in flight", inFlight("entry", { entityId: 3 }) === null);

  let threw = false;
  try {
    inFlight("entry", { "1; DROP TABLE tasks": 1 });
  } catch {
    threw = true;
  }
  check("a payload key cannot be anything a caller chose", threw);
}

/* -------------------------------------------------------------- headers */

section("A download's name survives any title");
{
  const ascii = attachment("corpus-entries.md");
  check("an ASCII name is unchanged", ascii.includes('filename="corpus-entries.md"'), ascii);
  check("and is also given encoded", ascii.includes("filename*=UTF-8''corpus-entries.md"), ascii);

  // The audit's S-07: an Arabic title threw from inside the response
  // constructor, so the export produced no download at all.
  const arabic = attachment("الجزيرة.docx", "draft-7.docx");
  check(
    "a non-Latin name is carried encoded",
    arabic.includes("filename*=UTF-8''") && /%D8|%D9/i.test(arabic),
    arabic
  );
  check(
    "with an ASCII fallback that is a name, not an extension",
    arabic.includes('filename="draft-7.docx"'),
    arabic
  );
  check(
    "every byte of the header is Latin-1",
    // eslint-disable-next-line no-control-regex
    !/[^\x00-\xff]/.test(arabic),
    arabic
  );
  // The ASCII half is quoted, so a quote inside the title would end it early
  // and the rest of the name would be read as another header parameter.
  const quoted = attachment('a"b.md');
  check(
    "a quote in a title cannot break out of the header",
    quoted.includes('filename="ab.md"') && (quoted.match(/"/g) ?? []).length === 2,
    quoted
  );
  // The header is built, not concatenated: it has to survive a real Response.
  let constructed = true;
  try {
    new Response("x", { headers: { "content-disposition": attachment("مقال طويل.docx") } });
  } catch {
    constructed = false;
  }
  check("and a Response accepts it", constructed);
}

/* ------------------------------------------------------------------ LAN */

section("LAN mode: bound to everything means asking for a token");
{
  const {
    ensureLanToken,
    lanEnabled,
    lanSettings,
    setLanEnabled,
    tokenFrom,
    tokenMatches,
    loginUrls,
  } = await import("../lib/lan.ts");

  check("off by default, so nothing is exposed", !lanEnabled());
  check("and there is no token to leak", lanSettings().token === null);

  const token = await ensureLanToken();
  check("a token is 32 bytes of hex", /^[0-9a-f]{64}$/.test(token), token);
  check("and is generated once, not per call", (await ensureLanToken()) === token);
  check("switching on does not change it", (await setLanEnabled(true)).token === token);
  check("and is remembered for the launcher to read", lanEnabled());

  // The config file is shared with the API keys; LAN mode must not tread on them.
  const { readStore, writeStore } = await import("../lib/config-file.ts");
  writeStore({ ...readStore(), keys: [{ id: "k", key: "secret" }] });
  await setLanEnabled(false);
  check("turning it off leaves the keys alone", readStore().keys?.[0]?.key === "secret");
  check("and keeps the token for next time", lanSettings().token === token);
  await setLanEnabled(true);

  const headerReq = new Request("http://x/", { headers: { "x-corpus-token": token } });
  const bearerReq = new Request("http://x/", { headers: { authorization: `Bearer ${token}` } });
  const cookieReq = new Request("http://x/", { headers: { cookie: `a=1; corpus_token=${token}` } });
  const bareReq = new Request("http://x/");
  check("the header is read", tokenFrom(headerReq) === token);
  check("so is a bearer", tokenFrom(bearerReq) === token);
  check("so is the cookie the login sets", tokenFrom(cookieReq) === token);
  check("and nothing is read from a bare request", tokenFrom(bareReq) === null);

  check("the right token matches", tokenMatches(token, token));
  check("a wrong one does not", !tokenMatches(`${token.slice(0, -1)}0`, token));
  check("a short one does not", !tokenMatches("abc", token));
  check("an empty one does not", !tokenMatches("", token));
  check("and neither does one against no token", !tokenMatches(token, null));

  const urls = loginUrls(5400, token);
  check(
    "the sign-in links carry the token on a real address",
    urls.every((u) => u.includes(`/login?token=${token}`) && !u.includes("127.0.0.1")),
    urls.join(", ")
  );

  // The one thing that must never happen: LAN on and the door open anyway.
  const middleware = fs.readFileSync(path.join(root, "middleware.ts"), "utf8");
  check(
    "the middleware lets exactly two things past unauthenticated",
    /\/api\/hello/.test(middleware) && /\/login/.test(middleware)
  );
  check(
    "and /api/hello only for a GET",
    /req\.method === "GET" && pathname === "\/api\/hello"/.test(middleware),
    "the open route must not accept writes"
  );
  const hello = fs.readFileSync(path.join(root, "app/api/hello/route.ts"), "utf8");
  check("the open route starts no work", !/kickWorker/.test(hello));
  check("and reports counts, never content", !/quote|body_md|SELECT \*/.test(hello));
  const runs = fs.readFileSync(path.join(root, "app/api/runs/route.ts"), "utf8");
  check("nor does the Library's poll", !/kickWorker/.test(runs));
  const kick = fs.readFileSync(path.join(root, "app/api/worker/kick/route.ts"), "utf8");
  check("kicking the worker is a POST", /export async function POST/.test(kick) && !/export async function GET/.test(kick));

  await setLanEnabled(false);
}

/* --------------------------------------------------------------- scripts */

section("The server binds where it says it does");
{
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  check("dev is loopback only", pkg.scripts.dev.includes("--hostname 127.0.0.1"), pkg.scripts.dev);
  check("so is start", pkg.scripts.start.includes("--hostname 127.0.0.1"), pkg.scripts.start);
  check("neither offers 0.0.0.0", !`${pkg.scripts.dev} ${pkg.scripts.start}`.includes("0.0.0.0"));
  check("the LAN scripts exist", Boolean(pkg.scripts["dev:lan"] && pkg.scripts["start:lan"]));

  // Binding every interface and demanding a token are one decision; a script
  // that did the first without the second is the audit's finding.
  const lanScript = fs.readFileSync(path.join(root, "scripts/lan.mjs"), "utf8");
  check("and they bind everything", lanScript.includes("0.0.0.0"));
  check("only together with the token", lanScript.includes("CORPUS_LAN"));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
