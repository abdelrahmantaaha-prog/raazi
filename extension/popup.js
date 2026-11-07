// The popup: read the page, show what would be sent, send it — or gather the
// selected words onto a draft and send the article with them.
//
// With "send as soon as I click the icon" on (the default), a page that reads
// as a whole article goes straight to the inbox: one click, and the popup
// closes itself a moment later. Anything thinner waits for the button, since
// that is when you may want to select the article text first. So does a page
// with words selected: a selection is either a quote to gather or the
// article's text to send instead, and only you know which. Enter does
// whichever is on offer.
const $ = (id) => document.getElementById(id);
const ENOUGH = 1000; // matches ENOUGH_TO_READ in Raazi
const ENOUGH_WORDS = 120; // and ENOUGH_WORDS: both floors, or it is a menu, not an article
const CLOSE_AFTER_MS = 1800;

let article = null;
let sending = false;
let sent = false;
let closeTimer = null;
let canGather = false;

function verdict(kind, text) {
  const v = $("verdict");
  v.hidden = false;
  v.className = `verdict ${kind}`;
  v.textContent = text;
}

/** The keyboard shortcuts as the browser actually has them — Brave leaves a suggested key unassigned when it clashes. */
async function showShortcut() {
  try {
    const commands = await chrome.commands.getAll();
    const key = (name) => {
      const c = commands.find((x) => x.name === name);
      return c && c.shortcut ? c.shortcut : "not set";
    };
    $("key").textContent = key("clip");
    $("gatherKey").textContent = key("gather");
  } catch {
    $("shortcut").hidden = true;
  }
}

/** Closes the popup after a sent-on-click, unless the pointer is resting on it. */
function closeSoon() {
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => window.close(), CLOSE_AFTER_MS);
}

/** Fills the draft picker, with the draft the extension would gather into already chosen. */
async function loadDrafts() {
  const answer = await chrome.runtime.sendMessage({ type: "drafts" });
  if (!answer || !answer.ok) {
    $("gatherNote").textContent = (answer && answer.error) || "Could not list your drafts.";
    return;
  }
  const select = $("draft");
  select.textContent = "";
  for (const d of answer.drafts) {
    const option = document.createElement("option");
    option.value = String(d.id);
    option.textContent = d.title || "Untitled";
    select.appendChild(option);
  }
  if (!answer.drafts.length) {
    $("gatherNote").textContent = "No drafts yet — start one on Raazi's Write page.";
    return;
  }
  select.value = String(answer.chosen ?? answer.drafts[0].id);
  canGather = true;
  $("gather").disabled = false;
}

async function init() {
  void showShortcut();
  const { instant } = await chrome.storage.sync.get({ instant: true });
  $("instant").checked = instant;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id || !/^https?:/.test(tab.url || "")) {
    $("status").textContent = "This is not a web page Raazi can read.";
    return;
  }
  const answer = await chrome.runtime.sendMessage({ type: "read", tabId: tab.id });
  if (!answer || !answer.ok) {
    $("status").textContent = "";
    verdict("err", (answer && answer.error) || "Could not read this page.");
    return;
  }
  article = answer.article;
  $("status").textContent = article.fromSelection
    ? "Your selection, as the article."
    : article.fromFrame
      ? "The article open inside Raazi."
      : "The article, as Readability found it.";
  $("title").textContent = article.title;
  const bits = [article.outlet, article.author, article.publishedAt ? article.publishedAt.slice(0, 10) : ""].filter(Boolean);
  $("meta").textContent = bits.join(" · ");
  if (article.image) {
    $("pic").src = article.image;
    $("pic").style.display = "block";
    $("pic").onerror = () => ($("pic").style.display = "none");
  }

  const quote = (article.selection || "").trim();
  const hasQuote = quote.length >= 2;
  if (hasQuote) {
    $("gatherBox").hidden = false;
    $("quote").hidden = false;
    $("quote").textContent = quote.length > 280 ? `${quote.slice(0, 279)}…` : quote;
    void loadDrafts();
  }
  try {
    const { gathered } = await chrome.storage.session.get({ gathered: {} });
    const count = gathered[article.canonical || article.url] || 0;
    if (count) $("gatheredCount").textContent = `${count} quote${count === 1 ? "" : "s"} gathered from this page so far.`;
  } catch {
    /* no session storage: no count */
  }

  const words = article.text ? article.text.split(/\s+/).length : 0;
  if (article.text.length >= ENOUGH && words >= ENOUGH_WORDS) {
    verdict("ok", `${words.toLocaleString()} words — enough to read.`);
    $("send").disabled = false;
    // The whole point of the setting: an article is sent without a second click —
    // unless words are selected, when the choice is yours.
    if (instant && !hasQuote) await sendArticle(true);
    return;
  }
  if (article.text.length >= 200) {
    verdict("warn", `Only ${words} words came through. Select the article text on the page and try again, or send it and paste later.`);
  } else {
    verdict("err", "Nothing readable here. Select the article text on the page and try again.");
    return;
  }
  $("send").disabled = false;
}

