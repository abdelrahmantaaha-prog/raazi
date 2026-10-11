import { Type, type Schema } from "@google/genai";
import { db, tx } from "../db";
import { generateWebJson } from "../ai/client";
import { sameUrl } from "../ai/claude-code";
import { finishTask } from "../queue";
import type { Task } from "../types";
import { stripMarkers } from "../markers";
import { LIT_KINDS, RESEARCH_KINDS, renumberCitations, reviewInput, saveReport, type LitKind, type LitResult } from "../litreview";

/**
 * Literature review & news: what else has been written on a text.
 *
 * The text is an article (a source — an inbox item's fetched article is one),
 * a draft, or a passage highlighted in a source. Claude on your plan searches
 * the web, and Corpus's own tools for academic papers and the news archive,
 * and comes back with research and news on it and a short review of the
 * field. Asked for by hand; it spends the plan's allowance.
 *
 * The same guard as the web check: every result is matched against the
 * addresses the searches really returned or a fetch really opened, and one
 * that is on neither list was remembered or made up, so it is dropped — a
 * paper that does not exist is the worst thing a literature review can hand
 * a researcher. The review's citations are renumbered to what survived.
 */

/** About five thousand words of a long text; the rest is not needed to know what it is about. */
const TEXT_LIMIT = 30_000;
/** At most this many results of each kind are kept. */
const MAX_RESEARCH = 10;
const MAX_NEWS = 8;

const SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    overview: {
      type: Type.STRING,
      description:
        "120–250 words: a short literature review of the subject, citing the results as [1], [2]… by their number in the results list.",
    },
    results: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          kind: { type: Type.STRING, enum: LIT_KINDS, description: "paper, report, book, news or analysis" },
          title: { type: Type.STRING },
          url: { type: Type.STRING, description: "The address exactly as the search, tool or fetch gave it." },
          authors: { type: Type.STRING, description: "Authors, or the institution that published it." },
          outlet: { type: Type.STRING, description: "Journal, publisher, think tank or news outlet." },
          date: { type: Type.STRING, description: "Year for research; the date for news (YYYY-MM-DD)." },
          finding: { type: Type.STRING, description: "One or two sentences: what it finds or reports, from the page." },
          why: { type: Type.STRING, description: "One sentence: how it bears on the text." },
        },
        required: ["kind", "title", "url", "finding", "why"],
      },
    },
  },
  required: ["overview", "results"],
};

const SYSTEM = `You are a research librarian for a journalist and researcher. You are given a
text — an article they are reading, a draft they are writing, or a passage or
idea they highlighted while reading — and you find what else has been written
on it, then write a short literature review.

What to find:
- Research: peer-reviewed papers, working papers and preprints, books, and
  reports from think tanks, NGOs, international bodies and governments.
- News: reporting and analysis from reputable outlets, the most recent first.

How:
- First work out what the text is about and the specific questions it raises.
  When a FOCUS is given, the focus is the subject; the rest is context only.
- Search the web, and use the academic-papers and news-archive tools if you
  have them. Search in the text's language and in English. Prefer an
  open-access copy of a paper where one exists (the publisher's page, a
  repository, arXiv or SSRN) over a paywalled one.
- Results: up to ${MAX_RESEARCH} research and up to ${MAX_NEWS} news, most relevant first.
  Fewer is fine — quality over quantity. No content farms, no copies of
  other pages, no forums.
- For each, say what it finds or reports, from the page or the abstract you
  were shown, and how it bears on the text: supports it, contradicts it,
  extends it, gives background, or is the original source of something in it.
- Every result must be something a search, a tool or a fetch actually returned
  in this session, with its address exactly as given. Never write an address
  or a paper from memory; it will be checked and dropped.
- The overview is a literature review in miniature: what is established, where
  researchers disagree, what the latest news adds, and what is missing. Cite
  results by their number in your list — [1] is the first — and say nothing in
  it that your results do not support.
- Write the overview, findings and notes in the language the text is written in.
- Keep it to about thirty searches and tool calls in all.

People: research people only in their public role. Never look for home
addresses, phone numbers, email addresses, family members or private accounts.`;

