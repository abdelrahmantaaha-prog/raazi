/**
 * Folders brought in whole: a zip lands as a folder of its own, nothing read;
 * reading turns each readable file into a source that remembers its folder.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/test-folders.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const SANDBOX = path.join(root, "data", "__folders__");
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(SANDBOX, { recursive: true });
process.env.CORPUS_DATA_DIR = SANDBOX;
// Adding a source wakes the background worker, which would read the queued
// files alongside the test. The test reads them itself, one at a time.
process.env.CORPUS_FOLLOWER = "1";
fs.writeFileSync(path.join(SANDBOX, "config.json"), JSON.stringify({ requestsPerMinute: 0 }));

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) {
    passed++;
    console.log(`  ok    ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
};
const section = (t) => console.log(`\n${t}`);

const { zip } = await import("../lib/zip.ts");
const { unzip, safeZipPath } = await import("../lib/unzip.ts");
const folders = await import("../lib/folders.ts");
const { handleFolderFile } = await import("../lib/pipeline/folder.ts");
const { db } = await import("../lib/db/index.ts");

section("Reading a zip");
check("a path that climbs out is refused", safeZipPath("../../etc/passwd") === null && safeZipPath("/abs") === null && safeZipPath("C:/x") === null);
check("an ordinary path is kept", safeZipPath("a/./b/c.txt") === "a/b/c.txt");
const archive = zip([
  { name: "notes/one.txt", data: "The IAEA board met in June 2008.\n\nElBaradei reported on Iran." },
  { name: "تقارير/تقرير.md", data: "# تقرير\n\nنص التقرير." },
  { name: "web/page.html", data: "<html><body><h1>Treaty</h1><p>Signed in 1919 at Versailles.</p></body></html>" },
  { name: "setup.exe", data: "binary" },
  { name: "../escape.txt", data: "x" },
  { name: "__MACOSX/notes/._one.txt", data: "junk" },
]);
const u = unzip(archive);
check("readable files come out, junk does not", u.files.map((f) => f.path).sort().join() === "notes/one.txt,setup.exe,web/page.html,تقارير/تقرير.md", u.files.map((f) => f.path).join());
check("the escaping path is reported, not dropped silently", u.skipped.some((s) => s.path === "../escape.txt"));
let threw = false;
try {
  unzip(Buffer.from("not a zip at all"));
} catch {
  threw = true;
}
check("something that is not a zip says so", threw);
const win = "C:/Users/MH/AppData/Local/Temp/claude/ziptest/win.zip";
if (fs.existsSync(win)) {
  const w = unzip(fs.readFileSync(win));
  check("a zip made by Windows opens", w.files.some((f) => f.path === "sub/deep.md"), w.files.map((f) => f.path).join());
}

section("Landing a zip as a folder");
const made = folders.folderFromZip("Iran files.zip", archive);
const folder = folders.getFolder(made.folderId);
check("the folder is named after the zip", folder.name === "Iran files");
check("every file is listed", folder.files === 4, String(folder.files));
check("nothing is read on arrival", folder.added === 0 && db().prepare("SELECT COUNT(*) n FROM sources").get().n === 0);
const files = folders.folderFiles(made.folderId);
check("a program is listed as not readable", files.find((f) => f.rel_path === "setup.exe").state === "unsupported");
check("the files are on disk in the folder", fs.existsSync(path.join(folders.FOLDERS_DIR, String(made.folderId), "notes", "one.txt")));
check("the same file twice is not listed twice", folders.addToFolder(made.folderId, "notes/one.txt", Buffer.from("again")) === false);

section("Reading the folder");
const one = files.find((f) => f.rel_path === "notes/one.txt");
folders.setFileState(files.find((f) => f.rel_path === "web/page.html").id, "skipped");
const { runId, queued } = folders.readFolder(made.folderId);
check("read all takes the waiting files and passes over the one left out", queued === 2, String(queued));
const tasks = db().prepare("SELECT * FROM tasks WHERE run_id=? AND kind='folder_file'").all(runId);
for (const t of tasks) await handleFolderFile(t);
const after = folders.folderFiles(made.folderId);
const read = after.filter((f) => f.state === "added");
check("each becomes a source", read.length === 2, after.map((f) => `${f.rel_path}:${f.state}:${f.error ?? ""}`).join(" | "));
const src = db().prepare("SELECT * FROM sources WHERE id=?").get(after.find((f) => f.id === one.id).source_id);
check("the source remembers its folder", src?.folder_id === made.folderId);
check("and is titled after the file", src?.title === "one");
check("the waiting copy is gone once read", !fs.existsSync(path.join(folders.FOLDERS_DIR, String(made.folderId), "notes", "one.txt")));
check("its reading joins the folder's run", db().prepare("SELECT COUNT(*) n FROM tasks WHERE run_id=? AND kind='extract'").get(runId).n > 0);
check("an Arabic file name survives", read.some((f) => f.rel_path === "تقارير/تقرير.md"));

folders.setFileState(after.find((f) => f.rel_path === "web/page.html").id, "waiting");
const html = folders.readFolder(made.folderId);
for (const t of db().prepare("SELECT * FROM tasks WHERE run_id=? AND kind='folder_file'").all(html.runId)) await handleFolderFile(t);
const page = folders.folderFiles(made.folderId).find((f) => f.rel_path === "web/page.html");
const pageChunks = db().prepare("SELECT group_concat(text, ' ') t FROM chunks WHERE source_id=?").get(page.source_id)?.t ?? "";
check("a web page is read as its text, not its markup", page.state === "added" && pageChunks.includes("Versailles") && !pageChunks.includes("<p>"), pageChunks.slice(0, 120));

section("Removing the folder");
folders.removeFolder(made.folderId);
check("the folder is gone", !folders.getFolder(made.folderId));
const left = db().prepare("SELECT id, title, folder_id FROM sources").all();
check("its sources stay, without the folder", left.length === 3 && left.every((s) => s.folder_id === null), JSON.stringify(left));
check("its files are gone from disk", !fs.existsSync(path.join(folders.FOLDERS_DIR, String(made.folderId))));

db().close?.();
fs.rmSync(SANDBOX, { recursive: true, force: true });
console.log(`\n${failed === 0 ? "All passed" : "FAILURES PRESENT"}: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
