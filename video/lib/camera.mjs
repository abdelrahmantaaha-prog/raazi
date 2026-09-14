import fs from "node:fs";
import path from "node:path";

/**
 * A visible pointer. Headless Chromium draws none, and a click nobody can see
 * coming reads as the page changing by itself. Re-installed on a timer because
 * a client-side navigation can replace the node.
 */
export const CURSOR_SCRIPT = `(() => {
  const install = () => {
    if (document.getElementById("__film_cursor") || !document.documentElement) return;
    const ring = document.createElement("div");
    ring.id = "__film_ring";
    Object.assign(ring.style, { position: "fixed", left: "0", top: "0", width: "44px", height: "44px",
      margin: "-22px 0 0 -22px", borderRadius: "50%", border: "3px solid rgba(123,74,42,.55)",
      background: "rgba(123,74,42,.12)", opacity: "0", pointerEvents: "none", zIndex: "2147483646",
      transform: "translate(-200px,-200px) scale(.4)" });
    const c = document.createElement("div");
    c.id = "__film_cursor";
    c.innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24"><path d="M4 2 L4 19.5 L8.6 15.4 L11.8 22.2 L15 20.8 L11.8 14.1 L18.5 14.1 Z" fill="#1d140d" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    Object.assign(c.style, { position: "fixed", left: "0", top: "0", pointerEvents: "none", zIndex: "2147483647",
      transform: "translate(-200px,-200px)", filter: "drop-shadow(0 2px 3px rgba(0,0,0,.28))" });
    document.documentElement.append(ring, c);
    const at = window.__filmAt;
    if (at) c.style.transform = "translate(" + (at[0] - 4) + "px," + (at[1] - 2) + "px)";
  };
  addEventListener("mousemove", (e) => {
    window.__filmAt = [e.clientX, e.clientY];
    const c = document.getElementById("__film_cursor");
    if (c) c.style.transform = "translate(" + (e.clientX - 4) + "px," + (e.clientY - 2) + "px)";
  }, true);
  addEventListener("mousedown", (e) => {
    const r = document.getElementById("__film_ring");
    if (!r) return;
    r.style.transition = "none";
    r.style.opacity = "1";
    r.style.transform = "translate(" + e.clientX + "px," + e.clientY + "px) scale(.4)";
    requestAnimationFrame(() => requestAnimationFrame(() => {
      r.style.transition = "transform .45s ease-out, opacity .45s ease-out";
      r.style.opacity = "0";
      r.style.transform = "translate(" + e.clientX + "px," + e.clientY + "px) scale(1.25)";
    }));
  }, true);
  setInterval(install, 150);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install); else install();
})();`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/**
 * Records the page through the DevTools screencast — full-quality frames at
 * the device pixel size, rather than Playwright's softer built-in recorder —
 * and moves, clicks, scrolls and types at a human pace while it does.
 */
export class Camera {
  constructor(page) {
    this.page = page;
    this.x = 1380;
    this.y = 780;
  }

  /** Seconds since recording started. */
  now() {
    return Date.now() / 1000 - this.t0;
  }

  async park() {
    await this.page.mouse.move(this.x, this.y);
  }

