// Packaging mode — match CCS / packaging codes (BPC.291168.001, P790046, 142632-1-1 …) against the
// "P2-02 Packaging Product Baseline" Sheet1 and report its Use status.
// Pure functions, no DOM; runs in the browser and in Node (tests).

import { normalizePart, foldConfusions, editDistance } from "./matcher.js";

export const PKG_ORDER = ["pkg_service", "pkg_production", "pkg_obsolete", "pkg_check", "pkg_not_listed", "pkg_none"];

export const PKG_LABEL = {
  pkg_service: "SERVICE — pink tag",
  pkg_production: "CURRENT PRODUCTION — yellow tag",
  pkg_obsolete: "DON'T USE ANYMORE — grey tag",
  pkg_check: "On list — check status",
  pkg_not_listed: "Code read — NOT on packaging list",
  pkg_none: "No packaging code read",
};

export const PKG_COLOR = {
  pkg_service: "#e91e8c",
  pkg_production: "#f9c80e",
  pkg_obsolete: "#757575",
  pkg_check: "#ef6c00",
  pkg_not_listed: "#c62828",
  pkg_none: "#9e9e9e",
};

export const PKG_ACTION = {
  pkg_service: "In service: label it PINK; it stays on the floor for relocation to the service area.",
  pkg_production: "Current production: label it YELLOW; needs a new production home.",
  pkg_obsolete: "No longer used: label it GREY; dispositioned / quarantined.",
  pkg_check: "On the list but the use status is blank or conflicting; ask before tagging.",
  pkg_not_listed: "A packaging code was read but is not on the baseline list; record it for review.",
  pkg_none: "No packaging code found; get closer or type the code.",
};

const MIN_ALIAS = 5;
// CCS code shape after removing punctuation: BPC/BPK/BPL + 5-6 digits + 3 digits (OCR may read B as 8, 0 as O).
const CCS_RE = /[B8]P[CKL][0-9OQ]{8,9}/g;

function cellText(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(v).replace(/\.0+$/, "");
  return String(v).trim();
}

/** "Service ", "DON'T USE ANYMORE", "Current Production " → status key. */
export function statusFromUse(text) {
  const t = String(text ?? "").toLowerCase().replace(/[^a-z ]/g, "");
  if (!t.trim()) return "pkg_check";
  if (/\bdon ?t use|\bdont use|not use|no longer|obsolete/.test(t) || /^don/.test(t.trim())) return "pkg_obsolete";
  if (t.includes("service")) return "pkg_service";
  if (t.includes("production") || t.includes("current")) return "pkg_production";
  return "pkg_check";
}

/** All usable identifiers in a code cell (multi-line, "(candidate)" notes, trailing words, placeholders). */
export function splitCodes(cell) {
  const out = [];
  for (const piece of cellText(cell).split(/\r?\n|;|,/)) {
    const first = piece.replace(/\([^)]*\)/g, " ").trim().split(/\s+/)[0] || "";
    if (!/[0-9]/.test(first) || /X{3,}/i.test(first)) continue;   // "stock item", "BPK.3XXXXX.000"
    if (normalizePart(first).length < MIN_ALIAS) continue;
    out.push(first);
  }
  return out;
}

/** rows: array of arrays; header row contains "Use status" and a code column. */
export function buildPackagingCatalog(rows) {
  let h = -1;
  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    if ((rows[i] || []).some((c) => cellText(c).toLowerCase().replace(/\s+/g, " ") === "use status")) { h = i; break; }
  }
  if (h < 0) throw new Error("Could not find a 'Use status' header (packaging list Sheet1).");
  const header = rows[h].map((c) => cellText(c).toLowerCase());
  const find = (...keys) => header.findIndex((x) => keys.some((k) => x.includes(k)));
  const cCode = find("ccs", "part number");
  const cItem = find("material item", "item", "description");
  const cInternal = find("internal");
  const cUse = find("use status");
  if (cCode < 0) throw new Error("Could not find the 'Part Number / CCS codes' column.");
  const records = [];
  for (let r = h + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const codes = splitCodes(row[cCode]);
    if (!codes.length) continue;
    const use = cellText(row[cUse]);
    records.push({
      code: codes[0], codes, row: r + 1,
      item: cellText(row[cItem]), internal: cellText(row[cInternal]),
      use, status: statusFromUse(use),
      aliases: [...new Set(codes.map(normalizePart))],
    });
  }
  return new PackagingCatalog(records, h + 1);
}

