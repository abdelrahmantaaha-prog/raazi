/**
 * Refuses to build while Raazi is serving.
 *
 * `next build` replaces `.next` in place, and the filenames inside it are
 * content-hashed. A server that is already running keeps sending HTML that
 * points at the chunk names from the *previous* build, and those files no
 * longer exist — so every stylesheet and script 404s and the app renders as raw
 * unstyled HTML. It looks like a catastrophic CSS bug and is nothing of the
 * kind, which is exactly what makes it cost an hour to diagnose.
 *
 * This has now happened twice here, both times because "remember not to do
 * that" is not a mechanism. So it is a check: the build stops, says what is in
 * the way, and says how to clear it.
 *
 * CORPUS_ALLOW_HOT_BUILD=1 skips it, for the case where you genuinely mean to
 * rebuild under a server you are about to restart anyway.
 */
import net from "node:net";

const PORT = Number(process.env.PORT ?? 5400);

// A dist build goes to .next-dist (next.config.ts), so nothing is replaced
// under a running server.
if (process.env.CORPUS_ALLOW_HOT_BUILD === "1" || process.env.CORPUS_DIST === "1") {
  process.exit(0);
}

const busy = await new Promise((resolve) => {
  const socket = net.connect({ host: "127.0.0.1", port: PORT });
  const done = (answer) => {
    socket.destroy();
    resolve(answer);
  };
  socket.setTimeout(500);
  socket.once("connect", () => done(true));
  socket.once("timeout", () => done(false));
  socket.once("error", () => done(false));
});

if (!busy) process.exit(0);

console.error(
  [
    "",
    `  Something is already serving on port ${PORT}.`,
    "",
    "  Building now would replace .next underneath it, and every page it serves",
    "  afterwards would lose its stylesheets — the app renders as unstyled HTML",
    "  until the server is restarted.",
    "",
    "  Quit Raazi (tray icon → Quit) and make sure its node process is gone:",
    "",
    "    powershell -Command \"Get-Process node,Raazi -EA SilentlyContinue | Stop-Process -Force\"",
    "",
    "  Then build again. To override deliberately:  CORPUS_ALLOW_HOT_BUILD=1 npm run build",
    "",
  ].join("\n")
);
process.exit(1);
