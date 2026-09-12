// The service worker: reads the page through the content script and posts it
// to Corpus. The popup and the keyboard shortcut both come through here, so
// there is one place that knows the address and the token.

const DEFAULTS = { corpusUrl: "http://127.0.0.1:5400", token: "" };

async function settings() {
  const s = await chrome.storage.sync.get(DEFAULTS);
  return { corpusUrl: (s.corpusUrl || DEFAULTS.corpusUrl).replace(/\/+$/, ""), token: s.token || "" };
}

/** Runs the extractor in the tab and returns what it saw. */
async function readTab(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    files: ["readability.js", "content.js"],
  });
  if (!result || !result.result) throw new Error("Could not read this page.");
  return result.result;
}

/** Posts an article to the inbox. Resolves to the server's answer. */
async function send(article) {
  const { corpusUrl, token } = await settings();
  const headers = { "content-type": "application/json" };
  if (token) headers["x-corpus-token"] = token;
  let res;
  try {
    res = await fetch(`${corpusUrl}/api/inbox/clip`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        url: article.canonical || article.url,
        title: article.title,
        text: article.text,
        author: article.author || null,
        publishedAt: article.publishedAt || null,
        outlet: article.outlet || null,
        image: article.image || null,
        lang: article.lang || null,
      }),
    });
  } catch (e) {
    throw new Error(`Corpus did not answer at ${corpusUrl}. Is it running? Set the address in the extension's options.`);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error("Corpus is in LAN mode and wants its token — paste it into the extension's options.");
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

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    try {
      if (msg.type === "read") reply({ ok: true, article: await readTab(msg.tabId) });
      else if (msg.type === "send") reply({ ok: true, result: await send(msg.article) });
      else if (msg.type === "hello") reply({ ok: true, hello: await hello(msg.corpusUrl, msg.token) });
      else reply({ ok: false, error: "Unknown message." });
    } catch (e) {
      reply({ ok: false, error: e && e.message ? e.message : String(e) });
    }
  })();
  return true; // async reply
});

// The keyboard shortcut: read and send in one go, and say so on the icon.
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "clip") return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return;
    const article = await readTab(tab.id);
    await send(article);
    badge("✓", "#2f6b5b");
  } catch (e) {
    badge("!", "#8a4a5e");
    console.warn("[corpus] clip failed:", e);
  }
});
