// One-time: the RSA-2048 keypair that signs update packages.
//
//   node scripts/gen-update-keys.mjs
//
// The PRIVATE key goes to %USERPROFILE%\.raazi-keys\update-private.pem, locked
// with a passphrase and never inside the repository. The public modulus is
// written into launcher/UpdateKeys.cs, so every Raazi.exe built after this can
// verify a package offline. RSA rather than Ed25519 because the launcher is
// .NET Framework, which verifies RSA-SHA256 natively. Its own key, not
// Mutarjim's: a Mutarjim package must never install here.
//
// Losing the private key means no update can reach an install that has the
// old launcher — keep an offline copy.
//
// The passphrase is asked twice, or taken from RAAZI_KEY_PASSPHRASE. `--second`
// makes the spare pair the starter also trusts (update-private-2.pem), kept
// offline for the day the first must be retired.
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { askHidden, keysDir } from "./lib/private-key.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const second = process.argv.includes("--second");
const keyDir = keysDir();
const privPath = path.join(keyDir, second ? "update-private-2.pem" : "update-private.pem");
if (fs.existsSync(privPath)) {
  console.error(`${privPath} already exists — refusing to overwrite.`);
  console.error("Replacing it cuts off every install that has the current launcher.");
  process.exit(1);
}

let passphrase = process.env.RAAZI_KEY_PASSPHRASE || "";
if (!passphrase) {
  passphrase = await askHidden("Passphrase to lock the new key (12 characters or more): ");
  if ((await askHidden("The same passphrase again: ")) !== passphrase) {
    console.error("The two passphrases differ — nothing was written.");
    process.exit(1);
  }
}
if (passphrase.length < 12) {
  console.error("Use 12 characters or more — nothing was written.");
  process.exit(1);
}

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
fs.mkdirSync(keyDir, { recursive: true });
fs.writeFileSync(privPath, privateKey.export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase }), { mode: 0o600 });
fs.mkdirSync(path.join(root, "keys"), { recursive: true });
const pubName = second ? "update-public-2.pem" : "update-public.pem";
fs.writeFileSync(path.join(root, "keys", pubName), publicKey.export({ type: "spki", format: "pem" }));

const modulus = Buffer.from(publicKey.export({ format: "jwk" }).n, "base64url").toString("base64");
const field = second ? "Modulus2" : "Modulus1";
const keysFile = path.join(root, "launcher", "UpdateKeys.cs");
const source = fs.readFileSync(keysFile, "utf8");
const next = source.replace(new RegExp(`const string ${field} = "[^"]*";`), `const string ${field} = "${modulus}";`);
if (next === source) {
  console.error(`Could not find ${field} in launcher/UpdateKeys.cs — paste this in by hand:\n${modulus}`);
  process.exit(1);
}
fs.writeFileSync(keysFile, next);

console.log(`private -> ${privPath}  (SECRET: never ships, never commits; back it up offline)`);
console.log(`public  -> keys/${pubName} and launcher/UpdateKeys.cs`);
