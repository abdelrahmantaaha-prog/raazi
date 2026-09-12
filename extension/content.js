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

  const text = selection.trim().length >= 400 ? selection.trim() : (article && article.textContent ? article.textContent : document.body.innerText || "");

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
    text: text.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim(),
    fromSelection: selection.trim().length >= 400,
  };
})();
