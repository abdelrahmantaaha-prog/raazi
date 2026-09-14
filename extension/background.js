// The service worker: reads the page through the content script and posts it
// to Corpus. The popup, the keyboard shortcuts and the right-click menu all
// come through here, so there is one place that knows the address and the token.

const DEFAULTS = { corpusUrl: "http://127.0.0.1:5400", token: "", embed: true };

async function settings() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  return {
    corpusUrl: (s.corpusUrl || DEFAULTS.corpusUrl).replace(/\/+$/, ""),
    token: s.token || "",
    embed: s.embed !== false,
  };
}

/** One machine, two names: Corpus opened at localhost is the Corpus at 127.0.0.1. */
const LOOPBACK = ["127.0.0.1", "localhost"];

/** Whether an address is Corpus's own. */
function isCorpus(url, corpusUrl) {
  try {
    const a = new URL(url);
    const b = new URL(corpusUrl);
    const host = (h) => (LOOPBACK.includes(h) ? "loopback" : h);
    return a.protocol === b.protocol && host(a.hostname) === host(b.hostname) && a.port === b.port;
  } catch (e) {
    return false;
  }
}

/**
 * Runs the extractor in the tab and returns what it saw, and which frame.
 *
 * On Corpus's own page the article is the one open inside it, in the inbox's
 * Page view, so every frame is read and the embedded article is what comes
 * back. Reading Corpus itself would have sent the inbox as an article.
 */
async function readTab(tabId) {
  const { corpusUrl } = await settings();
  const tab = await chrome.tabs.get(tabId);
  const onCorpus = isCorpus(tab.url || "", corpusUrl);
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: onCorpus },
    files: ["readability.js", "content.js"],
  });

  if (onCorpus) {
    // The longest page that is not Corpus: the article, not an ad frame inside it.
    const framed = (results || [])
      .filter((r) => r.frameId !== 0 && r.result && !isCorpus(r.result.url, corpusUrl))
      .sort((a, b) => (b.result.text || "").length - (a.result.text || "").length)[0];
    if (!framed) {
      throw new Error("This is Corpus itself. Open an article's Page view in the inbox, then send it from here.");
    }
    return { ...framed.result, fromFrame: true, frameId: framed.frameId };
  }

  const [result] = results || [];
  if (!result || !result.result) throw new Error("Could not read this page.");
  return { ...result.result, frameId: 0 };
}

/** A request to Corpus, with the token when there is one, and its answer read. */
async function call(path, init = {}) {
  const { corpusUrl, token } = await settings();
  const headers = init.body ? { "content-type": "application/json" } : {};
  if (token) headers["x-corpus-token"] = token;
  let res;
  try {
    res = await fetch(`${corpusUrl}${path}`, { ...init, headers });
  } catch (e) {
    throw new Error(`Corpus did not answer at ${corpusUrl}. Is it running? Set the address in the extension's options.`);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error("Corpus is in LAN mode and wants its token — paste it into the extension's options.");
  return { res, data, corpusUrl };
}

/**
 * Posts an article to the inbox, with anything extra the caller gathered.
 *
 * With quotes, the text sent is the article whatever is selected: the selection
 * is the quote then, not a stand-in for an article Readability misjudged.
 */
async function send(article, extra = {}) {
  const gathering = Array.isArray(extra.quotes) && extra.quotes.length > 0;
  const { res, data, corpusUrl } = await call("/api/inbox/clip", {
    method: "POST",
    body: JSON.stringify({
      url: article.canonical || article.url,
      title: article.title,
      text: gathering ? article.articleText || article.text : article.text,
      author: article.author || null,
      publishedAt: article.publishedAt || null,
      outlet: article.outlet || null,
      image: article.image || null,
      lang: article.lang || null,
      ...extra,
    }),
  });
  if (!res.ok) throw new Error(data.error || `Corpus answered ${res.status}.`);
  return { ...data, corpusUrl };
}

/** "Is there a Corpus at this address?" — for the options page's test button. */
async function hello(corpusUrl, token) {
  const headers = token ? { "x-corpus-token": token } : {};
  const res = await fetch(`${corpusUrl.replace(/\/+$/, "")}/api/hello`, { headers });
  const data = await res.json().catch(() => ({}));
  if (data.app !== "corpus") throw new Error("Something answered, but it is not Corpus.");
  return data;
}

function badge(text, color) {
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 4000);
}

