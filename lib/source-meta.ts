import { db } from "./db";

/**
 * A source's loose metadata, the JSON column that covers, pictures, photo
 * flags and shipping records share. Read whole and written back whole, so one
 * writer never drops another's keys.
 */
export function readMeta(sourceId: number): Record<string, unknown> {
  const row = db().prepare("SELECT meta_json FROM sources WHERE id=?").get(sourceId) as
    | { meta_json: string | null }
    | undefined;
  try {
    return JSON.parse(row?.meta_json || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Sets the given keys; a key set to undefined is removed. */
export function patchMeta(sourceId: number, patch: Record<string, unknown>): void {
  const meta = { ...readMeta(sourceId), ...patch };
  for (const k of Object.keys(patch)) if (patch[k] === undefined) delete meta[k];
  db().prepare("UPDATE sources SET meta_json=? WHERE id=?").run(JSON.stringify(meta), sourceId);
}
