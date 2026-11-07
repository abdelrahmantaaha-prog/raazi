"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { dirOf } from "@/lib/dir";
import { EntityDrawer } from "../../components/EntityDrawer";
import {
  NATURAL,
  OnlineSpeaker,
  RATES,
  Speaker,
  groupVoices,
  isNatural,
  langOf,
  naturalVoice,
  pickVoice,
  watchVoices,
  type Voice,
} from "@/lib/speech";
import { Lookup, type LookupAt } from "./Lookup";
import { SendToWrite, type SendAt } from "./SendToWrite";
import { LitReviewWindow } from "../../components/LitReview";
import { ReaderParagraph } from "./ReaderParagraph";
import { PdfPages, type PageBlock, type PdfApi } from "./PdfPages";
import { tidySelection } from "@/lib/pdf-align";

export interface Passage {
  id: number;
  seq: number;
  text: string;
  locator: string;
  /** The page of the source file it starts on, when it has pages. */
  page?: number | null;
  label: string | null;
  extracted: boolean;
  /** `model` is which model read the passage and found this, when known. */
  mentions: { surface: string; entityId: number; name: string; model: string | null }[];
}

export interface Mark {
  id: number;
  chunk_id: number;
  offset: number;
  excerpt: string | null;
  seq: number;
}

interface Prefs {
  size: number;
  measure: number;
  theme: "paper" | "sepia" | "night";
  serif: boolean;
  highlights: boolean;
  justify: boolean;
  /**
   * 'scroll' is an ordinary page you move through yourself. 'focus' lights one
   * paragraph at a time and advances only when you say so.
   */
  mode: "scroll" | "focus";
  /** The voice to read aloud in, by voiceURI. Undefined means "pick for me". */
  voice?: string;
  /** Speaking speed. 1 is the voice's own pace. */
  rate: number;
  /** How large the page view draws a PDF's pages, in percent of the screen's fit. */
  zoom: number;
  /** Bumped when a default changes in a way that should reach saved prefs. */
  v: number;
}

const DEFAULTS: Prefs = {
  size: 19,
  measure: 34,
  theme: "paper",
  serif: true,
  highlights: true,
  justify: true,
  mode: "scroll",
  rate: 1,
  zoom: 100,
  v: 3,
};

/**
 * How a PDF is shown: its own pages, or Raazi's text of it. Remembered per
 * source, because the answer depends on the PDF — a well-made one reads best
 * as itself, and a scan or a badly encoded one reads better as text.
 */
type View = "page" | "text";
const viewKey = (sourceId: number) => `corpus.reader.view.${sourceId}`;

const THEMES = {
  paper: { bg: "#fbfaf7", fg: "#1c1a17", muted: "#6b665e", rule: "#e2ddd3", mark: "#efe4d6" },
  sepia: { bg: "#f4ecd8", fg: "#3b2f1e", muted: "#7a6a52", rule: "#ddd0b4", mark: "#e8d9b8" },
  night: { bg: "#16161a", fg: "#d6d3cd", muted: "#8b877f", rule: "#2c2c31", mark: "#33302a" },
};

/** How far down the viewport counts as "the line you are reading". */
const READING_LINE = 140;

/**
 * Nothing about scrolling records progress. Deliberately, and after two goes at
 * it: scroll position measured the scrollbar rather than the reader, and
 * time-in-view was better but still a guess about attention that could be
 * wrong in both directions — it counted a passage left open while you made tea,
 * and refused one you read quickly.
 *
 * Progress is now only ever recorded by an explicit act: finishing a paragraph
 * in reading mode, or saying "read to here". Nothing is inferred.
 */

/**
 * The source as something to actually read, rather than as a pile of the
 * chunks the pipeline happens to work in.
 *
 * Chunk boundaries are an implementation detail — they overlap, they cut
 * mid-argument, and showing them as cards makes a book unreadable. Here the
 * text runs continuously and the seams are dissolved: overlapping tails are
 * trimmed, and only real divisions (a new page, a new chapter) get a marker.
 *
 * Everything positional hangs off `scroller`, the element that actually
 * scrolls. This reader is a fixed, full-screen panel, so the document behind it
 * never moves — which meant the window scroll listeners this used to rely on
 * never fired even once. Progress sat at 0%, the position was never saved
 * because saving was triggered by those same events, and space and the arrow
 * keys called window.scrollBy on a window with nothing to scroll. One wrong
 * element, three broken features.
 */
