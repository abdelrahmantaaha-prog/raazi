"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  clipboardHtml,
  markerHtml,
  numbering,
  readClip,
  renumberDom,
  retargetClip,
  type PortableRef,
} from "./citations";
import { reviewSheet, reviewUnits, unitOf, type ReviewUnit } from "./review";

export type CitationRef = PortableRef;

/**
 * A rich text editor, built on contenteditable and nothing else.
 *
 * The formatting a piece of research writing needs is a short list — headings,
 * bold, italic, quotes, lists, and citations — and `document.execCommand`
 * produces all of it in every browser this runs in. It is deprecated and has no
 * replacement, which is an unusual state of affairs; the alternative is a
 * hundred-kilobyte editor framework for six buttons, in an application that has
 * so far refused every dependency it could write instead.
 *
 * The one thing execCommand cannot do is citations, so those are inserted
 * directly as a marked, uneditable span carrying the reference's id (see
 * lib/cite-markers.ts). The number a marker shows is redrawn on every edit
 * from the order references are first cited — the order the export numbers
 * its footnotes in — so the screen and the Word file always agree.
 */
export function Editor({
  html,
  citations,
  draftId,
  onChange,
  onCite,
  onLibrary,
  onAdopt,
  dir,
  reviewing = false,
  reviewed = [],
  onReviewing,
  onReviewed,
}: {
  html: string;
  /** The draft's references, in stored order. */
  citations: CitationRef[];
  /** The open draft, written onto the clipboard so a paste knows where it came from. */
  draftId: number | null;
  onChange: (html: string) => void;
  /** Asked for when you press Cite with nothing selected to attach it to. */
  onCite: () => void;
  /** Opens the search for something in the library to cite. */
  onLibrary?: () => void;
  /**
   * Makes references pasted from elsewhere this draft's own: given what each
   * pasted marker pointed at, returns the id it should point at here, and the
   * reference list as it now stands.
   */
  onAdopt?: (refs: PortableRef[]) => Promise<{ ids: Map<number, number>; citations: CitationRef[] }>;
  dir?: "ltr" | "rtl";
  /** Review mode is on: the paragraphs passed are shown, and the bar to pass them. */
  reviewing?: boolean;
  /** The fingerprints of the paragraphs marked reviewed (see ./review.ts). */
  reviewed?: string[];
  onReviewing?: (on: boolean) => void;
  /** The reviewed list as it now stands, for the desk to keep. */
  onReviewed?: (keys: string[]) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  /** What we last wrote into the box, so we don't fight the cursor. */
  const mine = useRef<string>("");
  /** The latest references and draft, for handlers that outlive a render. */
  const refs = useRef<CitationRef[]>(citations);
  refs.current = citations;
  const draft = useRef<number | null>(draftId);
  draft.current = draftId;

  // Only ever push HTML in when it did not come from here. Re-setting innerHTML
  // on every keystroke would drop the caret to the start of the document, which
  // is the classic way a contenteditable editor becomes unusable.
  useEffect(() => {
    const el = box.current;
    if (!el || html === mine.current) return;
    if (el.innerHTML !== html) el.innerHTML = html;
    mine.current = html;
  }, [html]);

  // Enter makes a paragraph, not a div.
  //
  // Chrome and everything built on it default to wrapping each new line in a
  // `div`, which is not what the rest of this application means by a
  // paragraph: the stored markup is paragraphs, the Word export reads
  // paragraphs, and the sanitiser now has to rescue divs into them. Asking the
  // browser for `p` up front means the markup is right from the keystroke
  // rather than repaired afterwards. Firefox already does this; the call is
  // harmless where it is unsupported.
  useEffect(() => {
    try {
      document.execCommand("defaultParagraphSeparator", false, "p");
    } catch {
      /* an older engine; the sanitiser still folds divs into paragraphs */
    }
  }, []);

  /**
   * Hands the box's HTML up, with every marker numbered for where it now
   * stands. Moving a sentence changes which reference is cited first, so the
   * numbers are redrawn on every edit, not only when the list changes.
   */
  const emit = useCallback(() => {
    const el = box.current;
    if (!el) return;
    renumberDom(el, refs.current);
    mine.current = el.innerHTML;
    onChange(el.innerHTML);
  }, [onChange]);

  // A reference added, removed or merged: redraw the markers to match.
  useEffect(() => {
    const el = box.current;
    if (el && renumberDom(el, citations)) {
      mine.current = el.innerHTML;
      onChange(el.innerHTML);
    }
  }, [citations, onChange]);

  /**
   * What the caret is standing in, so the toolbar can show it.
   *
   * Every other set of tabs and toggles in Raazi says which one you are on;
   * this row of six did not, so the only way to find out whether a paragraph
   * was a heading — or whether the words you were about to type would come
   * out bold — was to type them and look. `selectionchange` is on the
   * document rather than the element, because moving the caret with the
   * keyboard fires nothing on the box itself.
   */
  const [active, setActive] = useState<{ block: string; bold: boolean; italic: boolean; ul: boolean; ol: boolean }>({
    block: "",
    bold: false,
    italic: false,
    ul: false,
    ol: false,
  });

  useEffect(() => {
    const read = () => {
      const el = box.current;
      const sel = document.getSelection();
      // Only when the caret is actually in this editor; otherwise the answers
      // describe whatever else has focus.
      if (!el || !sel?.anchorNode || !el.contains(sel.anchorNode)) return;
      try {
        setActive({
          block: (document.queryCommandValue("formatBlock") || "").toLowerCase(),
          bold: document.queryCommandState("bold"),
          italic: document.queryCommandState("italic"),
          ul: document.queryCommandState("insertUnorderedList"),
          ol: document.queryCommandState("insertOrderedList"),
        });
      } catch {
        /* an engine that will not answer; the toolbar simply shows nothing */
      }
    };
    document.addEventListener("selectionchange", read);
    return () => document.removeEventListener("selectionchange", read);
  }, []);

  const run = useCallback(
    (command: string, value?: string) => {
      box.current?.focus();
      document.execCommand(command, false, value);
      emit();
      // execCommand does not fire selectionchange, so re-read the state the
      // command just changed or the button would stay unlit until you moved.
      try {
        setActive({
          block: (document.queryCommandValue("formatBlock") || "").toLowerCase(),
          bold: document.queryCommandState("bold"),
          italic: document.queryCommandState("italic"),
          ul: document.queryCommandState("insertUnorderedList"),
          ol: document.queryCommandState("insertOrderedList"),
        });
      } catch {
        /* as above */
      }
    },
    [emit]
  );

  /** A heading button returns the line to body text when it is already that
   *  heading, which is what a toggle that looks like a toggle has to do. */
  const block = useCallback(
    (tag: string) => run("formatBlock", active.block === tag ? "<p>" : `<${tag}>`),
    [run, active.block]
  );

  /** Puts a marker for a reference already in the list where the caret is. */
  const insertCitation = useCallback(
    (refId: number) => {
      const el = box.current;
      if (!el || !refs.current.some((r) => r.id === refId)) return;
      el.focus();
      // contenteditable="false" keeps the marker atomic: backspace removes the
      // whole thing rather than eating the number a digit at a time.
      document.execCommand("insertHTML", false, markerHtml(refId) + "&nbsp;");
      emit();
    },
    [emit]
  );

  // Copy, cut and paste.
  //
  // Copying out of a draft writes the selection as markup, each marker
  // carrying the reference it points at (see ./citations.ts). Pasting that
  // back — into this draft or another, now or after a reload — keeps every
  // marker a marker: one whose reference is in this draft stays pointed at
  // it, and one from elsewhere brings its reference along, joining the one
  // already here when the same source is cited rather than adding it twice.
  //
  // Anything from outside Raazi arrives as plain text. Pasting from a web
  // page otherwise drags in fonts, colours and background images, and a
  // document that changes appearance depending on where a paragraph came from
  // is not a document.
  //
  // As *paragraphs*, though, not as one block of text with the line breaks
  // left in. `insertText` turns every newline into a `<br>`, and a `<br>` is
  // the one piece of markup the screen and the Word export disagree about:
  // tight on screen, a full paragraph in the exported file, because
  // htmlToDocx has to end the block at one. Two pages pasted out of a PDF
  // arrived looking like prose and exported as sixty paragraphs. So a blank
  // line starts a new paragraph, and a single newline — which in pasted text
  // is almost always a wrapped line rather than a break the author meant —
  // closes up into a space.
  useEffect(() => {
    const el = box.current;
    if (!el) return;

    const onCopy = (e: ClipboardEvent) => {
      const sel = document.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount || !e.clipboardData) return;
      const range = sel.getRangeAt(0);
      if (!el.contains(range.commonAncestorContainer)) return;
      e.preventDefault();
      e.clipboardData.setData("text/plain", sel.toString());
      e.clipboardData.setData("text/html", clipboardHtml(range.cloneContents(), draft.current, refs.current));
      if (e.type === "cut") {
        document.execCommand("delete");
        emit();
      }
    };

    const putBack = (html: string, at: Range | null) => {
      el.focus();
      if (at) {
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(at);
      }
      document.execCommand("insertHTML", false, html);
      emit();
    };

    const onPaste = (e: ClipboardEvent) => {
      e.preventDefault();
      const clip = readClip(e.clipboardData?.getData("text/html") ?? "");

      if (clip) {
        const here = new Set(refs.current.map((r) => r.id));
        const sameDraft = clip.draftId !== null && clip.draftId === draft.current;
        // A marker needs adopting when it is from another draft, or from this
        // one but its reference has been removed since it was copied.
        const adopt = [...clip.refs]
          .filter(([id, ref]) => ref !== null && !(sameDraft && here.has(id)))
          .map(([, ref]) => ref as PortableRef);
        if (!adopt.length || !onAdopt) {
          putBack(retargetClip(clip, new Map()), null);
          return;
        }
        // The caret is remembered across the round trip to the server, so the
        // text lands where it was pasted rather than wherever focus wandered.
        const sel = window.getSelection();
        const at = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
        void onAdopt(adopt)
          .then(({ ids, citations: next }) => {
            if (next.length) refs.current = next;
            putBack(retargetClip(clip, ids), at);
          })
          .catch(() => putBack(retargetClip(clip, new Map()), at));
        return;
      }

      const text = e.clipboardData?.getData("text/plain") ?? "";
      const paragraphs = text
        .replace(/\r\n?/g, "\n")
        .split(/\n\s*\n+/)
        .map((p) => p.replace(/\n+/g, " ").trim())
        .filter(Boolean);

      if (paragraphs.length <= 1) {
        document.execCommand("insertText", false, paragraphs[0] ?? "");
      } else {
        document.execCommand(
          "insertHTML",
          false,
          paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("")
        );
      }
      emit();
    };

    el.addEventListener("copy", onCopy);
    el.addEventListener("cut", onCopy);
    el.addEventListener("paste", onPaste);
    return () => {
      el.removeEventListener("copy", onCopy);
      el.removeEventListener("cut", onCopy);
      el.removeEventListener("paste", onPaste);
    };
  }, [emit, onAdopt]);

  // ---- review mode -------------------------------------------------------
  //
  // You read the draft over where it is, in the editor, and pass it a
  // paragraph at a time: the one the caret is in has a bar beside it, and one
  // you have passed has its first line highlighted. The text stays editable
  // throughout, because the point of reading it over is to fix what you find.
  // See ./review.ts for why none of this is written into the draft.

  /** Scopes the review stylesheet to this editor's box. */
  const editorId = useId();
  const scope = `[data-editor="${editorId}"]`;
  /** The units as the text last stood, for the buttons and the keyboard. */
  const units = useRef<ReviewUnit[]>([]);
  const [current, setCurrent] = useState<HTMLElement | null>(null);
  const [sheet, setSheet] = useState("");
  const [tally, setTally] = useState({ done: 0, total: 0, at: -1 });

  // Redrawn whenever the text, the list or the caret's paragraph changes.
  // Only after the text is in the box, which is why this reads the DOM in an
  // effect rather than the HTML during render.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const list = reviewUnits(el, scope);
    units.current = list;
    const passed = new Set(reviewed);
    setSheet(reviewing ? reviewSheet(list, passed, current) : "");
    setTally({
      done: list.filter((u) => passed.has(u.key)).length,
      total: list.length,
      at: list.findIndex((u) => u.el === current),
    });
  }, [html, reviewed, reviewing, current, scope]);

  // Which paragraph the caret is in, wherever it was moved from.
  useEffect(() => {
    const follow = () => {
      const el = box.current;
      const sel = document.getSelection();
      if (!el || !sel?.anchorNode || !el.contains(sel.anchorNode)) return;
      setCurrent(unitOf(el, sel.anchorNode));
    };
    document.addEventListener("selectionchange", follow);
    return () => document.removeEventListener("selectionchange", follow);
  }, []);

  /** Puts the caret at the start of a unit and brings it to the middle of the view. */
  const goTo = useCallback((unit: ReviewUnit | undefined) => {
    const el = box.current;
    if (!el || !unit) return;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(unit.el);
    range.collapse(true);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    unit.el.scrollIntoView({ block: "center", behavior: "smooth" });
    setCurrent(unit.el);
  }, []);

  /** The reviewed list with one unit's mark flipped, keeping only paragraphs still in the draft. */
  const flip = useCallback(
    (unit: ReviewUnit, on: boolean): Set<string> => {
      const present = new Set(units.current.map((u) => u.key));
      const next = new Set(reviewed.filter((k) => present.has(k)));
      if (on) next.add(unit.key);
      else next.delete(unit.key);
      onReviewed?.([...next]);
      return next;
    },
    [reviewed, onReviewed]
  );

  const step = useCallback(
    (by: 1 | -1) => {
      const list = units.current;
      const at = list.findIndex((u) => u.el === current);
      goTo(list[at === -1 ? 0 : Math.min(list.length - 1, Math.max(0, at + by))]);
    },
    [current, goTo]
  );

  /** The next unit not yet passed after `from`, coming round to the top. */
  const nextOpen = (passed: Set<string>, from: number) => {
    const list = units.current;
    for (let i = 1; i <= list.length; i++) {
      const u = list[(from + i) % list.length];
      if (!passed.has(u.key)) return u;
    }
    return undefined;
  };

  /** Passes the paragraph you are on and takes you to the next one waiting. */
  const passAndNext = useCallback(() => {
    const list = units.current;
    const at = list.findIndex((u) => u.el === current);
    if (at === -1) {
      goTo(nextOpen(new Set(reviewed), -1));
      return;
    }
    const passed = flip(list[at], true);
    const next = nextOpen(passed, at);
    if (next) goTo(next);
  }, [current, reviewed, flip, goTo]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Into review mode at the first paragraph not yet passed, unless the caret is already in one. */
  const startReview = () => {
    onReviewing?.(true);
    if (!current || !box.current?.contains(current)) goTo(nextOpen(new Set(reviewed), -1) ?? units.current[0]);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!reviewing) return;
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      passAndNext();
    } else if (e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      step(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Escape") {
      onReviewing?.(false);
    }
  };

  const here = tally.at === -1 ? undefined : units.current[tally.at];
  const herePassed = here ? reviewed.includes(here.key) : false;

  /** Each reference's number as the text stands, for the "Cite existing" list. */
  const numbers = numbering(html, citations);

  return (
    <div className="rounded-lg border border-[var(--color-rule)] bg-white">
      {/* Pinned to the top of the window while the draft scrolls under it: in a
          long piece the formatting and the citations were a scroll away from
          the sentence that needed them. */}
      <div className="sticky top-0 z-10 flex flex-wrap items-center gap-0.5 rounded-t-lg border-b border-[var(--color-rule)] bg-white/95 px-2 py-1.5 backdrop-blur">
        <Group>
          <Tool label="H1" title="Heading" on={active.block === "h1"} onClick={() => block("h1")} />
          <Tool label="H2" title="Subheading" on={active.block === "h2"} onClick={() => block("h2")} />
          <Tool label="H3" title="Sub-subheading" on={active.block === "h3"} onClick={() => block("h3")} />
          <Tool
            label="¶"
            title="Body text"
            on={active.block === "p" || active.block === "div" || active.block === ""}
            onClick={() => run("formatBlock", "<p>")}
          />
        </Group>
        <Divider />
        <Group>
          <Tool label="B" title="Bold (Ctrl+B)" bold on={active.bold} onClick={() => run("bold")} />
          <Tool label="I" title="Italic (Ctrl+I)" italic on={active.italic} onClick={() => run("italic")} />
        </Group>
        <Divider />
        <Group>
          <Tool
            label="“ ”"
            title="Block quote"
            on={active.block === "blockquote"}
            onClick={() => block("blockquote")}
          />
          <Tool label="•" title="Bulleted list" on={active.ul} onClick={() => run("insertUnorderedList")} />
          <Tool label="1." title="Numbered list" on={active.ol} onClick={() => run("insertOrderedList")} />
        </Group>
        <Divider />
        <button
          // Keeps the caret in the draft, so the citation lands where it was.
          onMouseDown={(e) => e.preventDefault()}
          onClick={onCite}
          className="rounded px-2 py-1 text-xs font-medium text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)]"
          title="Add a reference and cite it here"
        >
          + Citation
        </button>
        {onLibrary ? (
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={onLibrary}
            className="rounded px-2 py-1 text-xs font-medium text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)]"
            title="Search your library — titles, authors and full text — and cite what you find where the cursor is"
          >
            Cite from library
          </button>
        ) : null}

        {citations.length > 0 && (
          <select
            className="ml-1 max-w-[13rem] rounded border border-[var(--color-rule)] bg-white px-1.5 py-1 text-xs"
            value=""
            onChange={(e) => {
              const refId = Number(e.target.value);
              if (e.target.value !== "" && Number.isFinite(refId)) insertCitation(refId);
              e.target.value = "";
            }}
            title="Cite something already in your references"
          >
            <option value="">Cite existing…</option>
            {[...citations]
              .sort((a, b) => (numbers.get(a.id) ?? Infinity) - (numbers.get(b.id) ?? Infinity))
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {numbers.has(c.id) ? `[${numbers.get(c.id)}]` : "[–]"} {c.text.slice(0, 44)}
                </option>
              ))}
          </select>
        )}

        {onReviewed ? (
          <>
            <Divider />
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => (reviewing ? onReviewing?.(false) : startReview())}
              aria-pressed={reviewing}
              className={`rounded px-2 py-1 text-xs font-medium transition ${
                reviewing
                  ? "bg-[var(--color-ink)] text-white"
                  : "text-[var(--color-ink)] hover:bg-[var(--color-accent-soft)]"
              }`}
              title="Read the draft over a paragraph at a time and mark each one reviewed"
            >
              Review
              {tally.total > 0 && (tally.done > 0 || reviewing) ? (
                <span className="ms-1 tabular-nums opacity-70">
                  {tally.done}/{tally.total}
                </span>
              ) : null}
            </button>
          </>
        ) : null}

        <span className="ml-auto text-[0.68rem] text-[var(--color-muted)]">
          Pastes from outside Raazi arrive as plain text
        </span>

        {reviewing && (
          <div className="mt-1.5 flex basis-full flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--color-rule)] pt-1.5 text-xs">
            <span className="tabular-nums text-[var(--color-muted)]">
              {tally.at === -1 ? "Click into a paragraph" : `Paragraph ${tally.at + 1} of ${tally.total}`}
            </span>
            {/* How far through you are, as the highlights add up. */}
            <span className="flex items-center gap-1.5 tabular-nums text-[var(--color-muted)]">
              <span className="h-1.5 w-20 overflow-hidden rounded-full bg-[var(--color-rule)]">
                <span
                  className="block h-full bg-[var(--color-reviewed)] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.08)]"
                  style={{ width: `${tally.total ? (tally.done / tally.total) * 100 : 0}%` }}
                />
              </span>
              {tally.total > 0 && tally.done === tally.total ? "All reviewed" : `${tally.done} reviewed`}
            </span>
            <span className="flex items-center gap-1">
              <ReviewButton title="Previous paragraph (Alt+↑)" disabled={tally.at <= 0} onClick={() => step(-1)}>
                ↑
              </ReviewButton>
              <ReviewButton title="Next paragraph (Alt+↓)" disabled={tally.at >= tally.total - 1} onClick={() => step(1)}>
                ↓
              </ReviewButton>
            </span>
            <ReviewButton
              title={herePassed ? "Take the mark off this paragraph" : "Mark this paragraph reviewed"}
              disabled={!here}
              on={herePassed}
              onClick={() => here && flip(here, !herePassed)}
            >
              {herePassed ? "✓ Reviewed" : "Mark reviewed"}
            </ReviewButton>
            <ReviewButton
              title="Mark this paragraph reviewed and go to the next one waiting (Ctrl+Enter)"
              disabled={tally.total === 0 || (herePassed && tally.done === tally.total)}
              onClick={passAndNext}
            >
              Mark &amp; next →
            </ReviewButton>
            <span className="text-[0.68rem] text-[var(--color-muted)]">
              Changing a reviewed paragraph takes its mark off.
            </span>
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onReviewing?.(false)}
              className="ml-auto rounded px-2 py-1 font-medium text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)]"
              title="Leave review mode (Esc)"
            >
              Done
            </button>
          </div>
        )}
      </div>

      {sheet ? <style>{sheet}</style> : null}
      <div
        ref={box}
        data-editor={editorId}
        contentEditable
        suppressContentEditableWarning
        dir={dir}
        onInput={emit}
        onBlur={emit}
        onKeyDown={onKeyDown}
        spellCheck
        role="textbox"
        aria-multiline="true"
        aria-label="Draft"
        className="prose-draft min-h-[30rem] w-full px-6 py-5 focus:outline-none"
      />
    </div>
  );
}

