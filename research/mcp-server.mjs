#!/usr/bin/env node
/**
 * Corpus's research tools, offered to Claude during a web check.
 *
 * Claude Code starts this program for the length of one check and talks to it
 * over stdin and stdout (the Model Context Protocol, newline-delimited
 * JSON-RPC). Claude reads each claim, picks whichever of these tools fits it —
 * Wikidata for a role and its dates, court records for a lawsuit, a ship
 * register for a vessel named in a sanctions story — and calls it. Every
 * answer carries the addresses it came from, and Corpus only shows a source
 * whose address one of these tools or a web search actually returned.
 *
 * Plain JavaScript with no dependencies, so it runs from a checkout and from
 * the packaged copy alike. Keys arrive in CORPUS_RESEARCH_KEYS; a tool whose
 * key is missing is simply not offered.
 *
 * What is deliberately not here: data-broker people search (home addresses,
 * phone numbers, relatives) and anything that logs in to a platform or gets
 * round its blocks. People are researched through public records of public
 * roles only.
 */
import readline from "node:readline";
import { findShippingCodes, CONTAINER_OWNERS, CARRIER_TRACKING, AWB_AIRLINES, containerValid, imoValid, awbValid } from "./shipping-codes.mjs";

const KEYS = (() => {
  try {
    return JSON.parse(process.env.CORPUS_RESEARCH_KEYS || "{}");
  } catch {
    return {};
  }
})();

const UA = "Corpus research tool (a personal research library)";
const TIMEOUT_MS = 25_000;
const MAX_TEXT = 14_000;

