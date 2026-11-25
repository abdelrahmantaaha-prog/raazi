# Raazi · الرازي

**A research encyclopedia that writes itself from your sources, and a newsroom that watches your beat.**

Feed Raazi books, papers, articles and recordings, or point it at the feeds you
follow. It reads each source once, finds every person, organisation, event and
place in it, and writes an encyclopedia entry for each, with every sentence
traceable to a quote at a page number. Add another source next month and the
affected entries revise themselves and tell you what changed.

Every morning it writes you a brief: what came in about the subjects you watch,
which outlets carried it, where they disagree, and which entries changed. Every
line opens the passage it rests on.

It runs on your own machine and listens on loopback only unless you turn on LAN
mode.

## Features

- **Pedia**: entries for people, institutions, events and places, written from a
  plan over all of a subject's evidence, checked sentence by sentence against
  their citations, and rewritten when new evidence arrives. Where sources
  disagree, both claims are kept.
- **Library**: PDF (with OCR for scanned pages), EPUB, web articles, Markdown,
  audio and video. Endnotes, running heads and page furniture are stripped
  locally before anything is sent to a model.
- **News**: RSS/Atom feeds, YouTube channels, news queries, and pages with no
  feed. An inbox to keep, file or discard items, which learns from what you
  discard. Accounts of one development are grouped into stories.
- **Daily brief**: built from the database first, then written up with a
  citation on every claim, plus a calendar of every date the sources mention.
- **Write**: a drafting desk with a shelf of quotes and sources, library-wide
  citation search, and export to Word with footnotes.
- **Search**: keyword search over your library and the news, search by meaning
  (embeddings), and catalogue search for books and papers.
- **Bilingual reading**: pair a book with its translation and read them side by
  side, aligned without a model.
- **Disciplines**: separate libraries for separate subjects, each in its own
  database.
- **Resumable by design**: every unit of work is a queued task, so a run that
  hits a quota or a crash picks up where it stopped.

## Requirements

- Windows 10/11 for the tray launcher (the web app itself runs anywhere Node does)
- Node.js 20 or newer
- A Google Gemini API key ([free keys](https://aistudio.google.com/apikey)).
  Anthropic (an API key, or a signed-in Claude Code install) and a local
  [Ollama](https://ollama.com) are optional extra providers.

## Getting started

```bash
npm install
npm run build
npm run build:exe   # optional: the Windows tray launcher, Raazi.exe
```

Then either double-click **Raazi.exe**, or run it from a terminal:

```bash
npm run dev         # development server
npm start           # production build
```

Open <http://localhost:5400> and add your Gemini key under **Settings**. You can
add several keys: when one runs out of quota the work moves to the next, and
**Settings → Who does what** decides which provider handles each stage.

`build:exe` compiles a small launcher with the C# compiler that ships with
Windows, with nothing extra to install. It starts the server in the background,
opens Raazi in its own app window (Brave, Chrome or Edge in app mode), and sits
in the notification area. From its tray menu you can start Raazi with Windows or
connect to a Raazi running on another computer.

## Other pieces

| Folder | What it is |
| --- | --- |
| [`extension/`](extension/README.md) | Brave/Chrome/Edge extension: sends the article you are reading (signed in, paywall open) to the inbox, and lets the inbox show the original page |
| [`android/`](android/README.md) | Android app that finds Raazi on your network and opens it, with sign-in by QR code |
| `launcher/` | The Windows tray launcher and its signed auto-updater |
| `research/` | Public-record lookup tools (Wikidata, court records, ship registers) that Claude can call while checking a claim, served over MCP |

## Your data

Everything lives in `data/` (gitignored): the SQLite database (`better-sqlite3`), source files,
covers, settings and API keys. Keys are stored server-side in
`data/config.json` so the background worker can keep going with no tab open.
`GEMINI_API_KEY` in `.env.local` overrides the stored one.

Only the passages being read are sent to the model you route them to. With
Ollama, nothing leaves the machine.

**LAN mode** (Settings) opens Raazi to your own devices behind a token, which
also enables the phone app and syncing a library between two computers.

## Development

```bash
npm test            # unit and integration suites, no API key needed
```

```
app/          Next.js pages and API routes
lib/          the engine: queue, worker, providers, ingest, pipeline, feeds, brief
lib/db/schema.sql   the whole data model
launcher/     C# tray launcher and updater
extension/    browser extension
android/      phone app
scripts/      tests, evaluation and release tooling
docs/         design notes
```

[`docs/DESIGN.md`](docs/DESIGN.md) explains how each part works and why it was
built that way: the inbox and curator, citations, retry and quota handling,
story grouping, disciplines, sync between computers, and the updater.

## Known limits

- Free-tier keys are slow for a whole book. Set your tier in Settings and give
  a long first run a token cap.
- Entity resolution is cautious: it would rather leave two entries for one
  person than merge two people. Either can be corrected by hand.
- OCR and media transcription have not been tested on a real scanned book or a
  long recording yet.
- The brief only covers what your feeds brought in.

## Name

Raazi was called Corpus until version 0.10. Some internal identifiers keep the
old name on purpose (`data/corpus.db`, the `corpus_token` cookie, the
`x-corpus-token` header, `CORPUS_*` variables, the `com.corpus.helper` Android
package), because existing libraries and signed-in devices depend on them.