  async start(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    this.dir = dir;
    this.frames = [];
    this.writes = [];
    this.cdp = await this.page.context().newCDPSession(this.page);
    let n = 0;
    this.cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
      const file = `f${String(n++).padStart(5, "0")}.jpg`;
      this.frames.push({ file, t: metadata.timestamp ?? Date.now() / 1000 });
      this.writes.push(fs.promises.writeFile(path.join(dir, file), Buffer.from(data, "base64")));
      this.cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    });
    await this.cdp.send("Page.startScreencast", { format: "jpeg", quality: 94, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
    this.t0 = Date.now() / 1000;
    // A static page sends nothing until it repaints; nudge one.
    await this.page.mouse.move(this.x + 1, this.y);
    await this.page.mouse.move(this.x, this.y);
  }

  async stop() {
    const t1 = Date.now() / 1000;
    await this.page.mouse.move(this.x + 1, this.y);
    await sleep(80);
    await this.cdp.send("Page.stopScreencast").catch(() => {});
    await this.cdp.detach().catch(() => {});
    await Promise.all(this.writes);
    return { frames: this.frames, t0: this.t0, t1, dir: this.dir };
  }

  async wait(sec) {
    await sleep(sec * 1000);
  }

  /** Waits until the recording reaches this many seconds. */
  async until(sec) {
    const left = sec - this.now();
    if (left > 0) await sleep(left * 1000);
  }

  locate(target) {
    return typeof target === "string" ? this.page.locator(target).first() : target;
  }

  async point(target, { dx = 0.5, dy = 0.5 } = {}) {
    if (Array.isArray(target)) return { x: target[0], y: target[1] };
    const box = await this.locate(target).boundingBox();
    if (!box) throw new Error(`nothing to point at: ${target}`);
    return { x: box.x + box.width * dx, y: box.y + box.height * dy };
  }

  async moveTo(target, { ms = 700, ...at } = {}) {
    const { x, y } = await this.point(target, at);
    const x0 = this.x, y0 = this.y, start = Date.now();
    for (;;) {
      const t = Math.min((Date.now() - start) / ms, 1);
      const k = ease(t);
      this.x = x0 + (x - x0) * k;
      this.y = y0 + (y - y0) * k;
      await this.page.mouse.move(this.x, this.y);
      if (t >= 1) break;
      await sleep(10);
    }
  }

  async click(target, opts = {}) {
    await this.moveTo(target, opts);
    await sleep(160);
    await this.page.mouse.down();
    await sleep(80);
    await this.page.mouse.up();
  }

  /** Eased scroll of the document (or a container), independent of the wheel. */
  async scrollBy(dy, { ms = 1100, container } = {}) {
    await this.page.evaluate(async ({ dy, ms, container }) => {
      const el = container ? document.querySelector(container) : document.scrollingElement;
      const from = el.scrollTop;
      const to = Math.max(0, Math.min(from + dy, el.scrollHeight - el.clientHeight));
      const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
      el.style.scrollBehavior = "auto";
      const start = performance.now();
      await new Promise((done) => {
        const step = (now) => {
          const t = Math.min((now - start) / ms, 1);
          el.scrollTop = from + (to - from) * ease(t);
          if (t < 1) requestAnimationFrame(step); else done();
        };
        requestAnimationFrame(step);
      });
    }, { dy, ms, container });
  }

  /** Scrolls so the target's top sits `top` pixels below the viewport's. */
  async scrollTo(target, { top = 120, ...opts } = {}) {
    const box = await this.locate(target).boundingBox();
    if (!box) throw new Error(`nothing to scroll to: ${target}`);
    await this.scrollBy(box.y - top, opts);
  }

  async type(text, { delay = 60 } = {}) {
    for (const ch of text) {
      await this.page.keyboard.type(ch);
      await sleep(delay + Math.random() * 45);
    }
  }

  async key(key) {
    await this.page.keyboard.press(key);
  }

  // ---- on-screen text (lib/overlay.mjs) ----

  async caption(card) {
    await this.page.evaluate((c) => window.__film?.caption(c), card);
  }

  async hideCaption() {
    await this.page.evaluate(() => window.__film?.hideCaption()).catch(() => {});
  }

  /** Spotlights one element, with an optional note pinned to it. */
  async focus(target, opts = {}) {
    await this.locate(target).evaluate((el) => {
      document.querySelectorAll("[data-film-focus]").forEach((e) => e.removeAttribute("data-film-focus"));
      el.setAttribute("data-film-focus", "");
    });
    await this.page.evaluate((o) => window.__film?.focus(o), opts);
  }

  async unfocus() {
    await this.page.evaluate(() => window.__film?.unfocus()).catch(() => {});
  }
}
