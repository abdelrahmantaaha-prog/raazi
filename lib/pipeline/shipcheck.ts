import { Type, type Schema } from "@google/genai";
import { db, tx } from "../db";
import { generateWebJson } from "../ai/client";
import { sameUrl } from "../ai/claude-code";
import { finishTask } from "../queue";
import { patchMeta, readMeta } from "../source-meta";
import type { Task } from "../types";
import type { WebSource } from "../web-checks";
import { findShippingCodes } from "../../research/shipping-codes.mjs";
import { LEADS, SOURCE, TOOLS_AND_PEOPLE, saveLeads, type Lead } from "./webcheck";
import type { ShipmentRecord, ShippingMeta } from "./shipment";

/**
 * A shipment, looked up on the open web and in public records.
 *
 * The entry check asks whether what the library says is true. A shipping paper
 * needs the other question: what does the public record say about what it
 * names? Who the parties are and where they are registered, whether any is on
 * a sanctions or export-control list, what each customs code covers, where a
 * contract, batch or part number turns up, and what has been reported about
 * such goods on such a route. Asked for by hand, one shipment at a time, on
 * your plan's searches. It reports beside the paper and never edits it.
 */

export type LookupStatus = "flag" | "found" | "nothing";
export type LookupKind = "party" | "code" | "reference" | "goods" | "route" | "place";

export interface Lookup {
  subject: string;
  kind: LookupKind;
  status: LookupStatus;
  found: string;
  sources: WebSource[];
  /** Sources the answer named that no search returned — dropped, counted. */
  unread?: number;
}

export interface ShipmentCheck {
  overview?: string;
  lookups: Lookup[];
  leads: number;
  checkedAt: string;
}

const SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    overview: { type: Type.STRING, description: "Three sentences at most: what the public record adds to this paper, most important first." },
    leads: LEADS,
    lookups: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          subject: { type: Type.STRING, description: "What was looked up, as the paper writes it: a party, a code, a number, the goods on the route." },
          kind: { type: Type.STRING, enum: ["party", "code", "reference", "goods", "route", "place"] },
          status: { type: Type.STRING, enum: ["flag", "found", "nothing"] },
          found: { type: Type.STRING, description: "Two or three sentences: what the sources say about it. For 'nothing', what was searched." },
          sources: { type: Type.ARRAY, items: SOURCE },
        },
        required: ["subject", "kind", "status", "found", "sources"],
      },
    },
  },
  required: ["lookups"],
};

const SYSTEM = `You research a shipment recorded in a journalist's shipping papers, on the
open web and in public records. You are not judging the papers and not
rewriting them: you find what the public record says about what they name.

Look up, most valuable first:
1. Every party — company or organisation. Company registers: where it is
   registered, its number, status and dates, and its directors or owners
   where a register shows them. Sanctions, export-control and
   arms-embargo lists. Serious reporting about it. Any other name it trades or
   traded under.
2. Every customs (HS) code: what that heading covers, from a customs tariff
   or trade-classification page.
3. Every number that may be public — contract, batch, part, serial, model
   numbers — searched exactly as written.
4. Any SHIPPING CODES listed: look a ship up with the vessel tool; for a
   container, bill of lading or air waybill, track_shipment says whose it is
   and gives the tracking page. A tracking page you cannot read yourself is a
   lead of kind "shipment".
5. The goods and the route together: reporting, UN Panel of Experts or
   arms-trade reports, export-licence records or court cases about such goods
   moving between those places, and any embargo on the destination.
A business address may be looked up to see which companies sit at it.

Status:
- flag: something the journalist must see — a listing on a sanctions,
  export-control or debarment list; an embargo covering these goods to this
  destination; reporting that ties a party, a number or these goods on this
  route to diversion, smuggling or a conflict.
- found: public records or reporting bear on it, without a flag.
- nothing: you searched and found nothing relevant. Say what you searched.

Rules:
- Search. Report only what the pages and tools you used say. Your own memory
  is not a source: anything you know but did not find is "nothing".
- Prefer registers, official lists and records, and reputable reporting.
  Ignore content farms and pages copied from elsewhere.
- Give every "flag" and "found" at least one source, with the address exactly
  as the search, fetch or tool returned it. Never write an address from
  memory; it will be checked and dropped.
- A name match is not an identity match: say what ties a record to this party
  (the same registration number, address, country, directors), or say that
  only the name matches.
- Write "found" and the overview in the language of the paper's summary.
- Keep it to about thirty searches and tool calls in all.

${TOOLS_AND_PEOPLE}`;