async function get(url, { headers = {}, json = true, method = "GET", body, timeoutMs = TIMEOUT_MS } = {}) {
  const res = await fetch(url, {
    method,
    body,
    headers: { "user-agent": UA, accept: json ? "application/json" : "text/html,*/*", ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${new URL(url).hostname} answered ${res.status}: ${text.slice(0, 200)}`);
  return json ? JSON.parse(text) : text;
}

const q = encodeURIComponent;
const strip = (html) =>
  String(html ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .trim();
const clip = (s, n = 400) => (s && s.length > n ? `${s.slice(0, n)}…` : s);

// ---------------------------------------------------------------------------
// Reference
// ---------------------------------------------------------------------------

/** The Wikidata properties worth knowing about a person, organisation or place. */
const WD_PROPS = {
  P31: "instance of", P106: "occupation", P27: "citizenship", P569: "born", P570: "died", P19: "place of birth",
  P39: "position held", P108: "employer", P102: "political party", P463: "member of", P69: "educated at",
  P571: "founded", P576: "dissolved", P159: "headquarters", P17: "country", P112: "founded by",
  P169: "chief executive", P488: "chair", P127: "owned by", P749: "parent organisation", P355: "subsidiary",
  P856: "official website", P2002: "X (Twitter) username", P2397: "YouTube channel id", P3789: "Telegram username",
  P12361: "Bluesky handle", P4033: "Mastodon address", P2013: "Facebook username", P2003: "Instagram username",
  P1278: "LEI code", P458: "IMO ship number", P587: "MMSI", P8047: "flag (ship)",
};

async function wikidata({ query, id }) {
  let qid = id && /^Q\d+$/i.test(id) ? id.toUpperCase() : null;
  let candidates = [];
  if (!qid) {
    const found = await get(
      `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${q(query ?? "")}&language=en&uselang=en&format=json&limit=5`
    );
    candidates = (found.search ?? []).map((s) => ({ id: s.id, label: s.label, description: s.description }));
    qid = candidates[0]?.id;
    if (!qid) return { found: 0, note: "Nothing on Wikidata by that name." };
  }
  const ent = (await get(
    `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${qid}&props=labels|descriptions|claims|sitelinks/urls&languages=en|ar&format=json`
  )).entities[qid];

  const facts = [];
  const refs = new Set();
  for (const [p, name] of Object.entries(WD_PROPS)) {
    for (const c of ent.claims?.[p] ?? []) {
      const v = c.mainsnak?.datavalue?.value;
      if (v === undefined) continue;
      const fact = { property: name };
      if (v && typeof v === "object" && v.id) {
        fact.item = v.id;
        refs.add(v.id);
      } else if (v && typeof v === "object" && v.time) fact.value = v.time.replace(/^\+/, "").slice(0, 10);
      else if (v && typeof v === "object" && v.amount) fact.value = v.amount;
      else fact.value = String(v);
      const start = c.qualifiers?.P580?.[0]?.datavalue?.value?.time;
      const end = c.qualifiers?.P582?.[0]?.datavalue?.value?.time;
      if (start) fact.start = start.replace(/^\+/, "").slice(0, 10);
      if (end) fact.end = end.replace(/^\+/, "").slice(0, 10);
      if (c.references?.length) fact.referenced = true;
      facts.push(fact);
    }
  }
  // Names for the items the facts point at, in one call.
  const labels = {};
  const ids = [...refs].slice(0, 50);
  if (ids.length) {
    const named = await get(
      `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${ids.join("|")}&props=labels&languages=en&format=json`
    );
    for (const [k, e] of Object.entries(named.entities ?? {})) labels[k] = e.labels?.en?.value ?? k;
  }
  for (const f of facts) if (f.item) f.value = labels[f.item] ?? f.item;

  return {
    id: qid,
    url: `https://www.wikidata.org/wiki/${qid}`,
    label: ent.labels?.en?.value ?? ent.labels?.ar?.value,
    description: ent.descriptions?.en?.value,
    wikipedia: ent.sitelinks?.enwiki?.url ?? ent.sitelinks?.arwiki?.url,
    facts,
    otherMatches: candidates.slice(1),
  };
}

let gdeltLast = 0;
async function newsArchive({ query, from, to, max = 20 }) {
  // GDELT allows one request every five seconds.
  const wait = gdeltLast + 5500 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  gdeltLast = Date.now();
  const d = (s) => (s ? `${String(s).replace(/\D/g, "").padEnd(8, "0").slice(0, 8)}000000` : "");
  let url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${q(query)}&mode=artlist&format=json&sort=hybridrel&maxrecords=${Math.min(75, Number(max) || 20)}`;
  if (from) url += `&startdatetime=${d(from)}`;
  if (to) url += `&enddatetime=${d(to)}`;
  const fetchText = () => get(url, { json: false, timeoutMs: 60_000 });
  // GDELT's "one request every five seconds" is not the whole rule: on 3 Oct 2026
  // it refused a request sixty seconds after the last and took one fifteen
  // seconds after that. A refusal or a dropped connection is GDELT under load,
  // so wait and ask again, twice, then say it is busy rather than fail the check.
  let text;
  for (const pause of [0, 10_000, 20_000]) {
    if (pause) {
      await new Promise((r) => setTimeout(r, pause));
      gdeltLast = Date.now();
    }
    try {
      text = await fetchText();
      break;
    } catch (err) {
      if (!/ 429|fetch failed|aborted|timeout/i.test(String(err?.message))) throw err;
    }
  }
  if (text === undefined) return { found: 0, note: "GDELT is busy and refused three times; use the other tools or a web search." };
  if (!text.trim().startsWith("{")) return { found: 0, note: clip(text, 200) };
  const data = JSON.parse(text);
  return {
    found: data.articles?.length ?? 0,
    articles: (data.articles ?? []).map((a) => ({
      url: a.url,
      title: a.title,
      outlet: a.domain,
      date: a.seendate?.slice(0, 8),
      language: a.language,
      country: a.sourcecountry,
    })),
  };
}

async function scholarly({ query, max = 8 }) {
  const data = await get(`https://api.openalex.org/works?search=${q(query)}&per-page=${Math.min(25, Number(max) || 8)}`);
  return {
    found: data.meta?.count ?? 0,
    works: (data.results ?? []).map((w) => ({
      title: w.title,
      year: w.publication_year,
      url: w.doi || w.primary_location?.landing_page_url || w.id,
      venue: w.primary_location?.source?.display_name,
      authors: (w.authorships ?? []).slice(0, 6).map((a) => a.author?.display_name),
      citedBy: w.cited_by_count,
      openAccess: w.open_access?.oa_url,
    })),
  };
}

async function wayback({ url, around }) {
  const snaps = await get(
    `https://web.archive.org/cdx/search/cdx?url=${q(url)}&output=json&fl=timestamp,original,statuscode&filter=statuscode:200&collapse=digest&limit=-15`
  ).catch(() => []);
  const rows = Array.isArray(snaps) ? snaps.slice(1) : [];
  let closest = null;
  if (around) {
    const near = await get(`https://archive.org/wayback/available?url=${q(url)}&timestamp=${String(around).replace(/\D/g, "")}`);
    closest = near.archived_snapshots?.closest?.url ?? null;
  }
  return {
    snapshots: rows.map(([ts, original]) => ({
      date: `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`,
      url: `https://web.archive.org/web/${ts}/${original}`,
    })),
    closest,
    note: rows.length ? "Open a snapshot with the web fetch tool to read it." : "No archived copies found.",
  };
}

// ---------------------------------------------------------------------------
// Public records: people in public roles, companies, courts
// ---------------------------------------------------------------------------

async function sanctions({ name, max = 8 }) {
  const data = await get(`https://api.opensanctions.org/search/default?q=${q(name)}&limit=${Math.min(20, Number(max) || 8)}`, {
    headers: { authorization: `ApiKey ${KEYS.opensanctions}` },
  });
  return {
    found: data.total?.value ?? data.results?.length ?? 0,
    results: (data.results ?? []).map((r) => ({
      name: r.caption,
      kind: r.schema,
      url: `https://www.opensanctions.org/entities/${r.id}/`,
      topics: r.properties?.topics,
      countries: r.properties?.country ?? r.properties?.nationality,
      positions: (r.properties?.position ?? []).slice(0, 6),
      lists: (r.datasets ?? []).slice(0, 8),
    })),
  };
}

async function companies({ name, officer, jurisdiction }) {
  const token = `api_token=${q(KEYS.opencorporates)}`;
  if (officer) {
    const data = await get(`https://api.opencorporates.com/v0.4/officers/search?q=${q(officer)}&${token}`);
    return {
      officers: (data.results?.officers ?? []).slice(0, 15).map(({ officer: o }) => ({
        name: o.name,
        role: o.position,
        from: o.start_date,
        to: o.end_date,
        company: o.company?.name,
        jurisdiction: o.company?.jurisdiction_code,
        url: o.opencorporates_url,
      })),
    };
  }
  const data = await get(
    `https://api.opencorporates.com/v0.4/companies/search?q=${q(name ?? "")}${jurisdiction ? `&jurisdiction_code=${q(jurisdiction)}` : ""}&${token}`
  );
  return {
    companies: (data.results?.companies ?? []).slice(0, 15).map(({ company: c }) => ({
      name: c.name,
      number: c.company_number,
      jurisdiction: c.jurisdiction_code,
      status: c.current_status,
      incorporated: c.incorporation_date,
      dissolved: c.dissolution_date,
      address: c.registered_address_in_full,
      url: c.opencorporates_url,
    })),
  };
}

async function secFilings({ query, forms, from, to }) {
  let url = `https://efts.sec.gov/LATEST/search-index?q=${q(`"${String(query).replace(/"/g, "")}"`)}`;
  if (forms) url += `&forms=${q(forms)}`;
  if (from || to) url += `&dateRange=custom&startdt=${from ?? "2001-01-01"}&enddt=${to ?? new Date().toISOString().slice(0, 10)}`;
  const data = await get(url);
  return {
    found: data.hits?.total?.value ?? 0,
    filings: (data.hits?.hits ?? []).slice(0, 15).map((h) => {
      const [adsh, file] = String(h._id).split(":");
      const cik = String(h._source?.ciks?.[0] ?? "").replace(/^0+/, "");
      return {
        filers: h._source?.display_names,
        form: h._source?.form,
        date: h._source?.file_date,
        url: cik && file ? `https://www.sec.gov/Archives/edgar/data/${cik}/${adsh.replace(/-/g, "")}/${file}` : undefined,
      };
    }),
  };
}

