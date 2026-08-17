import { db, tx } from "./db";

/**
 * Tags organise the pedia without partitioning it. An entity is never split by
 * topic — one person stays one person — it simply carries every tag that
 * applies, and you filter by them.
 *
 * An entity's tags come from two places:
 *   derived  — every tag on a source that mentions it. Computed live, so adding
 *              a source to a topic re-tags everyone it names, with no rebuild.
 *   override — a tag you added by hand, or a derived one you told it to hide.
 *
 * effective = (derived ∪ added) − hidden
 */

export interface Tag {
  id: number;
  name: string;
  description: string | null;
  color: string | null;
  created_at: string;
}

export interface TagWithCounts extends Tag {
  sources: number;
  entities: number;
}

/** Muted, readable at small sizes, and distinguishable from each other. */
const PALETTE = [
  "#7a4b2a", "#2f6b5b", "#4a5a8a", "#8a4a5e",
  "#5f6b2a", "#7a5a2a", "#3f5f7a", "#6b3a6b",
];

export function listTags(): TagWithCounts[] {
  return db()
    .prepare(
      `SELECT t.*,
              (SELECT COUNT(*) FROM source_tags st WHERE st.tag_id = t.id) AS sources,
              (SELECT COUNT(*) FROM (
                 SELECT DISTINCT m.entity_id
                   FROM live_mentions m JOIN source_tags st ON st.source_id = m.source_id
                  WHERE st.tag_id = t.id
                  UNION
                 SELECT et.entity_id FROM entity_tags et
                  WHERE et.tag_id = t.id AND et.state = 'added'
               )) AS entities
         FROM tags t
        ORDER BY t.name`
    )
    .all() as TagWithCounts[];
}

export function getTag(id: number): Tag | undefined {
  return db().prepare("SELECT * FROM tags WHERE id=?").get(id) as Tag | undefined;
}

/** Case-insensitive by name, so "Egypt" typed twice is one tag. */
export function ensureTag(name: string, description?: string): number {
  const clean = name.trim().replace(/\s+/g, " ");
  if (!clean) throw new Error("A tag needs a name.");

  const existing = db()
    .prepare("SELECT id FROM tags WHERE name = ? COLLATE NOCASE")
    .get(clean) as { id: number } | undefined;
  if (existing) return existing.id;

  const count = (db().prepare("SELECT COUNT(*) AS n FROM tags").get() as { n: number }).n;
  return Number(
    db()
      .prepare("INSERT INTO tags (name, description, color) VALUES (?, ?, ?)")
      .run(clean, description?.trim() || null, PALETTE[count % PALETTE.length]).lastInsertRowid
  );
}

export function renameTag(id: number, name: string, description?: string) {
  db()
    .prepare("UPDATE tags SET name=COALESCE(NULLIF(?,''), name), description=? WHERE id=?")
    .run(name.trim(), description?.trim() || null, id);
}

/** Deleting a tag never deletes anything it was attached to. */
export function deleteTag(id: number) {
  db().prepare("DELETE FROM tags WHERE id=?").run(id);
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export function tagsForSource(sourceId: number): Tag[] {
  return db()
    .prepare(
      `SELECT t.* FROM tags t JOIN source_tags st ON st.tag_id = t.id
        WHERE st.source_id = ? ORDER BY t.name`
    )
    .all(sourceId) as Tag[];
}

export function setSourceTags(sourceId: number, tagIds: number[], assigned: "user" | "ai" = "user") {
  tx(() => {
    db().prepare("DELETE FROM source_tags WHERE source_id=?").run(sourceId);
    const stmt = db().prepare(
      "INSERT OR IGNORE INTO source_tags (source_id, tag_id, assigned) VALUES (?, ?, ?)"
    );
    for (const id of tagIds) stmt.run(sourceId, id, assigned);
    db().prepare("UPDATE sources SET tagged_at=datetime('now') WHERE id=?").run(sourceId);
  });
}

export function addSourceTag(sourceId: number, tagId: number, assigned: "user" | "ai" = "user") {
  db()
    .prepare("INSERT OR IGNORE INTO source_tags (source_id, tag_id, assigned) VALUES (?, ?, ?)")
    .run(sourceId, tagId, assigned);
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export interface EffectiveTag extends Tag {
  /** derived: comes from a source. manual: you added it here. */
  origin: "derived" | "manual";
}

export function tagsForEntity(entityId: number): EffectiveTag[] {
  return db()
    .prepare(
      `SELECT t.*, MIN(origin) AS origin FROM (
         SELECT st.tag_id AS tag_id, 'derived' AS origin
           FROM live_mentions m JOIN source_tags st ON st.source_id = m.source_id
          WHERE m.entity_id = ?
         UNION ALL
         SELECT et.tag_id, 'manual'
           FROM entity_tags et
          WHERE et.entity_id = ? AND et.state = 'added'
       ) AS src
       JOIN tags t ON t.id = src.tag_id
      WHERE t.id NOT IN (
        SELECT tag_id FROM entity_tags WHERE entity_id = ? AND state = 'hidden'
      )
      GROUP BY t.id
      ORDER BY t.name`
    )
    .all(entityId, entityId, entityId) as EffectiveTag[];
}

/** Adding a tag already derived is a no-op; hiding one you added removes it. */
export function setEntityTag(entityId: number, tagId: number, on: boolean) {
  const derived = db()
    .prepare(
      `SELECT 1 AS x FROM live_mentions m JOIN source_tags st ON st.source_id = m.source_id
        WHERE m.entity_id = ? AND st.tag_id = ? LIMIT 1`
    )
    .get(entityId, tagId) as { x: number } | undefined;

  if (on) {
    if (derived) {
      // It comes from the evidence anyway — just clear any suppression.
      db().prepare("DELETE FROM entity_tags WHERE entity_id=? AND tag_id=?").run(entityId, tagId);
    } else {
      db()
        .prepare("INSERT OR REPLACE INTO entity_tags (entity_id, tag_id, state) VALUES (?,?,'added')")
        .run(entityId, tagId);
    }
    return;
  }

  if (derived) {
    // Can't un-derive it, so record that you don't want to see it here.
    db()
      .prepare("INSERT OR REPLACE INTO entity_tags (entity_id, tag_id, state) VALUES (?,?,'hidden')")
      .run(entityId, tagId);
  } else {
    db().prepare("DELETE FROM entity_tags WHERE entity_id=? AND tag_id=?").run(entityId, tagId);
  }
}

/**
 * SQL fragment restricting a query to one tag, for reuse across the pedia,
 * search and the quote bank. `alias` is the entities table alias in the query.
 */
export function tagFilterSql(alias = "e"): string {
  return `(
    EXISTS (
      SELECT 1 FROM live_mentions m JOIN source_tags st ON st.source_id = m.source_id
       WHERE m.entity_id = ${alias}.id AND st.tag_id = @tagId
    )
    OR EXISTS (
      SELECT 1 FROM entity_tags et
       WHERE et.entity_id = ${alias}.id AND et.tag_id = @tagId AND et.state = 'added'
    )
  ) AND NOT EXISTS (
    SELECT 1 FROM entity_tags et2
     WHERE et2.entity_id = ${alias}.id AND et2.tag_id = @tagId AND et2.state = 'hidden'
  )`;
}
