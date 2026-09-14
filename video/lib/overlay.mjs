/**
 * On-screen storytelling drawn inside the page being recorded, so Arabic is
 * shaped by the browser, stays sharp at any size, and can point at the real
 * element rather than at a guessed rectangle in post.
 *
 *   caption  a chapter card: kicker, headline, one line of explanation,
 *            revealed word by word
 *   focus    dims everything but one element (marked data-film-focus) and
 *            pins a short note to it; follows it through scrolls and glides
 *            between targets
 *
 * Passed to addInitScript as a function, so it must stay self-contained.
 * Lives in a shadow root so the app's stylesheet cannot reach it.
 */
export function overlayMain() {
  if (window.__film) return;

  const CSS = `
    :host { all: initial; }
    .spot { position: fixed; left: 0; top: 0; width: 0; height: 0; border-radius: 14px;
      box-shadow: 0 0 0 4000px rgba(16, 10, 6, 0); outline: 2px solid rgba(232, 190, 146, 0); outline-offset: 3px;
      transition: box-shadow .45s ease, outline-color .45s ease; }
    .spot.on { box-shadow: 0 0 0 4000px rgba(16, 10, 6, .5); outline-color: rgba(232, 190, 146, .95); }

    .note { position: fixed; left: 0; top: 0; opacity: 0; transition: opacity .3s ease; }
    .note.on { opacity: 1; }
    .note span { display: inline-block; direction: rtl; white-space: nowrap; background: #faf6f0; color: #3a2415;
      font: 700 18px/1.5 "Noto Kufi Arabic", sans-serif; padding: 8px 18px 9px; border-radius: 999px;
      border: 1px solid rgba(123, 74, 42, .22); box-shadow: 0 10px 28px rgba(12, 7, 3, .28); }
    .note span::before { content: ""; display: inline-block; width: 8px; height: 8px; border-radius: 50%;
      background: #b5733f; margin-inline-end: 10px; vertical-align: middle; }
    .note.on span { animation: pop .5s cubic-bezier(.2, .9, .3, 1.25); }
    @keyframes pop { from { transform: translateY(8px) scale(.92); } to { transform: none; } }

    .card { position: fixed; width: 560px; box-sizing: border-box; padding: 22px 28px 24px; border-radius: 18px;
      background: linear-gradient(180deg, rgba(36, 24, 15, .96), rgba(24, 16, 10, .96)); color: #f7efe5;
      box-shadow: 0 24px 60px rgba(10, 6, 3, .35), inset 0 1px 0 rgba(255, 255, 255, .07);
      opacity: 0; transform: translateY(22px) scale(.985);
      transition: opacity .55s ease, transform .65s cubic-bezier(.2, .8, .2, 1);
      font-family: "Noto Sans Arabic", sans-serif; direction: rtl; text-align: right; }
    .card.on { opacity: 1; transform: none; }
    .card[data-pos="br"] { right: 40px; bottom: 40px; }
    .card[data-pos="bl"] { left: 40px; bottom: 40px; }
    .card[data-pos="tr"] { right: 40px; top: 40px; }
    .card[data-pos="tl"] { left: 40px; top: 40px; }
    .kicker { display: flex; align-items: center; gap: 12px; font: 700 15px/1.4 "Noto Kufi Arabic", sans-serif; color: #e3b98f; }
    .kicker .line { flex: 1; height: 1px; background: linear-gradient(to left, rgba(227, 185, 143, .55), rgba(227, 185, 143, 0)); }
    .kicker .count { font: 600 13px/1 "Segoe UI", system-ui, sans-serif; font-variant-numeric: tabular-nums lining-nums;
      letter-spacing: 1.5px; color: rgba(227, 185, 143, .8); direction: ltr; }
    .title { font: 700 31px/1.5 "Noto Kufi Arabic", sans-serif; margin: 12px 0 6px; color: #fff8ef; }
    .body { font: 400 19px/1.85 "Noto Sans Arabic", sans-serif; color: #d9cbbb; }
    .kicker, .title, .body { transition: opacity .22s ease; }
    .card.swap .kicker, .card.swap .title, .card.swap .body { opacity: 0; }
    .w { display: inline-block; opacity: 0; transform: translateY(10px); filter: blur(5px);
      animation: w .55s cubic-bezier(.2, .8, .2, 1) forwards; }
    @keyframes w { to { opacity: 1; transform: none; filter: blur(0); } }
  `;

  const st = { caption: null, focusOn: false, side: "top", pad: 10, cur: null, snap: true };
  let host = null;
  let root = null;
  const q = (sel) => root.querySelector(sel);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const two = (n) => String(n).padStart(2, "0");
  const words = (text, start, step) => String(text).split(/\s+/).filter(Boolean)
    .map((w, i) => `<span class="w" style="animation-delay:${(start + i * step).toFixed(3)}s">${esc(w)}</span>`).join(" ");

  function mount() {
    if (host && host.isConnected) return;
    if (!document.documentElement) return;
    host = document.createElement("div");
    host.id = "__film_overlay";
    host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483600;";
    root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${CSS}</style><div class="spot"></div><div class="note"></div>` +
      `<div class="card" data-pos="br"><div class="kicker"><span class="chap"></span><span class="line"></span>` +
      `<span class="count"></span></div><div class="title"></div><div class="body"></div></div>`;
    document.documentElement.appendChild(host);
    // A client-side navigation can drop the node; put back what was showing.
    if (st.caption) { paint(st.caption); q(".card").classList.add("on"); }
    if (st.focusOn) { q(".spot").classList.add("on"); st.snap = true; }
  }

  function paint(c) {
    const card = q(".card");
    card.dataset.pos = c.pos || "br";
    q(".chap").textContent = c.kicker || "";
    q(".count").textContent = c.step ? `${two(c.step)} / ${two(c.total)}` : "";
    q(".title").innerHTML = words(c.title || "", 0.08, 0.07);
    q(".body").innerHTML = words(c.body || "", 0.32, 0.03);
  }

  function tick() {
    mount();
    if (root && st.focusOn) {
      const el = document.querySelector("[data-film-focus]");
      if (el) {
        const r = el.getBoundingClientRect();
        const p = st.pad;
        const t = { x: r.left - p, y: r.top - p, w: r.width + 2 * p, h: r.height + 2 * p };
        if (!st.cur || st.snap) { st.cur = { ...t }; st.snap = false; }
        else for (const k of ["x", "y", "w", "h"]) st.cur[k] += (t[k] - st.cur[k]) * 0.18;
        const c = st.cur;
        const spot = q(".spot");
        spot.style.transform = `translate(${c.x}px, ${c.y}px)`;
        spot.style.width = `${c.w}px`;
        spot.style.height = `${c.h}px`;

        const note = q(".note");
        const nw = note.offsetWidth, nh = note.offsetHeight;
        let side = st.side;
        if (side === "top" && c.y - nh - 16 < 14) side = "bottom";
        if (side === "bottom" && c.y + c.h + nh + 16 > innerHeight - 14) side = "top";
        let ny = side === "top" ? c.y - nh - 16 : c.y + c.h + 16;
        let nx = c.x + c.w - nw; // right-aligned: Arabic reads from the right
        nx = Math.max(14, Math.min(nx, innerWidth - nw - 14));
        ny = Math.max(14, Math.min(ny, innerHeight - nh - 14));
        note.style.transform = `translate(${nx}px, ${ny}px)`;
      }
    }
    requestAnimationFrame(tick);
  }

  window.__film = {
    caption(c) {
      mount();
      st.caption = c;
      const card = q(".card");
      if (card.classList.contains("on")) {
        card.classList.add("swap");
        setTimeout(() => { paint(c); card.classList.remove("swap"); }, 240);
      } else {
        paint(c);
        void card.offsetWidth;
        card.classList.add("on");
      }
    },
    hideCaption() {
      mount();
      st.caption = null;
      q(".card").classList.remove("on");
    },
    focus(o = {}) {
      mount();
      const spot = q(".spot");
      st.snap = !spot.classList.contains("on");
      st.focusOn = true;
      st.pad = o.pad ?? 10;
      st.side = o.side || "top";
      const note = q(".note");
      note.classList.remove("on");
      if (o.note) {
        note.innerHTML = `<span>${esc(o.note)}</span>`;
        void note.offsetWidth;
        note.classList.add("on");
      }
      spot.classList.add("on");
    },
    unfocus() {
      mount();
      st.focusOn = false;
      q(".spot").classList.remove("on");
      q(".note").classList.remove("on");
    },
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  requestAnimationFrame(tick);
}
