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
/** For the few public sites that turn away anything that does not look like a browser. */
const BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
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
// Investigations: leaks, registers, arms and trade
// ---------------------------------------------------------------------------

/** OCCRP Aleph: leaked documents, company registers and customs records, searched together. */
async function leaks({ query, kind, max = 15 }) {
  const schema = { company: "Company", person: "Person", document: "Document", any: "" }[kind ?? "any"] ?? "";
  const data = await get(
    `https://aleph.occrp.org/api/2/entities?q=${q(query)}&limit=${Math.min(30, Number(max) || 15)}&highlight=true${
      schema ? `&filter:schemata=${schema}` : ""
    }`,
    { headers: { authorization: `ApiKey ${KEYS.aleph}` } }
  );
  return {
    total: data.total,
    results: (data.results ?? []).map((r) => ({
      name: r.properties?.name?.[0] ?? r.properties?.title?.[0] ?? r.properties?.fileName?.[0],
      kind: r.schema,
      dataset: r.collection?.label,
      countries: r.properties?.country ?? r.properties?.jurisdiction,
      dates: [r.properties?.incorporationDate?.[0], r.properties?.date?.[0]].filter(Boolean),
      excerpt: clip(strip((r.highlight ?? []).join(" … ")), 400),
      url: r.links?.ui ?? `https://aleph.occrp.org/entities/${r.id}`,
    })),
  };
}

/** ICIJ Offshore Leaks: offshore companies, officers and intermediaries from the Panama, Paradise and Pandora papers. */
async function offshoreLeaks({ name, kind }) {
  const type = { entity: "Entity", officer: "Officer", intermediary: "Intermediary", address: "Address" }[kind ?? ""];
  const queries = JSON.stringify({ q0: { query: name, ...(type ? { type } : {}) } });
  const data = await get("https://offshoreleaks.icij.org/api/v1/reconcile", {
    method: "POST",
    body: `queries=${q(queries)}`,
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  return {
    matches: (data.q0?.result ?? []).slice(0, 15).map((r) => ({
      name: r.name,
      kind: r.types?.[0]?.name,
      from: r.description,
      score: Math.round(r.score),
      url: `https://offshoreleaks.icij.org/nodes/${r.id}`,
    })),
    note: "A name match only. Open the record to see the jurisdiction, dates, officers and the leak it came from.",
  };
}

/** Ukraine's War & Sanctions catalogue: foreign-made parts found in weapons used against Ukraine, and their makers. */
async function weaponComponents({ query, marking, companies: whichCompanies }) {
  const base = "https://war-sanctions.gur.gov.ua/en/components";
  const browser = { "user-agent": BROWSER };
  if (marking) {
    const tips = await get(`${base}/default/marking-tips?q=${q(marking)}`, { headers: browser });
    const found = [...new Set((tips.results ?? []).map((t) => t.text))].slice(0, 15);
    if (!found.length) return { markings: [], note: `No component with a marking like "${marking}" in the catalogue.` };
    const list = await componentList(`${base}?${new URLSearchParams({ "f[search]": found[0] })}`, browser);
    return { markings: found, closest: found[0], ...list };
  }
  if (whichCompanies) {
    // The company list filters only in the browser; the site's own search
    // reaches the companies, and the people and Rostec firms besides.
    const url = `https://war-sanctions.gur.gov.ua/en/search/index?q=${q(query ?? "")}`;
    const html = await get(url, { json: false, headers: browser });
    const hits = [];
    for (const m of html.matchAll(/<a[^>]+href="(https:\/\/war-sanctions\.gur\.gov\.ua\/en\/([a-z/-]+)\/\d+)"[^>]*>([\s\S]*?)<\/a>/g)) {
      if (hits.some((h) => h.url === m[1])) continue;
      hits.push({ section: m[2], text: clip(strip(m[3]).replace(/\s+/g, " "), 200), url: m[1] });
    }
    return { results: hits.slice(0, 25), searched: url };
  }
  return componentList(`${base}?${new URLSearchParams({ "f[search]": query ?? "" })}`, browser);
}

async function componentList(url, headers) {
  const html = await get(url, { json: false, headers });
  const total = /class="summary">Total:\s*([\d,]+)/.exec(html)?.[1];
  const items = [];
  for (const block of html.split(/<a class="component-link"/).slice(1, 16)) {
    const href = /href="([^"]+)"/.exec(block)?.[1];
    const fields = {};
    for (const m of block.matchAll(/<div class="text-white">([^<]+)<\/div>\s*<div class="yellow[^"]*">([^<]+)<\/div>(?:\s*<div class="text-white font-weight-bold">([^<]+)<\/div>)?/g)) {
      fields[strip(m[1])] = strip(m[3] ? `${m[2]} — ${m[3]}` : m[2]);
    }
    if (href) items.push({ ...fields, url: href });
  }
  return { total: total ? Number(total.replace(/,/g, "")) : items.length, items, searched: url };
}

