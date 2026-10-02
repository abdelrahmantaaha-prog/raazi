import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Schema } from "@google/genai";
import { toJsonSchema, dropNulls } from "./schema";
import { SubscriptionLimitError, TruncatedOutputError } from "./errors";
import { unescapeModelJson } from "./escapes";
import type { AnthropicCall, AnthropicUsage } from "./anthropic";

/**
 * Claude on the Claude plan, through Claude Code.
 *
 * The Anthropic adapter bills by the token. A Claude subscription is not an
 * API key and cannot be turned into one; what it does cover is Claude Code.
 * So this adapter is Claude Code: `claude -p` on this machine, signed in as
 * you, one question and out. No tools, no settings files, no MCP servers, no
 * session kept — the model and nothing else.
 *
 * What that changes, against the API:
 *
 *  - **The limit is the plan's, not a bill.** Every call draws on the same
 *    five-hour and weekly allowance as your own chats. When it is spent,
 *    Claude Code says so and says when it resets; that becomes a
 *    SubscriptionLimitError, which the rotation treats as a spent allowance
 *    until that moment and hands the work to the next provider.
 *  - **Each call starts a process.** A few seconds before the model reads a
 *    word — nothing next to a brief, noticeable across thousands of passages.
 *  - **An API key in the environment would win.** Claude Code bills
 *    ANTHROPIC_API_KEY when it sees one, so it is removed from the child's
 *    environment: this path is the subscription or nothing.
 *
 * The "key" on the ring is only a placeholder that lets the rotation treat
 * this like any other provider; any text will do, as for the local model.
 */

const BIN = process.env.CORPUS_CLAUDE_BIN ?? "claude";

/** A schema longer than this goes into the prompt rather than onto a Windows command line. */
const MAX_SCHEMA_ARG = 20_000;

/** When "resets Oct 4, 4pm" or "resets 9:30pm" is, in this machine's time. */
export function parseReset(message: string, now = new Date()): Date | null {
  const m = /resets\s+(?:([A-Z][a-z]{2,8})\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(message);
  if (!m) return null;
  let hour = Number(m[3]) % 12;
  if (m[5].toLowerCase() === "pm") hour += 12;
  const at = new Date(now);
  at.setHours(hour, Number(m[4] ?? 0), 0, 0);
  if (m[1]) {
    const month = new Date(`${m[1]} 1, 2000`).getMonth();
    if (Number.isNaN(month)) return null;
    at.setMonth(month, Number(m[2]));
    if (at.getTime() < now.getTime() - 86_400_000) at.setFullYear(at.getFullYear() + 1);
  } else if (at.getTime() <= now.getTime()) {
    at.setDate(at.getDate() + 1);
  }
  return at;
}

interface CliResult {
  is_error?: boolean;
  subtype?: string;
  errors?: unknown[];
  result?: string;
  api_error_status?: number | null;
  structured_output?: unknown;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  modelUsage?: Record<string, unknown>;
}

export interface CliAnswer {
  text: string;
  structured?: unknown;
  usage: AnthropicUsage;
  model?: string;
}

/**
 * What Claude Code printed, as an answer or as the error it describes.
 * Errors carry a status in their message so the rest of the client reads them
 * the way it reads the API's: 401 a rejected key, 5xx a busy service.
 */
export function readResult(stdout: string): CliAnswer {
  let r: CliResult;
  try {
    r = JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? "") as CliResult;
  } catch {
    throw new Error(`Claude Code did not answer in the expected shape: ${stdout.trim().slice(0, 200) || "nothing"}`);
  }
  const said = String(r.result ?? "").trim();
  if (r.is_error) {
    if (r.api_error_status === 429 || /hit your .*limit|usage limit|limit reached|requires usage credits/i.test(said)) {
      throw new SubscriptionLimitError(said, parseReset(said));
    }
    if (r.api_error_status === 401 || /\/login|not logged|authenticat/i.test(said)) {
      throw new Error(`401 Claude Code is not signed in on this machine. Run \`claude\` once and sign in with your plan. (${said})`);
    }
    const status = r.api_error_status ? `${r.api_error_status} ` : "";
    // With no result text, the reason is in the subtype ("error_max_turns",
    // "error_max_structured_output_retries", …) and the errors list. Dropping
    // them left 155 failures in a day saying only "no reason given".
    const why = [r.subtype, ...(r.errors ?? []).map(String)].filter(Boolean).join(" — ").slice(0, 400);
    throw new Error(`${status}Claude Code: ${said || (why ? `failed (${why}).` : "failed with no reason given.")}`);
  }
  const u = r.usage ?? {};
  return {
    text: said,
    structured: r.structured_output,
    usage: {
      tokensIn: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      tokensOut: u.output_tokens ?? 0,
    },
    // The version the alias resolved to, so an entry can say which model wrote it.
    model: Object.keys(r.modelUsage ?? {})[0],
  };
}

