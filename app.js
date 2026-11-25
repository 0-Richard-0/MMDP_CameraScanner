// Photo → Part Match — PWA front end. Matching logic lives in matcher.js (shared with tests).
import {
  buildCatalog, evaluateLines, normalizePart, foldConfusions, SODECIA_PN_RE, STATUS_ORDER, STATUS_LABEL, STATUS_COLOR,
} from "./matcher.js?v=1.8.2";
import {
  buildPackagingCatalog, evaluatePackaging, PKG_ORDER, PKG_LABEL, PKG_COLOR, PKG_ACTION,
} from "./packaging.js?v=1.8.2";
import { parseBarcodes, sameSerial } from "./labelcodes.js?v=1.8.2";

const VERSION = "1.8.2";
const LS_CATALOG = "ppm.catalog.v1";
const LS_PKG = "ppm.packaging.v1";
const LS_MODE = "ppm.mode.v1";
const LS_LOCATION = "ppm.location.v1";
const LS_HISTORY = "ppm.history.v1";
const LS_AUTHOR = "ppm.author.v1";
const LABEL = { ...STATUS_LABEL, ...PKG_LABEL };
const COLOR = { ...STATUS_COLOR, ...PKG_COLOR };
// Statuses that are reported straight away in live scan (others need the same read on two frames).
const CONFIDENT = new Set(["exact_match", "pkg_service", "pkg_production", "pkg_obsolete"]);
const HISTORY_CAP = 400;
const MIN_LINE_CONF = 0.45;        // recognition confidence 0-1 (same threshold as the PC tool)
const PHOTO_MAX_SIDE = 1280;       // longest side fed to detection for whole photos
const SCAN_INTERVAL_MS = 500;
const CONFIRM_DELAY_MS = 60;       // gap before the confirming frame once a number is in the box

const $ = (id) => document.getElementById(id);
const work = $("work");
const wctx = work.getContext("2d", { willReadFrequently: true });

let catalog = null;
let catalogMeta = null;
let pkgCatalog = null;
let pkgMeta = null;
let mode = localStorage.getItem(LS_MODE) === "packaging" ? "packaging" : "parts";
let worker = null;
let workerReady = null;
let stream = null;
let scanning = false;
let scanTimer = null;
let lastFrameKey = null;
let lastSavedKey = null;
let lastSavedAt = 0;
let history = [];
let torchSupported = false;
let frozen = false;
let awaitClear = false;
let lastVerdict = null;
let lastResult = null;              // { entry, dup, ... } of the last live-scan record
let lastDup = false;
let current = null;                 // History entry the quantity box under the camera belongs to
let recentCodes = [];               // barcodes seen in the last few live frames: [{ t, format, text }]
let qtyDirty = false;
let lastTiming = null;              // ms spent in the last live-scan step: { codes, text, turned } (shown on the ? tab)
const RECENT_CODES_MS = 1500;       // short, so barcodes of the label just left are not carried to the next one
const BARCODE_GRACE_MS = 1200;      // extra time for serial / quantity once some barcode of the label was read
const BARCODE_GRACE_MIN_MS = 350;   // ... and when none was read yet (labels without barcodes must not feel slower)
const SOFT_DUP_MS = 10 * 60 * 1000;
const DEFAULT_FILTER = {
  parts: ["exact_match", "possible_match", "ambiguous", "not_in_catalog"],
  packaging: ["pkg_service", "pkg_production", "pkg_obsolete", "pkg_check", "pkg_not_listed"],
};
let histFilter = new Set(DEFAULT_FILTER[mode]);

// ------------------------------------------------------------------ utilities
function toast(msg, ms = 2200) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add("hidden"), ms);
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function nowIso() { return new Date().toISOString().replace("T", " ").slice(0, 19); }

function author() { return ($("author").value || "").trim(); }
function locationText() { return ($("location").value || "").trim(); }

// ------------------------------------------------------------------ mode (parts | packaging)
const isPkg = () => mode === "packaging";
const order = () => (isPkg() ? PKG_ORDER : STATUS_ORDER);
const hasList = () => !!(isPkg() ? pkgCatalog : catalog);
const entryMode = (e) => e.mode || "parts";

/** OCR lines -> verdict for the active mode (same shape in both modes). */
function evalLines(lines) {
  return isPkg() ? evaluatePackaging(lines, pkgCatalog) : evaluateLines(lines, catalog);
}

function setMode(next) {
  if (next === mode) return;
  if (stream) stopCamera();
  mode = next;
  localStorage.setItem(LS_MODE, mode);
  histFilter = new Set(DEFAULT_FILTER[mode]);
  $("liveResult").classList.add("hidden");
  $("batchResults").innerHTML = "";
  recentCodes = []; lastResult = null; liveCtx = null;
  setCurrent(null);
  renderMode();
}

function renderMode() {
  document.body.classList.toggle("pkg", isPkg());
  document.querySelectorAll("#modeSwitch button").forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
  document.querySelector("header .title").textContent = isPkg() ? "Packaging Scan" : "Photo → Part Match";
  $("manual").placeholder = isPkg() ? "or type a CCS / packaging code, e.g. BPC.291168.001" : "or type a number, e.g. 294122P03";
  $("guide").querySelector("span").textContent = isPkg() ? "hold the CCS / packaging code inside the box" : "hold the job / part number inside the box";
  $("legend").innerHTML = order().map((s) => `<li><span class="tag" style="background:${COLOR[s]}">${esc(LABEL[s])}</span> — ${esc(isPkg() ? PKG_ACTION[s] : LEGEND_TEXT[s])}</li>`).join("");
  renderCatalogChip();
  renderHistory();
}

// ------------------------------------------------------------------ catalog
function setCatalogFromRows(rows, meta) {
  catalog = buildCatalog(rows);
  catalogMeta = { ...meta, parts: catalog.size, duplicates: catalog.duplicateRows };
  localStorage.setItem(LS_CATALOG, JSON.stringify({ rows, meta: catalogMeta }));
  renderCatalogChip();
}

function setPkgFromRows(rows, meta) {
  pkgCatalog = buildPackagingCatalog(rows);
  pkgMeta = { ...meta, parts: pkgCatalog.size };
  localStorage.setItem(LS_PKG, JSON.stringify({ rows, meta: pkgMeta }));
  renderCatalogChip();
}

function renderCatalogChip() {
  const b = $("btnList"), l = $("listLabel");
  const cat = isPkg() ? pkgCatalog : catalog, meta = isPkg() ? pkgMeta : catalogMeta;
  if (cat) {
    b.classList.add("ok");
    l.textContent = `${meta.parts} ${isPkg() ? "items" : "parts"} · ${meta.name}`;
    b.title = isPkg() ? `Packaging list loaded ${meta.loaded}. Tap to load another workbook.`
      : `Loaded ${meta.loaded} (${meta.duplicates} duplicate rows skipped). Tap to load another list.`;
  } else {
    b.classList.remove("ok");
    l.textContent = isPkg() ? "Load packaging list" : "Load part list";
  }
  $("needList").classList.toggle("hidden", !!cat);
  $("needListName").textContent = isPkg() ? "P2-02 Packaging Product Baseline .xlsb" : "obsolete cl.xlsx";
  $("btnCam").disabled = !cat;
  renderTally();
}

function restoreCatalog() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_CATALOG) || "null");
    if (saved && saved.rows) { catalog = buildCatalog(saved.rows); catalogMeta = saved.meta; }
  } catch { /* ignore corrupt cache */ }
  try {
    const saved = JSON.parse(localStorage.getItem(LS_PKG) || "null");
    if (saved && saved.rows) { pkgCatalog = buildPackagingCatalog(saved.rows); pkgMeta = saved.meta; }
  } catch { /* ignore corrupt cache */ }
  renderCatalogChip();
}

/** Published lists next to the app (partlist.json / packaging.json, written by publish_web_app_to_repo.ps1).
 *  Loaded on every open when online; a newer published list replaces an older auto-loaded one,
 *  but never replaces a list the user loaded by hand. */
async function autoLoadRemoteList() {
  await Promise.all([autoLoadOne("partlist.json", false), autoLoadOne("packaging.json", true)]);
}

async function autoLoadOne(file, pkg) {
  try {
    const res = await fetch(file, { cache: "no-cache" });
    if (!res.ok) return;
    const data = await res.json();
    if (!data || !Array.isArray(data.rows)) return;
    const stamp = data.source_modified || data.generated || "";
    const meta = pkg ? pkgMeta : catalogMeta;
    if (meta && meta.origin === "manual") return;
    if (meta && meta.origin === "published" && meta.stamp === stamp) return;
    const m = { name: `${data.source || "published list"} (${stamp})`, loaded: nowIso(), origin: "published", stamp };
    if (pkg) setPkgFromRows(data.rows, m); else setCatalogFromRows(data.rows, m);
    if (pkg === isPkg()) toast(`${pkg ? "Packaging" : "Part"} list ${stamp}: ${(pkg ? pkgCatalog : catalog).size} ${pkg ? "items" : "parts"}`);
  } catch { /* offline or not published: keep whatever is cached */ }
}

async function loadCatalogFile(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  if (isPkg()) {
    // The baseline has several sheets; use the one with a "Use status" header (Sheet1).
    const names = [...wb.SheetNames].sort((a, b) => (b === "Sheet1") - (a === "Sheet1"));
    for (const name of names) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: null });
      try { buildPackagingCatalog(rows); } catch { continue; }
      setPkgFromRows(rows, { name: file.name, loaded: nowIso(), sheet: name, origin: "manual" });
      return toast(`Loaded ${pkgCatalog.size} packaging items from ${file.name} (${name})`);
    }
    throw new Error("no sheet with a 'Use status' column");
  }
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  setCatalogFromRows(rows, { name: file.name, loaded: nowIso(), sheet: wb.SheetNames[0], origin: "manual" });
  toast(`Loaded ${catalog.size} part numbers from ${file.name}`);
}

