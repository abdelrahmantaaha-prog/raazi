/**
 * The v2 Sec-MS-GEC token: what Edge's Read Aloud now sends to prove it is Edge.
 *
 * Until November 2026 the token was a plain SHA-256 of the current five-minute
 * window and a fixed client token. The service then began refusing that on the
 * speech connection (a bare 403 on the WebSocket handshake) while still
 * accepting it for the voice list — so the voices menu filled and nothing
 * spoke. Edge now sends "<16 hex>-<64 hex>": a CS64 checksum and a SHA-256
 * whose first block is a secret Edge never discloses, carried here as the
 * hash state after that block.
 *
 * Ported from the `edge-tts` project (src/edge_tts/drm.py,
 * generate_sec_ms_gec_v2), which is where to look when this breaks next.
 * Written in BigInt to keep the Python's arithmetic exactly; it runs once per
 * five-minute window, so speed does not matter.
 */

const M = 0xffffffffn;

const SHA256_INITIAL = [
  0x6a09e667n, 0xbb67ae85n, 0x3c6ef372n, 0xa54ff53an, 0x510e527fn, 0x9b05688cn, 0x1f83d9abn, 0x5be0cd19n,
];
/** The state partway through the secret first block. */
const SHA256_STATE = [
  0xfd9fbea2n, 0x91243ce7n, 0xbe499094n, 0xcd2e1e0an, 0x6c006f49n, 0x04bd35abn, 0xfeb0a7e4n, 0x03effbd2n,
];
/** That block's message schedule for words 16–29, less the parts the token adds. */
const SHA256_SCHEDULE = [
  0xeb24bf9en, 0x1558691fn, 0xa0c09ee2n, 0x0cfa32ban, 0xa622ee8cn, 0xd1dd9491n, 0xc0dd25a0n,
  0xf9e70ab6n, 0xf0c31573n, 0x7058ce4en, 0x7188e606n, 0x00e5ab33n, 0xd258b060n, 0x72766564n,
];
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
].map(BigInt);
const SHA256_ADJUSTMENT = 0xc9dc06a7n;
/** The round constants for the secret block, where round 14's is adjusted. */
const K_BLOCK = [...K.slice(0, 14), SHA256_ADJUSTMENT, ...K.slice(15)];
const SIGMA0_ADJUSTMENT = 0x059c0b80n;
const SIGMA1_ADJUSTMENT = 0x000b92c0n;

const CS64_COEFFICIENTS: [bigint, bigint][] = [
  [0xe82e91b1n, 0xb32700d0n],
  [0x44de24c6n, 0x88dff51dn],
  [0x3beb65bcn, 0x29514038n],
  [0xc89c5933n, 0xb328cbdfn],
  [0x8d1ec211n, 0xd405b4d5n],
  [0x314ef5d5n, 0x26e55f3cn],
  [0xe92491b1n, 0x607801c6n],
  [0xf0a5b9d5n, 0x82b2c1fbn],
  [0x06064cf3n, 0xfa51a3dan],
  [0xda79fa60n, 0x207cc464n],
  [0xbed20560n, 0x3c3c74f3n],
  [0x89f9c9f8n, 0xd2d14b61n],
  [0x35fa38c6n, 0xbb04a2c1n],
  [0xcb49e3c6n, 0xc5626167n],
];
const CS64_FACTOR = 0x82893933n;
const CS64_ADJUSTMENT0 = 0xf2f90b1an;
const CS64_ADJUSTMENT1 = 0x0b1a0000n;

const rotr = (x: bigint, n: bigint) => ((x >> n) | (x << (32n - n))) & M;
const rol16 = (x: bigint) => {
  x &= M;
  return ((x << 16n) | (x >> 16n)) & M;
};
const sigma0 = (x: bigint) => rotr(x, 7n) ^ rotr(x, 18n) ^ (x >> 3n);
const sigma1 = (x: bigint) => rotr(x, 17n) ^ rotr(x, 19n) ^ (x >> 10n);

/** SHA-256's rounds from `first` to 63 over `w`, starting from `state`. */
function rounds(state: bigint[], w: bigint[], first: number, k: bigint[]): bigint[] {
  let [a, b, c, d, e, f, g, h] = state;
  for (let i = first; i < 64; i++) {
    const s1 = rotr(e, 6n) ^ rotr(e, 11n) ^ rotr(e, 25n);
    const ch = g ^ (e & (f ^ g));
    const t1 = (h + s1 + ch + k[i] + w[i]) & M;
    const s0 = rotr(a, 2n) ^ rotr(a, 13n) ^ rotr(a, 22n);
    const maj = (a & b) | (c & (a | b));
    const t2 = (s0 + maj) & M;
    [h, g, f, e, d, c, b, a] = [g, f, e, (d + t1) & M, c, b, a, (t1 + t2) & M];
  }
  return [a, b, c, d, e, f, g, h];
}

function expand(w: bigint[], from: number): void {
  for (let i = from; i < 64; i++) w.push((sigma1(w[i - 2]) + w[i - 7] + sigma0(w[i - 15]) + w[i - 16]) & M);
}

const be = (bytes: Uint8Array) => bytes.reduce((n, b) => (n << 8n) | BigInt(b), 0n);

