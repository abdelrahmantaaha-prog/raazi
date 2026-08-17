/**
 * Reading a book out loud, using the voices already on the machine.
 *
 * No account, no key, no per-character cost and nothing sent anywhere: the
 * browser's speech synthesis speaks through the operating system's own voices.
 * That last property is what decides it. A book is around half a million
 * characters, which exhausts the monthly free allowance of every hosted
 * text-to-speech service in a sitting or two, and would mean posting the text of
 * everything you read to somebody's server — in an app whose whole premise is a
 * library that lives on your disk.
 *
 * The awkward parts are all in the platform, and they are the reason this module
 * exists rather than a bare `speechSynthesis.speak(text)` call at the point of
 * use:
 *
 *  - Voices arrive late. `getVoices()` is empty on first call in most browsers
 *    and fills in after a `voiceschanged` event that may already have fired.
 *  - Long utterances are cut off. Chrome stops speaking after roughly fifteen
 *    seconds of a single utterance — a documented, long-standing bug — so a
 *    paragraph has to be broken into sentence-sized pieces and queued.
 *  - Cancelling is not clean. `cancel()` fires `onend` on the utterance it
 *    killed, indistinguishable from a natural finish, which will happily
 *    advance the reader a paragraph you never heard.
 *
 * All three are handled here so the reader can treat speech as: say this, tell
 * me when it is genuinely finished.
 */

export interface Voice {
  /** `SpeechSynthesisVoice.voiceURI` — what identifies it across sessions. */
  uri: string;
  name: string;
  lang: string;
  localService: boolean;
}

/** The pieces of one paragraph, each short enough to survive being spoken. */
export function sentences(text: string, max = 220): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];

  // Split after sentence-ending punctuation, including the Arabic question mark
  // and full stop, keeping the punctuation with the sentence it ends.
  const parts = clean.match(/[^.!?؟۔]+[.!?؟۔]*\s*/g) ?? [clean];

  const out: string[] = [];
  let buffer = "";

  for (const part of parts) {
    const piece = part.trim();
    if (!piece) continue;

    // A sentence longer than the ceiling on its own — someone's page-long
    // period — is broken at a comma, and failing that at a space. Never
    // mid-word: a voice reading half a word aloud is worse than a clumsy break.
    if (piece.length > max) {
      if (buffer) {
        out.push(buffer);
        buffer = "";
      }
      out.push(...breakLong(piece, max));
      continue;
    }

    if (buffer.length + piece.length + 1 <= max) {
      buffer = buffer ? `${buffer} ${piece}` : piece;
    } else {
      if (buffer) out.push(buffer);
      buffer = piece;
    }
  }
  if (buffer) out.push(buffer);
  return out;
}

function breakLong(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    const at =
      Math.max(window.lastIndexOf("، "), window.lastIndexOf(", "), window.lastIndexOf("; ")) ||
      -1;
    const cut = at > max * 0.4 ? at + 1 : window.lastIndexOf(" ");
    if (cut <= 0) break;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Which script a paragraph is in, as a BCP-47 prefix.
 *
 * Only enough to pick a voice. A book here can be Arabic, and a paragraph of
 * Arabic read by an English voice is not merely accented — it is unintelligible,
 * because the voice will spell out characters it has no phonemes for.
 */
export function langOf(text: string): "ar" | "en" {
  let arabic = 0;
  let latin = 0;
  for (const ch of text.slice(0, 400)) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0x0600 && c <= 0x06ff) || (c >= 0x0750 && c <= 0x077f) || (c >= 0xfb50 && c <= 0xfeff)) arabic++;
    else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) latin++;
  }
  return arabic > latin ? "ar" : "en";
}

/**
 * The best available voice for a language, given what you have chosen.
 *
 * Your choice wins whenever it can speak the language in front of it. It cannot
 * simply always win: choosing an English voice and then reaching an Arabic
 * chapter has to fall back, or the book turns to noise halfway through.
 *
 * Among the rest, a voice whose language matches exactly beats one that merely
 * shares a prefix, and a locally installed voice beats a network one — network
 * voices sound better and stop working on a train.
 */
