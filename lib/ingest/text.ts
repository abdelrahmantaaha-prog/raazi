import type { Piece } from "../chunk";

/**
 * Plain text and Markdown. Headings become document labels, so a citation can
 * say which section it came from rather than just "p. ?".
 */
export function parseText(raw: string): Piece[] {
  const text = raw.replace(/\r\n/g, "\n").trim();
  if (!text) return [];

  const lines = text.split("\n");
  const pieces: Piece[] = [];
  let label = "";
  let buf: string[] = [];
  let charStart = 0;
  let cursor = 0;

  const flush = () => {
    const body = buf.join("\n").trim();
    if (body) {
      pieces.push({
        text: body,
        label: label || "Text",
        locator: { chapter: label || undefined, charStart, charEnd: cursor },
      });
    }
    buf = [];
    charStart = cursor;
  };

  for (const line of lines) {
    const heading = /^(#{1,3})\s+(.*\S)\s*$/.exec(line);
    // An underlined or ALL-CAPS short line reads as a heading in plain text too.
    const plainHeading =
      !heading && /^[A-Z؀-ۿ][^.!?]{2,70}$/.test(line.trim()) &&
      line.trim().length > 0 && !line.trim().endsWith(",");

    if (heading) {
      flush();
      label = heading[2];
    } else if (plainHeading && buf.length > 6) {
      flush();
      label = line.trim();
    } else {
      buf.push(line);
    }
    cursor += line.length + 1;
  }
  flush();

  return pieces.length ? pieces : [{ text, label: "Text", locator: { charStart: 0, charEnd: text.length } }];
}
