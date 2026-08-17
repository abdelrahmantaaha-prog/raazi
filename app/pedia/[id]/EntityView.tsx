"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useMemo, useState } from "react";
import type { EntityDetail } from "@/lib/queries";
import type { EffectiveTag, TagWithCounts } from "@/lib/tags";
import { ENTITY_LABEL } from "@/lib/types";
import { Badge, Button, Card } from "../../components/ui";
import { dirOf } from "@/lib/dir";
import { EntryBody, citationOrder, type Citation } from "../../components/EntryBody";
import { CitationPopover } from "../../components/CitationPopover";
import { TagChip } from "../../components/TagFilter";
import { ConnectionsGraph } from "../../components/ConnectionsGraph";
import { Portrait } from "./Portrait";
import { WhereCard } from "../../components/MapView";
import { DiscardButton, RestoreButton } from "./Discard";
import { reasonLabel } from "@/lib/discard-reasons";
import { EntityDrawer } from "../../components/EntityDrawer";
import { linkEntities, type LinkTarget } from "@/lib/entity-links";

type Tab = "entry" | "evidence" | "timeline" | "connections" | "history";

export function EntityView({
  detail,
  citations,
  siblings,
  allTags,
  portrait,
  where,
  pictured,
  links,
}: {
  detail: EntityDetail;
  /** Other subjects whose names, appearing in this entry, become openable. */
  links: LinkTarget[];
  citations: Citation[];
  siblings: { id: number; name: string; mentions: number }[];
  allTags: TagWithCounts[];
  portrait: { has: boolean; credit: { wikidata?: string; commons?: string; byYou: boolean } };
  where: { lat: number; lon: number; zoom?: number; wikidata?: string } | null;
  pictured: number[];
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("entry");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  /**
   * Which citation the reader is currently checking, and the marker it hangs
   * off — the quote opens beside the sentence, not at the foot of the entry.
   */
  const [openCite, setOpenCite] = useState<{ id: number; anchor: HTMLElement } | null>(null);
  /** Another subject, opened over this one rather than instead of it. */
  const [openEntity, setOpenEntity] = useState<number | null>(null);

  const { entity, entry, tags, evidence, evidenceBySource, aliases, events, relations, network, revisions, contradictions, merges, discarded, flags } = detail;

  const citationMap = useMemo(() => new Map(citations.map((c) => [c.id, c])), [citations]);
  const citeOrder = useMemo(
    () => citationOrder(entry?.body_md ?? "", citationMap),
    [entry?.body_md, citationMap]
  );
  const dir = dirOf(entry?.body_md ?? evidence[0]?.quote ?? "");

  const post = async (body: unknown, note: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/entities/${entity.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed.");
      setMessage(note);
      router.refresh();
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const generate = () =>
    post(
      { action: "generate" },
      entry ? "Queued a revision — it will appear here shortly." : "Queued. The entry will appear here shortly."
    );

  const openCount = contradictions.filter((c) => !c.resolved).length;

  /** Passages you rejected that the current entry text still cites. */
  const citesDiscarded = useMemo(() => {
    if (!entry?.body_md || discarded.length === 0) return 0;
    const cited = new Set(
      [...entry.body_md.matchAll(/\[\[m:(\d+)\]\]/g)].map((m) => Number(m[1]))
    );
    return discarded.filter((d) => cited.has(d.id)).length;
  }, [entry?.body_md, discarded]);

  /**
   * Jumps from a citation in the entry to the passage it came from. The
   * evidence list only exists while its tab is mounted, so switch first and
   * scroll on the next frame — otherwise there is nothing to scroll to, which
   * is exactly why the plain `#m<id>` anchors did nothing.
   */
  const showInEvidence = (mentionId: number) => {
    setTab("evidence");
    setOpenCite(null);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = document.getElementById(`m${mentionId}`);
        if (!el) return;
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("cite-flash");
        setTimeout(() => el.classList.remove("cite-flash"), 1600);
      });
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 gap-4">
          <Portrait
            entityId={entity.id}
            name={entity.canonical_name}
            hasPortrait={portrait.has}
            credit={portrait.credit}
          />
          <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-serif text-2xl font-semibold">{entity.canonical_name}</h1>
            <Badge>{ENTITY_LABEL[entity.type] ?? entity.type}</Badge>
            {entity.entry_state === "stale" && <Badge tone="warn">needs update</Badge>}
            {openCount > 0 && <Badge tone="danger">{openCount} contradiction{openCount === 1 ? "" : "s"}</Badge>}
          </div>
          {entity.disambiguator && (
            <p className="mt-1 text-sm text-[var(--color-muted)]">{entity.disambiguator}</p>
          )}
          {aliases.length > 1 && (
            <NameChooser
              entityId={entity.id}
              current={entity.canonical_name}
              aliases={aliases}
              locked={entity.name_locked === 1}
              onDone={() => router.refresh()}
            />
          )}
          <EntityTags entityId={entity.id} tags={tags} allTags={allTags} onDone={() => router.refresh()} />
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => post({ action: "star", starred: entity.starred !== 1 }, entity.starred ? "Unstarred." : "Starred.")}
            disabled={busy}
          >
            {entity.starred ? "★ Starred" : "☆ Star"}
          </Button>
          <Button variant="primary" onClick={generate} disabled={busy}>
            {entry ? (entity.entry_state === "stale" ? "Update entry" : "Regenerate") : "Write entry"}
          </Button>
          <a
            href={`/api/export?format=markdown&entity=${entity.id}`}
            className="rounded border border-[var(--color-rule)] bg-white px-3 py-1.5 text-sm font-medium hover:bg-[var(--color-accent-soft)]"
          >
            Export
          </a>
        </div>
      </div>

      {message && (
        <p className="rounded border border-[var(--color-rule)] bg-white px-3 py-2 text-sm">{message}</p>
      )}

      {/* The rejected-evidence warning takes precedence over the ordinary stale
          notice: an entry resting on evidence you have thrown out is a stronger
          claim than an entry that has merely fallen behind, and saying both at
          once would bury it. */}
      {citesDiscarded > 0 ? (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
          This entry still rests on {citesDiscarded} passage
          {citesDiscarded === 1 ? "" : "s"} you discarded — struck through in the text
          below. Rewrite it to remove what those sentences claim.{" "}
          <button onClick={generate} disabled={busy} className="font-medium underline">
            Rewrite now
          </button>
        </div>
      ) : (
        entity.entry_state === "stale" &&
        entry && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            New evidence has come in since this entry was written. Update it to fold in what
            the newer sources say — the changelog will tell you what changed.
          </div>
        )
      )}

      {where && (
        <WhereCard
          name={entity.canonical_name}
          lat={where.lat}
          lon={where.lon}
          zoom={where.zoom}
          wikidata={where.wikidata}
        />
      )}

      <div className="flex flex-wrap gap-1 border-b border-[var(--color-rule)]">
        {([
          ["entry", "Entry"],
          ["evidence", `Evidence (${evidence.length})`],
          ["timeline", `Timeline (${events.length})`],
          ["connections", `Connections (${relations.length})`],
          ["history", `History (${revisions.length})`],
        ] as [Tab, string][]).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition ${
              tab === id
                ? "border-[var(--color-accent)] text-[var(--color-accent)]"
                : "border-transparent text-[var(--color-muted)] hover:text-[var(--color-ink)]"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Keyed on the tab so switching replays the entrance: the panel fades
          up rather than snapping in, which is what tells you the page changed
          under you rather than jumped. */}
      <div key={tab} className="view-enter">
      {tab === "entry" && (
        <div className="space-y-4">
          {/* What the verify pass could not square with the citations. Shown
              above the entry, because the honest reading order is "here is
              what to be suspicious of" before the fluent prose that follows —
              these sentences wear real citation markers, which is exactly what
              makes them impossible to spot from inside the text. */}
          {entry && flags.length > 0 && (
            <details className="rounded-lg border border-amber-200 bg-amber-50">
              <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-amber-900">
                {flags.length} sentence{flags.length === 1 ? "" : "s"} not fully borne out by{" "}
                {flags.length === 1 ? "its" : "their"} citations
              </summary>
              <div className="space-y-3 border-t border-amber-200 px-4 py-3">
                <p className="text-xs text-amber-900/80">
                  Corpus re-read each cited sentence against the exact passages it cites.
                  These are the ones the passages do not carry — either saying more than the
                  sources say, or saying something the sources never say at all. The entry
                  text is untouched. <span className="font-medium">Regenerate</span> hands
                  these verdicts to the writer, which investigates each one: a claim the
                  evidence really supports is kept and re-cited correctly, an overstated one
                  is weakened to what the quotes carry, and one with no support is dropped.
                </p>
                <ul className="space-y-3">
                  {flags.map((f) => (
                    <li key={f.id} className="border-l-2 border-amber-300 pl-3">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <Badge tone={f.verdict === "unsupported" ? "danger" : "warn"}>
                          {f.verdict}
                        </Badge>
                        <p className="text-sm" dir={dirOf(f.sentence)}>
                          {f.sentence.replace(/\[\[m:\d+\]\]/g, "").trim()}
                        </p>
                      </div>
                      {f.note && (
                        <p className="mt-1 text-xs text-amber-900/80" dir={dirOf(f.note)}>
                          {f.note}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            </details>
          )}

          {!entry ? (
            <Card>
              <p className="font-medium">No entry written yet.</p>
              <p className="mt-1 text-sm text-[var(--color-muted)]">
                This entity has {evidence.length} quote{evidence.length === 1 ? "" : "s"} behind it.
                Entries are written on demand for anything below the automatic threshold, so
                nothing is spent on names mentioned once in passing.
              </p>
              <div className="mt-3">
                <Button variant="primary" onClick={generate} disabled={busy}>
                  Write it now
                </Button>
              </div>
            </Card>
          ) : (
            <>
              <Card>
                <p className="font-serif text-lg" dir={dirOf(entry.summary)}>
                  {entry.summary}
                </p>
              </Card>
              <Card>
                <EntryBody
                  body={entry.body_md}
                  citations={citationMap}
                  dir={dir}
                  onCite={(id, anchor) =>
                    setOpenCite((cur) => (cur?.id === id ? null : { id, anchor }))
                  }
                  activeId={openCite?.id}
                  renderText={(text, key) => (
                    <NameLinks
                      key={key}
                      text={text}
                      links={links}
                      onOpen={setOpenEntity}
                    />
                  )}
                />
                <p className="mt-6 border-t border-[var(--color-rule)] pt-3 text-xs text-[var(--color-muted)]">
                  Written from {evidence.length} passage{evidence.length === 1 ? "" : "s"} across{" "}
                  {evidenceBySource.length} source{evidenceBySource.length === 1 ? "" : "s"}. Last
                  updated {entry.updated_at}. Click any numbered citation to see the exact quote it
                  rests on.
                </p>
              </Card>

              {/* Another entry, opened over this one. Rendered once for the
                  whole page rather than per tab: the evidence and connections
                  tabs lead to other subjects too. */}
              <EntityDrawer entityId={openEntity} onClose={() => setOpenEntity(null)} />

              <CitationPopover
                citation={openCite ? citationMap.get(openCite.id) : undefined}
                anchor={openCite?.anchor ?? null}
                index={openCite ? citeOrder.get(openCite.id) : undefined}
                onClose={() => setOpenCite(null)}
                onShowInEvidence={showInEvidence}
              />

              <ol className="space-y-1 text-sm text-[var(--color-muted)]">
                {[...citeOrder.entries()]
                  .sort((a, b) => a[1] - b[1])
                  .map(([id, n]) => ({ c: citationMap.get(id)!, n }))
                  .map(({ c, n }) => (
                    <li key={c.id} className="flex gap-2">
                      <span className="w-5 shrink-0 text-right text-[var(--color-accent)]">
                        {n}.
                      </span>
                      <button
                        onClick={() => showInEvidence(c.id)}
                        className="text-left hover:text-[var(--color-ink)] hover:underline"
                      >
                        {c.citation}
                      </button>
                    </li>
                  ))}
              </ol>
            </>
          )}

          {contradictions.length > 0 && (
            <Card>
              <h2 className="font-serif text-lg font-semibold">Where sources disagree</h2>
              <p className="mt-1 text-sm text-[var(--color-muted)]">
                Both sides are kept. Nothing here has been resolved for you.
              </p>
              <ul className="mt-3 space-y-3">
                {contradictions.map((c) => (
                  <li key={c.id} className="rounded border border-[var(--color-rule)] p-3">
                    <p className="text-sm">
                      <span className="font-medium">{c.title_a ?? "Earlier evidence"}:</span> {c.claim_a}
                    </p>
                    <p className="mt-2 text-sm">
                      <span className="font-medium">{c.title_b ?? "Newer evidence"}:</span> {c.claim_b}
                    </p>
                    {c.quote_b && (
                      <p className="mt-2 border-l-2 border-[var(--color-rule)] pl-3 text-sm italic text-[var(--color-muted)]">
                        “{c.quote_b}”
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      )}

      {tab === "evidence" && (
        <div className="space-y-4">
          {evidenceBySource.map((group) => (
            <Card key={group.sourceId}>
              <div className="flex items-baseline justify-between gap-3">
                <Link href={`/sources/${group.sourceId}`} className="font-medium hover:text-[var(--color-accent)]">
                  {group.title}
                </Link>
                <span className="text-sm text-[var(--color-muted)]">
                  {group.author ?? ""} · {group.rows.length} passage{group.rows.length === 1 ? "" : "s"}
                </span>
              </div>
              <ul className="mt-3 space-y-3">
                {group.rows.map((row) => (
                  <li key={row.id} id={`m${row.id}`} className="border-l-2 border-[var(--color-rule)] pl-3">
                    <p className="text-sm italic" dir={dirOf(row.quote)}>
                      “{row.quote}”
                    </p>
                    {/* What a back-reference in the quote points at. Shown
                        because a wrong resolution is exactly the kind of error
                        that is invisible in the finished entry and obvious
                        here, next to the words it claims to explain. */}
                    {row.context && (
                      <p
                        className="mt-1 border-l-2 border-[var(--color-accent-soft)] pl-2 text-sm text-[var(--color-muted)]"
                        dir={dirOf(row.context)}
                      >
                        <span className="font-medium">Refers to:</span> {row.context}
                      </p>
                    )}
                    <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-[var(--color-muted)]">
                      <span>{row.locator || "—"}</span>
                      <span>as “{row.surface}”</span>
                      {row.confidence < 1 && (
                        <span title="This passage does not name the subject; it was identified from the text around it.">
                          named from context
                        </span>
                      )}
                      <StarQuote id={row.id} starred={row.starred === 1} />
                      <DiscardButton mentionId={row.id} onDone={setMessage} />
                    </div>
                    {row.claim && <p className="mt-1 text-sm text-[var(--color-muted)]">{row.claim}</p>}
                  </li>
                ))}
              </ul>
            </Card>
          ))}

          {/* What you threw out, kept where you can read and undo it. Evidence
              that disappeared when rejected would make the audit unauditable —
              you could never check your own past judgement, which is the one
              thing a record of judgements is for. */}
          {discarded.length > 0 && (
            <details className="rounded-lg border border-[var(--color-rule)] bg-white">
              <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
                Discarded by you ({discarded.length})
              </summary>
              <div className="border-t border-[var(--color-rule)] p-4">
                <p className="mb-3 text-xs text-[var(--color-muted)]">
                  These are kept out of the entry, out of the study cards, and out of
                  anything Corpus writes — including after a source is read again. The
                  reasons are given back to the model next time it writes about{" "}
                  {entity.canonical_name}.
                </p>
                <ul className="space-y-3">
                  {discarded.map((row) => (
                    <li
                      key={row.id}
                      className="border-l-2 border-[var(--color-rule)] pl-3 opacity-70"
                    >
                      <p className="text-sm italic line-through" dir={dirOf(row.quote)}>
                        “{row.quote}”
                      </p>
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--color-muted)]">
                        <Badge>{reasonLabel(row.discard_reason)}</Badge>
                        <span>{row.source_title}</span>
                        <span>{row.locator || "—"}</span>
                        {row.scope === "library" && <span>· applies library-wide</span>}
                        <RestoreButton mentionId={row.id} onDone={setMessage} />
                      </div>
                      {row.note && (
                        <p className="mt-1 text-xs text-[var(--color-muted)]" dir={dirOf(row.note)}>
                          “{row.note}”
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            </details>
          )}
        </div>
      )}

      {tab === "timeline" && (
        <Card>
          {events.length === 0 ? (
            <p className="text-sm text-[var(--color-muted)]">No dated events found for this entity.</p>
          ) : (
            <ol className="space-y-3">
              {events.map((ev) => (
                <li key={ev.id} className="flex gap-4">
                  <span className="w-28 shrink-0 font-mono text-sm text-[var(--color-accent)]">
                    {ev.date_text ?? ev.date_iso ?? "undated"}
                  </span>
                  <span className="text-sm">
                    {ev.summary}
                    {ev.source_title && (
                      <span className="text-[var(--color-muted)]"> — {ev.source_title}</span>
                    )}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Card>
      )}

      {tab === "connections" && (
        <div className="space-y-4">
          {relations.length === 0 ? (
            <Card>
              <p className="text-sm text-[var(--color-muted)]">No connections recorded yet.</p>
            </Card>
          ) : (
            <>
              <ConnectionsGraph
                centreName={entity.canonical_name}
                centreType={entity.type}
                connections={relations}
                network={network}
                pictured={pictured}
              />
              <details className="rounded-lg border border-[var(--color-rule)] bg-white">
                <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
                  Read them as a list ({relations.length})
                </summary>
                <ul className="space-y-2 border-t border-[var(--color-rule)] p-4">
                  {relations.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-baseline gap-2 text-sm">
                      <span className="text-[var(--color-muted)]">
                        {r.direction === "out" ? `${entity.canonical_name} ${r.type}` : `${r.type} →`}
                      </span>
                      <Link
                        href={`/pedia/${r.other_id}`}
                        className="font-medium hover:text-[var(--color-accent)]"
                      >
                        {r.other_name}
                      </Link>
                      {r.quote && (
                        <span className="w-full text-xs italic text-[var(--color-muted)]">
                          “{r.quote}”
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </details>
            </>
          )}
        </div>
      )}

      {tab === "history" && (
        <div className="space-y-4">
          <Card>
            <h2 className="font-serif text-lg font-semibold">Revisions</h2>
            {revisions.length === 0 ? (
              <p className="mt-1 text-sm text-[var(--color-muted)]">No entry has been written yet.</p>
            ) : (
              <ul className="mt-3 space-y-3">
                {revisions.map((r, i) => (
                  <li key={r.id} className="border-l-2 border-[var(--color-rule)] pl-3">
                    <p className="text-sm font-medium">
                      {i === revisions.length - 1 ? "First draft" : "Revised"}
                      {r.trigger_title && (
                        <span className="font-normal text-[var(--color-muted)]"> after adding “{r.trigger_title}”</span>
                      )}
                      <span className="ml-2 text-xs font-normal text-[var(--color-muted)]">{r.created_at}</span>
                    </p>
                    {r.changelog_md && (
                      <div className="mt-1 whitespace-pre-wrap text-sm text-[var(--color-muted)]">
                        {/* The changelog is prose for you, not a cited entry —
                            markers here are just noise. */}
                        {r.changelog_md.replace(/\s*\[\[m:\d+\]\]/g, "")}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <MergePanel entityId={entity.id} merges={merges} siblings={siblings} onDone={() => router.refresh()} />
        </div>
      )}
      </div>
    </div>
  );
}

/**
 * Most tags here are derived — this entity is mentioned in a source filed under
 * that topic. You can add one that isn't, or hide a derived one that is
 * technically true but not useful on this entity.
 */
/**
 * Names in the prose that the library knows, made openable.
 *
 * They open beside the entry rather than replacing it: following a reference
 * three deep and wanting the original back is the normal shape of reading an
 * encyclopedia, and browser history is a poor substitute for it.
 */
function NameLinks({
  text,
  links,
  onOpen,
}: {
  text: string;
  links: LinkTarget[];
  onOpen: (id: number) => void;
}) {
  return (
    <>
      {linkEntities(text, links).map((s, i) =>
        s.entityId === undefined ? (
          <span key={i}>{s.text}</span>
        ) : (
          <button
            key={i}
            type="button"
            onClick={() => onOpen(s.entityId!)}
            title={`Open ${s.entityName}`}
            className="cursor-pointer border-b border-dotted border-[var(--color-accent)] text-inherit hover:bg-[var(--color-accent-soft)]"
          >
            {s.text}
          </button>
        )
      )}
    </>
  );
}

function EntityTags({
  entityId,
  tags,
  allTags,
  onDone,
}: {
  entityId: number;
  tags: EffectiveTag[];
  allTags: TagWithCounts[];
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const on = new Set(tags.map((t) => t.id));

  const toggle = async (tagId: number, next: boolean) => {
    await fetch(`/api/entities/${entityId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "tag", tagId, on: next }),
    });
    onDone();
  };

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      {tags.map((t) => (
        <Link key={t.id} href={`/pedia?tag=${t.id}`}>
          <TagChip name={t.name} color={t.color} origin={t.origin} />
        </Link>
      ))}

      {allTags.length > 0 && (
        <button
          onClick={() => setOpen((v) => !v)}
          className="rounded-full border border-dashed border-[var(--color-rule)] px-2.5 py-0.5 text-xs text-[var(--color-muted)] hover:bg-[var(--color-accent-soft)]"
        >
          {open ? "done" : "edit topics"}
        </button>
      )}

      {open && (
        <div className="mt-2 w-full rounded border border-[var(--color-rule)] bg-white p-3">
          <p className="mb-2 text-xs text-[var(--color-muted)]">
            Dotted tags come from the sources this entity appears in. Turning one off hides it here
            only; it stays on the source.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {allTags.map((t) => {
              const active = on.has(t.id);
              return (
                <button
                  key={t.id}
                  onClick={() => toggle(t.id, !active)}
                  className={`rounded-full border px-2.5 py-0.5 text-xs transition ${
                    active ? "text-white" : "bg-white text-[var(--color-muted)] hover:bg-[var(--color-accent-soft)]"
                  }`}
                  style={
                    active
                      ? { backgroundColor: t.color ?? "var(--color-accent)", borderColor: t.color ?? "var(--color-accent)" }
                      : { borderColor: "var(--color-rule)" }
                  }
                >
                  {t.name}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function StarQuote({ id, starred }: { id: number; starred: boolean }) {
  const [on, setOn] = useState(starred);
  return (
    <button
      onClick={async () => {
        const next = !on;
        setOn(next);
        await fetch(`/api/mentions/${id}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ starred: next }),
        });
      }}
      className="hover:text-[var(--color-accent)]"
      title={on ? "Remove from quote bank" : "Save to quote bank"}
    >
      {on ? "★ in quote bank" : "☆ save quote"}
    </button>
  );
}

function MergePanel({
  entityId,
  merges,
  siblings,
  onDone,
}: {
  entityId: number;
  merges: EntityDetail["merges"];
  siblings: { id: number; name: string; mentions: number }[];
  onDone: () => void;
}) {
  const [other, setOther] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <Card>
      <h2 className="font-serif text-lg font-semibold">Identity</h2>
      <p className="mt-1 text-sm text-[var(--color-muted)]">
        Automatic resolution is deliberately cautious — it would rather leave two entries for
        one person than fuse two people. Fix either direction here; your decision is recorded
        and will not be undone by a later pass.
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        <select
          value={other}
          onChange={(e) => setOther(e.target.value)}
          className="min-w-[16rem] flex-1 rounded border border-[var(--color-rule)] bg-white px-3 py-2 text-sm"
        >
          <option value="">Fold another entity into this one…</option>
          {siblings.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.mentions})
            </option>
          ))}
        </select>
        <Button
          disabled={!other || busy}
          onClick={async () => {
            setBusy(true);
            await fetch(`/api/entities/${entityId}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ action: "merge", otherId: Number(other) }),
            });
            setOther("");
            setBusy(false);
            onDone();
          }}
        >
          Merge
        </Button>
      </div>

      {merges.length > 0 && (
        <ul className="mt-4 space-y-2">
          {merges.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span>
                Absorbed <span className="font-medium">{m.merged_name}</span>
                <span className="text-[var(--color-muted)]">
                  {" "}
                  — {m.reason} ({m.actor})
                </span>
              </span>
              <Button
                variant="ghost"
                onClick={async () => {
                  await fetch(`/api/merges/${m.id}`, { method: "DELETE" });
                  onDone();
                }}
              >
                Split back out
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/**
 * Which of the recorded forms is the heading.
 *
 * The choice is limited to names the sources actually used, because a heading
 * typed freehand would be the one line of the pedia with no evidence behind it.
 * Choosing locks it: `bestName` re-scores an entity every time a new alias
 * arrives, so without a lock a correction lasts until the next mention.
 */
function NameChooser({
  entityId,
  current,
  aliases,
  locked,
  onDone,
}: {
  entityId: number;
  current: string;
  aliases: string[];
  locked: boolean;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const others = aliases.filter((a) => a !== current);

  const choose = async (name: string) => {
    setBusy(true);
    try {
      await fetch(`/api/entities/${entityId}/name`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      setOpen(false);
      onDone();
    } finally {
      setBusy(false);
    }
  };

  const release = async () => {
    setBusy(true);
    try {
      await fetch(`/api/entities/${entityId}/name`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ unlock: true }),
      });
      setOpen(false);
      onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-1 text-sm text-[var(--color-muted)]">
      <span>Also called: {others.join(" · ")}</span>{" "}
      <button
        onClick={() => setOpen((v) => !v)}
        className="underline decoration-dotted underline-offset-2 hover:text-[var(--color-accent)]"
        aria-expanded={open}
      >
        {locked ? "heading set by you" : "change heading"}
      </button>

      {open && (
        <div className="mt-2 rounded-lg border border-[var(--color-rule)] bg-white p-3">
          <p className="mb-2 text-xs">
            Choose the form to head this entry. Only names your sources used are offered.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {aliases.map((a) => (
              <button
                key={a}
                disabled={busy}
                onClick={() => void choose(a)}
                className={`rounded-full border px-3 py-1 text-sm transition disabled:opacity-50 ${
                  a === current
                    ? "border-[var(--color-accent)] bg-[var(--color-accent-soft)] font-medium"
                    : "border-[var(--color-rule)] hover:bg-[var(--color-accent-soft)]"
                }`}
              >
                {a}
              </button>
            ))}
          </div>
          {locked && (
            <button
              onClick={release}
              disabled={busy}
              className="mt-2 text-xs underline hover:text-[var(--color-accent)]"
            >
              Let Corpus choose again
            </button>
          )}
        </div>
      )}
    </div>
  );
}