function requireCatalog() {
  if (hasList()) return true;
  toast(`Load the ${isPkg() ? "packaging" : "part"} list first — Scan tab, Step 1`, 3500);
  switchTab("scan");
  return false;
}

function pickCatalog() {
  const inp = document.createElement("input");
  inp.type = "file";
  // Spreadsheet types only, so phone choosers offer Files / OneDrive and never the camera.
  inp.accept = ".xlsx,.xlsm,.xlsb,.xls,.csv";
  inp.onchange = () => inp.files[0] && loadCatalogFile(inp.files[0]).catch((e) => toast("Could not read list: " + e.message, 4000));
  inp.click();
}

// ------------------------------------------------------------------ OCR
// PaddleOCR PP-OCRv4 (detection + recognition) running on ONNX Runtime Web ? the same models the
// PC tool uses through RapidOCR, so phone and PC read labels the same way.
function getOcr() {
  if (workerReady) return workerReady;
  $("scanStatus").textContent = "loading OCR (first time ? 30 MB)?";
  workerReady = (async () => {
    const abs = (p) => new URL(p, document.baseURI).href;
    const { Ocr, ort } = await import("./vendor/ocr.bundle.js");
    ort.env.wasm.wasmPaths = { mjs: abs("vendor/ort-wasm-simd-threaded.js"), wasm: abs("vendor/ort-wasm-simd-threaded.wasm") };
    ort.env.wasm.numThreads = 1;          // no COOP/COEP headers on static hosting ? single thread
    ort.env.wasm.proxy = false;
    const ocr = await Ocr.create({
      models: {
        detectionPath: abs("vendor/models/ch_PP-OCRv4_det_infer.onnx"),
        recognitionPath: abs("vendor/models/ch_PP-OCRv4_rec_infer.onnx"),
        dictionaryPath: abs("vendor/models/ppocr_keys_v1.txt"),
      },
      onnxOptions: { executionProviders: ["wasm"], graphOptimizationLevel: "all" },
    });
    worker = ocr;
    return ocr;
  })();
  workerReady.catch((e) => { workerReady = null; toast("OCR failed to load: " + (e && e.message || e), 6000); });
  return workerReady;
}

/** Draw `source` (video/img/canvas) into the work canvas with optional crop, rotation and size limits. */
function prepare(source, { crop = null, rotate = 0, maxSide = 1280, minWidth = 0 } = {}) {
  const sw = source.videoWidth || source.naturalWidth || source.width;
  const sh = source.videoHeight || source.naturalHeight || source.height;
  const c = crop ? { x: crop.x * sw, y: crop.y * sh, w: crop.w * sw, h: crop.h * sh } : { x: 0, y: 0, w: sw, h: sh };
  let scale = Math.min(1, maxSide / Math.max(c.w, c.h));
  if (minWidth && c.w * scale < minWidth) scale = minWidth / c.w;
  const w = Math.round(c.w * scale), h = Math.round(c.h * scale);
  const rot = ((rotate % 360) + 360) % 360;
  work.width = rot % 180 ? h : w;
  work.height = rot % 180 ? w : h;
  wctx.save();
  wctx.fillStyle = "#fff";
  wctx.fillRect(0, 0, work.width, work.height);
  wctx.translate(work.width / 2, work.height / 2);
  wctx.rotate((rot * Math.PI) / 180);
  wctx.drawImage(source, c.x, c.y, c.w, c.h, -w / 2, -h / 2, w, h);
  wctx.restore();
  return work;
}

async function ocrCanvas(canvas) {
  const ocr = await getOcr();
  const img = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
  ocrCanvas.detail = contrastOf(img);
  const { texts } = await ocr.detect({ data: img.data, width: img.width, height: img.height });
  const kept = (texts || []).filter((t) => (t.mean ?? t.score ?? 1) >= MIN_LINE_CONF).map((t) => ({ text: String(t.text || "").trim(), box: t.box, mean: t.mean ?? t.score ?? 1 })).filter((t) => t.text);
  ocrCanvas.items = kept;                        // lines with their position in the canvas
  return kept.map((t) => t.text);
}

/** Spread of brightness in a picture (standard deviation, 0-255). A plain surface is near 0; print is not. */
function contrastOf(img) {
  let n = 0, sum = 0, sq = 0;
  for (let i = 0; i < img.data.length; i += 4 * 7) {       // every 7th pixel is plenty
    const y = (img.data[i] * 3 + img.data[i + 1] * 6 + img.data[i + 2]) / 10;
    n++; sum += y; sq += y * y;
  }
  return n ? Math.sqrt(Math.max(0, sq / n - (sum / n) ** 2)) : 0;
}

const DECISIVE = new Set(["exact_match", "possible_match", "ambiguous", "not_in_catalog",
  "pkg_service", "pkg_production", "pkg_obsolete", "pkg_check", "pkg_not_listed"]);

// ------------------------------------------------------------------ barcodes
// zxing-cpp (WebAssembly) reads the label barcodes: container serial, label quantity, part number.
// It is an addition to the text read: if it cannot load or finds nothing, scanning works as before.
const BC_OPTIONS = { formats: ["Code39", "Code128", "PDF417", "DataMatrix"], tryHarder: true, tryRotate: true,
  tryInvert: false, tryDownscale: true, textMode: "Plain", maxNumberOfSymbols: 16 };
const bcCanvas = document.createElement("canvas");
let zxingReady = null;

function getZxing() {
  if (!zxingReady) {
    zxingReady = (async () => {
      const z = await import("./vendor/zxing-reader.js");
      const wasm = new URL("vendor/zxing_reader.wasm", document.baseURI).href;
      z.prepareZXingModule({ overrides: { locateFile: (path, prefix) => (path.endsWith(".wasm") ? wasm : prefix + path) } });
      return z;
    })().catch((e) => { console.warn("barcode reader unavailable:", e); return null; });
  }
  return zxingReady;
}

/** Barcodes anywhere in `source` (video / image) -> [{ format, text }]. Never throws. */
async function readCodes(source, maxSide = 1920) {
  try {
    const z = await getZxing();
    const sw = source.videoWidth || source.naturalWidth || source.width;
    const sh = source.videoHeight || source.naturalHeight || source.height;
    if (!z || !sw || !sh) return [];
    const s = Math.min(1, maxSide / Math.max(sw, sh));
    bcCanvas.width = Math.round(sw * s); bcCanvas.height = Math.round(sh * s);
    const ctx = bcCanvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, bcCanvas.width, bcCanvas.height);
    const found = await z.readBarcodes(ctx.getImageData(0, 0, bcCanvas.width, bcCanvas.height), BC_OPTIONS);
    return found.filter((r) => r.text && r.isValid !== false).map((r) => ({ format: r.format, text: r.text }));
  } catch (e) {
    console.warn("barcode read failed:", e);
    return [];
  }
}

/** Fields for the label in view. Live frames are pooled for a few seconds because one frame rarely
 *  decodes every barcode; if the pool mixes two containers, only the current frame is used. */
function labelFields(codes, pooled = false) {
  if (!pooled) return parseBarcodes(codes);
  const now = Date.now();
  recentCodes = recentCodes.filter((c) => now - c.t < RECENT_CODES_MS).concat(codes.map((c) => ({ ...c, t: now })));
  const f = parseBarcodes(recentCodes);
  return f.labels > 1 ? parseBarcodes(codes) : f;
}

/** Barcode values that may decide the verdict: only ones that are certain. A barcode never produces
 *  "not on the list" by itself, because the number that matters may be printed text not yet read. */
function codeLines(codes, f) {
  if (isPkg()) {
    return codes.map((c) => c.text.trim()).filter((t) => t.length >= 6 && t.length <= 24).filter((t) => {
      const v = evaluatePackaging([t], pkgCatalog);
      return !v.possible && ["pkg_service", "pkg_production", "pkg_obsolete"].includes(v.status);
    });
  }
  return f.parts.filter((p) => SODECIA_PN_RE.test(normalizePart(p)) || catalog.matchToken(p).kind === "exact");
}

/** Full-image evaluation with rotation fallback: keep rotating until a Sodecia part number is found
 *  (garbage tokens from upside-down text must not stop the search). */
async function evaluateImage(source, { rotations = [0, 180, 90, 270], maxSide = PHOTO_MAX_SIDE, extra = [] } = {}) {
  let best = null;
  for (const rot of rotations) {
    const canvas = prepare(source, { rotate: rot, maxSide });
    const lines = await ocrCanvas(canvas);
    const v = evalLines(lines.concat(extra));
    v.orientation = rot;
    if (!best || v.tokens.length > best.tokens.length || (!best.lines.length && lines.length)) best = v;
    if (DECISIVE.has(v.status)) { best = v; break; }
  }
  return best;
}

// ------------------------------------------------------------------ rendering
function partHeadline(v) {
  if (v.parts.length) return v.parts.map((p) => p.partNumber).join(", ");
  if (v.unlisted.length) return v.unlisted.join(", ");
  return "—";
}

