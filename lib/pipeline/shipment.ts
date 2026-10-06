import { Type, type Schema } from "@google/genai";
import { db, tx } from "../db";
import { generateJson } from "../ai/client";
import { getConfig } from "../config";
import { finishTask } from "../queue";
import { patchMeta, readMeta } from "../source-meta";
import type { ChunkExtraction, EntityType, ExtractedEntity, ExtractedRelation, Task } from "../types";
import { languageName, locateQuote, persist, quoteKey } from "./extract";
import { strongClaude } from "./ocr";

/**
 * Shipping papers — invoices and packing lists, loading plans, waybills,
 * manifests — read as what they are.
 *
 * The ordinary reading looks for named people, organisations and places in
 * prose. A loading plan has no prose and often no names: two aircraft of truck
 * chassis, a control cabin and simulators came out of it with nothing indexed
 * at all, and an invoice for a drone airframe from Minsk to Abu Dhabi gave its
 * parties but not that one had shipped to the other (6 Oct 2026). Here the
 * document is read whole for the shipment itself: who sent what to whom, when,
 * how, under which papers, and which other shipping papers in the library
 * belong with it. The shipment becomes an entry of its own, joined to its
 * parties and places, and the source carries the record for its page.
 */

/** A recognisable phrase of a shipping document, in the languages these come in. */
const SIGNS: RegExp[] = [
  /packing\s*list/i, /commercial\s*invoice/i, /pro-?forma\s*invoice/i, /bill\s*of\s*lading/i, /\bB\/L\b/,
  /air\s*-?way\s*-?bill/i, /\bAWB\b/, /\bmanifest\b/i, /loading\s*plan/i, /consignee/i, /\bshipper\b/i,
  /notify\s*party/i, /port\s*of\s*(loading|discharge)/i, /gross\s*(weight|wt)/i, /net(to)?\s*(weight|wt)/i,
  /\bCBM\b|\(M3\)|volume\s*\(?m3/i, /\bHS\s*code/i, /country\s*of\s*origin/i, /\b(FOB|CIF|FCA|EXW|DAP|DDP|CFR)\b/,
  /packing\s*form|wooden\s*box|cartons?\b|pallets?\b/i, /container\s*(no|number)/i, /flight\s*(no|number)/i,
  /delivery\s*address/i, /total\s*(number\s*of\s*)?packages/i,
  // One sign per phrase, as above: a whole bill of lading in Arabic must count
  // for as much as one in English.
  /装箱单|装载/, /舱单|提单/, /发票/, /毛重|净重/, /体积/, /收货人|发货人/, /架机/,
  /Отправитель|Грузоотправитель/i, /Получатель|Грузополучатель/i, /Вес\s*(брутто|нетто)/i, /упаковочн|накладн|инвойс/i,
  /بوليصة\s*(ال)?شحن/, /قائمة\s*(ال)?تعبئة/, /فاتورة\s*تجارية/, /المرسل\s*إليه/, /الشاحن/,
  /الوزن\s*(الإجمالي|القائم|الصافي)/, /ميناء\s*(ال)?(شحن|تفريغ)/, /رقم\s*الحاوية/, /شهادة\s*(ال)?منشأ/, /بيان\s*(ال)?شحن|مانيفست/,
];

/** How many distinct signs of a shipping document the text carries. */
export function shippingSigns(text: string): number {
  return SIGNS.filter((re) => re.test(text)).length;
}

/** Three signs is a shipping document; a news story about a shipment rarely has more than one. */
export const SHIPPING_THRESHOLD = 3;

/** The whole document is read at once; anything longer is not a shipping paper. */
const MAX_CHARS = 40_000;

const PARTY_ROLES = ["shipper", "consignee", "buyer", "seller", "notify party", "carrier", "forwarder", "manufacturer", "signatory", "other"];
const PLACE_ROLES = ["origin", "destination", "delivery address", "port of loading", "port of discharge", "transit", "other"];
const REF_KINDS = ["invoice", "contract", "order", "air waybill", "bill of lading", "container", "flight", "vessel", "voyage", "permit", "other"];

const quoted = (description: string) => ({ type: Type.STRING, description });

const SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    shipments: {
      type: Type.ARRAY,
      description: "One per shipment the document records; usually exactly one. Empty if it is not a shipping document.",
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING, description: "A short name a researcher would use for this shipment, built from its papers and parties, e.g. 'Invoice 1001 shipment, KVAND IS to M2 Technology Development' or 'First flight of the GCS loading plan'. In the language given in the rules." },
          documentType: { type: Type.STRING, description: "What the paper is, e.g. 'commercial invoice and packing list', 'aircraft loading plan', 'air waybill'. In the language given in the rules." },
          quote: quoted("A verbatim line from the document that heads or identifies it, e.g. its title line. Copy exactly."),
          summary: { type: Type.STRING, description: "Two or three sentences: who ships what to whom, from where to where, when, how, under which papers. Only what the document says. In the language given in the rules." },
          dateText: { type: Type.STRING, description: "The document's date as written, or empty." },
          dateIso: { type: Type.STRING, description: "The same date as YYYY-MM-DD, YYYY-MM or YYYY; empty if none." },
          transportMode: { type: Type.STRING, enum: ["air", "sea", "road", "rail", "unknown"] },
          references: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                kind: { type: Type.STRING, enum: REF_KINDS },
                value: { type: Type.STRING, description: "The number or identifier as written." },
                date: { type: Type.STRING, description: "Its date as written, if given." },
              },
              required: ["kind", "value"],
            },
          },
          parties: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                role: { type: Type.STRING, enum: PARTY_ROLES },
                name: { type: Type.STRING, description: "The name exactly as written." },
                type: { type: Type.STRING, enum: ["org", "person", "institution"] },
                address: { type: Type.STRING, description: "As written, or empty." },
                quote: quoted("The verbatim text where the name appears. Copy exactly."),
              },
              required: ["role", "name", "type", "quote"],
            },
          },
          places: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                role: { type: Type.STRING, enum: PLACE_ROLES },
                name: { type: Type.STRING, description: "The city, port, airport or country exactly as written." },
                quote: quoted("The verbatim text where it appears. Copy exactly."),
              },
              required: ["role", "name", "quote"],
            },
          },
          goods: {
            type: Type.ARRAY,
            description: "Every line of goods, in order.",
            items: {
              type: Type.OBJECT,
              properties: {
                description: { type: Type.STRING, description: "As written; keep part numbers and both languages if both are given." },
                quantity: { type: Type.STRING },
                packing: { type: Type.STRING },
                grossKg: { type: Type.STRING },
                value: { type: Type.STRING },
                hsCode: { type: Type.STRING },
                origin: { type: Type.STRING },
                serial: { type: Type.STRING },
              },
              required: ["description"],
            },
          },
          totals: {
            type: Type.OBJECT,
            properties: {
              packages: { type: Type.STRING },
              grossKg: { type: Type.STRING },
              netKg: { type: Type.STRING },
              volumeM3: { type: Type.STRING },
              value: { type: Type.STRING },
              currency: { type: Type.STRING },
            },
          },
          remarks: { type: Type.STRING, description: "Anything else the document notes about handling, loading or terms, in its own words; empty if nothing." },
        },
        required: ["name", "documentType", "quote", "summary", "parties", "places", "goods"],
      },
    },
    links: {
      type: Type.ARRAY,
      description: "Other shipping papers listed under OTHER SHIPPING PAPERS that belong with this one. Empty when none clearly do.",
      items: {
        type: Type.OBJECT,
        properties: {
          shipment: { type: Type.INTEGER, description: "Which shipment of THIS document, counting from 1." },
          other: { type: Type.STRING, description: "The id of the other paper's shipment, exactly as listed, e.g. 'S54-1'." },
          relation: { type: Type.STRING, description: "Short verb phrase from this shipment to the other, e.g. 'is the second flight of the same consignment as', 'ships goods under the same contract as'." },
          reason: { type: Type.STRING, description: "What in the two papers shows it: the shared number, party, goods or wording. One sentence." },
        },
        required: ["shipment", "other", "relation", "reason"],
      },
    },
  },
  required: ["shipments"],
};

