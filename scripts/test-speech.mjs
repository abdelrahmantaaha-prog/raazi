/**
 * Reading a book out loud.
 *
 * The parts worth testing are the ones that are wrong by default. A paragraph
 * handed to the browser whole gets cut off mid-sentence after about fifteen
 * seconds; an English voice handed Arabic produces noise; and `cancel()` fires
 * the same `onend` as a natural finish, so stopping playback advances the book
 * past a paragraph you never heard. Each of those has a test here, against a
 * stand-in synthesiser rather than a real one.
 *
 *   node scripts/test-speech.mjs
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) {
    passed++;
    console.log(`  ok    ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
};
const section = (t) => console.log(`\n${t}`);

const {
  sentences,
  langOf,
  pickVoice,
  groupVoices,
  Speaker,
  OnlineSpeaker,
  RATES,
  maxChars,
  naturalVoice,
  isNatural,
} = await import("../lib/speech.ts");

/* ------------------------------------------------------------- a fake mouth */

/**
 * Stands in for the browser's synthesiser, queue and all.
 *
 * Nothing finishes on its own: an utterance ends only when the test says so,
 * via `tick()`. That is the whole point of it. The first version completed each
 * utterance on a microtask, which looked more realistic and tested less than
 * nothing — the entire paragraph finished before the test could call stop(), so
 * the cases about interrupting playback were passing without ever interrupting
 * anything.
 *
 * It holds a queue rather than a single live utterance because that is what the
 * real one does, and because handing the whole paragraph over at once is what
 * removes the seam between sentences. A stand-in that could only hold one
 * utterance would quietly discard the rest and prove nothing.
 */
function fakeSynth() {
  const spoken = [];
  let cancelled = 0;
  let paused = 0;
  let resumed = 0;
  const queue = [];
  const synth = {
    speak(u) {
      spoken.push({ text: u.text, lang: u.lang, rate: u.rate, voice: u.voice?.name ?? null });
      queue.push(u);
    },
    cancel() {
      cancelled++;
      const dropped = queue.splice(0, queue.length);
      // The real API fires onend for what it kills, and this models it at its
      // worst: every discarded utterance reports an ending. That is exactly
      // what would run a tally of endings to its total and report a paragraph
      // finished that nobody heard.
      //
      // Fired asynchronously, because that is what a browser does — these are
      // dispatched events, not direct calls — and because firing them
      // synchronously is what made an earlier version of this file useless.
      // Cancelling and immediately speaking again is the ordinary case of
      // turning a page: dispatched late, the dead paragraph's endings arrive
      // *after* the new one has installed its callback, and land on it. Fired
      // synchronously they arrived while the callback was still null and hit
      // nothing, so the test passed with the guard taken out.
      for (const u of dropped) setTimeout(() => u.onend?.(), 0);
    },
    pause() {
      paused++;
    },
    resume() {
      resumed++;
    },
  };
  return {
    synth,
    spoken,
    cancels: () => cancelled,
    pauses: () => paused,
    resumes: () => resumed,
    /** Lets the utterance at the head of the queue finish. */
    tick() {
      queue.shift()?.onend?.();
    },
    /** Lets it fail instead. */
    fail() {
      queue.shift()?.onerror?.();
    },
    /** Handed over but not yet spoken. */
    pending: () => queue.length,
    speaking: () => queue.length > 0,
  };
}

/**
 * Three sentences long enough that the packer cannot fold them into one
 * utterance — which is what it correctly does with short ones, and what made
 * the first draft of these tests assert the wrong number.
 */
function longParagraph(...tails) {
  // Each sentence has to land in a narrow band. Above half the ceiling, or two
  // of them are quite correctly folded into one utterance and the count is not
  // what the test expects; above the ceiling itself and each is broken in two
  // instead. Roughly 130 characters sits between those, at every rate these
  // tests use. That band is not a bug — it is why fewer, longer utterances
  // sound better than one per sentence.
  const filler =
    "A sentence long enough that it will not share an utterance with its neighbour, " +
    "yet stays inside the ceiling on its own";
  return tails.map((t) => `${filler}, ${t}.`).join(" ");
}