/** Serial / quantity line of a record (empty when nothing was captured). */
function codesLine(e) {
  if (!e) return "";
  const bits = [];
  if (e.serial) bits.push(`Serial <b>${esc(e.serial)}</b>`);
  if (e.qty != null) bits.push(`Qty <b>${esc(e.qty)}</b>${e.labelQty != null && e.labelQty !== e.qty ? ` (label ${esc(e.labelQty)})` : ""}`);
  else if (e.labelQty != null) bits.push(`Label qty <b>${esc(e.labelQty)}</b> — not confirmed`);
  if (e.custPart) bits.push(`Barcode part <b>${esc(e.custPart)}</b>`);
  if ((e.seen || 1) > 1) bits.push(`scanned ${e.seen}×${e.lastSeen ? `, last ${esc(e.lastSeen)}` : ""}`);
  return bits.length ? `<div class="codes">${bits.join(" · ")}</div>` : "";
}

function cardHtml(v, { thumb = "", source = "", when = "", id = null, foundBy = null, location = "", entry = null, notice = "" } = {}) {
  const color = COLOR[v.status];
  const desc = v.parts.map((p) => [p.description, p.model, p.comment].filter(Boolean).join(" · ")).filter(Boolean).join(" | ");
  const label = v.possible ? "POSSIBLE MATCH — confirm code" : LABEL[v.status];
  return `<div class="card" style="border-left-color:${color}" data-id="${id ?? ""}">
    ${thumb ? `<img class="thumb" src="${thumb}" alt="">` : ""}
    <div class="status" style="color:${color === PKG_COLOR.pkg_production ? "#8a6d00" : color}">${esc(label)}</div>
    <div class="part">${esc(partHeadline(v))}</div>
    ${desc ? `<div class="desc">${esc(desc)}</div>` : ""}
    ${notice}${codesLine(entry)}
    ${v.note ? `<div class="note">${esc(v.note)}</div>` : ""}
    ${v.tokens.length ? `<div class="tokens">read: ${esc(v.tokens.join(" · "))}</div>` : ""}
    ${foundBy !== null ? `<div class="meta">Found by: <b>${esc(foundBy || "— (type your name under the camera)")}</b>${location ? ` · Area: <b>${esc(location)}</b>` : ""}</div>` : ""}
    <div class="meta">${when ? `<span>${esc(when)}</span>` : ""}${source ? `<span>${esc(source)}</span>` : ""}</div>
  </div>`;
}

const fmtLoc = (e) => `${e.location ? ` · ${esc(e.location)}` : ""}${e.foundBy ? ` · by ${esc(e.foundBy)}` : ""}`;

/** Notice on a result: container already in History, likely repeat without a serial, or two labels in view. */
function resultNotice(r) {
  if (!r) return "";
  if (r.dup) return `<div class="dup"><b>Already recorded</b> ${esc(r.entry.when)}${fmtLoc(r.entry)} — not counted again. <button data-sep="1">Record as separate</button></div>`;
  if (r.soft) return `<div class="dup soft">Same number was recorded ${r.soft.min} min ago${fmtLoc(r.soft.entry)}. Same container? <button data-undo="${r.entry.id}">Undo this one</button></div>`;
  if (r.labels > 1) return `<div class="dup soft">Barcodes of ${r.labels} containers were in view, so serial and quantity were not recorded. Scan one label at a time.</div>`;
  return "";
}

let liveCtx = null;

function renderResult(v, thumb, r, source) {
  lastVerdict = v;
  lastDup = !!(r && r.dup);
  liveCtx = { v, thumb, r, source, when: nowIso() };
  refreshLive();
  $("liveResult").classList.remove("hidden");
  if (r) setCurrent(DECISIVE.has(v.status) || v.status === "no_match" ? r.entry : null, r);
}

function refreshLive() {
  if (!liveCtx) return;
  const { v, thumb, r, source, when } = liveCtx;
  $("liveResult").innerHTML = cardHtml(v, { thumb, source, when, entry: r && r.entry, notice: resultNotice(r) });
}

function showLive(v, thumb, r = null) {
  renderResult(v, thumb, r, "live scan");
  $("guide").classList.toggle("hit", DECISIVE.has(v.status));
}

// ------------------------------------------------------------------ quantity box (under the camera)
function setCurrent(entry, r = null) {
  current = entry;
  qtyDirty = false;
  $("qtyRow").classList.toggle("hidden", !entry);
  $("qtyInfo").classList.toggle("hidden", !entry);
  if (!entry) return;
  $("qty").value = entry.qty ?? entry.labelQty ?? "";
  $("btnQty").textContent = entry.qty != null ? "Saved ✓" : "Save qty";
  const serial = entry.serial ? `Serial ${entry.serial}` : "";
  $("qtyInfo").textContent = r && r.dup
    ? (entry.qty != null ? `${serial} is already recorded with quantity ${entry.qty}. Change it and Save to correct it.`
      : `${serial} is already recorded, no count saved yet${entry.labelQty != null ? ` (label says ${entry.labelQty})` : ""}. Type the count, then Save.`)
    : entry.labelQty != null ? `${serial ? serial + " · l" : "L"}abel says ${entry.labelQty} — change it if the count is different, then Save.`
    : serial ? `${serial} · no quantity barcode read — type the count, then Save.`
    : "No barcode read — type the count if you have it. Keep the whole label in view to pick up serial and quantity.";
}

/** Store the counted quantity on the current record. `quiet` is used when leaving the record (Resume). */
function saveQty(quiet = false) {
  if (!current) return false;
  const raw = $("qty").value.trim();
  if (!/^\d{1,7}$/.test(raw)) { if (!quiet) toast("Type the quantity as a whole number"); return false; }
  current.qty = Number(raw);
  qtyDirty = false;
  saveHistory();
  $("btnQty").textContent = "Saved ✓";
  refreshLive();
  return true;
}

// ------------------------------------------------------------------ history
function loadHistory() {
  try { history = JSON.parse(localStorage.getItem(LS_HISTORY) || "[]"); } catch { history = []; }
  renderHistory();
}

function saveHistory() {
  while (history.length > HISTORY_CAP) history.pop();
  try { localStorage.setItem(LS_HISTORY, JSON.stringify(history)); }
  catch { // storage full: drop thumbnails of oldest entries
    for (let i = history.length - 1; i >= 0 && i > 50; i--) history[i].thumb = "";
    try { localStorage.setItem(LS_HISTORY, JSON.stringify(history)); } catch { /* give up silently */ }
  }
  renderHistory();
}

function thumbnailOf(source, size = 160) {
  const sw = source.videoWidth || source.naturalWidth || source.width;
  const sh = source.videoHeight || source.naturalHeight || source.height;
  const s = Math.min(1, size / Math.max(sw, sh));
  const c = document.createElement("canvas");
  c.width = Math.round(sw * s); c.height = Math.round(sh * s);
  c.getContext("2d").drawImage(source, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.6);
}

/** The part of a record that comes from the verdict (what was read and what it matched). */
function verdictFields(v, thumb, f) {
  const known = new Set([...v.parts.map((p) => p.partNumber), ...v.unlisted].map(normalizePart));
  return {
    status: v.status,
    possible: !!v.possible,
    parts: v.parts.map((p) => p.partNumber),
    description: v.parts.map((p) => p.description).filter(Boolean).join("; "),
    internal: isPkg() ? v.parts.map((p) => p.model).filter(Boolean).join("; ") : "",
    comment: v.parts.map((p) => p.comment).filter(Boolean).join("; "),
    unlisted: v.unlisted,
    tokens: v.tokens,
    lines: v.lines,
    note: v.note,
    thumb,
    // Part number from the barcode when it is not the number already matched (usually the customer's number).
    custPart: f && !isPkg() ? f.parts.filter((p) => !known.has(normalizePart(p))).join("; ") : "",
  };
}

function addHistory(v, { thumb, source, name }, f = null) {
  const entry = {
    id: Date.now() + Math.random().toString(16).slice(2, 6),
    mode,
    when: nowIso(),
    source, name,
    foundBy: author(),
    location: locationText(),
    ...verdictFields(v, thumb, f),
    serial: f ? f.serial : "",
    serialKind: f ? f.serialKind : "",
    plate: f ? f.plate : "",
    labelQty: f ? f.qty : null,
    qty: null,
    seen: 1,
    lastSeen: "",
  };
  history.unshift(entry);
  saveHistory();
  if (!entry.foundBy && !addHistory.nagged && entry.status !== "manual_review" && entry.status !== "pkg_none") {
    addHistory.nagged = true;
    toast("Tip: type your name in “Found by” so finds are attributed to you", 4000);
  }
  return entry;
}

const whenMs = (when) => Date.parse(String(when).replace(" ", "T") + "Z");   // History times are UTC
const headline = (e) => (e.parts.length ? e.parts : e.unlisted).join(", ");

/** Record of the container with this serial in the active mode, if it was scanned before. */
function findBySerial(serial) {
  return serial ? history.find((e) => entryMode(e) === mode && e.serial && sameSerial(e.serial, serial)) : undefined;
}

/** Small line over the camera showing what the barcodes have given so far, so it is visible that they are being read. */
function showCodeInfo(f) {
  const bits = [];
  if (f) {
    if (f.labels > 1) bits.push(`${f.labels} labels in view`);
    if (f.serial) bits.push(`serial ${f.serial}`);
    if (f.qty != null) bits.push(`qty ${f.qty}`);
    if (!bits.length && f.parts.length) bits.push(`part ${f.parts[0]}`);
    if (!bits.length && f.count) bits.push("read");
  }
  $("codeInfo").textContent = bits.length ? `barcode: ${bits.join(" · ")}` : "";
}

/**
 * Record a result. A container whose serial is already in this mode's History is not added again:
 * its record is updated (times scanned, missing label quantity) and returned with dup = true.
 * Without a serial a repeat cannot be proven; in Parts mode the same number in the same area within
 * ten minutes is flagged (soft) so it can be undone.
 * Returns { entry, dup, soft, labels }.
 */