/** Conflict Armament Research: field investigations tracing weapons and drone parts recovered in conflicts. */
async function conflictArmament({ query }) {
  // The reports are PDFs in the site's media library; its own search returns only pages.
  const [files, posts] = await Promise.all([
    get(`https://www.conflictarm.com/wp-json/wp/v2/media?search=${q(query)}&mime_type=application/pdf&per_page=15&_fields=title,source_url,date`),
    get(`https://www.conflictarm.com/wp-json/wp/v2/posts?search=${q(query)}&per_page=10&_fields=title,link,date`),
  ]);
  return {
    reports: files.map((f) => ({ title: strip(f.title?.rendered), date: f.date?.slice(0, 10), url: f.source_url })),
    dispatches: posts.map((x) => ({ title: strip(x.title?.rendered), date: x.date?.slice(0, 10), url: x.link })),
    note: "Reports and dispatches on conflictarm.com. Open one to read it; their iTrace database needs its own sign-in.",
  };
}

/** The Security Council sanctions committees whose expert panels publish reports. */
const PANELS = {
  sudan: { n: 1591, name: "Sudan (Darfur)" },
  libya: { n: 1970, name: "Libya" },
  yemen: { n: 2140, name: "Yemen" },
  "south sudan": { n: 2206, name: "South Sudan" },
  "central african republic": { n: 2127, name: "Central African Republic" },
  "dr congo": { n: 1533, name: "Democratic Republic of the Congo" },
  mali: { n: 2374, name: "Mali" },
  haiti: { n: 2653, name: "Haiti" },
  "north korea": { n: 1718, name: "DPRK (North Korea)" },
  "al-shabaab": { n: 2713, name: "Al-Shabaab (Somalia)" },
};

/** UN Security Council panels of experts: their reports on arms embargo breaches, by country. */
async function unPanelReports({ country }) {
  const key = String(country ?? "").toLowerCase();
  const panel = PANELS[key] ?? Object.values(PANELS).find((p) => p.name.toLowerCase().includes(key));
  if (!panel) return { error: `No expert panel for "${country}". Panels: ${Object.values(PANELS).map((p) => p.name).join(", ")}.` };
  const page = `https://main.un.org/securitycouncil/en/sanctions/${panel.n}/panel-of-experts/reports`;
  // The page turns away anything that does not look like a browser, and
  // carries the reports' symbols as text more reliably than as links.
  const html = await get(page, { json: false, headers: { "user-agent": BROWSER } });
  // Tags become spaces, or a symbol runs into the date printed beside it.
  const text = html.replace(/<[^>]+>/g, " ");
  const symbols = [...new Set([...text.matchAll(/\bS\/(\d{4})\/(\d{1,4})\b/g)].map((m) => `S/${m[1]}/${m[2]}`))];
  const reports = symbols
    .sort((a, b) => {
      const [, ya, na] = a.split("/").map(Number);
      const [, yb, nb] = b.split("/").map(Number);
      return yb - ya || nb - na;
    })
    .map((symbol) => ({ symbol, year: symbol.split("/")[1], url: `https://undocs.org/${symbol}` }));
  return {
    panel: panel.name,
    page,
    reports: reports.slice(0, 30),
    note: "Each report is a UN document; open its address to read it. Annexes list seizures, serial numbers, flights and companies.",
  };
}