globalThis.SpeechSynthesisUtterance = class {
  constructor(text) {
    this.text = text;
    this.onend = null;
    this.onerror = null;
  }
};

const settle = () => new Promise((r) => setTimeout(r, 0));

/* ------------------------------------------------------------------ cutting */

section("Breaking a paragraph into speakable pieces");
{
  check("nothing from nothing", sentences("").length === 0);
  check("whitespace is nothing", sentences("   \n  ").length === 0);

  const three = sentences("One thing happened. Then another. And a third.", 20);
  check("it splits on sentence ends", three.length === 3, JSON.stringify(three));
  check("punctuation stays with its sentence", three[0] === "One thing happened.");

  const joined = sentences("A. B. C. D.", 200);
  check("short sentences are packed together, not sent one by one", joined.length === 1, JSON.stringify(joined));

  const long = "word ".repeat(200).trim();
  const pieces = sentences(long, 100);
  check("a sentence longer than the ceiling is broken up", pieces.length > 1);
  check("every piece is within the ceiling", pieces.every((p) => p.length <= 100), JSON.stringify(pieces.map((p) => p.length)));
  check(
    "and never mid-word",
    pieces.every((p) => !p.startsWith("ord") && !p.endsWith("wo")),
    JSON.stringify(pieces.slice(0, 3))
  );
  check(
    "the words all survive",
    pieces.join(" ").split(/\s+/).length === long.split(/\s+/).length,
    `${pieces.join(" ").split(/\s+/).length} vs ${long.split(/\s+/).length}`
  );

  // Long enough that packing cannot recombine them, which is what makes this a
  // test of the terminators rather than of the packer.
  const arabic = sentences(
    "ذهب الملك عبد العزيز إلى مدينة الرياض في فصل الشتاء. " +
      "ثم عاد إلى مكة المكرمة بعد أسبوعين من ذلك اليوم؟ " +
      "نعم هذا صحيح تماما بلا أدنى شك على الإطلاق.",
    60
  );
  check("Arabic sentences are split apart", arabic.length === 3, JSON.stringify(arabic));
  check(
    "the Arabic question mark ends a sentence",
    arabic.some((p) => p.trim().endsWith("؟")),
    JSON.stringify(arabic)
  );

  check(
    "a paragraph with no full stop at all still gets spoken",
    sentences("a paragraph with no terminal punctuation at all").length === 1
  );
}

/* ------------------------------------------------------------------ voices */

section("Knowing what language a paragraph is in");
{
  check("English", langOf("The king returned to Riyadh in 1932.") === "en");
  check("Arabic", langOf("عاد الملك إلى الرياض عام ١٩٣٢.") === "ar");
  check(
    "Arabic with Latin numerals and a stray English name",
    langOf("عاد الملك عبد العزيز إلى الرياض عام 1932 بعد لقاء Bechtel.") === "ar"
  );
  check("empty text defaults to English rather than throwing", langOf("") === "en");
}

section("Picking a voice");
{
  const voices = [
    { uri: "hoda", name: "Microsoft Hoda", lang: "ar-EG", localService: true },
    { uri: "naayf", name: "Microsoft Naayf", lang: "ar-SA", localService: true },
    { uri: "david", name: "Microsoft David", lang: "en-US", localService: true },
    { uri: "ava", name: "Microsoft Ava Online (Natural)", lang: "en-US", localService: false },
  ];

  check("an Arabic paragraph gets an Arabic voice", pickVoice(voices, "ar").lang.startsWith("ar"));
  check("an English paragraph gets an English voice", pickVoice(voices, "en").lang.startsWith("en"));
  check(
    "a local voice is preferred over a network one",
    pickVoice(voices, "en").uri === "david",
    "network voices sound better and stop working offline"
  );

  check("your choice is honoured", pickVoice(voices, "en", "ava").uri === "ava");
  check(
    "but is overruled when it cannot read the text",
    pickVoice(voices, "ar", "david").lang.startsWith("ar"),
    "an English voice reading Arabic produces noise, not an accent"
  );

  const englishOnly = voices.filter((v) => v.lang.startsWith("en"));
  check(
    "with no voice for the language, something still speaks",
    pickVoice(englishOnly, "ar") !== null,
    "silence would look like a broken button"
  );
  check("no voices at all is null, not a crash", pickVoice([], "en") === null);

  const grouped = groupVoices(voices, "ar");
  check("the menu puts usable voices first", grouped.forThis.length === 2 && grouped.others.length === 2);

  check("the speed choices include normal pace", RATES.includes(1));
}

