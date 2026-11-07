"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  clipboardHtml,
  markerHtml,
  numbering,
  readClip,
  renumberDom,
  retargetClip,
  type PortableRef,
} from "./citations";

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

        <span className="ml-auto text-[0.68rem] text-[var(--color-muted)]">
          Pastes from outside Raazi arrive as plain text
        </span>
      </div>

      <div
        ref={box}
        contentEditable
        suppressContentEditableWarning
        dir={dir}
        onInput={emit}
        onBlur={emit}
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

/** For text pasted in: it becomes markup, so it must not be able to be markup. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