async function courtRecords({ query, kind = "opinions" }) {
  const type = kind === "dockets" ? "r" : "o";
  const data = await get(`https://www.courtlistener.com/api/rest/v4/search/?q=${q(query)}&type=${type}`, {
    headers: KEYS.courtlistener ? { authorization: `Token ${KEYS.courtlistener}` } : {},
  });
  return {
    found: data.count ?? 0,
    cases: (data.results ?? []).slice(0, 15).map((r) => ({
      case: r.caseName,
      court: r.court,
      date: r.dateFiled,
      docket: r.docketNumber,
      url: r.absolute_url ? `https://www.courtlistener.com${r.absolute_url}` : undefined,
      excerpt: clip(strip(r.opinions?.[0]?.snippet ?? r.snippet ?? ""), 300),
    })),
  };
}

// ---------------------------------------------------------------------------
// Social media: public accounts, through each platform's public route
// ---------------------------------------------------------------------------

async function bluesky({ handle, max = 20 }) {
  const actor = String(handle).replace(/^@/, "");
  const [profile, feed] = await Promise.all([
    get(`https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${q(actor)}`),
    get(`https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${q(actor)}&limit=${Math.min(50, Number(max) || 20)}&filter=posts_no_replies`),
  ]);
  return {
    account: { name: profile.displayName, handle: profile.handle, url: `https://bsky.app/profile/${profile.handle}`, about: clip(profile.description, 300) },
    posts: (feed.feed ?? []).map(({ post }) => ({
      date: post.record?.createdAt,
      text: clip(post.record?.text, 600),
      url: `https://bsky.app/profile/${post.author?.handle}/post/${String(post.uri).split("/").pop()}`,
    })),
  };
}