function system(lang: string): string {
  return `You read shipping papers for an investigative journalist: commercial invoices,
packing lists, loading plans, air waybills, bills of lading, manifests. Your
reading becomes a record that is cited, so it must hold to the paper.

- Use only what the DOCUMENT says. Never add what you know about these companies,
  places or goods from elsewhere, and never guess what goods are for.
- Names, numbers, part numbers and addresses exactly as written. Do not
  translate or correct them. Where a paper gives a line in two languages, keep
  both.
- Every "quote" is copied character for character from the DOCUMENT, short:
  the cell or line where the name or title appears.
- Write "name", "documentType" and "summary" in ${lang}.
- A party's role is what the paper calls it: the sender is the shipper, the
  recipient the consignee; a buyer named under a contract is the buyer.
- Links: only when the two papers themselves show they belong together — the
  same contract, invoice, waybill or flight number, the same parties with the
  same goods, or titles such as "first flight" and "second flight" of one
  plan. Two shipments of similar goods are not linked on that alone.
- If the DOCUMENT is not a shipping paper after all, return no shipments.`;
}

interface Party { role: string; name: string; type: string; address?: string; quote: string }
interface Place { role: string; name: string; quote: string }
interface Goods { description: string; quantity?: string; packing?: string; grossKg?: string; value?: string; hsCode?: string; origin?: string; serial?: string }
export interface ShipmentRecord {
  name: string;
  documentType: string;
  quote: string;
  summary: string;
  dateText?: string;
  dateIso?: string;
  transportMode?: string;
  references?: { kind: string; value: string; date?: string }[];
  parties: Party[];
  places: Place[];
  goods: Goods[];
  totals?: { packages?: string; grossKg?: string; netKg?: string; volumeM3?: string; value?: string; currency?: string };
  remarks?: string;
  /** The entity this shipment became; filled in when it is written. */
  entityId?: number;
}
interface Link { shipment: number; other: string; relation: string; reason: string }

