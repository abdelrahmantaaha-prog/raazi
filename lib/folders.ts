import fs from "node:fs";
import path from "node:path";
import { DATA_DIR, db } from "./db";
import { createRun, enqueue } from "./queue";
import { safeZipPath, unzip } from "./unzip";
import { IMAGE_EXTENSIONS, OFFICE_EXTENSIONS } from "./ingest/office";

/**
 * Folders: a zip or a folder of documents, brought in whole.
 *
 * A folder of two hundred files is not two hundred decisions made at the
 * moment of dropping it. So the files land first — copied into Corpus under a
 * folder of their own, listed, nothing read — and reading is a second step you
 * take when you are ready: all of them, or the ones you pick. Reading is where
 * the cost is; landing is free.
 *
 * A file Corpus cannot read (an old .doc or .xls, a program, a picture in a
 * format other than PNG or JPG) is still listed, marked as such, so the folder shows what was in it rather than
 * quietly shrinking. Once a file is read it becomes a source like any other,
 * remembers its folder, and its waiting copy is removed — the source keeps its
 * own.
 */

export const FOLDERS_DIR = path.join(DATA_DIR, "folders");

export type FolderFileState = "waiting" | "queued" | "added" | "skipped" | "unsupported" | "failed";

/** What Corpus can make a source from, by extension. Null: listed, not readable. */
export function readableAs(file: string): "pdf" | "epub" | "media" | "text" | "html" | "office" | "image" | null {
  const ext = path.extname(file).toLowerCase();
  if (OFFICE_EXTENSIONS.includes(ext)) return "office";
  if (IMAGE_EXTENSIONS.includes(ext)) return "image";
  if (ext === ".pdf") return "pdf";
  if (ext === ".epub") return "epub";
  if ([".mp3", ".m4a", ".wav", ".ogg", ".flac", ".aac", ".mp4", ".webm", ".mov"].includes(ext)) return "media";
  if ([".txt", ".md", ".markdown", ".text", ".srt", ".vtt", ".csv", ".json", ".xml"].includes(ext)) return "text";
  if ([".html", ".htm", ".xhtml"].includes(ext)) return "html";
  return null;
}

export interface FolderRow {
  id: number;
  name: string;
  origin: "zip" | "folder";
  created_at: string;
  files: number;
  waiting: number;
  added: number;
  unsupported: number;
  failed: number;
}

export interface FolderFile {
  id: number;
  folder_id: number;
  rel_path: string;
  size: number;
  state: FolderFileState;
  source_id: number | null;
  error: string | null;
}

const COUNTS = `
  (SELECT COUNT(*) FROM folder_files ff WHERE ff.folder_id = f.id) AS files,
  (SELECT COUNT(*) FROM folder_files ff WHERE ff.folder_id = f.id AND ff.state IN ('waiting','queued')) AS waiting,
  (SELECT COUNT(*) FROM folder_files ff WHERE ff.folder_id = f.id AND ff.state = 'added') AS added,
  (SELECT COUNT(*) FROM folder_files ff WHERE ff.folder_id = f.id AND ff.state = 'unsupported') AS unsupported,
  (SELECT COUNT(*) FROM folder_files ff WHERE ff.folder_id = f.id AND ff.state = 'failed') AS failed`;

export function listFolders(): FolderRow[] {
  return db().prepare(`SELECT f.*, ${COUNTS} FROM folders f ORDER BY f.created_at DESC, f.id DESC`).all() as FolderRow[];
}

export function getFolder(id: number): FolderRow | undefined {
  return db().prepare(`SELECT f.*, ${COUNTS} FROM folders f WHERE f.id = ?`).get(id) as FolderRow | undefined;
}

export function folderFiles(id: number): FolderFile[] {
  return db()
    .prepare("SELECT * FROM folder_files WHERE folder_id = ? ORDER BY rel_path COLLATE NOCASE")
    .all(id) as FolderFile[];
}

