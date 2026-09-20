import zlib from "node:zlib";

/**
 * Reads a ZIP the way any unpacker would: from the central directory.
 *
 * The same walk `test-docx.mjs` does, pulled out so a second suite can read a
 * generated .docx without a second copy of it. Deliberately not using a
 * library: the point of these tests is that the file we write is one a real
 * unpacker can open, and a reader that shared code with the writer would not
 * prove that.
 */
export function unzip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error("no end-of-central-directory record");
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);

  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error("bad central header");
    const method = buf.readUInt16LE(at + 10);
    const compressed = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const offset = buf.readUInt32LE(at + 42);
    const name = buf.slice(at + 46, at + 46 + nameLen).toString("utf8");

    const localNameLen = buf.readUInt16LE(offset + 26);
    const localExtraLen = buf.readUInt16LE(offset + 28);
    const start = offset + 30 + localNameLen + localExtraLen;
    const body = buf.slice(start, start + compressed);
    files.set(name, method === 0 ? body : zlib.inflateRawSync(body));
    at += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

/** One part of a generated document, as text. */
export function unzipText(buf, name) {
  const part = unzip(buf).get(name);
  if (!part) throw new Error(`no ${name} in the file`);
  return part.toString("utf8");
}
