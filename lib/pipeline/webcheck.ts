import { Type, type Schema } from "@google/genai";
import { db, tx } from "../db";
import { generateWebJson } from "../ai/client";
import { sameUrl } from "../ai/claude-code";
import { finishTask } from "../queue";
import type { Task } from "../types";
import { stripMarkers } from "../markers";
import type { WebFinding, WebReport, WebScope, WebSource, WebVerdict } from "../web-checks";
import { findShippingCodes, type ShippingCode } from "../../research/shipping-codes.mjs";

/**
 * Checks an entry, or its connections, against the open web.
 *
 * Everything else in Corpus judges against your own sources, on purpose: the
 * point of an entry is what THIS library says. This is the one step that looks
 * outside it, and only when you ask — to catch the entry that faithfully
 * repeats a source that was wrong, or a connection a single article got
 * backwards. It reports and never edits: the entry and the connections stay
 * as written, the verdicts sit beside them.
 *
 * The search is Claude Code's own, on your plan. Every source the answer names
 * is matched against the addresses the searches actually returned or a fetch
 * actually opened; one that is on neither list was not read, so it is dropped,
 * and a verdict left with no source is reported as "not found" rather than
 * shown resting on nothing.
 */

const SOURCE = {
  type: Type.OBJECT,
  properties: {
    url: { type: Type.STRING, description: "The page's address, exactly as the search or fetch gave it." },
    title: { type: Type.STRING },
    says: {
      type: Type.STRING,
      description: "Under 30 words: what this page says on the point, closely paraphrased or quoted.",
    },
  },
  required: ["url", "says"],
};

/** Something found along the way that the library does not have yet. */
const LEADS = {
  type: Type.ARRAY,
  description:
    "At most eight: pages or records you found that add something the text does not have and would be worth the researcher reading as a new source — or a shipment worth tracking. Not the pages you cited for a verdict, unless they also carry more.",
  items: {
    type: Type.OBJECT,
    properties: {
      url: { type: Type.STRING, description: "Exactly as a search, fetch or tool returned it." },
      title: { type: Type.STRING },
      why: { type: Type.STRING, description: "One sentence: what it adds." },
      kind: { type: Type.STRING, enum: ["source", "record", "post", "shipment"] },
    },
    required: ["url", "why", "kind"],
  },
};

const VERDICT = {
  type: Type.STRING,
  enum: ["confirmed", "partly", "disputed", "not_found"],
};

const ENTRY_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    overview: { type: Type.STRING, description: "Two sentences at most: how the entry holds up overall." },
    leads: LEADS,
    claims: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          claim: { type: Type.STRING, description: "The claim, in the entry's own language and close to its words." },
          verdict: VERDICT,
          note: {
            type: Type.STRING,
            description: "One sentence. For 'partly' and 'disputed', say exactly what the sources say instead.",
          },
          sources: { type: Type.ARRAY, items: SOURCE },
        },
        required: ["claim", "verdict", "sources"],
      },
    },
  },
  required: ["claims"],
};

const CONNECTIONS_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    overview: { type: Type.STRING, description: "Two sentences at most: how the connections hold up overall." },
    leads: LEADS,
    connections: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.INTEGER, description: "The connection's number, as given." },
          verdict: VERDICT,
          note: {
            type: Type.STRING,
            description: "One sentence. For 'partly' and 'disputed', say what the sources say the tie really is.",
          },
          sources: { type: Type.ARRAY, items: SOURCE },
        },
        required: ["id", "verdict", "sources"],
      },
    },
  },
  required: ["connections"],
};

const RULES = `How to judge:

- confirmed: reliable pages you found state it.
- partly: they bear out part of it, or bear it out with a qualification the
  text drops (a different date, a narrower role, "alleged" where the text says
  "did"). Say which part in the note.
- disputed: reliable pages say something incompatible. Say what they say.
- not_found: you searched and found nothing either way. This is not an
  accusation; much of what a private library holds never reaches the web.

Rules:
- Search. Judge only on what the pages you found say. Your own memory is not a
  source: a claim you are sure of is "not_found" until a page bears it out.
- Prefer primary and reputable sources: official sites and records, major news
  organisations, encyclopedias, academic publishers. Ignore content farms,
  forums, and pages that look copied from somewhere else.
- Give every confirmed, partly or disputed verdict at least one source, with
  the page's address exactly as the search or fetch returned it. Never write
  an address from memory or guess one; it will be checked and dropped.
- Where pages disagree with each other, say so in the note and give both.
- Where the text describes something recent, look for the most recent
  reporting; a later development can overtake an earlier one.
- Write the claim and the note in the language the text is written in.
- Keep it to about twenty-five searches and tool calls in all.

Research tools. Besides web search you may have tools named research__…:
Wikidata (roles and their dates, official accounts), a worldwide news archive,
academic papers, the Wayback Machine, sanctions and politically-exposed-person
lists, company registries, US SEC filings, US court records, public posts from
Bluesky, Mastodon and Telegram channels, YouTube and Reddit search, and a ship
register and shipment tracker. Pick the tool that fits each claim: a register
or official record beats an article about it. A tool's answer counts as a
source on the same terms as a page: cite the address it gave.

People:
- Research people only in their public role: offices, appointments,
  directorships, filings, court cases, public statements, official accounts.
- Never look for home addresses, phone numbers, email addresses, family
  members, or private social-media accounts, of anyone.
- Someone with no public role who appears in the text is checked only as far
  as the claim about them goes, and no further.

Shipments: where SHIPPING CODES are listed, decide whether any matters to a
claim — a ship or container in a sanctions or smuggling story, say. Look up a
ship with the vessel tool; for a container, bill of lading or air waybill, the
track_shipment tool says whose it is and gives the tracking page. Report a
tracking page you could not read yourself as a lead of kind "shipment".`;

