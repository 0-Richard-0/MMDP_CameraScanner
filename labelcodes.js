// Label barcodes -> container serial, label quantity and part number. Pure (shared with tests).
// Automotive shipping labels put a data identifier in front of each value:
//   P part number · Q quantity · S / 3S serial · 1J licence plate (UN + 9-character DUNS + serial) · V supplier.
// The 2D symbol repeats the same fields in one ISO 15434 message.

// Field separators as raw control characters (GS, RS, EOT) or as the control pictures a decoder prints for them.
const SEP_RE = /[\x1d\x1e\x04\u241d\u241e\u2404]+/;

/** Serial as compared between scans: no spaces, no leading zeros. */
export function canonSerial(value) {
  return String(value ?? "").toUpperCase().replace(/\s+/g, "").replace(/^0+(?=.)/, "");
}

/** Serial part of a licence plate: what follows the issuing agency (UN) and the 9-character DUNS. */
export function plateSerial(plate) {
  const m = /^UN(.{9})(.+)$/.exec(String(plate ?? "").trim());
  return canonSerial(m ? m[2] : plate);
}

/** Same container? Equal serials, or one is the tail of the other (licence plate vs. serial barcode). */
export function sameSerial(a, b) {
  const x = canonSerial(a), y = canonSerial(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 6 && long.endsWith(short);
}

function readField(raw, out) {
  const s = String(raw ?? "").trim();
  let m;
  if ((m = /^1J(.{6,40})$/.exec(s))) out.plates.add(m[1].trim());
  else if ((m = /^(3S|S)([A-Z0-9]{4,20})$/.exec(s)) && /\d/.test(m[2])) out.serials.set(canonSerial(m[2]), m[1]);
  else if ((m = /^Q(\d{1,7})$/.exec(s))) { if (Number(m[1]) > 0) out.qtys.add(Number(m[1])); }
  else if ((m = /^P([A-Z0-9][A-Z0-9 .\-]{4,24})$/.exec(s))) out.parts.add(m[1].trim().replace(/\s+/g, " "));
  else if (/^00\d{18}$/.test(s)) out.serials.set(canonSerial(s.slice(2)), "SSCC");
}

/**
 * codes: [{ format, text }] as returned by the barcode reader for one label.
 * Returns the fields that could be read. `labels` > 1 means barcodes of more than one container were in
 * view; serial and quantity are then left empty rather than guessed.
 */
export function parseBarcodes(codes) {
  const out = { plates: new Set(), serials: new Map(), qtys: new Set(), parts: new Set() };
  for (const c of codes || []) {
    for (const seg of String(c.text ?? "").replace(/\u2420/g, " ").split(SEP_RE)) readField(seg, out);
  }
  const plateOf = new Map();
  for (const plate of out.plates) {
    const tail = plateSerial(plate);
    if (!tail) continue;
    const known = [...out.serials.keys()].find((s) => sameSerial(s, tail));
    if (known) plateOf.set(known, plate);
    else { out.serials.set(tail, "1J"); plateOf.set(tail, plate); }
  }
  const ids = [...out.serials.keys()];
  const one = ids.length === 1;
  return {
    serial: one ? ids[0] : "",
    serialKind: one ? out.serials.get(ids[0]) : "",
    plate: one ? plateOf.get(ids[0]) || "" : "",
    qty: ids.length <= 1 && out.qtys.size === 1 ? [...out.qtys][0] : null,
    parts: [...out.parts],
    labels: ids.length,
    count: (codes || []).length,
  };
}
