/**
 * Arabic captions from word timings. The voice is given a lightly vowelled
 * script so it reads ambiguous words right; the captions drop the vowel marks,
 * which read as clutter on screen.
 */
const HARAKAT = /[ً-ْٰـ]/g;
const PAUSE = /^\s*[.،,؟?!؛:]/;

/** Phrases break at the script's punctuation; long ones split into even parts. */
export function sceneCues(words, script, offset, maxWords = 7) {
  const phrases = [];
  let phrase = [];
  let cursor = 0;
  for (const w of words) {
    const at = script.indexOf(w.text, cursor);
    if (at >= 0) cursor = at + w.text.length;
    phrase.push(w);
    if (at >= 0 && PAUSE.test(script.slice(cursor))) { phrases.push(phrase); phrase = []; }
  }
  if (phrase.length) phrases.push(phrase);

  const cues = [];
  for (const p of phrases) {
    const parts = Math.ceil(p.length / maxWords);
    const size = Math.ceil(p.length / parts);
    for (let i = 0; i < p.length; i += size) {
      const c = p.slice(i, i + size);
      cues.push({
        start: offset + c[0].start,
        end: offset + c.at(-1).end,
        text: c.map((w) => w.text).join(" ").replace(HARAKAT, ""),
      });
    }
  }
  return cues;
}

const stamp = (s) => {
  const cs = Math.max(0, Math.round(s * 100));
  const h = Math.floor(cs / 360000), m = Math.floor(cs / 6000) % 60, sec = Math.floor(cs / 100) % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
};

/** A caption stays up a little past its last word, never into the next one. */
export function assDocument(cues) {
  const sorted = [...cues].sort((a, b) => a.start - b.start);
  const lines = sorted.map((c, i) => {
    const next = sorted[i + 1];
    const end = next ? Math.min(next.start - 0.04, c.end + 0.6) : c.end + 0.8;
    return `Dialogue: 0,${stamp(c.start)},${stamp(end)},Caption,,0,0,0,,${c.text}`;
  });
  // Box style (BorderStyle 3): cream text on a translucent dark-brown band.
  return `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,Noto Sans Arabic,52,&H00F2F7FA,&H00F2F7FA,&H330D141D,&H00000000,-1,0,0,0,100,100,0,0,3,16,0,2,240,240,58,178

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${lines.join("\n")}
`;
}
