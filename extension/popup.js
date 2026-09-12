// The popup: read the page, show what would be sent, send it.
const $ = (id) => document.getElementById(id);
const ENOUGH = 1000; // matches ENOUGH_TO_READ in Corpus
const ENOUGH_WORDS = 120; // and ENOUGH_WORDS: both floors, or it is a menu, not an article

let article = null;

function verdict(kind, text) {
  const v = $("verdict");
  v.hidden = false;
  v.className = `verdict ${kind}`;
  v.textContent = text;
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id || !/^https?:/.test(tab.url || "")) {
    $("status").textContent = "This is not a web page Corpus can read.";
    return;
  }
  const answer = await chrome.runtime.sendMessage({ type: "read", tabId: tab.id });
  if (!answer || !answer.ok) {
    $("status").textContent = "";
    verdict("err", (answer && answer.error) || "Could not read this page.");
    return;
  }
  article = answer.article;
  $("status").textContent = article.fromSelection ? "Your selection, as the article." : "The article, as Readability found it.";
  $("title").textContent = article.title;
  const bits = [article.outlet, article.author, article.publishedAt ? article.publishedAt.slice(0, 10) : ""].filter(Boolean);
  $("meta").textContent = bits.join(" · ");
  if (article.image) {
    $("pic").src = article.image;
    $("pic").style.display = "block";
    $("pic").onerror = () => ($("pic").style.display = "none");
  }
  const words = article.text ? article.text.split(/\s+/).length : 0;
  if (article.text.length >= ENOUGH && words >= ENOUGH_WORDS) {
    verdict("ok", `${words.toLocaleString()} words — enough to read.`);
  } else if (article.text.length >= 200) {
    verdict("warn", `Only ${words} words came through. Select the article text on the page and try again, or send it and paste later.`);
  } else {
    verdict("err", "Nothing readable here. Select the article text on the page and try again.");
    return;
  }
  $("send").disabled = false;
}

$("send").addEventListener("click", async () => {
  if (!article) return;
  $("send").disabled = true;
  $("status").textContent = "Sending…";
  const answer = await chrome.runtime.sendMessage({ type: "send", article });
  if (!answer || !answer.ok) {
    $("status").textContent = "";
    verdict("err", (answer && answer.error) || "That did not work.");
    $("send").disabled = false;
    return;
  }
  const r = answer.result;
  $("status").textContent = r.note || "In the inbox.";
  verdict("ok", `${r.words.toLocaleString()} words in ${r.chunks} passage${r.chunks === 1 ? "" : "s"}. ${r.held} waiting in the inbox.`);
  const open = $("open");
  open.href = `${r.corpusUrl}/inbox`;
  open.hidden = false;
});

$("options").addEventListener("click", () => chrome.runtime.openOptionsPage());

init().catch((e) => {
  $("status").textContent = "";
  verdict("err", e && e.message ? e.message : String(e));
});
