import { NextResponse } from "next/server";
import { readBody } from "@/lib/http";
import {
  accountStatus,
  cancelLogin,
  fromThisMachine,
  loginState,
  sendLoginCode,
  startLogin,
  whenSignedIn,
} from "@/lib/ai/claude-account";
import { forgetPlanLimit } from "@/lib/keys";

export const dynamic = "force-dynamic";

whenSignedIn(forgetPlanLimit);

const LOCAL_ONLY = "Open Raazi on this computer to change the Claude account.";

/** Who Claude Code is signed in as, and how a sign-in in progress is going. */
export async function GET(req: Request) {
  const local = fromThisMachine(req);
  const account = await accountStatus();
  // Another device on the network sees whether Claude is ready, not whose it is.
  return NextResponse.json({
    account: local ? account : { ...account, email: null },
    login: loginState(),
    local,
  });
}

/** { action: "start" | "code" | "cancel", code? } */
export async function POST(req: Request) {
  if (!fromThisMachine(req)) return NextResponse.json({ error: LOCAL_ONLY }, { status: 403 });
  const body = (await readBody<{ action?: string; code?: string }>(req)) ?? {};
  try {
    if (body.action === "start") return NextResponse.json({ login: await startLogin() });
    if (body.action === "code") return NextResponse.json({ login: sendLoginCode(String(body.code ?? "")) });
    if (body.action === "cancel") return NextResponse.json({ login: cancelLogin() });
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