section("How much fits in one utterance before Chrome cuts it off");
{
  // The cutoff is about fifteen seconds of speech, and prose runs at roughly
  // fourteen characters a second — so the ceiling is a duration wearing a
  // character count as a disguise.
  const seconds = (rate) => maxChars(rate) / (14 * rate);

  check(
    "a normal-pace utterance stays under the fifteen-second cutoff",
    seconds(1) < 15,
    `${seconds(1).toFixed(1)}s — the old flat 220 was about 16s, over the cliff`
  );
  check(
    "and so does every speed on offer",
    RATES.every((r) => seconds(r) < 15),
    JSON.stringify(RATES.map((r) => `${r}x:${seconds(r).toFixed(1)}s`))
  );
  check(
    "reading faster fits more text in the same fifteen seconds",
    maxChars(2) > maxChars(1),
    `${maxChars(1)} at 1x vs ${maxChars(2)} at 2x`
  );
  check(
    "but never so little that prose is minced into fragments",
    maxChars(0.25) >= 120,
    `${maxChars(0.25)}`
  );
  check("nor so much that a slow voice sails past it anyway", maxChars(8) <= 480, `${maxChars(8)}`);

  // The reason any of this matters: a single long sentence gets no packing to
  // hide behind, so it meets the ceiling alone.
  const oneLongSentence = "word ".repeat(120).trim();
  check(
    "a long sentence is cut to the ceiling for the rate it will be read at",
    sentences(oneLongSentence, maxChars(1)).every((p) => p.length <= maxChars(1)),
    `ceiling ${maxChars(1)}`
  );

  // A network voice is bounded by round trips, not by the cutoff: every split
  // costs a fetch, and the gap while it happens is what you hear.
  check(
    "a network voice is given far longer utterances than a local one",
    maxChars(1, false) > maxChars(1, true) * 3,
    `${maxChars(1, true)} local vs ${maxChars(1, false)} network`
  );
  check(
    "enough that an ordinary paragraph is a single request",
    maxChars(1, false) >= 800,
    `${maxChars(1, false)} — the paragraphs measured in this book ran to about 780`
  );
  check(
    "but still bounded, so a cutoff would cost a seam and not a paragraph",
    maxChars(4, false) <= 1600,
    `${maxChars(4, false)}`
  );
  check("local remains the assumption when nothing says otherwise", maxChars(1) === maxChars(1, true));
}

/* ----------------------------------------------------------------- speaking */

section("Speaking a paragraph");
{
  const fake = fakeSynth();
  const { synth, spoken } = fake;
  const s = new Speaker(synth);

  let finished = 0;
  s.speak(longParagraph("the first", "the second", "the third"), {
    rate: 1.3,
    voice: { name: "Hoda", lang: "ar-EG" },
    onDone: () => finished++,
  });

  check(
    "the whole paragraph is handed over at once, not fed a piece at a time",
    spoken.length === 3,
    `${spoken.length} — feeding it one at a time puts a round trip between every sentence`
  );
  check("in order", spoken[0].text.endsWith("the first."), spoken[0].text.slice(-20));
  fake.tick();
  fake.tick();
  check("and it runs straight through them", fake.pending() === 1, `${fake.pending()} left`);
  check("the rate is carried through", spoken.every((x) => x.rate === 1.3));
  check(
    "the language is set alongside the voice",
    spoken.every((x) => x.lang === "ar-EG"),
    "some platforms ignore the voice unless lang agrees with it"
  );
  check("nothing is reported before the last piece ends", finished === 0);
  fake.tick();
  check("done is reported exactly once, at the end", finished === 1, `${finished}`);
}

