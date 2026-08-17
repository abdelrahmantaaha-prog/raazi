import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * A dev server must not build on top of the running app.
   *
   * `next dev` and `next build` both write to `.next` by default, so starting a
   * dev server while Corpus is running replaces the build underneath it: the
   * hashed chunks and stylesheets its pages ask for stop existing, and every
   * page it serves afterwards arrives unstyled until it is restarted. The build
   * guard in `scripts/guard-build.mjs` catches a build doing this and cannot
   * catch a dev server doing the same thing.
   *
   * Next sets NODE_ENV itself — `development` for `dev`, `production` for
   * `build` and `start` — so the two can simply never share a directory.
   */
  distDir: process.env.NODE_ENV === "development" ? ".next-dev" : ".next",

  // Native module + libraries that must not be bundled by webpack/turbopack.
  serverExternalPackages: ["better-sqlite3", "jsdom", "pdfjs-dist"],
  experimental: {
    // Ingest routes stream large files through; keep the body cap generous.
    serverActions: { bodySizeLimit: "128mb" },
  },
};

export default nextConfig;