async function mastodon({ account, max = 20 }) {
  const [user, host] = String(account).replace(/^@/, "").split("@");
  if (!user || !host) throw new Error("Give the account as name@server, e.g. Gargron@mastodon.social.");
  const acct = await get(`https://${host}/api/v1/accounts/lookup?acct=${q(user)}`);
  const statuses = await get(`https://${host}/api/v1/accounts/${acct.id}/statuses?limit=${Math.min(40, Number(max) || 20)}&exclude_replies=true`);
  return {
    account: { name: acct.display_name, url: acct.url, about: clip(strip(acct.note), 300) },
    posts: statuses.map((s) =>
      s.reblog
        ? { date: s.created_at, reposted: s.reblog.account?.acct, text: clip(strip(s.reblog.content), 600), url: s.reblog.url }
        : { date: s.created_at, text: clip(strip(s.content), 600), url: s.url }
    ),
  };
}

async function telegram({ channel, query }) {
  const name = String(channel).replace(/^@|^https?:\/\/t\.me\/(s\/)?/g, "").split(/[/?]/)[0];
  const html = await get(`https://t.me/s/${q(name)}${query ? `?q=${q(query)}` : ""}`, { json: false });
  const title = strip(/<meta property="og:title" content="([^"]*)"/.exec(html)?.[1] ?? name);
  const posts = [];
  for (const block of html.split('class="tgme_widget_message_wrap').slice(1)) {
    const post = /data-post="([^"]+)"/.exec(block)?.[1];
    if (!post) continue;
    const text = /class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(block)?.[1];
    const date = /<time datetime="([^"]+)"/.exec(block)?.[1];
    posts.push({ date, text: clip(strip(text), 600), url: `https://t.me/${post}` });
  }
  return {
    channel: { name: title, url: `https://t.me/${name}` },
    posts: posts.reverse(),
    note: posts.length ? undefined : "No public posts — the channel may be private, or not allow previews.",
  };
}

async function youtube({ query, channelId, from, max = 10 }) {
  let url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&maxResults=${Math.min(25, Number(max) || 10)}&key=${q(KEYS.youtube)}`;
  if (query) url += `&q=${q(query)}`;
  if (channelId) url += `&channelId=${q(channelId)}&order=date`;
  if (from) url += `&publishedAfter=${q(new Date(from).toISOString())}`;
  const data = await get(url);
  return {
    videos: (data.items ?? []).map((v) => ({
      title: strip(v.snippet?.title),
      channel: v.snippet?.channelTitle,
      date: v.snippet?.publishedAt,
      description: clip(v.snippet?.description, 300),
      url: `https://www.youtube.com/watch?v=${v.id?.videoId}`,
    })),
  };
}