export function pickVoice(voices: Voice[], lang: "ar" | "en", preferredUri?: string): Voice | null {
  const speaks = (v: Voice) => v.lang.toLowerCase().startsWith(lang);
  const chosen = preferredUri ? voices.find((v) => v.uri === preferredUri) : undefined;
  if (chosen && speaks(chosen)) return chosen;

  const candidates = voices.filter(speaks);
  if (candidates.length === 0) return chosen ?? voices[0] ?? null;

  return (
    candidates.slice().sort((a, b) => {
      // Prefer the default regional form of a language over an unusual one.
      const exact = (v: Voice) => (v.lang.toLowerCase() === lang ? 0 : 1);
      return exact(a) - exact(b) || Number(b.localService) - Number(a.localService);
    })[0] ?? null
  );
}

/** Voices grouped for a menu: the ones that can read this book first. */
export function groupVoices(voices: Voice[], lang: "ar" | "en"): { forThis: Voice[]; others: Voice[] } {
  const forThis = voices.filter((v) => v.lang.toLowerCase().startsWith(lang));
  const others = voices.filter((v) => !v.lang.toLowerCase().startsWith(lang));
  return { forThis, others };
}

export const RATES = [0.75, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2] as const;

/**
 * How much text one utterance can carry.
 *
 * Two different constraints, depending on where the voice lives, and they pull
 * in opposite directions.
 *
 * A voice installed on the machine is bounded by Chrome's cutoff: about fifteen
 * seconds of wall-clock speech, after which an utterance is silently abandoned.
 * Prose runs at roughly fourteen characters a second at normal pace, so a flat
 * 220 characters was about sixteen seconds — marginally *over* the cliff. Since
 * the limit is wall-clock, reading faster fits proportionally more text into the
 * same fifteen seconds, so the ceiling scales with the rate.
 *
 * A network voice — Microsoft's "Natural" voices, which Edge exposes and Chrome
 * does not — is bounded by something else entirely: every utterance is a
 * separate request to a server, and the gap while it is fetched is audible. For
 * these, splitting is the thing doing the damage. Chunks sized for a cutoff that
 * costs nothing to avoid locally will stutter once each boundary costs a round
 * trip, so the ceiling goes up until a normal paragraph is a single request.
 *
 * The ceiling for network voices is deliberately not unbounded. If the cutoff
 * turns out to apply to them too, a runaway ceiling would mean whole paragraphs
 * cut off mid-sentence rather than a seam between them — a much worse failure
 * than the one being fixed. `keepAlive` on the Speaker is the other half of this
 * bet.
 */
export function maxChars(rate = 1, local = true): number {
  const perSecond = 14;
  if (!local) return Math.min(1600, Math.max(400, Math.round(perSecond * 60 * rate)));
  const safeSeconds = 13;
  return Math.min(480, Math.max(120, Math.round(perSecond * safeSeconds * rate)));
}

/**
 * Speaks a paragraph as one batch of utterances and reports back once, at the
 * end.
 *
 * A class rather than a handful of functions because the correctness of the
 * whole thing rests on one piece of state — a token identifying the current
 * run. `cancel()` fires `onend` on the utterances it kills, and that callback is
 * identical to a natural ending; without something to tell them apart, stopping
 * playback advances the reader to the next paragraph, and pressing stop is
 * indistinguishable from listening to the end.
 *
 * Every piece is handed over at once rather than one at a time. The synthesiser
 * keeps its own queue and runs straight from one utterance into the next;
 * feeding it a piece only after the previous one's `onend` had surfaced into
 * JavaScript put a round trip, and an audible seam, between every sentence.
 * That seam was the reason paragraphs sounded chopped up, and it is invisible
 * from here — it lives in the gap between the engine finishing and the next
 * `speak()` reaching it.
 */
export class Speaker {
  private run = 0;
  private done: (() => void) | null = null;
  private synth: SpeechSynthesis | null;
  /** Whether you paused it, as opposed to it having stopped by itself. */
  private held = false;
  private poke: ReturnType<typeof setInterval> | null = null;

  constructor(synth?: SpeechSynthesis | null) {
    this.synth = synth ?? (typeof window === "undefined" ? null : window.speechSynthesis);
  }

  get supported(): boolean {
    return Boolean(this.synth);
  }

