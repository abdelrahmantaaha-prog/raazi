// The film, scene by scene: what the narrator says and what the camera does
// while it is said. `say` is lightly vowelled so the voice reads it right;
// the captions drop the vowels. A scene lasts as long as its narration plus a
// breath either side, or `min` seconds, whichever is longer.

export const TITLE = "corpus-tour-ar";
export const BASE = process.env.FILM_URL ?? "http://127.0.0.1:5410";
export const VOICE = process.env.FILM_VOICE ?? "ar-SA-HamedNeural";
export const RATE = process.env.FILM_RATE ?? "+8%";

const card = (body) => `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<style>
  #__film_cursor, #__film_ring { display: none !important; }
  html, body { margin: 0; height: 100%; background: #faf7f2; color: #2a1d12; overflow: hidden; }
  body { display: grid; place-items: center; font-family: "Amiri", "Noto Naskh Arabic", serif; }
  .wrap { text-align: center; }
  .mark { font-family: Georgia, "Times New Roman", serif; font-weight: 700; font-size: 38px; letter-spacing: .5px;
          color: #7b4a2a; direction: ltr; opacity: 0; }
  h1 { font-size: 150px; line-height: 1.1; margin: 18px 0 8px; font-weight: 700; opacity: 0; }
  p { font-size: 50px; line-height: 1.6; margin: 0; color: #5b4636; opacity: 0; }
  .rule { width: 0; height: 3px; background: #7b4a2a; margin: 34px auto 0; }
  /* Held until the camera is rolling: the page settles before recording starts. */
  .go .mark { animation: rise .9s ease-out .15s forwards; }
  .go h1 { animation: rise 1s ease-out .45s forwards; }
  .go p { animation: rise 1s ease-out .95s forwards; }
  .go .rule { animation: grow 1.1s ease-out 1.3s forwards; }
  @keyframes rise { from { opacity: 0; transform: translateY(26px); } to { opacity: 1; transform: none; } }
  @keyframes grow { to { width: 220px; } }
</style></head><body><div class="wrap">${body}</div></body></html>`;

const at = (s, fraction) => s.length * fraction;

const rollCard = {
  settle: 300,
  async run(cam, page) {
    await cam.wait(0.2);
    await page.evaluate(() => document.body.classList.add("go"));
  },
};

