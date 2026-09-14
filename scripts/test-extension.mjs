/**
 * The browser extension's service worker, run against a stand-in for the
 * browser: the rule that lets Corpus show an article inside itself, reading
 * the article out of that frame rather than Corpus's own page, and gathering
 * a selected quote onto a draft while the article goes to the inbox.
 *
 * The properties: the refusal to be framed is lifted only for frames Corpus
 * opens, never for a page in its own tab; switching it off removes the rule;
 * sending from Corpus sends the embedded article, not the inbox; and a quote
 * gathered is the selection, sent with the whole article, to the chosen draft,
 * without sending the article twice.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/test-extension.mjs
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
const settle = () => new Promise((r) => setTimeout(r, 5));
const json = (v) => JSON.stringify(v);

const source = fs.readFileSync(path.join(root, "extension", "background.js"), "utf8");

/** background.js in a context with a pretend `chrome`. */
function load({ stored = {}, tabUrl = "https://paper.example/story", frames = [], fetchImpl } = {}) {
  const calls = { rules: [], listeners: {}, target: null, injected: [], menus: [], menuUpdates: [] };
  const session = {};
  const sync = { ...stored };
  const on = (name) => ({ addListener: (fn) => (calls.listeners[name] = fn) });
  const chrome = {
    storage: {
      sync: {
        get: async (defaults) => ({ ...defaults, ...sync }),
        set: async (values) => void Object.assign(sync, values),
      },
      session: {
        get: async (defaults) => ({ ...defaults, ...session }),
        set: async (values) => void Object.assign(session, values),
      },
      onChanged: on("storage"),
    },
    declarativeNetRequest: { updateDynamicRules: async (update) => void calls.rules.push(update) },
    runtime: { onMessage: on("message"), onInstalled: on("installed"), onStartup: on("startup") },
    commands: { onCommand: on("command") },
    contextMenus: {
      removeAll: async () => {},
      create: (item) => void calls.menus.push(item),
      update: (id, change) => void calls.menuUpdates.push([id, change]),
      onClicked: on("menu"),
    },
    action: { setBadgeBackgroundColor() {}, setBadgeText() {} },
    tabs: { get: async (id) => ({ id, url: tabUrl }), query: async () => [] },
    scripting: {
      executeScript: async ({ target, func }) => {
        if (func) {
          calls.injected.push(target);
          return [];
        }
        calls.target = target;
        return frames;
      },
    },
  };
  const context = vm.createContext({
    chrome,
    URL,
    console,
    setTimeout,
    fetch:
      fetchImpl ??
      (async () => {
        throw new Error("no network in tests");
      }),
  });
  vm.runInContext(source, context);
  return { context, calls, sync, session };
}

section("The manifest asks for what the extension needs");
{
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "extension", "manifest.json"), "utf8"));
  check("header rules are permitted", manifest.permissions.includes("declarativeNetRequestWithHostAccess"));
  check("so is the right-click menu", manifest.permissions.includes("contextMenus"));
  check("gathering has its own shortcut", Boolean(manifest.commands.gather?.suggested_key?.default));
  check("and the version moved, so a reload is visible", manifest.version === "0.4.0", manifest.version);
}

section("The refusal to be framed is lifted only inside Corpus");
{
  const { context } = load();
  const rule = JSON.parse(json(context.embedRule("http://127.0.0.1:5400")));
  check("it removes X-Frame-Options and the content security policy", rule.action.type === "modifyHeaders" &&
    json(rule.action.responseHeaders.map((h) => [h.header, h.operation])) ===
      json([["x-frame-options", "remove"], ["content-security-policy", "remove"]]));
  check("only for frames, never for a page in its own tab", json(rule.condition.resourceTypes) === json(["sub_frame"]));
  check("only when Corpus's page opened the frame, under either name for this machine",
    json(rule.condition.initiatorDomains) === json(["127.0.0.1", "localhost"]), json(rule.condition.initiatorDomains));
  check("nothing matches by the article's address, so no site is singled out", !("requestDomains" in rule.condition) && !("urlFilter" in rule.condition));

  const lan = JSON.parse(json(context.embedRule("http://192.168.1.20:5400")));
  check("a Corpus on the network is matched by its own address alone", json(lan.condition.initiatorDomains) === json(["192.168.1.20"]));
  check("a malformed address makes no rule", context.embedRule("not a url") === null);
}

section("The rule follows the setting");
{
  const on = load({ stored: { corpusUrl: "http://127.0.0.1:5400" } });
  on.calls.listeners.installed();
  await settle();
  check("installing puts the rule in place", on.calls.rules.length === 1 && on.calls.rules[0].addRules.length === 1);
  check("replacing any older copy of it", json(on.calls.rules[0].removeRuleIds) === json([1]));

  on.calls.listeners.storage({ token: { newValue: "x" } }, "sync");
  await settle();
  check("changing the token leaves the rule alone", on.calls.rules.length === 1);
  on.calls.listeners.storage({ corpusUrl: { newValue: "http://192.168.1.20:5400" } }, "sync");
  await settle();
  check("changing the address rewrites it", on.calls.rules.length === 2);

  const off = load({ stored: { embed: false } });
  off.calls.listeners.startup();
  await settle();
  check("switched off, the rule is removed and none added",
    off.calls.rules.length === 1 && off.calls.rules[0].addRules.length === 0 && json(off.calls.rules[0].removeRuleIds) === json([1]));
}

