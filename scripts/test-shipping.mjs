/**
 * Shipping papers and photographs — the parts that need no model.
 *
 *   node node_modules/tsx/dist/cli.mjs scripts/test-shipping.mjs
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { PDFDocument } from "pdf-lib";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const SANDBOX = path.join(root, "data", "__shipping__");
fs.rmSync(SANDBOX, { recursive: true, force: true });
process.env.CORPUS_DATA_DIR = SANDBOX;

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

const { shippingSigns, SHIPPING_THRESHOLD } = await import("../lib/pipeline/shipment.ts");
const { pageImages, photoPiece } = await import("../lib/pipeline/ocr.ts");

// ---------------------------------------------------------------------------
section("Shipping papers are recognised, in the languages they come in");
// ---------------------------------------------------------------------------
const loadingPlan = `第一架机 FIRST FLIGHT LOADING PLAN
NO. Product name Product name in Chinese QTY Packing form GROSS WEIGHT lehgth width height Unit volume (M3)
1 GCS truck chassis GCS底盘 1 TRUCK CHASSIS IN NUDE 15000
2 GCS CABIN GCS驾驶舱 1 Wooden box 1120`;
const invoice = `COMBINED Commercial invoice & PACKING LIST
Отправитель: / Shipper: KVAND IS, LLC  Получатель: / Recipient: «M2 Technology Development LLC»
Netto Wt (kg) / Вес нетто (кг) | Gross Wt (kg) / Вес брутто (кг) | HS Code | Country of origin`;
const arabic = `بوليصة الشحن رقم 4471 — الشاحن: شركة الأفق — المرسل إليه: مؤسسة النيل — الوزن الإجمالي 1200 كغ — ميناء الشحن: جبل علي`;
const story = `The ministry said the shipment of drones arrived in Port Sudan last week, according to two officials who asked not to be named.`;

check("an aircraft loading plan", shippingSigns(loadingPlan) >= SHIPPING_THRESHOLD, String(shippingSigns(loadingPlan)));
check("a Russian–English invoice and packing list", shippingSigns(invoice) >= SHIPPING_THRESHOLD, String(shippingSigns(invoice)));
check("an Arabic bill of lading", shippingSigns(arabic) >= SHIPPING_THRESHOLD, String(shippingSigns(arabic)));
check("but not a news story that mentions a shipment", shippingSigns(story) < SHIPPING_THRESHOLD, String(shippingSigns(story)));

// ---------------------------------------------------------------------------
section("A photograph goes to the reader as the photograph, not a PDF");
// ---------------------------------------------------------------------------
// The smallest valid JPEG: a 1×1 white pixel.
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/APn+iiigD//Z",
  "base64"
);
const photoPdf = await PDFDocument.create();
const img = await photoPdf.embedJpg(new Uint8Array(JPEG));
photoPdf.addPage([img.width, img.height]).drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
const reloaded = await PDFDocument.load(await photoPdf.save());
const images = pageImages(reloaded, [0]);
check("the picture inside a one-photo PDF is found", images?.length === 1);
check("and it is the JPEG, byte for byte", images?.[0].equals(JPEG));

const textPdf = await PDFDocument.create();
textPdf.addPage().drawText("A born-digital page");
check("a page with no picture is not mistaken for one", pageImages(await PDFDocument.load(await textPdf.save()), [0]) === null);

// ---------------------------------------------------------------------------
section("A photo reading says which part is the picture's own words");
// ---------------------------------------------------------------------------
const reading = photoPiece(
  `<<<TEXT>>>\nCP28 [painted on the cargo dolly]\nTURKISH AIRLINES [on the fuselage behind]\n<<<DESCRIPTION>>>\nTwo wooden crates under cargo netting on an airport dolly at dusk.`,
  1
);
check("both parts are kept", /CP28/.test(reading?.text ?? "") && /wooden crates/.test(reading?.text ?? ""), reading?.text);
check("the description is marked as written by the AI", /described by the AI/.test(reading?.text ?? ""));
check("a photo with no text says so", /none legible/.test(photoPiece("<<<TEXT>>>\nnone\n<<<DESCRIPTION>>>\nA tarmac at night.", 1)?.text ?? ""));
check(
  "an apology is not a reading",
  photoPiece("I cannot locate the file WhatsApp Image (2). Could you please verify the filename?", 1) === null
);

fs.rmSync(SANDBOX, { recursive: true, force: true });
console.log(`\n${failed === 0 ? "All passed" : "FAILURES PRESENT"}: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