function record(v, info, f = null, { forceNew = false } = {}) {
  const labels = f ? f.labels : 0;
  if (f && f.serial && !forceNew) {
    const old = findBySerial(f.serial);
    if (old) {
      old.seen = (old.seen || 1) + 1;
      old.lastSeen = nowIso();
      if (old.labelQty == null && f.qty != null) old.labelQty = f.qty;
      if (!old.plate && f.plate) old.plate = f.plate;
      // First scan got the barcode but not the number; this one did: keep the better read on the same record.
      if (!DECISIVE.has(old.status) && DECISIVE.has(v.status)) Object.assign(old, verdictFields(v, info.thumb, f));
      history = [old, ...history.filter((e) => e !== old)];   // History lists the latest scan first, repeats included
      saveHistory();
      return { entry: old, dup: true, soft: null, labels, pending: { v, info, f } };
    }
  }
  const entry = addHistory(v, info, f);
  let soft = null;
  if (!isPkg() && !entry.serial && DECISIVE.has(entry.status) && info.source !== "photos") {
    const prev = history.find((e) => e !== entry && entryMode(e) === mode && !e.serial && headline(e) === headline(entry)
      && (e.location || "") === (entry.location || "") && whenMs(entry.when) - whenMs(e.when) < SOFT_DUP_MS);
    if (prev) soft = { entry: prev, min: Math.max(1, Math.round((whenMs(entry.when) - whenMs(prev.when)) / 60000)) };
  }
  return { entry, dup: false, soft, labels };
}

/** "Record as separate" on an already-recorded notice: the operator says it is a different container. */
function recordSeparate() {
  const p = liveCtx && liveCtx.r && liveCtx.r.pending;
  if (!p) return;
  const r = record(p.v, p.info, p.f, { forceNew: true });
  if (lastResult === liveCtx.r) lastResult = r;
  liveCtx.r = r;
  lastDup = false;
  refreshLive();
  setCurrent(r.entry, r);
  if (frozen) holdResult(p.v, false);
  toast("Recorded as a separate container");
}

/** "Undo this one" on a likely-repeat notice: remove the record that was just added. */
function undoRecord(id) {
  history = history.filter((e) => e.id !== id);
  saveHistory();
  if (liveCtx) liveCtx.r = null;
  setCurrent(null);
  refreshLive();
  toast("Removed — the earlier record is kept");
}

/** History: set or correct the counted quantity of a record (inline editor in the card). */
let qtyEditId = null;

function qtyEditorHtml(e) {
  return `<input class="qtyEdit" inputmode="numeric" pattern="[0-9]*" placeholder="count${e.labelQty != null ? ` (label ${e.labelQty})` : ""}" value="${esc(e.qty ?? e.labelQty ?? "")}">
    <button class="primary" data-qtysave="${e.id}">Save</button><button data-qtycancel="1">Cancel</button>`;
}

function saveQtyEdit(id) {
  const e = history.find((x) => x.id === id);
  const inp = document.querySelector("#histList .qtyEdit");
  if (!e || !inp) return;
  if (!/^\d{1,7}$/.test(inp.value.trim())) return toast("Type the quantity as a whole number");
  e.qty = Number(inp.value.trim());
  qtyEditId = null;
  saveHistory();
  if (current === e) setCurrent(e);
  refreshLive();
}

function entryToVerdict(e) {
  return {
    status: e.status, note: e.note, tokens: e.tokens, unlisted: e.unlisted, lines: e.lines, possible: e.possible,
    parts: e.parts.map((pn, i) => ({ partNumber: pn, description: i === 0 ? e.description : "", comment: i === 0 ? e.comment : "", model: i === 0 ? (e.internal || "") : "" })),
  };
}

function renderHistory() {
  const mine = history.filter((e) => entryMode(e) === mode);
  $("histCount").textContent = mine.length ? String(mine.length) : "";
  const q = ($("histSearch").value || "").trim().toUpperCase();
  const shown = mine.filter((e) => histFilter.has(e.status) && (!q || [e.name, e.foundBy, e.location, e.description, e.serial, e.custPart, ...e.parts, ...e.unlisted, ...e.tokens].join(" ").toUpperCase().includes(q)));
  // Results whose filter is switched off (e.g. "Number read — not a Sodecia part number") would otherwise look lost.
  const off = mine.filter((e) => !histFilter.has(e.status)).length;
  const offNote = off ? `<p class="hint hiddenNote">${off} more result${off > 1 ? "s are" : " is"} hidden by the filters above. <button data-showall="1">Show all</button></p>` : "";
  $("histList").innerHTML = offNote + (shown.length
    ? shown.map((e) => cardHtml(entryToVerdict(e), { thumb: e.thumb, source: `${e.source}${e.name ? " · " + e.name : ""}`, when: e.when, id: e.id, foundBy: e.foundBy || "", location: e.location || "", entry: e })
        .replace("</div>\n  </div>", `</div><div class="actions">${qtyEditId === e.id ? qtyEditorHtml(e) : `<button data-qty="${e.id}">Qty</button><button data-del="${e.id}">Delete</button>`}</div></div>`)).join("")
    : `<p class="hint">Nothing here yet${mine.length ? " for the selected filters" : ""}.</p>`);
  const counts = Object.fromEntries(order().map((s) => [s, mine.filter((e) => e.status === s).length]));
  $("histFilters").innerHTML = order().map((s) =>
    `<button class="filter ${histFilter.has(s) ? "on" : ""}" data-f="${s}" style="--c:${COLOR[s]}">${esc(LABEL[s])} ${counts[s]}</button>`).join("");
  renderTally();
}

/** Packaging: running count of pink / yellow / grey tags on this phone, for planning space. */
function renderTally() {
  const el = $("tally");
  if (!isPkg()) { el.classList.add("hidden"); return; }
  const today = nowIso().slice(0, 10);
  const mine = history.filter((e) => entryMode(e) === "packaging" && !e.possible);
  const keys = ["pkg_service", "pkg_production", "pkg_obsolete", "pkg_not_listed", "pkg_check"];
  const short = { pkg_service: "Service", pkg_production: "Production", pkg_obsolete: "Don't use", pkg_not_listed: "Not listed", pkg_check: "Check" };
  el.innerHTML = keys.map((k) => {
    const all = mine.filter((e) => e.status === k).length;
    const t = mine.filter((e) => e.status === k && e.when.startsWith(today)).length;
    return `<div class="tile ${k}" style="--c:${COLOR[k]}"><b>${all}</b><span>${short[k]}</span><small>${t} today</small></div>`;
  }).join("");
  el.classList.remove("hidden");
}

function historyCsv(which = mode) {
  const q = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const list = history.filter((e) => entryMode(e) === which);
  // 1.8.0 columns go after the existing ones so sheets built on the earlier export keep their positions.
  const moreCols = ["serial", "serial_type", "licence_plate", "label_qty", "counted_qty", "barcode_part_number", "times_scanned", "last_scanned", "record_id"];
  // Excel keeps 15 digits of a number: a longer all-digit serial (pallet SSCC) is written as text.
  const longId = (s) => (/^\d{16,}$/.test(s) ? `="${s}"` : s);
  const more = (e) => [longId(e.serial || ""), e.serialKind || "", e.plate || "", e.labelQty ?? "", e.qty ?? "", e.custPart || "", e.seen || 1, e.lastSeen || "", e.id];
  if (which === "packaging") {
    const cols = ["when", "found_by", "area_location", "source", "image_name", "status", "tag_colour", "use_status", "ccs_code",
      "material_item", "internal_pn", "possible_match", "codes_read", "ocr_text", "notes", ...moreCols];
    const colour = { pkg_service: "PINK", pkg_production: "YELLOW", pkg_obsolete: "GREY" };
    const rows = list.map((e) => [e.when, e.foundBy || "", e.location || "", e.source, e.name, LABEL[e.status], e.possible ? "" : colour[e.status] || "",
      e.comment, e.parts.join("; ") || e.unlisted.join("; "), e.description, e.internal || "", e.possible ? "yes" : "",
      e.tokens.join("; "), (e.lines || []).join(" | "), e.note, ...more(e)].map(q).join(","));
    return "\uFEFF" + [cols.join(","), ...rows].join("\r\n");
  }
  const cols = ["when", "found_by", "area_location", "source", "image_name", "status", "matched_part_numbers", "catalog_description", "catalog_comment",
    "sodecia_numbers_not_in_catalog", "part_tokens", "ocr_text", "notes", ...moreCols];
  const rows = list.map((e) => [e.when, e.foundBy || "", e.location || "", e.source, e.name, e.status, e.parts.join("; "), e.description, e.comment,
    e.unlisted.join("; "), e.tokens.join("; "), (e.lines || []).join(" | "), e.note, ...more(e)].map(q).join(","));
  return "\uFEFF" + [cols.join(","), ...rows].join("\r\n");
}

async function exportCsv(share) {
  if (!history.some((e) => entryMode(e) === mode)) return toast("History is empty");
  const name = `${isPkg() ? "packaging_scan" : "photo_part_match"}_${new Date().toISOString().slice(0, 10)}.csv`;
  const blob = new Blob([historyCsv()], { type: "text/csv" });
  const file = new File([blob], name, { type: "text/csv" });
  if (share && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: isPkg() ? "Packaging scan" : "Photo part match" }); return; } catch { /* fall through */ }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ------------------------------------------------------------------ sound
const LS_SOUND = "ppm.sound.v1";
let audioCtx = null;
let soundOn = localStorage.getItem(LS_SOUND) !== "off";

/** Must be called from a user gesture once (iOS); safe to call repeatedly. */
function unlockAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch { /* no audio available */ }
}

