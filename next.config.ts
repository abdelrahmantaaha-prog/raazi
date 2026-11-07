import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * A dev server must not build on top of the running app.
   *
   * `next dev` and `next build` both write to `.next` by default, so starting a
   * dev server while Raazi is running replaces the build underneath it: the
   * hashed chunks and stylesheets its pages ask for stop existing, and every
   * page it serves afterwards arrives unstyled until it is restarted. The build
   * guard in `scripts/guard-build.mjs` catches a build doing this and cannot
   * catch a dev server doing the same thing.
   *
   * Next sets NODE_ENV itself — `development` for `dev`, `production` for
   * `build` and `start` — so the two can simply never share a directory.
   */
  distDir: process.env.NODE_ENV === "development" ? ".next-dev" : ".next",

  // A self-contained server under .next/standalone, carrying the node_modules it
  // actually needs, is what `npm run dist` packages so a copy can be handed over
  // without a checkout or an `npm install`.
  //
  // But it is produced ONLY for a dist build, never for the everyday one, and
  // that is not a size optimisation — it is what keeps this machine running.
  // `next start` is the entrypoint the launcher uses from a checkout, and Next
  // 15 treats `next start` with `output: "standalone"` as unsupported: it prints
  // a warning and the server process exits on its own a moment after "Ready",
  // before it has served anything. That is the "Raazi stopped unexpectedly"
  // crash. A plain build has no standalone output, so `next start` is supported
  // and stays up; `npm run dist` sets CORPUS_DIST=1 to get the standalone bundle
  // it needs, and its copies run through server.js, not `next start`.
  output: process.env.CORPUS_DIST === "1" ? "standalone" : undefined,

  // Native module + libraries that must not be bundled by webpack/turbopack.
  serverExternalPackages: ["better-sqlite3", "jsdom", "pdfjs-dist"],
  experimental: {
    // Ingest routes stream large files through; keep the body cap generous.
    serverActions: { bodySizeLimit: "128mb" },
    // The LAN-token middleware means every request body passes through it,
    // and Next caps that at 10 MB by default: a 25 MB zip arrived as its first
    // 10 MB, which is not a zip (3 Oct 2026). The routes keep their own,
    // smaller ceilings — this only has to be above the largest of them.
    middlewareClientMaxBodySize: "1gb",
  },
};

export default nextConfig;
