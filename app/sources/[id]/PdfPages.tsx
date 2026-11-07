"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject, RefObject } from "react";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { align, bookText, findSelection, fold, tidySelection, type Part } from "@/lib/pdf-align";

/**
 * The book as its PDF: every page drawn as it was printed, with the page's own
 * text laid invisibly over it so it can still be selected.
 *
 * Everything else the reader does keeps working because this hands it the same
 * landmarks the text view does:
 *
 * - `section[data-chunk]` around the pages each passage covers, which is what
 *   position, bookmarks, "read to here" and the link that opened the book
 *   measure against.
 * - `[data-para="n"]` over each paragraph's place on its page, which is what
 *   reading mode lights, the voice follows and Listen starts from. These come
 *   from matching Raazi's paragraphs to the PDF's text (lib/pdf-align), so
 *   they are there for every page whether or not it has been drawn yet.
 * - Selectable text, which is what the dictionary and the writing desk are
 *   offered from. A selection is taken back to the extracted words before it
 *   goes anywhere (`api.resolve`), so what reaches the writing desk is the
 *   paragraph as Raazi reads it, not the PDF's line breaks.
 *
 * Pages are drawn only near the screen and let go further away: a canvas for
 * every page of a six-hundred-page book would hold gigabytes.
 */

export interface PageBlock {
  key: string;
  chunkId: number;
  /** 1-based page the passage starts on, as stored with it. */
  page: number | null;
  paragraphs: string[];
  /** Position of its first paragraph in the whole book. */
  first: number;
  divider: string | null;
  mentions: { surface: string; entityId: number; name: string }[];
}

export interface PdfApi {
  /**
   * A selection made on the pages, as the extracted text it corresponds to,
   * the passage it is in, and its paragraph for context. Falls back to the
   * selection itself, tidied, when it cannot be found.
   */
  resolve(selected: string, chunkId: number | null): { text: string; chunkId: number | null; context?: string };
}

interface Theme {
  bg: string;
  fg: string;
  muted: string;
  rule: string;
  mark: string;
}

type PdfJs = typeof import("pdfjs-dist");

/**
 * pdf.js, from public/pdfjs (copied there from node_modules by
 * scripts/pdfjs-assets.mjs). Loaded as a plain module the browser fetches
 * rather than bundled: it starts its worker from a URL and expects its fonts
 * and character maps beside it, which a bundler's renamed chunks break.
 */
const BASE = "/pdfjs/";
let loader: Promise<PdfJs> | null = null;
function loadPdfJs(): Promise<PdfJs> {
  if (!loader) {
    const url = `${BASE}pdf.min.mjs`;
    loader = (import(/* webpackIgnore: true */ url) as Promise<PdfJs>)
      .then((m) => {
        m.GlobalWorkerOptions.workerSrc = `${BASE}pdf.worker.min.mjs`;
        return m;
      })
      .catch((e) => {
        loader = null;
        throw e;
      });
  }
  return loader;
}

/**
 * What reading every page's text found, kept for the last few sources so that
 * going back to the pages from the text — or closing the book and opening it
 * again — does not read the whole PDF a second time.
 */
interface Found {
  runs: Float32Array[];
  parts: (Part[] | null)[];
  scanned: boolean;
  /** Which paragraphs it was found for; a change in them means looking again. */
  sig: string;
}
const found = new Map<number, Found>();
function remember(sourceId: number, f: Found) {
  found.delete(sourceId);
  found.set(sourceId, f);
  while (found.size > 3) found.delete(found.keys().next().value!);
}

/** The widest a page is drawn at 100%, in CSS pixels. */
const BASE_WIDTH = 860;
/** Room kept between the page and the screen's edges. */
const GUTTER = 32;
/** How far beyond the screen pages are drawn ahead of arriving. */
const AHEAD = 1.5;

interface Size {
  w: number;
  h: number;
}

/** One paragraph's box on one page, as fractions of the page. */
interface Box {
  para: number;
  l: number;
  t: number;
  w: number;
  h: number;
}

