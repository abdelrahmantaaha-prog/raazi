# Corpus

A research pedia that grows with your sources.

Feed it books, papers, articles and recordings. It reads them once, finds every
person, organisation, institution, event and place, and writes an encyclopedia
entry for each — with every sentence traceable to a quote at a page number. Add
another source next month and the existing entries revise themselves, and tell
you what changed.

Runs entirely on your machine. Your library, the database and your API key never
leave it.

## Running it

Double-click **Corpus.exe** (or the desktop shortcut). It starts the server in the
background, opens your browser, and sits in the notification area — right-click the
tray icon to reopen it, open the data folder, or quit. Closing the browser leaves
it running, so a long ingest keeps going; quitting from the tray stops it.

First time only:

```bash
npm install
npm run build
npm run build:exe
```

`build:exe` compiles the launcher with the C# compiler that already ships with
Windows — about 15 KB, no Electron, nothing extra to install. Rerun `npm run build`
after changing the app; the launcher falls back to dev mode if there is no build.

Prefer a terminal? `npm run dev` still works.

Then open <http://localhost:5400> and paste a Gemini API key into Settings
(free keys: <https://aistudio.google.com/apikey>).

**Add more than one key.** When a key runs out of daily quota it is set aside until
it resets and the work carries straight on with the next; a run only stops when
every key is spent, and then only until the *first* one comes back. Free keys are
rate limited per key too, so the pacing is per key — three keys means roughly three
times the throughput. Settings shows each key's state and lets you pause, retry or
remove one.

## Using more than one service

Keys can come from Groq, Cerebras, OpenRouter, Mistral, or anything speaking the
OpenAI API (Ollama, LM Studio, vLLM) as well as Gemini. **Settings → Who does what**
then decides which service handles which stage.

The one worth moving is **Reading passages** — around 88% of all tokens, and it needs
nothing but text in and JSON out. Sending it elsewhere is what makes a Gemini quota
last; everything else is small enough to leave alone.

Three rules the router enforces whatever you configure:

- **Capability wins.** Scanned-page OCR, transcription and entity embeddings only go
  to a provider that can actually do them. On free tiers that means Gemini, which is
  why it stays the backbone rather than being replaced.
- **Non-Latin sources override the routing.** The cheaper providers are appreciably
  weaker on Arabic, and a name they miss is lost silently rather than slowly. A
  source's declared language decides this; where none is declared — PDFs, pasted
  text — the router reads the passage itself.
- **Nothing stops for one service being spent.** Keys rotate within a provider, then
  providers rotate between themselves, and only when nothing can answer does the run
  park — until the first key *anywhere* returns.

Bear in mind that on Groq, Cerebras and OpenRouter, usage is counted per account
rather than per key, so extra keys there buy nothing. Only Gemini's limits are per
project. Settings says so under each provider.

The key is stored server-side in `data/config.json`, not in your browser. That is
deliberate: ingesting a book takes hundreds of calls over a long stretch, and the
background worker has to keep going with no tab open, so it needs to reach the key
on its own. `GEMINI_API_KEY` in `.env.local` overrides the stored one.

## What it does with a source

| Stage | Cost | What happens |
|---|---|---|
| Parse | free | PDF text via pdfjs, EPUB via the spine, articles via Readability, Markdown by heading |
| File | 1 call | Reads the opening and files it under the right topics (skipped if you chose them yourself) |
| OCR | paid, only if needed | Pages with no embedded text are sliced out and sent to Gemini as images. A born-digital PDF spends nothing here |
| Extract | 1 call per ~3,500 tokens | Entities, relations and dated events, each with a verbatim quote |
| Resolve | cheap, mostly free | "Nasser" and "Gamal Abdel Nasser" become one person. Exact matches are free; only genuinely ambiguous pairs reach the model, batched ten at a time |
| Entries | 1 call per entity | Only for entities above the mention threshold or ones you starred. The rest stay stubs and generate when you open them |

Everything converges on **chunks** — ~3,500-token windows split on paragraph
boundaries, each carrying the page, chapter or timecode a citation will point at.

### What never reaches Gemini

A born-digital PDF and a web article are turned into Markdown **locally, for free** —
Gemini receives text, never the file. So the way to make them cheaper is not to
convert them again, it is to stop sending the parts that are not prose. Before
anything is chunked, `lib/ingest/clean.ts` drops:

- **endnotes, bibliographies and reference lists** — pages that are mostly citation
  lines, plus runs of three or more consecutive citation lines inside pages that are
  otherwise prose;
- **running heads, footers and bare page numbers** — anything repeating across a
  quarter of the pages;
- hyphenation across line breaks, ligatures and zero-width junk.

Measured on a real 717,000-character academic PDF: **16% fewer tokens and 8 fewer
API calls**, and the note shown when you add a source tells you what it skipped.

The threshold is deliberately conservative. pdfjs inlines superscript endnote
markers, so a sentence can begin "22 Shrewdly, WestExec…" and look bibliographic
while being the actual argument — cutting more aggressively deletes the book. If you
are researching a bibliography itself, this is the knob to reconsider.

PDF headings are recovered from font sizes and emitted as Markdown (156 of them in
that same book), and article HTML becomes Markdown rather than flat text. That is
partly about tokens and mostly about giving the chunker real boundaries, so a chunk
is a coherent passage instead of half of two.

## Entries are derived, not authored

`entries.built_from_hash` is a hash of the mention set an entry was written from.
When a new source adds mentions the hash stops matching and the entity is marked
**stale**.

Regenerating is a revision, not a rewrite: the model gets the existing entry plus
*only the evidence it has not seen*, and returns the revised text, a changelog, and
any contradictions it noticed. Cheaper than re-reading everything, and it leaves a
record of how the picture shifted when each book arrived — visible under **History**.

**Stale entries are rewritten on their own.** Every ingest ends by queueing the
entries its new evidence affected, and the worker sweeps for anything else the
moment its queue is clear — so staleness caused by something other than an ingest
(a merge you made by hand, a source you removed, a run interrupted before its
planning step) is picked up too rather than waiting for the next book.

Two rules, deliberately separate: a **new** entry is only written once an entity
clears the mention threshold, so the hundreds of names a book produces do not each
cost a call; an entry that **already exists** is always brought back into line with
its evidence, however small the entity — a stale entry contradicts the sources it
cites, which is the one thing this tool must not do. The Library shows the count
with an **Update now** button, and Settings can switch the automatic part off.

Where sources disagree, both claims are kept with their evidence and shown on the
entry. Silently picking a winner would be a bug, not a feature.

## Topics, when you research several things at once

Topics organise the pedia without partitioning it. Crucially, **an entity is never
split or duplicated by topic** — someone who turns up in two of your subjects stays
one person, with one entry drawing on all the evidence, findable under both.

- A **source** carries one or more topics. New sources are filed automatically:
  one cheap call reads the opening, and is shown the topics you already use so it
  reuses them rather than coining "Egypt", "Egyptian History" and "Modern Egypt".
- An **entity** carries whatever topics its sources carry. This is derived live,
  so re-filing a source instantly re-tags everyone it mentions — nothing to rebuild.
- On top of that you can add a topic to an entity by hand, or hide a derived one
  that is technically true but not useful there. Your override always wins.
- Filter the Pedia, Search and the quote bank by topic; **Topics** manages them,
  including merging two names for one subject and bulk-filing anything unfiled.

One honest limit: because entity topics are derived from sources, a wide-ranging
book tags everyone in it. A book about Egypt that covers the Bandung conference
will put "Egypt" on Sukarno. Hide it on that entity, or split the source.

## Running out of tokens, and picking back up

Every unit of work is a row in `tasks`. The worker claims one with an atomic
`UPDATE … WHERE state='pending'`, calls Gemini, then writes the results *and* marks
the task done in a single transaction. Kill the process mid-book and you lose at
most one task; on restart, anything left `running` goes back in the queue.

What happens next depends on why the call failed:

| Condition | Response |
|---|---|
| 429 with a `retryDelay`, or a per-minute quota | Sleep exactly that long and retry — this is a rate limit, not exhaustion |
| 429 with no quota detail at all | Assume a short window and wait a minute. Guessing "spent for the day" here used to cost a whole key over a burst |
| 429 on an explicit per-day quota | Set that key aside for **an hour**, not until tomorrow — see below |
| 500 / 503 | Exponential backoff, five attempts, then fail that one task and carry on |
| `finishReason: MAX_TOKENS` | Split the chunk in half and requeue both halves ahead of the rest |
| Safety block | Skip that passage with the reason recorded; the book continues |
| 401 / bad key | Park as `paused_key` until you fix it in Settings |

**A refused key is never written off for the day.** Providers describe a spent
minute and a spent day in almost the same words, and getting that wrong is
expensive in one direction only: parking a key for eighteen hours over a
per-minute burst wastes most of a free tier, while retrying an hour early costs
one failed call. So a refused key comes back after **an hour** (configurable in
Settings), and the wait only doubles — to a cap of eight hours — if it is refused
*again* on its first call back. Any single successful call resets it.

**Parked runs come back on their own.** When the worker stands down it sets a
timer for the next run that falls due, so a run parked overnight is running again
in the morning with nothing open and nobody watching. Adding or retrying a key
releases parked runs straight away rather than waiting out a timer that was only
ever a guess about when quota would return. Runs *you* paused stay paused.

Every parked run also resumes with one button on the Library page, and resuming
after three days is the same code path as resuming after a crash. Runs carry a token
ledger and an optional cap; hitting the cap parks the run rather than surprising you.

## Tests

```bash
npm test
```

150 assertions, no API key needed. `test-resume.mjs` drives the real worker against
a scratch database with injected handlers, including a simulated kill mid-run and a
real Gemini quota-error payload. `test-tags.mjs` covers the property that matters
most — an entity in two topics stays one entity — plus derivation, overrides and
filtering. `test-routing.mjs` covers the two rules that must never bend — OCR never
reaching a provider that cannot see, and Arabic never quietly landing on a model
weak at it — plus schema translation and OpenAI-style rate-limit parsing.
`test-formats.mjs` builds a PDF and an EPUB on the fly and parses them, fetches one
live article, and checks the cleaner does not mistake cited prose for a bibliography.

## Layout

```
app/                 pages and API routes
lib/
  db/schema.sql      the whole data model
  queue.ts           runs and tasks
  worker.ts          the loop, and what it does when a call fails
  providers.ts       who can answer which kind of question
  keys.ts            the key ring, and per-key quota state
  ai/client.ts       routing, key rotation, provider failover
  ai/errors.ts       the error taxonomy that makes resuming possible
  ai/openai.ts       one adapter for every non-Gemini provider
  ingest/            pdf, epub, text, web parsers, and the token cleaner
  pipeline/          extract, resolve, entry, tag, ocr, transcribe
data/                your library, database and keys — gitignored
```

## Known limits

- Free-tier keys are slow for a whole book. Set the tier in Settings so the worker
  paces itself, and give a long run a token cap the first time.
- Entity resolution is deliberately cautious: it would rather leave two entries for
  one person than fuse two people. Fix either direction under **History → Identity**;
  your decision is recorded and no later pass will undo it.
- OCR and media transcription are implemented but have not been exercised against a
  real scanned book or a long recording.