let redditToken = null;
async function reddit({ query, subreddit, max = 15 }) {
  if (!redditToken || redditToken.expires < Date.now()) {
    const [id, secret] = String(KEYS.reddit ?? "").split(":");
    const t = await get("https://www.reddit.com/api/v1/access_token", {
      method: "POST",
      body: "grant_type=client_credentials",
      headers: {
        authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
    });
    redditToken = { value: t.access_token, expires: Date.now() + (t.expires_in - 60) * 1000 };
  }
  const where = subreddit ? `/r/${q(String(subreddit).replace(/^r\//, ""))}/search` : "/search";
  const data = await get(
    `https://oauth.reddit.com${where}?q=${q(query)}&limit=${Math.min(50, Number(max) || 15)}&sort=relevance${subreddit ? "&restrict_sr=1" : ""}`,
    { headers: { authorization: `Bearer ${redditToken.value}` } }
  );
  return {
    posts: (data.data?.children ?? []).map(({ data: p }) => ({
      title: p.title,
      subreddit: p.subreddit_name_prefixed,
      date: new Date(p.created_utc * 1000).toISOString(),
      text: clip(p.selftext, 400),
      link: p.url_overridden_by_dest,
      url: `https://www.reddit.com${p.permalink}`,
    })),
  };
}

// ---------------------------------------------------------------------------
// Logistics
// ---------------------------------------------------------------------------

async function vessel({ imo, name, mmsi }) {
  const out = {};
  if (!imo && !mmsi && name) {
    const html = await get(`https://www.vesselfinder.com/vessels?name=${q(name)}`, { json: false });
    const hits = [
      ...html.matchAll(/href="\/vessels\/details\/(\d+)"[\s\S]{0,1500}?title="([^"]*)"[\s\S]{0,300}?class="slna">([^<]+)<\/div>\s*<div class="slty">([^<]*)/g),
    ].slice(0, 10);
    out.matches = hits.map((m) => ({
      name: strip(m[3]),
      type: strip(m[4]),
      flag: strip(m[2]),
      url: `https://www.vesselfinder.com/vessels/details/${m[1]}`,
    }));
    if (!out.matches.length) out.note = "No ship by that name on VesselFinder.";
  }
  const id = imo ? String(imo).replace(/\D/g, "") : mmsi ? String(mmsi).replace(/\D/g, "") : null;
  if (imo && !imoValid(id)) out.warning = "That IMO number's check digit does not add up — it may be misread.";
  if (id) {
    const page = `https://www.vesselfinder.com/vessels/details/${id}`;
    const html = await get(page, { json: false }).catch(() => "");
    const details = {};
    for (const m of html.matchAll(/<td class="tp[cx]1">([^<]+)<\/td><td class="tp[cx]2">([^<]*)/g)) {
      const v = strip(m[2]);
      if (v && v !== "-") details[strip(m[1])] = v;
    }
    out.register = {
      url: page,
      summary: strip(/<meta name="description" content="([^"]*)"/.exec(html)?.[1] ?? ""),
      details,
    };
  }
  if (KEYS.gfw && (id || name)) {
    const data = await get(
      `https://gateway.api.globalfishingwatch.org/v3/vessels/search?query=${q(id ?? name)}&datasets[0]=public-global-vessel-identity:latest&includes[0]=OWNERSHIP&includes[1]=AUTHORIZATIONS`,
      { headers: { authorization: `Bearer ${KEYS.gfw}` } }
    ).catch((e) => ({ error: String(e.message ?? e) }));
    out.history = data.error
      ? { error: data.error }
      : (data.entries ?? []).slice(0, 3).map((e) => ({
          names: (e.registryInfo ?? []).map((r) => ({ name: r.shipname, flag: r.flag, from: r.transmissionDateFrom, to: r.transmissionDateTo })),
          owners: (e.registryOwners ?? []).map((o) => ({ owner: o.name, flag: o.flag, from: o.dateFrom, to: o.dateTo })),
          seenAs: (e.selfReportedInfo ?? []).slice(0, 6).map((s) => ({ name: s.shipname, flag: s.flag, mmsi: s.ssvid, from: s.transmissionDateFrom, to: s.transmissionDateTo })),
          url: `https://globalfishingwatch.org/map/vessel/${e.selfReportedInfo?.[0]?.id ?? ""}`,
        }));
  }
  return out;
}

