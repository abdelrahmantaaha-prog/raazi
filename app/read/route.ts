import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * The doorway to the one article window.
 *
 * Every outside link in Raazi points here rather than straight at the
 * article, and every one of them carries `target="corpus-article"`. The
 * browser reuses a window by name, so the second link you open replaces the
 * first instead of adding to a row of tabs that reaches the end of the bar by
 * mid-morning — a reading desk with one page on it, which is how you read a
 * wire feed.
 *
 * The bounce exists because a named window and a severed `window.opener`
 * cannot be had together any other way. `rel="noopener"` would stop the
 * article reaching back into Raazi, but it also makes the browser ignore the
 * name and open a new window every time; `window.open(url, name, "noopener")`
 * has the same problem. A page can, however, null *its own* opener — and once
 * it is null it stays null across the navigation that follows. So this page
 * does that and then replaces itself with the article. One window, reused,
 * with no handle back to the app.
 *
 * `location.replace` rather than an assignment, so the bounce leaves no step
 * in the window's history: Back in the article window goes to the previous
 * article, not to a blank page that immediately forwards again.
 */
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("u") ?? "";

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return bounceFailed("That link is not a web address.");
  }
  // Only the two schemes an article can live at. Without this the parameter
  // would carry javascript: and data: URLs into a click on our own origin.
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    return bounceFailed("Only http and https links open here.");
  }

  // Into a JS string, with the one sequence that could close the script tag
  // escaped. The address is never written into the markup itself.
  const literal = JSON.stringify(target.href).replace(/</g, "\\u003c");

  return html(`<!doctype html>
<meta charset="utf-8">
<title>Opening…</title>
<meta name="robots" content="noindex">
<style>body{font:14px system-ui,sans-serif;color:#6b7583;margin:0;display:grid;place-items:center;height:100vh}</style>
<p>Opening the article…</p>
<script>
  try { window.opener = null; } catch (e) {}
  location.replace(${literal});
</script>`);
}

function bounceFailed(message: string) {
  return html(`<!doctype html>
<meta charset="utf-8">
<title>Cannot open that link</title>
<style>body{font:14px system-ui,sans-serif;color:#12161f;margin:0;display:grid;place-items:center;height:100vh}</style>
<p>${message.replace(/[<>&]/g, "")}</p>`);
}

function html(body: string) {
  return new NextResponse(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      // This page only ever runs the one inline script written above.
      "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
      "referrer-policy": "no-referrer",
    },
  });
}