export class PackagingCatalog {
  constructor(records, headerRow = 0) {
    this.records = records;
    this.headerRow = headerRow;
    this.byAlias = new Map();
    for (const rec of records) {
      for (const a of rec.aliases) {
        const k = foldConfusions(a);
        if (!this.byAlias.has(k)) this.byAlias.set(k, []);
        if (!this.byAlias.get(k).includes(rec)) this.byAlias.get(k).push(rec);
      }
    }
  }

  get size() { return this.records.length; }

  /** Records whose code appears in the OCR text. Numeric-only codes must be a whole word (barcode digits
   *  would otherwise produce false hits); codes with letters may be split by OCR, so they match inside
   *  the joined, punctuation-free text. */
  find(lines) {
    const words = new Set();
    for (const line of lines) for (const w of String(line).toUpperCase().split(/[\s:]+/)) {
      const n = normalizePart(w);
      if (n) { words.add(foldConfusions(n)); if (/^P[0-9]/.test(n)) words.add(foldConfusions(n.slice(1))); }
    }
    const joined = foldConfusions(normalizePart(lines.join(" ")));
    const hits = [];
    for (const [alias, recs] of this.byAlias) {
      const numeric = /^[0-9]+$/.test(alias);
      if (numeric ? words.has(alias) : joined.includes(alias)) hits.push({ alias, recs });
    }
    // Keep the most specific: drop aliases contained in a longer hit (BPC291168000 vs …0001 cannot both fit).
    const kept = hits.filter((x) => !hits.some((y) => y !== x && y.alias.length > x.alias.length && y.alias.includes(x.alias)));
    const recs = [];
    for (const k of kept) for (const r of k.recs) if (!recs.includes(r)) recs.push(r);
    return recs;
  }

  nearest(code) {
    const n = foldConfusions(normalizePart(code));
    const near = [];
    for (const [alias, recs] of this.byAlias) {
      if (alias.length >= 8 && Math.abs(alias.length - n.length) <= 1 && editDistance(alias, n, 1) <= 1) {
        for (const r of recs) if (!near.includes(r)) near.push(r);
      }
    }
    return near;
  }
}

function ccsCodes(lines) {
  const text = normalizePart(lines.join(" "));
  const out = [];
  for (const m of text.matchAll(CCS_RE)) {
    const raw = m[0].replace(/^8/, "B").replace(/[OQ]/g, "0");
    const d = raw.slice(3);
    const pretty = `${raw.slice(0, 3)}.${d.slice(0, d.length - 3)}.${d.slice(-3)}`;
    if (!out.includes(pretty)) out.push(pretty);
  }
  return out;
}

const asPart = (rec) => ({ partNumber: rec.code, description: rec.item, model: rec.internal, comment: rec.use || "(blank use status)" });

/** OCR lines (or a typed code) → verdict in the same shape the Parts mode produces. */
export function evaluatePackaging(lines, catalog) {
  lines = (lines || []).map((l) => String(l ?? "")).filter(Boolean);
  const codesRead = ccsCodes(lines);
  const recs = catalog.find(lines);
  const base = { tokens: codesRead.length ? codesRead : lines.slice(0, 3), lines, unlisted: [], matches: [] };
  if (recs.length) {
    const statuses = [...new Set(recs.map((r) => r.status))];
    const status = statuses.length === 1 ? statuses[0] : "pkg_check";
    const note = statuses.length === 1 ? PKG_ACTION[status]
      : `Matches ${recs.length} list rows with different use status (${recs.map((r) => `${r.code}: ${r.use || "blank"}`).join("; ")}); check before tagging.`;
    return { ...base, status, parts: recs.map(asPart), note, possible: false };
  }
  for (const code of codesRead) {
    const near = catalog.nearest(code);
    if (near.length) {
      return { ...base, status: "pkg_check", parts: near.map(asPart), possible: true,
        note: `Read ${code}; one character from ${near.map((r) => `${r.code} (${r.use || "blank status"})`).join(" or ")}. Confirm the code on the label before tagging.` };
    }
  }
  if (codesRead.length) {
    return { ...base, status: "pkg_not_listed", parts: [], unlisted: codesRead, note: `${codesRead.join(", ")} — ${PKG_ACTION.pkg_not_listed}` };
  }
  return { ...base, status: "pkg_none", parts: [], tokens: [], note: PKG_ACTION.pkg_none };
}
