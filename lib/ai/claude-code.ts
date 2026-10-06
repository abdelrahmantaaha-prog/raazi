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
  /** On a web call: every address the searches returned or a fetch opened. */
  seen?: string[];
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

/**
 * One address in the form two spellings of it share, so a link the answer
 * gives can be matched against the links the searches actually returned.
 */
export function sameUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    return `${host}${u.pathname.replace(/\/+$/, "")}${u.search}`;
  } catch {
    return raw.trim().toLowerCase();
  }
}

/**
 * A web call's transcript, as Claude Code streams it: the answer, and every
 * address the model was actually shown — the links each search returned and
 * the pages it fetched. A source the answer names that is on neither list was
 * not read; it was remembered, or made up.
 */
export function readStream(stdout: string): CliAnswer {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim().startsWith("{"));
  const seen = new Set<string>();
  const take = (text: string) => {
    for (const m of text.matchAll(/https?:\/\/[^\s"'<>\\)\]]+/g)) seen.add(sameUrl(m[0].replace(/[.,;:]+$/, "")));
  };
  let result: string | undefined;
  for (const line of lines) {
    let ev: {
      type?: string;
      message?: { content?: { type?: string; name?: string; input?: { url?: string }; content?: unknown }[] };
    };
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === "result") result = line;
    for (const c of ev.message?.content ?? []) {
      if (c.type === "tool_use" && c.name === "WebFetch" && c.input?.url) take(c.input.url);
      if (c.type === "tool_result") take(typeof c.content === "string" ? c.content : JSON.stringify(c.content ?? ""));
    }
  }
  if (!result) throw new Error(`Claude Code did not finish its answer: ${stdout.trim().slice(-200) || "nothing"}`);
  return { ...readResult(result), seen: [...seen] };
}

/** A page or picture for Claude to look at, and the extension that says what it is. */
export interface Attachment {
  ext: string;
  data: Buffer;
}

/** Corpus's research tool server, and the keys it may use. */
export interface ResearchTools {
  server: string;
  keys: Record<string, string>;
}

async function run(
  opts: AnthropicCall & {
    schema?: Record<string, unknown>;
    schemaInPrompt?: boolean;
    web?: boolean;
    research?: ResearchTools;
    files?: Attachment[];
  }
): Promise<CliAnswer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corpus-claude-"));
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_BASE_URL;
  delete env.CLAUDECODE;

  // Pages and pictures to look at — a scanned page, a photographed document —
  // go into this call's own folder, and Claude may open files there and
  // nowhere else: a read outside it is refused (checked 3 Oct 2026).
  const attached: string[] = [];
  for (const [i, f] of (opts.files ?? []).entries()) {
    const name = `attachment-${i + 1}${f.ext}`;
    fs.writeFileSync(path.join(dir, name), f.data);
    attached.push(name);
  }
  const looked = attached.length
    ? `Open and read ${attached.length === 1 ? "this file" : "these files"} in the current folder first: ${attached.join(", ")}.\n\n`
    : "";

  const schemaText = opts.schema ? JSON.stringify(opts.schema) : "";
  const schemaInPrompt = opts.schemaInPrompt || schemaText.length > MAX_SCHEMA_ARG;
  const prompt =
    looked +
    (schemaInPrompt ? `${opts.prompt}\n\nAnswer with JSON only, matching this JSON Schema:\n${schemaText}` : opts.prompt);

  // A web call gets search and page-reading and nothing else — no files, no
  // shell — and streams its turns so the addresses it was shown can be kept.
  // With research tools, Corpus's own tool server is started beside it for the
  // length of the call (research/mcp-server.mjs), and its tools are allowed too.
  const web = Boolean(opts.web || opts.research);
  const tools = [...(web ? ["WebSearch", "WebFetch"] : []), ...(attached.length ? ["Read"] : [])];
  const allowed = [
    ...(web ? ["WebSearch", "WebFetch"] : []),
    ...(opts.research ? ["mcp__research"] : []),
    ...(attached.length ? ["Read(./**)"] : []),
  ];
  const args = [
    "-p",
    "--model", opts.model,
    "--output-format", web ? "stream-json" : "json",
    ...(web ? ["--verbose"] : []),
    "--effort", opts.effort ?? "medium",
    "--tools", tools.join(","),
    ...(allowed.length ? ["--allowedTools", allowed.join(",")] : []),
    "--setting-sources", "",
    "--strict-mcp-config",
    "--no-session-persistence",
  ];
  if (opts.research) {
    // The keys ride in the server's own environment, in a file inside this
    // call's temporary folder, which is removed when the call ends.
    const file = path.join(dir, "research.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          research: {
            type: "stdio",
            command: process.execPath,
            args: [opts.research.server],
            env: { CORPUS_RESEARCH_KEYS: JSON.stringify(opts.research.keys) },
          },
        },
      }),
      "utf8"
    );
    args.push("--mcp-config", file);
  }
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
    return web ? readStream(stdout) : readResult(stdout);
  } finally {
    // Windows can hold the folder a moment after the process exits. A throw
    // here replaced a finished answer with EPERM and failed the task, so a
    // folder left behind in Temp is the lesser harm.
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch {
      /* left for Windows to clear */
    }
  }
}

