// Reading the private keys that sign update packages, which are locked with a
// passphrase. The passphrase comes from
// RAAZI_KEY_PASSPHRASE when set, otherwise it is asked for at the terminal
// without being shown. It is never written anywhere.
import { createPrivateKey } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Where the keys live: %USERPROFILE%\.raazi-keys, or a USB stick via RAAZI_KEYS_DIR. */
export function keysDir() {
  return process.env.RAAZI_KEYS_DIR || path.join(os.homedir(), ".raazi-keys");
}

/** Whether a PEM file is protected with a passphrase. */
export function isEncryptedPem(pem) {
  return /ENCRYPTED/.test(pem);
}

/** Asks for a passphrase on the terminal, echoing nothing. */
export function askHidden(question) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    if (!input.isTTY) {
      reject(new Error("The key is passphrase-protected: set RAAZI_KEY_PASSPHRASE or run this in a terminal."));
      return;
    }
    process.stderr.write(question);
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    let answer = "";
    const onData = (ch) => {
      if (ch === "\r" || ch === "\n" || ch === "\u0004") {
        input.setRawMode(false);
        input.pause();
        input.off("data", onData);
        process.stderr.write("\n");
        resolve(answer);
      } else if (ch === "\u0003") {
        input.setRawMode(false);
        process.stderr.write("\n");
        process.exit(130);
      } else if (ch === "\u007f" || ch === "\b") {
        answer = answer.slice(0, -1);
      } else {
        answer += ch;
      }
    };
    input.on("data", onData);
  });
}

/** The private key in a PEM file, opened with its passphrase when it has one. */
export async function loadPrivateKey(pemPath) {
  const pem = fs.readFileSync(pemPath, "utf8");
  if (!isEncryptedPem(pem)) return createPrivateKey(pem);
  const passphrase =
    process.env.RAAZI_KEY_PASSPHRASE || (await askHidden(`Passphrase for ${path.basename(pemPath)}: `));
  try {
    return createPrivateKey({ key: pem, format: "pem", passphrase });
  } catch {
    throw new Error(`Wrong passphrase for ${pemPath}.`);
  }
}
