import { listEntities } from "@/lib/queries";
import { AskClient } from "./AskClient";

export const dynamic = "force-dynamic";

/**
 * The example questions used to be hard-coded to one library's subjects —
 * settlements, Suez, the High Dam — which read as a demo to anyone else. They
 * are now drawn from the three subjects this library actually talks about
 * most, and left out altogether when it has none yet.
 */
function suggestionsFor(): string[] {
  const top = listEntities({ limit: 40 })
    .sort((a, b) => b.mentions - a.mentions)
    .slice(0, 3)
    .map((e) => e.canonical_name);
  if (top.length === 0) return [];

  const out = [`Tell me everything you know about ${top[0]}`];
  if (top[1]) out.push(`What do my sources say about ${top[1]}?`);
  if (top[2]) out.push(`How are ${top[0]} and ${top[2]} connected?`);
  out.push("Where do my sources disagree with each other?");
  return out;
}

export default function AskPage() {
  return <AskClient suggestions={suggestionsFor()} />;
}