/** The state after the secret block, which ends with the token's first seven bytes. */
function initialState(head: Uint8Array): bigint[] {
  const w: bigint[] = [...Array(14).fill(0n), be(head.subarray(0, 3)), be(head.subarray(3, 7))];
  for (let i = 16; i < 30; i++) {
    let v = SHA256_SCHEDULE[i - 16];
    if (i - 2 >= 14) v += i === 16 ? sigma1(w[i - 2]) ^ SIGMA1_ADJUSTMENT : sigma1(w[i - 2]);
    if (i - 7 >= 14) v += w[i - 7];
    if (i - 15 >= 14) v += i === 29 ? sigma0(w[i - 15]) ^ SIGMA0_ADJUSTMENT : sigma0(w[i - 15]);
    w.push(v & M);
  }
  w.push((sigma1(w[28]) + w[23] + sigma0(w[15]) + w[14] + SHA256_ADJUSTMENT - K[14]) & M);
  expand(w, 31);
  const working = rounds(SHA256_STATE, w, 14, K_BLOCK);
  return SHA256_INITIAL.map((x, i) => (x + working[i]) & M);
}

/** One standard SHA-256 block. Exported so the test can check it against node:crypto. */
export function sha256Compress(state: bigint[], block: Uint8Array): bigint[] {
  const w: bigint[] = [];
  for (let i = 0; i < 16; i++) w.push(be(block.subarray(i * 4, i * 4 + 4)));
  expand(w, 16);
  const working = rounds(state, w, 0, K);
  return state.map((x, i) => (x + working[i]) & M);
}

/** SHA-256 of the secret first block followed by the rest of `data`. */
function digest(data: Uint8Array): Buffer {
  if (data.length < 7) throw new Error("Token salt must contain at least seven bytes.");
  const length = 57 + data.length;
  const pad = (((55 - length) % 64) + 64) % 64;
  const padded = Buffer.alloc(data.length - 7 + 1 + pad + 8);
  padded.set(data.subarray(7));
  padded[data.length - 7] = 0x80;
  padded.writeBigUInt64BE(BigInt(length * 8), padded.length - 8);
  let state = initialState(data.subarray(0, 7));
  for (let off = 0; off < padded.length; off += 64) state = sha256Compress(state, padded.subarray(off, off + 64));
  const out = Buffer.alloc(32);
  state.forEach((x, i) => out.writeUInt32BE(Number(x), i * 4));
  return out;
}

/** Little-endian 32-bit words, zero-padded to an even count. */
function wordsLe(data: Uint8Array): bigint[] {
  const padded = Buffer.alloc(Math.ceil(data.length / 4) * 4);
  padded.set(data);
  const words: bigint[] = [];
  for (let i = 0; i < padded.length; i += 4) words.push(BigInt(padded.readUInt32LE(i)));
  if (words.length % 2) words.push(0n);
  return words;
}

function cs64(data: Uint8Array, sha: Buffer): [bigint, bigint] {
  const keyA = BigInt(sha.readUInt32LE(0)) | 1n;
  const keyB = BigInt(sha.readUInt32LE(4)) | 1n;
  const factors = [(keyA * CS64_FACTOR) & M, (keyB * CS64_FACTOR) & M];
  const terms = CS64_COEFFICIENTS.map(([coef], i) => (coef * factors[i % 2]) & M);
  const offsets = CS64_COEFFICIENTS.map(([, offset]) => offset);
  wordsLe(Buffer.concat([Buffer.from([0]), data])).forEach((word, i) => {
    let term = word * (i % 2 === 0 ? keyA : keyB);
    let offset = rol16(word) * (i % 2 === 0 ? 0xef0569fbn : 0xc31713dbn);
    if (i === 0) {
      term += CS64_ADJUSTMENT0 * factors[0];
      offset += CS64_ADJUSTMENT1;
    }
    terms.push(term & M);
    offsets.push(offset & M);
  });

  let swapAcc = 0n;
  let swapLast = 0n;
  let state = 0n;
  let acc = 0n;
  for (let i = 0; i < terms.length; i += 2) {
    const x = terms[i];
    const y = terms[i + 1];
    let t = rol16((offsets[i] + x) & M);
    let q = (t * 0x76f50f34n) & M;
    swapAcc += (rol16(q) * 0xc3efea97n + q) & M;
    t = rol16((offsets[i + 1] + y) & M);
    q = (t * 0x1881ce3cn) & M;
    swapLast = (rol16(q) * 0x35bd1ec9n + q) & M;
    swapAcc = (swapAcc + swapLast) & M;

    state = (state * keyA + x) & M;
    state = (rol16(state) * 0xcf98b111n) & M;
    state = (rol16(state) * 0x87085b9fn) & M;
    state = (rol16(state) * 0x12ceb96dn) & M;
    state = (rol16(state) * 0x257e1d83n) & M;
    acc += state;
    t = (state * keyB + y) & M;
    t = (rol16(t) * 0xa27416f5n) & M;
    t = (rol16(t) * 0xd38396ffn) & M;
    state = (rol16((rol16(t) * 0x7c932b89n) & M) * 0xbfa49f69n) & M;
    acc = (acc + state) & M;
  }
  return [swapLast ^ state, swapAcc ^ acc];
}

let last: { input: string; token: string } | null = null;

/** The v2 token for `input`: the window's ticks followed by the client token. */
export function gecV2(input: string): string {
  if (last?.input === input) return last.token;
  const data = Buffer.from(input, "ascii");
  const sha = digest(data);
  const [lo, hi] = cs64(data, sha);
  const head = Buffer.alloc(8);
  head.writeUInt32LE(Number(lo), 0);
  head.writeUInt32LE(Number(hi), 4);
  const token = `${head.toString("hex").toUpperCase()}-${sha.toString("hex").toUpperCase()}`;
  last = { input, token };
  return token;
}
