import { inflateRawSync } from "node:zlib";

/**
 * A ZIP reader, the other half of lib/zip.ts, for the same reason: a folder of
 * documents arrives as a .zip, and reading one is a page of code rather than a
 * dependency.
 *
 * Reads the central directory, then each entry's data, stored or deflated —
 * which is what every archiver writes by default. Refused, with a reason:
 * ZIP64 (an archive or entry over 4 GB, or over 65,535 entries), encrypted
 * entries, and other compression methods.
 *
 * And guarded, because an archive is a file from somewhere else: a name that
 * climbs out of its folder ("../../x") or is absolute is refused, and the
 * total unpacked size is capped, so a small archive that inflates to a
 * terabyte (a "zip bomb") stops at the cap instead of filling the disk.
 */

export interface UnzippedFile {
  /** Path inside the archive: forward slashes, no leading slash, no "..". */
  path: string;
  data: Buffer;
}

export interface UnzipResult {
  files: UnzippedFile[];
  /** Entries left out, and why — shown to you, never silently dropped. */
  skipped: { path: string; reason: string }[];
}

/** Junk every archiver on a Mac or Windows machine adds. */
const JUNK = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$|desktop\.ini$)/i;

export function safeZipPath(raw: string): string | null {
  const p = raw.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!p || p.startsWith("/") || /^[a-z]:/i.test(p)) return null;
  const parts = p.split("/").filter((s) => s && s !== ".");
  if (parts.some((s) => s === "..")) return null;
  return parts.join("/");
}

export function unzip(buf: Buffer, opts: { maxTotalBytes?: number; maxFiles?: number } = {}): UnzipResult {
  const maxTotal = opts.maxTotalBytes ?? 2 * 1024 * 1024 * 1024;
  const maxFiles = opts.maxFiles ?? 5000;

  // The end-of-central-directory record: 22 bytes plus a comment of up to 64 KB.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("That is not a zip file, or it is damaged.");

  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    throw new Error("This zip is too large for Raazi to open (over 4 GB or 65,535 files). Unzip it and add the folder instead.");
  }

  const files: UnzippedFile[] = [];
  const skipped: UnzipResult["skipped"] = [];
  let total = 0;
  let p = cdOffset;

  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) {
      throw new Error("This zip's table of contents is damaged.");
    }
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    // Bit 11 says the name is UTF-8. Older archivers wrote the DOS code page;
    // Latin-1 is the closest Node reads, and keeps an Arabic name from Windows
    // legible far more often than not.
    const rawName = buf.subarray(p + 46, p + 46 + nameLen).toString(flags & 0x800 ? "utf8" : "latin1");
    p += 46 + nameLen + extraLen + commentLen;

    if (rawName.endsWith("/")) continue; // a directory
    if (JUNK.test(rawName)) continue;
    const name = safeZipPath(rawName);
    if (!name) {
      skipped.push({ path: rawName, reason: "its name points outside the folder" });
      continue;
    }
    if (flags & 0x1) {
      skipped.push({ path: name, reason: "it is password-protected" });
      continue;
    }
    if (size === 0xffffffff || compressed === 0xffffffff) {
      skipped.push({ path: name, reason: "it is over 4 GB" });
      continue;
    }
    if (method !== 0 && method !== 8) {
      skipped.push({ path: name, reason: "it is compressed in a way Raazi cannot unpack" });
      continue;
    }
    if (files.length >= maxFiles) {
      skipped.push({ path: name, reason: `the folder already has ${maxFiles} files` });
      continue;
    }
    if (total + size > maxTotal) {
      skipped.push({ path: name, reason: "the zip unpacks to more than Raazi will take at once" });
      continue;
    }

    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) {
      skipped.push({ path: name, reason: "its data is damaged" });
      continue;
    }
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + compressed);
    let data: Buffer;
    try {
      // The size in the directory is a promise the data may not keep; cap the
      // inflate at it so a lying entry cannot balloon past what was counted.
      data = method === 0 ? Buffer.from(raw) : inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) });
    } catch {
      skipped.push({ path: name, reason: "its data is damaged" });
      continue;
    }
    total += data.length;
    files.push({ path: name, data });
  }

  return { files, skipped };
}
