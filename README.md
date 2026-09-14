# Corpus

A research pedia that grows with your sources, and a newsroom that watches your beat.

Feed it books, papers, articles and recordings — or point it at the feeds you
follow and let them arrive on their own. It reads each once, finds every person,
organisation, institution, event and place, and writes an encyclopedia entry for
each, with every sentence traceable to a quote at a page number. Add another
source next month and the existing entries revise themselves, and tell you what
changed.

Every morning it hands you a brief: what came in since the last one about the subjects you
watch, which outlets carried it, where they disagree, and which entries changed.
Every line in it opens the passage it rests on.

Runs on your machine. By default it listens on loopback only; Settings → LAN mode
opens it to your own devices behind a token.

## Running it

Double-click **Corpus.exe** (or the desktop shortcut). It starts the server in the
background, opens Corpus in **its own window**, and sits in the notification area —
right-click the tray icon to reopen it, open the data folder, or quit. Closing the
window leaves it running, so a long ingest keeps going; quitting from the tray
stops it.

**One window.** The window is your browser in app mode — Brave first, then Chrome,
then Edge — so it has no tabs and no address bar, but it keeps your sign-ins, the
browser extension, and the inbox's Page view. Opening Corpus again, from the tray,
the shortcut or a second double-click, brings that window to the front rather than
opening another. Links to articles open in the browser as usual. Untick *Open in its
own window* in the tray menu to go back to a browser tab. The browser can also
install it (Brave's menu → *Install Corpus*), which pins it to the taskbar.

**A Corpus on another computer.** Right-click the tray icon → *Connect to another
Corpus…*, paste the other machine's address and token from its *Settings → LAN
mode*, test, and connect. This copy then runs no server of its own and opens that
one — the laptop on the desk working from the library on the machine at home, over
the LAN or Tailscale. *Connect to… → This computer* switches back. Point the
browser extension's options at the same address.

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

## Getting around

Seven sections down the left, each holding its own pages as tabs. The rail used
to list all fifteen pages at once, which is a table of contents rather than a
navigation bar — nothing has moved or gone, it is just filed now.

| Section      | Its pages                                | What it is for                                        |
| ------------ | ---------------------------------------- | ----------------------------------------------------- |
| **Brief**    | Today · This week · Calendar             | What to read this morning, the week's record, and every date the sources mention |
| **News**     | Inbox · Stories · Feeds                  | The wire: what arrived, grouped, and what subscribes   |
| **Library**  | Sources · Quotes · Topics                | What you own, the passages you starred, how it's filed |
| **Pedia**    | Entries · Network                        | What was built from the library, one at a time or all  |
| **Write**    | —                                        | Drafts and ideas, with the citations to hand           |
| **Search**   | Library · News · Books & papers          | Three searches: your own text, the wire, the catalogues |
| **Settings** | —                                        | Keys, routing, schedules, corrections                  |

## The inbox

What the feeds pull in waits here, fetched and chunked but unread, until you say
which pieces are worth the reading. On a wide screen the item you click, or move
to with J and K, opens in a pane on the right: the text the fetch actually got, a word count, and
a verdict — enough to read, only the feed's summary, or too thin to be an
article. That is the question the paste box exists to answer, and it used to be
answerable only by keeping the item and finding out. Items carry the picture
their feed or their page declared, so the list reads at a glance.

**Search** (/) at the top of the list finds what is waiting by its headline,
its outlet, or anything in the article's own text — the last word matches while
you are still typing it, and a row found only by its text says *found in the
text*. Keeping, filing and discarding keep the search in place; Esc clears it.

**Keep, or file.** Keep reads the article and puts it in the morning: it is in
the library and in the brief. **File** (F) reads it exactly the same way — its
people get entries, it is filed under its topics and grouped with its story —
but the source is marked as filed rather than kept, and everything that builds
the brief takes only what was kept. For the piece that belongs in the pedia and
not in the morning: a French election, a book review, a beat you follow but do
not present from.

**Star** (S) sets an article aside for a closer look without deciding anything
about it. It stays in the inbox, and it is also listed on the **Starred** tab of
the Write page, beside the drafts it may end up in — with where it stands
(waiting, kept, filed or discarded), a link to read it on its own page, and Keep
and File for one still waiting. The star is on the article rather than the inbox
item, so keeping, filing or discarding it leaves it starred; a discarded
article's text is never thrown away.

**From the browser.** `extension/` is a small Brave/Chrome/Edge extension
(load it unpacked from `brave://extensions`). Click it on any article and the
page goes into the inbox as your browser sees it — signed in, paywall open —
with the full text, marked *full text*: one click sends it, and the popup
closes itself (a page too thin to be an article waits for the button instead).
`Alt+Shift+C` does the same without the popup. Sending an address that is already waiting replaces its text, which
is exactly what pasting does. What you send goes to the top of the inbox, and an
inbox open in another window shows it within a few seconds, without a reload —
including new text for the article already in the pane. See `extension/README.md`.

**The page itself.** The pane's **Page** view (V) shows the article's own page,
live, inside Corpus, instead of the text the fetch got. Sites refuse to be shown
inside another page, so it needs the browser extension, which lifts that refusal
for frames Corpus opens and nowhere else; without it the view is blank, with a
link to open the article in a tab. Clicking the extension on Corpus while an
article is open there sends that article. Brave keeps logins away from pages
shown inside another site, so a paywalled article appears signed out unless
cross-site cookies are allowed for Corpus in Shields.

**It holds still.** Deciding an item moves the pane to the next one without
the page jumping: stories keep their place in the list while the page is open,
the pane keeps one height and has the neighbouring articles loaded before you
reach them, and messages appear at the foot of the screen rather than above the
list.

## The watching calendar

Every time a brief is prepared, every date its sources mention is filed on the
calendar under **Brief → Calendar**: elections, rulings, anniversaries,
deadlines — past, present and to come. The page is a month grid: each day
carries what the sources placed on it, today is marked, and a day opens to its
lines; a **Next up** list beside it runs through what is ahead. A day the source
fixed is filed as a day. Anything vaguer is piled under **Sometime in** the
week, the month or the year the wording allows, and never more precisely than
that: "last week" against a piece published on the 9th is the week of the 4th.
Each line opens the entity and the passage; dismiss the ones that are somebody
else's to watch. The daily brief shows the dates it noticed under its own text,
and the calendar page can file the last thirty days from a library the brief
never ran over.

**A day named without a year.** News copy says "the vote on Oct. 19" and "the
Oct. 7 attack" in the same breath, and only the first is this year's. A day
given without a year is filed as this year's when the sentence treats it as
still to come; when it describes something already done and falls after the
piece was published, it cannot be this year's, and it is filed as what it is —
an **anniversary**, recurring on the grid each year and never "coming up" under
a year it never had. Wording that says "anniversary" or "years since" is an
anniversary wherever it falls. Earlier filings are re-read under the current
rule every time the calendar is filed, so a correction reaches the whole
calendar, not only dates noticed afterwards.

## Writing beside the library

**Write** keeps drafts and, beside each, a shelf of the quotes and sources you
mean to use in it — gathered rather than generated, and copied rather than
linked, so nothing on the shelf can evaporate when a source is re-read. Three
ways onto the shelf: search the library from the pane and keep a hit; **log a
quote** by pasting it and tying it to a citation — pick the source from your
library, or type the reference for a book you read elsewhere; or, while reading
a source, select a passage and click **Send to Write** on the card that
appears. That one lands cited to the source and the place, and linked to the
passage so it can be checked. Every line on the shelf can be inserted as a block
quote or turned into a numbered reference where the cursor is.

**Cite from library**, in the editor's toolbar, searches everything in the
library from inside the draft — sources by title, author and outlet, and the
full text of every source, articles you starred included — and cites what you
choose where the cursor was: a whole source, or a passage as the sentence it
was found by, which can also be set into the draft as a block quote. It finds
passages the pane's search cannot, since that one reads only what extraction
tied to a person or an institution. Like the rest of the desk it matches words;
no model is involved. The toolbar stays pinned to the top of the window while a
long draft scrolls under it.

## Two laptops, one library

**Settings → The other laptop** syncs Corpus between two machines over the LAN
or Tailscale. It is a copy, not a merge — the point is continuity, not
collaboration: work on either, and before you switch, sync towards the machine
you are about to use.

- **Pull** makes this library a copy of the other one. This one is backed up
  first, whole, under `data/backups` (the last three are kept).
- **Push** makes the other one a copy of this. Implemented as "ask it to pull
  from me", so there is one code path.

Both machines need **LAN mode** on (the card above it in Settings, which shows
the addresses and the token to paste into the other side). The database goes
across as a consistent snapshot while the other side keeps running; source
files, covers and portraits follow. `config.json` — keys, routing, the LAN
token — stays per machine. If the library on the receiving side has changed
since the last sync, the page says so and asks before replacing it.

## Using more than one service

There are three services, and each is here for a reason: **Gemini** reads, **Claude**
writes, and **Ollama** on this machine answers anything you would rather not send
anywhere. **Settings → Who does what** decides which handles which stage.

The one worth thinking about is **Writing entries** — it is where prose judgement and
citation discipline show, and where a stronger model is worth paying for. **Reading
passages** is around 88% of all tokens and wants the cheap, reliable one.

Two rules the router enforces whatever you configure:

- **Capability wins.** Scanned-page OCR, transcription and entity embeddings only go
  to a provider that can actually do them — which means Gemini, and is why it stays
  the backbone rather than being replaced.
- **Nothing stops for one service being spent.** Keys rotate within a provider, then
  the call falls through to Gemini, and only when nothing can answer does the run
  park — until the first key *anywhere* returns.
- **A refusal is charged to the model that answered.** Gemini's free allowance is
  per model and shared by every key you own, so "out of quota for the day" means
  the model is spent, not the key: the ring sets that model aside for an hour and
  the same key asks the next one down. A key is set aside only when there is
  nothing left to ask it. Embeddings have no substitute, so a spent embedding
  model parks that task alone and leaves every key as it was.

Extra keys multiply your quota on Gemini, whose limits are per project. Anthropic
bills the account, so a second key there is a second label on one bill, and Ollama
has no quota at all — any text works as its key. Settings says so under each.

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
| Extract | 1 call per ~3,500 tokens | Entities, relations and dated events, each with a verbatim quote, who is asserting it, and what kind of claim it is |
| Resolve | cheap, mostly free | "Nasser" and "Gamal Abdel Nasser" become one person. Exact matches are free; only genuinely ambiguous pairs reach the model, batched ten at a time |
| Sweep | free | Finds the appearances extraction walked past, by matching the names it already knows |
| Entries | 1 call per entity, 2 for a large one | The writer sees all of a subject's evidence at once and plans the entry before writing it. Only for entities above the mention threshold, or ones you starred |
| Verify | 1 call per entry | Reads every sentence back against its own citations and flags what they do not carry |

A source is told when it was published, by whom and from where, and resolves its
own relative dates against that: "March of this year", in a piece filed today, is
stored as 2026-03. Nothing later in the pipeline could recover that.

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

Regenerating is a rewrite from all of the evidence, with the previous version in
front of the writer so that what still holds is kept. It returns the revised text,
a changelog, and any contradictions it noticed — a record of how the picture
shifted when each book arrived, visible under **History**.

**An entry is written whole, from a plan.** The writer is given every passage, the
dated events and the recorded relations, and decides the shape of the entry before
writing a word of it: a spine of time for a person or an event, of theme for an
institution or a place. It used to be assembled forty quotes at a time, each pass
bolting new material onto the last, and the result read as an index — a man's
schooling, a lawsuit and a shipping contract in one paragraph because three quotes
came from one book. Facts now share a paragraph only when they share a subject, a
period, or a connection the sources actually state.

**Stale entries are rewritten on their own.** Every ingest ends by queueing the
entries its new evidence affected, and the worker sweeps for anything else the
moment its queue is clear — so staleness caused by something other than an ingest
(a merge you made by hand, a source you removed, a run interrupted before its
planning step) is picked up too rather than waiting for the next book.

**Staleness is about evidence, and nothing else.** There was once a second rule:
an entry citing under 85% of its passages counted as out of date. It could not be
satisfied — the writer is told, correctly, that it is not scored on how much
evidence it uses — so the same two dozen entries were rewritten on every quiet
minute, for weeks, and that one rule accounted for most of the tokens this
application had ever spent. Coverage is now reported on the Library and queues
nothing, and an entry rewritten three times against unchanged evidence is not
rewritten a fourth.

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

## Watching a beat

**Feeds** takes an address — an outlet's politics page, a committee, a wire, a
YouTube channel — or a phrase to watch, which becomes a news-query feed. Each feed
carries its own interval and a daily cap, because a feed that suddenly republishes
its archive is the failure worth guarding against and it costs tokens per item. A
feed added today reads what comes next rather than what it already holds, unless
you say otherwise.

**A page with no feed** can be followed too: paste its address and Corpus reads
the page's links the way you would scan it — the ones that read as headlines, on
the same site, outside the navigation — and every link that was not there last
time arrives in the inbox like anything a feed brought in. If the page
advertises a feed in its head, that is followed instead, since a real feed
carries dates a scrape never will. For a noisy page, give a link pattern: part
of the address every article shares, such as `ArticleID/`, or a `/regex/`.
What the page holds when it is added is recorded as already seen, so following
a page does not read its whole front page, unless you ask for that.

Polling is ordinary queue work, so a closed laptop picks up where it left off, and
it comes ahead of the reading: a feed that falls due while a book is being chunked
and read is checked on the worker's next pass, not once the book is done, and the
articles it finds are fetched into the inbox before the reading carries on — a
fetch costs no tokens, and the inbox is what is waiting on it. An
item already in the library — the same story from a second feed, matched on its
address with the tracking parameters stripped — is recorded and not fetched again.

**Stories** group accounts of one development: six outlets on one wire report is
one story and six sources. Grouping needs two signals to agree, headline overlap
and shared entities inside three days, and is one click from corrected — rename a
story, pin it, or say "not this story" of an account.

**The watchlist** is the shortlist the brief is built around: a person, an
institution, a topic, or a phrase. It is changed at the top of the brief, under
*Watching*: the × on any of them stops following it, and *Follow a phrase…*
adds one. People and institutions are also followed from their pedia page with
**Watch**. Topics are added by Corpus itself once they come up across several
outlets; removing one of those says no for good, so it is not suggested again.

**The brief** is assembled from the database — which passages arrived, about whom,
from which outlet, at what time — and only then written up, under the same rule as
an entry: every claim carries a marker, and a marker the writer was not given is
stripped. It says when only one outlet has something, and never merges two
outlets' numbers into one figure.

**Expand**, beside any heading of the brief that cites something, writes a
closer look at that topic under its section: where it stands, how it got there
in order, who is saying what, and where the reporting disagrees. It is written
from more of the library than the brief could use — the passages cited under
the heading, everything else read from those same articles, and earlier
coverage from the last two months that shares the subject — under the same
citation rule. Earlier coverage is found by SQL: an article counts when it
shares a subject that is rare in the library, or belongs to the same running
story, so a subject every article mentions pulls nothing in. Expanding again
writes it again; *Hide expanded* folds it away.

## Tests

```bash
npm test
```

1,420 assertions across 25 suites, no API key needed. `test-resume.mjs` drives the real worker against
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
  components/sections.ts  what the rail lists, and what is folded under each
public/fonts/        Amiri, subsetted to Arabic — the pedia is half Arabic
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
  pipeline/          extract, resolve, entry, verify, tag, ocr, transcribe, poll, brief
  markers.ts         the one citation grammar every reader of an entry agrees on
  sentences.ts       sentence splitting that knows "U.S." is not the end of one
  feeds.ts           feeds, their items, and what has already been read
  stories.ts         grouping accounts of one development
  watchlist.ts       what you follow
  brief.ts           the query the daily brief is made of
  net.ts             outbound fetching that refuses private addresses
  lan.ts             the token that guards LAN mode
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
- Story grouping reads headlines and entities, not text. Two rounds of the same
  negotiation a week apart are two stories, which is usually what you want and
  occasionally is not.
- The brief covers what your feeds brought in. It cannot tell you about something
  that no feed you follow reported.
- Claude is metered rather than rationed. Gemini refuses you when the day's
  allowance is gone; Anthropic bills you instead, so the entry stage is the one
  place in the app where a runaway loop costs money rather than time.
