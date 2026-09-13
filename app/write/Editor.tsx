"use client";

import { useCallback, useEffect, useRef } from "react";
import { citationMarker } from "./citations";

export interface CitationRef {
  id: number;
  text: string;
}

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
 * directly as a marked, uneditable span. They carry the reference's id — the
 * note text lives with the draft — so correcting a reference updates every
 * place it appears rather than the first one you find, and the number shown
 * is recomputed from the list's order whenever that changes.
 */
export function Editor({
  html,
  citations,
  onChange,
  onCite,
  dir,
}: {
  html: string;
  citations: CitationRef[];
  onChange: (html: string) => void;
  /** Asked for when you press Cite with nothing selected to attach it to. */
  onCite: () => void;
  dir?: "ltr" | "rtl";
}) {
  const box = useRef<HTMLDivElement>(null);
  /** What we last wrote into the box, so we don't fight the cursor. */
  const mine = useRef<string>("");

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

  const emit = useCallback(() => {
    const el = box.current;
    if (!el) return;
    mine.current = el.innerHTML;
    onChange(el.innerHTML);
  }, [onChange]);

  const run = useCallback(
    (command: string, value?: string) => {
      box.current?.focus();
      document.execCommand(command, false, value);
      emit();
    },
    [emit]
  );

  /** Puts a citation marker where the caret is. */
  const insertCitation = useCallback(
    (index: number) => {
      const el = box.current;
      const ref = citations[index];
      if (!el || !ref) return;
      el.focus();
      // contenteditable="false" keeps the marker atomic: backspace removes the
      // whole thing rather than eating the number a digit at a time.
      document.execCommand("insertHTML", false, citationMarker(ref.id, index));
      emit();
    },
    [emit, citations]
  );

  // Paste as plain text. Pasting from a web page otherwise drags in fonts,
  // colours and background images, and a document that changes appearance
  // depending on where a paragraph came from is not a document.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onPaste = (e: ClipboardEvent) => {
      e.preventDefault();
      const text = e.clipboardData?.getData("text/plain") ?? "";
      document.execCommand("insertText", false, text);
      emit();
    };
    el.addEventListener("paste", onPaste);
    return () => el.removeEventListener("paste", onPaste);
  }, [emit]);

  return (
    <div className="rounded-lg border border-[var(--color-rule)] bg-white">
      <div className="flex flex-wrap items-center gap-0.5 border-b border-[var(--color-rule)] px-2 py-1.5">
        <Group>
          <Tool label="H1" title="Heading" onClick={() => run("formatBlock", "<h1>")} />
          <Tool label="H2" title="Subheading" onClick={() => run("formatBlock", "<h2>")} />
          <Tool label="H3" title="Sub-subheading" onClick={() => run("formatBlock", "<h3>")} />
          <Tool label="¶" title="Body text" onClick={() => run("formatBlock", "<p>")} />
        </Group>
        <Divider />
        <Group>
          <Tool label="B" title="Bold (Ctrl+B)" bold onClick={() => run("bold")} />
          <Tool label="I" title="Italic (Ctrl+I)" italic onClick={() => run("italic")} />
        </Group>
        <Divider />
        <Group>
          <Tool label="“ ”" title="Block quote" onClick={() => run("formatBlock", "<blockquote>")} />
          <Tool label="•" title="Bulleted list" onClick={() => run("insertUnorderedList")} />
          <Tool label="1." title="Numbered list" onClick={() => run("insertOrderedList")} />
        </Group>
        <Divider />
        <button
          onClick={onCite}
          className="rounded px-2 py-1 text-xs font-medium text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)]"
          title="Add a reference and cite it here"
        >
          + Citation
        </button>

        {citations.length > 0 && (
          <select
            className="ml-1 max-w-[13rem] rounded border border-[var(--color-rule)] bg-white px-1.5 py-1 text-xs"
            value=""
            onChange={(e) => {
              const i = Number(e.target.value);
              if (Number.isFinite(i) && e.target.value !== "") insertCitation(i);
              e.target.value = "";
            }}
            title="Cite something already in your references"
          >
            <option value="">Cite existing…</option>
            {citations.map((c, i) => (
              <option key={c.id} value={i}>
                [{i + 1}] {c.text.slice(0, 44)}
              </option>
            ))}
          </select>
        )}

        <span className="ml-auto text-[0.68rem] text-[var(--color-muted)]">
          Pastes arrive as plain text
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
}: {
  label: string;
  title: string;
  onClick: () => void;
  bold?: boolean;
  italic?: boolean;
}) {
  return (
    <button
      // Stops the editor losing its selection the moment the button is pressed,
      // which would apply the command to nothing.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      title={title}
      className={`min-w-[1.9rem] rounded px-1.5 py-1 text-xs hover:bg-[var(--color-accent-soft)] ${
        bold ? "font-bold" : ""
      } ${italic ? "italic" : ""}`}
    >
      {label}
    </button>
  );
}