async function sendArticle(onClick) {
  if (!article || sending || sent) return;
  sending = true;
  $("send").disabled = true;
  $("status").textContent = "Sending…";
  const answer = await chrome.runtime.sendMessage({ type: "send", article });
  sending = false;
  if (!answer || !answer.ok) {
    $("status").textContent = "";
    verdict("err", (answer && answer.error) || "That did not work.");
    $("send").disabled = false;
    return;
  }
  sent = true;
  const r = answer.result;
  $("status").textContent = r.note || "In the inbox.";
  $("send").textContent = "Sent";
  verdict("ok", `${r.words.toLocaleString()} words in ${r.chunks} passage${r.chunks === 1 ? "" : "s"}. ${r.held} waiting in the inbox.`);
  const open = $("open");
  open.href = `${r.corpusUrl}/inbox`;
  open.hidden = false;
  if (onClick) closeSoon();
}

async function gatherQuote() {
  if (!article || !canGather || sending) return;
  sending = true;
  canGather = false;
  $("gather").disabled = true;
  $("gatherNote").textContent = "Gathering…";
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const answer = await chrome.runtime.sendMessage({ type: "gather", tabId: tab.id, draftId: Number($("draft").value) });
  sending = false;
  if (!answer || !answer.ok) {
    $("gatherNote").textContent = (answer && answer.error) || "That did not work.";
    canGather = true;
    $("gather").disabled = false;
    return;
  }
  const r = answer.result;
  $("gather").textContent = "Gathered";
  $("gatherNote").textContent = r.gathered
    ? `On the shelf of “${r.draft.title}”${r.alreadyRead ? " — the article was already in your library." : " — and the article is in the inbox."}`
    : `Already on the shelf of “${r.draft.title}”.`;
  // The article went with the quote; there is nothing left to send.
  sent = true;
  $("send").disabled = true;
  const open = $("open");
  open.href = `${r.corpusUrl}/write?draft=${r.draft.id}`;
  open.textContent = "Open the draft";
  open.hidden = false;
}

$("send").addEventListener("click", () => void sendArticle(false));
$("gather").addEventListener("click", () => void gatherQuote());

$("draft").addEventListener("change", () => {
  const select = $("draft");
  void chrome.runtime.sendMessage({
    type: "choose-draft",
    id: Number(select.value),
    title: select.selectedOptions[0] ? select.selectedOptions[0].textContent : "",
  });
});

// Enter does what is on offer: gather when words are selected, send otherwise.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.target.closest("a, input, select")) return;
  e.preventDefault();
  if (canGather) void gatherQuote();
  else if (!$("send").disabled) void sendArticle(false);
});

// Resting the pointer on the popup keeps it open to read; leaving lets it close.
document.body.addEventListener("mouseenter", () => clearTimeout(closeTimer));
document.body.addEventListener("mouseleave", () => {
  // Only a sent-on-click closes itself; a gathered quote leaves the popup open to read.
  if (sent && $("instant").checked && $("gatherBox").hidden) closeSoon();
});

$("instant").addEventListener("change", () => chrome.storage.sync.set({ instant: $("instant").checked }));
$("keys").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
});
$("options").addEventListener("click", () => chrome.runtime.openOptionsPage());

init().catch((e) => {
  $("status").textContent = "";
  verdict("err", e && e.message ? e.message : String(e));
});