section("Sending from Corpus sends the article open inside it");
{
  const { context } = load();
  check("127.0.0.1 and localhost are the same Corpus", context.isCorpus("http://localhost:5400/inbox", "http://127.0.0.1:5400"));
  check("another port is not", !context.isCorpus("http://127.0.0.1:3000/", "http://127.0.0.1:5400"));
  check("and an article is not", !context.isCorpus("https://paper.example/story", "http://127.0.0.1:5400"));

  const frames = [
    { frameId: 0, result: { url: "http://localhost:5400/inbox", text: "Inbox Keep File Discard ".repeat(80) } },
    { frameId: 7, result: { url: "https://ads.example/slot", text: "Buy now" } },
    { frameId: 4, result: { url: "https://paper.example/story", title: "The story", text: "The article itself. ".repeat(100) } },
  ];
  const corpus = load({ tabUrl: "http://localhost:5400/inbox", frames });
  const article = await corpus.context.readTab(1);
  check("every frame is read on Corpus's page", corpus.calls.target.allFrames === true);
  check("the embedded article comes back, not the inbox or an ad", article.url === "https://paper.example/story" && article.title === "The story");
  check("marked as read from inside Corpus, with its frame", article.fromFrame === true && article.frameId === 4);

  const empty = load({ tabUrl: "http://127.0.0.1:5400/inbox", frames: [frames[0]] });
  let refused = null;
  try {
    await empty.context.readTab(1);
  } catch (err) {
    refused = err;
  }
  check("with no article open inside, it says so instead of sending the inbox", refused !== null && /Page view/.test(refused.message), refused?.message);

  const plain = load({ tabUrl: "https://paper.example/story", frames: [{ frameId: 0, result: { url: "https://paper.example/story", text: "Text." } }] });
  const own = await plain.context.readTab(2);
  check("an article in its own tab is read from the top frame only", plain.calls.target.allFrames === false && own.url === "https://paper.example/story" && !own.fromFrame);
}

section("A selected quote is gathered onto a draft, and the article sent with it");
{
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null, headers: init.headers ?? {} });
    if (url.endsWith("/api/drafts")) {
      return new Response(json({ drafts: [{ id: 7, title: "Latest draft" }, { id: 3, title: "Budget piece" }] }), { status: 200 });
    }
    if (url.endsWith("/api/inbox/clip")) {
      return new Response(json({ sourceId: 11, gathered: 1, skipped: 0, draft: { id: 3, title: "Budget piece" } }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  };
  const clips = () => requests.filter((r) => r.url.endsWith("/api/inbox/clip"));
  const page = {
    url: "https://paper.example/story",
    title: "The story",
    text: "A sentence worth keeping.",
    articleText: "The whole article. ".repeat(80),
    selection: "A sentence worth keeping.",
  };

  const ext = load({ stored: { draftId: 3, token: "tok" }, frames: [{ frameId: 0, result: page }], fetchImpl });
  const result = await ext.context.gather(1);
  const first = clips()[0];
  check("the quote is the selection", first?.body.quotes?.[0] === "A sentence worth keeping.", json(first?.body.quotes));
  check("it goes to the draft chosen in the popup", first?.body.draftId === 3);
  check("the article sent with it is the whole article, not the selection", first?.body.text.startsWith("The whole article."));
  check("the token travels with it", first?.headers["x-corpus-token"] === "tok");
  check("the first quote from a page sends the article", first?.body.clip === true);
  check("the gathered words are marked on the page, in the frame they were in", ext.calls.injected.some((t) => json(t.frameIds) === json([0])));
  check("and the answer names the draft", result.draft?.title === "Budget piece");

  await ext.context.gather(1);
  check("a second quote from the same page does not send the article again", clips()[1]?.body.clip === false);

  const fallback = load({ frames: [{ frameId: 0, result: page }], fetchImpl });
  await fallback.context.gather(1);
  check("with no draft chosen, quotes go to the draft worked on last", clips().at(-1)?.body.draftId === 7);

  const asked = load({ stored: { draftId: 3 }, frames: [{ frameId: 0, result: page }], fetchImpl });
  await asked.context.gather(1, "", 7);
  check("a draft picked in the popup for this quote wins over the saved one", clips().at(-1)?.body.draftId === 7);

  const nothing = load({ frames: [{ frameId: 0, result: { ...page, selection: "" } }], fetchImpl });
  const before = clips().length;
  let refused = null;
  try {
    await nothing.context.gather(1);
  } catch (err) {
    refused = err;
  }
  check("with nothing selected it says so rather than sending", refused !== null && /Select/.test(refused.message) && clips().length === before);

  const menu = load({ stored: { draftTitle: "Budget piece" }, fetchImpl });
  menu.calls.listeners.installed();
  await settle();
  check("installing adds a right-click item for selected text", menu.calls.menus.some((m) => json(m.contexts) === json(["selection"])));
  check("named for the draft quotes will go to", menu.calls.menus.some((m) => /Budget piece/.test(m.title)), json(menu.calls.menus));
  menu.sync.draftTitle = "Another piece";
  menu.calls.listeners.storage({ draftTitle: { newValue: "Another piece" } }, "sync");
  await settle();
  check("and renamed when another draft is chosen", menu.calls.menuUpdates.some(([, c]) => /Another piece/.test(c.title)));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
