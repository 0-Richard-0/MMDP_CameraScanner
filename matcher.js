// Matching engine — a 1:1 port of tools/retrieval/photo_part_match.py.
// Pure functions, no DOM; runs in the browser and in Node (tests).
//
// Status precedence: exact_match > possible_match (look-alike / revision / 1-edit on a
// malformed token) > ambiguous > not_in_catalog (clean Sodecia number not on the list)
// > no_match (only customer / lot numbers) > manual_review (nothing readable).

export const STATUS_ORDER = ["exact_match", "possible_match", "ambiguous", "not_in_catalog", "no_match", "manual_review"];

export const STATUS_LABEL = {
  exact_match: "On obsolete list",
  possible_match: "Possible match — confirm",
  ambiguous: "Ambiguous — confirm",
  not_in_catalog: "Part number read — NOT on obsolete list",
  no_match: "Number read — not a Sodecia part number",
  manual_review: "Nothing readable",
};

export const STATUS_COLOR = {
  exact_match: "#2e7d32",
  possible_match: "#f9a825",
  ambiguous: "#ef6c00",
  not_in_catalog: "#1565c0",
  no_match: "#757575",
  manual_review: "#c62828",
};

const MIN_TOKEN_LEN = 6;
const MIN_FUZZY_LEN = 8;

// (?<![A-Z0-9]) lookbehind is not available on iOS < 16.4, so the boundary is a capture group.
const PART_NUMBER_SCAN = /(^|[^A-Z0-9])((?:[A-Z][A-Z0-9]{0,3}-?)?[0-9]{4,8}[A-Z0-9]{0,8})(?![A-Z0-9])/g;
const PART_NUMBER_FULL = /^(?:[A-Z][A-Z0-9]{0,3}-?)?[0-9]{4,8}[A-Z0-9]{0,8}$/;
export const SODECIA_PN_RE = /^[0-9]{6}P[0-9]{2}[A-Z]?$/;
const LABEL_PREFIX_RE = /^(?:JOB|JOBNO|PN|PARTNO|SN|NO)(?=[0-9])/;
const NOISE_RE = /(?:^[A-Z]{2}[0-9]{5}$)|(?:(?:PCS|PC|KG|LB|LBS|RD|ST|AVE|DR|BLVD)$)/;

const CONFUSION = { O: "0", Q: "0", I: "1", L: "1", S: "5", B: "8", Z: "2" };

export function normalizePart(value) {
  return String(value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function foldConfusions(norm) {
  return norm.replace(/[OQILSBZ]/g, (c) => CONFUSION[c]);
}

export function editDistance(a, b, limit = null) {
  if (a === b) return 0;
  if (limit !== null && Math.abs(a.length - b.length) > limit) return limit + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] !== b[j - 1] ? 1 : 0)));
    }
    if (limit !== null && Math.min(...cur) > limit) return limit + 1;
    prev = cur;
  }
  return prev[b.length];
}

function cellText(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return String(v);
  return String(v).trim();
}

export function splitCellPartNumbers(cell) {
  const text = cellText(cell);
  if (!text) return [];
  const pieces = text.split(/[\s/,;|]+/).filter(Boolean);
  const out = pieces.filter((p) => normalizePart(p).length >= 4);
  return out.length ? out : [text];
}

