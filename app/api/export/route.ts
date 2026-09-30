import path from "node:path";
import { NextResponse } from "next/server";
import { attachment, badRequest, notFound, queryId } from "@/lib/http";
import { db } from "@/lib/db";
import { citationOf, evidenceFor, listEntities } from "@/lib/queries";
import { formatCitation } from "@/lib/citation";
import { formatLocator } from "@/lib/chunk";
import type { Locator } from "@/lib/types";
import { briefDoc, entryDoc, toPdf } from "@/lib/pdf-export";

export const dynamic = "force-dynamic";

/**
 * Everything leaves as plain text you can paste into whatever you write in.
 * The citation is resolved here, not stored — it always reflects the current
 * source metadata.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const format = url.searchParams.get("format") ?? "markdown";
  const entityId = queryId(req, "entity");
  if (entityId !== null && !db().prepare("SELECT 1 FROM entities WHERE id=?").get(entityId)) {
    return notFound("No such entity.");
  }

  switch (format) {
    // A designed PDF of one entry (?entity=) or one brief (?brief=<day key>); see lib/pdf-export.ts.
    case "pdf": {
      const briefDay = url.searchParams.get("brief");
      const doc = briefDay ? briefDoc(briefDay) : entityId !== null ? entryDoc(entityId) : null;
      if (!doc) return notFound(briefDay ? "That brief has not been written." : "That entry has not been written.");
      try {
        const pdf = await toPdf(doc.html);
        return new NextResponse(new Uint8Array(pdf), {
          headers: { "content-type": "application/pdf", "content-disposition": attachment(`${doc.name}.pdf`) },
        });
      } catch (e) {
        return badRequest(e instanceof Error ? e.message : String(e));
      }
    }
    case "markdown":
      return text(entriesMarkdown(entityId ?? undefined), "corpus-entries.md");
    case "quotes":
      return text(quotesMarkdown(), "corpus-quotes.md");
    case "bibtex":
      return text(bibtex(), "corpus-sources.bib");
    case "json":
      return NextResponse.json(graph(), {
        headers: { "content-disposition": attachment("corpus-graph.json") },
      });
    default:
      return badRequest("Unknown format.");
  }
}

function text(body: string, filename: string) {
  return new NextResponse(body, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": attachment(filename),
    },
  });
}

/** Replaces [[m:12]] with a numbered footnote and collects the references. */
function renderCitations(body: string, entityId: number): { body: string; refs: string[] } {
  const evidence = new Map(evidenceFor(entityId).map((e) => [e.id, e]));
  const refs: string[] = [];
  const index = new Map<number, number>();

  const out = body.replace(/\[\[m:(\d+)\]\]/g, (_, raw) => {
    const id = Number(raw);
    const e = evidence.get(id);
    if (!e) return "";
    if (!index.has(id)) {
      index.set(id, refs.length + 1);
      refs.push(`[^${refs.length + 1}]: ${citationOf(e)} — "${e.quote}"`);
    }
    return `[^${index.get(id)}]`;
  });

  return { body: out, refs };
}

function entriesMarkdown(entityId?: number): string {
  const rows = entityId
    ? (db()
        .prepare("SELECT id, canonical_name, type FROM entities WHERE id=?")
        .all(entityId) as { id: number; canonical_name: string; type: string }[])
    : listEntities({ limit: 10000 })
        .filter((e) => e.summary !== null)
        .map((e) => ({ id: e.id, canonical_name: e.canonical_name, type: e.type }));

  const parts: string[] = [];
  for (const e of rows) {
    const entry = db()
      .prepare("SELECT summary, body_md, updated_at FROM entries WHERE entity_id=?")
      .get(e.id) as { summary: string; body_md: string; updated_at: string } | undefined;
    if (!entry) continue;

    const { body, refs } = renderCitations(entry.body_md, e.id);
    parts.push(
      `# ${e.canonical_name}\n\n*${e.type} — entry generated ${entry.updated_at} from the sources below*\n\n${entry.summary}\n\n${body}\n\n${refs.join("\n")}`
    );
  }

  return parts.length
    ? `# Corpus entries\n\n${parts.join("\n\n---\n\n")}\n`
    : "No entries have been generated yet.\n";
}