function tone(freq, start, dur, gain = 0.6, type = "square") {
  const o = audioCtx.createOscillator(), g = audioCtx.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(gain, start + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  o.connect(g).connect(audioCtx.destination);
  o.start(start); o.stop(start + dur + 0.05);
}

/** Loud, repeated patterns for a noisy shop floor. */
function playResult(status) {
  if (!soundOn) return;
  unlockAudio();
  if (!audioCtx) return;
  const t = audioCtx.currentTime + 0.01;
  if (status === "pkg_service") {             // pink: high two-tone chime, three times
    for (const off of [0, 0.5, 1.0]) { tone(1319, t + off, 0.14); tone(988, t + off + 0.16, 0.22); }
    return;
  }
  if (status === "pkg_production") status = "exact_match";       // yellow: rising fanfare
  if (status === "pkg_obsolete" || status === "pkg_not_listed") status = "not_in_catalog";   // grey / red: low buzz
  if (status === "pkg_check") status = "possible_match";          // orange: blips
  if (status === "exact_match") {            // rising three-note fanfare, twice
    for (const off of [0, 0.75]) { tone(880, t + off, 0.16); tone(1175, t + off + 0.17, 0.16); tone(1568, t + off + 0.34, 0.32); }
  } else if (status === "not_in_catalog" || status === "no_match") {   // low double buzz, twice: not on the list
    for (const off of [0, 0.7]) { tone(240, t + off, 0.22, 0.6, "sawtooth"); tone(180, t + off + 0.26, 0.30, 0.6, "sawtooth"); }
  } else if (status === "possible_match" || status === "ambiguous") {  // three quick blips: look at it
    for (const off of [0, 0.55]) { tone(620, t + off, 0.10); tone(620, t + off + 0.15, 0.10); tone(620, t + off + 0.30, 0.10); }
  }
}

/** Four falling notes: this container is already recorded (deliberately unlike every verdict sound). */
function playDuplicate() {
  if (!soundOn) return;
  unlockAudio();
  if (!audioCtx) return;
  const t = audioCtx.currentTime + 0.01;
  for (const off of [0, 0.75]) [988, 784, 659, 523].forEach((f, i) => tone(f, t + off + i * 0.13, 0.11, 0.6, "triangle"));
}

const FX_COLOR = { exact_match: "#2e7d32", possible_match: "#ef6c00", ambiguous: "#ef6c00", not_in_catalog: "#c62828", no_match: "#c62828",
  pkg_service: PKG_COLOR.pkg_service, pkg_production: PKG_COLOR.pkg_production, pkg_obsolete: PKG_COLOR.pkg_obsolete,
  pkg_check: PKG_COLOR.pkg_check, pkg_not_listed: PKG_COLOR.pkg_not_listed };

/** Light chasing the screen perimeter + short tint, in the verdict colour. */
// Big word shown over the camera with the chase, and kept on a held frame until Resume.
const FX_WORD = {
  exact_match: "ON LIST", possible_match: "CONFIRM", ambiguous: "CONFIRM", not_in_catalog: "NOT ON LIST", no_match: "NO PART #",
  pkg_service: "SERVICE", pkg_production: "PRODUCTION", pkg_obsolete: "DON'T USE", pkg_check: "CHECK", pkg_not_listed: "NOT LISTED",
};
// Text colour that stays readable on each background (yellow needs dark text).
const fxInk = (status) => (status === "pkg_production" ? "#2b2200" : "#fff");

const DUP_WORD = "ALREADY RECORDED";
const wordHtml = (status, dup) => `${esc(FX_WORD[status] || "")}${dup ? `<small>${DUP_WORD}</small>` : ""}`;

function showVerdictFx(status, ms = 10000, dup = false) {
  const color = FX_COLOR[status];
  const fx = $("verdictFx");
  if (!color) return;
  fx.classList.add("hidden");
  void fx.offsetWidth;                        // restart the CSS animations
  fx.style.setProperty("--c", color);
  fx.style.setProperty("--ink", fxInk(status));
  fx.querySelector(".word").innerHTML = wordHtml(status, dup);
  fx.classList.remove("hidden");
  clearTimeout(showVerdictFx._t);
  showVerdictFx._t = setTimeout(() => fx.classList.add("hidden"), ms);
}

function hideVerdictFx() {
  clearTimeout(showVerdictFx._t);
  $("verdictFx").classList.add("hidden");
}

function buzz(status) {
  if (!navigator.vibrate) return;
  navigator.vibrate(status === "exact_match" || status === "pkg_production" || status === "pkg_service" ? [120, 60, 120, 60, 250]
    : status === "possible_match" || status === "ambiguous" || status === "pkg_check" ? [80, 60, 80, 60, 80] : [300, 100, 300]);
}

/** Everything that should happen when a verdict is produced for the user. A container that is already
 *  recorded keeps its tag colour and word but gets its own sound and vibration. */
function announce(status, possible = false, dup = false) {
  if (possible) status = isPkg() ? "pkg_check" : "possible_match";
  if (dup) { playDuplicate(); if (navigator.vibrate) navigator.vibrate([60, 40, 60, 40, 60, 40, 60]); }
  else { playResult(status); buzz(status); }
  showVerdictFx(status, 10000, dup);
}

function renderSoundButton() {
  const b = $("btnSound");
  b.textContent = soundOn ? "🔔" : "🔕";
  b.title = soundOn ? "Sound on — tap to mute" : "Sound off — tap to enable";
}

// ------------------------------------------------------------------ camera / live scan
const GUIDE = { x: 0.07, y: 0.38, w: 0.86, h: 0.20 };
const ROT_FALLBACK = [180, 90, 270];
let rotIdx = 0;

const LS_CAM = "ppm.camera.v1";      // deviceId of the rear camera that has the flash (Android multi-lens phones)
const IS_IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getCamera(deviceId) {
  const size = { width: { ideal: 1920 }, height: { ideal: 1080 } };
  return navigator.mediaDevices.getUserMedia({
    video: deviceId ? { deviceId: { exact: deviceId }, ...size } : { facingMode: { ideal: "environment" }, ...size }, audio: false,
  });
}

async function useStream(s) {
  stream = s;
  const video = $("video");
  video.srcObject = s;
  await video.play().catch(() => {});
}

async function startCamera() {
  if (!requireCatalog()) return;
  unlockAudio();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return toast("Camera not available in this browser; use the Photos tab.", 4000);
  let s = null;
  const saved = localStorage.getItem(LS_CAM);
  if (saved) { try { s = await getCamera(saved); } catch { localStorage.removeItem(LS_CAM); } }
  if (!s) {
    try { s = await getCamera(null); } catch (e) { return toast("Camera permission denied or unavailable: " + e.message, 4000); }
  }
  await useStream(s);
  document.body.classList.add("camOn");
  $("btnCam").textContent = "Stop live scan";
  $("btnShot").disabled = false;
  const track = stream.getVideoTracks()[0];
  $("btnTorch").disabled = false;
  $("btnTorch").title = "Flashlight";
  // Chrome needs a moment before torch shows up in capabilities; re-check lazily for the tooltip only.
  setTimeout(() => { try { torchSupported = !!(track.getCapabilities && track.getCapabilities().torch); } catch { /* ignore */ } }, 1500);
  getOcr().then(() => { $("scanStatus").textContent = "scanning…"; scanning = true; scheduleScan(0); });
}

function stopCamera() {
  scanning = false;
  frozen = false;
  clearTimeout(scanTimer);
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  document.body.classList.remove("camOn");
  $("video").srcObject = null;
  $("btnCam").textContent = "Start live scan";
  $("btnShot").disabled = true;
  $("btnShot").textContent = "Capture frame";
  $("btnTorch").disabled = true;
  $("btnTorch").style.background = "";
  toggleTorch.on = false;
  $("scanStatus").textContent = "camera off";
  $("guide").classList.remove("hit", "busy");
  showCodeInfo(null);
  releaseHold();
  awaitClear = false;
  recentCodes = [];
  focus = null; stickyRot = 0; lastWholeKey = null; weakTicks = 0; serialOnlyTicks = 0; wholeAfter = 0;
  setZoom(1);
}

// ------------------------------------------------------------------ manual entry
function checkManual() {
  if (!requireCatalog()) return;
  const raw = ($("manual").value || "").trim();
  if (!raw) return toast(isPkg() ? "Type a CCS / packaging code first" : "Type a part / job number first");
  const v = evalLines([raw]);
  if (isPkg() && v.status === "pkg_none") {
    v.status = "pkg_not_listed"; v.tokens = [raw]; v.unlisted = [raw];
    v.note = `"${raw}" is not on the packaging list — record it for review.`;
  }
  if (!isPkg() && !v.tokens.length) {           // too short / not number-like for the extractor: still try it verbatim
    const m = catalog.matchToken(raw);
    if (m.kind !== "none") {
      v.tokens = [raw]; v.matches = [m]; v.parts = m.parts;
      v.status = m.kind === "exact" ? "exact_match" : m.kind === "ambiguous" ? "ambiguous" : "possible_match";
      v.note = m.kind === "exact" ? "Exact match to a part on the list." : "Close to a listed part; confirm.";
    } else {
      v.status = "no_match"; v.tokens = [raw]; v.note = `"${raw}" is not a Sodecia part number (dddddd P dd) and matches nothing on the list.`;
    }
  }
  const r = record(v, { thumb: "", source: "manual", name: raw });
  renderResult(v, "", r, "typed: " + raw);
  announce(v.status);
  $("manual").select();
}

function scheduleScan(ms) { clearTimeout(scanTimer); if (scanning) scanTimer = setTimeout(scanOnce, ms); }

let focus = null;        // { crop, rot, key }: where the number read on the last frame sits, for a quick confirming read
let lastWholeKey = null; // result of the last whole-label read that still needs a second read
let weakTicks = 0;       // frames in a row whose box held numbers but no part number
let serialOnlyTicks = 0; // frames in a row with a serial barcode but no number in the box
let wholeAfter = 0;      // earliest time for the next whole-label read after one that found nothing
let stickyRot = 0;       // turn (degrees) that gave a number on the last frame; tried first on the next one
const EMPTY_BOX_CONTRAST = 10;   // below this the box shows a plain surface: nothing to read turned

const sameDigits = (text) => foldConfusions(normalizePart(text));

/** Read the text of the whole camera picture (not just the box): upright, and turned round when the
 *  upright read is not clearly an upright label. Returns { v, items, w, h, twice }; `twice` says the
 *  number was read on two separate lines (a label prints the job number in two places). */
async function readWhole(video, extra) {
  let best = null;
  for (const rot of [0, 180]) {
    const canvas = prepare(video, { rotate: rot, maxSide: PHOTO_MAX_SIDE });
    const v = evalLines((await ocrCanvas(canvas)).concat(extra));
    v.orientation = rot;
    const items = ocrCanvas.items;
    if (!best || DECISIVE.has(v.status) || v.tokens.length > best.v.tokens.length) best = { v, items, w: canvas.width, h: canvas.height };
    const upright = items.length >= 6 && items.reduce((s, it) => s + it.mean, 0) / items.length >= 0.85;
    if (DECISIVE.has(v.status) || upright) break;
  }
  const numbers = [...best.v.parts.map((p) => p.partNumber), ...best.v.unlisted].map(sameDigits).filter(Boolean);
  best.twice = numbers.length > 0 && numbers.every((n) => best.items.filter((it) => sameDigits(it.text).includes(n)).length >= 2);
  return best;
}

/** What a live frame says, as one string: two frames with the same key confirm each other. */
function scanKey(v) {
  if (v.status === "manual_review" || v.status === "pkg_none") return null;
  return `${v.status}|${partHeadline(v)}|${v.status === "no_match" ? v.tokens.slice(0, 3).join(",") : ""}`;
}

/** Part of the video frame (fractions) that holds the lines the verdict came from, with a margin.
 *  `crop` is the part of the frame the read covered and `rot` (0 or 180) how it was turned.
 *  Null when those lines cannot be pinned down; the next frame then reads the whole box again. */
function focusCrop(v, { items, w, h }, crop, rot = 0) {
  const want = [...v.parts.map((p) => p.partNumber), ...v.unlisted, ...(v.status === "no_match" ? v.tokens.slice(0, 3) : [])].map(sameDigits).filter(Boolean);
  const hits = want.map((n) => items.find((it) => sameDigits(it.text).includes(n)));
  if (!want.length || hits.some((it) => !it)) return null;
  const pts = hits.flatMap((it) => it.box || []);
  if (!pts.length || pts.some((p) => !Array.isArray(p) || !isFinite(p[0]) || !isFinite(p[1]))) return null;
  const x0 = Math.min(...pts.map((p) => p[0])), x1 = Math.max(...pts.map((p) => p[0]));
  const y0 = Math.min(...pts.map((p) => p[1])), y1 = Math.max(...pts.map((p) => p[1]));
  const lineH = (y1 - y0) / hits.length;
  const mx = lineH, my = lineH * 0.6;
  let fx0 = Math.max(0, (x0 - mx) / w), fx1 = Math.min(1, (x1 + mx) / w);
  let fy0 = Math.max(0, (y0 - my) / h), fy1 = Math.min(1, (y1 + my) / h);
  if (rot === 180) { [fx0, fx1] = [1 - fx1, 1 - fx0]; [fy0, fy1] = [1 - fy1, 1 - fy0]; }
  if (fx1 - fx0 < 0.02 || fy1 - fy0 < 0.02) return null;
  return { x: crop.x + fx0 * crop.w, y: crop.y + fy0 * crop.h, w: (fx1 - fx0) * crop.w, h: (fy1 - fy0) * crop.h };
}

async function scanOnce() {
  if (!scanning || !stream || frozen) return;
  const video = $("video");
  if (video.readyState < 2) return scheduleScan(200);
  let next = SCAN_INTERVAL_MS;
  try {
    // The guide box in screen space maps to the video frame after object-fit: cover (and digital zoom).
    const crop = coverCrop(video, GUIDE);
    // Barcodes are read from the whole frame (they sit elsewhere on the label than the number in the box).
    const t0 = performance.now();
    const codes = await readCodes(video);
    const fields = labelFields(codes, true);
    const extra = codeLines(codes, fields);
    const t1 = performance.now();
    let v = null;
    let certain = false;                 // true: the verdict needs no confirming frame
    let tText = 0, tTurned = 0;
    // 1. A container already in History is known by its serial: its recorded numbers are checked against
    //    the current list, without reading the text again.
    const known = findBySerial(fields.serial);
    if (known && DECISIVE.has(known.status)) {
      const again = evalLines((known.parts.length ? known.parts : known.unlisted).concat(extra));
      if (again.status === known.status && !!again.possible === !!known.possible) { v = again; certain = true; }
    }
    // 2. A barcode that is itself an exact list match needs no text read either.
    if (!v && extra.length) {
      const byCode = evalLines(extra);
      if (CONFIDENT.has(byCode.status) && !byCode.possible) v = byCode;
    }
    // 3. Second frame of a number seen on the previous one: read only the line(s) that hold it.
    if (!v && focus && focus.key === lastFrameKey) {
      const ta = performance.now();
      const quick = evalLines((await ocrCanvas(prepare(video, { crop: focus.crop, rotate: focus.rot, maxSide: 1100, minWidth: 700 }))).concat(extra));
      quick.orientation = focus.rot;
      tText = performance.now() - ta;
      if (scanKey(quick) === focus.key) v = quick;
    }
    focus = null;
    // 4. Read the whole box. Nothing usable upright: try the label upside down, then sideways (one turn per
    //    frame to stay fast). A turn that gave a number is tried first on the next frame so it can be
    //    confirmed; a box showing a plain surface has nothing to turn.
    if (!v) {
      const turns = stickyRot ? [stickyRot, 0] : [0, ROT_FALLBACK[rotIdx % ROT_FALLBACK.length]];
      const reads = {};
      for (let i = 0; i < turns.length; i++) {
        if (i > 0 && (DECISIVE.has(v.status) || ocrCanvas.detail < EMPTY_BOX_CONTRAST)) break;
        if (i > 0 && !stickyRot) rotIdx++;
        const rot = turns[i];
        const ta = performance.now();
        const canvas = prepare(video, { crop, rotate: rot, maxSide: 1100, minWidth: rot % 180 ? 0 : 800 });
        const cand = evalLines((await ocrCanvas(canvas)).concat(extra));
        cand.orientation = rot;
        reads[rot] = { items: ocrCanvas.items, w: canvas.width, h: canvas.height };
        if (i === 0) tText += performance.now() - ta; else tTurned = performance.now() - ta;
        if (!v || DECISIVE.has(cand.status) || cand.tokens.length > v.tokens.length) v = cand;
      }
      stickyRot = v.orientation && scanKey(v) ? v.orientation : 0;
      if (v.orientation % 180 === 0 && scanKey(v)) {
        const tight = focusCrop(v, reads[v.orientation], crop, v.orientation);
        if (tight) focus = { crop: tight, rot: v.orientation, key: scanKey(v) };
      }
    }
    lastTiming = { codes: Math.round(t1 - t0), text: Math.round(tText), turned: Math.round(tTurned) };
    // Anything with a readable number is reportable: matches, unlisted Sodecia numbers, and labels where
    // only customer / serial numbers were read (so the user knows the label was seen but holds no part number).
    let key = scanKey(v);
    // After Resume, the label just reported is ignored until it leaves the view; then the next box with
    // the same code counts as a new scan (several identical boxes in a row). A different serial is a
    // different container even when the number is the same, so it counts straight away.
    const lastSerial = lastResult ? lastResult.entry.serial : "";
    const otherContainer = !!(fields.serial && lastSerial && !sameSerial(fields.serial, lastSerial));
    const sameContainer = !!(fields.serial && lastSerial && sameSerial(fields.serial, lastSerial));
    const weak = v.status === "no_match";      // numbers in the box, none of them a part number
    const waitNext = () => {
      $("scanStatus").textContent = "move to the next label…"; $("guide").classList.remove("busy");
      scheduleScan(SCAN_INTERVAL_MS);
    };
    if (awaitClear) {
      if (sameContainer || (key && key === lastSavedKey && !otherContainer)) return waitNext();
      if (!key || otherContainer) { awaitClear = false; lastSavedKey = null; }
      else if (!weak) awaitClear = false;
      // weak: other numbers on a label do not say which label it is; decided after the whole-label read below
    }
    $("scanStatus").textContent = key ? `reading ${partHeadline(v) !== "—" ? partHeadline(v) : v.tokens[0] || ""}…` : "looking for a number…";
    $("guide").classList.toggle("busy", !!key);
    showCodeInfo(fields);
    let hit = !!key && (certain || key === lastFrameKey || (CONFIDENT.has(v.status) && !v.possible));
    // The box holds numbers but no part number, or only a barcode was read: the job number is usually
    // somewhere else on the label, so the whole picture is read before anything is concluded.
    weakTicks = weak ? weakTicks + 1 : 0;
    serialOnlyTicks = !key && fields.serial ? serialOnlyTicks + 1 : 0;
    const now = Date.now();
    const justTried = now < wholeAfter - 1500;                           // a whole-label read found nothing a moment ago
    const labelInView = (weak && (fields.serial || weakTicks >= 2)) || serialOnlyTicks >= 2;
    if (!isPkg() && !certain && !justTried && ((hit && weak) || (labelInView && now >= wholeAfter))) {
      $("scanStatus").textContent = "reading the whole label…";
      $("guide").classList.add("busy");
      const tw = performance.now();
      const whole = await readWhole(video, extra);
      lastTiming.whole = Math.round(performance.now() - tw);
      if (!scanning || !stream) return;
      if (DECISIVE.has(whole.v.status)) {
        v = whole.v; key = scanKey(v);
        if (awaitClear && key === lastSavedKey) return waitNext();        // still the label just reported
        awaitClear = false;
        // An exact list match stands on one read. Anything else needs a second one: the number printed
        // twice on the label, the line that held it on the next frame, or another whole-label read.
        hit = (CONFIDENT.has(v.status) && !v.possible) || whole.twice || key === lastWholeKey;
        if (!hit) {
          lastWholeKey = key;
          const tight = focusCrop(v, whole, { x: 0, y: 0, w: 1, h: 1 }, v.orientation);
          if (tight) focus = { crop: tight, rot: v.orientation, key };
        }
      } else {
        lastWholeKey = null;
        wholeAfter = Date.now() + 4000;                                   // do not keep re-reading the same view
        if (hit && whole.v.status === "no_match" && whole.v.tokens.length > v.tokens.length) { v = whole.v; key = scanKey(v); }
      }
    }
    if (hit && v.status === "no_match" && awaitClear) return waitNext();  // cannot tell it from the label just reported
    if (hit) {
      focus = null; stickyRot = 0; lastWholeKey = null;
      if (!(key === lastSavedKey && Date.now() - lastSavedAt < 15000)) {
        // The number is read. Barcodes often need another frame, so keep reading them for a moment:
        // briefly when none has been seen at all, longer when part of the label's barcodes already decoded.
        // The verdict is announced before that wait, so the reaction is not held up by the barcodes.
        let f = fields;
        const complete = () => (f.serial && f.qty != null) || f.labels > 1;
        const thumb = thumbnailOf(video);
        let told = null;
        if (!complete()) { told = !!findBySerial(f.serial); announce(v.status, false, told); }
        const until = Date.now() + (recentCodes.length ? BARCODE_GRACE_MS : BARCODE_GRACE_MIN_MS);
        let stopped = false;
        while (Date.now() < until && !complete()) {
          $("scanStatus").textContent = "reading barcode…";
          await sleep(60);
          if (!stream) { stopped = true; break; }       // camera stopped: the verdict was given, so keep the record
          if (!scanning) return;                        // Capture frame took over and records its own result
          f = labelFields(await readCodes(video), true);
          showCodeInfo(f);
        }
        lastResult = record(v, { thumb, source: "live scan", name: "" }, f);
        if (stopped) return renderResult(v, thumb, lastResult, "live scan");
        showLive(v, thumb, lastResult);
        lastSavedKey = key; lastSavedAt = Date.now();
        if (told !== lastResult.dup) announce(v.status, false, lastResult.dup);
      } else {
        showLive(v, thumbnailOf(video), lastResult);
      }
      lastFrameKey = null;
      recentCodes = [];
      return holdResult(v, lastDup);
    }
    lastFrameKey = key;
    if (key) next = CONFIRM_DELAY_MS;                   // a number is in the box: confirm it on the very next frame
  } catch (e) {
    $("scanStatus").textContent = "scan error: " + e.message;
  }
  scheduleScan(next);
}

/** Convert a fractional rectangle of the displayed (object-fit: cover, optionally CSS-zoomed) video into frame coordinates. */
function coverCrop(video, g) {
  const vw = video.videoWidth, vh = video.videoHeight;
  const ew = video.clientWidth, eh = video.clientHeight;
  if (!vw || !vh || !ew || !eh) return g;
  const scale = Math.max(ew / vw, eh / vh);
  const dw = vw * scale, dh = vh * scale;            // displayed size of the full frame
  const ox = (dw - ew) / 2, oy = (dh - eh) / 2;      // cropped-off margins in display px
  let x = (ox + g.x * ew) / dw, y = (oy + g.y * eh) / dh, w = (g.w * ew) / dw, h = (g.h * eh) / dh;
  if (digitalZoom > 1) {                              // CSS scale shows only the central 1/zoom of the frame
    const z = digitalZoom;
    x = 0.5 + (x - 0.5) / z; y = 0.5 + (y - 0.5) / z; w /= z; h /= z;
  }
  return { x, y, w, h };
}

// ------------------------------------------------------------------ zoom
let digitalZoom = 1;

async function setZoom(level) {
  const video = $("video");
  document.querySelectorAll("#zoomBar button").forEach((b) => b.classList.toggle("on", Number(b.dataset.zoom) === level));
  const track = stream && stream.getVideoTracks()[0];
  const caps = track && track.getCapabilities ? track.getCapabilities() : {};
  if (track && caps.zoom && level >= caps.zoom.min && level <= caps.zoom.max) {
    try {   // real (sensor) zoom where the phone exposes it
      await track.applyConstraints({ advanced: [{ zoom: level }] });
      digitalZoom = 1; video.style.transform = "";
      return;
    } catch { /* fall through to digital */ }
  }
  digitalZoom = level;
  video.style.transform = level > 1 ? `scale(${level})` : "";
}

/** Live-scan hit: freeze on the result with the tag colour around the picture until Resume is tapped. */
function holdResult(v, dup = false) {
  frozen = true;
  scanning = false; clearTimeout(scanTimer);
  lastVerdict = v;
  $("guide").classList.remove("busy");
  $("video").pause();
  const status = v.possible ? "pkg_check" : v.status;
  const color = FX_COLOR[status] || COLOR[status] || "#9e9e9e";
  $("camWrap").style.setProperty("--c", color);
  $("camWrap").style.setProperty("--ink", fxInk(status));
  $("heldWord").innerHTML = wordHtml(status, dup);
  $("camWrap").classList.add("held");
  $("btnShot").textContent = "Resume ▶";
  $("btnShot").classList.add("primary");
  $("scanStatus").textContent = "held — tap the picture or Resume ▶ for the next scan";
}

function releaseHold() {
  $("camWrap").classList.remove("held");
  $("btnShot").classList.remove("primary");
  hideVerdictFx();                    // moving on: don't let the last colour linger over the next scan
}

async function captureFrame() {
  if (!stream || !requireCatalog()) return;
  const video = $("video");
  if (frozen) {                       // second tap: unfreeze and resume live scanning
    if (qtyDirty) saveQty(true);      // a count typed but not saved is kept
    setCurrent(null);
    frozen = false;
    awaitClear = true;
    recentCodes = [];
    focus = null; stickyRot = 0; lastWholeKey = null; weakTicks = 0; serialOnlyTicks = 0; wholeAfter = 0;
    showCodeInfo(null);
    releaseHold();
    await video.play().catch(() => {});
    $("btnShot").textContent = "Capture frame";
    $("guide").classList.remove("hit");
    scanning = true; $("scanStatus").textContent = "scanning…"; scheduleScan(200);
    return;
  }
  frozen = true;
  scanning = false; clearTimeout(scanTimer);
  video.pause();                      // the preview stays on the frozen frame
  $("btnShot").textContent = "Resume ▶";
  $("scanStatus").textContent = "frozen — reading full frame…";
  try {
    const codes = await readCodes(video);
    const fields = labelFields(codes, true);
    showCodeInfo(fields);
    const v = await evaluateImage(video, { rotations: [0], extra: codeLines(codes, fields) });
    const thumb = thumbnailOf(video);
    lastResult = record(v, { thumb, source: "capture", name: "" }, fields);
    showLive(v, thumb, lastResult);
    recentCodes = [];
    announce(v.status, false, lastResult.dup);
    if (frozen) holdResult(v, lastResult.dup);
  } catch (e) {
    if (frozen) $("scanStatus").textContent = "frozen — read failed: " + e.message;
  }
}

/** Try to set the torch and confirm it really changed. Android Chrome can "accept" the constraint on a
 *  lens without a flash and do nothing, so on Android success requires torch in capabilities + settings. */
async function applyTorch(track, want) {
  for (const c of [{ advanced: [{ torch: want }] }, { torch: want }]) {
    try { await track.applyConstraints(c); } catch { continue; }
    if (IS_IOS) return true;                       // iOS: no error means it worked (previous behaviour)
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    const set = track.getSettings ? track.getSettings() : {};
    if (caps.torch && (set.torch === undefined || set.torch === want)) return true;
  }
  return false;
}

/** Multi-lens Android phones: facingMode "environment" may open a rear lens without the flash.
 *  Try the other rear cameras one at a time and keep the first one that has a torch. */
async function switchToTorchCamera() {
  if (!navigator.mediaDevices.enumerateDevices) return false;
  const original = stream.getVideoTracks()[0].getSettings().deviceId;
  const cams = (await navigator.mediaDevices.enumerateDevices())
    .filter((d) => d.kind === "videoinput" && d.deviceId && d.deviceId !== original && !/front|user|selfie|face/i.test(d.label));
  if (!cams.length) return false;
  $("scanStatus").textContent = "looking for the camera with the flash…";
  for (const d of cams) {
    stream.getTracks().forEach((t) => t.stop());   // Android opens one camera at a time
    let s;
    try { s = await getCamera(d.deviceId); } catch { s = null; }
    if (!s) { await useStream(await getCamera(original).catch(() => getCamera(null))); continue; }
    await useStream(s);
    await sleep(600);                               // capabilities appear a moment after start
    const caps = s.getVideoTracks()[0].getCapabilities ? s.getVideoTracks()[0].getCapabilities() : {};
    if (caps.torch) { localStorage.setItem(LS_CAM, d.deviceId); setZoom(1); return true; }
  }
  stream.getTracks().forEach((t) => t.stop());
  await useStream(await getCamera(original).catch(() => getCamera(null)));
  setZoom(1);
  return false;
}

async function toggleTorch() {
  let track = stream && stream.getVideoTracks()[0];
  if (!track) return toast("Start the live scan first");
  const want = !toggleTorch.on;
  let ok = await applyTorch(track, want);
  if (!ok && want && !IS_IOS && !toggleTorch.searched) {
    toggleTorch.searched = true;                    // only sweep the lenses once per session
    const wasScanning = scanning;
    scanning = false; clearTimeout(scanTimer);
    const found = await switchToTorchCamera().catch(() => false);
    track = stream.getVideoTracks()[0];
    if (found) ok = await applyTorch(track, want);
    if (wasScanning && !frozen) { scanning = true; $("scanStatus").textContent = "scanning…"; scheduleScan(300); }
  }
  if (!ok) {
    toggleTorch.on = false; $("btnTorch").style.background = "";
    return toast(/SamsungBrowser/i.test(navigator.userAgent)
      ? "Samsung Internet does not let web pages use the flashlight. Open this app in Chrome to use 🔦."
      : "This phone/browser does not give web pages the flashlight. Try Chrome, or add more light.", 6000);
  }
  toggleTorch.on = want;
  $("btnTorch").style.background = want ? "#ffe082" : "";
}

// ------------------------------------------------------------------ photos tab
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { resolve(img); setTimeout(() => URL.revokeObjectURL(url), 1000); };
    img.onerror = () => reject(new Error("cannot decode " + file.name));
    img.src = url;
  });
}