function Group({ children }: { children: React.ReactNode }) {
  return <span className="flex items-center gap-0.5">{children}</span>;
}

function Divider() {
  return <span className="mx-1 h-4 w-px bg-[var(--color-rule)]" />;
}

function Tool({
  label,
  title,
  onClick,
  bold,
  italic,
  on,
}: {
  label: string;
  title: string;
  onClick: () => void;
  bold?: boolean;
  italic?: boolean;
  /** Whether the caret is currently inside what this button applies. */
  on?: boolean;
}) {
  return (
    <button
      // Stops the editor losing its selection the moment the button is pressed,
      // which would apply the command to nothing.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      title={title}
      aria-pressed={on ?? false}
      className={`min-w-[1.9rem] rounded px-1.5 py-1 text-xs transition hover:bg-[var(--color-accent-soft)] ${
        on
          ? "bg-[var(--color-ink)] text-white hover:bg-[var(--color-ink)]"
          : "text-[var(--color-ink)]"
      } ${bold ? "font-bold" : ""} ${italic ? "italic" : ""}`}
    >
      {label}
    </button>
  );
}

/** A button on the review bar; like the toolbar's, it leaves the caret where it was. */
function ReviewButton({
  title,
  onClick,
  disabled,
  on,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  on?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={on}
      className={`rounded border px-2 py-0.5 transition disabled:opacity-35 ${
        on
          ? "border-transparent bg-[var(--color-reviewed)] text-[var(--color-ink)]"
          : "border-[var(--color-rule)] bg-white hover:bg-[var(--color-accent-soft)]"
      }`}
    >
      {children}
    </button>
  );
}

/** For text pasted in: it becomes markup, so it must not be able to be markup. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