section("Stopping is not finishing");
{
  const fake = fakeSynth();
  const { synth, spoken } = fake;
  const s = new Speaker(synth);

  let advanced = 0;
  s.speak(longParagraph("the first", "the second", "the third"), {
    onDone: () => advanced++,
  });
  fake.tick(); // the first piece is heard; two are still queued behind it
  s.stop(); // …and this fires onend on both, exactly as the real API does
  for (let i = 0; i < 6; i++) await settle();

  check("the queue is emptied", fake.pending() === 0, `${fake.pending()} left`);
  check("and stays silent", !fake.speaking());
  check(
    "and the reader is NOT advanced",
    advanced === 0,
    "cancel() fires onend on everything queued; counting those endings would " +
      "reach the total and report a paragraph finished that nobody heard"
  );
  check(
    "not even after the endings cancel() fired have all arrived",
    advanced === 0,
    `${spoken.length} pieces were queued, and every one of them reported an ending`
  );
}

/**
 * Turning a page while the last one is still speaking.
 *
 * This is the case the run token exists for, and the only one that reaches it —
 * which took a mutation test to discover. Simply stopping is already covered by
 * `stop()` clearing the callback, so removing the token changed nothing there
 * and the suite stayed green with the guard deleted.
 *
 * The danger needs three things at once: a paragraph interrupted mid-flight, a
 * new one installed behind it, and the dead paragraph's endings arriving late —
 * as dispatched events do. Its tally then completes against whatever callback
 * is installed *now*, and the book jumps a paragraph nobody read.
 */
section("Starting again interrupts what was speaking");
{
  const fake = fakeSynth();
  const { synth, spoken } = fake;
  const s = new Speaker(synth);

  let first = 0;
  let second = 0;
  s.speak(longParagraph("the first", "the second"), { onDone: () => first++ });
  s.speak(longParagraph("the next", "and the last"), { onDone: () => second++ });

  // The abandoned paragraph's endings land in here — after the new paragraph
  // has installed its callback, and while it is still only part-spoken.
  for (let i = 0; i < 6; i++) await settle();

  check(
    "the new paragraph is spoken",
    spoken.some((x) => x.text.endsWith("the next.")),
    JSON.stringify(spoken.map((x) => x.text.slice(-12)))
  );
  check("the old one's callback is disowned", first === 0, `${first}`);
  check(
    "and the endings it left behind are not counted towards the new one",
    second === 0,
    "two stale endings would otherwise complete the new paragraph's tally " +
      "before a word of it had been heard"
  );

  fake.tick();
  fake.tick();
  check("which reports done only when IT ends", second === 1, `${second}`);
}

section("A paragraph that fails to speak does not strand the reader");
{
  const fake = fakeSynth();
  const s = new Speaker(fake.synth);

  let done = 0;
  s.speak(longParagraph("the first", "the second"), { onDone: () => done++ });
  fake.fail(); // the voice is missing its data, or the engine simply gives up
  fake.fail();
  for (let i = 0; i < 6; i++) await settle();

  check("it moves on through the failures", fake.spoken.length === 2, `${fake.spoken.length}`);
  check("and still reports done", done === 1, "otherwise the book stops in silence for ever");
}

