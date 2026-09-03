/**
 * Starts Corpus in LAN mode: bound to every interface, and demanding the token.
 *
 *   node scripts/lan.mjs dev
 *   node scripts/lan.mjs start
 *
 * A script rather than an npm one-liner because the two halves must not come
 * apart. `--hostname 0.0.0.0` on its own is the audit's finding — a server
 * anyone on the Wi-Fi can drive — and `CORPUS_LAN=1` is what makes the
 * middleware insist on the token. Setting an environment variable inline is
 * also spelled differently in cmd.exe and in a POSIX shell, and package.json
 * cannot say both.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2] === "start" ? "start" : "dev";
const port = process.env.PORT || "5400";

const child = spawn(
  process.execPath,
  [path.join(root, "node_modules", "next", "dist", "bin", "next"), mode, "--port", port, "--hostname", "0.0.0.0"],
  {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, CORPUS_LAN: "1", PORT: port },
  }
);

child.on("exit", (code) => process.exit(code ?? 0));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