/** SIPRI's country ids, fetched once per check. */
let sipriCountries = null;
async function sipriCountry(name) {
  sipriCountries ??= await get("https://atbackend.sipri.org/api/p/countries/getAllCountriesTrimmed");
  const want = String(name).trim().toLowerCase();
  const alias = { uae: "united arab emirates", usa: "united states", us: "united states", uk: "united kingdom", russia: "russia" }[want] ?? want;
  const hit =
    sipriCountries.find((c) => c.Name.toLowerCase() === alias) ??
    sipriCountries.find((c) => c.Name.toLowerCase().startsWith(alias)) ??
    sipriCountries.find((c) => c.Name.toLowerCase().includes(alias));
  if (!hit) throw new Error(`SIPRI has no country called "${name}".`);
  return hit;
}

/** SIPRI Arms Transfers Database: state transfers of major conventional arms since 1950. */
async function armsTransfers({ supplier, recipient }) {
  if (!supplier && !recipient) throw new Error("Give a supplier, a recipient, or both.");
  const filter = (field, c) => ({ field, oldField: "", condition: "contains", value1: "", value2: "", listData: [c.EntityId] });
  const filters = [];
  const names = {};
  if (supplier) filters.push(filter("Supplier", (names.supplier = await sipriCountry(supplier))));
  if (recipient) filters.push(filter("Recipient", (names.recipient = await sipriCountry(recipient))));
  filters.push({ field: "opendeals", oldField: "", condition: "", value1: "", value2: "", listData: [] });
  const data = await get("https://atbackend.sipri.org/api/p/trades/trade-register-csv/", {
    method: "POST",
    body: JSON.stringify({ filters, logic: "AND" }),
    headers: { "content-type": "application/json" },
  });
  const lines = Buffer.from(data.bytes ?? "", "base64").toString("utf8").split("\n");
  const head = lines.findIndex((l) => l.startsWith("Recipient,Supplier"));
  const cols = head >= 0 ? splitCsv(lines[head]) : [];
  const rows = head >= 0 ? lines.slice(head + 1).filter((l) => l.trim()).map(splitCsv) : [];
  const pick = (r, name) => r[cols.indexOf(name)];
  return {
    from: names.supplier?.Name ?? "any",
    to: names.recipient?.Name ?? "any",
    transfers: rows.slice(0, 60).map((r) => ({
      recipient: pick(r, "Recipient"),
      supplier: pick(r, "Supplier"),
      ordered: pick(r, "Year of order"),
      number: pick(r, "Number ordered"),
      weapon: pick(r, "Weapon designation"),
      description: pick(r, "Weapon description"),
      delivered: pick(r, "Year(s) of delivery"),
      comments: pick(r, "Comments"),
    })),
    total: rows.length,
    url: "https://armstransfers.sipri.org/ArmsTransfer/TransferRegister",
    note: "Major conventional arms only — aircraft, armoured vehicles, artillery, missiles, ships, and since 2020 some drones. Small arms, ammunition and parts are not covered.",
  };
}

function splitCsv(line) {
  const out = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = !quoted;
    } else if (ch === "," && !quoted) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/** UN Comtrade's country codes, fetched once per check. */
let comtradeAreas = null;
async function comtradeCode(name) {
  comtradeAreas ??= (await get("https://comtradeapi.un.org/files/v1/app/reference/partnerAreas.json")).results ?? [];
  const want = String(name).trim().toLowerCase();
  if (want === "world") return 0;
  const hit =
    comtradeAreas.find((a) => [a.PartnerCodeIsoAlpha3, a.PartnerCodeIsoAlpha2].some((c) => c?.toLowerCase() === want)) ??
    comtradeAreas.find((a) => a.PartnerDesc?.toLowerCase() === want) ??
    comtradeAreas.find((a) => a.PartnerDesc?.toLowerCase().startsWith(want));
  if (!hit) throw new Error(`Comtrade has no country called "${name}". Try its three-letter code.`);
  return hit.PartnerCode;
}