// ---------------------------------------------------------------------------
// Gathering quotes onto a draft.
// ---------------------------------------------------------------------------

/** The drafts in Corpus, most recently worked on first. */
async function drafts() {
  const { res, data } = await call("/api/drafts");
  if (!res.ok) throw new Error(data.error || `Corpus answered ${res.status}.`);
  return data.drafts || [];
}

/** The draft quotes go to: the one asked for, else the one chosen in the popup, else the draft worked on last. */
async function targetDraft(wanted) {
  const { draftId } = await chrome.storage.sync.get({ draftId: null });
  const list = await drafts();
  const chosen = list.find((d) => d.id === wanted) || list.find((d) => d.id === draftId) || list[0];
  if (!chosen) throw new Error("There is no draft to gather into yet. Start one on Corpus's Write page.");
  return chosen;
}

/** Pages already sent this browser session, so a second quote does not send the article again. */
async function sentPages() {
  const { sent } = await chrome.storage.session.get({ sent: [] });
  return sent;
}

async function rememberSent(url) {
  const sent = await sentPages();
  if (!sent.includes(url)) await chrome.storage.session.set({ sent: [...sent, url].slice(-200) });
}

async function countGathered(url, n) {
  if (!n) return;
  const { gathered } = await chrome.storage.session.get({ gathered: {} });
  await chrome.storage.session.set({ gathered: { ...gathered, [url]: (gathered[url] || 0) + n } });
}

/**
 * Marks the gathered words on the page, so what has been taken stays visible.
 * A highlight, not an edit: the page's text is untouched.
 */
async function mark(tabId, frameId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId || 0] },
      func: () => {
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount || !window.CSS || !CSS.highlights || typeof Highlight === "undefined") return false;
        const range = sel.getRangeAt(0).cloneRange();
        const marks = CSS.highlights.get("corpus-gathered");
        if (marks) marks.add(range);
        else CSS.highlights.set("corpus-gathered", new Highlight(range));
        if (!document.getElementById("corpus-gathered-style")) {
          const style = document.createElement("style");
          style.id = "corpus-gathered-style";
          style.textContent = "::highlight(corpus-gathered){background-color:rgba(234,179,8,.38);}";
          (document.head || document.documentElement).appendChild(style);
        }
        sel.removeAllRanges();
        return true;
      },
    });
  } catch (e) {
    /* a page that will not be marked still had its quote gathered */
  }
}

/**
 * Gathers the selected words as a quote onto a draft, and sends the article with it.
 *
 * One action does both because they are one thought: this sentence matters,
 * and so does the piece it sits in. The first quote from a page sends the whole
 * article to the inbox; later ones from the same page only add to the shelf.
 */
async function gather(tabId, fallbackText, wantedDraft) {
  const article = await readTab(tabId);
  const quote = (article.selection || fallbackText || "").trim();
  if (!quote) throw new Error("Select the words you want to keep first.");
  const draft = await targetDraft(wantedDraft);
  const url = article.canonical || article.url;
  const alreadySent = (await sentPages()).includes(url);

  const result = await send(article, { quotes: [quote], draftId: draft.id, clip: !alreadySent });
  await rememberSent(url);
  await countGathered(url, result.gathered || 0);
  await mark(tabId, article.frameId);
  badge(result.gathered ? "+1" : "✓", "#2f6b5b");
  return { ...result, quote, draft: result.draft || { id: draft.id, title: draft.title } };
}

const MENU_ID = "corpus-gather";

async function menuTitle() {
  const { draftTitle } = await chrome.storage.sync.get({ draftTitle: "" });
  return draftTitle
    ? `Gather quote to “${draftTitle}” and send the article`
    : "Gather quote to your draft and send the article";
}

