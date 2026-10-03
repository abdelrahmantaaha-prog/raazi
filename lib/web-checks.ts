import { db } from "./db";

/** An entry, or its connections, as checked against the open web. See lib/pipeline/webcheck.ts. */

export type WebVerdict = "confirmed" | "partly" | "disputed" | "not_found";
export type WebScope = "entry" | "connections";

export interface WebSource {
  url: string;
  title?: string;
  says?: string;
}

export interface WebFinding {
  /** The claim as checked; for a connection, the relation in words. */
  claim: string;
  /** The connection's id, so the page can hang the verdict on it. */
  relationId?: number;
  verdict: WebVerdict;
  note?: string;
  sources: WebSource[];
  /** Sources the answer named that no search returned — dropped, counted. */
  unread?: number;
}

export interface WebReport {
  scope: WebScope;
  findings: WebFinding[];
  overview?: string;
  checkedAt: string;
}

/** The latest check of each kind for one subject. */
export function webChecksFor(entityId: number): { entry?: WebReport; connections?: WebReport } {
  const rows = db()
    .prepare("SELECT scope, report_json FROM web_checks WHERE entity_id=?")
    .all(entityId) as { scope: WebScope; report_json: string }[];
  const out: { entry?: WebReport; connections?: WebReport } = {};
  for (const r of rows) {
    try {
      out[r.scope] = JSON.parse(r.report_json) as WebReport;
    } catch {
      /* a report that will not parse is simply not shown */
    }
  }
  return out;
}