/** What the source carries for its page, under meta.shipping. */
export interface ShippingMeta {
  shipments: ShipmentRecord[];
  links: { shipment: number; sourceId: number; otherShipment: number; relation: string; reason: string }[];
  readAt: string;
  /** Rows this pass wrote, so a second reading replaces rather than doubles them. */
  written: { mentions: number[]; relations: number[]; events: number[] };
}

/** What a party is to the shipment, as the relation from the party. */
const PARTY_VERB: Record<string, string> = {
  shipper: "shipped",
  consignee: "is consignee of",
  buyer: "bought",
  seller: "sold",
  "notify party": "is notify party of",
  carrier: "carried",
  forwarder: "forwarded",
  manufacturer: "made the goods of",
  signatory: "signed for",
  other: "is named in",
};
/** What a place is to the shipment, as the relation from the shipment. */
const PLACE_VERB: Record<string, string> = {
  origin: "shipped from",
  destination: "shipped to",
  "delivery address": "delivered to",
  "port of loading": "loaded at",
  "port of discharge": "unloaded at",
  transit: "passed through",
  other: "names",
};

const CONTEXT = "Shipping record";

export async function handleShipment(task: Task): Promise<void> {
  const { sourceId } = JSON.parse(task.payload_json) as { sourceId: number };
  const source = db().prepare("SELECT id, title FROM sources WHERE id=?").get(sourceId) as
    | { id: number; title: string }
    | undefined;
  if (!source) {
    finishTask(task.id, task.run_id, { tokensIn: 0, tokensOut: 0 }, "skipped", "Source is gone.");
    return;
  }
  const chunks = db()
    .prepare("SELECT id, source_id, text FROM chunks WHERE source_id=? ORDER BY seq")
    .all(sourceId) as { id: number; source_id: number; text: string }[];
  const text = chunks.map((c) => c.text).join("\n\n");

  // Free: most sources are not shipping papers and cost nothing to rule out.
  if (shippingSigns(`${source.title}\n${text}`) < SHIPPING_THRESHOLD) {
    finishTask(task.id, task.run_id, { tokensIn: 0, tokensOut: 0 }, "skipped", "Not a shipping document.");
    return;
  }
  if (text.length > MAX_CHARS) {
    finishTask(task.id, task.run_id, { tokensIn: 0, tokensOut: 0 }, "skipped", "Too long to be a shipping document.");
    return;
  }

  const others = otherShipments(sourceId);
  const lang = languageName(getConfig().entryLanguage);
  const { data, usage, model } = await generateJson<{ shipments: ShipmentRecord[]; links?: Link[] }>({
    stage: "extract",
    // Few documents, each one read into a record that is cited: the writer reads them.
    claudeModel: strongClaude(),
    system: system(lang),
    schema: SCHEMA,
    parts: [
      `DOCUMENT (title: ${source.title})\n${text}`,
      others.length
        ? `OTHER SHIPPING PAPERS in this library, to link to only when the papers show they belong together:\n${others
            .map((o) => `${o.key}: ${o.line}`)
            .join("\n")}`
        : "OTHER SHIPPING PAPERS: none yet.",
    ],
  });

  const shipments = (data.shipments ?? []).filter((s) => s?.name?.trim() && s.quote?.trim());
  tx(() => {
    unwrite(sourceId);
    if (!shipments.length) {
      patchMeta(sourceId, { shipping: undefined });
      finishTask(task.id, task.run_id, usage, "skipped", "Read as a shipping document, but it records no shipment.");
      return;
    }
    const written = write(sourceId, chunks, shipments, model);
    const byKey = new Map(others.map((o) => [o.key, o]));
    const links: ShippingMeta["links"] = [];
    for (const l of data.links ?? []) {
      const mine = shipments[l.shipment - 1];
      const other = byKey.get(String(l.other).trim());
      if (!mine?.entityId || !other || !l.relation?.trim()) continue;
      const to = root(other.entityId);
      const from = root(mine.entityId);
      if (!to || !from || to === from) continue;
      const id = Number(
        db()
          .prepare(
            `INSERT INTO relations (from_entity, to_entity, type, source_id, mention_id, quote, context)
             VALUES (?, ?, ?, ?, NULL, NULL, ?)`
          )
          .run(from, to, l.relation.trim(), sourceId, `${CONTEXT}: ${l.reason?.trim() ?? ""}`.trim())
          .lastInsertRowid
      );
      written.relations.push(id);
      links.push({ shipment: l.shipment, sourceId: other.sourceId, otherShipment: other.index + 1, relation: l.relation.trim(), reason: l.reason?.trim() ?? "" });
    }
    const meta: ShippingMeta = { shipments, links, readAt: new Date().toISOString(), written };
    patchMeta(sourceId, { shipping: meta });
    finishTask(
      task.id,
      task.run_id,
      usage,
      "done",
      `Read as a shipping document: ${shipments.length} shipment(s)${links.length ? `, linked to ${links.length} other paper(s)` : ""}.`
    );
  });
}