/** The right-click item on selected text. */
async function setupMenu() {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: MENU_ID, title: await menuTitle(), contexts: ["selection"] });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab || !tab.id) return;
  gather(tab.id, info.selectionText).catch((e) => {
    badge("!", "#8a4a5e");
    console.warn("[corpus] gather failed:", e);
  });
});

// ---------------------------------------------------------------------------
// Messages from the popup and the options page.
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    try {
      if (msg.type === "read") reply({ ok: true, article: await readTab(msg.tabId) });
      else if (msg.type === "send") {
        const result = await send(msg.article);
        // The popup may close itself before you look at it; the icon says it went.
        badge("✓", "#2f6b5b");
        reply({ ok: true, result });
      } else if (msg.type === "gather") {
        reply({ ok: true, result: await gather(msg.tabId, "", msg.draftId) });
      } else if (msg.type === "drafts") {
        const list = await drafts();
        const { draftId } = await chrome.storage.sync.get({ draftId: null });
        const chosen = list.find((d) => d.id === draftId) || list[0];
        reply({ ok: true, drafts: list, chosen: chosen ? chosen.id : null });
      } else if (msg.type === "choose-draft") {
        await chrome.storage.sync.set({ draftId: msg.id, draftTitle: msg.title || "" });
        reply({ ok: true });
      } else if (msg.type === "hello") reply({ ok: true, hello: await hello(msg.corpusUrl, msg.token) });
      else reply({ ok: false, error: "Unknown message." });
    } catch (e) {
      reply({ ok: false, error: e && e.message ? e.message : String(e) });
    }
  })();
  return true; // async reply
});

// The keyboard shortcuts: send the page, or gather the selection. Said on the icon.
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "clip" && command !== "gather") return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return;
    if (command === "gather") {
      await gather(tab.id);
      return;
    }
    const article = await readTab(tab.id);
    await send(article);
    badge("✓", "#2f6b5b");
  } catch (e) {
    badge("!", "#8a4a5e");
    console.warn(`[corpus] ${command} failed:`, e);
  }
});

// ---------------------------------------------------------------------------
// Showing an article inside Corpus.
// ---------------------------------------------------------------------------

const EMBED_RULE_ID = 1;

/**
 * The rule that lets Corpus show an article's page inside itself.
 *
 * News sites refuse to be shown inside another page by sending X-Frame-Options,
 * or a Content-Security-Policy with frame-ancestors. For a frame that Corpus's
 * own page opens — and only that: the rule matches sub-frame requests whose
 * initiator is Corpus's host — both headers are removed from the response.
 * A declarative rule cannot take one directive out of a policy, so the whole
 * policy goes for that frame; the same article opened in its own tab, or
 * framed by any other site, keeps all of it.
 */
function embedRule(corpusUrl) {
  let host = "";
  try {
    host = new URL(corpusUrl).hostname;
  } catch (e) {
    return null;
  }
  if (!host) return null;
  return {
    id: EMBED_RULE_ID,
    priority: 1,
    action: {
      type: "modifyHeaders",
      responseHeaders: [
        { header: "x-frame-options", operation: "remove" },
        { header: "content-security-policy", operation: "remove" },
      ],
    },
    condition: {
      initiatorDomains: LOOPBACK.includes(host) ? LOOPBACK.slice() : [host],
      resourceTypes: ["sub_frame"],
    },
  };
}

/** Puts the rule in place for the current address, or takes it away when switched off. */
async function applyEmbedRule() {
  const { corpusUrl, embed } = await settings();
  const rule = embed ? embedRule(corpusUrl) : null;
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [EMBED_RULE_ID],
    addRules: rule ? [rule] : [],
  });
}

chrome.runtime.onInstalled.addListener(() => {
  void applyEmbedRule();
  void setupMenu();
});
chrome.runtime.onStartup.addListener(() => void applyEmbedRule());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  if (changes.corpusUrl || changes.embed) void applyEmbedRule();
  if (changes.draftTitle) {
    void menuTitle().then((title) => chrome.contextMenus.update(MENU_ID, { title }));
  }
});
