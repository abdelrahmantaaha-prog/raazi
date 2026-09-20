// Checks what the narrator actually says against what the script meant it to
// say. Each line is voiced (from the same cache make.mjs uses), then Gemini
// hears it twice: once blind, writing down every vowel it hears, and once with
// the vowelled script in hand, listing the words read differently. The blind
// transcript is diffed word by word against the script, so a wrong vowel shows
// even when the reviewer is too polite to mention it.
//
//   node pronounce.mjs --scenes=scenes-narrated.mjs [--only=intro,entry]
import { GoogleGenAI } from "@google/genai";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { narrate } from "./lib/tts.mjs";
import { spoken } from "./lib/captions.mjs";

const args = process.argv.slice(2);
const value = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const ONLY = value("only")?.split(",");
const SCENES_FILE = path.resolve(import.meta.dirname, value("scenes") ?? "scenes-narrated.mjs");
const { SCENES, VOICE, RATE, TITLE } = await import(pathToFileURL(SCENES_FILE).href);
const FILM = path.resolve(import.meta.dirname, "out", TITLE);
const REPORT = path.join(FILM, "pronunciation.json");

// The app's own Gemini keys; the snapshot deliberately has none.
const config = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../data/config.json"), "utf8"));
const KEYS = config.keys.filter((k) => k.provider === "gemini" && !k.invalid).map((k) => k.key);
const MODELS = ["gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash"];

// Free keys allow a handful of calls a minute: when every key and model is
// refused for quota, wait out the minute rather than give up.
async function ask(parts, schema) {
  let last;
  for (let round = 0; round < 6; round++) {
    let limited = false;
    for (const model of MODELS) {
      for (const apiKey of KEYS) {
        try {
          const ai = new GoogleGenAI({ apiKey });
          const res = await ai.models.generateContent({
            model,
            contents: [{ role: "user", parts: parts.map((p) => (typeof p === "string" ? { text: p } : p)) }],
            config: { temperature: 0, responseMimeType: "application/json", responseSchema: schema },
          });
          return JSON.parse(res.text);
        } catch (err) {
          last = err;
          if (err.status === 429 || err.status === 503) limited = true;
        }
      }
    }
    if (!limited) break;
    console.log(`  (quota: waiting a minute)`);
    await new Promise((r) => setTimeout(r, 60_000));
  }
  throw last;
}

const HARAKAT = /[ً-ْٰ]/g;
const HARAKA = /^[ً-ْٰ]$/; // not global: .test() on a /g regex keeps state between calls
const TATWEEL = /ـ/g;
const bare = (w) => w.replace(HARAKAT, "").replace(TATWEEL, "").replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه");
const tokens = (s) => s.replace(/[.,،؛:!?؟«»"“”()\-–—…]/g, " ").split(/\s+/).filter(Boolean);
// Shadda first, so "بّ" and "ّب" compare equal whatever order the marks were typed in.
const marks = (w) => [...w.replace(TATWEEL, "")].map((ch, i, a) => (HARAKA.test(ch) ? "" : ch + a.slice(i + 1).join("").match(/^[ً-ْٰ]*/)[0].split("").sort().join("")))
  .filter(Boolean);

/** Words whose vowels differ where both texts mark them; the last letter of a word before a pause is left alone. */
function diff(script, heard) {
  const a = tokens(script), b = tokens(heard);
  const pauses = new Set();
  let i = 0;
  for (const m of script.matchAll(/\S+/g)) {
    if (/[.,،؛:!?؟]$/.test(m[0])) pauses.add(i);
    i += tokens(m[0]).length;
  }
  pauses.add(a.length - 1);
  const out = [];
  let j = 0;
  for (let k = 0; k < a.length; k++) {
    // Re-align on the bare letters: a dropped, split or merged word should cost a row or two, not the rest of the line.
    let at = b.slice(j, j + 6).findIndex((w) => bare(w) === bare(a[k]));
    if (at < 0) { out.push({ word: a[k], heard: "(not matched)" }); continue; }
    const h = b[j + at];
    j += at + 1;
    const x = marks(a[k]), y = marks(h);
    if (x.length !== y.length) { out.push({ word: a[k], heard: h }); continue; }
    const last = x.length - 1;
    const bad = x.some((c, n) => {
      if (n === last && pauses.has(k)) return false;
      const cx = c.slice(1).replace(/ّ/, ""), cy = y[n].slice(1).replace(/ّ/, "");
      const shadda = c.includes("ّ") !== y[n].includes("ّ");
      // Only a mark on both sides can disagree; an unmarked letter in either text is not evidence.
      return shadda || (cx && cy && cx !== cy);
    });
    if (bad) out.push({ word: a[k], heard: h });
  }
  return out;
}

const report = fs.existsSync(REPORT) ? JSON.parse(fs.readFileSync(REPORT, "utf8")) : {};
for (const s of SCENES) {
  if (!s.say || (ONLY && !ONLY.includes(s.id))) continue;
  const say = spoken(s.say);
  const narr = await narrate(say, { voice: VOICE, rate: RATE, dir: path.join(FILM, "tts") });
  const audio = { inlineData: { mimeType: "audio/mp3", data: fs.readFileSync(narr.audio).toString("base64") } };

  const blind = await ask([
    "This is a Modern Standard Arabic voice-over. Write down exactly what the speaker says, fully vowelled: put on every " +
    "letter the haraka you actually hear (fatha, damma, kasra, sukun, shadda, tanwin), including case endings where they " +
    "are voiced and sukun where the speaker stops on a word. Do not correct grammar or supply vowels you cannot hear; " +
    "if a word is mispronounced, write it as pronounced. Latin-script names may be written as heard in Arabic letters.",
    audio,
  ], { type: "object", properties: { transcript: { type: "string" } }, required: ["transcript"] });

  const review = await ask([
    `Intended text, fully vowelled:\n${say}\n\n` +
    "You are a strict reviewer of Arabic voice-overs. Listen to the recording and list every word the speaker reads " +
    "differently from the intended vocalisation: a wrong short vowel or case ending, a missing or extra shadda, a " +
    "long vowel shortened, a word skipped or added, a wrong stop or pause that changes the meaning, or a name that " +
    "sounds wrong. Ignore a dropped final vowel on the last word before a pause (waqf). Also rate how natural it " +
    "sounds to a native listener from 1 to 5. Return no issues if it is read as intended.",
    audio,
  ], {
    type: "object",
    properties: {
      natural: { type: "integer" },
      issues: { type: "array", items: { type: "object", properties: {
        intended: { type: "string" }, heard: { type: "string" }, note: { type: "string" },
      }, required: ["intended", "heard", "note"] } },
    },
    required: ["natural", "issues"],
  });

  const mismatches = diff(say, blind.transcript);
  report[s.id] = { say, heard: blind.transcript, mismatches, natural: review.natural, issues: review.issues };
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));

  console.log(`\n■ ${s.id}  (${narr.duration.toFixed(1)}s, natural ${review.natural}/5)`);
  console.log(`  script: ${say}`);
  console.log(`  heard:  ${blind.transcript}`);
  for (const m of mismatches) console.log(`  ≠ ${m.word}  →  ${m.heard}`);
  for (const x of review.issues) console.log(`  ! ${x.intended} → ${x.heard}: ${x.note}`);
}
console.log(`\nreport: ${REPORT}`);
