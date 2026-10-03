/**
 * Shipping codes in a piece of text: containers, ships, air cargo, bills of
 * lading.
 *
 * Plain JavaScript, because two programs read it: Corpus itself, which scans
 * the passages behind an entry before a web check, and the research tool
 * server Claude Code starts, which knows no TypeScript.
 *
 * Three of the four carry a check digit, which is what makes this worth doing
 * by rule rather than by asking a model: "MSKU 123456 5" either adds up or it
 * does not. A bill of lading has no check digit, so one is only taken where the
 * text calls it one.
 */

/** ISO 6346 letter values: A=10 upward, skipping every multiple of 11. */
const LETTER = (() => {
  const out = {};
  let v = 10;
  for (const c of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
    if (v % 11 === 0) v++;
    out[c] = v++;
  }
  return out;
})();

/** Whether an ISO 6346 container number's last digit is right. */
export function containerValid(code) {
  const s = String(code).replace(/[\s-]/g, "").toUpperCase();
  if (!/^[A-Z]{3}[UJZ]\d{7}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const c = s[i];
    sum += (i < 4 ? LETTER[c] : Number(c)) * 2 ** i;
  }
  return (sum % 11) % 10 === Number(s[10]);
}

/** Whether a seven-digit IMO ship number's last digit is right. */
export function imoValid(code) {
  const s = String(code).replace(/\D/g, "");
  if (!/^\d{7}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 6; i++) sum += Number(s[i]) * (7 - i);
  return sum % 10 === Number(s[6]);
}

/** Whether an air waybill's last digit is right: the serial's remainder by 7. */
export function awbValid(code) {
  const s = String(code).replace(/\D/g, "");
  if (!/^\d{11}$/.test(s)) return false;
  return Number(s.slice(3, 10)) % 7 === Number(s[10]);
}

/**
 * Who a container belongs to, by its owner code. Shipping lines only; a
 * container owned by a leasing company says nothing about who is moving it.
 */
export const CONTAINER_OWNERS = {
  MAEU: "Maersk", MSKU: "Maersk", MRKU: "Maersk", MRSU: "Maersk", MSAU: "Maersk", SUDU: "Maersk (Hamburg Süd)",
  MSCU: "MSC", MEDU: "MSC", MSDU: "MSC", MSMU: "MSC",
  CMAU: "CMA CGM", CGMU: "CMA CGM", APZU: "CMA CGM (APL)", APHU: "CMA CGM (APL)",
  HLXU: "Hapag-Lloyd", HLCU: "Hapag-Lloyd", HLBU: "Hapag-Lloyd", UACU: "Hapag-Lloyd",
  COSU: "COSCO", CBHU: "COSCO", CCLU: "COSCO", CSNU: "COSCO", OOLU: "OOCL", OOCU: "OOCL",
  EGHU: "Evergreen", EISU: "Evergreen", EMCU: "Evergreen", EGSU: "Evergreen",
  ONEU: "ONE", NYKU: "ONE", MOLU: "ONE", KKFU: "ONE",
  YMLU: "Yang Ming", YMMU: "Yang Ming", HDMU: "HMM", ZIMU: "ZIM", ZCSU: "ZIM",
  PILU: "PIL", WHLU: "Wan Hai", SITU: "SITC", KMTU: "KMTC", IRSU: "IRISL", ESPU: "Emirates Shipping Line",
};

/** The shipping lines' own tracking pages, where you can look a container up yourself. */
export const CARRIER_TRACKING = {
  Maersk: "https://www.maersk.com/tracking/",
  MSC: "https://www.msc.com/en/track-a-shipment",
  "CMA CGM": "https://www.cma-cgm.com/ebusiness/tracking",
  "Hapag-Lloyd": "https://www.hapag-lloyd.com/en/online-business/track/track-by-container-solution.html",
  COSCO: "https://elines.coscoshipping.com/ebusiness/cargoTracking",
  OOCL: "https://www.oocl.com/eng/ourservices/eservices/cargotracking/Pages/cargotracking.aspx",
  Evergreen: "https://ct.shipmentlink.com/servlet/TDB1_CargoTracking.do",
  ONE: "https://ecomm.one-line.com/one-ecom/manage-shipment/cargo-tracking",
  "Yang Ming": "https://www.yangming.com/e-service/track_trace/track_trace_cargo_tracking.aspx",
  HMM: "https://www.hmm21.com/e-service/general/trackNTrace/TrackNTrace.do",
  ZIM: "https://www.zim.com/tools/track-a-shipment",
};

