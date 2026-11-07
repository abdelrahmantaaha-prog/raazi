const $ = (id) => document.getElementById(id);
const DEFAULTS = { corpusUrl: "http://127.0.0.1:5400", token: "", instant: true, embed: true };

chrome.storage.sync.get(DEFAULTS).then((s) => {
  $("corpusUrl").value = s.corpusUrl || DEFAULTS.corpusUrl;
  $("token").value = s.token || "";
  $("instant").checked = s.instant;
  $("embed").checked = s.embed;
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

// A checkbox saves itself; there is nothing to type wrong.
$("instant").addEventListener("change", async () => {
  await chrome.storage.sync.set({ instant: $("instant").checked });
  note("ok", $("instant").checked ? "Clicking the icon sends the article." : "Clicking the icon shows the article first.");
});

$("embed").addEventListener("change", async () => {
  await chrome.storage.sync.set({ embed: $("embed").checked });
  note("ok", $("embed").checked ? "Raazi can show articles inside itself." : "Articles keep their refusal to be shown inside Raazi.");
});

$("test").addEventListener("click", async () => {
  const corpusUrl = ($("corpusUrl").value.trim() || DEFAULTS.corpusUrl).replace(/\/+$/, "");
  note("", "Asking…");
  const answer = await chrome.runtime.sendMessage({ type: "hello", corpusUrl, token: $("token").value.trim() });
  if (!answer || !answer.ok) return note("err", (answer && answer.error) || "No answer.");
  const h = answer.hello;
  note(
    "ok",
    `Raazi ${h.version} on ${h.host}: ${h.library.sources} sources, ${h.library.entries} entries.${h.lan ? " LAN mode is on, so the token is needed." : ""}`
  );
});
