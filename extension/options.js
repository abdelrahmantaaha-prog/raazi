const $ = (id) => document.getElementById(id);
const DEFAULTS = { corpusUrl: "http://127.0.0.1:5400", token: "" };

chrome.storage.sync.get(DEFAULTS).then((s) => {
  $("corpusUrl").value = s.corpusUrl || DEFAULTS.corpusUrl;
  $("token").value = s.token || "";
});

function note(kind, text) {
  $("note").className = kind;
  $("note").textContent = text;
}

$("save").addEventListener("click", async () => {
  const corpusUrl = ($("corpusUrl").value.trim() || DEFAULTS.corpusUrl).replace(/\/+$/, "");
  if (!/^https?:\/\//.test(corpusUrl)) return note("err", "The address must start with http:// or https://.");
  await chrome.storage.sync.set({ corpusUrl, token: $("token").value.trim() });
  note("ok", "Saved.");
});

$("test").addEventListener("click", async () => {
  const corpusUrl = ($("corpusUrl").value.trim() || DEFAULTS.corpusUrl).replace(/\/+$/, "");
  note("", "Asking…");
  const answer = await chrome.runtime.sendMessage({ type: "hello", corpusUrl, token: $("token").value.trim() });
  if (!answer || !answer.ok) return note("err", (answer && answer.error) || "No answer.");
  const h = answer.hello;
  note(
    "ok",
    `Corpus ${h.version} on ${h.host}: ${h.library.sources} sources, ${h.library.entries} entries.${h.lan ? " LAN mode is on, so the token is needed." : ""}`
  );
});