/** UN Comtrade: the declared value and weight of trade between two countries in one customs code, by year. */
async function tradeFlows({ reporter, partner, hsCode, year, flow = "import" }) {
  const rc = await comtradeCode(reporter);
  const pc = partner ? await comtradeCode(partner) : 0;
  const fc = flow === "export" ? "X" : "M";
  const url = `https://comtradeapi.un.org/public/v1/preview/C/A/HS?reporterCode=${rc}&period=${q(year)}&partnerCode=${pc}&cmdCode=${q(String(hsCode).replace(/\D/g, ""))}&flowCode=${fc}`;
  const data = await get(url);
  return {
    reporter,
    partner: partner ?? "World",
    flow: fc === "M" ? "imports" : "exports",
    year,
    hsCode,
    records: (data.data ?? []).map((d) => ({ hsCode: d.cmdCode, valueUSD: d.primaryValue, netKg: d.netWgt, quantity: d.qty, quantityUnit: d.qtyUnitAbbr })),
    url,
    note: "As the reporting country declared it to the UN. Ask again with the countries swapped and the flow reversed: the partner's own figures often differ, and the gap is itself a finding. One year per question.",
  };
}

/** The Global LEI register: the legal identity, address and parent of any company that holds a Legal Entity Identifier. */
async function lei({ name, lei: code }) {
  const url = code
    ? `https://api.gleif.org/api/v1/lei-records/${q(code)}`
    : `https://api.gleif.org/api/v1/lei-records?filter%5Bfulltext%5D=${q(name)}&page%5Bsize%5D=10`;
  const data = await get(url);
  const records = Array.isArray(data.data) ? data.data : data.data ? [data.data] : [];
  return {
    records: records.map((r) => {
      const e = r.attributes?.entity ?? {};
      const a = e.legalAddress ?? {};
      return {
        name: e.legalName?.name,
        otherNames: (e.otherNames ?? []).map((n) => n.name),
        lei: r.id,
        status: e.status,
        jurisdiction: e.jurisdiction,
        registeredAs: e.registeredAs,
        address: [...(a.addressLines ?? []), a.city, a.country].filter(Boolean).join(", "),
        registered: r.attributes?.registration?.initialRegistrationDate,
        url: `https://search.gleif.org/#/record/${r.id}`,
      };
    }),
    note: records.length ? undefined : "No company by that name holds an LEI. Many private firms never take one.",
  };
}