export function createFolder(name: string, origin: "zip" | "folder"): number {
  const clean = name.trim().replace(/\.zip$/i, "").slice(0, 200) || "Untitled folder";
  const id = Number(db().prepare("INSERT INTO folders (name, origin) VALUES (?, ?)").run(clean, origin).lastInsertRowid);
  fs.mkdirSync(path.join(FOLDERS_DIR, String(id)), { recursive: true });
  return id;
}

/** Lands one file in a folder. Returns false for a path that is not safe, or a file already there. */
export function addToFolder(folderId: number, relPath: string, data: Buffer): boolean {
  const rel = safeZipPath(relPath);
  if (!rel) return false;
  const dest = path.join(FOLDERS_DIR, String(folderId), ...rel.split("/"));
  // Belt and braces: the joined path must still be inside the folder.
  if (!dest.startsWith(path.join(FOLDERS_DIR, String(folderId)) + path.sep)) return false;
  const state: FolderFileState = readableAs(rel) ? "waiting" : "unsupported";
  const inserted = db()
    .prepare("INSERT OR IGNORE INTO folder_files (folder_id, rel_path, size, state) VALUES (?,?,?,?)")
    .run(folderId, rel, data.length, state).changes;
  if (!inserted) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, data);
  return true;
}

/** A zip, unpacked into a new folder named after it. */
export function folderFromZip(name: string, zipBytes: Buffer): { folderId: number; files: number; skipped: { path: string; reason: string }[] } {
  const { files, skipped } = unzip(zipBytes);
  const folderId = createFolder(name, "zip");
  let n = 0;
  for (const f of files) {
    if (addToFolder(folderId, f.path, f.data)) n++;
    else skipped.push({ path: f.path, reason: "it was already in the folder" });
  }
  return { folderId, files: n, skipped };
}

/**
 * Queues the folder's waiting files to be read — all of them, or the ones
 * named — as one run, so its progress shows as one piece of work. The caller
 * wakes the worker.
 */
export function readFolder(folderId: number, fileIds?: number[]): { runId: number | null; queued: number } {
  const folder = getFolder(folderId);
  if (!folder) return { runId: null, queued: 0 };
  const rows = (
    fileIds?.length
      ? db()
          .prepare(
            `SELECT id FROM folder_files WHERE folder_id = ? AND state IN ('waiting','failed')
               AND id IN (${fileIds.map(() => "?").join(",")})`
          )
          .all(folderId, ...fileIds)
      : db().prepare("SELECT id FROM folder_files WHERE folder_id = ? AND state = 'waiting'").all(folderId)
  ) as { id: number }[];
  if (!rows.length) return { runId: null, queued: 0 };
  const runId = createRun({ kind: "folder", label: `Folder: ${folder.name}` });
  db().transaction(() => {
    enqueue(runId, rows.map((r) => ({ kind: "folder_file" as const, payload: { fileId: r.id } })));
    const mark = db().prepare("UPDATE folder_files SET state='queued', error=NULL WHERE id=?");
    for (const r of rows) mark.run(r.id);
  })();
  return { runId, queued: rows.length };
}

export function setFileState(fileId: number, state: "waiting" | "skipped") {
  db()
    .prepare("UPDATE folder_files SET state=? WHERE id=? AND state IN ('waiting','skipped','failed')")
    .run(state, fileId);
}

export function renameFolder(id: number, name: string) {
  if (name.trim()) db().prepare("UPDATE folders SET name=? WHERE id=?").run(name.trim().slice(0, 200), id);
}

/**
 * Removes a folder and the files still waiting in it. Sources already read
 * from it stay in the library; they only forget which folder they came from.
 */
export function removeFolder(id: number) {
  db().transaction(() => {
    db().prepare("UPDATE sources SET folder_id = NULL WHERE folder_id = ?").run(id);
    db().prepare("DELETE FROM folder_files WHERE folder_id = ?").run(id);
    db().prepare("DELETE FROM folders WHERE id = ?").run(id);
  })();
  fs.rmSync(path.join(FOLDERS_DIR, String(id)), { recursive: true, force: true });
}