async function run(opts: AnthropicCall & { schema?: Record<string, unknown> }): Promise<CliAnswer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corpus-claude-"));
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_BASE_URL;
  delete env.CLAUDECODE;

  const schemaText = opts.schema ? JSON.stringify(opts.schema) : "";
  const schemaInPrompt = schemaText.length > MAX_SCHEMA_ARG;
  const prompt = schemaInPrompt
    ? `${opts.prompt}\n\nAnswer with JSON only, matching this JSON Schema:\n${schemaText}`
    : opts.prompt;

  const args = [
    "-p",
    "--model", opts.model,
    "--output-format", "json",
    "--effort", opts.effort ?? "medium",
    "--tools", "",
    "--setting-sources", "",
    "--strict-mcp-config",
    "--no-session-persistence",
  ];
  // Long system prompts, the stage's lessons included, go in a file: a
  // Windows command line stops at 32,767 characters.
  if (opts.system) {
    const file = path.join(dir, "system.txt");
    fs.writeFileSync(file, opts.system, "utf8");
    args.push("--system-prompt-file", file);
  }
  if (schemaText && !schemaInPrompt) args.push("--json-schema", schemaText);

  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(BIN, args, { cwd: dir, env, windowsHide: true });
      let out = "";
      let err = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("Claude Code timed out."));
      }, opts.timeoutMs ?? 180_000);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(
          (e as NodeJS.ErrnoException).code === "ENOENT"
            ? new Error("Claude Code is not installed on this machine, or not on the PATH.")
            : e
        );
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        // An error still comes back as JSON on stdout, with a non-zero exit.
        if (out.trim()) resolve(out);
        else reject(new Error(`Claude Code exited ${code}: ${err.trim().slice(0, 300) || "no output"}`));
      });
      child.stdin.end(prompt, "utf8");
    });
    return readResult(stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Strips a fence a model sometimes puts round JSON it was told to send bare. */
function unfence(text: string): string {
  return text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
}

export async function claudeCodeJson<T>(
  opts: AnthropicCall & { schema: Schema }
): Promise<{ data: T; usage: AnthropicUsage; model: string }> {
  const answer = await run({ ...opts, schema: toJsonSchema(opts.schema) });
  let parsed: T;
  if (answer.structured !== undefined && answer.structured !== null) {
    parsed = answer.structured as T;
  } else {
    if (!answer.text) throw new Error("Empty response from Claude Code.");
    try {
      parsed = JSON.parse(unfence(answer.text)) as T;
    } catch {
      // As on the API path: JSON that will not parse is nearly always cut short,
      // and the worker knows how to split an oversized chunk.
      throw new TruncatedOutputError();
    }
  }
  return { data: dropNulls(unescapeModelJson(parsed)), usage: answer.usage, model: answer.model ?? opts.model };
}

export async function claudeCodeText(
  opts: AnthropicCall
): Promise<{ data: string; usage: AnthropicUsage; model: string }> {
  const answer = await run(opts);
  if (!answer.text) throw new Error("Empty response from Claude Code.");
  return { data: answer.text, usage: answer.usage, model: answer.model ?? opts.model };
}

/**
 * Whether Claude Code is here at all, without spending the plan on it. A
 * signed-out or spent plan shows itself on the first real call, with a
 * reason that says which.
 */
export async function validateClaudeCode(): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn(BIN, ["--version"], { windowsHide: true });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("error", () => resolve({ ok: false, error: "Claude Code is not installed on this machine, or not on the PATH." }));
    child.on("close", (code) =>
      resolve(code === 0 && /claude code/i.test(out) ? { ok: true } : { ok: false, error: `Claude Code did not start (${out.trim() || `exit ${code}`}).` })
    );
  });
}