export async function handleShipcheck(task: Task): Promise<void> {
  const { sourceId, shipment } = JSON.parse(task.payload_json) as { sourceId: number; shipment: number };
  const meta = readMeta(sourceId);
  const shipping = meta.shipping as ShippingMeta | undefined;
  const s = shipping?.shipments?.[shipment];
  if (!s) {
    finishTask(task.id, task.run_id, { tokensIn: 0, tokensOut: 0 }, "skipped", "That shipment is no longer on record.");
    return;
  }
  const text = (db().prepare("SELECT text FROM chunks WHERE source_id=? ORDER BY seq").all(sourceId) as { text: string }[])
    .map((c) => c.text)
    .join("\n");
  const codes = findShippingCodes(text);
  const linked = (shipping?.links ?? []).filter((l) => l.shipment === shipment + 1);

  const res = await generateWebJson<{ overview?: string; leads?: Lead[]; lookups: Omit<Lookup, "unread">[] }>({
    stage: "verify",
    research: true,
    system: SYSTEM,
    schema: SCHEMA,
    prompt: [
      `SHIPMENT\n${describe(s)}`,
      linked.length
        ? `PAPERS IT BELONGS WITH:\n${linked.map((l) => `- ${l.relation} ${titleOf(l.sourceId)} (${l.reason})`).join("\n")}`
        : "",
      codes.length
        ? `SHIPPING CODES found in the paper:\n${codes
            .map((c) => `- ${c.kind} ${c.code}${c.carrier ? ` (${c.carrier})` : c.airline ? ` (${c.airline})` : ""}`)
            .join("\n")}`
        : "SHIPPING CODES: none in the paper.",
    ]
      .filter(Boolean)
      .join("\n\n"),
  });

  const read = new Set(res.seen);
  const lookups: Lookup[] = (res.data.lookups ?? [])
    .filter((l) => l?.subject?.trim())
    .map((l) => {
      const sources = (l.sources ?? []).filter((x) => x?.url && read.has(sameUrl(x.url)));
      const unread = (l.sources ?? []).length - sources.length;
      // A finding that lost every source it named rests on nothing.
      const status: LookupStatus =
        l.status !== "nothing" && sources.length === 0 ? "nothing" : (["flag", "found", "nothing"] as const).includes(l.status) ? l.status : "nothing";
      return { subject: l.subject.trim(), kind: l.kind, status, found: l.found?.trim() ?? "", sources, ...(unread ? { unread } : {}) };
    });

  tx(() => {
    const entityId = s.entityId ? root(s.entityId) : null;
    const leads = entityId ? saveLeads(entityId, "shipment", res.data.leads ?? [], res.seen) : 0;
    const report: ShipmentCheck = { overview: res.data.overview?.trim(), lookups, leads, checkedAt: new Date().toISOString() };
    const checks = { ...((readMeta(sourceId).shippingChecks as Record<string, ShipmentCheck> | undefined) ?? {}), [shipment]: report };
    patchMeta(sourceId, { shippingChecks: checks });
    const n = (st: LookupStatus) => lookups.filter((l) => l.status === st).length;
    finishTask(
      task.id,
      task.run_id,
      res.usage,
      "done",
      `${lookups.length} looked up online: ${n("flag")} to see, ${n("found")} found, ${n("nothing")} nothing found.${
        leads ? ` ${leads} new lead(s) in the Research inbox.` : ""
      }`
    );
  });
}

/** The shipment as the researcher's paper records it, for the prompt. */
function describe(s: ShipmentRecord): string {
  const lines = [`${s.name} — ${s.documentType}${s.dateText ? `, dated ${s.dateText}` : ""}`, s.summary];
  if (s.references?.length) lines.push(`Papers: ${s.references.map((r) => `${r.kind} ${r.value}${r.date ? ` (${r.date})` : ""}`).join("; ")}`);
  if (s.parties.length) lines.push(`Parties:\n${s.parties.map((p) => `- ${p.role}: ${p.name}${p.address ? ` — ${p.address}` : ""}`).join("\n")}`);
  if (s.places.length) lines.push(`Route: ${s.places.map((p) => `${p.role} ${p.name}`).join("; ")}`);
  if (s.goods.length) {
    lines.push(
      `Goods:\n${s.goods
        .map((g, i) =>
          `${i + 1}. ${g.description}${[g.quantity && `qty ${g.quantity}`, g.hsCode && `HS ${g.hsCode}`, g.origin && `origin ${g.origin}`, g.serial && `serial ${g.serial}`, g.value && `value ${g.value}`]
            .filter(Boolean)
            .map((x) => `; ${x}`)
            .join("")}`
        )
        .join("\n")}`
    );
  }
  if (s.totals) {
    const t = s.totals;
    const parts = [t.packages && `${t.packages} packages`, t.grossKg && `${t.grossKg} kg gross`, t.value && `${t.value} ${t.currency ?? ""}`.trim()].filter(Boolean);
    if (parts.length) lines.push(`Totals: ${parts.join(", ")}`);
  }
  if (s.remarks?.trim()) lines.push(`Remarks: ${s.remarks.trim()}`);
  return lines.join("\n");
}

function titleOf(sourceId: number): string {
  const row = db().prepare("SELECT title FROM sources WHERE id=?").get(sourceId) as { title: string } | undefined;
  return row ? `"${row.title}"` : `source ${sourceId}`;
}

function root(id: number): number | null {
  let cur: number | null = id;
  for (let hops = 0; cur !== null && hops < 64; hops++) {
    const r = db().prepare("SELECT merged_into FROM entities WHERE id=?").get(cur) as { merged_into: number | null } | undefined;
    if (!r) return null;
    if (r.merged_into === null) return cur;
    cur = r.merged_into;
  }
  return cur;
}