const ENTRY_SYSTEM = `You fact-check an encyclopedia entry against the open web.
The entry was written from a researcher's private sources. You are not editing
it: no rewrites, no style notes, no suggestions of what to add.

First pick the entry's checkable claims — at most fifteen, the ones that matter
most: names, roles and titles, dates, figures, places, events, quotations and
who said them. Skip opinion, framing and anything too vague to check. Then
check each one on the web.

${RULES}`;

const CONNECTIONS_SYSTEM = `You fact-check the connections recorded between one
subject and others in a researcher's encyclopedia — "X advised Y", "X is a
member of Y" — against the open web. Each was read out of a single passage of
the researcher's sources, so a connection can be backwards, out of date, or
simply wrong. You are not editing them.

Check every numbered connection: is that tie between those two real, and is it
the tie stated? Give each connection its number back.

${RULES}`;

/** Connections checked in one go, the most-discussed first. */
const MAX_CONNECTIONS = 40;

export async function handleWebcheck(task: Task): Promise<void> {
  const { entityId, scope } = JSON.parse(task.payload_json) as { entityId: number; scope: WebScope };

  const entity = db()
    .prepare("SELECT id, canonical_name, type, disambiguator FROM entities WHERE id=?")
    .get(entityId) as { id: number; canonical_name: string; type: string; disambiguator: string | null } | undefined;
  if (!entity) {
    finishTask(task.id, task.run_id, { tokensIn: 0, tokensOut: 0 }, "skipped", "That subject no longer exists.");
    return;
  }
  const who = `${entity.canonical_name} (${entity.type}${entity.disambiguator ? `, ${entity.disambiguator}` : ""})`;

  let findings: WebFinding[];
  let overview: string | undefined;
  let usage: { tokensIn: number; tokensOut: number };
  let leads: Lead[] = [];
  let seen: string[] = [];

  // Shipping codes in the passages behind this subject, found by rule — each
  // one's check digit holds — so Claude can decide whether any is worth a look.
  const codes = shippingCodesFor(entityId);
  const codeBlock = codes.length
    ? `SHIPPING CODES in the researcher's sources about this subject:\n${codes
        .map((c) => `- ${c.kind} ${c.code}${c.carrier ? ` (${c.carrier})` : c.airline ? ` (${c.airline})` : ""}`)
        .join("\n")}`
    : "";

  if (scope === "connections") {
    const relations = db()
      .prepare(
        `SELECT r.id, r.type, r.quote, r.from_entity,
                other.canonical_name AS other_name, other.type AS other_type,
                (SELECT COUNT(*) FROM live_mentions m WHERE m.entity_id = other.id) AS weight
           FROM relations r
           JOIN entities other
             ON other.id = CASE WHEN r.from_entity=? THEN r.to_entity ELSE r.from_entity END
          WHERE (r.from_entity=? OR r.to_entity=?) AND other.merged_into IS NULL
          ORDER BY weight DESC
          LIMIT ${MAX_CONNECTIONS}`
      )
      .all(entityId, entityId, entityId) as {
      id: number;
      type: string;
      quote: string | null;
      from_entity: number;
      other_name: string;
      other_type: string;
    }[];
    if (!relations.length) {
      finishTask(task.id, task.run_id, { tokensIn: 0, tokensOut: 0 }, "skipped", "No connections to check.");
      return;
    }
    const said = (r: (typeof relations)[number]) =>
      r.from_entity === entityId
        ? `${entity.canonical_name} — ${r.type} — ${r.other_name} (${r.other_type})`
        : `${r.other_name} (${r.other_type}) — ${r.type} — ${entity.canonical_name}`;

    const res = await generateWebJson<{
      overview?: string;
      leads?: Lead[];
      connections: { id: number; verdict: WebVerdict; note?: string; sources?: WebSource[] }[];
    }>({
      stage: "verify",
      research: true,
      system: CONNECTIONS_SYSTEM,
      schema: CONNECTIONS_SCHEMA,
      prompt: [
        `SUBJECT: ${who}`,
        `CONNECTIONS:\n${relations
          .map((r) => `${r.id}. ${said(r)}${r.quote ? `\n   from the passage: "${r.quote.slice(0, 300)}"` : ""}`)
          .join("\n")}`,
        codeBlock,
      ]
        .filter(Boolean)
        .join("\n\n"),
    });
    usage = res.usage;
    overview = res.data.overview;
    leads = res.data.leads ?? [];
    seen = res.seen;
    const byId = new Map(relations.map((r) => [r.id, r]));
    findings = (res.data.connections ?? [])
      .filter((c) => byId.has(c.id))
      .map((c) => keepRead({ claim: said(byId.get(c.id)!), relationId: c.id, verdict: c.verdict, note: c.note, sources: c.sources ?? [] }, res.seen));
  } else {
    const entry = db()
      .prepare("SELECT summary, body_md FROM entries WHERE entity_id=?")
      .get(entityId) as { summary: string; body_md: string } | undefined;
    if (!entry?.body_md?.trim()) {
      finishTask(task.id, task.run_id, { tokensIn: 0, tokensOut: 0 }, "skipped", "No entry written yet.");
      return;
    }
    const res = await generateWebJson<{
      overview?: string;
      leads?: Lead[];
      claims: { claim: string; verdict: WebVerdict; note?: string; sources?: WebSource[] }[];
    }>({
      stage: "verify",
      research: true,
      system: ENTRY_SYSTEM,
      schema: ENTRY_SCHEMA,
      prompt: [
        `SUBJECT: ${who}`,
        `ENTRY:\n"""\n${entry.summary}\n\n${stripMarkers(entry.body_md)}\n"""`,
        codeBlock,
      ]
        .filter(Boolean)
        .join("\n\n"),
    });
    usage = res.usage;
    overview = res.data.overview;
    leads = res.data.leads ?? [];
    seen = res.seen;
    findings = (res.data.claims ?? [])
      .filter((c) => c.claim?.trim())
      .map((c) => keepRead({ claim: c.claim.trim(), verdict: c.verdict, note: c.note, sources: c.sources ?? [] }, res.seen));
  }

  const report: WebReport = { scope, findings, overview, checkedAt: new Date().toISOString() };
  const count = (v: WebVerdict) => findings.filter((f) => f.verdict === v).length;

  tx(() => {
    db()
      .prepare(
        `INSERT INTO web_checks (entity_id, scope, report_json) VALUES (?,?,?)
         ON CONFLICT(entity_id, scope) DO UPDATE SET report_json=excluded.report_json, checked_at=datetime('now')`
      )
      .run(entityId, scope, JSON.stringify(report));
    const added = saveLeads(entityId, scope, leads, seen);
    finishTask(
      task.id,
      task.run_id,
      usage,
      "done",
      `${findings.length} ${scope === "connections" ? "connection(s)" : "claim(s)"} checked on the web: ${count(
        "confirmed"
      )} confirmed, ${count("partly")} partly, ${count("disputed")} disputed, ${count("not_found")} not found.${
        added ? ` ${added} new lead(s) in the Research inbox.` : ""
      }`
    );
  });
}

