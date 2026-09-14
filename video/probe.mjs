// Finds the elements scenes will click: citation markers, the contradictions
// badge, the network canvas, the write pane's search. Prints what it finds and
// screenshots the states a click opens.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.FILM_URL ?? "http://127.0.0.1:5410";
const OUT = path.resolve(import.meta.dirname, "out/explore");
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1.2 });
const page = await context.newPage();
const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
const settle = async (url) => { await page.goto(BASE + url, { waitUntil: "domcontentloaded" }); await page.waitForTimeout(3000); };

const describe = (sel) => page.evaluate((sel) => [...document.querySelectorAll(sel)].slice(0, 6).map((el) => ({
  tag: el.tagName, cls: String(el.className).slice(0, 120), text: el.textContent.trim().slice(0, 60),
  attrs: [...el.attributes].map((a) => `${a.name}=${a.value.slice(0, 40)}`).join(" "),
})), sel);

// Scrolling: is it the document or an inner container?
await settle("/brief");
console.log("scroll", await page.evaluate(() => {
  const se = document.scrollingElement;
  const inner = [...document.querySelectorAll("*")].filter((el) => {
    const s = getComputedStyle(el);
    return /(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 50;
  }).map((el) => `${el.tagName}.${String(el.className).slice(0, 60)} ${el.scrollHeight}/${el.clientHeight}`);
  return { doc: `${se.scrollHeight}/${se.clientHeight}`, inner };
}));

// Brief citation markers
const briefMarkers = await page.evaluate(() => [...document.querySelectorAll("button, sup, a")]
  .filter((el) => /^\d{1,2}$/.test(el.textContent.trim()) && el.getBoundingClientRect().width < 40)
  .slice(0, 3).map((el) => ({ tag: el.tagName, cls: String(el.className).slice(0, 140), parent: el.parentElement.tagName + "." + String(el.parentElement.className).slice(0, 60) })));
console.log("brief markers", briefMarkers);

// Entry page
await settle("/pedia/20336");
const entryMarkers = await page.evaluate(() => [...document.querySelectorAll("button, sup, a, span")]
  .filter((el) => /^\d{1,2}$/.test(el.textContent.trim()) && el.getBoundingClientRect().width < 40)
  .slice(0, 3).map((el) => ({ tag: el.tagName, cls: String(el.className).slice(0, 140), attrs: [...el.attributes].map((a) => a.name).join(",") })));
console.log("entry markers", entryMarkers);
console.log("details", await describe("details > summary"));

// Click the first marker in the body and capture the popover
const marker = page.locator("button.align-super").first();
if (await marker.count()) {
  await marker.click();
  await page.waitForTimeout(800);
  await shot("probe-entry-popover");
  console.log("popover", await describe("[role=dialog], [class*=popover], [class*=Popover]"));
  await page.keyboard.press("Escape");
}
// The contradictions badge — where does it take you?
const badge = page.getByText(/3 contradictions/).first();
if (await badge.count()) {
  await badge.click();
  await page.waitForTimeout(1200);
  await shot("probe-entry-contradictions");
  console.log("after badge url", page.url(), "scrollY", await page.evaluate(() => scrollY));
}
// Verification banner expanded
await settle("/pedia/20336");
const banner = page.getByText(/not fully borne out/).first();
if (await banner.count()) {
  await banner.click();
  await page.waitForTimeout(800);
  await shot("probe-entry-verify");
}

// Library, whole page
await settle("/");
await page.screenshot({ path: path.join(OUT, "probe-library-full.png"), fullPage: true });

// Network: scroll the canvas into view
await settle("/network");
const canvas = page.locator("canvas, svg").last();
console.log("network canvas", await describe("canvas"), await page.locator("svg").count());
await page.evaluate(() => scrollTo(0, 620));
await page.waitForTimeout(2500);
await shot("probe-network");

// Write: the library search on the right
await settle("/write?draft=5");
console.log("write inputs", await describe("input, textarea"));
const search = page.getByPlaceholder(/Search your library/);
if (await search.count()) {
  await search.fill("America");
  await search.press("Enter");
  await page.waitForTimeout(2500);
  await shot("probe-write-search");
}

// Search page with a query
await settle("/search");
await page.getByPlaceholder(/A name, a phrase/).fill("Strait of Hormuz");
await page.getByRole("button", { name: "Search" }).click();
await page.waitForTimeout(3000);
await shot("probe-search-results");

// Inbox filtered to one outlet, second item selected
await settle("/inbox");
await page.getByRole("button", { name: /The Washington Post/ }).first().click();
await page.waitForTimeout(2000);
await page.keyboard.press("j");
await page.waitForTimeout(1200);
await shot("probe-inbox-wapo");

await browser.close();