/** rows: array of arrays (first sheet, as read by SheetJS with header:1). */
export function buildCatalog(rows) {
  let headerIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    if ((rows[i] || []).some((c) => cellText(c).toLowerCase() === "part number")) { headerIdx = i; break; }
  }
  if (headerIdx < 0) throw new Error("Could not find a 'Part Number' header in the workbook.");
  const header = (rows[headerIdx] || []).map((c) => cellText(c).toLowerCase());
  const col = (...names) => { for (const n of names) { const i = header.indexOf(n); if (i >= 0) return i; } return -1; };
  const cPart = col("part number"), cDesc = col("description"), cModel = col("model number", "model"),
    cCont = col("container"), cInv = col("system inv", "system inventory"), cComment = col("comment", "comments");
  const get = (row, i) => (i < 0 || i >= row.length ? "" : cellText(row[i]));

  const records = [];
  const seen = new Map();
  let duplicates = 0;
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    if (cPart < 0 || cPart >= row.length) continue;
    const numbers = splitCellPartNumbers(row[cPart]);
    if (!numbers.length) continue;
    const key = normalizePart(numbers[0]);
    if (!key) continue;
    if (seen.has(key)) { duplicates++; continue; }
    const rec = {
      partNumber: numbers[0],
      row: r + 1,
      description: get(row, cDesc),
      model: get(row, cModel),
      container: get(row, cCont),
      systemInv: get(row, cInv),
      comment: get(row, cComment),
      aliases: [...new Set(numbers.map(normalizePart).filter(Boolean))].sort(),
    };
    seen.set(key, rec);
    records.push(rec);
  }
  return new PartCatalog(records, duplicates, headerIdx + 1);
}

export class PartCatalog {
  constructor(records, duplicateRows = 0, headerRow = 0) {
    this.records = records;
    this.duplicateRows = duplicateRows;
    this.headerRow = headerRow;
    this.exact = new Map();
    this.folded = new Map();
    for (const rec of records) {
      for (const alias of rec.aliases) {
        if (!this.exact.has(alias)) this.exact.set(alias, rec);
        const f = foldConfusions(alias);
        if (!this.folded.has(f)) this.folded.set(f, []);
        if (!this.folded.get(f).includes(rec)) this.folded.get(f).push(rec);
      }
    }
  }

  get size() { return this.records.length; }

  matchToken(token) {
    const norm = normalizePart(token);
    if (!norm) return { token, kind: "none", parts: [] };
    if (this.exact.has(norm)) return { token, kind: "exact", parts: [this.exact.get(norm)] };
    const folded = this.folded.get(foldConfusions(norm));
    if (folded && folded.length) return { token, kind: "confusion", parts: [...folded] };
    if (norm.length < MIN_FUZZY_LEN) return { token, kind: "none", parts: [] };
    const near = [], revision = [];
    for (const rec of this.records) {
      for (const alias of rec.aliases) {
        if (Math.abs(alias.length - norm.length) <= 1 && editDistance(norm, alias, 1) <= 1) {
          if (!near.includes(rec)) near.push(rec);
          if ((alias.startsWith(norm) || norm.startsWith(alias)) && !revision.includes(rec)) revision.push(rec);
          break;
        }
      }
    }
    if (revision.length === 1) return { token, kind: "revision", parts: revision };
    if (near.length === 1) return { token, kind: "edit1", parts: near };
    if (near.length > 1) return { token, kind: "ambiguous", parts: near };
    return { token, kind: "none", parts: [] };
  }
}

/** Distinct part-number-like tokens from OCR lines, in order. Mirrors extract_part_tokens(). */
export function extractPartTokens(lines) {
  const seen = [];   // normalized, in order
  const out = [];
  const consider = (tokRaw) => {
    const tok = tokRaw.replace(LABEL_PREFIX_RE, "");
    const norm = normalizePart(tok);
    if (norm.length < MIN_TOKEN_LEN || /^[A-Z]+$/.test(norm) || NOISE_RE.test(norm)) return;
    if (new Set(norm).size === 1) return;
    if (seen.some((s) => s.includes(norm))) return;
    for (let i = seen.length - 1; i >= 0; i--) {
      if (norm.includes(seen[i])) { seen.splice(i, 1); out.splice(i, 1); }
    }
    seen.push(norm);
    out.push(tok);
  };
  for (const line of lines) {
    const upper = String(line ?? "").toUpperCase();
    const words = upper.split(/[\s:]+/).filter(Boolean);
    for (const size of [3, 2]) {
      for (let i = 0; i + size <= words.length; i++) {
        const window = words.slice(i, i + size);
        const last = window[window.length - 1];
        if (/^[A-Z]+$/.test(last) && last.length > 2) continue;
        const joined = window.join("");
        if (PART_NUMBER_FULL.test(joined)) consider(joined);
      }
    }
    PART_NUMBER_SCAN.lastIndex = 0;
    let m;
    while ((m = PART_NUMBER_SCAN.exec(upper)) !== null) consider(m[2]);
    for (const w of words) {
      if (PART_NUMBER_FULL.test(w.replace(LABEL_PREFIX_RE, ""))) consider(w);
    }
  }
  return out;
}