interface Lead {
  url: string;
  title?: string;
  why: string;
  kind: "source" | "record" | "post" | "shipment";
}

/**
 * Puts what the check found along the way in the Research inbox — kept apart
 * from the news inbox, because these were looked for, about one subject, and
 * nothing reaches the library until you keep it. Only addresses a search or a
 * tool actually returned; one already there for this subject is not added
 * twice, and one you dismissed stays dismissed.
 */
function saveLeads(entityId: number, scope: WebScope, leads: Lead[], seen: string[]): number {
  const read = new Set(seen);
  const insert = db().prepare(
    `INSERT OR IGNORE INTO research_finds (entity_id, scope, url, title, why, kind) VALUES (?,?,?,?,?,?)`
  );
  let n = 0;
  for (const l of leads.slice(0, 8)) {
    if (!l?.url || !l.why || !read.has(sameUrl(l.url))) continue;
    const kind = ["source", "record", "post", "shipment"].includes(l.kind) ? l.kind : "source";
    n += insert.run(entityId, scope, l.url.trim(), l.title?.trim() || null, l.why.trim(), kind).changes;
  }
  return n;
}

/** Codes in the text of every passage that mentions this subject. */
function shippingCodesFor(entityId: number): ShippingCode[] {
  const rows = db()
    .prepare(
      `SELECT c.text FROM chunks c
        WHERE c.id IN (SELECT chunk_id FROM live_mentions WHERE entity_id = ?)
        LIMIT 400`
    )
    .all(entityId) as { text: string }[];
  const found = new Map<string, ShippingCode>();
  for (const r of rows) for (const c of findShippingCodes(r.text)) found.set(`${c.kind}:${c.code}`, c);
  return [...found.values()].slice(0, 30);
}

/**
 * Keeps the sources the searches really returned. A verdict that loses all of
 * them is not shown as if it rested on something: it becomes "not found".
 */
function keepRead(f: WebFinding, seen: string[]): WebFinding {
  const read = new Set(seen);
  const sources = f.sources.filter((s) => s.url && read.has(sameUrl(s.url)));
  const unread = f.sources.length - sources.length;
  const verdict = f.verdict !== "not_found" && sources.length === 0 ? "not_found" : f.verdict;
  return {
    ...f,
    verdict: (["confirmed", "partly", "disputed", "not_found"] as const).includes(verdict) ? verdict : "not_found",
    sources,
    ...(unread ? { unread } : {}),
  };
}