async function processFiles(files, source) {
  if (!files.length || !requireCatalog()) return;
  const out = $("batchResults"), prog = $("batchProgress");
  await getOcr();
  let i = 0;
  for (const file of files) {
    i++;
    prog.textContent = `Reading ${i} / ${files.length}: ${file.name}`;
    try {
      const img = await loadImage(file);
      let codes = await readCodes(img, 2400);
      let fields = labelFields(codes);
      if (!fields.serial || fields.qty == null) {     // small or dense barcodes need the full-size picture
        const fine = await readCodes(img, 4000);
        codes = codes.concat(fine.filter((c) => !codes.some((k) => k.text === c.text)));
        fields = labelFields(codes);
      }
      const v = await evaluateImage(img, { extra: codeLines(codes, fields) });
      const thumb = thumbnailOf(img);
      const r = record(v, { thumb, source, name: file.name }, fields);
      if (files.length === 1) announce(v.status, false, r.dup);   // single photo from the camera app: same cue as live scan
      const notice = r.dup ? `<div class="dup"><b>Already recorded</b> ${esc(r.entry.when)}${fmtLoc(r.entry)} — not counted again.</div>` : "";
      out.insertAdjacentHTML("afterbegin", cardHtml(v, { thumb, source: file.name, when: nowIso(), entry: r.entry, notice }));
    } catch (e) {
      out.insertAdjacentHTML("afterbegin", `<div class="card" style="border-left-color:#c62828"><div class="status">Error</div><div>${esc(file.name)}: ${esc(e.message)}</div></div>`);
    }
  }
  prog.textContent = `Done — ${files.length} photo(s). Results are also in History.`;
}

