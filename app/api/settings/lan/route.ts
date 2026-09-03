import { NextResponse } from "next/server";
import { ensureLanToken, lanAddresses, lanSettings, loginUrls } from "@/lib/lan";

export const dynamic = "force-dynamic";

/**
 * What the Settings page shows for LAN mode: whether it is on, the token, and
 * the addresses a phone could open — as ready-made sign-in links, so the page
 * can draw one as a QR code and not have to know how they are put together.
 *
 * Read-only. Turning LAN mode on and off goes through POST /api/settings with
 * `lan: { enabled }`, alongside every other preference. The token is generated
 * here if it does not exist yet, so the page always has one to show; that is
 * the only write, it happens once, and it is not something a caller controls.
 *
 * Reaching this route at all means the caller is either at the keyboard or
 * already holds the token, so returning it is not a disclosure.
 */
export async function GET() {
  const settings = lanSettings();
  const token = settings.token ?? (await ensureLanToken());
  const port = Number(process.env.PORT ?? 5400);
  return NextResponse.json({
    enabled: settings.enabled,
    token,
    port,
    addresses: lanAddresses(),
    loginUrls: loginUrls(port, token),
    // The bind address follows the script that started the server, not the
    // preference; a change takes effect when Corpus is next started.
    note: settings.enabled
      ? "LAN mode is on. Restart Corpus if it was started before you switched it on."
      : "LAN mode is off. Corpus listens on this computer only.",
  });
}