export function sodeciaNumbers(tokens) {
  const out = [];
  for (const t of tokens) {
    const n = normalizePart(t);
    if (SODECIA_PN_RE.test(n) && !out.includes(n)) out.push(n);
  }
  return out;
}

/** Returns { status, matches, note, unlisted }. Mirrors classify_photo(). */
export function classify(tokens, catalog) {
  const matches = tokens.map((t) => catalog.matchToken(t));
  const exact = matches.filter((m) => m.kind === "exact");
  const nearMiss = matches.filter((m) => (m.kind === "edit1" || m.kind === "ambiguous") && SODECIA_PN_RE.test(normalizePart(m.token)));
  const possible = matches.filter((m) => m.kind === "confusion" || m.kind === "revision" || (m.kind === "edit1" && !nearMiss.includes(m)));
  const ambiguous = matches.filter((m) => m.kind === "ambiguous" && !nearMiss.includes(m));
  const unlistedAll = sodeciaNumbers(tokens);

  const result = (status, ms, note) => {
    const aliases = new Set();
    for (const m of ms) { for (const p of m.parts) for (const a of p.aliases) aliases.add(a); if (m.kind === "confusion" || m.kind === "revision") aliases.add(normalizePart(m.token)); }
    return { status, matches: ms, note, unlisted: unlistedAll.filter((n) => !aliases.has(n)) };
  };

  if (exact.length) return result("exact_match", exact, "Exact match to a part on the list.");
  if (possible.length) {
    const kinds = new Set(possible.map((m) => m.kind));
    const how = { confusion: "OCR look-alike characters (O/0, I/1, S/5, B/8)", revision: "same number with/without a trailing revision letter", edit1: "one-character difference" };
    const text = ["confusion", "revision", "edit1"].filter((k) => kinds.has(k)).map((k) => how[k]).join("; ");
    return result("possible_match", possible, `Close match via ${text}; confirm against the label.`);
  }
  if (ambiguous.length) return result("ambiguous", ambiguous, "One character away from several listed parts; confirm visually.");
  if (unlistedAll.length) {
    let note = `Sodecia number read but NOT on the list: ${unlistedAll.join(", ")}.`;
    if (nearMiss.length) {
      note += " Nearest list entries: " + nearMiss.map((m) => `${normalizePart(m.token)} is 1 character from ${m.parts.map((p) => p.partNumber).join(", ")}`).join("; ") + ".";
    }
    return result("not_in_catalog", [], note);
  }
  if (tokens.length) return result("no_match", [], `Read ${tokens.slice(0, 4).join(", ")}${tokens.length > 4 ? ", …" : ""} — customer / serial / lot numbers only; no Sodecia part number (dddddd P dd) on this label, so it cannot be on the list.`);
  return result("manual_review", [], "No part-number-like text found.");
}

/** Convenience: OCR lines -> full verdict. */
export function evaluateLines(lines, catalog) {
  const tokens = extractPartTokens(lines);
  const verdict = classify(tokens, catalog);
  const parts = [];
  for (const m of verdict.matches) for (const p of m.parts) if (!parts.includes(p)) parts.push(p);
  return { ...verdict, tokens, parts, lines };
}