function trackShipment({ code }) {
  const raw = String(code).toUpperCase().replace(/[\s-]/g, "");
  if (/^[A-Z]{3}[UJZ]\d{7}$/.test(raw)) {
    const carrier = CONTAINER_OWNERS[raw.slice(0, 4)];
    const line = carrier?.split(" (")[0];
    return {
      kind: "container",
      code: raw,
      valid: containerValid(raw),
      carrier: carrier ?? "a leasing company or a line not on Corpus's list — the owner code alone does not say who is moving it",
      tracking: line === "Maersk" ? `${CARRIER_TRACKING.Maersk}${raw}` : CARRIER_TRACKING[line],
      note: "Shipping lines' tracking pages need a browser; this cannot read them for you. The link is for the researcher.",
    };
  }
  if (/^\d{11}$/.test(raw)) {
    return {
      kind: "air waybill",
      code: `${raw.slice(0, 3)}-${raw.slice(3)}`,
      valid: awbValid(raw),
      airline: AWB_AIRLINES[raw.slice(0, 3)] ?? "unknown airline prefix",
      note: "Look it up on the airline's cargo tracking page.",
    };
  }
  if (/^\d{7}$/.test(raw)) return { kind: "ship (IMO)", code: raw, valid: imoValid(raw), note: "Use the vessel tool." };
  const carrier = CONTAINER_OWNERS[raw.slice(0, 4)];
  return {
    kind: "bill of lading (probably)",
    code: raw,
    carrier: carrier ?? "unknown",
    tracking: carrier ? CARRIER_TRACKING[carrier.split(" (")[0]] : undefined,
    note: "Bills of lading carry no check digit, so this cannot be confirmed as one.",
  };
}

// ---------------------------------------------------------------------------
// The protocol
// ---------------------------------------------------------------------------

const str = (description) => ({ type: "string", description });
const int = (description) => ({ type: "integer", description });