/** Strips a fence a model sometimes puts round JSON it was told to send bare. */
export function unfence(text: string): string {
  // And a sentence before or after the object, which a reply sometimes has.
  // After it is the case that bit: a passage with nothing to extract came back
  // as a fenced empty answer and then a paragraph of "Rationale", and the
  // whole of it was read as JSON, failed, and was taken for a cut-off reply
  // (6 Oct 2026). The first complete object is the answer; the rest is not.
  const from = text.indexOf("{");
  if (from < 0) return text.trim();
  let depth = 0;
  let inString = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return text.slice(from, i + 1);
  }
  // Never closed: cut short, and left whole for the caller to say so.
  return text.slice(from).trim();
}

/** The JSON in a reply, read leniently; undefined when it cannot be read at all. */
export function readJson<T>(text: string): T | undefined {
  const from = text.indexOf("{");
  const attempts = [
    () => unfence(text),
    () => escapeInnerQuotes(unfence(text)),
    // A bare quote can throw the object's end off; repaired first, it cannot.
    () => unfence(escapeInnerQuotes(from >= 0 ? text.slice(from) : text)),
  ];
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt()) as T;
    } catch {
      /* next */
    }
  }
  return undefined;
}

/** A reply that closes its object, as opposed to one that stopped partway. */
function looksWhole(text: string): boolean {
  return /[}\]]\s*(```)?\s*$/.test(text.trim());
}

/**
 * Escapes double quotes a model left bare inside a string value — a passage
 * about a dolly marked "CP28", copied into a quote field without its
 * backslashes. Inside a string, a quote closes it only when what follows is
 * what may follow a string: a comma, a colon, or a closing bracket.
 */
export function escapeInnerQuotes(json: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (ch === "\\") {
      out += ch + (json[i + 1] ?? "");
      i++;
      continue;
    }
    if (ch === '"') {
      const next = /^\s*(\S)/.exec(json.slice(i + 1))?.[1];
      if (next === undefined || next === "," || next === ":" || next === "}" || next === "]") {
        inString = false;
        out += ch;
      } else {
        out += '\\"';
      }
      continue;
    }
    out += ch;
  }
  return out;
}

/** Model + schema pairs whose structured output failed; until a restart they go as plain JSON. */
const plainJsonFor = new Set<string>();

export async function claudeCodeJson<T>(
  opts: AnthropicCall & {
    schema: Schema;
    web?: boolean;
    research?: ResearchTools;
    /**
     * Ask for the answer as plain JSON in the reply from the start. For long
     * answers: a reading of a dense passage — forty thousand characters of
     * quotes — came back from the structured-output route as JSON that would
     * not parse, and Claude Code had the whole of it rewritten three times,
     * five and a half minutes a passage (3 Oct 2026).
     */
    plainJson?: boolean;
  }
): Promise<{ data: T; usage: AnthropicUsage; model: string; seen?: string[] }> {
  const schema = toJsonSchema(opts.schema);
  const key = `${opts.model} ${JSON.stringify(schema)}`;
  let answer: CliAnswer;
  try {
    answer = await run({ ...opts, schema, schemaInPrompt: Boolean(opts.plainJson) || plainJsonFor.has(key) });
  } catch (err) {
    // Claude Code hands a --json-schema answer back through a tool call, and
    // on a long Markdown body (an entry, 2–4 KB of prose and citation markers)
    // Opus kept sending that call input that would not parse — five tries,
    // then "error_max_structured_output_retries". On 2 Oct 2026 that was most
    // of the day's entries. The same answer written as plain JSON in the reply
    // comes through, so ask once more that way — and keep asking that way for
    // this model and shape, since the five failed tries are paid for each time.
    if (opts.plainJson || plainJsonFor.has(key) || !/error_max_structured_output_retries/.test(String((err as Error)?.message))) throw err;
    console.log("[corpus] Claude Code could not send its answer as structured output; asking for plain JSON from now on");
    plainJsonFor.add(key);
    answer = await run({ ...opts, schema, schemaInPrompt: true });
  }
  let parsed: T;
  if (answer.structured !== undefined && answer.structured !== null) {
    parsed = answer.structured as T;
  } else {
    if (!answer.text) throw new Error("Empty response from Claude Code.");
    let json = readJson<T>(answer.text);
    if (json === undefined && looksWhole(answer.text)) {
      // Whole but broken — not cut short — so splitting the passage would not
      // help, and a short one cannot be split at all: five photo readings
      // failed that way on 6 Oct 2026. Asked once more, it comes back right.
      answer = await run({
        ...opts,
        schema,
        schemaInPrompt: true,
        prompt: `${opts.prompt}\n\nYour last answer was not valid JSON. Inside every string value, escape each double quote as \\".`,
      });
      json =
        answer.structured !== undefined && answer.structured !== null
          ? (answer.structured as T)
          : answer.text
            ? readJson<T>(answer.text)
            : undefined;
    }
    // As on the API path: JSON that still will not parse is taken as cut
    // short, and the worker knows how to split an oversized chunk.
    if (json === undefined) throw new TruncatedOutputError();
    parsed = json;
  }
  return {
    data: dropNulls(unescapeModelJson(parsed)),
    usage: answer.usage,
    model: answer.model ?? opts.model,
    seen: answer.seen,
  };
}

export async function claudeCodeText(
  opts: AnthropicCall & { files?: Attachment[] }
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
