/**
 * The research toolkit a web check can use — the parts that can be checked
 * without the network: the shipping-code rules, and the tool server's
 * protocol and its key gating.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/test-research.mjs
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let passed = 0;
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) {
    passed++;
    console.log(`  ok    ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
};
const section = (t) => console.log(`\n${t}`);

const codes = await import("../research/shipping-codes.mjs");

section("Check digits");
check("the ISO 6346 example container adds up", codes.containerValid("CSQU3054383"));
check("one digit off does not", !codes.containerValid("CSQU3054384"));
check("spaces and dashes are allowed", codes.containerValid("CSQU 305438-3"));
check("a real IMO number adds up", codes.imoValid("9074729"));
check("a mistyped one does not", !codes.imoValid("9074728"));
check("an air waybill's serial and check digit", codes.awbValid("17612345675") && !codes.awbValid("17612345676"));

section("Finding codes in text");
const found = codes.findShippingCodes(
  "Container MSKU 907032 3 and CSQU3054383 were loaded onto IMO 9074729 (MMSI 538004356). " +
    "AWB 176-1234 5675. B/L No. MAEU123456789. Call 202-5550 1234 for details. Bad box MSKU9070324."
);
const kinds = (k) => found.filter((f) => f.kind === k).map((f) => f.code);
check("both containers", kinds("container").join() === "MSKU9070323,CSQU3054383", JSON.stringify(kinds("container")));
check("a misread container is left out", !kinds("container").includes("MSKU9070324"));
check("the shipping line is named", found.find((f) => f.code === "MSKU9070323")?.carrier === "Maersk");
check("the ship, by IMO", kinds("ship").join() === "9074729");
check("the ship's MMSI", kinds("ship-mmsi").join() === "538004356");
check("the air waybill, with its airline", found.find((f) => f.kind === "air-waybill")?.airline === "Emirates");
check("the bill of lading", kinds("bill-of-lading").join() === "MAEU123456789");
check("a phone number is not an air waybill", found.filter((f) => f.kind === "air-waybill").length === 1);
check("nothing in plain prose", codes.findShippingCodes("The minister met the board in 2008.").length === 0);
check(
  "a word that starts with BL is not a bill of lading",
  codes.findShippingCodes("BLOODTHIRSTY tyrants; BLACKLISTING firms; Bloomberg former editor").length === 0
);
check("nor a label with no number after it", codes.findShippingCodes("the B/L ACKNOWLEDGEMENT form").length === 0);
check("a bill of lading in lower case still counts", codes.findShippingCodes("bl no: medu12345678")[0]?.code === "MEDU12345678");

section("The tool server");
async function server(keys) {
  const p = spawn(process.execPath, [path.join(root, "research", "mcp-server.mjs")], {
    env: { ...process.env, CORPUS_RESEARCH_KEYS: JSON.stringify(keys) },
  });
  let buf = "";
  const waiting = new Map();
  p.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const m = JSON.parse(line);
      waiting.get(m.id)?.(m);
    }
  });
  let n = 0;
  const call = (method, params) =>
    new Promise((resolve) => {
      const id = ++n;
      waiting.set(id, resolve);
      p.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  return { call, stop: () => p.kill() };
}

{
  const s = await server({});
  const init = await s.call("initialize", { protocolVersion: "2025-06-18" });
  check("it answers the handshake", init.result?.serverInfo?.name === "corpus-research");
  const names = (await s.call("tools/list")).result.tools.map((t) => t.name);
  check("keyless tools are offered", ["wikidata", "news_archive", "court_records", "telegram", "vessel"].every((t) => names.includes(t)));
  check("a tool whose key is missing is not", !names.includes("sanctions") && !names.includes("youtube"));
  check(
    "the investigation tools that need no key are offered",
    ["offshore_leaks", "weapon_components", "conflict_armament", "un_panel_reports", "arms_transfers", "trade_flows", "lei"].every((t) => names.includes(t))
  );
  check("leaks and flights wait for their keys", !names.includes("leaks") && !names.includes("flights"));
  check("there is no people-search tool", !names.some((t) => /people|person|phone|address/i.test(t)));
  const tracked = JSON.parse((await s.call("tools/call", { name: "track_shipment", arguments: { code: "MSKU 907032 3" } })).result.content[0].text);
  check("a container is tracked to its line", tracked.carrier === "Maersk" && tracked.valid === true);
  check("with the line's own tracking page", tracked.tracking === "https://www.maersk.com/tracking/MSKU9070323");
  const scanned = JSON.parse(
    (await s.call("tools/call", { name: "shipping_codes", arguments: { text: "aboard IMO 9074729" } })).result.content[0].text
  );
  check("the scanner is offered as a tool", scanned.codes?.[0]?.code === "9074729");
  const unknown = await s.call("tools/call", { name: "sanctions", arguments: { name: "x" } });
  check("calling a tool that is off is an error, not a crash", unknown.result?.isError === true);
  const bad = await s.call("no/such/method");
  check("an unknown method is refused", bad.error?.code === -32601);
  s.stop();
}
{
  const s = await server({ opensanctions: "x", youtube: "y", aleph: "a", opensky: "id:secret" });
  const names = (await s.call("tools/list")).result.tools.map((t) => t.name);
  check("a key switches its tool on", names.includes("sanctions") && names.includes("youtube"));
  check("so do the Aleph and OpenSky keys", names.includes("leaks") && names.includes("flights"));
  s.stop();
}

section("Sources a tool returned count as seen");
{
  const { readStream, sameUrl } = await import("../lib/ai/claude-code.ts");
  // A research tool's answer arrives as JSON text inside a tool result.
  const toolText = JSON.stringify({ register: { url: "https://www.vesselfinder.com/vessels/details/9074729" } });
  const lines = [
    { type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__research__vessel", input: { imo: "9074729" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", content: [{ type: "text", text: toolText }] }] } },
    { type: "result", is_error: false, result: "", structured_output: {}, usage: {} },
  ];
  const a = readStream(lines.map((l) => JSON.stringify(l)).join("\n"));
  check("a tool's address is kept", a.seen.includes(sameUrl("https://www.vesselfinder.com/vessels/details/9074729")), JSON.stringify(a.seen));
}

console.log(`\n${failed === 0 ? "All passed" : "FAILURES PRESENT"}: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
