// What the Raazi phone app adds to Raazi's own pages, before they run.
//
// Android's WebView leaves out three things a reading app leans on, and this
// fills each from the phone through the RaaziPhone bridge (which only Raazi's
// own address can see):
//
//  - read-aloud: the WebView has no speechSynthesis at all, so the reader's
//    Listen button had nothing to speak with. The phone's own voices stand in,
//    behind the same API the reader already uses.
//  - the screen wake lock the reader asks for while a book is open.
//  - the back button: it closes whatever sheet or book is open (by Escape,
//    which every panel in Raazi already answers) before it leaves the page.
(() => {
  if (window.__raaziPhone) return;
  const bridge = window.RaaziPhone;
  if (!bridge) return;
  window.__raaziPhone = true;
  const send = (m) => bridge.postMessage(JSON.stringify(m));

  // ---- The back button --------------------------------------------------
  let lastBack = { at: 0, open: 0 };
  const openPanels = () =>
    [...document.querySelectorAll('[role="dialog"], [data-back]')].filter((el) => el.getClientRects().length > 0).length;
  window.__raaziBack = () => {
    const open = openPanels();
    if (!open) return false;
    // Pressed again straight away with nothing closed: whatever is open does
    // not answer Escape, and back must not become a trap.
    const now = Date.now();
    if (now - lastBack.at < 1500 && lastBack.open === open) {
      lastBack = { at: 0, open: 0 };
      return false;
    }
    lastBack = { at: now, open };
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true, cancelable: true })
    );
    return true;
  };

  // ---- Keeping the screen on -------------------------------------------
  let holds = 0;
  const wakeLock = {
    request() {
      holds++;
      send({ op: "awake", on: true });
      let released = false;
      const sentinel = {
        type: "screen",
        get released() {
          return released;
        },
        onrelease: null,
        addEventListener() {},
        removeEventListener() {},
        release() {
          if (!released) {
            released = true;
            holds = Math.max(0, holds - 1);
            if (!holds) send({ op: "awake", on: false });
          }
          return Promise.resolve();
        },
      };
      return Promise.resolve(sentinel);
    },
  };
  try {
    Object.defineProperty(navigator, "wakeLock", { value: wakeLock, configurable: true });
  } catch (e) {}

  // ---- Read-aloud ------------------------------------------------------
  const fire = (target, type, extra) => {
    const ev = new Event(type);
    Object.assign(ev, { utterance: target, charIndex: 0, elapsedTime: 0, name: "" }, extra || {});
    try {
      target.dispatchEvent(ev);
    } catch (e) {}
    const handler = target["on" + type];
    if (typeof handler === "function") {
      try {
        handler.call(target, ev);
      } catch (e) {
        setTimeout(() => {
          throw e;
        });
      }
    }
  };

  class SpeechSynthesisUtterance extends EventTarget {
    constructor(text) {
      super();
      this.text = text == null ? "" : String(text);
      this.lang = "";
      this.voice = null;
      this.rate = 1;
      this.pitch = 1;
      this.volume = 1;
      this.onstart = this.onend = this.onerror = this.onpause = this.onresume = this.onboundary = this.onmark = null;
    }
  }

  let voices = [];
  let seq = 0;
  /** What has been handed over and has not ended, in order; the first is speaking. */
  let queue = [];
  let paused = false;

  const handOver = (entry) => {
    const u = entry.u;
    send({
      op: "speak",
      id: entry.id,
      text: u.text,
      voice: (u.voice && u.voice.voiceURI) || "",
      lang: u.lang || (u.voice && u.voice.lang) || document.documentElement.lang || "",
      rate: Number(u.rate) || 1,
      pitch: Number(u.pitch) || 1,
      volume: u.volume == null ? 1 : Number(u.volume),
    });
  };

  class Synth extends EventTarget {
    constructor() {
      super();
      this.onvoiceschanged = null;
    }
    get speaking() {
      return queue.length > 0;
    }
    get pending() {
      return queue.length > 1;
    }
    get paused() {
      return paused;
    }
    getVoices() {
      return voices.slice();
    }
    speak(u) {
      if (!(u instanceof SpeechSynthesisUtterance)) throw new TypeError("Not an utterance");
      const entry = { id: ++seq, u, started: false };
      queue.push(entry);
      if (!paused) handOver(entry);
    }
    cancel() {
      const dropped = queue;
      queue = [];
      paused = false;
      send({ op: "stop" });
      for (const e of dropped) setTimeout(() => fire(e.u, "error", { error: e.started ? "interrupted" : "canceled" }), 0);
    }
    // Android's engine cannot pause, only stop. So pausing stops, and resuming
    // says the current sentence again from its start — the reader hands over
    // a sentence or so at a time, so that is a few seconds repeated at most.
    pause() {
      if (paused || !queue.length) return;
      paused = true;
      send({ op: "stop" });
      fire(queue[0].u, "pause");
    }
    resume() {
      // The reader nudges resume() every few seconds while speaking, to keep
      // Chrome's engine awake; when nothing is paused it must do nothing.
      if (!paused) return;
      paused = false;
      if (queue.length) fire(queue[0].u, "resume");
      for (const e of queue) handOver(e);
    }
  }
  const synth = new Synth();

  bridge.onmessage = (event) => {
    let m;
    try {
      m = JSON.parse(event.data);
    } catch (e) {
      return;
    }
    if (m.voices) {
      voices = m.voices.map((v) => Object.freeze({ voiceURI: v.voiceURI, name: v.name, lang: v.lang, localService: !!v.localService, default: !!v.default }));
      const ev = new Event("voiceschanged");
      synth.dispatchEvent(ev);
      if (typeof synth.onvoiceschanged === "function") synth.onvoiceschanged(ev);
      return;
    }
    if (paused) return;
    const at = queue.findIndex((e) => e.id === m.id);
    if (at < 0) return;
    const entry = queue[at];
    if (m.ev === "start") {
      if (!entry.started) {
        entry.started = true;
        fire(entry.u, "start");
      }
    } else if (m.ev === "end" || m.ev === "error") {
      queue.splice(at, 1);
      fire(entry.u, m.ev, m.ev === "error" ? { error: "synthesis-failed" } : {});
    }
  };

  try {
    Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
    Object.defineProperty(window, "SpeechSynthesisUtterance", { value: SpeechSynthesisUtterance, configurable: true, writable: true });
  } catch (e) {}
  send({ op: "hello" });
})();
