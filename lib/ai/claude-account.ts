import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * Which Claude account Claude Code is signed in to on this machine, and
 * signing in to another one without leaving the app.
 *
 * Every call Corpus sends to "Claude (your plan)" goes through Claude Code, and
 * Claude Code answers as whoever it is signed in as — so that account, and a
 * way to change it, belong on the settings page rather than in a terminal.
 *
 * Signing in is Claude Code's own: `claude auth login` opens the browser on
 * this machine at Claude's sign-in page, and when the browser cannot finish
 * by itself Claude shows a code to paste back. The page shows the same link
 * (so the sign-in can be done from any device) and a box for that code, which
 * is written to the waiting process. The password never passes through here.
 */

const BIN = process.env.CORPUS_CLAUDE_BIN ?? "claude";
/** How long a sign-in may wait for the browser before it is abandoned. */
const LOGIN_TIMEOUT_MS = 10 * 60_000;

export interface ClaudeAccount {
  installed: boolean;
  signedIn: boolean;
  email: string | null;
  /** "pro", "max", … as Claude Code reports it. */
  plan: string | null;
  /** "claude.ai" for a subscription; anything else is not what the reader uses. */
  method: string | null;
  error?: string;
}

export interface LoginState {
  state: "idle" | "waiting" | "done" | "failed";
  url: string | null;
  error: string | null;
}

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // An API key would sign Claude Code in as the key, not the plan.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDECODE;
  return env;
}

/** What `claude auth status` says, reduced to what the page shows. */
export function readStatus(stdout: string): ClaudeAccount {
  const s = JSON.parse(stdout) as { loggedIn?: boolean; email?: string; subscriptionType?: string; authMethod?: string };
  return {
    installed: true,
    signedIn: Boolean(s.loggedIn),
    email: s.loggedIn ? (s.email ?? null) : null,
    plan: s.loggedIn ? (s.subscriptionType ?? null) : null,
    method: s.loggedIn ? (s.authMethod ?? null) : null,
  };
}

export function accountStatus(): Promise<ClaudeAccount> {
  return new Promise((resolve) => {
    const none: ClaudeAccount = { installed: false, signedIn: false, email: null, plan: null, method: null };
    let out = "";
    let child;
    try {
      child = spawn(BIN, ["auth", "status"], { env: childEnv(), windowsHide: true });
    } catch {
      return resolve({ ...none, error: "Claude Code is not installed on this machine." });
    }
    const timer = setTimeout(() => child.kill(), 30_000);
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ ...none, error: "Claude Code is not installed on this machine, or not on the PATH." });
    });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        resolve(readStatus(out.trim()));
      } catch {
        resolve({ ...none, installed: true, error: "Claude Code did not say who it is signed in as." });
      }
    });
  });
}

/** The sign-in link Claude Code prints for when the browser does not open. */
export function loginUrlOf(output: string): string | null {
  const m = /https:\/\/\S+\/oauth\/authorize\?\S+/.exec(output);
  return m ? m[0] : null;
}

const g = globalThis as unknown as {
  __claudeLogin?: { child: ChildProcessWithoutNullStreams; out: string; state: LoginState };
};

export function loginState(): LoginState {
  return g.__claudeLogin?.state ?? { state: "idle", url: null, error: null };
}

/**
 * Starts Claude Code's sign-in, or returns the one already waiting. Resolves
 * once the link is known (or the attempt has already ended), so the page can
 * show it at once.
 */
export function startLogin(): Promise<LoginState> {
  const running = g.__claudeLogin;
  if (running?.state.state === "waiting") return Promise.resolve(running.state);

  return new Promise((resolve) => {
    const child = spawn(BIN, ["auth", "login", "--claudeai"], { env: childEnv(), windowsHide: true });
    const session = { child, out: "", state: { state: "waiting", url: null, error: null } as LoginState };
    g.__claudeLogin = session;
    let answered = false;
    const answer = () => {
      if (!answered) {
        answered = true;
        resolve(session.state);
      }
    };
    const timer = setTimeout(() => {
      session.state = { ...session.state, state: "failed", error: "The sign-in waited ten minutes and was abandoned." };
      child.kill();
    }, LOGIN_TIMEOUT_MS);

    const read = (d: Buffer) => {
      session.out += d.toString();
      const url = loginUrlOf(session.out);
      if (url && !session.state.url) {
        session.state = { ...session.state, url };
        answer();
      }
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("error", () => {
      clearTimeout(timer);
      session.state = { state: "failed", url: null, error: "Claude Code is not installed on this machine, or not on the PATH." };
      answer();
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (session.state.state === "waiting" && code === 0) {
        try {
          (globalThis as unknown as { __claudeSignedIn?: () => void }).__claudeSignedIn?.();
        } catch {
          // Letting go of a spent allowance is a nicety; the sign-in stands.
        }
      }
      if (session.state.state === "waiting") {
        const said = session.out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() ?? "";
        session.state =
          code === 0
            ? { ...session.state, state: "done", error: null }
            : { ...session.state, state: "failed", error: /failed|error/i.test(said) ? said.replace(/^.*?>\s*/, "") : `Sign-in ended without finishing (exit ${code}).` };
      }
      answer();
    });
    // Should the link never appear, the page still hears back.
    setTimeout(answer, 15_000);
  });
}

/** The code Claude's page shows when the browser cannot hand it back itself. */
export function sendLoginCode(code: string): LoginState {
  const s = g.__claudeLogin;
  if (!s || s.state.state !== "waiting") throw new Error("No sign-in is waiting for a code. Start again.");
  const clean = code.trim();
  if (!clean || /[\r\n]/.test(clean) || clean.length > 2000) throw new Error("That does not look like a sign-in code.");
  s.child.stdin.write(`${clean}\n`);
  return s.state;
}

export function cancelLogin(): LoginState {
  const s = g.__claudeLogin;
  if (s?.state.state === "waiting") {
    s.state = { ...s.state, state: "failed", error: "Cancelled." };
    s.child.kill();
  }
  g.__claudeLogin = undefined;
  return loginState();
}

/**
 * Whether a request comes from this machine, by what it says about itself.
 * Next does not hand a route the socket, so this reads the Host header and
 * the forwarded-for header Next fills in — enough that a phone on the network
 * cannot change the account by accident, not a lock against someone trying.
 */
export function fromThisMachine(req: Request): boolean {
  const loop = (h: string) => /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|::ffff:127\.\d+\.\d+\.\d+)$/i.test(h);
  const host = (req.headers.get("host") ?? "").replace(/:\d+$/, "");
  const from = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
  return loop(host) && (!from || loop(from));
}

/**
 * Called once a sign-in finishes: a new account has a new allowance, so
 * whatever the app set aside because the old one was spent is let go.
 */
export function whenSignedIn(fn: () => void): void {
  (globalThis as unknown as { __claudeSignedIn?: () => void }).__claudeSignedIn = fn;
}