let openskyToken = null;
async function opensky(path) {
  if (!openskyToken || openskyToken.expires < Date.now()) {
    const [id, secret] = String(KEYS.opensky ?? "").split(":");
    const t = await get("https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token", {
      method: "POST",
      body: `grant_type=client_credentials&client_id=${q(id)}&client_secret=${q(secret)}`,
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    openskyToken = { value: t.access_token, expires: Date.now() + (t.expires_in - 60) * 1000 };
  }
  return get(`https://opensky-network.org/api${path}`, { headers: { authorization: `Bearer ${openskyToken.value}` } });
}

/** OpenSky Network: past flights of one aircraft, or arrivals and departures at one airport. */
async function flights({ icao24, airport, direction = "arrival", from, to }) {
  const begin = Math.floor(new Date(from).getTime() / 1000);
  const end = Math.floor(new Date(to ?? from).getTime() / 1000) + (to ? 0 : 86400);
  if (!Number.isFinite(begin) || !Number.isFinite(end)) throw new Error("Give from (and to) as YYYY-MM-DD.");
  let list;
  if (icao24) list = await opensky(`/flights/aircraft?icao24=${q(String(icao24).toLowerCase())}&begin=${begin}&end=${end}`);
  else if (airport) list = await opensky(`/flights/${direction === "departure" ? "departure" : "arrival"}?airport=${q(String(airport).toUpperCase())}&begin=${begin}&end=${end}`);
  else throw new Error("Give an aircraft's icao24 address or an airport's ICAO code.");
  return {
    flights: (list ?? []).slice(0, 60).map((f) => ({
      icao24: f.icao24,
      callsign: f.callsign?.trim(),
      from: f.estDepartureAirport,
      to: f.estArrivalAirport,
      departed: f.firstSeen ? new Date(f.firstSeen * 1000).toISOString() : undefined,
      arrived: f.lastSeen ? new Date(f.lastSeen * 1000).toISOString() : undefined,
      url: `https://opensky-network.org/aircraft-profile?icao24=${f.icao24}`,
    })),
    note: "Airports are OpenSky's estimates from the track. An aircraft with its transponder off, or over areas without receivers, leaves no record.",
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
    name: "leaks",
    key: "aleph",
    description:
      "OCCRP Aleph: leaked documents, company registers, customs and court records from many countries, searched together. The best place to find a private number — a contract, invoice or batch number — or a company that has no website. Quote exact numbers and names.",
    schema: { query: str('Words, a name or a number; quote exact phrases, e.g. "160823".'), kind: { type: "string", enum: ["any", "company", "person", "document"] }, max: int("Up to 30.") },
    required: ["query"],
    run: leaks,
  },
  {
    name: "offshore_leaks",
    description:
      "ICIJ Offshore Leaks (Panama, Paradise and Pandora papers and others): offshore companies, their officers and the intermediaries who set them up, matched by name.",
    schema: { name: str("A company or person name."), kind: { type: "string", enum: ["entity", "officer", "intermediary", "address"] } },
    required: ["name"],
    run: offshoreLeaks,
  },
  {
    name: "weapon_components",
    description:
      "Ukraine's War & Sanctions catalogue (Defence Intelligence of Ukraine): foreign-made components found in Russian and Iranian weapons and drones, with the weapon, the component's marking and its manufacturer. Search by words, by a part marking or number, or list the companies involved.",
    schema: {
      query: str("Words: a manufacturer, a country, a weapon (e.g. Shahed, Orlan, Lancet)."),
      marking: str("A part number or marking as written on the component."),
      companies: { type: "boolean", description: "Search the involved companies instead of the components." },
    },
    run: weaponComponents,
  },
  {
    name: "conflict_armament",
    description:
      "Conflict Armament Research: investigations that trace weapons, ammunition and drone parts recovered in conflicts back to their makers and suppliers — Sudan, Libya, Yemen, the Sahel, Ukraine and more.",
    schema: { query: str("Words, e.g. Sudan drones, or a weapon or company name.") },
    required: ["query"],
    run: conflictArmament,
  },
  {
    name: "un_panel_reports",
    description:
      "Reports of UN Security Council panels of experts on sanctions and arms embargoes (Sudan, Libya, Yemen, South Sudan, CAR, DR Congo, Mali, Haiti, North Korea, Al-Shabaab), newest first, with links. Their annexes name companies, flights, seizures and serial numbers.",
    schema: { country: str("e.g. Sudan, Libya, Yemen") },
    required: ["country"],
    run: unPanelReports,
  },
  {
    name: "arms_transfers",
    description:
      "SIPRI Arms Transfers Database: state transfers of major conventional arms since 1950 — aircraft, armoured vehicles, artillery, missiles, ships and some drones — between a supplier and a recipient country, with years and numbers. Not small arms, ammunition or parts.",
    schema: { supplier: str("Supplying country, e.g. Belarus"), recipient: str("Receiving country, e.g. Sudan") },
    run: armsTransfers,
  },
  {
    name: "trade_flows",
    description:
      "UN Comtrade: the value and weight of trade one country declared with another in one customs (HS) code and year — e.g. the UAE's imports of HS 8807 (aircraft and drone parts) from Belarus in 2023. Check both sides: the partner's mirror figures often differ.",
    schema: {
      reporter: str("The declaring country, by name or three-letter code."),
      partner: str("The other country; leave out for the world."),
      hsCode: str("2, 4 or 6 digits, e.g. 8807 or 930190."),
      year: str("One year, e.g. 2023."),
      flow: { type: "string", enum: ["import", "export"] },
    },
    required: ["reporter", "hsCode", "year"],
    run: tradeFlows,
  },
  {
    name: "lei",
    description:
      "The Global LEI register (GLEIF): a company's legal name, identifier, registered address, jurisdiction, register number and status, for any company that holds a Legal Entity Identifier — common for firms in finance and trade.",
    schema: { name: str("A company name."), lei: str("A 20-character LEI, if known.") },
    run: lei,
  },
  {
    name: "flights",
    key: "opensky",
    description:
      "OpenSky Network: past flights of one aircraft (by its icao24 transponder address) or arrivals and departures at one airport (by ICAO code, e.g. OMAA, HSSK) between two dates — for cargo flights behind a shipment.",
    schema: {
      icao24: str("The aircraft's 6-character transponder address."),
      airport: str("An airport's 4-letter ICAO code."),
      direction: { type: "string", enum: ["arrival", "departure"] },
      from: str("YYYY-MM-DD"),
      to: str("YYYY-MM-DD; a week at most for an airport."),
    },
    required: ["from"],
    run: flights,
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