/** Removes what an earlier reading of this source wrote. */
function unwrite(sourceId: number): void {
  const prior = readMeta(sourceId).shipping as ShippingMeta | undefined;
  if (!prior?.written) return;
  const del = (table: string, ids: number[]) => {
    if (ids.length) db().prepare(`DELETE FROM ${table} WHERE source_id=? AND id IN (${ids.map(() => "?").join(",")})`).run(sourceId, ...ids);
  };
  del("relations", prior.written.relations ?? []);
  del("events", prior.written.events ?? []);
  del("mentions", prior.written.mentions ?? []);
}

/** Writes each shipment as an entity joined to its parties and places, in the
 *  passage where its quotes are found. Returns the rows written. */
function write(
  sourceId: number,
  chunks: { id: number; source_id: number; text: string }[],
  shipments: ShipmentRecord[],
  model: string | undefined
): ShippingMeta["written"] {
  const max = (table: string) => (db().prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM ${table}`).get() as { m: number }).m;
  const before = { mentions: max("mentions"), relations: max("relations"), events: max("events") };

  for (const s of shipments) {
    // The passage that carries the shipment's own quote is where it is filed;
    // a party quoted elsewhere is filed in its own passage, unlinked.
    const home = chunks.find((c) => locateQuote(s.quote, c.text)) ?? null;
    if (!home) continue;
    const known = new Set(
      (db().prepare("SELECT surface, quote FROM mentions WHERE chunk_id=?").all(home.id) as { surface: string; quote: string }[]).map(
        (m) => quoteKey(m.surface, m.quote)
      )
    );
    const shipmentName = s.name.trim();
    const when = s.dateText?.trim() ? `, ${s.dateText.trim()}` : "";
    const entities: ExtractedEntity[] = [
      {
        surface: shipmentName,
        type: "event",
        disambiguator: `${s.documentType}${when}`.slice(0, 120),
        claim: s.summary,
        quote: s.quote,
        context: s.documentType,
        attribution: "source",
        claimKind: "fact",
      },
    ];
    const relations: ExtractedRelation[] = [];
    for (const p of s.parties ?? []) {
      if (!p.name?.trim() || !p.quote?.trim()) continue;
      const type: EntityType = p.type === "person" || p.type === "institution" ? p.type : "org";
      entities.push({
        surface: p.name.trim(),
        type,
        claim: `${capital(p.role)} of ${shipmentName}${p.address?.trim() ? `; address given: ${p.address.trim()}` : ""}.`,
        quote: p.quote,
        context: shipmentName,
        attribution: "source",
        claimKind: "fact",
      });
      relations.push({ from: p.name.trim(), to: shipmentName, type: PARTY_VERB[p.role] ?? PARTY_VERB.other, context: CONTEXT });
    }
    for (const pl of s.places ?? []) {
      if (!pl.name?.trim() || !pl.quote?.trim()) continue;
      entities.push({
        surface: pl.name.trim(),
        type: "place",
        claim: `${capital(pl.role)} of ${shipmentName}.`,
        quote: pl.quote,
        context: shipmentName,
        attribution: "source",
        claimKind: "fact",
      });
      relations.push({ from: shipmentName, to: pl.name.trim(), type: PLACE_VERB[pl.role] ?? PLACE_VERB.other, context: CONTEXT });
    }
    // The link a reader of the network wants first: who sent to whom.
    for (const from of (s.parties ?? []).filter((p) => p.role === "shipper" || p.role === "seller")) {
      for (const to of (s.parties ?? []).filter((p) => p.role === "consignee" || p.role === "buyer")) {
        if (from.name?.trim() && to.name?.trim()) {
          relations.push({ from: from.name.trim(), to: to.name.trim(), type: "shipped goods to", context: `${CONTEXT}: ${shipmentName}` });
        }
      }
    }
    const extraction: ChunkExtraction = {
      entities,
      relations,
      events: s.dateIso?.trim() || s.dateText?.trim()
        ? [{ entity: shipmentName, dateText: s.dateText?.trim() || s.dateIso?.trim(), dateIso: s.dateIso?.trim(), precision: precisionOf(s.dateIso), summary: s.summary, context: CONTEXT }]
        : [],
    };
    persist(home, extraction, known, model ?? null);

    const entity = db()
      .prepare(
        `SELECT m.entity_id AS id FROM mentions m
          WHERE m.chunk_id=? AND m.surface=? AND m.id > ? ORDER BY m.id DESC LIMIT 1`
      )
      .get(home.id, shipmentName, before.mentions) as { id: number } | undefined;
    if (entity) s.entityId = entity.id;
  }

  const since = (table: string, after: number) =>
    (db().prepare(`SELECT id FROM ${table} WHERE source_id=? AND id > ?`).all(sourceId, after) as { id: number }[]).map((r) => r.id);
  return { mentions: since("mentions", before.mentions), relations: since("relations", before.relations), events: since("events", before.events) };
}

/** The other shipping papers already read, one line each, for linking. */
function otherShipments(sourceId: number): { key: string; sourceId: number; index: number; entityId: number; line: string }[] {
  const rows = db()
    .prepare("SELECT id, title, meta_json FROM sources WHERE id <> ? AND meta_json LIKE '%\"shipping\"%'")
    .all(sourceId) as { id: number; title: string; meta_json: string }[];
  const out: { key: string; sourceId: number; index: number; entityId: number; line: string }[] = [];
  for (const r of rows) {
    let meta: { shipping?: ShippingMeta };
    try {
      meta = JSON.parse(r.meta_json);
    } catch {
      continue;
    }
    meta.shipping?.shipments?.forEach((s, i) => {
      if (!s.entityId) return;
      const refs = (s.references ?? []).map((x) => `${x.kind} ${x.value}`).join("; ");
      const parties = (s.parties ?? []).map((p) => `${p.role}: ${p.name}`).join("; ");
      const goods = (s.goods ?? []).slice(0, 12).map((g) => g.description).join("; ");
      out.push({
        key: `S${r.id}-${i + 1}`,
        sourceId: r.id,
        index: i,
        entityId: s.entityId,
        line: `"${r.title}" — ${s.documentType}${s.dateText ? `, ${s.dateText}` : ""}. ${refs ? `Papers: ${refs}. ` : ""}${parties ? `Parties: ${parties}. ` : ""}Goods: ${goods}.`,
      });
    });
  }
  return out.slice(0, 60);
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

function precisionOf(iso?: string): string {
  if (!iso) return "unknown";
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "day";
  if (/^\d{4}-\d{2}$/.test(iso)) return "month";
  if (/^\d{4}$/.test(iso)) return "year";
  return "unknown";
}

function capital(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