function quotesMarkdown(): string {
  const rows = db()
    .prepare(
      `SELECT m.quote, m.claim, e.canonical_name, e.type,
              s.title, s.author, s.year, c.locator_json, d.label AS doc_label
         FROM live_mentions m
         JOIN entities e ON e.id = m.entity_id
         JOIN sources  s ON s.id = m.source_id
         JOIN chunks   c ON c.id = m.chunk_id
    LEFT JOIN documents d ON d.id = c.doc_id
        WHERE m.starred = 1
        ORDER BY e.canonical_name, s.id`
    )
    .all() as {
    quote: string;
    claim: string | null;
    canonical_name: string;
    title: string;
    author: string | null;
    year: string | null;
    locator_json: string;
    doc_label: string | null;
  }[];

  if (!rows.length) return "No quotes starred yet. Star them from an entry's evidence list.\n";

  const byEntity = new Map<string, string[]>();
  for (const r of rows) {
    const cite = formatCitation({
      author: r.author,
      title: r.title,
      year: r.year,
      locator: formatLocator(JSON.parse(r.locator_json) as Locator, r.doc_label),
    });
    const line = `> ${r.quote.replace(/\n/g, "\n> ")}\n>\n> — ${cite}`;
    if (!byEntity.has(r.canonical_name)) byEntity.set(r.canonical_name, []);
    byEntity.get(r.canonical_name)!.push(line);
  }

  return (
    "# Quote bank\n\n" +
    [...byEntity.entries()]
      .map(([name, quotes]) => `## ${name}\n\n${quotes.join("\n\n")}`)
      .join("\n\n")
  );
}

function bibtex(): string {
  const sources = db()
    .prepare("SELECT * FROM sources ORDER BY id")
    .all() as {
    id: number;
    title: string;
    author: string | null;
    year: string | null;
    publisher: string | null;
    kind: string;
    url: string | null;
  }[];

  return sources
    .map((s) => {
      const key = `${(s.author ?? "anon").split(/[\s,]+/)[0].toLowerCase()}${s.year ?? ""}${s.id}`;
      const type = s.kind === "url" ? "online" : s.kind === "media" ? "misc" : "book";
      const fields = [
        `  title     = {${s.title}}`,
        s.author ? `  author    = {${s.author}}` : null,
        s.year ? `  year      = {${s.year}}` : null,
        s.publisher ? `  publisher = {${s.publisher}}` : null,
        s.url ? `  url       = {${s.url}}` : null,
      ].filter(Boolean);
      return `@${type}{${key},\n${fields.join(",\n")}\n}`;
    })
    .join("\n\n");
}

/**
 * The whole graph as JSON.
 *
 * `SELECT *` on sources ships the `path` column, which is an absolute path
 * into this machine's home directory — a detail of where Corpus happens to be
 * installed, in a file whose whole purpose is to be sent somewhere else. The
 * file name is what identifies the source; the directory is nobody's business.
 */
function graph() {
  const sources = (
    db().prepare("SELECT * FROM sources").all() as (Record<string, unknown> & {
      path: string | null;
    })[]
  ).map((s) => ({ ...s, path: s.path ? path.basename(s.path) : null }));

  return {
    exportedAt: new Date().toISOString(),
    sources,
    entities: db().prepare("SELECT id, type, canonical_name, disambiguator, entry_state FROM entities WHERE merged_into IS NULL").all(),
    entries: db().prepare("SELECT * FROM entries").all(),
    mentions: db().prepare("SELECT id, entity_id, source_id, surface, quote, claim FROM live_mentions").all(),
    relations: db().prepare("SELECT * FROM relations").all(),
    events: db().prepare("SELECT * FROM events").all(),
    contradictions: db().prepare("SELECT * FROM contradictions").all(),
  };
}