/** What the model is shown. */
function inputFor(reviewId: number): { prompt: string; partial?: string } | { skip: string } {
  const r = reviewInput(reviewId);
  if (!r) return { skip: "The review is gone." };

  let title = r.title;
  let text = "";
  if (r.target === "draft") {
    const d = db().prepare("SELECT title, body_md FROM drafts WHERE id=?").get(r.target_id) as
      | { title: string; body_md: string }
      | undefined;
    if (!d) return { skip: "The draft is gone." };
    title = d.title || title;
    // Stored as the editor's HTML.
    text = stripMarkers(d.body_md ?? "")
      .replace(/<\/(p|h[1-6]|li|blockquote|div)>/gi, "\n\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } else {
    const s = db().prepare("SELECT title, author, outlet, published_at FROM sources WHERE id=?").get(r.target_id) as
      | { title: string; author: string | null; outlet: string | null; published_at: string | null }
      | undefined;
    if (!s) return { skip: "The source is gone." };
    title = [s.title, s.author, s.outlet, s.published_at?.slice(0, 10)].filter(Boolean).join(" — ");
    // With a focus, the paragraph around it is enough context; without one,
    // the text itself is the subject.
    if (!r.focus) {
      const chunks = db().prepare("SELECT text FROM chunks WHERE source_id=? ORDER BY seq").all(r.target_id) as { text: string }[];
      text = chunks.map((c) => c.text).join("\n\n");
    }
  }
  if (!r.focus && !text.trim()) return { skip: r.target === "draft" ? "The draft is empty." : "The source has no text yet." };

  const partial =
    text.length > TEXT_LIMIT ? `Only the first ${Math.round(TEXT_LIMIT / 6).toLocaleString("en")} or so words were read.` : undefined;
  const prompt = [
    `WHAT IT IS: ${r.target === "draft" ? "a draft the researcher is writing" : r.focus ? "a passage highlighted in a source they are reading" : "an article or source they are reading"}`,
    `TITLE: ${title}`,
    r.focus ? `FOCUS (the subject):\n"""\n${r.focus.slice(0, 4000)}\n"""` : "",
    r.focus && r.context && r.context.trim() !== r.focus.trim() ? `CONTEXT (around the focus):\n"""\n${r.context.slice(0, 6000)}\n"""` : "",
    text ? `TEXT:\n"""\n${text.slice(0, TEXT_LIMIT)}\n"""` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return { prompt, partial };
}

/** The results that were really read, at most so many of each kind, with the original numbers of those kept. Pure. */
export function keepReadResults(
  results: Partial<LitResult>[],
  seen: string[]
): { results: LitResult[]; kept: number[]; dropped: number } {
  const read = new Set(seen.map(sameUrl));
  const out: LitResult[] = [];
  const kept: number[] = [];
  const urls = new Set<string>();
  let dropped = 0;
  let research = 0;
  let news = 0;
  results.forEach((r, i) => {
    const url = r.url?.trim();
    if (!url || !r.title?.trim() || !read.has(sameUrl(url))) {
      if (url) dropped++;
      return;
    }
    if (urls.has(sameUrl(url))) return;
    const kind: LitKind = LIT_KINDS.includes(r.kind as LitKind) ? (r.kind as LitKind) : "analysis";
    const isResearch = RESEARCH_KINDS.includes(kind);
    if (isResearch ? research >= MAX_RESEARCH : news >= MAX_NEWS) return;
    if (isResearch) research++;
    else news++;
    urls.add(sameUrl(url));
    kept.push(i + 1);
    out.push({
      kind,
      title: r.title.trim(),
      url,
      ...(r.authors?.trim() ? { authors: r.authors.trim() } : {}),
      ...(r.outlet?.trim() ? { outlet: r.outlet.trim() } : {}),
      ...(r.date?.trim() ? { date: r.date.trim() } : {}),
      finding: (r.finding ?? "").trim(),
      why: (r.why ?? "").trim(),
    });
  });
  return { results: out, kept, dropped };
}

export async function handleLitReview(task: Task): Promise<void> {
  const { reviewId } = JSON.parse(task.payload_json) as { reviewId: number };
  const input = inputFor(reviewId);
  if ("skip" in input) {
    finishTask(task.id, task.run_id, { tokensIn: 0, tokensOut: 0 }, "skipped", input.skip);
    return;
  }

  const res = await generateWebJson<{ overview?: string; results?: Partial<LitResult>[] }>({
    stage: "verify",
    research: true,
    system: SYSTEM,
    schema: SCHEMA,
    prompt: input.prompt,
  });

  const { results, kept, dropped } = keepReadResults(res.data.results ?? [], res.seen);
  const overview = renumberCitations(res.data.overview ?? "", kept);
  const papers = results.filter((r) => RESEARCH_KINDS.includes(r.kind)).length;

  tx(() => {
    saveReport(reviewId, {
      overview,
      results,
      dropped,
      searchedAt: new Date().toISOString(),
      ...(input.partial ? { partial: input.partial } : {}),
    });
    finishTask(
      task.id,
      task.run_id,
      res.usage,
      "done",
      `${papers} research result(s) and ${results.length - papers} news result(s) found.${
        dropped ? ` ${dropped} named but never opened, and dropped.` : ""
      }`
    );
  });
}
