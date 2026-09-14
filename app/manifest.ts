import type { MetadataRoute } from "next";

/**
 * What makes Corpus installable as an app: its own window, its own taskbar
 * icon, no tabs and no address bar — one place for all of it, rather than one
 * more browser tab among thirty. The launcher opens this window by itself;
 * the manifest is what lets the browser offer to install it too, and gives the
 * window its name and icon either way.
 *
 * The window is still the browser underneath, which is the point: your
 * sign-ins, the Corpus Inbox extension, and the Page view all keep working.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Corpus",
    short_name: "Corpus",
    description: "A research pedia built from your own sources.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#fbfaf7",
    theme_color: "#7a4b2a",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
