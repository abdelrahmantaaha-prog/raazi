// The film told in on-screen Arabic, no narration. Each scene opens a chapter
// card, then spotlights the part of the page the card is talking about.
// Times are seconds into the scene; `min` is how long the scene runs.

export const TITLE = "corpus-tour-ar-text";
export const BASE = process.env.FILM_URL ?? "http://127.0.0.1:5410";

const TOTAL = 12;
const chapter = (step, kicker, title, body, pos = "br") => ({ step, total: TOTAL, kicker, title, body, pos });

const card = (body, extraCss = "") => `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<style>
  #__film_cursor, #__film_ring, #__film_overlay { display: none !important; }
  html, body { margin: 0; height: 100%; overflow: hidden; }
  body { display: grid; place-items: center; color: #24170e; font-family: "Noto Sans Arabic", sans-serif;
         background: radial-gradient(1100px 680px at 65% 30%, #fffaf3 0%, #f6efe5 55%, #ece1d3 100%); }
  .stage { text-align: center; }
  .mark { font: 700 30px/1 Georgia, serif; color: #8a5530; letter-spacing: 7px; text-transform: uppercase; direction: ltr; opacity: 0; }
  h1 { font: 700 176px/1.2 "Amiri", serif; margin: 10px 0 0; clip-path: inset(0 0 0 100%); }
  .l1 { font: 500 46px/1.6 "Noto Naskh Arabic", serif; color: #4a3526; margin: 6px 0 0; opacity: 0; }
  .l2 { font: 500 38px/1.6 "Noto Naskh Arabic", serif; color: #7a5a44; margin: 2px 0 0; opacity: 0; }
  .chips { display: flex; gap: 16px; justify-content: center; margin-top: 46px; }
  .chips span { font: 700 23px/1.4 "Noto Kufi Arabic", sans-serif; color: #6d4326; background: #fffdf9;
                border: 1px solid #e6d5c3; border-radius: 999px; padding: 10px 26px 12px;
                box-shadow: 0 8px 22px rgba(90, 55, 30, .08); opacity: 0; transform: translateY(14px); }
  .rule { width: 0; height: 3px; background: #8a5530; margin: 36px auto 0; }
  .small { font: 700 24px/1.5 "Noto Kufi Arabic", sans-serif; color: #8a5530; margin-top: 26px; opacity: 0; }
  .go .mark { animation: fade .8s ease .1s forwards; }
  .go h1 { animation: wipe 1.1s cubic-bezier(.7, 0, .2, 1) .35s forwards; }
  .go .l1 { animation: rise .8s ease 1.3s forwards; }
  .go .l2 { animation: rise .8s ease 1.75s forwards; }
  .go .rule { animation: grow 1s ease-out 1.8s forwards; }
  .go .small { animation: rise .8s ease 2.3s forwards; }
  .go .chips span { animation: rise .6s cubic-bezier(.2, .8, .2, 1) forwards; }
  .go .chips span:nth-child(1) { animation-delay: 2.5s; }
  .go .chips span:nth-child(2) { animation-delay: 2.7s; }
  .go .chips span:nth-child(3) { animation-delay: 2.9s; }
  .go .chips span:nth-child(4) { animation-delay: 3.1s; }
  @keyframes fade { to { opacity: 1; } }
  @keyframes rise { from { opacity: 0; transform: translateY(18px); } to { opacity: 1; transform: none; } }
  @keyframes wipe { to { clip-path: inset(0 0 0 0); } }
  @keyframes grow { to { width: 240px; } }
  ${extraCss}
</style></head><body><div class="stage">${body}</div></body></html>`;

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
    min: 6.5,
    ...rollCard,
    card: card(`<div class="mark">Raazi</div><h1>الرازي</h1>
      <p class="l1">موسوعة بحثية تنمو مع مصادرك</p><p class="l2">وغرفة أخبار تراقب ما يهمّك</p>
      <div class="chips"><span>توثيق كل جملة</span><span>مراجعة مع كل مصدر</span><span>موجز كل صباح</span><span>على جهازك</span></div>`),
  },
  {
    id: "library",
    url: "/",
    min: 10,
    async run(cam, page) {
      await cam.wait(0.3);
      await cam.caption(chapter(1, "المكتبة", "أضِف مصادرك مرة واحدة",
        "كتب وأبحاث ومقالات وتسجيلات؛ يقرؤها الرازي ويستخرج منها الأشخاص والمؤسسات والأحداث والأماكن."));
      const stats = page.getByText("Entities", { exact: true }).locator("xpath=../..");
      await cam.moveTo(stats, { ms: 1000 });
      await cam.focus(stats, { note: "كل ما استُخرج من مكتبتك", pad: 14, side: "bottom" });
      await cam.until(4.8);
      await cam.unfocus();
      // Stops at the first two shelves; a badly named PDF sits further down.
      await cam.scrollTo(page.getByRole("heading", { name: /Books & documents/ }), { top: 70, ms: 1800 });
      await cam.moveTo([700, 520], { ms: 1200 });
    },
  },
  {
    id: "pedia",
    url: "/pedia",
    min: 6.5,
    async prep(page) {
      await page.evaluate(() => scrollTo(0, 560));
    },
    async run(cam, page) {
      await cam.wait(0.3);
      await cam.caption(chapter(2, "الموسوعة", "مدخلٌ لكل اسم",
        "كل مدخل يُكتب من مصادرك وحدها، ومعه عدد الاقتباسات والمصادر التي يستند إليها."));
      const row = page.getByText("United States", { exact: true }).first().locator("xpath=ancestor::*[self::a or self::li][1]");
      await cam.moveTo(row, { ms: 900, dx: 0.3 });
      await cam.focus(row, { note: "151 اقتباسًا من 35 مصدرًا", pad: 6 });
    },
  },
  {
    id: "entry",
    url: "/pedia/20336",
    min: 14,
    async prep(page) {
      await page.evaluate(() => scrollTo(0, 330));
    },
    async run(cam, page) {
      await cam.wait(0.3);
      await cam.caption(chapter(3, "التوثيق", "كل جملة تعود إلى نصّها",
        "انقر رقم الإحالة، فيظهر الاقتباس الحرفي من المصدر الذي تستند إليه الجملة.", "bl"));
      const marker = page.locator("button.align-super").first();
      await cam.moveTo(marker, { ms: 1100 });
      await cam.until(2.4);
      await cam.click(marker, { ms: 120 });
      await cam.wait(0.5);
      await cam.focus(page.getByRole("dialog"), { note: "الاقتباس كما ورد في المصدر", pad: 8 });
      await cam.until(7.0);
      await cam.unfocus();
      await cam.key("Escape");
      // Close on blank sidebar, not the page: the verification banner sits under the top of the viewport.
      if (await page.getByRole("dialog").count()) await cam.click([120, 720], { ms: 700 });
      await cam.scrollBy(-400, { ms: 900 });
      await cam.caption(chapter(3, "التحقّق", "وما لا تسنده الشواهد، يُعلَّم",
        "يعيد الرازي قراءة كل جملة مقابل مصادرها، ويشير إلى ما لا تحمله منها.", "bl"));
      await cam.click(page.getByText(/not fully borne out/).first(), { ms: 800 });
      await cam.wait(0.4);
      await cam.focus(page.locator("details").first(), { note: "جملتان بلا سند كافٍ", pad: 6, side: "bottom" });
    },
  },
  {
    id: "history",
    url: "/pedia/20336?tab=history",
    min: 12,
    async run(cam, page) {
      await cam.wait(0.3);
      await cam.caption(chapter(4, "المراجعة", "المدخل يتجدّد مع كل مصدر",
        "كل مراجعة تذكر المقال الذي دفع إليها، وما الذي تغيّر، والنموذج الذي كتبها."));
      const revisions = page.getByRole("heading", { name: "Revisions" }).locator("xpath=..");
      await cam.focus(revisions, { note: "5 مراجعات حتى الآن", pad: 6 });
      await cam.moveTo(page.locator("text=Revised").first(), { ms: 1000 });
      await cam.wait(0.8);
      await cam.moveTo(page.locator("text=Revised").nth(2), { ms: 1200 });
      await cam.until(5.8);
      await cam.unfocus();
      await cam.click(page.getByText("Entry", { exact: true }).first(), { ms: 900 });
      await cam.wait(0.5);
      await cam.scrollTo(page.getByText("Where sources disagree", { exact: true }), { top: 90, ms: 1500 });
      await cam.caption(chapter(4, "الخلاف", "حين تختلف المصادر",
        "تُحفظ الروايتان معًا بشواهدهما، ولا يُحسم الخلاف نيابةً عنك."));
      const disagree = page.getByRole("heading", { name: "Where sources disagree" }).locator("xpath=..");
      await cam.focus(disagree, { note: "3 روايات متعارضة", pad: 6 });
      await cam.moveTo(disagree, { ms: 900, dx: 0.45, dy: 0.4 });
    },
  },
  {
    id: "network",
    url: "/network",
    min: 6.5,
    async prep(page) {
      await page.evaluate(() => scrollTo(0, 470));
    },
    async run(cam, page) {
      await cam.wait(0.3);
      await cam.caption(chapter(5, "الشبكة", "كل الصلات في خريطة واحدة",
        "قرابة ومناصب وتحالفات ونزاعات، مرسومة كما سجّلتها مصادرك."));
      const zoomOut = page.getByRole("button").filter({ hasText: /^\s*[−–-]\s*$/ }).first();
      await cam.click(zoomOut, { ms: 900 });
      await cam.wait(0.5);
      await cam.click(zoomOut, { ms: 200 });
      await cam.wait(0.6);
      await cam.moveTo([900, 560], { ms: 1300 });
    },
  },
  {
    id: "inbox",
    url: "/inbox",
    min: 11,
    // Filtered before the camera rolls: the unfiltered inbox opens on
    // Federal Register items that are only a scraping-block notice.
    async prep(page) {
      await page.getByRole("button", { name: /The Washington Post/ }).first().click();
      await page.waitForTimeout(1500);
    },
    async run(cam, page) {
      await cam.wait(0.3);
      await cam.caption(chapter(6, "غرفة الأخبار", "صندوق وارد لا يكلّف شيئًا",
        "تصل المقالات من خلاصاتك دون أن يُستهلك أي رمز، وتقرّر أنت ما يستحق القراءة.", "bl"));
      const chip = page.getByRole("button", { name: /The Washington Post/ }).first();
      await cam.moveTo(chip, { ms: 1000 });
      await cam.focus(chip, { note: "تصفية حسب المنفذ", pad: 6 });
      await cam.until(4.6);
      await cam.unfocus();
      await cam.key("j");
      await cam.wait(1.0);
      const verdict = page.getByText(/Too little to be an article|Enough to read|only the feed/).first();
      await cam.moveTo(verdict, { ms: 1000 });
      await cam.focus(verdict, { note: "حكم فوري: هل النص كافٍ للقراءة؟", pad: 8 });
    },
  },
  {
    id: "stories",
    url: "/stories/103",
    min: 7.5,
    async run(cam, page) {
      await cam.wait(0.3);
      await cam.caption(chapter(7, "القصص", "حدث واحد، روايات عدّة",
        "تُجمع تغطيات المنافذ المختلفة للحدث نفسه في قصة واحدة، مع من وما تتناوله."));
      const accounts = page.getByRole("heading", { name: "Accounts" }).locator("xpath=following-sibling::*[1]");
      await cam.moveTo(accounts, { ms: 1000, dx: 0.35 });
      await cam.focus(accounts, { note: "5 منافذ · قصة واحدة", pad: 8 });
    },
  },
  {
    id: "brief",
    url: "/brief",
    min: 13,
    async run(cam, page) {
      await cam.wait(0.3);
      await cam.caption(chapter(8, "الموجز الصباحي", "ما يهمّك، كل صباح",
        "ملخص لما وصل عن الموضوعات التي تتابعها: من نشر الخبر، وأين تختلف الروايات."));
      const watching = page.getByText("Watching:", { exact: true }).locator("xpath=..");
      await cam.moveTo(watching, { ms: 1000, dx: 0.2 });
      await cam.focus(watching, { note: "الموضوعات التي تتابعها", pad: 8 });
      await cam.until(5.0);
      await cam.unfocus();
      await cam.scrollBy(420, { ms: 1500 });
      await cam.until(7.2);
      const marker = page.locator("button.align-super").nth(1);
      await cam.click(marker, { ms: 1000 });
      await cam.wait(0.5);
      await cam.focus(page.getByRole("dialog"), { note: "كل سطر يعود إلى مصدره", pad: 8 });
    },
  },
  {
    id: "calendar",
    url: "/calendar",
    min: 9,
    async run(cam, page) {
      await cam.wait(0.3);
      await cam.caption(chapter(9, "التقويم", "كل تاريخ تذكره المصادر",
        "انتخابات وجلسات ومواعيد نهائية وذكرى سنوية، كلٌّ في يومه من الشهر.", "bl"));
      await cam.moveTo(page.getByText("September 2026", { exact: true }), { ms: 900 });
      await cam.until(3.0);
      const nextUp = page.getByRole("heading", { name: "Next up" }).locator("xpath=..");
      await cam.focus(nextUp, { note: "ما هو قادم", pad: 6, side: "bottom" });
      await cam.moveTo(page.getByText("Next up", { exact: true }), { ms: 900 });
    },
  },
  {
    id: "write",
    url: "/write?draft=5",
    min: 9,
    async run(cam, page) {
      await cam.wait(0.3);
      await cam.caption(chapter(10, "الكتابة", "مصادرك بجانب مسودّتك",
        "اقتباسات موثّقة بالصفحة، جاهزة للإدراج في النص حين تحتاجها.", "bl"));
      await cam.moveTo([760, 520], { ms: 1000 });
      await cam.until(2.6);
      const gathered = page.getByText(/^gathered$/i).locator("xpath=..");
      await cam.focus(gathered, { note: "اقتباسات مع مواضعها", pad: 4 });
      const more = page.getByText(/^Show all \(\d+ words\)$/).first();
      await cam.moveTo(more, { ms: 1100 });
      await cam.click(more, { ms: 100 });
      await cam.wait(0.9);
      await cam.moveTo(page.getByText("Insert", { exact: true }).first(), { ms: 800 });
    },
  },
  {
    id: "search",
    url: "/search",
    min: 7.5,
    async run(cam, page) {
      await cam.wait(0.3);
      await cam.caption(chapter(11, "البحث", "في النص الكامل لكل شيء",
        "ابحث في نصوص مصادرك ومداخلك كاملة، واذهب مباشرة إلى موضع الكلمة."));
      await cam.click(page.getByPlaceholder(/A name, a phrase/), { ms: 900 });
      await cam.type("Strait of Hormuz", { delay: 40 });
      await cam.click(page.getByRole("button", { name: "Search" }), { ms: 600 });
      await cam.wait(1.0);
      await cam.scrollBy(380, { ms: 1100 });
      const results = page.getByRole("heading", { name: "In entries" }).locator("xpath=following-sibling::*[1]");
      await cam.focus(results, { note: "النتائج مع السياق", pad: 6 });
    },
  },
  {
    id: "settings",
    url: "/settings",
    min: 7.5,
    async run(cam, page) {
      await cam.wait(0.3);
      await cam.caption(chapter(12, "على جهازك", "مكتبتك تبقى عندك",
        "المصادر وقاعدة البيانات والمفاتيح على جهازك، وأنت تختار الخدمة التي تتولّى كل مهمة."));
      await cam.scrollTo(page.getByText("Who does what", { exact: true }), { top: 80, ms: 1400 });
      const routing = page.getByRole("heading", { name: "Who does what" }).locator("xpath=..");
      await cam.focus(routing, { note: "خدمة لكل مهمة", pad: 6 });
      await cam.moveTo(page.getByText("Writing entries", { exact: true }), { ms: 900 });
    },
  },
  {
    id: "outro",
    min: 6.5,
    ...rollCard,
    card: card(`<div class="mark">Raazi</div><h1>الرازي</h1>
      <p class="l1">مكتبتك، وقد صارت موسوعةً وغرفةَ أخبار</p><div class="rule"></div>
      <p class="small">يعمل على جهازك · يكتب من مصادرك وحدها</p>`),
  },
];