  /**
   * Says a paragraph, then calls `onDone` — but only if it was allowed to
   * finish. Interrupting it calls nothing.
   */
  speak(
    text: string,
    opts: { voice?: SpeechSynthesisVoice | null; rate?: number; onDone?: () => void }
  ): void {
    if (!this.synth) return;
    this.stop();

    const mine = ++this.run;
    const rate = opts.rate ?? 1;
    this.done = opts.onDone ?? null;
    this.held = false;

    // Absent a voice we are told about, assume the cautious case. A missing
    // `voice` means the platform default, which is normally a local one.
    const local = opts.voice ? opts.voice.localService !== false : true;
    const pieces = sentences(text, maxChars(rate, local));
    if (pieces.length === 0) {
      const finish = this.done;
      this.done = null;
      finish?.();
      return;
    }

    // Counted rather than hung off the last utterance alone. Engines do drop
    // the occasional queued utterance, and a `done` that depended on one
    // specific callback arriving would leave the book stopped in silence for
    // ever; every ending and every failure advances the same tally.
    let ended = 0;
    const settle = () => {
      // What the token defends, precisely: turning a page while the last one is
      // still speaking. `cancel()` fires these callbacks for the utterances it
      // discards and they arrive late, as dispatched events do — by which time
      // a new paragraph has installed its own `done`. Untokened, the dead
      // paragraph's endings complete their tally against the *new* callback and
      // the book jumps a paragraph nobody heard.
      //
      // Stopping and staying stopped is not this case: `stop()` clears `done`,
      // so those endings land on nothing. Deleting this line therefore leaves
      // every obvious test green, which is how it survived the first draft.
      if (mine !== this.run) return;
      if (++ended < pieces.length) return;

      this.stopPoking();
      const finish = this.done;
      this.done = null;
      finish?.();
    };

    this.startPoking();
    for (const piece of pieces) {
      const u = new SpeechSynthesisUtterance(piece);
      if (opts.voice) {
        u.voice = opts.voice;
        // Set alongside the voice: some platforms ignore `voice` unless `lang`
        // agrees with it, and read Arabic in an English voice regardless.
        u.lang = opts.voice.lang;
      }
      u.rate = rate;
      u.onend = settle;
      // A failed utterance must not strand the reader in silence waiting for an
      // `onend` that is never coming, so an error counts like an ending.
      u.onerror = settle;
      this.synth.speak(u);
    }
  }

  pause(): void {
    this.held = true;
    this.synth?.pause();
  }

  resume(): void {
    this.held = false;
    this.synth?.resume();
  }

  /**
   * Nudges the engine while a long utterance is in flight.
   *
   * Chrome abandons an utterance after about fifteen seconds and reports
   * nothing. The ceiling keeps local voices under that, but a network voice is
   * deliberately given far longer utterances — splitting is what makes those
   * stutter — so something has to cover the case where the cutoff applies to
   * them as well.
   *
   * This is the weak form of the workaround, and knowingly so. The sturdy
   * version pairs `pause()` with `resume()`, which resets the engine's timer
   * but can put a click in the audio — and on a network voice may force it to
   * rebuffer, which is the exact fault being fixed. A lone `resume()` cannot
   * do that: on something already speaking it is defined as a no-op. If a
   * paragraph turns out to cut off mid-sentence on a natural voice, this is the
   * first thing to make sturdier, at the cost of that click.
   */
  private startPoking(): void {
    this.stopPoking();
    if (typeof setInterval !== "function") return;
    this.poke = setInterval(() => {
      // Never fight a deliberate pause: resuming here would restart a paragraph
      // you had stopped to think about.
      if (!this.held) this.synth?.resume();
    }, 10_000);
  }

  private stopPoking(): void {
    if (this.poke !== null) {
      clearInterval(this.poke);
      this.poke = null;
    }
  }

  /** Silences everything and disowns the callbacks of whatever was queued. */
  stop(): void {
    this.run++;
    this.done = null;
    this.held = false;
    this.stopPoking();
    // Cancelling while paused leaves some engines stuck, so wake it first.
    try {
      this.synth?.resume();
      this.synth?.cancel();
    } catch {
      /* nothing worth doing about it */
    }
  }
}

/**
 * The installed voices, once they exist.
 *
 * `getVoices()` returns an empty list on the first call in Chrome and fills in
 * later; the event announcing that may also have fired before anyone listened.
 * So: try now, and subscribe in case now was too early.
 */
export function watchVoices(onChange: (voices: Voice[]) => void): () => void {
  if (typeof window === "undefined" || !window.speechSynthesis) {
    onChange([]);
    return () => {};
  }
  const synth = window.speechSynthesis;

  const read = () =>
    onChange(
      synth.getVoices().map((v) => ({
        uri: v.voiceURI,
        name: v.name,
        lang: v.lang,
        localService: v.localService,
      }))
    );

  read();
  synth.addEventListener("voiceschanged", read);
  return () => synth.removeEventListener("voiceschanged", read);
}
