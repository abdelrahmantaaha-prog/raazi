import { db } from "../db";

/** One lead in the Research inbox. See research_finds in lib/db/migrate.ts. */
export interface ResearchFind {
  id: number;
  entity_id: number;
  entity_name: string;
  entity_type: string;
  scope: string;
  url: string;
  title: string | null;
  why: string;
  kind: "source" | "record" | "post" | "shipment";
  state: "new" | "kept" | "dismissed";
  source_id: number | null;
  created_at: string;
}

export function listFinds(state: "new" | "kept" | "dismissed" = "new", limit = 300): ResearchFind[] {
  return db()
    .prepare(
      `SELECT f.*, e.canonical_name AS entity_name, e.type AS entity_type
         FROM research_finds f JOIN entities e ON e.id = f.entity_id
        WHERE f.state = ?
        ORDER BY f.created_at DESC, f.id
        LIMIT ?`
    )
    .all(state, limit) as ResearchFind[];
}

export function findCounts(): Record<string, number> {
  const rows = db().prepare("SELECT state, COUNT(*) AS n FROM research_finds GROUP BY state").all() as {
    state: string;
    n: number;
  }[];
  return Object.fromEntries(rows.map((r) => [r.state, r.n]));
}

export function getFind(id: number): ResearchFind | undefined {
  return db()
    .prepare(
      `SELECT f.*, e.canonical_name AS entity_name, e.type AS entity_type
         FROM research_finds f JOIN entities e ON e.id = f.entity_id WHERE f.id = ?`
    )
    .get(id) as ResearchFind | undefined;
}

export function setFindState(id: number, state: ResearchFind["state"], sourceId: number | null = null) {
  db().prepare("UPDATE research_finds SET state=?, source_id=COALESCE(?, source_id) WHERE id=?").run(state, sourceId, id);
}