// ------------------------------------------------------------------ wiring
function switchTab(name) {
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.id === "tab-" + name));
  if (name !== "scan" && stream) stopCamera();
  if (name === "help") {
    $("timing").textContent = lastTiming
      ? `Last scan step on this device: barcodes ${lastTiming.codes} ms · text ${lastTiming.text} ms${lastTiming.turned > 5 ? ` · turned text ${lastTiming.turned} ms` : ""}${lastTiming.whole ? ` · whole label ${lastTiming.whole} ms` : ""}.`
      : "";
  }
}

const LEGEND_TEXT = {
  exact_match: "a number on the label equals a part on the obsolete list",
  possible_match: "same number ± revision letter, or look-alike characters; confirm by eye",
  ambiguous: "a garbled read is close to several list entries",
  not_in_catalog: "a clean Sodecia job number was read but it is not on the list — needs an inventory decision",
  no_match: "a number was read, but it is a customer / serial / lot number, not a Sodecia part number — the label was seen but has nothing to match",
  manual_review: "nothing readable — get closer or try again",
};

function init() {
  $("ver").textContent = "v" + VERSION;
  document.querySelectorAll("#modeSwitch button").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));
  $("location").value = localStorage.getItem(LS_LOCATION) || "";
  $("location").addEventListener("input", () => localStorage.setItem(LS_LOCATION, locationText()));
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
  $("btnList").addEventListener("click", pickCatalog);
  $("btnListBig").addEventListener("click", pickCatalog);
  $("btnCam").addEventListener("click", () => (stream ? stopCamera() : startCamera()));
  $("btnShot").addEventListener("click", captureFrame);
  $("btnPlay").addEventListener("click", startCamera);
  // While a result is held, tapping the picture itself resumes (bigger target than the button).
  $("video").addEventListener("click", () => { if (stream && frozen) captureFrame(); });
  // Missed the colour? Tap the result card to flash and sound it again.
  $("liveResult").addEventListener("click", (e) => {
    if (e.target.closest("[data-sep]")) return recordSeparate();
    const undo = e.target.closest("[data-undo]");
    if (undo) return undoRecord(undo.dataset.undo);
    if (lastVerdict) { unlockAudio(); announce(lastVerdict.status, false, lastDup); }
  });
  $("btnQty").addEventListener("click", () => saveQty());
  $("qty").addEventListener("input", () => { qtyDirty = true; $("btnQty").textContent = "Save qty"; });
  $("qty").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); if (saveQty()) $("qty").blur(); } });
  $("btnTorch").addEventListener("click", toggleTorch);
  $("btnManual").addEventListener("click", checkManual);
  $("manual").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); checkManual(); } });
  document.querySelectorAll("#zoomBar button").forEach((b) => b.addEventListener("click", () => setZoom(Number(b.dataset.zoom))));
  $("btnSound").addEventListener("click", () => {
    soundOn = !soundOn; localStorage.setItem(LS_SOUND, soundOn ? "on" : "off"); renderSoundButton();
    if (soundOn) { unlockAudio(); announce("exact_match"); }
  });
  renderSoundButton();
  $("author").value = localStorage.getItem(LS_AUTHOR) || "";
  const onAuthor = () => {
    localStorage.setItem(LS_AUTHOR, author());
    // History lives on this phone only, so entries without a name were found by this phone's user.
    if (author()) { let changed = false; for (const e of history) if (!e.foundBy) { e.foundBy = author(); changed = true; } if (changed) saveHistory(); }
  };
  $("author").addEventListener("change", onAuthor);
  $("author").addEventListener("input", onAuthor);
  $("filePhotos").addEventListener("change", (e) => processFiles([...e.target.files], "photos").then(() => { e.target.value = ""; }));
  $("fileCamera").addEventListener("change", (e) => processFiles([...e.target.files], "photo").then(() => { e.target.value = ""; }));
  $("histSearch").addEventListener("input", renderHistory);
  $("histFilters").addEventListener("click", (e) => {
    const b = e.target.closest("[data-f]"); if (!b) return;
    histFilter.has(b.dataset.f) ? histFilter.delete(b.dataset.f) : histFilter.add(b.dataset.f);
    renderHistory();
  });
  $("histList").addEventListener("click", (e) => {
    if (e.target.closest("[data-showall]")) { histFilter = new Set(order()); return renderHistory(); }
    const qb = e.target.closest("[data-qty]");
    if (qb) { qtyEditId = qb.dataset.qty; renderHistory(); const inp = document.querySelector("#histList .qtyEdit"); if (inp) { inp.focus(); inp.select(); } return; }
    const qs = e.target.closest("[data-qtysave]");
    if (qs) return saveQtyEdit(qs.dataset.qtysave);
    if (e.target.closest("[data-qtycancel]")) { qtyEditId = null; return renderHistory(); }
    const b = e.target.closest("[data-del]"); if (!b) return;
    if (current && current.id === b.dataset.del) setCurrent(null);
    history = history.filter((x) => x.id !== b.dataset.del); saveHistory();
  });
  $("histList").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && e.target.classList.contains("qtyEdit") && qtyEditId) { e.preventDefault(); saveQtyEdit(qtyEditId); }
  });
  $("btnExport").addEventListener("click", () => exportCsv(false));
  $("btnShare").addEventListener("click", () => exportCsv(true));
  $("btnClear").addEventListener("click", () => {
    if (confirm(`Clear all ${isPkg() ? "packaging" : "parts"} history on this phone? Export the CSV first if you need it.`)) {
      history = history.filter((e) => entryMode(e) !== mode); saveHistory();
      setCurrent(null);
    }
  });
  document.addEventListener("visibilitychange", () => { if (document.hidden && stream) stopCamera(); });

  restoreCatalog();
  loadHistory();
  renderMode();
  autoLoadRemoteList();
  if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => {});
}

init();

// Exposed for automated tests (Playwright) — not used by the UI.
window.__ppm = { get catalog() { return catalog; }, get pkgCatalog() { return pkgCatalog; }, get history() { return history; }, get mode() { return mode; }, get timing() { return lastTiming; }, get focus() { return focus; },
  setMode, evaluateImage, loadCatalogFile, processFiles, normalizePart, historyCsv, checkManual, readCodes, parseBarcodes, record };