export function PdfPages({
  sourceId,
  blocks,
  scroller,
  zoom,
  cursor,
  focus,
  speaking,
  theme,
  themeName,
  highlights,
  onOpenEntity,
  onReady,
  onSettled,
  onFail,
  api,
}: {
  sourceId: number;
  blocks: PageBlock[];
  scroller: RefObject<HTMLDivElement | null>;
  /** Percent of the fitted width. */
  zoom: number;
  /** The paragraph reading mode or the voice is on, by its place in the book. */
  cursor: number;
  focus: boolean;
  speaking: boolean;
  theme: Theme;
  themeName: "paper" | "sepia" | "night";
  highlights: boolean;
  onOpenEntity: (id: number) => void;
  /** The pages are laid out at their final sizes: a position can be restored. */
  onReady: () => void;
  /**
   * The paragraphs have been found on the pages, which can move where each
   * passage's pages begin. A position restored before this is restored again.
   */
  onSettled: () => void;
  /** The PDF could not be opened; the reader goes back to the text. */
  onFail: (why: string) => void;
  api: MutableRefObject<PdfApi | null>;
}) {
  const [lib, setLib] = useState<PdfJs | null>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [sizes, setSizes] = useState<Size[] | null>(null);
  /** Each page's text runs as boxes, [l, t, w, h] as fractions, four per run. */
  const cached = found.get(sourceId);
  const sig = useMemo(() => signature(blocks), [blocks]);
  const fresh = cached && cached.sig === sig ? cached : null;
  const runs = useRef<Float32Array[]>(fresh?.runs ?? []);
  const [parts, setParts] = useState<(Part[] | null)[] | null>(fresh?.parts ?? null);
  const [matching, setMatching] = useState<{ done: number; of: number } | null>(null);
  const [scanned, setScanned] = useState(fresh?.scanned ?? false);
  const [near, setNear] = useState<Set<number>>(() => new Set());
  const [vw, setVw] = useState(() => (typeof window === "undefined" ? BASE_WIDTH : window.innerWidth));

  const onReadyRef = useRef(onReady);
  const onSettledRef = useRef(onSettled);
  const onFailRef = useRef(onFail);
  useEffect(() => {
    onReadyRef.current = onReady;
    onSettledRef.current = onSettled;
    onFailRef.current = onFail;
  });

  useEffect(() => {
    const onResize = () => setVw(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const width = Math.round(Math.min(vw - GUTTER, BASE_WIDTH) * (zoom / 100));

  // Open the PDF, and learn every page's size before drawing any: the layout
  // has to be right from the start, or a restored position lands on the wrong
  // page once the pages above it settle.
  useEffect(() => {
    let live = true;
    let opened: PDFDocumentProxy | null = null;
    (async () => {
      try {
        const m = await loadPdfJs();
        const task = m.getDocument({
          url: `/api/sources/${sourceId}/file`,
          cMapUrl: `${BASE}cmaps/`,
          cMapPacked: true,
          standardFontDataUrl: `${BASE}standard_fonts/`,
          isEvalSupported: false,
        });
        const d = await task.promise;
        opened = d;
        if (!live) return void d.destroy();
        const all: Size[] = new Array(d.numPages);
        for (let n = 1; n <= d.numPages; n += 24) {
          const batch = [];
          for (let k = n; k < Math.min(n + 24, d.numPages + 1); k++) batch.push(d.getPage(k));
          for (const page of await Promise.all(batch)) {
            const vp = page.getViewport({ scale: 1 });
            all[page.pageNumber - 1] = { w: vp.width, h: vp.height };
          }
          if (!live) return;
        }
        setLib(m);
        setDoc(d);
        setSizes(all);
      } catch (e) {
        if (live) onFailRef.current(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
      void opened?.destroy();
    };
  }, [sourceId]);

  // Tell the reader once the pages are in place.
  const told = useRef(false);
  useLayoutEffect(() => {
    if (sizes && !told.current) {
      told.current = true;
      onReadyRef.current();
    }
  }, [sizes]);

  // Once the paragraphs are placed and the pages regrouped by them.
  const settled = useRef(false);
  useEffect(() => {
    if (!parts || !sizes || settled.current) return;
    settled.current = true;
    onSettledRef.current();
  }, [parts, sizes]);

  // Read every page's text, in the background, and find the paragraphs on it.
  useEffect(() => {
    if (!doc || !lib) return;
    const known = found.get(sourceId);
    if (known && known.sig === sig) return;
    let live = true;
    (async () => {
      const strs: string[][] = [];
      const boxes: Float32Array[] = [];
      setMatching({ done: 0, of: doc.numPages });
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        const tc = await page.getTextContent();
        if (!live) return;
        const vp = page.getViewport({ scale: 1 });
        const items = tc.items.filter((i) => "str" in i) as { str: string; transform: number[]; width: number }[];
        const b = new Float32Array(items.length * RUN);
        items.forEach((it, i) => {
          const tx = lib.Util.transform(vp.transform, it.transform);
          const fontHeight = Math.hypot(tx[2], tx[3]);
          b[i * RUN] = tx[4] / vp.width;
          b[i * RUN + 1] = (tx[5] - fontHeight * 0.9) / vp.height;
          b[i * RUN + 2] = (it.width * vp.scale) / vp.width;
          b[i * RUN + 3] = (fontHeight * 1.15) / vp.height;
          b[i * RUN + 4] = it.str.trim().length;
        });
        strs.push(items.map((i) => i.str));
        boxes.push(b);
        if (n % 20 === 0) {
          setMatching({ done: n, of: doc.numPages });
          // Let the page breathe between batches.
          await new Promise((r) => setTimeout(r, 0));
          if (!live) return;
        }
      }
      runs.current = boxes;
      const book = bookText(strs);
      // A scan carries no text of its own, only what was read from its picture.
      const isScan = book.text.length < doc.numPages * 40;

      const wanted: { text: string; page: number | null; until: number | null }[] = [];
      blocks.forEach((b, k) => {
        const until = blocks.slice(k + 1).find((n) => n.page && b.page && n.page > b.page)?.page ?? null;
        for (const text of b.paragraphs) wanted.push({ text, page: b.page, until });
      });
      const placed = align(book, wanted);
      remember(sourceId, { runs: boxes, parts: placed, scanned: isScan, sig });
      setScanned(isScan);
      setParts(placed);
      setMatching(null);
    })().catch(() => setMatching(null));
    return () => {
      live = false;
    };
  }, [doc, lib, blocks, sourceId, sig]);

  /** Every page's paragraph boxes. */
  const boxesByPage = useMemo(() => {
    const out = new Map<number, Box[]>();
    if (!parts) return out;
    parts.forEach((ps, para) => {
      for (const p of ps ?? []) {
        const b = runs.current[p.page];
        if (!b) continue;
        const box = blockBox(b, p.from, p.to);
        if (!box) continue;
        const list = out.get(p.page + 1) ?? [];
        list.push({ para, l: box.l - 0.008, t: box.t - 0.004, w: box.w + 0.016, h: box.h + 0.008 });
        out.set(p.page + 1, list);
      }
    });
    return out;
  }, [parts]);

  /** Which paragraphs are on each page, for the entity marks drawn there. */
  const blockOfPara = useMemo(() => {
    const out: number[] = [];
    blocks.forEach((b, k) => b.paragraphs.forEach(() => out.push(k)));
    return out;
  }, [blocks]);

  /**
   * Which passage each page belongs to.
   *
   * A passage owns the pages from the one it starts on to the one before the
   * next passage starts. Once the paragraphs are found, "starts on" is where
   * its first paragraph actually is, which corrects a passage that names its
   * printed folio rather than the file's page.
   */
  const sections = useMemo(() => {
    if (!sizes) return [];
    const N = sizes.length;
    const starts = blocks.map((b, k) => {
      for (let i = 0; i < b.paragraphs.length; i++) {
        const found = parts?.[b.first + i];
        if (found?.length) return found[0].page + 1;
      }
      return b.page ? Math.min(N, Math.max(1, b.page)) : null;
    });
    // A passage with no page sits where the one before it did.
    let last = 1;
    const at = starts.map((s) => (s === null ? last : (last = s)));

    // The owner of each page: the passage that starts closest before it.
    const byStart = blocks.map((b, k) => ({ k, page: at[k] })).sort((a, b) => a.page - b.page || a.k - b.k);
    const owner: number[] = new Array(N + 1).fill(byStart[0]?.k ?? 0);
    let j = 0;
    for (let n = 1; n <= N; n++) {
      while (j < byStart.length && byStart[j].page <= n) j++;
      if (j > 0) owner[n] = byStart[j - 1].k;
    }

    // Consecutive pages with one owner make a section; a passage that owns no
    // page still gets an empty one where it starts, so it can be jumped to.
    const out: { key: string; chunkId: number; pages: number[] }[] = [];
    const placed = new Set<number>();
    for (let n = 1; n <= N; n++) {
      for (const s of byStart) {
        if (s.page === n && owner[n] !== s.k && !placed.has(s.k)) {
          placed.add(s.k);
          out.push({ key: `mark-${blocks[s.k].key}`, chunkId: blocks[s.k].chunkId, pages: [] });
        }
      }
      const k = owner[n];
      const prev = out[out.length - 1];
      if (prev && prev.pages.length && prev.chunkId === blocks[k]?.chunkId) prev.pages.push(n);
      else {
        placed.add(k);
        out.push({ key: `pages-${n}`, chunkId: blocks[k]?.chunkId ?? 0, pages: [n] });
      }
    }
    return out;
  }, [sizes, blocks, parts]);

  /** Where each chapter's first paragraph is, for the "Jump to" list. */
  const anchorsByPage = useMemo(() => {
    const out = new Map<number, { id: string; t: number }[]>();
    blocks.forEach((b) => {
      if (!b.divider) return;
      const first = parts?.[b.first]?.[0];
      const box = first ? boxesByPage.get(first.page + 1)?.find((x) => x.para === b.first) : null;
      const page = first ? first.page + 1 : b.page;
      if (!page) return;
      const list = out.get(page) ?? [];
      list.push({ id: b.key, t: box ? box.t : 0 });
      out.set(page, list);
    });
    return out;
  }, [blocks, parts, boxesByPage]);

  /** The entity names to mark on each page: those of the passages found there. */
  const mentionsByPage = useMemo(() => {
    const out = new Map<number, PageBlock["mentions"]>();
    for (const [page, boxes] of boxesByPage) {
      const ks = new Set(boxes.map((b) => blockOfPara[b.para]));
      out.set(page, [...ks].flatMap((k) => blocks[k]?.mentions ?? []));
    }
    return out;
  }, [boxesByPage, blockOfPara, blocks]);

  // Draw what is near the screen, and let go of what is far from it.
  useEffect(() => {
    const root = scroller.current;
    if (!root || !sizes) return;
    const io = new IntersectionObserver(
      (entries) => {
        setNear((was) => {
          let next: Set<number> | null = null;
          for (const e of entries) {
            const n = Number((e.target as HTMLElement).dataset.page);
            if (e.isIntersecting === was.has(n)) continue;
            next ??= new Set(was);
            if (e.isIntersecting) next.add(n);
            else next.delete(n);
          }
          return next ?? was;
        });
      },
      { root, rootMargin: `${Math.round(root.clientHeight * AHEAD)}px 0px` }
    );
    for (const el of root.querySelectorAll<HTMLElement>("[data-page]")) io.observe(el);
    return () => io.disconnect();
  }, [scroller, sizes, sections]);

  // What the reader asks of a selection.
  useEffect(() => {
    api.current = {
      resolve(selected, chunkId) {
        const k = blocks.findIndex((b) => b.chunkId === chunkId);
        const around = k < 0 ? [] : blocks.slice(Math.max(0, k - 1), k + 2);
        const texts = around.flatMap((b) => b.paragraphs);
        const owners = around.flatMap((b) => b.paragraphs.map(() => b.chunkId));
        const hit = findSelection(selected, texts);
        if (hit) return { text: hit.text, chunkId: owners[hit.paragraph] ?? chunkId, context: texts[hit.paragraph] };
        return { text: tidySelection(selected), chunkId };
      },
    };
    return () => {
      api.current = null;
    };
  }, [api, blocks]);

  const filter =
    themeName === "night"
      ? "invert(0.9) hue-rotate(180deg)"
      : themeName === "sepia"
        ? "sepia(0.35) saturate(0.9)"
        : undefined;

  if (!sizes || !doc || !lib) {
    return (
      <p className="py-24 text-center text-sm" style={{ color: theme.muted }}>
        Opening the pages…
      </p>
    );
  }

  const aligned = parts ? parts.filter(Boolean).length : 0;
  const note = matching
    ? `Finding the text on the pages · ${matching.done} of ${matching.of}`
    : scanned
      ? "This PDF is a scan: its pages carry no text of their own, so words cannot be selected here. The Text view has what Raazi read from them."
      : parts && parts.length > 20 && aligned < parts.length * 0.5
        ? "Only part of the text could be found on these pages, so reading mode and the voice may jump between pages. The Text view follows more closely."
        : null;

  return (
    <div className="mx-auto pb-40 pt-6" style={{ width }}>
      {note && (
        <p className="mb-4 text-center text-[0.8rem]" style={{ color: theme.muted }} role="status">
          {note}
        </p>
      )}
      {sections.map((s) => (
        <section key={s.key} data-chunk={s.chunkId}>
          {s.pages.map((n) => {
            const boxes = boxesByPage.get(n) ?? EMPTY;
            const lit = boxes.some((b) => b.para === cursor) ? cursor : -1;
            return (
              <PdfPage
                key={n}
                lib={lib}
                doc={doc}
                n={n}
                size={sizes[n - 1]}
                width={width}
                near={near.has(n)}
                boxes={boxes}
                lit={lit}
                focus={focus}
                speaking={speaking}
                anchors={anchorsByPage.get(n) ?? NO_ANCHORS}
                mentions={highlights ? mentionsByPage.get(n) ?? NO_MENTIONS : NO_MENTIONS}
                theme={theme}
                filter={filter}
                night={themeName === "night"}
                onOpenEntity={onOpenEntity}
              />
            );
          })}
        </section>
      ))}
      <p className="mt-16 text-center text-[0.8em]" style={{ color: theme.muted }}>
        End of the document.
      </p>
    </div>
  );
}

const EMPTY: Box[] = [];
const NO_ANCHORS: { id: string; t: number }[] = [];
const NO_MENTIONS: PageBlock["mentions"] = [];

/** An entity name found on a drawn page, as boxes in fractions of the page. */
interface Hit {
  entityId: number;
  name: string;
  rects: { l: number; t: number; w: number; h: number }[];
}

const PdfPage = memo(function PdfPage({
  lib,
  doc,
  n,
  size,
  width,
  near,
  boxes,
  lit,
  focus,
  speaking,
  anchors,
  mentions,
  theme,
  filter,
  night,
  onOpenEntity,
}: {
  lib: PdfJs;
  doc: PDFDocumentProxy;
  n: number;
  size: Size;
  width: number;
  near: boolean;
  boxes: Box[];
  /** The lit paragraph, when it is on this page; -1 otherwise. */
  lit: number;
  focus: boolean;
  speaking: boolean;
  anchors: { id: string; t: number }[];
  mentions: PageBlock["mentions"];
  theme: Theme;
  filter: string | undefined;
  night: boolean;
  onOpenEntity: (id: number) => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const text = useRef<HTMLDivElement>(null);
  const [drawn, setDrawn] = useState(false);
  const [hits, setHits] = useState<Hit[]>([]);
  const scale = width / size.w;
  const height = Math.round(size.h * scale);

  // The entity names, found among the text layer's own spans so their boxes
  // sit exactly on the words.
  const findHits = useCallback(
    (spans: HTMLElement[]) => {
      const box = wrap.current?.getBoundingClientRect();
      if (!box || !mentions.length) return setHits([]);
      let folded = "";
      const spanOf: number[] = [];
      const rawOf: number[] = [];
      spans.forEach((s, i) => {
        const f = fold(s.textContent ?? "");
        folded += f.text;
        for (const r of f.map) {
          spanOf.push(i);
          rawOf.push(r);
        }
      });
      const unique = new Map<string, PageBlock["mentions"][number]>();
      for (const m of mentions) {
        const key = fold(m.surface).text;
        if (key.length >= 3 && !unique.has(key)) unique.set(key, m);
      }
      const out: Hit[] = [];
      for (const [key, m] of unique) {
        let found = 0;
        for (let a = folded.indexOf(key); a >= 0 && found < 40; a = folded.indexOf(key, a + key.length)) {
          const b = a + key.length - 1;
          const startSpan = spans[spanOf[a]];
          const endSpan = spans[spanOf[b]];
          const startNode = startSpan.firstChild;
          const endNode = endSpan.firstChild;
          if (!startNode || !endNode) continue;
          // Whole words only: "Iran" is not in "Tirana".
          const before = (startNode.textContent ?? "")[rawOf[a] - 1];
          const after = (endNode.textContent ?? "")[rawOf[b] + 1];
          if ((before && /\p{L}/u.test(before)) || (after && /\p{L}/u.test(after))) continue;
          const range = document.createRange();
          range.setStart(startNode, rawOf[a]);
          range.setEnd(endNode, Math.min((endNode.textContent ?? "").length, rawOf[b] + 1));
          const rects = [...range.getClientRects()]
            .filter((r) => r.width > 1 && r.height > 1)
            .map((r) => ({
              l: (r.left - box.left) / box.width,
              t: (r.top - box.top) / box.height,
              w: r.width / box.width,
              h: r.height / box.height,
            }));
          if (rects.length) {
            out.push({ entityId: m.entityId, name: m.name, rects });
            found++;
          }
        }
      }
      setHits(out);
    },
    [mentions]
  );

  const spansRef = useRef<HTMLElement[]>([]);

  useEffect(() => {
    const c = canvas.current;
    const t = text.current;
    if (!c || !t) return;
    if (!near) {
      // Far away: let the pixels go.
      c.width = 0;
      c.height = 0;
      t.replaceChildren();
      spansRef.current = [];
      setDrawn(false);
      setHits([]);
      return;
    }

    let cancelled = false;
    let render: { cancel: () => void } | null = null;
    let layer: { cancel: () => void } | null = null;
    (async () => {
      let page: PDFPageProxy;
      try {
        page = await doc.getPage(n);
      } catch {
        return;
      }
      if (cancelled) return;
      const vp = page.getViewport({ scale });
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      c.width = Math.floor(vp.width * dpr);
      c.height = Math.floor(vp.height * dpr);
      const ctx = c.getContext("2d");
      if (!ctx) return;
      const task = page.render({
        canvasContext: ctx,
        viewport: vp,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      });
      render = task;
      try {
        await task.promise;
      } catch {
        return; // cancelled by a newer draw
      }
      if (cancelled) return;
      setDrawn(true);

      const tc = await page.getTextContent();
      if (cancelled) return;
      t.replaceChildren();
      const tl = new lib.TextLayer({ textContentSource: tc, container: t, viewport: vp });
      layer = tl;
      try {
        await tl.render();
      } catch {
        return;
      }
      if (cancelled) return;
      const end = document.createElement("div");
      end.className = "endOfContent";
      t.append(end);
      spansRef.current = tl.textDivs;
      findHits(tl.textDivs);
    })();

    return () => {
      cancelled = true;
      render?.cancel();
      layer?.cancel();
    };
    // `findHits` is left out on purpose: a change in the names to mark is
    // handled below without drawing the page again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [near, doc, lib, n, scale]);

  useEffect(() => {
    if (spansRef.current.length) findHits(spansRef.current);
  }, [findHits]);

  // While dragging a selection, the area below the text belongs to the text,
  // so a drag that runs off the last line does not select from the top.
  useEffect(() => {
    const t = text.current;
    if (!t) return;
    const down = () => {
      t.classList.add("selecting");
      const up = () => {
        t.classList.remove("selecting");
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointerup", up);
    };
    t.addEventListener("pointerdown", down);
    return () => t.removeEventListener("pointerdown", down);
  }, []);

  const litBoxes = lit >= 0 ? boxes.filter((b) => b.para === lit) : EMPTY;
  const pct = (x: number) => `${(x * 100).toFixed(3)}%`;

  return (
    <div
      ref={wrap}
      data-page={n}
      className="relative mb-4"
      style={
        {
          width,
          height,
          background: night ? "#1b1b1f" : "#fff",
          boxShadow: `0 1px 3px ${night ? "rgba(0,0,0,.6)" : "rgba(0,0,0,.14)"}`,
          // Keeps reading mode's dimming to the page it is on.
          overflow: "clip",
          "--scale-factor": scale,
        } as React.CSSProperties
      }
    >
      <canvas
        ref={canvas}
        aria-hidden
        className="absolute inset-0 select-none"
        style={{ width: "100%", height: "100%", filter, opacity: drawn ? 1 : 0, transition: "opacity 160ms" }}
      />
      {!drawn && (
        <span className="absolute inset-0 grid place-items-center text-xs tabular-nums" style={{ color: theme.muted }}>
          {n}
        </span>
      )}
      <div ref={text} className="textLayer" />

      {/* The paragraphs' places. Invisible in an ordinary read; they are what
          reading mode and the voice find their paragraph by. */}
      {boxes.map((b, i) => (
        <div
          key={i}
          data-para={b.para}
          aria-hidden
          className="pointer-events-none absolute"
          style={{ left: pct(b.l), top: pct(b.t), width: pct(b.w), height: pct(b.h), zIndex: 2 }}
        />
      ))}

      {/* Reading mode: everything but the paragraph you are on, washed out. */}
      {focus &&
        (litBoxes.length ? (
          litBoxes.map((b, i) => (
            <div
              key={`lit${i}`}
              aria-hidden
              className="pointer-events-none absolute rounded"
              style={{
                left: pct(b.l),
                top: pct(b.t),
                width: pct(b.w),
                height: pct(b.h),
                boxShadow: `0 0 0 100vmax ${theme.bg}d9`,
                transition: "all 260ms ease",
                zIndex: 3,
              }}
            />
          ))
        ) : (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{ background: theme.bg, opacity: 0.85, zIndex: 3 }}
          />
        ))}

      {/* The paragraph being read aloud: a rule in the margin beside it. */}
      {speaking &&
        litBoxes.map((b, i) => (
          <div
            key={`say${i}`}
            aria-hidden
            className="pointer-events-none absolute"
            style={{
              left: `calc(${pct(b.l)} - 7px)`,
              top: pct(b.t),
              width: 3,
              height: pct(b.h),
              borderRadius: 2,
              background: night ? "#d6d3cd" : theme.fg,
              opacity: 0.55,
              zIndex: 4,
            }}
          />
        ))}

      {/* Names Raazi knows, marked on the page and opened beside it. */}
      {hits.map((h, i) =>
        h.rects.map((r, j) => (
          <button
            key={`${i}-${j}`}
            type="button"
            title={`Open ${h.name}`}
            onClick={() => onOpenEntity(h.entityId)}
            className="absolute cursor-pointer rounded-sm"
            style={{
              left: pct(r.l),
              top: pct(r.t),
              width: pct(r.w),
              height: pct(r.h),
              background: theme.mark,
              mixBlendMode: night ? "screen" : "multiply",
              zIndex: 2,
            }}
          />
        ))
      )}

      {anchors.map((a) => (
        <span key={a.id} id={a.id} aria-hidden className="pointer-events-none absolute left-0" style={{ top: pct(a.t) }} />
      ))}
    </div>
  );
});

/** Numbers kept per text run: left, top, width, height (fractions of the page), and its length. */
const RUN = 5;

/**
 * The box around a paragraph's lines on a page.
 *
 * Not simply around every run it covers: pdf.js lists a page's running head
 * and folio among the runs of whatever paragraph straddles them, so the plain
 * union of a paragraph continued from the page before ran from the head at the
 * top to the page number at the foot, covering everything in between. The runs
 * are grouped into blocks of lines that sit close together, and the block
 * holding most of the paragraph's text is its box.
 */
function blockBox(b: Float32Array, from: number, to: number): { l: number; t: number; w: number; h: number } | null {
  const idx: number[] = [];
  for (let i = from; i <= to; i++) if (b[i * RUN + 2] > 0 && b[i * RUN + 4] > 0) idx.push(i);
  if (!idx.length) return null;
  idx.sort((x, y) => b[x * RUN + 1] - b[y * RUN + 1]);
  const heights = idx.map((i) => b[i * RUN + 3]).sort((x, y) => x - y);
  const line = heights[heights.length >> 1];

  type Block = { l: number; t: number; r: number; bot: number; chars: number };
  let best: Block | null = null;
  let cur: Block | null = null;
  for (const i of idx) {
    const l = b[i * RUN], t = b[i * RUN + 1], r = l + b[i * RUN + 2], bot = t + b[i * RUN + 3];
    // More than about a blank line's gap below the block so far starts another.
    if (cur && t > cur.bot + line * 0.9) {
      if (!best || cur.chars > best.chars) best = cur;
      cur = null;
    }
    if (!cur) cur = { l, t, r, bot, chars: 0 };
    cur.l = Math.min(cur.l, l);
    cur.t = Math.min(cur.t, t);
    cur.r = Math.max(cur.r, r);
    cur.bot = Math.max(cur.bot, bot);
    cur.chars += b[i * RUN + 4];
  }
  if (cur && (!best || cur.chars > best.chars)) best = cur;
  if (!best || best.r <= best.l || best.bot <= best.t) return null;
  return { l: best.l, t: best.t, w: best.r - best.l, h: best.bot - best.t };
}

/** What a book's paragraphs are, cheaply: each passage and how many it holds. */
function signature(blocks: PageBlock[]): string {
  return blocks.map((b) => `${b.chunkId}:${b.paragraphs.length}`).join(",");
}