export function Reader({
  passages,
  pdf = false,
  title,
  author,
  sourceId,
  position,
  marks,
  readAlong,
  initialChunk = null,
  onClose,
}: {
  passages: Passage[];
  /** The source is a PDF, so its own pages can be shown. */
  pdf?: boolean;
  title: string;
  author: string | null;
  sourceId: number;
  position: {
    chunkId: number | null;
    offset: number;
    progress: number;
    read: number[];
    /** Passages read only partway, and how far into each. */
    partly: Record<number, number>;
  };
  marks: Mark[];
  /** Whether Raazi reads this source as you go, and how far behind it is. */
  readAlong: { on: boolean; remaining: number };
  /**
   * A passage to open at, from a search hit or a citation's "Read in". Wins
   * over the saved position for this one opening, and is lit for a moment so
   * the eye lands on it.
   */
  initialChunk?: number | null;
  onClose: () => void;
}) {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULTS);
  const [ready, setReady] = useState(false);
  const [progress, setProgress] = useState(position.progress);
  const [panel, setPanel] = useState<"none" | "type" | "marks">("none");
  const [bookmarks, setBookmarks] = useState<Mark[]>(marks);
  const [here, setHere] = useState<number | null>(position.chunkId);
  const [pending, setPending] = useState(readAlong.remaining);
  const [restored, setRestored] = useState<string | null>(null);
  const [lookup, setLookup] = useState<LookupAt | null>(null);
  /** A passage selected for the writing desk — the card that offers to send it. */
  const [send, setSend] = useState<SendAt | null>(null);
  /** A literature review of what you highlighted, and the paragraph it was in. */
  const [review, setReview] = useState<{ focus: string; context?: string } | null>(null);
  const selectionContext = useRef<string | undefined>(undefined);

  /** A PDF's own pages, or the text. Read from storage with the prefs below. */
  const [view, setView] = useState<View>(pdf ? "page" : "text");
  /** The page view could not open the PDF, and the reader fell back to text. */
  const [pageFailed, setPageFailed] = useState(false);
  const pages = pdf && view === "page" && !pageFailed;
  /** What the page view offers: a selection on the page as the extracted text. */
  const pdfApi = useRef<PdfApi | null>(null);
  /**
   * Where you were when you switched views, to return to once the other view
   * has laid itself out. The page view lays itself out only after the PDF has
   * opened, so this waits for it.
   */
  const pendingJump = useRef<{ id: number; offset: number } | null>(null);
  /** The opening position is restored once, by whichever view is first ready. */
  const restoredOnce = useRef(false);

  const scroller = useRef<HTMLDivElement>(null);
  /** The in-flight soft scroll, so a second advance retargets it rather than
   *  fighting it. See `softScrollTo`. */
  const glide = useRef<Glide>({
    target: null,
    frame: null,
    timer: null,
    started: 0,
    from: 0,
  }).current;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSaved = useRef<{ id: number; offset: number } | null>(null);
  /**
   * Whether reading mode is on, for measurements taken outside a render. In
   * reading mode the lit paragraph sits a third of the way down the screen,
   * not on the reading line, and "where you are" has to follow it.
   */
  const focusMode = useRef(prefs.mode === "focus");
  useEffect(() => {
    focusMode.current = prefs.mode === "focus";
  }, [prefs.mode]);
  /**
   * Where the reading line was at the last scroll tick. The unmount flush runs
   * after React has detached the scroller ref, so it cannot measure anything —
   * this is what it saves instead. Without it the last "Finished reading"
   * before closing was lost whenever you closed within its 600 ms debounce.
   */
  const lastPosition = useRef<{ id: number; offset: number } | null>(null);
  /**
   * How much of each passage is known to be read, 0 to 1, so it is never
   * re-sent. Partway counts: a passage of a book is several pages long.
   */
  const read = useRef<Map<number, number>>(
    new Map(position.read.map((id) => [id, position.partly[id] ?? 1]))
  );
  /** Read since the last save, and how far, waiting to be reported. */
  const pendingRead = useRef<Map<number, number>>(new Map());
  const [readCount, setReadCount] = useState(() => finishedCount(read.current));

  const blocks = useMemo(() => joinPassages(passages), [passages]);
  const theme = THEMES[prefs.theme];

  /**
   * Every paragraph in the book, in order, each knowing which passage it
   * belongs to and whether it is the last one there.
   *
   * Reading mode advances a paragraph at a time, and progress is stored per
   * passage as a share of it — so each paragraph carries how much of its
   * passage is read once it is finished. Working it out once here means the
   * advance itself stays a single increment.
   */
  const paragraphs = useMemo(() => {
    const flat: { chunkId: number; blockKey: string; index: number; upto: number }[] = [];
    for (const b of blocks) {
      const total = b.paragraphs.reduce((n, p) => n + p.length, 0) || 1;
      let done = 0;
      b.paragraphs.forEach((p, i) => {
        done += p.length;
        flat.push({
          chunkId: b.chunkId,
          blockKey: b.key,
          index: i,
          // Exactly 1 at the end, whatever the rounding, so a finished passage
          // is finished.
          upto: i === b.paragraphs.length - 1 ? 1 : done / total,
        });
      });
    }
    return flat;
  }, [blocks]);

  /**
   * Which paragraph is lit. Starts wherever you had already read to, so
   * switching into reading mode resumes rather than restarting.
   */
  const [cursor, setCursor] = useState(0);

  /**
   * True when the paragraph you are on does not fit on the screen.
   *
   * Freezing the page is the point of reading mode, but a paragraph taller than
   * the window turns that into a trap: the bottom of it is unreachable and the
   * only way to read it is to leave the mode. So the freeze lifts for exactly
   * as long as it has to, and clamps shut again on the next paragraph that fits.
   */
  const [overflowing, setOverflowing] = useState(false);
  /** The pedia entry open beside the book, if any. */
  const [openEntity, setOpenEntity] = useState<number | null>(null);

  /** Reading aloud: whether it is running, and whether it is on hold. */
  const [listening, setListening] = useState(false);
  const [paused, setPaused] = useState(false);
  /** The browser's own voices, and Microsoft's Natural ones through Raazi. */
  const [machineVoices, setMachineVoices] = useState<Voice[]>([]);
  const [naturalVoices, setNaturalVoices] = useState<Voice[]>([]);
  const voices = useMemo(() => [...naturalVoices, ...machineVoices], [naturalVoices, machineVoices]);
  /** Why a Natural voice just gave way to one on the machine, briefly. */
  const [voiceNote, setVoiceNote] = useState<string | null>(null);
  /**
   * The voice list as the speaking effect reads it, and the voice it last
   * spoke with. Chrome and Edge fire `voiceschanged` more than once, and with
   * the list as a dependency each firing tore down the utterance and read the
   * paragraph again from its first word. Now a change in the list only
   * restarts the paragraph when the voice in use has actually gone — or when
   * there was none to pick from yet.
   */
  const voicesRef = useRef<Voice[]>([]);
  /** Whether the list held your chosen voice last time it changed. */
  const hadChosen = useRef(false);
  const spokenVoice = useRef<string | null>(null);
  const [voiceEpoch, setVoiceEpoch] = useState(0);
  const speaker = useRef<Speaker | null>(null);
  if (speaker.current === null && typeof window !== "undefined") {
    speaker.current = new Speaker();
  }
  const online = useRef<OnlineSpeaker | null>(null);
  if (online.current === null && typeof window !== "undefined") {
    online.current = new OnlineSpeaker();
  }
  const canSpeak = Boolean(speaker.current?.supported || online.current?.supported);

  /** Block key + paragraph number → its position in the whole book. */
  const paraIndex = useMemo(() => {
    const map = new Map<string, number>();
    paragraphs.forEach((p, i) => map.set(`${p.blockKey}:${p.index}`, i));
    return map;
  }, [paragraphs]);
  const chapters = useMemo(
    () => blocks.filter((b) => b.divider).map((b) => ({ id: b.key, label: b.divider! })),
    [blocks]
  );
  const marked = useMemo(() => new Set(bookmarks.map((b) => b.chunk_id)), [bookmarks]);

  /**
   * Which passage the reading line is currently sitting in, and how far into it.
   *
   * Measured against the scroller's own box rather than the viewport, so it
   * stays correct if this panel ever stops being full-screen.
   */
  const currentPassage = useCallback((): { id: number; offset: number } | null => {
    const el = scroller.current;
    if (!el) return null;
    // In reading mode, the top of the lit paragraph — see `showParagraph`.
    const line =
      el.getBoundingClientRect().top +
      (focusMode.current ? el.clientHeight * 0.32 + 1 : READING_LINE);

    let best: { id: number; offset: number } | null = null;
    for (const section of el.querySelectorAll<HTMLElement>("section[data-chunk]")) {
      const box = section.getBoundingClientRect();
      if (box.top > line) break;
      best = {
        id: Number(section.dataset.chunk),
        offset: Math.max(0, Math.min(1, (line - box.top) / (box.height || 1))),
      };
    }
    // Above the first passage, you are at the start of the first passage.
    return best ?? firstPassage(el);
  }, []);

  /**
   * How much of the book you have read, by length of passage.
   *
   * Computed from the passages actually read rather than from scroll position,
   * and weighted by length so a half-page passage does not count for as much
   * as a long one.
   */
  const fraction = useCallback((): number => {
    let total = 0;
    let done = 0;
    for (const p of passages) {
      total += p.text.length;
      done += p.text.length * (read.current.get(p.id) ?? 0);
    }
    return total > 0 ? done / total : 0;
  }, [passages]);

  /**
   * Saves the position, and lets the server read on from there.
   *
   * Skipped when you have hardly moved and the save was not asked for. Moving
   * within a passage does count: a passage of a book is several pages, and
   * saving only on entering one put you back at its top every time you
   * came back.
   */
  const save = useCallback(
    async (force = false) => {
      const measured = currentPassage();
      if (measured) lastPosition.current = measured;
      const at = measured ?? lastPosition.current;
      const newlyRead = [...pendingRead.current];
      // Nothing moved and nothing was read: no reason to say anything.
      if (!at) return;
      const was = lastSaved.current;
      const moved = !was || was.id !== at.id || Math.abs(was.offset - at.offset) > 0.02;
      if (!force && !moved && newlyRead.length === 0) return;
      lastSaved.current = at;
      pendingRead.current.clear();

      try {
        const res = await fetch(`/api/sources/${sourceId}/position`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chunkId: at.id,
            offset: at.offset,
            read: newlyRead.filter(([, share]) => share >= 1).map(([id]) => id),
            partly: newlyRead
              .filter(([, share]) => share < 1)
              .map(([chunkId, share]) => ({ chunkId, share })),
          }),
          // Survives the page going away mid-request, which is exactly when
          // the unmount flush sends it.
          keepalive: true,
        });
        const data = (await res.json()) as { remaining?: number };
        if (typeof data.remaining === "number") setPending(data.remaining);
      } catch {
        // Losing a save to a dropped request is survivable — but the passages
        // it was carrying go back in the queue rather than being forgotten.
        for (const [id, share] of newlyRead) {
          if (share > (pendingRead.current.get(id) ?? 0)) pendingRead.current.set(id, share);
        }
      }
    },
    [sourceId, currentPassage]
  );

  // Remembered per browser, because a 600-page book and a news article do not
  // want the same settings.
  useEffect(() => {
    try {
      const raw = localStorage.getItem("corpus.reader");
      if (raw) {
        const saved = JSON.parse(raw) as Partial<Prefs>;
        const merged = { ...DEFAULTS, ...saved };
        // Justified became the default. A stored `false` from before that was
        // never a choice, only the old default, so let the new one win once —
        // the toggle is still there for anyone who prefers a ragged edge.
        if ((saved.v ?? 1) < 2) merged.justify = DEFAULTS.justify;
        merged.v = DEFAULTS.v;
        setPrefs(merged);
      }
      const v = localStorage.getItem(viewKey(sourceId));
      if (v === "page" || v === "text") setView(v);
    } catch {
      /* first run */
    }
    setReady(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (ready) localStorage.setItem("corpus.reader", JSON.stringify(prefs));
  }, [prefs, ready]);

  /**
   * Picks up where you left off, before the first paint you see.
   *
   * This used to be a banner with a button, on the theory that jumping someone
   * into the middle of a book is presumptuous. In practice you press it every
   * single time, and the one time you don't you scroll for a minute looking for
   * your place. So it restores, and says so, and offers the way back to the top.
   */
  /**
   * Returns to a place instantly, without the banner — for switching between
   * the pages and the text, where the place is the one you were just at.
   */
  const jumpNow = useCallback((at: { id: number; offset: number }) => {
    const el = scroller.current;
    const target = el?.querySelector<HTMLElement>(`section[data-chunk="${at.id}"]`);
    if (!el || !target) return;
    el.scrollTop = target.offsetTop - READING_LINE + (target.offsetHeight || 0) * at.offset;
    lastJump.current = { at, top: el.scrollTop };
  }, []);

  /**
   * The last place returned to, and where the page was left. The page view
   * regroups its pages by passage once it has found the text on them, which
   * moves where a passage begins; a place restored before that is restored
   * again, unless you have scrolled away from it since.
   */
  const lastJump = useRef<{ at: { id: number; offset: number }; top: number } | null>(null);

  const restorePosition = useCallback((): (() => void) | undefined => {
    const el = scroller.current;
    if (!el) return;
    restoredOnce.current = true;

    // A passage asked for by the link that opened the reader comes first;
    // otherwise the place you left off.
    const asked =
      initialChunk !== null
        ? el.querySelector<HTMLElement>(`section[data-chunk="${initialChunk}"]`)
        : null;
    const chunkId = asked ? initialChunk : position.chunkId;
    if (chunkId === null) return;

    const target = asked ?? el.querySelector<HTMLElement>(`section[data-chunk="${chunkId}"]`);
    if (!target) return;

    const into = asked ? 0 : (target.offsetHeight || 0) * (position.offset ?? 0);
    el.scrollTop = target.offsetTop - READING_LINE + into;
    lastJump.current = { at: { id: chunkId, offset: asked ? 0 : position.offset ?? 0 }, top: el.scrollTop };
    lastSaved.current = { id: chunkId, offset: asked ? 0 : position.offset ?? 0 };
    setProgress(fraction());

    const seq = passages.find((p) => p.id === chunkId)?.seq;
    const where = seq === undefined ? "where you left off" : `passage ${seq + 1} of ${passages.length}`;
    setRestored(asked ? `${where}, from the link you followed` : where);
    const t = setTimeout(() => setRestored(null), 5000);

    let flash: ReturnType<typeof setTimeout> | null = null;
    if (asked) {
      target.classList.add("chunk-flash");
      flash = setTimeout(() => target.classList.remove("chunk-flash"), 2000);
    }
    return () => {
      clearTimeout(t);
      if (flash) clearTimeout(flash);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The text view is laid out as soon as it renders. The page view says when
  // it is, through `onPagesReady`.
  useLayoutEffect(() => {
    if (!ready || pages) return;
    const at = pendingJump.current;
    if (at) {
      pendingJump.current = null;
      jumpNow(at);
      return;
    }
    if (!restoredOnce.current) return restorePosition();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, pages]);

  const onPagesReady = useCallback(() => {
    const at = pendingJump.current;
    pendingJump.current = null;
    if (at) jumpNow(at);
    else if (!restoredOnce.current) restorePosition();
  }, [jumpNow, restorePosition]);

  const onPagesSettled = useCallback(() => {
    const was = lastJump.current;
    const el = scroller.current;
    if (!was || !el || Math.abs(el.scrollTop - was.top) > 2) return;
    jumpNow(was.at);
  }, [jumpNow]);

  const onPagesFailed = useCallback((why: string) => {
    console.warn("[corpus] page view unavailable:", why);
    setPageFailed(true);
    setVoiceNote("The PDF itself could not be opened, so this is Raazi's text of it.");
  }, []);

  // The reading line and the debounced save hang off one listener on the
  // element that actually moves. Progress does not: it is a fact about what
  // you have read, and scrolling is not reading.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !ready) return;

    const onScroll = () => {
      const at = currentPassage();
      if (at) lastPosition.current = at;
      setHere(at?.id ?? null);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void save(), 1200);
    };

    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      // A save still waiting on its debounce is sent, not thrown away: a
      // passage marked read in the last second before closing must reach
      // the server, and the flush below cannot measure anything by the time
      // it runs.
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
        void save(true);
      }
    };
  }, [ready, save, currentPassage]);

  /**
   * "I have read this far" — everything above the reading line, whatever you
   * scrolled past. Not the rest of the passage the line is in: that can be
   * pages you have not reached.
   */
  const markThroughHere = useCallback(async () => {
    const at = currentPassage();
    if (!at) return;
    const upTo = passages.find((p) => p.id === at.id)?.seq ?? -1;
    for (const p of passages) {
      const share = p.seq < upTo ? 1 : p.id === at.id ? at.offset : 0;
      if (share > (read.current.get(p.id) ?? 0)) read.current.set(p.id, share);
    }
    setReadCount(finishedCount(read.current));
    setProgress(fraction());
    lastSaved.current = at;

    const res = await fetch(`/api/sources/${sourceId}/position`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chunkId: at.id,
        offset: at.offset,
        through: at.id,
        throughShare: at.offset,
      }),
    });
    const data = (await res.json()) as { remaining?: number };
    if (typeof data.remaining === "number") setPending(data.remaining);
  }, [sourceId, currentPassage, passages, fraction]);

  // Leaving counts as stopping, however you leave.
  useEffect(() => {
    if (!ready) return;
    const flush = () => void save(true);
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      flush();
    };
  }, [ready, save]);

  const page = useCallback((dir: 1 | -1) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollBy({ top: dir * el.clientHeight * 0.86, behavior: "smooth" });
  }, []);

  /**
   * Brings a paragraph to the reading line without jolting the page.
   *
   * Measured with rectangles rather than `offsetTop`, which is relative to the
   * nearest *positioned* ancestor — and each passage is `position: relative` so
   * it can hold the bookmark marker in its margin. A paragraph's offsetTop is
   * therefore its distance from the top of its own passage, usually under a
   * hundred pixels, which scrolled the book back to the beginning every time.
   */
  const showParagraph = useCallback((index: number) => {
    const el = scroller.current;
    // On a PDF's pages a paragraph that could not be found there has no place
    // of its own; its passage's pages are the nearest thing.
    const target =
      el?.querySelector<HTMLElement>(`[data-para="${index}"]`) ??
      (paragraphs[index]
        ? el?.querySelector<HTMLElement>(`section[data-chunk="${paragraphs[index].chunkId}"]`)
        : null);
    if (!el || !target) return;
    const delta = target.getBoundingClientRect().top - el.getBoundingClientRect().top;
    // A third of the way down rather than the very top: a paragraph pinned to
    // the ceiling with the rest of the screen empty below it reads as broken.
    softScrollTo(el, Math.max(0, el.scrollTop + delta - el.clientHeight * 0.32), glide);
  }, [glide, paragraphs]);

  const switchView = useCallback(
    (next: View) => {
      const at = currentPassage();
      if (at) pendingJump.current = at;
      setView(next);
      try {
        localStorage.setItem(viewKey(sourceId), next);
      } catch {
        /* remembered for this sitting only */
      }
    },
    [currentPassage, sourceId]
  );

  /** The book's passages as the page view needs them. */
  const pageBlocks = useMemo<PageBlock[]>(() => {
    const pageOf = new Map(passages.map((p) => [p.id, p.page ?? null]));
    let first = 0;
    return blocks.map((b) => {
      const out = {
        key: b.key,
        chunkId: b.chunkId,
        page: pageOf.get(b.chunkId) ?? null,
        paragraphs: b.paragraphs,
        first,
        divider: b.divider,
        mentions: b.mentions,
      };
      first += b.paragraphs.length;
      return out;
    });
  }, [blocks, passages]);

  /**
   * "I have read this one." The only thing in the reader that records progress.
   *
   * Every paragraph counts, as its share of the passage it is in — a passage
   * runs to several pages, and counting only its last paragraph meant whole
   * sittings recorded nothing. Recording it is also what releases the passage
   * to the extraction queue on a read-along book. Both happen here, in one
   * place, because you said so.
   */
  const finishParagraph = useCallback(() => {
    // Read from the updater rather than from the closure: pressing the button
    // three times quickly would otherwise advance one paragraph, because all
    // three handlers were created in the same render and see the same cursor.
    setCursor((at) => {
      const current = paragraphs[at];
      if (!current) return at;

      if (current.upto > (read.current.get(current.chunkId) ?? 0)) {
        read.current.set(current.chunkId, current.upto);
        pendingRead.current.set(current.chunkId, current.upto);
        setReadCount(finishedCount(read.current));
        setProgress(fraction());
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => void save(true), 600);
      }
      return Math.min(at + 1, paragraphs.length - 1);
    });
  }, [paragraphs, fraction, save]);

  const goBack = useCallback(() => {
    setCursor((at) => Math.max(0, at - 1));
  }, []);

  const blockByKey = useMemo(() => new Map(blocks.map((b) => [b.key, b])), [blocks]);

  /** The words of one paragraph, by its position in the whole book. */
  const textAt = useCallback(
    (i: number) => {
      const p = paragraphs[i];
      if (!p) return "";
      return blockByKey.get(p.blockKey)?.paragraphs[p.index] ?? "";
    },
    [paragraphs, blockByKey]
  );

  /**
   * The paragraph the reading line is sitting on.
   *
   * Needed because in scroll mode the cursor is not maintained — nothing moves
   * it, since nothing lights a paragraph. Pressing Listen has to begin where
   * your eye is, and without this it began at the first paragraph of the book
   * however far in you were.
   */
  const paragraphAtReadingLine = useCallback(() => {
    const el = scroller.current;
    if (!el) return 0;
    const line = el.getBoundingClientRect().top + el.clientHeight * 0.3;
    for (const node of el.querySelectorAll<HTMLElement>("[data-para]")) {
      if (node.getBoundingClientRect().bottom >= line) return Number(node.dataset.para) || 0;
    }
    return 0;
  }, []);

  /**
   * Reads the current paragraph aloud, then moves on.
   *
   * `paused` is deliberately not a dependency. Putting it here would tear down
   * the utterance and start the paragraph again from its first word every time
   * you paused and resumed, which is not what either word means; holding and
   * releasing is handled below, on the synthesiser itself.
   *
   * The cleanup silences whatever is speaking, and Speaker.stop disowns its
   * callback as it does so — otherwise stopping playback would fire the same
   * onDone as reaching the end of a paragraph and advance the book past
   * something you never heard.
   */
  useEffect(() => {
    const s = speaker.current;
    const o = online.current;
    if (!listening || !ready || !s) return;

    const text = textAt(cursor);
    if (!text.trim()) {
      // A blank or a divider: step over it rather than stopping.
      if (cursor < paragraphs.length - 1) finishParagraph();
      else setListening(false);
      return;
    }

    const onDone = () => {
      if (cursor >= paragraphs.length - 1) setListening(false);
      else finishParagraph();
    };
    const onMachine = (voice: Voice | null) => {
      const native =
        voice && typeof window !== "undefined" && window.speechSynthesis
          ? window.speechSynthesis.getVoices().find((v) => v.voiceURI === voice.uri) ?? null
          : null;
      spokenVoice.current = native?.voiceURI ?? null;
      s.speak(text, { voice: native, rate: prefs.rate, onDone });
    };

    const wanted = pickVoice(voicesRef.current, langOf(text), prefs.voice);
    if (wanted && isNatural(wanted) && o?.supported) {
      spokenVoice.current = wanted.uri;
      o.speak(text, {
        voice: wanted.uri.slice(NATURAL.length),
        rate: prefs.rate,
        onDone,
        // The service is unofficial and can go away; the book carries on in a
        // voice on the machine rather than stopping mid-chapter.
        onFail: (err) => {
          console.warn("[corpus] Natural voice unavailable:", err.message);
          setVoiceNote("The Natural voice could not be reached, so a voice on this machine is reading.");
          const machine = voicesRef.current.filter((v) => !isNatural(v));
          onMachine(pickVoice(machine, langOf(text)));
        },
      });
      // The next paragraph, fetched while this one plays, so there is no
      // pause for the round trip between them.
      const next = textAt(cursor + 1);
      const nextVoice = next.trim() ? pickVoice(voicesRef.current, langOf(next), prefs.voice) : null;
      if (nextVoice && isNatural(nextVoice)) {
        o.prefetch(next, { voice: nextVoice.uri.slice(NATURAL.length), rate: prefs.rate });
      }
    } else {
      onMachine(wanted);
    }

    return () => {
      s.stop();
      o?.stop();
    };
  }, [
    listening,
    cursor,
    ready,
    voiceEpoch,
    prefs.voice,
    prefs.rate,
    textAt,
    finishParagraph,
    paragraphs.length,
  ]);

  // Holding and releasing, without losing your place in the sentence.
  useEffect(() => {
    const s = speaker.current;
    if (!s || !listening) return;
    // Both, since either may be the one speaking; the idle one ignores it.
    if (paused) {
      s.pause();
      online.current?.pause();
    } else {
      s.resume();
      online.current?.resume();
    }
  }, [paused, listening]);

  /**
   * Keeps the paragraph being spoken on screen in scroll mode.
   *
   * Reading mode already follows the cursor; ordinary scrolling does not, so
   * without this the voice walks off down the book while the page sits still.
   */
  useEffect(() => {
    if (!listening || !ready || prefs.mode === "focus") return;
    showParagraph(cursor);
  }, [listening, cursor, ready, prefs.mode, showParagraph]);

  // The voices the machine has, once the browser admits to them.
  useEffect(() => watchVoices(setMachineVoices), []);

  // And the Natural ones, which the server lists. Asking for the list sends
  // nothing of the book; only choosing one of these voices does.
  useEffect(() => {
    let live = true;
    fetch("/api/speech/voices")
      .then((res) => (res.ok ? res.json() : { voices: [] }))
      .then((data: { voices?: { id: string; name: string; lang: string }[] }) => {
        if (live) setNaturalVoices((data.voices ?? []).map(naturalVoice));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!voiceNote) return;
    const t = setTimeout(() => setVoiceNote(null), 6000);
    return () => clearTimeout(t);
  }, [voiceNote]);

  useEffect(() => {
    voicesRef.current = voices;
    if (!listening) return;
    const using = spokenVoice.current;
    const vanished = using !== null && !voices.some((v) => v.uri === using);
    // Speaking with no voice picked means the list was empty when it began;
    // now that there is one, the right voice may be very different.
    const nowAvailable = using === null && voices.length > 0;
    // The voice you chose arriving after reading began — the Natural list
    // comes from the server, later than the machine's — takes over at once
    // rather than a paragraph later.
    const chosenArrived =
      Boolean(prefs.voice) && using !== prefs.voice && !hadChosen.current && voices.some((v) => v.uri === prefs.voice);
    hadChosen.current = voices.some((v) => v.uri === prefs.voice);
    if (vanished || nowAvailable || chosenArrived) setVoiceEpoch((e) => e + 1);
  }, [voices, listening, prefs.voice]);

  // Leaving the reader must not leave a voice talking to an empty room.
  useEffect(
    () => () => {
      speaker.current?.stop();
      online.current?.stop();
    },
    []
  );

  const toggleListening = useCallback(() => {
    if (listening) {
      setListening(false);
      setPaused(false);
      return;
    }
    // Begin where the eye is, not where the cursor was last left.
    if (prefs.mode !== "focus") setCursor(paragraphAtReadingLine());
    setPaused(false);
    setListening(true);
  }, [listening, prefs.mode, paragraphAtReadingLine]);

  /**
   * Holds the page still while you read.
   *
   * `overflow: hidden` already removes the scrollbar and the wheel's effect on
   * this element, but a wheel event it does not consume keeps travelling and
   * scrolls whatever is behind — so the page you came from creeps along under a
   * reader that looks frozen, and closing it drops you somewhere unexpected.
   * Refusing the gesture outright is both more honest and what was asked for.
   *
   * Registered non-passively on purpose: a passive listener is forbidden from
   * calling preventDefault, and browsers assume wheel and touchmove are passive
   * unless told otherwise.
   */
  useEffect(() => {
    const el = scroller.current;
    if (!el || prefs.mode !== "focus" || overflowing) return;

    const refuse = (e: Event) => e.preventDefault();
    el.addEventListener("wheel", refuse, { passive: false });
    el.addEventListener("touchmove", refuse, { passive: false });
    return () => {
      el.removeEventListener("wheel", refuse);
      el.removeEventListener("touchmove", refuse);
    };
  }, [prefs.mode, overflowing]);

  /**
   * Keeps the lit paragraph in view.
   *
   * Driven by the committed cursor rather than from inside the click handler.
   * Scheduling the scroll from within a state updater looked equivalent and was
   * not: the cursor advanced and the page never moved, because work queued from
   * a render-phase updater is not guaranteed to survive to the commit. An effect
   * on the value that actually changed always runs, exactly once, after the DOM
   * has been updated — which is also when the paragraph is where it will stay.
   */
  useEffect(() => {
    if (!ready || prefs.mode !== "focus") return;
    showParagraph(cursor);

    // Decide whether this one needs the freedom to scroll. Measured after the
    // glide rather than before it, because a paragraph is only unreachable
    // relative to where it has been placed.
    const el = scroller.current;
    const target = el?.querySelector<HTMLElement>(`[data-para="${cursor}"]`);
    if (!el || !target) return;
    const check = setTimeout(() => {
      // The room it has: the screen below the reading line, less the advance
      // bar at the foot.
      const room = el.clientHeight - el.clientHeight * 0.32 - 96;
      setOverflowing(target.offsetHeight > room);
    }, 460);
    return () => clearTimeout(check);
  }, [cursor, ready, prefs.mode, showParagraph]);

  /**
   * Entering reading mode picks up at the first paragraph you have not read.
   *
   * Anything else would be wrong in an obvious way: starting at the top means
   * re-reading a book you are halfway through, and starting where the scroll
   * position happens to be means starting mid-sentence.
   */
  useEffect(() => {
    if (!ready || prefs.mode !== "focus") return;
    // The first paragraph not wholly inside what is already read of its passage.
    const firstUnread = paragraphs.findIndex(
      (p) => (read.current.get(p.chunkId) ?? 0) < p.upto - 1e-6
    );
    setCursor(firstUnread < 0 ? paragraphs.length - 1 : firstUnread);
    // The scroll itself is the effect above, which follows the cursor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefs.mode, ready]);

  const jumpTo = useCallback((chunkId: number, offset = 0) => {
    const el = scroller.current;
    const target = el?.querySelector<HTMLElement>(`section[data-chunk="${chunkId}"]`);
    if (!el || !target) return;
    el.scrollTo({
      top: target.offsetTop - READING_LINE + (target.offsetHeight || 0) * offset,
      behavior: "smooth",
    });
  }, []);

  const toggleMark = useCallback(async () => {
    const at = currentPassage();
    if (!at) return;
    const block = blocks.find((b) => b.chunkId === at.id);
    const res = await fetch(`/api/sources/${sourceId}/bookmarks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chunkId: at.id,
        offset: at.offset,
        excerpt: block?.paragraphs[0]?.slice(0, 200) ?? null,
      }),
    });
    const data = (await res.json()) as { bookmarks: Mark[] };
    setBookmarks(data.bookmarks ?? []);
  }, [sourceId, currentPassage, blocks]);

  const removeMark = useCallback(
    async (id: number) => {
      const res = await fetch(`/api/sources/${sourceId}/bookmarks?bookmark=${id}`, {
        method: "DELETE",
      });
      const data = (await res.json()) as { bookmarks: Mark[] };
      setBookmarks(data.bookmarks ?? []);
    },
    [sourceId]
  );

  /**
   * Selecting a word offers its definition.
   *
   * Only for something that actually looks like a word or short phrase — a
   * dragged-out paragraph is a copy, not a question, and popping a dictionary
   * over it would be an interruption rather than a feature. Double-clicking a
   * word is the usual way in, and that lands here too.
   */
  useEffect(() => {
    const el = scroller.current;
    if (!el || !ready) return;

    const onUp = () => {
      // Deferred a tick: on a double-click the selection is not final yet.
      setTimeout(() => {
        const sel = window.getSelection();
        const raw = sel?.toString().trim() ?? "";
        if (!sel || sel.isCollapsed || !raw) {
          setLookup(null);
          setSend(null);
          return;
        }
        const box = sel.getRangeAt(0).getBoundingClientRect();
        if (!box.width && !box.height) return;
        const anchor = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement;
        // On a PDF's page, what the browser selected is the page's text as
        // pdf.js laid it out — a break at every line end, a hyphen in every
        // broken word. It is taken back to Raazi's text of the same words.
        const onPage = anchor?.closest?.(".textLayer") ? pdfApi.current : null;
        const text = onPage ? tidySelection(raw) : raw;
        // The paragraph it was in, should you ask for a literature review of it.
        selectionContext.current =
          anchor?.closest?.("p, li, blockquote, h1, h2, h3, h4, section[data-chunk]")?.textContent?.slice(0, 6000) ?? undefined;

        // Up to three words, and nothing with sentence punctuation in it, is a
        // word to look up. Anything longer is a passage, and a passage you have
        // dragged out is one you may want on the writing desk — offered beside
        // the selection, sent with one click, cited to this place in this
        // source. It replaces copying it out and pasting it there by hand.
        const wordish = text.length <= 40 && text.split(/\s+/).length <= 3 && !/[.!?؟،,;:]/.test(text);
        if (!wordish) {
          if (text.length < 12) return;
          const node = sel.anchorNode instanceof Element ? sel.anchorNode : sel.anchorNode?.parentElement;
          const chunk = node?.closest?.("section[data-chunk]")?.getAttribute("data-chunk");
          const chunkId = chunk ? Number(chunk) : null;
          setLookup(null);
          if (onPage) {
            const found = onPage.resolve(raw, chunkId);
            selectionContext.current = found.context?.slice(0, 6000);
            setSend({ text: found.text, chunkId: found.chunkId, x: box.left + box.width / 2, y: box.top });
          } else {
            setSend({ text, chunkId, x: box.left + box.width / 2, y: box.top });
          }
          return;
        }
        setSend(null);
        if (onPage) {
          // The paragraph it is in, from the text rather than the whole page.
          const chunk = anchor?.closest?.("section[data-chunk]")?.getAttribute("data-chunk");
          selectionContext.current = onPage.resolve(raw, chunk ? Number(chunk) : null).context?.slice(0, 6000);
        }
        setLookup({ word: text, x: box.left + box.width / 2, y: box.top });
      }, 0);
    };

    el.addEventListener("mouseup", onUp);
    return () => el.removeEventListener("mouseup", onUp);
  }, [ready]);

  // Space and arrows page through, the way a reader expects. B marks the place.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A shortcut with a modifier is someone else's shortcut.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement;
      // Its own controls first: Enter on a focused button presses the button,
      // arrows on the chapter select open the list. Only Escape reaches past
      // them, and a dialog handles that itself.
      const control = target.closest?.(
        'button, select, a[href], input, textarea, [contenteditable="true"], [role="dialog"]'
      );
      if (control && (e.key !== "Escape" || control.matches('[role="dialog"], input, textarea'))) {
        return;
      }
      if (e.key === " " || e.key === "PageDown" || e.key === "ArrowDown" || e.key === "Enter") {
        e.preventDefault();
        // In reading mode the space bar means "done with this one", which is the
        // whole gesture the mode exists for — one key, one paragraph, no
        // opportunity to go wandering.
        if (prefs.mode === "focus") {
          if (e.shiftKey) goBack();
          else finishParagraph();
        } else {
          page(e.shiftKey ? -1 : 1);
        }
      } else if (e.key === "PageUp" || e.key === "ArrowUp") {
        e.preventDefault();
        if (prefs.mode === "focus") goBack();
        else page(-1);
      } else if (prefs.mode === "focus" && !overflowing && (e.key === "Home" || e.key === "End")) {
        // The last two keys that would have thrown you across the book.
        e.preventDefault();
      } else if (e.key === "b" || e.key === "B") {
        e.preventDefault();
        void toggleMark();
      } else if (e.key === "Escape") {
        // Innermost thing first: the dictionary or the send card, then a panel, then the reader.
        if (lookup) setLookup(null);
        else if (send) setSend(null);
        else if (panel !== "none") setPanel("none");
        else onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [page, toggleMark, panel, onClose, lookup, send, prefs.mode, finishParagraph, goBack, overflowing]);

  if (!ready) return null;

  const hereIsMarked = here !== null && marked.has(here);

  /**
   * The reader is rendered straight into <body>, not where it sits in the tree.
   *
   * `z-40` only outranks the navigation rail's `z-30` if the two are compared
   * in the same stacking context, and they were not: the page wrapper fades in,
   * an element with opacity below 1 forms a stacking context, and the reader's
   * z-index was therefore being resolved *inside* that wrapper. The wrapper is
   * static and unpositioned, so a fixed rail at body level painted over the
   * whole book — the text was all there, full width and correct, with the first
   * seventy pixels of every line hidden behind the navigation.
   *
   * Moving it to the body ends the argument rather than winning it. It is also
   * proof against the same class of accident later: no ancestor's transform,
   * filter, opacity or containment can reach it now.
   */
  return createPortal(
    <div
      ref={scroller}
      className="fixed inset-0 z-40"
      style={{
        background: theme.bg,
        color: theme.fg,
        // Reading mode takes the scrollbar away entirely. `overflow: hidden`
        // still permits programmatic scrolling, so the glide between paragraphs
        // works exactly as before — what stops is you: the wheel, the drag, the
        // scrollbar and the fling. That is the whole point of the mode, and
        // leaving a way to slip out of it would defeat it.
        //
        // Except when the paragraph is taller than the screen, where a freeze
        // would hide the end of what you are trying to read.
        overflowY: prefs.mode === "focus" && !overflowing ? "hidden" : "auto",
        // A book never scrolls sideways. Without this, anything too wide for a
        // phone — the row of controls in the header, most obviously — made the
        // whole reader scrollable horizontally, and a single sideways flick
        // pushed the text off under the navigation rail with every line cut off
        // at its first few characters.
        overflowX: "hidden",
      }}
    >
      {/* Progress along the top, so you know how far in you are. */}
      <div
        className="fixed left-0 top-0 z-50 h-0.5 transition-[width] duration-150"
        style={{ width: `${progress * 100}%`, background: theme.fg, opacity: 0.35 }}
      />

      <header
        className="sticky top-0 z-40 backdrop-blur"
        style={{ background: `${theme.bg}e6`, borderBottom: `1px solid ${theme.rule}` }}
      >
        {/* Wraps rather than overflows. Nine controls do not fit across a phone
            in any arrangement, so on a narrow screen the title keeps the first
            line and the controls take the second. */}
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-2 gap-y-1.5 px-4 py-2 text-sm sm:px-5">
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <button
              onClick={onClose}
              style={{ color: theme.muted }}
              className="shrink-0 hover:opacity-70"
              title="Back to the library"
            >
              ←<span className="hidden sm:inline"> Library</span>
            </button>
            <span className="min-w-0 flex-1 truncate" style={{ color: theme.muted }}>
              {title}
              {author ? ` · ${author}` : ""}
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
          {readAlong.on && (
            <span
              className="hidden tabular-nums sm:inline"
              style={{ color: theme.muted }}
              title={
                pending > 0
                  ? `Raazi is ${pending} passage(s) behind you. It reads what you have read, not the whole book.`
                  : "Raazi has read everything you have."
              }
            >
              {pending > 0 ? `${pending} behind` : "caught up"}
            </span>
          )}

          <span
            className="tabular-nums"
            style={{ color: theme.muted }}
            title={`${readCount} of ${passages.length} passages read. Counted only from passages you finished — scrolling records nothing.`}
          >
            {Math.round(progress * 100)}%
          </span>

          {pdf && !pageFailed && (
            <span
              className="flex overflow-hidden rounded"
              style={{ border: `1px solid ${theme.rule}` }}
              title="The PDF's own pages, or Raazi's text of it"
            >
              {(["page", "text"] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => view !== v && switchView(v)}
                  aria-pressed={view === v}
                  className="px-2 py-1 hover:opacity-70"
                  style={view === v ? { background: theme.fg, color: theme.bg } : { color: theme.muted }}
                >
                  {v === "page" ? "Page" : "Text"}
                </button>
              ))}
            </span>
          )}

          <button
            onClick={() =>
              setPrefs({ ...prefs, mode: prefs.mode === "focus" ? "scroll" : "focus" })
            }
            className="rounded px-2 py-1 hover:opacity-70"
            style={
              prefs.mode === "focus"
                ? { background: theme.fg, color: theme.bg }
                : { border: `1px solid ${theme.rule}` }
            }
            title="One paragraph at a time, advanced only when you say so"
          >
            {/* Two words is a luxury a phone header cannot afford. */}
            <span className="hidden sm:inline">Reading mode</span>
            <span className="sm:hidden">Focus</span>
          </button>

          {prefs.mode !== "focus" && (
            <button
              onClick={() => void markThroughHere()}
              className="rounded px-2 py-1 hover:opacity-70"
              style={{ border: `1px solid ${theme.rule}` }}
              title="Count everything up to here as read"
            >
              <span className="hidden sm:inline">Read to here</span>
              <span className="sm:hidden">To here</span>
            </button>
          )}

          {canSpeak && (
            <>
              <button
                onClick={toggleListening}
                className="rounded px-2 py-1 hover:opacity-70"
                style={
                  listening
                    ? { background: theme.fg, color: theme.bg }
                    : { border: `1px solid ${theme.rule}` }
                }
                title={
                  listening
                    ? "Stop reading aloud"
                    : "Read aloud from here, using a voice on this machine"
                }
              >
                {listening ? "◼ Stop" : "▶ Listen"}
              </button>
              {listening && (
                <button
                  onClick={() => setPaused((v) => !v)}
                  className="rounded px-2 py-1 hover:opacity-70"
                  style={{ border: `1px solid ${theme.rule}` }}
                  title={paused ? "Carry on" : "Hold it there"}
                >
                  {paused ? "▶" : "❙❙"}
                </button>
              )}
            </>
          )}

          <button
            onClick={() => void toggleMark()}
            className="rounded px-2 py-1 hover:opacity-70"
            style={
              hereIsMarked
                ? { background: theme.fg, color: theme.bg }
                : { border: `1px solid ${theme.rule}` }
            }
            title={hereIsMarked ? "Remove this bookmark (B)" : "Bookmark this place (B)"}
          >
            {hereIsMarked ? "Marked" : "Mark"}
          </button>
          <button
            onClick={() => setPanel((p) => (p === "marks" ? "none" : "marks"))}
            className="rounded px-2 py-1 tabular-nums hover:opacity-70"
            style={{ border: `1px solid ${theme.rule}` }}
            aria-expanded={panel === "marks"}
            title="Your bookmarks in this source"
          >
            ▤ {bookmarks.length}
          </button>
          <button
            onClick={() => setPanel((p) => (p === "type" ? "none" : "type"))}
            className="rounded px-2 py-1 hover:opacity-70"
            style={{ border: `1px solid ${theme.rule}` }}
            aria-expanded={panel === "type"}
          >
            Aa
          </button>
          </div>
        </div>

        {panel === "type" && (
          <div className="mx-auto max-w-5xl px-5 pb-3" style={{ borderTop: `1px solid ${theme.rule}` }}>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-3 pt-3 text-sm">
              {pages ? (
                <Stepper
                  label="Zoom"
                  value={prefs.zoom}
                  onChange={(zoom) => setPrefs({ ...prefs, zoom })}
                  min={50}
                  max={250}
                  step={10}
                  theme={theme}
                  suffix="%"
                />
              ) : (
                <>
                  <Stepper
                    label="Text"
                    value={prefs.size}
                    onChange={(size) => setPrefs({ ...prefs, size })}
                    min={14}
                    max={30}
                    theme={theme}
                    suffix="px"
                  />
                  <Stepper
                    label="Width"
                    value={prefs.measure}
                    onChange={(measure) => setPrefs({ ...prefs, measure })}
                    min={24}
                    max={52}
                    theme={theme}
                    suffix="em"
                  />
                </>
              )}
              <Segmented
                value={prefs.theme}
                options={[
                  ["paper", "Paper"],
                  ["sepia", "Sepia"],
                  ["night", "Night"],
                ]}
                onChange={(v) => setPrefs({ ...prefs, theme: v as Prefs["theme"] })}
                theme={theme}
              />
              {!pages && (
                <Toggle
                  label="Serif"
                  on={prefs.serif}
                  onChange={(serif) => setPrefs({ ...prefs, serif })}
                  theme={theme}
                />
              )}
              {canSpeak && (
                <VoicePicker
                  voices={voices}
                  sample={textAt(cursor) || title}
                  chosen={prefs.voice}
                  rate={prefs.rate}
                  onVoice={(voice) => setPrefs({ ...prefs, voice })}
                  onRate={(rate) => setPrefs({ ...prefs, rate })}
                  theme={theme}
                />
              )}
              {!pages && (
                <Toggle
                  label="Justify"
                  on={prefs.justify}
                  onChange={(justify) => setPrefs({ ...prefs, justify })}
                  theme={theme}
                />
              )}
              <Toggle
                label="Show entities"
                on={prefs.highlights}
                onChange={(highlights) => setPrefs({ ...prefs, highlights })}
                theme={theme}
              />
            </div>

            {chapters.length > 1 && (
              <select
                className="mt-3 w-full rounded px-2 py-1.5 text-sm"
                style={{ background: theme.bg, color: theme.fg, border: `1px solid ${theme.rule}` }}
                onChange={(e) => {
                  const sc = scroller.current;
                  if (!sc) return;
                  // A chapter not found on the PDF's pages is jumped to by its passage.
                  const chunkId = blocks.find((b) => b.key === e.target.value)?.chunkId;
                  const el =
                    sc.querySelector<HTMLElement>(`#${CSS.escape(e.target.value)}`) ??
                    sc.querySelector<HTMLElement>(`section[data-chunk="${chunkId}"]`);
                  if (!el) return;
                  // Measured as rectangles: on the pages, the anchor sits inside
                  // a positioned page, so its offsetTop is from the page's top.
                  const top = sc.scrollTop + el.getBoundingClientRect().top - sc.getBoundingClientRect().top;
                  sc.scrollTo({ top: top - READING_LINE, behavior: "smooth" });
                }}
                defaultValue=""
              >
                <option value="" disabled>
                  Jump to…
                </option>
                {chapters.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}

        {panel === "marks" && (
          <div
            className="mx-auto max-w-5xl px-5 pb-3 pt-3 text-sm"
            style={{ borderTop: `1px solid ${theme.rule}` }}
          >
            {bookmarks.length === 0 ? (
              <p style={{ color: theme.muted }}>
                No bookmarks in this one yet. Press <kbd>B</kbd> anywhere to mark where you are.
              </p>
            ) : (
              <ul className="max-h-72 space-y-1 overflow-y-auto">
                {bookmarks.map((b) => (
                  <li key={b.id} className="flex items-start gap-3">
                    <button
                      className="min-w-0 flex-1 rounded px-2 py-1.5 text-left hover:opacity-70"
                      style={{ border: `1px solid ${theme.rule}` }}
                      onClick={() => {
                        jumpTo(b.chunk_id, b.offset);
                        setPanel("none");
                      }}
                    >
                      <span className="tabular-nums" style={{ color: theme.muted }}>
                        {b.seq + 1}.
                      </span>{" "}
                      <span dir={dirOf(b.excerpt ?? "")}>
                        {b.excerpt ? truncate(b.excerpt, 110) : "—"}
                      </span>
                    </button>
                    <button
                      onClick={() => void removeMark(b.id)}
                      className="mt-1.5 shrink-0 hover:opacity-70"
                      style={{ color: theme.muted }}
                      aria-label="Remove this bookmark"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </header>

      {voiceNote && (
        <div
          className="sticky top-[3.1rem] z-30 mx-auto max-w-5xl px-5 py-2 text-[0.8rem]"
          style={{ color: theme.muted }}
          role="status"
        >
          {voiceNote}
        </div>
      )}

      {restored && (
        <div
          className="sticky top-[3.1rem] z-30 mx-auto flex max-w-5xl items-center justify-between gap-3 px-5 py-2 text-[0.8rem]"
          style={{ color: theme.muted }}
        >
          <span>Picked up at {restored}.</span>
          <button
            className="rounded px-2 py-0.5 hover:opacity-70"
            style={{ border: `1px solid ${theme.rule}` }}
            onClick={() => {
              scroller.current?.scrollTo({ top: 0, behavior: "smooth" });
              setRestored(null);
            }}
          >
            Start from the top
          </button>
        </div>
      )}

      {pages ? (
        // Room at the foot, in reading mode, for the last paragraph to reach
        // the reading line, as the text view has.
        <div className={prefs.mode === "focus" ? "pb-[60vh]" : undefined}>
          <PdfPages
            sourceId={sourceId}
            blocks={pageBlocks}
            scroller={scroller}
            zoom={prefs.zoom}
            cursor={cursor}
            focus={prefs.mode === "focus"}
            speaking={listening}
            theme={theme}
            themeName={prefs.theme}
            highlights={prefs.highlights}
            onOpenEntity={setOpenEntity}
            onReady={onPagesReady}
            onSettled={onPagesSettled}
            onFail={onPagesFailed}
            api={pdfApi}
          />
        </div>
      ) : (
      <article
        // Room at the foot for the advance bar, and enough beyond it that the
        // last paragraph can still be scrolled up to the reading line.
        className={prefs.mode === "focus" ? "mx-auto px-5 pb-[70vh] pt-10" : "mx-auto px-5 pb-40 pt-10"}
        style={{
          maxWidth: `${prefs.measure}em`,
          fontSize: `${prefs.size}px`,
          lineHeight: 1.72,
          // Both stacks lead with Amiri, which claims only the Arabic
          // codepoints — so the serif switch still switches the English and an
          // Arabic book is set in Amiri either way.
          fontFamily: prefs.serif ? "var(--font-serif)" : "var(--font-sans)",
          textAlign: prefs.justify ? "justify" : "start",
          // Hyphenation is what keeps justified prose from opening rivers of
          // whitespace; without it a narrow measure looks broken.
          hyphens: prefs.justify ? "auto" : "manual",
          textWrap: "pretty",
          overflowWrap: "break-word",
        }}
      >
        <h1
          className="mb-1 text-[1.6em] font-semibold leading-tight"
          style={{ fontFamily: "var(--font-serif)" }}
        >
          {title}
        </h1>
        {author && (
          <p className="mb-10 text-[0.85em]" style={{ color: theme.muted }}>
            {author}
          </p>
        )}

        {blocks.map((b) => (
          <section
          key={b.key}
          id={b.key}
          data-chunk={b.chunkId}
          className="relative"
          style={{ opacity: 1 }}
        >
            {marked.has(b.chunkId) && (
              <span
                aria-label="Bookmarked"
                title="Bookmarked"
                className="absolute -left-6 top-1 hidden select-none sm:block"
                style={{ color: theme.fg, opacity: 0.55 }}
              >
                ▌
              </span>
            )}
            {b.divider && (
              <h2
                className="mb-4 mt-12 text-[0.72em] font-medium uppercase tracking-[0.14em]"
                style={{ color: theme.muted }}
              >
                {b.divider}
              </h2>
            )}
            {b.paragraphs.map((p, i) => {
              // Its position in the whole book, which is what reading mode
              // counts in.
              const at = paraIndex.get(`${b.key}:${i}`) ?? -1;
              return (
                <ReaderParagraph
                  key={i}
                  text={p}
                  at={at}
                  lit={prefs.mode !== "focus" || at === cursor}
                  speaking={listening && at === cursor}
                  indent={i > 0 && !b.divider}
                  highlights={prefs.highlights}
                  mentions={b.mentions}
                  mark={theme.mark}
                  ink={theme.fg}
                  onOpen={setOpenEntity}
                />
              );
            })}
          </section>
        ))}

        <p className="mt-20 text-center text-[0.8em]" style={{ color: theme.muted }}>
          End of {title}.
        </p>
      </article>
      )}

      {/* The advance bar. Fixed to the foot of the screen so the button is in
          the same place every time — the point of the mode is that reading on
          costs one deliberate press and no decisions about where to look. */}
      {prefs.mode === "focus" && (
        <div
          className="fixed inset-x-0 bottom-0 z-40 backdrop-blur"
          style={{ background: `${theme.bg}f2`, borderTop: `1px solid ${theme.rule}` }}
        >
          <div className="mx-auto flex max-w-3xl items-center gap-3 px-5 py-3">
            <button
              onClick={goBack}
              disabled={cursor === 0}
              className="rounded px-3 py-1.5 text-sm disabled:opacity-30"
              style={{ border: `1px solid ${theme.rule}`, color: theme.muted }}
              title="Back a paragraph (Shift+Space)"
            >
              ↑ Back
            </button>

            <span className="flex-1 text-center text-sm tabular-nums" style={{ color: theme.muted }}>
              Paragraph {cursor + 1} of {paragraphs.length}
              {overflowing && (
                <span className="ms-2 text-[0.8em]">· long one, scroll as you need</span>
              )}
            </span>

            {cursor >= paragraphs.length - 1 ? (
              <button
                onClick={finishParagraph}
                className="rounded px-4 py-1.5 text-sm font-medium"
                style={{ background: theme.fg, color: theme.bg }}
              >
                Finished the book
              </button>
            ) : (
              <button
                onClick={finishParagraph}
                className="rounded px-4 py-1.5 text-sm font-medium"
                style={{ background: theme.fg, color: theme.bg }}
                title="Mark this paragraph read and move on (Space)"
              >
                Finished reading ↓
              </button>
            )}
          </div>
        </div>
      )}

      {lookup && (
        <Lookup
          at={lookup}
          theme={theme}
          onClose={() => setLookup(null)}
          onReview={() => {
            setReview({ focus: lookup.word, context: selectionContext.current });
            setLookup(null);
          }}
        />
      )}
      {send && (
        <SendToWrite
          at={send}
          sourceId={sourceId}
          theme={theme}
          onClose={() => setSend(null)}
          onReview={() => {
            setReview({ focus: send.text, context: selectionContext.current });
            setSend(null);
          }}
        />
      )}
      {review && (
        <LitReviewWindow
          target="source"
          id={sourceId}
          focus={review.focus}
          context={review.context}
          onClose={() => setReview(null)}
        />
      )}

      {/* An entry, opened beside the book. Rendered here rather than outside
          the reader so it unmounts with it, and portalled from inside itself so
          it still paints above. */}
      <EntityDrawer entityId={openEntity} onClose={() => setOpenEntity(null)} />
    </div>,
    document.body
  );
}

// ---------------------------------------------------------------------------

/**
 * Eases the scroller to a position, by hand.
 *
 * `scrollTo({ behavior: "smooth" })` is the obvious way to do this and it does
 * not always work: in at least one browser here it was a silent no-op — the
 * assignment `scrollTop = n` moved the page instantly, and the identical smooth
 * call moved nothing at all. Since the whole point of reading mode is that the
 * page *glides* to the next paragraph rather than jumping, the animation is run
 * directly rather than requested.
 *
 * A running glide is cancelled before a new one starts, so pressing on quickly
 * follows you rather than fighting itself.
 */
export interface Glide {
  target: number | null;
  frame: number | null;
  timer: ReturnType<typeof setInterval> | null;
  started: number;
  from: number;
}

/**
 * Eases the scroller to a position, by hand, and guarantees it arrives.
 *
 * Two things forced this shape, both discovered the hard way.
 *
 * `scrollTo({ behavior: "smooth" })` is the obvious way to do it and cannot be
 * relied on: in a browser that is not compositing — backgrounded, occluded, or
 * saving power — it is a silent no-op, while a plain `scrollTop = n` on the
 * same element moves instantly. An animation frame loop has the same problem
 * for the same reason: no frames, no movement.
 *
 * So the animation runs on an interval rather than on frames, and it converges
 * on a *stored* target rather than one captured per call. The first version
 * cancelled its own settle timer whenever a new scroll started, which worked
 * perfectly for a single press and failed for a run of them — each press wiped
 * the guarantee left by the one before, and the page sat still while the
 * paragraphs marched off the bottom of the screen.
 */
function softScrollTo(el: HTMLElement, top: number, g: Glide, duration = 420): void {
  if (Math.abs(top - el.scrollTop) < 2) return;

  // Someone who has asked for less movement gets none.
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    stopGlide(g);
    el.scrollTop = top;
    return;
  }

  // Retarget an animation already in flight rather than restarting the clock,
  // so holding the button down reads as one continuous movement.
  g.target = top;
  g.from = el.scrollTop;
  g.started = performance.now();

  if (g.timer !== null) return;

  const tick = () => {
    if (g.target === null) return stopGlide(g);
    const t = Math.min(1, (performance.now() - g.started) / duration);
    // Ease in and out: it leaves and arrives gently, which is what makes it
    // read as the page moving rather than as the text being yanked.
    const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    el.scrollTop = g.from + (g.target - g.from) * eased;
    if (t >= 1) stopGlide(g);
  };

  // ~60fps where frames flow, and still correct where they do not.
  g.timer = setInterval(tick, 16);
}

function stopGlide(g: Glide): void {
  if (g.timer !== null) clearInterval(g.timer);
  if (g.frame !== null) cancelAnimationFrame(g.frame);
  g.timer = null;
  g.frame = null;
  g.target = null;
}

interface Block {
  key: string;
  chunkId: number;
  divider: string | null;
  paragraphs: string[];
  mentions: Passage["mentions"];
}

/** Passages read to the end, as opposed to partway. */
function finishedCount(read: Map<number, number>): number {
  let n = 0;
  for (const share of read.values()) if (share >= 1) n++;
  return n;
}

/** The chunk id of the first passage in the document, for positions above it. */
function firstPassage(el: HTMLElement): { id: number; offset: number } | null {
  const first = el.querySelector<HTMLElement>("section[data-chunk]");
  return first ? { id: Number(first.dataset.chunk), offset: 0 } : null;
}

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

/** How many paragraphs at the end of a chunk the next one may repeat. */
const SEAM = 3;

/**
 * Turns overlapping chunks back into continuous prose.
 *
 * The chunker deliberately repeats a tail of the previous window so a sentence
 * spanning the seam stays readable to the model. On the page that repetition
 * reads as a stutter, so it is trimmed here — the last paragraphs of one chunk
 * are dropped from the start of the next when they match.
 *
 * Only the seam is compared. The first version kept every signature it had
 * ever seen, so a refrain, a recurring subheading or a repeated formula was
 * shown once in the whole book and silently gone from everywhere else.
 */
export function joinPassages(passages: Passage[]): Block[] {
  const blocks: Block[] = [];
  let lastLabel: string | null = null;
  /** Signatures of the previous chunk's last few paragraphs. */
  let tail = new Set<string>();

  for (const p of passages) {
    const paragraphs: string[] = [];
    const sigs: string[] = [];
    for (const para of p.text.split(/\n\s*\n/)) {
      const text = para.trim();
      if (!text) continue;
      // The overlap is verbatim, so a signature of its opening is enough.
      const sig = text.slice(0, 90).replace(/\s+/g, " ");
      if (tail.has(sig)) continue;
      paragraphs.push(text);
      sigs.push(sig);
    }
    if (sigs.length) tail = new Set(sigs.slice(-SEAM));
    if (!paragraphs.length) continue;

    // A divider only where the reader would expect one: a new chapter, or a
    // page number when that is all we have.
    const label = p.label ?? p.locator ?? null;
    const divider = label && label !== lastLabel ? label : null;
    lastLabel = label;

    blocks.push({ key: `p${p.id}`, chunkId: p.id, divider, paragraphs, mentions: p.mentions });
  }
  return blocks;
}

/**
 * Choosing a voice and a pace.
 *
 * The voices that can read the book in front of you are listed first and the
 * rest are pushed below a rule, because the list a machine reports is long,
 * arbitrarily ordered, and mostly irrelevant — a reader of Arabic scrolling past
 * thirty English voices to find Hoda would reasonably conclude the feature was
 * broken.
 *
 * "Choose for me" is the default and stays the sensible answer for a mixed
 * library: it follows the script of each paragraph, so an Arabic chapter in an
 * English book is still read by an Arabic voice.
 *
 * Microsoft's Natural voices come first, in a group of their own, because they
 * are the ones worth listening to for long — and because choosing one sends the
 * text to Microsoft, which the group's name says rather than hides.
 */
function VoicePicker({
  voices,
  sample,
  chosen,
  rate,
  onVoice,
  onRate,
  theme,
}: {
  voices: Voice[];
  sample: string;
  chosen?: string;
  rate: number;
  onVoice: (uri: string | undefined) => void;
  onRate: (rate: number) => void;
  theme: Theme;
}) {
  const { forThis, others } = groupVoices(voices, langOf(sample));
  const natural = forThis.filter((v) => isNatural(v));
  const machine = forThis.filter((v) => !isNatural(v));

  if (voices.length === 0) {
    return (
      <span className="text-xs" style={{ color: theme.muted }}>
        No voices are installed on this machine.
      </span>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <label className="flex items-center gap-1.5">
        <span style={{ color: theme.muted }}>Voice</span>
        <select
          value={chosen ?? ""}
          onChange={(e) => onVoice(e.target.value || undefined)}
          className="max-w-[13rem] rounded px-1.5 py-1 text-sm"
          style={{ border: `1px solid ${theme.rule}`, background: theme.bg, color: theme.fg }}
        >
          <option value="">Choose for me</option>
          {natural.length > 0 && (
            <optgroup label="Natural — online, via Microsoft">
              {natural.map((v) => (
                <option key={v.uri} value={v.uri}>
                  {v.name}
                </option>
              ))}
            </optgroup>
          )}
          {machine.length > 0 && (
            <optgroup label={natural.length > 0 ? "On this machine" : "Reads this book"}>
              {machine.map((v) => (
                <option key={v.uri} value={v.uri}>
                  {v.name}
                </option>
              ))}
            </optgroup>
          )}
          {others.length > 0 && (
            <optgroup label="Other languages">
              {others.map((v) => (
                <option key={v.uri} value={v.uri}>
                  {v.name} — {v.lang}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </label>

      <label className="flex items-center gap-1.5">
        <span style={{ color: theme.muted }}>Speed</span>
        <select
          value={String(rate)}
          onChange={(e) => onRate(Number(e.target.value))}
          className="rounded px-1.5 py-1 text-sm tabular-nums"
          style={{ border: `1px solid ${theme.rule}`, background: theme.bg, color: theme.fg }}
        >
          {RATES.map((r) => (
            <option key={r} value={String(r)}>
              {r}×
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

type Theme = (typeof THEMES)[keyof typeof THEMES];

function Stepper({
  label,
  value,
  onChange,
  min,
  max,
  theme,
  suffix,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  theme: Theme;
  suffix: string;
  step?: number;
}) {
  const btn = {
    border: `1px solid ${theme.rule}`,
    color: theme.fg,
  };
  return (
    <span className="flex items-center gap-1.5">
      <span style={{ color: theme.muted }}>{label}</span>
      <button
        className="h-6 w-6 rounded hover:opacity-70"
        style={btn}
        onClick={() => onChange(Math.max(min, value - step))}
        aria-label={`Smaller ${label}`}
      >
        −
      </button>
      <span className="w-12 text-center tabular-nums" style={{ color: theme.muted }}>
        {value}
        {suffix}
      </span>
      <button
        className="h-6 w-6 rounded hover:opacity-70"
        style={btn}
        onClick={() => onChange(Math.min(max, value + step))}
        aria-label={`Larger ${label}`}
      >
        +
      </button>
    </span>
  );
}

function Segmented({
  value,
  options,
  onChange,
  theme,
}: {
  value: string;
  options: [string, string][];
  onChange: (v: string) => void;
  theme: Theme;
}) {
  return (
    <span className="flex overflow-hidden rounded" style={{ border: `1px solid ${theme.rule}` }}>
      {options.map(([v, label]) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          className="px-2.5 py-1"
          style={
            value === v
              ? { background: theme.fg, color: theme.bg }
              : { color: theme.muted }
          }
        >
          {label}
        </button>
      ))}
    </span>
  );
}

function Toggle({
  label,
  on,
  onChange,
  theme,
}: {
  label: string;
  on: boolean;
  onChange: (v: boolean) => void;
  theme: Theme;
}) {
  return (
    <button
      onClick={() => onChange(!on)}
      className="rounded px-2.5 py-1"
      style={
        on
          ? { background: theme.fg, color: theme.bg }
          : { border: `1px solid ${theme.rule}`, color: theme.muted }
      }
    >
      {label}
    </button>
  );
}
