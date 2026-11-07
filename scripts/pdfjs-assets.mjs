// Puts pdf.js where the browser can load it: public/pdfjs/.
//
// The reader's page view draws PDFs in the browser with pdf.js. It is loaded
// from public/ as plain files rather than bundled, because pdf.js starts its
// worker from a URL of its own and expects cmaps/ and standard_fonts/ beside
// it; a bundler that renames and splits files breaks all three. Copied from
// node_modules on every build and dev start, so the browser's pdf.js is always
// the installed version, and never committed (see .gitignore).
//
// Run: node scripts/pdfjs-assets.mjs   (prebuild and predev do it for you)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const from = path.join(root, "node_modules", "pdfjs-dist");
const to = path.join(root, "public", "pdfjs");

const files = ["build/pdf.min.mjs", "build/pdf.worker.min.mjs"];
const dirs = ["cmaps", "standard_fonts"];

fs.rmSync(to, { recursive: true, force: true });
fs.mkdirSync(to, { recursive: true });
for (const f of files) fs.copyFileSync(path.join(from, f), path.join(to, path.basename(f)));
for (const d of dirs) fs.cpSync(path.join(from, d), path.join(to, d), { recursive: true });

const version = JSON.parse(fs.readFileSync(path.join(from, "package.json"), "utf8")).version;
fs.writeFileSync(path.join(to, "VERSION"), `${version}\n`);
