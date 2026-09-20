// The film narrated in Arabic, with the camera spotlighting what is being said.
//
// `say` is fully vowelled so the voice cannot guess: every letter carries its
// haraka and case endings are written out. The last letter before a pause (a
// comma, colon or full stop) is left unmarked and the voice stops on it by
// itself; a written sukun there made it swallow the suffix (مَصَادِرِكْ came out
// مَصَادِر). No phrase ends on ة: unmarked it is swallowed (وَاحِدَة → وَاحِد),
// with sukun it is read as ت. Imperatives that could pass for past tense
// (اطَّلِعْ) and أين, which the voice lifts into a question, are avoided. The brand is always كُورْبَسْ. Captions drop every mark
// (lib/captions.mjs), and a `|` breaks a long phrase into two captions where the
// sense breaks, which the voice never sees. Check a change with:  node pronounce.mjs
//
// A scene lasts as long as its narration plus a breath either side, or `min`.

export const TITLE = "corpus-tour-ar-narrated";
export const BASE = process.env.FILM_URL ?? "http://127.0.0.1:5410";
export const VOICE = process.env.FILM_VOICE ?? "ar-SA-HamedNeural";
export const RATE = process.env.FILM_RATE ?? "+4%";

// An entry that still carries verification flags, contradictions and a long history.
const ENTRY = 17112;