/** Cargo airlines by the three digits an air waybill starts with. */
export const AWB_AIRLINES = {
  "001": "American Airlines", "006": "Delta", "016": "United", "020": "Lufthansa", "057": "Air France",
  "065": "Saudia", "072": "Gulf Air", "074": "KLM", "077": "EgyptAir", "081": "Qantas", "098": "Air India",
  "112": "China Cargo Airlines", "125": "British Airways", "131": "Japan Airlines", "157": "Qatar Airways",
  "160": "Cathay Pacific", "172": "Cargolux", "176": "Emirates", "180": "Korean Air", "205": "ANA",
  "214": "PIA", "229": "Kuwait Airways", "235": "Turkish Airlines", "297": "China Airlines",
  "406": "UPS Airlines", "423": "DHL", "465": "Air Astana", "512": "Royal Jordanian", "555": "Aeroflot",
  "589": "Jet Airways", "607": "Etihad", "615": "DHL Aviation", "618": "Singapore Airlines",
  "695": "EVA Air", "738": "Vietnam Airlines", "781": "China Eastern", "784": "China Southern",
  "880": "Hainan Airlines", "910": "Oman Air", "999": "Air China", "023": "FedEx",
};

/**
 * Every shipping code in a text, each once, with what it is and whether its
 * check digit holds. Codes whose check digit fails are left out: in a scanned
 * page they are usually a misread, and a misread code tracked confidently is
 * worse than none.
 */
export function findShippingCodes(text) {
  const s = String(text ?? "");
  const out = new Map();
  const add = (kind, code, extra = {}) => {
    const key = `${kind}:${code}`;
    if (!out.has(key)) out.set(key, { kind, code, ...extra });
  };

  for (const m of s.matchAll(/\b([A-Z]{3}[UJZ])[\s-]?(\d{6})[\s-]?(\d)\b/g)) {
    const code = `${m[1]}${m[2]}${m[3]}`;
    if (!containerValid(code)) continue;
    const carrier = CONTAINER_OWNERS[m[1]];
    add("container", code, carrier ? { carrier, tracking: CARRIER_TRACKING[carrier.split(" (")[0]] } : {});
  }

  for (const m of s.matchAll(/\bIMO[\s:#.-]*(?:No\.?|number)?[\s:#.-]*(\d{7})\b/gi)) {
    if (imoValid(m[1])) add("ship", m[1], { lookup: `https://www.vesselfinder.com/vessels/details/${m[1]}` });
  }

  for (const m of s.matchAll(/\bMMSI[\s:#.-]*(?:No\.?|number)?[\s:#.-]*(\d{9})\b/gi)) {
    add("ship-mmsi", m[1]);
  }

  // An air waybill is eleven digits, three of them the airline's. Without the
  // word nearby, eleven digits are as likely a phone number, so the label or a
  // known airline prefix in the usual 3-8 layout is required as well as the
  // check digit.
  for (const m of s.matchAll(/\b(?:(AWB|MAWB|HAWB|air\s*waybill)[\s:#.No-]*)?(\d{3})[\s-](\d{4})\s?(\d{4})\b/gi)) {
    const code = `${m[2]}${m[3]}${m[4]}`;
    if (!awbValid(code)) continue;
    const airline = AWB_AIRLINES[m[2]];
    if (!m[1] && !airline) continue;
    add("air-waybill", `${m[2]}-${m[3]}${m[4]}`, airline ? { airline } : {});
  }

  // The label must stand on its own and be followed by a separator, and the
  // code must carry a digit: without both, "BLOODTHIRSTY" read as a bill of
  // lading numbered OODTHIRSTY (found in a real library, 3 Oct 2026).
  for (const m of s.matchAll(
    /\b(?:B\/L|BL|bill\s+of\s+lading)(?:\s*(?:No\.?|number|#))?[\s:#.-]+((?=[A-Z0-9]*\d)[A-Z]{4}[A-Z0-9]{6,14})\b/gi
  )) {
    const code = m[1].toUpperCase();
    // A container number in a B/L field is still a container number.
    if (containerValid(code)) continue;
    const carrier = CONTAINER_OWNERS[code.slice(0, 4)];
    add("bill-of-lading", code, carrier ? { carrier, tracking: CARRIER_TRACKING[carrier.split(" (")[0]] } : {});
  }

  return [...out.values()];
}
