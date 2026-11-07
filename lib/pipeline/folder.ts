import fs from "node:fs";
import path from "node:path";
import { db } from "../db";
import { finishTask } from "../queue";
import { addFile } from "../ingest";
import { htmlToMarkdown } from "../ingest/web";
import { FOLDERS_DIR, readableAs, type FolderFile } from "../folders";
import type { Task } from "../types";

/** The worker's step: one file of a folder becomes a source. */
export async function handleFolderFile(task: Task): Promise<void> {
  const { fileId } = JSON.parse(task.payload_json) as { fileId: number };
  const file = db().prepare("SELECT * FROM folder_files WHERE id = ?").get(fileId) as FolderFile | undefined;
  if (!file || file.state === "added") {
    finishTask(task.id, task.run_id, { tokensIn: 0, tokensOut: 0 }, "skipped", "Already read, or no longer in the folder.");
    return;
  }
  const where = path.join(FOLDERS_DIR, String(file.folder_id), ...file.rel_path.split("/"));
  const as = readableAs(file.rel_path);
  try {
    if (!as) throw new Error("Raazi cannot read this kind of file.");
    let bytes = await fs.promises.readFile(where);
    let filename = path.basename(file.rel_path);
    const title = path.basename(filename, path.extname(filename));
    if (as === "html") {
      bytes = Buffer.from(htmlToMarkdown(bytes.toString("utf8")), "utf8");
      filename = `${title}.md`;
    }
    // Joins this run, so the folder's progress is one line on the Activity page.
    const added = await addFile({ filename, bytes, title, runId: task.run_id });
    db().prepare("UPDATE sources SET folder_id = ? WHERE id = ?").run(file.folder_id, added.sourceId);
    db().prepare("UPDATE folder_files SET state='added', source_id=?, error=NULL WHERE id=?").run(added.sourceId, fileId);
    fs.rmSync(where, { force: true });
    finishTask(task.id, task.run_id, { tokensIn: 0, tokensOut: 0 }, "done", `${file.rel_path}: ${added.note}`);
  } catch (err) {
    const message = String((err as Error)?.message ?? err).slice(0, 400);
    db().prepare("UPDATE folder_files SET state='failed', error=? WHERE id=?").run(message, fileId);
    finishTask(task.id, task.run_id, { tokensIn: 0, tokensOut: 0 }, "skipped", `${file.rel_path}: ${message}`);
  }
}