const TOOLS = [
  {
    name: "wikidata",
    description:
      "Structured facts about a person, organisation, place or ship from Wikidata: positions held with start and end dates, employers, party, citizenship, founding dates, owners, official website and official social-media accounts. Best first stop for roles, titles and dates.",
    schema: { query: str("A name to look up."), id: str("A Wikidata id like Q133308, if known.") },
    run: wikidata,
  },
  {
    name: "news_archive",
    description:
      "Search worldwide news coverage (GDELT, many languages, roughly the last three months by default; give from/to for earlier). For when, where and by whom an event was reported. Slow: one search every five seconds.",
    schema: { query: str('Search words; put exact phrases in quotes, e.g. "Rafael Grossi" Iran.'), from: str("YYYY-MM-DD"), to: str("YYYY-MM-DD"), max: int("Up to 75.") },
    required: ["query"],
    run: newsArchive,
  },
  {
    name: "scholarly",
    description: "Search academic papers and books (OpenAlex): title, year, venue, authors, DOI link. For claims about studies, findings and academics.",
    schema: { query: str("Search words."), max: int("Up to 25.") },
    required: ["query"],
    run: scholarly,
  },
  {
    name: "wayback",
    description:
      "Archived copies of a web page from the Internet Archive — to read a page as it was on a date, or one since changed or deleted (including a public social-media post).",
    schema: { url: str("The page address."), around: str("A date, YYYY-MM-DD, to find the copy nearest to.") },
    required: ["url"],
    run: wayback,
  },
  {
    name: "sanctions",
    key: "opensanctions",
    description:
      "Sanctions lists, politically exposed persons and criminal watchlists worldwide (OpenSanctions): which lists a person, company or ship is on, with positions held. Public figures and organisations only.",
    schema: { name: str("A person, company or ship name."), max: int("Up to 20.") },
    required: ["name"],
    run: sanctions,
  },
  {
    name: "companies",
    key: "opencorporates",
    description:
      "Company registries worldwide (OpenCorporates): a company's registration, status, dates and address; or, with officer, the directorships a named person holds or held.",
    schema: { name: str("A company name."), officer: str("A person's name, to find their company roles."), jurisdiction: str("e.g. gb, us_de, ae_du") },
    run: companies,
  },
  {
    name: "sec_filings",
    description:
      "Full-text search of US SEC filings (EDGAR): who filed what and when — annual reports, insider trades (form 4), ownership (13D/13G), proxies. Searches the filings' text for the exact phrase, so use the name as filings write it (form 4s use the legal name: \"Timothy D. Cook\", not \"Tim Cook\").",
    schema: { query: str("An exact name or phrase."), forms: str("Comma-separated forms, e.g. 10-K,8-K,4"), from: str("YYYY-MM-DD"), to: str("YYYY-MM-DD") },
    required: ["query"],
    run: secFilings,
  },
  {
    name: "court_records",
    description: "US court opinions and federal dockets (CourtListener): cases involving a person or organisation, with court, date and docket number.",
    schema: { query: str("A name or phrase; quote exact names."), kind: { type: "string", enum: ["opinions", "dockets"] } },
    required: ["query"],
    run: courtRecords,
  },
  {
    name: "bluesky",
    description: "Recent public posts from one Bluesky account, with links. For whether an official or outlet said something, and when.",
    schema: { handle: str("e.g. nytimes.com"), max: int("Up to 50.") },
    required: ["handle"],
    run: bluesky,
  },
  {
    name: "mastodon",
    description: "Recent public posts from one Mastodon account.",
    schema: { account: str("name@server, e.g. Gargron@mastodon.social"), max: int("Up to 40.") },
    required: ["account"],
    run: mastodon,
  },
  {
    name: "telegram",
    description:
      "Posts from a public Telegram channel, optionally searched — many governments, militaries, ministries and outlets in the Middle East announce here first. Public channels only.",
    schema: { channel: str("Channel username, e.g. durov"), query: str("Words to search within the channel.") },
    required: ["channel"],
    run: telegram,
  },
  {
    name: "youtube",
    key: "youtube",
    description: "Search YouTube videos, or the latest from one channel: speeches, interviews, press conferences.",
    schema: { query: str("Search words."), channelId: str("A channel id (Wikidata has them)."), from: str("YYYY-MM-DD"), max: int("Up to 25.") },
    run: youtube,
  },
  {
    name: "reddit",
    key: "reddit",
    description: "Search public Reddit posts, optionally in one subreddit. Useful for leads and first-hand accounts; weak as a source on its own.",
    schema: { query: str("Search words."), subreddit: str("e.g. geopolitics"), max: int("Up to 50.") },
    required: ["query"],
    run: reddit,
  },
  {
    name: "shipping_codes",
    description:
      "Find container numbers, ship IMO and MMSI numbers, air waybills and bills of lading in a piece of text, checking each code's check digit and naming the shipping line or airline.",
    schema: { text: str("The text to scan.") },
    required: ["text"],
    run: ({ text }) => ({ codes: findShippingCodes(text) }),
  },
  {
    name: "vessel",
    description:
      "A ship's register entry — name, type, flag, year built, tonnage — by IMO number, MMSI or name; with a Global Fishing Watch key, also its history of names, flags and owners.",
    schema: { imo: str("7-digit IMO number."), mmsi: str("9-digit MMSI."), name: str("Ship name.") },
    run: vessel,
  },
  {
    name: "track_shipment",
    description:
      "What a container number, air waybill or bill of lading is, whether its check digit holds, which line or airline it belongs to, and where it can be tracked.",
    schema: { code: str("The code as written.") },
    required: ["code"],
    run: trackShipment,
  },
];

const offered = TOOLS.filter((t) => !t.key || KEYS[t.key]);

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}
function fail(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // a notification
  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "corpus-research", version: "1.0.0" },
      });
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, {
        tools: offered.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: { type: "object", properties: t.schema, ...(t.required ? { required: t.required } : {}) },
        })),
      });
    case "tools/call": {
      const tool = offered.find((t) => t.name === params?.name);
      if (!tool) return reply(id, { content: [{ type: "text", text: `No tool called ${params?.name}.` }], isError: true });
      try {
        const out = await tool.run(params?.arguments ?? {});
        let text = JSON.stringify(out);
        if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}… (cut short)`;
        return reply(id, { content: [{ type: "text", text }] });
      } catch (err) {
        return reply(id, { content: [{ type: "text", text: `The ${tool.name} tool failed: ${String(err?.message ?? err).slice(0, 300)}` }], isError: true });
      }
    }
    default:
      return fail(id, -32601, `Unknown method ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  void handle(msg);
});