const card = (body) => `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
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
</style></head><body><div class="stage">${body}</div></body></html>`;

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
    min: 7,
    ...rollCard,
    card: card(`<div class="mark">Corpus</div><h1>كوربس</h1>
      <p class="l1">موسوعة بحثية تنمو مع مصادرك</p><p class="l2">وغرفة أخبار تتابع ما يهمّك</p>
      <div class="chips"><span>كل جملة موثّقة</span><span>مداخل تتجدّد مع مصادرك</span><span>موجز كل صباح</span><span>مكتبتك على جهازك</span></div>`),
    say: "هَذَا كُورْبَسْ: مَوْسُوعَةٌ بَحْثِيَّةٌ تَنْمُو مَعَ مَصَادِرِك، وَغُرْفَةُ أَخْبَارٍ تُتَابِعُ مَا يَهُمُّك.",
  },
  {
    id: "library",
    url: "/",
    say: "أَضِفِ الْكُتُبَ وَالْأَبْحَاثَ وَالْمَقَالَاتِ وَالتَّسْجِيلَات. يَقْرَأُ كُورْبَسْ كُلَّ مَصْدَرٍ مَرَّةً وَاحِدَةً فَقَط، وَيَسْتَخْرِجُ مِنْهُ الْأَشْخَاصَ وَالْمُنَظَّمَاتِ وَالْمُؤَسَّسَاتِ وَالْأَحْدَاثَ وَالْأَمَاكِن.",
    async run(cam, page, s) {
      await cam.wait(0.6);
      const stats = page.getByText("Entities", { exact: true }).locator("xpath=../..");
      await cam.moveTo(page.getByText("Entities", { exact: true }), { ms: 1000 });
      await cam.until(at(s, 0.38));
      await cam.focus(stats, { pad: 14 });
      await cam.moveTo(page.getByText("Passages", { exact: true }), { ms: 600 });
      await cam.until(at(s, 0.62));
      await cam.unfocus();
      // Stops at the first two shelves; a badly named PDF sits further down.
      await cam.scrollTo(page.getByRole("heading", { name: /Books & documents/ }), { top: 70, ms: 1800 });
      await cam.moveTo([700, 520], { ms: 1200 });
    },
  },
  {
    id: "pedia",
    url: "/pedia",
    // Not every name: only those mentioned often enough get an entry.
    say: "وَلِلْأَسْمَاءِ الْأَكْثَرِ وُرُودًا مَدَاخِلُ مَوْسُوعِيَّةٌ تُكْتَبُ مِنْ مَصَادِرِكَ وَحْدَهَا، وَبِجَانِبِ كُلِّ مَدْخَلٍ عَدَدُ اقْتِبَاسَاتِهِ وَمَصَادِرِه.",
    async prep(page) {
      await page.evaluate(() => scrollTo(0, 560));
    },
    async run(cam, page, s) {
      await cam.wait(0.5);
      const row = (name) => page.getByText(name, { exact: true }).first().locator("xpath=ancestor::*[self::a or self::li][1]");
      await cam.moveTo(row("United States of America"), { ms: 900, dx: 0.3 });
      await cam.focus(row("United States of America"), { pad: 6 });
      await cam.until(at(s, 0.55));
      await cam.moveTo(page.getByText(/^\d+ quotes$/).first(), { ms: 900 });
      await cam.until(at(s, 0.72));
      await cam.focus(row("Donald Trump"), { pad: 6 });
      await cam.moveTo(page.getByText(/^\d+ quotes$/).nth(1), { ms: 700 });
    },
  },
  {
    id: "entry",
    url: `/pedia/${ENTRY}`,
    say: "كُلُّ جُمْلَةٍ فِي الْمَدْخَلِ | تَسْتَنِدُ إِلَى اقْتِبَاسٍ حَرْفِيٍّ مِنْ مَصْدَرِهَا. انْقُرْ عَلَى الرَّقْمِ بِجَانِبِهَا، فَيَظْهَرُ لَكَ النَّصُّ كَمَا وَرَد. وَيُرَاجِعُ كُورْبَسْ كُلَّ جُمْلَةٍ عَلَى شَوَاهِدِهَا، وَيُنَبِّهُكَ إِلَى مَا لَا سَنَدَ لَهُ فِيهَا.",
    async run(cam, page, s) {
      await cam.wait(0.6);
      // A book citation with a plain, factual quote, below the summary box and the flags.
      const marker = page.locator("button.align-super").first();
      await cam.moveTo(marker, { ms: 1100 });
      await cam.until(at(s, 0.24));
      await cam.click(marker, { ms: 150 });
      await cam.wait(0.5);
      await cam.focus(page.getByRole("dialog"), { pad: 8 });
      await cam.until(at(s, 0.52));
      await cam.unfocus();
      await cam.key("Escape");
      if (await page.getByRole("dialog").count()) await cam.click([120, 720], { ms: 700 });
      const flags = page.getByText(/not fully borne out/).first();
      await cam.click(flags, { ms: 900 });
      await cam.wait(0.5);
      await cam.focus(page.locator("details").first(), { pad: 6, side: "bottom" });
    },
  },
  {
    id: "history",
    url: `/pedia/${ENTRY}?tab=history`,
    // تنقيح for a revision: مراجعة is already the verify pass in the scene before.
    say: "وَحِينَ يَصِلُ مَصْدَرٌ جَدِيد، تُعَادُ كِتَابَةُ الْمَدَاخِلِ الْمُتَعَلِّقَةِ بِه، وَيُسَجَّلُ مَا تَغَيَّرَ مَعَ كُلِّ تَنْقِيح. وَإِذَا تَعَارَضَ مَصْدَرَان، بَقِيَتِ الرِّوَايَتَانِ مَعًا بِشَوَاهِدِهِمَا، وَلَا يُحْسَمُ الْخِلَافُ نِيَابَةً عَنْك.",
    async run(cam, page, s) {
      await cam.wait(0.5);
      await cam.focus(page.getByRole("heading", { name: "Revisions" }).locator("xpath=.."), { pad: 6 });
      await cam.moveTo(page.locator("text=Revised").first(), { ms: 1000 });
      await cam.wait(0.8);
      await cam.moveTo(page.locator("text=Revised").nth(2), { ms: 1200 });
      await cam.until(at(s, 0.46));
      await cam.unfocus();
      // Disagreements live at the foot of the Entry tab.
      await cam.click(page.getByText("Entry", { exact: true }).first(), { ms: 900 });
      await cam.wait(0.5);
      await cam.scrollTo(page.getByText("Where sources disagree", { exact: true }), { top: 90, ms: 1500 });
      const disagree = page.getByRole("heading", { name: "Where sources disagree" }).locator("xpath=..");
      await cam.focus(disagree, { pad: 6 });
      await cam.moveTo(disagree, { ms: 900, dx: 0.45, dy: 0.35 });
    },
  },
  {
    id: "network",
    url: "/network",
    say: "وَتَرْسُمُ الشَّبَكَةُ كُلَّ صِلَةٍ سَجَّلَتْهَا مَصَادِرُك: مِنَ الْقَرَابَةِ وَالْمَنَاصِب، إِلَى التَّحَالُفَاتِ وَالنِّزَاعَات.",
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
      await cam.moveTo([1000, 600], { ms: 1300 });
    },
  },
  {
    id: "inbox",
    url: "/inbox",
    // "Yet": fetching costs nothing, keeping an item is what starts the reading.
    say: "أَمَّا الْأَخْبَار، فَتَصِلُ مِنَ الْخُلَاصَاتِ الَّتِي تَشْتَرِكُ فِيهَا | إِلَى صُنْدُوقِ الْوَارِدِ | دُونَ أَنْ تُكَلِّفَكَ شَيْئًا بَعْد. وَيُخْبِرُكَ كُورْبَسْ فَوْرًا | هَلْ وَصَلَ مِنَ الْمَقَالِ مَا يَكْفِي لِقِرَاءَتِه، ثُمَّ تُقَرِّرُ أَنْتَ مَا تَحْتَفِظُ بِه.",
    async run(cam, page, s) {
      await cam.wait(0.6);
      await cam.moveTo(page.getByText(/^Inbox$/).first(), { ms: 900 });
      await cam.until(at(s, 0.4));
      const verdict = () => page.getByText(/Too little to be an article|Enough to read|only the feed/).first();
      await cam.moveTo(verdict(), { ms: 900, dx: 0.3 });
      await cam.focus(verdict(), { pad: 8 });
      await cam.until(at(s, 0.62));
      await cam.unfocus();
      await cam.key("j");
      await cam.wait(1.0);
      await cam.moveTo(verdict(), { ms: 700, dx: 0.3 });
      await cam.until(at(s, 0.8));
      // Pointed at, never pressed: keeping an item would start the reading.
      await cam.moveTo(verdict().locator("xpath=following::button[1]"), { ms: 800 });
    },
  },
  {
    id: "stories",
    url: "/stories/103",
    // The brand before a preposition: "كُورْبَسْ تَغْطِيَاتِ" ran together into قُرْبَ التَّغْطِيَة.
    say: "وَيَجْمَعُ كُورْبَسْ فِي قِصَّةٍ وَاحِدَةٍ | مَا نَشَرَتْهُ وَسَائِلُ الْإِعْلَامِ الْمُخْتَلِفَةُ | عَنِ الْحَدَثِ نَفْسِه، مَعَ الْأَشْخَاصِ وَالْجِهَاتِ الَّتِي يَدُورُ حَوْلَهَا الْخَبَر.",
    async run(cam, page, s) {
      await cam.wait(0.5);
      const accounts = page.getByRole("heading", { name: "Accounts" }).locator("xpath=following-sibling::*[1]");
      await cam.moveTo(accounts, { ms: 1000, dx: 0.35 });
      await cam.focus(accounts, { pad: 8 });
      await cam.until(at(s, 0.6));
      const about = page.getByRole("heading", { name: "Who and what it is about" }).locator("xpath=following-sibling::*[1]");
      await cam.focus(about, { pad: 8 });
      await cam.moveTo(about, { ms: 900, dx: 0.3 });
    },
  },
  {
    id: "brief",
    url: "/brief",
    // No أين: the voice lifts it into a question. يَكْتُبُ, not يُعِدُّ, which it read as passive.
    say: "وَكُلَّ صَبَاح، يَكْتُبُ لَكَ كُورْبَسْ مُوجَزًا | بِمَا وَصَلَ عَنِ الْمَوْضُوعَاتِ الَّتِي تُتَابِعُهَا، يَذْكُرُ فِيهِ وَسَائِلَ الْإِعْلَامِ الَّتِي نَقَلَتْهُ | وَمَوَاضِعَ اخْتِلَافِ الرِّوَايَات. وَكُلُّ سَطْرٍ مِنْهُ يَفْتَحُ لَكَ الْمَقْطَعَ الَّذِي يَسْتَنِدُ إِلَيْه.",
    async run(cam, page, s) {
      await cam.wait(0.6);
      const watching = page.getByText("Watching:", { exact: true }).locator("xpath=..");
      await cam.moveTo(watching, { ms: 1000, dx: 0.2 });
      await cam.focus(watching, { pad: 8 });
      await cam.until(at(s, 0.42));
      await cam.unfocus();
      await cam.scrollBy(420, { ms: 1500 });
      await cam.until(at(s, 0.7));
      const marker = page.locator("button.align-super").nth(1);
      await cam.click(marker, { ms: 1000 });
      await cam.wait(0.5);
      await cam.focus(page.getByRole("dialog"), { pad: 8 });
    },
  },
  {
    id: "calendar",
    url: "/calendar",
    // "What happens on it", so it cannot be heard as what was published that day.
    say: "وَيُدْرِجُ التَّقْوِيمُ فِي كُلِّ يَوْمٍ مَا يَقَعُ فِيهِ بِحَسَبِ الْمَصَادِر: الِانْتِخَابَاتِ وَالْأَحْكَامَ الْقَضَائِيَّةَ وَالْمَوَاعِيدَ النِّهَائِيَّةَ وَذِكْرَى الْأَحْدَاث. وَإِلَى جَانِبِهِ قَائِمَةٌ بِمَا هُوَ قَادِم.",
    async run(cam, page, s) {
      await cam.wait(0.6);
      await cam.moveTo(page.getByText("September 2026", { exact: true }), { ms: 900 });
      await cam.until(at(s, 0.25));
      await cam.moveTo([900, 560], { ms: 1400 });
      await cam.until(at(s, 0.72));
      const nextUp = page.getByRole("heading", { name: "Next up" }).locator("xpath=..");
      await cam.focus(nextUp, { pad: 6, side: "bottom" });
      await cam.moveTo(page.getByText(/anniversary/).first(), { ms: 1000 });
    },
  },
  {
    id: "write",
    url: "/write?draft=5",
    say: "وَحِينَ تَكْتُب، تَبْقَى الِاقْتِبَاسَاتُ الَّتِي جَمَعْتَهَا إِلَى جَانِبِ مُسَوَّدَتِك، مُوَثَّقَةً بِمَصَادِرِهَا وَصَفَحَاتِهَا، جَاهِزَةً لِلْإِدْرَاجِ أَوِ الِاسْتِشْهَاد.",
    async run(cam, page, s) {
      await cam.wait(0.6);
      await cam.moveTo([760, 520], { ms: 1000 });
      await cam.until(at(s, 0.3));
      await cam.focus(page.getByText(/^gathered$/i).locator("xpath=.."), { pad: 4 });
      const more = page.getByText(/^Show all \(\d+ words\)$/).first();
      await cam.moveTo(more, { ms: 1000 });
      await cam.click(more, { ms: 100 });
      await cam.wait(0.8);
      await cam.moveTo(page.getByText("Insert", { exact: true }).first(), { ms: 800 });
      await cam.until(at(s, 0.8));
      await cam.unfocus();
      await cam.moveTo(page.getByText("Cite from library", { exact: true }), { ms: 900 });
    },
  },
  {
    id: "search",
    url: "/search",
    say: "وَابْحَثْ فِي النُّصُوصِ الْكَامِلَةِ لِكُلِّ مَصَادِرِكَ وَمَدَاخِلِك، لِتَرَى كُلَّ نَتِيجَةٍ فِي سِيَاقِهَا.",
    async run(cam, page) {
      await cam.wait(0.4);
      await cam.click(page.getByPlaceholder(/A name, a phrase/), { ms: 900 });
      await cam.type("Strait of Hormuz", { delay: 40 });
      await cam.click(page.getByRole("button", { name: "Search" }), { ms: 600 });
      await cam.wait(1.0);
      await cam.scrollBy(380, { ms: 1100 });
      await cam.focus(page.getByRole("heading", { name: "In entries" }).locator("xpath=following-sibling::*[1]"), { pad: 6 });
    },
  },
  {
    id: "settings",
    url: "/settings",
    // A service per stage, not one service for everything.
    say: "وَتَبْقَى مَكْتَبَتُكَ وَمَفَاتِيحُ الْوُصُولِ عَلَى جِهَازِك، وَأَنْتَ تَخْتَارُ لِكُلِّ مَرْحَلَةٍ مِنَ الْعَمَلِ خِدْمَةَ الذَّكَاءِ الِاصْطِنَاعِيِّ الَّتِي تَتَوَلَّاهَا.",
    async run(cam, page, s) {
      await cam.wait(0.6);
      await cam.moveTo(page.getByText("API keys", { exact: true }), { ms: 900 });
      await cam.focus(page.getByRole("heading", { name: "API keys" }).locator("xpath=.."), { pad: 6 });
      await cam.until(at(s, 0.4));
      await cam.unfocus();
      await cam.scrollTo(page.getByText("Who does what", { exact: true }), { top: 80, ms: 1400 });
      await cam.focus(page.getByRole("heading", { name: "Who does what" }).locator("xpath=.."), { pad: 6 });
      await cam.moveTo(page.getByText("Writing entries", { exact: true }), { ms: 900 });
    },
  },
  {
    id: "outro",
    min: 7,
    ...rollCard,
    card: card(`<div class="mark">Corpus</div><h1>كوربس</h1>
      <p class="l1">مكتبتك، وقد صارت موسوعة وغرفة أخبار</p><div class="rule"></div>
      <p class="small">مكتبتك على جهازك · كل جملة تستند إلى مصادرك</p>`),
    // Never opening on the brand: sentence-first, كُورْبَسْ was heard as قُرْبُص.
    say: "مَعَ كُورْبَسْ، تَصِيرُ مَكْتَبَتُكَ مَوْسُوعَةً وَغُرْفَةَ أَخْبَار.",
  },
];