section("A network voice is split differently from a local one");
{
  const paragraph = longParagraph("one", "two", "three", "four", "five", "six");

  const localRun = fakeSynth();
  new Speaker(localRun.synth).speak(paragraph, {
    voice: { name: "Microsoft David", lang: "en-US", localService: true },
  });

  const onlineRun = fakeSynth();
  new Speaker(onlineRun.synth).speak(paragraph, {
    voice: { name: "Microsoft Andrew Online (Natural)", lang: "en-US", localService: false },
  });

  check(
    "the same paragraph becomes fewer requests on a natural voice",
    onlineRun.spoken.length < localRun.spoken.length,
    `${localRun.spoken.length} local vs ${onlineRun.spoken.length} network`
  );
  check(
    "few enough that the paragraph is spoken in one",
    onlineRun.spoken.length === 1,
    `${onlineRun.spoken.length} — each extra one is a fetch, and the gap is audible`
  );
  check(
    "and no word is lost in the regrouping",
    onlineRun.spoken.map((s) => s.text).join(" ").split(/\s+/).length ===
      localRun.spoken.map((s) => s.text).join(" ").split(/\s+/).length
  );

  const unknown = fakeSynth();
  new Speaker(unknown.synth).speak(paragraph, {});
  check(
    "a voice we know nothing about is treated as local, which is the safe way to be wrong",
    unknown.spoken.length === localRun.spoken.length,
    "guessing network on an unknown voice risks a cut-off paragraph, not a seam"
  );
}

section("Keeping a long utterance alive without fighting you");
{
  // The keep-alive runs on a timer. Captured rather than waited for, so the
  // test states what it does instead of taking ten seconds to find out.
  let poke = null;
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  globalThis.setInterval = (fn) => {
    poke = fn;
    return 1;
  };
  globalThis.clearInterval = () => {
    poke = null;
  };

  try {
    const fake = fakeSynth();
    const s = new Speaker(fake.synth);
    s.speak(longParagraph("the first", "the second"), {});

    check("something is nudging the engine while it speaks", typeof poke === "function");

    const before = fake.resumes();
    poke();
    check("the nudge reaches the synthesiser", fake.resumes() === before + 1);

    s.pause();
    const held = fake.resumes();
    poke();
    poke();
    check(
      "but never while you have it paused",
      fake.resumes() === held,
      "otherwise the timer would restart a paragraph you stopped to think about"
    );

    // Counted from after the resume, since letting go is itself a resume and
    // would otherwise be mistaken for the nudge this is testing.
    s.resume();
    const released = fake.resumes();
    poke();
    check("and resumes nudging once you let it go", fake.resumes() === released + 1);

    s.stop();
    check("the timer is dropped when it falls silent", poke === null, "otherwise it ticks for ever");
  } finally {
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
  }
}

section("An empty paragraph");
{
  const { synth, spoken } = fakeSynth();
  const s = new Speaker(synth);
  let done = 0;
  s.speak("   ", { onDone: () => done++ });
  await settle();
  check("nothing is said", spoken.length === 0);
  check("but it is reported done, so the reader steps over it", done === 1);
}

section("Without speech support");
{
  const s = new Speaker(null);
  check("it reports that it cannot", s.supported === false);
  let called = 0;
  s.speak("Anything.", { onDone: () => called++ });
  s.stop();
  s.pause();
  s.resume();
  check("and does nothing, quietly", called === 0);
}

