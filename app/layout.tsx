import type { Metadata } from "next";
import "./globals.css";
import { Nav } from "./components/Nav";
import { PageTransition } from "./components/PageTransition";
import { SectionTabs } from "./components/SectionTabs";
import { ServerWatch } from "./components/ServerWatch";

export const metadata: Metadata = {
  title: "Corpus",
  description: "A research pedia built from your own sources.",
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  // The reader and the network map both want the whole screen on a phone.
  viewportFit: "cover" as const,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <ServerWatch />
        <Nav />
        {/* Offset by the rail, which is fixed. The max width is applied inside
            the remaining space rather than to the page, so a wide screen still
            centres its content and a narrow one gives everything it has. */}
        <main className="ms-14 px-4 py-6 sm:px-6 sm:py-8 lg:ms-48">
          {/* The width wrapper sits outside the transition so that the
              transition's own children are the page's sections — which is what
              the stagger in globals.css reaches for. */}
          <div className="mx-auto max-w-6xl">
            {/* Above the transition, and outside it: the strip belongs to the
                section rather than to the page, so it should hold still while
                the page under it changes. */}
            <SectionTabs />
            <PageTransition>{children}</PageTransition>
          </div>
        </main>
      </body>
    </html>
  );
}