export const SCENES = [
  {
    id: "intro",
    min: 6,
    ...rollCard,
    card: card(`<div class="mark">Corpus</div><h1>كوربس</h1><p>موسوعة بحثية تنمو مع مصادرك</p><div class="rule"></div>`),
    say: "هذا كوربس: موسوعةٌ بحثيّة تنمو مع مصادرك، وغرفةُ أخبارٍ تراقب ما يهمُّك.",
  },
  {
    id: "library",
    url: "/",
    say: "أضِف الكتبَ والأبحاثَ والمقالاتِ والتسجيلات. يقرأ كوربس كلَّ مصدرٍ مرةً واحدة، ويستخرج منه الأشخاصَ والمؤسساتِ والأحداثَ والأماكن.",
    async run(cam, page, s) {
      await cam.wait(0.6);
      await cam.moveTo(page.getByText("Entities", { exact: true }), { ms: 900 });
      await cam.until(at(s, 0.35));
      await cam.moveTo(page.getByText("Passages", { exact: true }), { ms: 500 });
      await cam.until(at(s, 0.42));
      // Stops at the first two shelves; a badly named PDF sits further down.
      await cam.scrollTo(page.getByRole("heading", { name: /Books & documents/ }), { top: 70, ms: 1800 });
      await cam.moveTo([700, 520], { ms: 1200 });
    },
  },
  {
    id: "pedia",
    url: "/pedia",
    say: "ولكلٍّ منها مدخلٌ موسوعيّ، يُكتَب من مصادرك وحدها.",
    async prep(page, cam) {
      await page.evaluate(() => scrollTo(0, 560));
    },
    async run(cam, page) {
      await cam.wait(0.5);
      await cam.moveTo(page.getByText("United States", { exact: true }).first(), { ms: 900 });
      await cam.wait(0.9);
      await cam.moveTo(page.getByText("Donald Trump", { exact: true }).first(), { ms: 700 });
    },
  },
  {
    id: "entry",
    url: "/pedia/20336",
    say: "كلُّ جملةٍ في المدخل تستند إلى اقتباسٍ حرفيّ من مصدرها. انقر الرقم، فترى النصَّ نفسه. وما لا تسنده الشواهدُ كاملًا، يُنبِّهك إليه.",
    async prep(page) {
      await page.evaluate(() => scrollTo(0, 330));
    },
    async run(cam, page, s) {
      await cam.wait(0.6);
      await cam.moveTo(page.locator("button.align-super").first(), { ms: 1100 });
      await cam.until(at(s, 0.27));
      await cam.click(page.locator("button.align-super").first(), { ms: 150 });
      await cam.until(at(s, 0.6));
      await cam.key("Escape");
      // Close on blank sidebar, not the page body: after the scroll, the
      // verification banner sits under most of the top of the viewport.
      if (await page.getByRole("dialog").count()) await cam.click([120, 720], { ms: 700 });
      await cam.scrollBy(-400, { ms: 900 });
      await cam.click(page.getByText(/not fully borne out/).first(), { ms: 700 });
      await cam.wait(0.4);
      console.log(`  verify panel open: ${await page.evaluate(() => document.querySelector("details")?.open)}`);
    },
  },
  {
    id: "history",
    url: "/pedia/20336?tab=history",
    say: "وحين يصل مصدرٌ جديد، يُراجِع المدخلُ نفسَه ويُسجِّل ما تغيَّر. وإذا تعارضت المصادر، يحتفظ بالروايتين معًا.",
    async run(cam, page, s) {
      await cam.wait(0.5);
      await cam.moveTo(page.locator("text=Revised").first(), { ms: 1000 });
      await cam.wait(0.6);
      await cam.moveTo(page.locator("text=Revised").nth(2), { ms: 1200 });
      await cam.until(at(s, 0.5));
      // Disagreements live at the foot of the Entry tab.
      await cam.click(page.getByText("Entry", { exact: true }).first(), { ms: 900 });
      await cam.wait(0.5);
      await cam.scrollTo(page.getByText("Where sources disagree", { exact: true }), { top: 90, ms: 1700 });
      await cam.moveTo(page.getByText("Where sources disagree", { exact: true }), { ms: 700 });
    },
  },
  {
    id: "network",
    url: "/network",
    say: "وتظهر الصِّلاتُ بين الأشخاص والمؤسسات في شبكةٍ واحدة.",
    async prep(page) {
      await page.evaluate(() => scrollTo(0, 470));
    },
    async run(cam, page) {
      const zoomOut = page.getByRole("button").filter({ hasText: /^\s*[−–-]\s*$/ }).first();
      await cam.wait(0.4);
      await cam.click(zoomOut, { ms: 900 });
      await cam.wait(0.5);
      await cam.click(zoomOut, { ms: 200 });
      await cam.wait(0.6);
      await cam.moveTo([1100, 620], { ms: 1300 });
    },
  },
  {
    id: "inbox",
    url: "/inbox",
    say: "أمّا الأخبار، فتصل من خلاصاتك إلى صندوق الوارد دون أن تستهلك شيئًا، وأنت تقرِّر ما يستحقُّ القراءة.",
    async run(cam, page, s) {
      await cam.wait(0.6);
      await cam.click(page.getByRole("button", { name: /The Washington Post/ }).first(), { ms: 1000 });
      await cam.until(at(s, 0.45));
      await cam.key("j");
      await cam.until(at(s, 0.7));
      await cam.key("j");
    },
  },
  {
    id: "stories",
    url: "/stories/103",
    say: "وتُجمَع تغطياتُ المنافذ المختلفة للحدث الواحد في قصةٍ واحدة.",
    async run(cam, page) {
      await cam.wait(0.5);
      await cam.moveTo(page.getByText("Accounts", { exact: true }), { ms: 900 });
      await cam.wait(0.6);
      await cam.moveTo([1500, 520], { ms: 1400 });
    },
  },
  {
    id: "brief",
    url: "/brief",
    say: "وكلَّ صباح، يكتب لك موجزًا بما وصل عن الموضوعات التي تتابعها: مَن نشر الخبر، وأين تختلف الروايات. وكلُّ سطرٍ فيه يعود إلى مصدره.",
    async run(cam, page, s) {
      await cam.wait(0.8);
      await cam.moveTo(page.getByText("Watching:", { exact: true }), { ms: 900 });
      await cam.until(at(s, 0.3));
      await cam.scrollBy(420, { ms: 1500 });
      await cam.until(at(s, 0.62));
      await cam.click(page.locator("button.align-super").nth(1), { ms: 1000 });
    },
  },
  {
    id: "calendar",
    url: "/calendar",
    say: "ويُدوِّن التقويمُ كلَّ تاريخٍ تذكره المصادر: انتخاباتٍ وجلساتٍ ومواعيدَ نهائيّة ومناسباتٍ سنويّة.",
    async run(cam, page, s) {
      await cam.wait(0.6);
      await cam.moveTo(page.getByText("September 2026", { exact: true }), { ms: 900 });
      await cam.until(at(s, 0.45));
      await cam.moveTo(page.getByText("Next up", { exact: true }), { ms: 1000 });
      await cam.scrollBy(260, { ms: 1400 });
    },
  },
  {
    id: "write",
    url: "/write?draft=5",
    say: "وحين تكتب، تبقى الاقتباساتُ والمصادرُ إلى جانب مسودّتك، جاهزةً للإدراج بتوثيقها.",
    async run(cam, page, s) {
      await cam.wait(0.6);
      await cam.moveTo([760, 520], { ms: 1000 });
      await cam.until(at(s, 0.35));
      await cam.moveTo(page.getByText(/^Show all \(\d+ words\)$/).first(), { ms: 1100 });
      await cam.click(page.getByText(/^Show all \(\d+ words\)$/).first(), { ms: 100 });
      await cam.wait(0.9);
      await cam.moveTo(page.getByText("Insert", { exact: true }).first(), { ms: 800 });
    },
  },
  {
    id: "search",
    url: "/search",
    say: "وابحث في النصوص الكاملة لكلِّ مصادرك ومداخلك.",
    async run(cam, page) {
      await cam.wait(0.4);
      await cam.click(page.getByPlaceholder(/A name, a phrase/), { ms: 900 });
      await cam.type("Strait of Hormuz", { delay: 45 });
      await cam.click(page.getByRole("button", { name: "Search" }), { ms: 600 });
      await cam.wait(1.2);
      await cam.scrollBy(380, { ms: 1200 });
    },
  },
  {
    id: "settings",
    url: "/settings",
    say: "ويعمل كلُّ ذلك على جهازك، بالخدمات التي تختارها أنت.",
    async run(cam, page, s) {
      await cam.wait(0.6);
      await cam.moveTo(page.getByText("API keys", { exact: true }), { ms: 900 });
      await cam.until(at(s, 0.35));
      await cam.scrollTo(page.getByText("Who does what", { exact: true }), { top: 80, ms: 1500 });
      await cam.moveTo(page.getByText("Writing entries", { exact: true }), { ms: 900 });
    },
  },
  {
    id: "outro",
    min: 6,
    ...rollCard,
    card: card(`<div class="mark">Corpus</div><h1>كوربس</h1><p>مكتبتك، وقد صارت موسوعةً وغرفةَ أخبار</p><div class="rule"></div>`),
    say: "كوربس: مكتبتُك، وقد صارت موسوعةً وغرفةَ أخبار.",
  },
];