section("The browser talks only to Raazi");
{
  // The Natural voices are fetched by Raazi's own server, so the browser
  // never contacts Microsoft — or anyone — directly.
  const fs = await import("node:fs");
  const src = fs.readFileSync(path.join(root, "lib", "speech.ts"), "utf8");
  const calls = [...src.matchAll(/\bfetch\(\s*"([^"]*)"/g)].map((m) => m[1]);
  check(
    "the only call is to Raazi's own speech route",
    calls.length === 1 && calls[0] === "/api/speech",
    calls.join(", ")
  );
  check("no other way out", !/XMLHttpRequest|WebSocket|\bfetch\(\s*[^"\s]/.test(src));
  check("no keys or endpoints", !/api[_-]?key|https?:\/\//i.test(src));
}

section("Natural voices");
{
  const ava = naturalVoice({ id: "en-US-AvaNeural", name: "Ava", lang: "en-US" });
  const salma = naturalVoice({ id: "ar-EG-SalmaNeural", name: "Salma", lang: "ar-EG" });
  const david = { uri: "david", name: "Microsoft David", lang: "en-US", localService: true };
  const hoda = { uri: "hoda", name: "Microsoft Hoda", lang: "ar-EG", localService: true };
  const all = [ava, salma, david, hoda];

  check("named with their region", ava.name === "Ava (US)", ava.name);
  check("told apart from the machine's", isNatural(ava) && !isNatural(david));
  check("chosen, one is used", pickVoice(all, "en", ava.uri) === ava);
  check(
    "and an Arabic chapter goes to a Natural Arabic voice, not the machine's",
    pickVoice(all, "ar", ava.uri) === salma,
    pickVoice(all, "ar", ava.uri)?.name
  );
  check("having chosen a machine voice, Arabic stays on the machine", pickVoice(all, "ar", david.uri) === hoda);
  check(
    "choosing nothing never sends text away",
    !isNatural(pickVoice(all, "en")) && !isNatural(pickVoice(all, "ar"))
  );
}

/* ----------------------------------------------- a fake player and server */

/** An audio element: plays when told, and ends when the test says so. */
class FakeAudio {
  static all = [];
  constructor() {
    this.src = "";
    this.paused = true;
    this.ended = false;
    this.played = [];
    this.onended = null;
    this.onerror = null;
    FakeAudio.all.push(this);
  }
  play() {
    this.paused = false;
    this.ended = false;
    this.played.push(this.src);
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  /** The piece now playing runs to its end. */
  end() {
    this.ended = true;
    this.paused = true;
    this.onended?.();
  }
}
globalThis.Audio = FakeAudio;

let requests = [];
let unreachable = false;
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  requests.push({ url, ...body });
  if (unreachable) return { ok: false, status: 502, json: async () => ({ error: "unreachable" }) };
  return { ok: true, status: 200, blob: async () => new Blob([body.text], { type: "audio/mpeg" }) };
};
const tick = () => new Promise((r) => setTimeout(r, 0));
const paragraph = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} goes on for a little while.`).join(" ");

section("Speaking a paragraph in a Natural voice");
{
  requests = [];
  const o = new OnlineSpeaker();
  const el = FakeAudio.all.at(-1);
  let done = 0;
  let inFlight = 0;
  let most = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    inFlight++;
    most = Math.max(most, inFlight);
    await tick();
    inFlight--;
    return realFetch(url, init);
  };
  o.speak(paragraph, { voice: "en-US-AvaNeural", rate: 1.15, onDone: () => done++ });
  for (let i = 0; i < 20; i++) await tick();
  globalThis.fetch = realFetch;

  // The service makes audio at about three times speaking pace and a piece
  // plays only once all of it is here: a whole paragraph at once kept you
  // waiting half a minute for the first word.
  check("the first piece is short, so speech starts soon", requests[0].text.length <= 160, String(requests[0].text.length));
  check(
    "the rest go in longer pieces",
    requests.slice(1, -1).every((q) => q.text.length <= 400 && q.text.length > 160) && requests.length > 2
  );
  check("all of the paragraph, in order", requests.map((q) => q.text).join(" ") === paragraph);
  check("never more than three requests at once", most <= 3, String(most));
  check(
    "to Raazi, with the voice and pace",
    requests.every((q) => q.url === "/api/speech" && q.voice === "en-US-AvaNeural" && q.rate === 1.15)
  );
  check("and the first starts playing", el.played.length === 1);
  for (let i = 1; i < requests.length; i++) {
    el.end();
    await tick();
  }
  check("then each next one", el.played.length === requests.length, `${el.played.length} of ${requests.length}`);
  check("not finished before the last piece is", done === 0);
  el.end();
  await tick();
  check("finished exactly once at the end", done === 1, String(done));
}

section("Moving on drops what was queued for the paragraph before");
{
  requests = [];
  const o = new OnlineSpeaker();
  // The old paragraph's first requests are still out when you move on.
  const held = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => new Promise((r) => held.push(() => r(realFetch(url, init))));
  o.speak(paragraph, { voice: "en-US-AvaNeural" });
  await tick();
  globalThis.fetch = realFetch;
  o.speak("The next paragraph, short.", { voice: "en-US-AvaNeural" });
  await tick();
  for (const release of held) release();
  for (let i = 0; i < 10; i++) await tick();
  const sentForOld = requests.filter((q) => paragraph.includes(q.text)).length;
  check("only what had already been sent is fetched for the old paragraph", sentForOld === 3, String(sentForOld));
  check("and the new one is fetched", requests.some((q) => q.text === "The next paragraph, short."));
}

section("Stopping a Natural voice is not finishing");
{
  const o = new OnlineSpeaker();
  const el = FakeAudio.all.at(-1);
  let done = 0;
  o.speak("A short one.", { voice: "en-US-AvaNeural", onDone: () => done++ });
  await tick();
  const ended = el.onended;
  o.stop();
  ended?.();
  await tick();
  check("stopping does not advance the book", done === 0);
}

section("The next paragraph is fetched ahead");
{
  requests = [];
  const o = new OnlineSpeaker();
  o.prefetch("The paragraph after this one.", { voice: "en-US-AvaNeural", rate: 1 });
  await tick();
  o.speak("The paragraph after this one.", { voice: "en-US-AvaNeural", rate: 1 });
  await tick();
  check("and not fetched again when it is reached", requests.length === 1, String(requests.length));
}

section("Holding a Natural voice");
{
  const o = new OnlineSpeaker();
  const el = FakeAudio.all.at(-1);
  o.speak("Paused before it began.", { voice: "en-US-AvaNeural", onDone: () => {} });
  o.pause();
  await tick();
  check("a paragraph paused while it was being fetched does not start", el.played.length === 0);
  o.resume();
  await tick();
  check("and starts when released", el.played.length === 1);
}

section("When the voice service cannot be reached");
{
  unreachable = true;
  const o = new OnlineSpeaker();
  let done = 0;
  let why = null;
  o.speak("Nobody home.", { voice: "en-US-AvaNeural", onDone: () => done++, onFail: (e) => (why = e) });
  await tick();
  await tick();
  check("the reader is told, so it can fall back", why?.message === "unreachable", String(why?.message));
  check("and it is not mistaken for finishing", done === 0);
  unreachable = false;
  requests = [];
  o.speak("Nobody home.", { voice: "en-US-AvaNeural" });
  await tick();
  check("a failure is not remembered: the next try really tries", requests.length === 1);
}

section("Proving to the voice service it is talking to Edge");
{
  const { secMsGec } = await import("../lib/edge-voice.ts");
  const { sha256Compress } = await import("../lib/edge-gec.ts");
  const { createHash } = await import("node:crypto");
  const start = 1_790_000_000 - (1_790_000_000 % 300);
  check("the v2 form: a checksum and a SHA-256, in capitals", /^[0-9A-F]{16}-[0-9A-F]{64}$/.test(secMsGec(start)));
  check("the same within a five-minute window", secMsGec(start) === secMsGec(start + 299));
  check("and different in the next", secMsGec(start) !== secMsGec(start + 300));
  // Pinned from a build the live service accepted (14 Nov 2026). If this
  // changes, the token changed, and the speech connection will be refused.
  check(
    "the token for a known window is unchanged",
    secMsGec(start) ===
      "D4216A7D3DE0C94F-91D741832FD084A110FDAD52BE2FFA569C6EA5F7D06A9429380A398738F4559A"
  );
  // The secret first block cannot be checked offline, but the rounds after it
  // are plain SHA-256, and those can.
  const iv = [0x6a09e667n, 0xbb67ae85n, 0x3c6ef372n, 0xa54ff53an, 0x510e527fn, 0x9b05688cn, 0x1f83d9abn, 0x5be0cd19n];
  const block = Buffer.alloc(64);
  block.write("abc");
  block[3] = 0x80;
  block[63] = 24;
  const ours = sha256Compress(iv, block).map((x) => x.toString(16).padStart(8, "0")).join("");
  check("its SHA-256 rounds agree with node:crypto", ours === createHash("sha256").update("abc").digest("hex"));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
