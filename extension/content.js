// Runs in the page, after readability.js, and evaluates to what the popup
// needs: the article as this browser sees it — signed in, paywall open — with
// the metadata the page declares about itself.
//
// Readability works on a clone, so the page you are reading is not touched.
// If you selected text first, the selection wins: it is the surest way to get
// exactly the piece and nothing else on a page Readability misjudges.
(() => {
  const meta = (sel) => {
    const el = document.querySelector(sel);
    const v = el && (el.getAttribute("content") || el.getAttribute("datetime") || el.getAttribute("href"));
    return v ? v.trim() : "";
  };
  const first = (...sels) => {
    for (const s of sels) {
      const v = meta(s);
      if (v) return v;
    }
    return "";
  };

  const selection = (window.getSelection && String(window.getSelection())) || "";
  let article = null;
  try {
    // eslint-disable-next-line no-undef
    article = new Readability(document.cloneNode(true)).parse();
  } catch (e) {
    article = null;
  }

  // Readability's textContent runs every paragraph into the next — a <p> holds
  // no newline, so "…the vote.The committee…" — and that wall is what used to
  // be sent. Its HTML keeps the structure, so the text is taken from that: a
  // blank line between blocks, headings marked as Markdown so Raazi files the
  // passages under them, list items on lines of their own, and figure captions
  // left out, as Raazi's own fetcher does.
  const BLOCK = /^(P|DIV|SECTION|ARTICLE|MAIN|HEADER|FOOTER|ASIDE|BLOCKQUOTE|PRE|UL|OL|LI|TABLE|THEAD|TBODY|TR|DL|DT|DD|HR|H[1-6])$/;
  const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|FIGURE|FIGCAPTION|BUTTON|SVG)$/;
  const blocksOf = (html) => {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const out = [];
    let line = "";
    const end = () => {
      const t = line.replace(/ *\n */g, "\n").replace(/ {2,}/g, " ").trim();
      if (t) out.push(t);
      line = "";
    };
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) {
          line += child.nodeValue.replace(/\s+/g, " ");
          continue;
        }
        if (child.nodeType !== 1) continue;
        const tag = child.tagName.toUpperCase();
        if (SKIP.test(tag)) continue;
        if (tag === "BR") {
          line += "\n";
          continue;
        }
        if (!BLOCK.test(tag)) {
          walk(child);
          continue;
        }
        end();
        const heading = /^H([1-6])$/.exec(tag);
        if (heading) {
          const t = child.textContent.replace(/\s+/g, " ").trim();
          if (t) out.push(`${"#".repeat(Math.min(3, Number(heading[1])))} ${t}`);
          continue;
        }
        if (tag === "LI") line = "- ";
        walk(child);
        end();
      }
    };
    walk(doc.body);
    end();
    return out.join("\n\n");
  };

  let readable = "";
  try {
    readable = article && article.content ? blocksOf(article.content) : "";
  } catch (e) {
    readable = "";
  }
  const text =
    selection.trim().length >= 400
      ? selection.trim()
      : readable || (article && article.textContent) || document.body.innerText || "";
  const tidy = (s) => s.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  const image = first(
    'meta[property="og:image:secure_url"]',
    'meta[property="og:image"]',
    'meta[name="og:image"]',
    'meta[name="twitter:image"]',
    'meta[name="twitter:image:src"]'
  );
  let absImage = "";
  if (image) {
    try {
      absImage = new URL(image, location.href).toString();
    } catch (e) {
      absImage = "";
    }
  }

  const canonical = first('link[rel="canonical"]', 'meta[property="og:url"]');

  return {
    url: location.href,
    canonical: canonical || "",
    title: first('meta[property="og:title"]') || (article && article.title) || document.title || location.href,
    author:
      (article && article.byline) ||
      first('meta[name="author"]', 'meta[property="article:author"]', 'meta[name="dc.creator"]', 'meta[name="parsely-author"]'),
    publishedAt: first(
      'meta[property="article:published_time"]',
      'meta[name="article:published_time"]',
      'meta[property="og:published_time"]',
      'meta[name="pubdate"]',
      'meta[name="publishdate"]',
      'meta[name="date"]',
      'meta[name="dc.date"]',
      'meta[itemprop="datePublished"]',
      "time[datetime]"
    ),
    outlet: first('meta[property="og:site_name"]', 'meta[name="application-name"]') || (article && article.siteName) || "",
    image: absImage,
    lang: (document.documentElement.getAttribute("lang") || "").split(/[-_]/)[0].toLowerCase(),
    text: tidy(text),
    // The article whatever is selected, for sending alongside a gathered quote —
    // where the selection is the quote, not a stand-in for the article.
    articleText: tidy(readable || (article && article.textContent) || document.body.innerText || ""),
    selection: selection.trim(),
    fromSelection: selection.trim().length >= 400,
  };
})();
