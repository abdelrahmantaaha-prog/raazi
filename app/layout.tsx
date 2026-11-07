import type { Metadata } from "next";
import "./globals.css";
import { Nav } from "./components/Nav";
import { PageTransition } from "./components/PageTransition";
import { SectionTabs } from "./components/SectionTabs";
import { ServerWatch } from "./components/ServerWatch";
import { activeDiscipline, listDisciplines } from "@/lib/disciplines";

/**
 * The discipline whose library every page below is showing — named in the
 * rail only once there is more than one, since a single library needs no
 * label and would only carry a word that meant nothing.
 */
function disciplineName(): string | undefined {
  try {
    return listDisciplines().length > 1 ? activeDiscipline().name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Rendered per request, never at build time.
 *
 * Nothing in this layout touches a request, so Next took every page below that
 * did not either for static, and baked the rail into it as `next build` saw it:
 * Home, Settings and Activity went on naming whichever discipline was open on
 * the day of the build, through every switch and restart after it.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Raazi",
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
        <Nav discipline={disciplineName()} />
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
