// Photo → Part Match — PWA front end. Matching logic lives in matcher.js (shared with tests).
import {
  buildCatalog, evaluateLines, normalizePart, STATUS_ORDER, STATUS_LABEL, STATUS_COLOR,
} from "./matcher.js?v=1.7.3";
import {
  buildPackagingCatalog, evaluatePackaging, PKG_ORDER, PKG_LABEL, PKG_COLOR, PKG_ACTION,
} from "./packaging.js?v=1.7.3";

const VERSION = "1.7.3";
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
const SCAN_INTERVAL_MS = 650;

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
  const { texts } = await ocr.detect({ data: img.data, width: img.width, height: img.height });
  return (texts || []).filter((t) => (t.mean ?? t.score ?? 1) >= MIN_LINE_CONF).map((t) => String(t.text || "").trim()).filter(Boolean);
}

const DECISIVE = new Set(["exact_match", "possible_match", "ambiguous", "not_in_catalog",
  "pkg_service", "pkg_production", "pkg_obsolete", "pkg_check", "pkg_not_listed"]);

/** Full-image evaluation with rotation fallback: keep rotating until a Sodecia part number is found
 *  (garbage tokens from upside-down text must not stop the search). */
async function evaluateImage(source, { rotations = [0, 180, 90, 270], maxSide = PHOTO_MAX_SIDE } = {}) {
  let best = null;
  for (const rot of rotations) {
    const canvas = prepare(source, { rotate: rot, maxSide });
    const lines = await ocrCanvas(canvas);
    const v = evalLines(lines);
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

function cardHtml(v, { thumb = "", source = "", when = "", id = null, foundBy = null, location = "" } = {}) {
  const color = COLOR[v.status];
  const desc = v.parts.map((p) => [p.description, p.model, p.comment].filter(Boolean).join(" · ")).filter(Boolean).join(" | ");
  const label = v.possible ? "POSSIBLE MATCH — confirm code" : LABEL[v.status];
  return `<div class="card" style="border-left-color:${color}" data-id="${id ?? ""}">
    ${thumb ? `<img class="thumb" src="${thumb}" alt="">` : ""}
    <div class="status" style="color:${color === PKG_COLOR.pkg_production ? "#8a6d00" : color}">${esc(label)}</div>
    <div class="part">${esc(partHeadline(v))}</div>
    ${desc ? `<div class="desc">${esc(desc)}</div>` : ""}
    ${v.note ? `<div class="note">${esc(v.note)}</div>` : ""}
    ${v.tokens.length ? `<div class="tokens">read: ${esc(v.tokens.join(" · "))}</div>` : ""}
    ${foundBy !== null ? `<div class="meta">Found by: <b>${esc(foundBy || "— (type your name under the camera)")}</b>${location ? ` · Area: <b>${esc(location)}</b>` : ""}</div>` : ""}
    <div class="meta">${when ? `<span>${esc(when)}</span>` : ""}${source ? `<span>${esc(source)}</span>` : ""}</div>
  </div>`;
}

function showLive(v, thumb) {
  lastVerdict = v;
  const el = $("liveResult");
  el.innerHTML = cardHtml(v, { thumb, source: "live scan", when: nowIso() });
  el.classList.remove("hidden");
  $("guide").classList.toggle("hit", DECISIVE.has(v.status));
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

function addHistory(v, { thumb, source, name }) {
  const entry = {
    id: Date.now() + Math.random().toString(16).slice(2, 6),
    mode,
    when: nowIso(),
    source, name,
    foundBy: author(),
    location: locationText(),
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
  };
  history.unshift(entry);
  saveHistory();
  if (!entry.foundBy && !addHistory.nagged && entry.status !== "manual_review" && entry.status !== "pkg_none") {
    addHistory.nagged = true;
    toast("Tip: type your name in “Found by” so finds are attributed to you", 4000);
  }
  return entry;
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
  const shown = mine.filter((e) => histFilter.has(e.status) && (!q || [e.name, e.foundBy, e.location, e.description, ...e.parts, ...e.unlisted, ...e.tokens].join(" ").toUpperCase().includes(q)));
  $("histList").innerHTML = shown.length
    ? shown.map((e) => cardHtml(entryToVerdict(e), { thumb: e.thumb, source: `${e.source}${e.name ? " · " + e.name : ""}`, when: e.when, id: e.id, foundBy: e.foundBy || "", location: e.location || "" })
        .replace("</div>\n  </div>", `</div><div class="actions"><button data-del="${e.id}">Delete</button></div></div>`)).join("")
    : `<p class="hint">Nothing here yet${mine.length ? " for the selected filters" : ""}.</p>`;
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
  if (which === "packaging") {
    const cols = ["when", "found_by", "area_location", "source", "image_name", "status", "tag_colour", "use_status", "ccs_code",
      "material_item", "internal_pn", "possible_match", "codes_read", "ocr_text", "notes"];
    const colour = { pkg_service: "PINK", pkg_production: "YELLOW", pkg_obsolete: "GREY" };
    const rows = list.map((e) => [e.when, e.foundBy || "", e.location || "", e.source, e.name, LABEL[e.status], e.possible ? "" : colour[e.status] || "",
      e.comment, e.parts.join("; ") || e.unlisted.join("; "), e.description, e.internal || "", e.possible ? "yes" : "",
      e.tokens.join("; "), (e.lines || []).join(" | "), e.note].map(q).join(","));
    return "\uFEFF" + [cols.join(","), ...rows].join("\r\n");
  }
  const cols = ["when", "found_by", "area_location", "source", "image_name", "status", "matched_part_numbers", "catalog_description", "catalog_comment",
    "sodecia_numbers_not_in_catalog", "part_tokens", "ocr_text", "notes"];
  const rows = list.map((e) => [e.when, e.foundBy || "", e.location || "", e.source, e.name, e.status, e.parts.join("; "), e.description, e.comment,
    e.unlisted.join("; "), e.tokens.join("; "), (e.lines || []).join(" | "), e.note].map(q).join(","));
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

function showVerdictFx(status, ms = 10000) {
  const color = FX_COLOR[status];
  const fx = $("verdictFx");
  if (!color) return;
  fx.classList.add("hidden");
  void fx.offsetWidth;                        // restart the CSS animations
  fx.style.setProperty("--c", color);
  fx.style.setProperty("--ink", fxInk(status));
  fx.querySelector(".word").textContent = FX_WORD[status] || "";
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

/** Everything that should happen when a verdict is produced for the user. */
function announce(status, possible = false) {
  if (possible) status = isPkg() ? "pkg_check" : "possible_match";
  playResult(status);
  showVerdictFx(status);
  buzz(status);
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
  $("guide").classList.remove("hit");
  releaseHold();
  awaitClear = false;
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
  const el = $("liveResult");
  el.innerHTML = cardHtml(v, { source: "typed: " + raw, when: nowIso() });
  el.classList.remove("hidden");
  addHistory(v, { thumb: "", source: "manual", name: raw });
  lastVerdict = v;
  announce(v.status);
  $("manual").select();
}

function scheduleScan(ms) { clearTimeout(scanTimer); if (scanning) scanTimer = setTimeout(scanOnce, ms); }

async function scanOnce() {
  if (!scanning || !stream || frozen) return;
  const video = $("video");
  if (video.readyState < 2) return scheduleScan(200);
  try {
    // The guide box in screen space maps to the video frame after object-fit: cover (and digital zoom).
    const crop = coverCrop(video, GUIDE);
    let canvas = prepare(video, { crop, maxSide: 1100, minWidth: 800 });
    let lines = await ocrCanvas(canvas);
    let v = evalLines(lines);
    if (!DECISIVE.has(v.status)) {
      // Nothing usable upright: try the label upside down, then sideways (alternating per frame to stay fast).
      const rot = ROT_FALLBACK[rotIdx++ % ROT_FALLBACK.length];
      canvas = prepare(video, { crop, rotate: rot, maxSide: 1100, minWidth: rot % 180 ? 0 : 800 });
      lines = await ocrCanvas(canvas);
      const v2 = evalLines(lines);
      if (DECISIVE.has(v2.status) || v2.tokens.length > v.tokens.length) { v = v2; v.orientation = rot; }
    }
    // Anything with a readable number is reportable: matches, unlisted Sodecia numbers, and labels where
    // only customer / serial numbers were read (so the user knows the label was seen but holds no part number).
    const key = v.status === "manual_review" || v.status === "pkg_none" ? null : `${v.status}|${partHeadline(v)}|${v.status === "no_match" ? v.tokens.slice(0, 3).join(",") : ""}`;
    // After Resume, the label just reported is ignored until it leaves the view; then the next box with
    // the same code counts as a new scan (several identical boxes in a row).
    if (awaitClear) {
      if (!key) { awaitClear = false; lastSavedKey = null; }
      else if (key === lastSavedKey) { $("scanStatus").textContent = "move to the next label…"; return scheduleScan(SCAN_INTERVAL_MS); }
      else awaitClear = false;
    }
    $("scanStatus").textContent = key ? "reading…" : "scanning…";
    if (key && (key === lastFrameKey || (CONFIDENT.has(v.status) && !v.possible))) {
      const thumb = thumbnailOf(video);
      showLive(v, thumb);
      if (!(key === lastSavedKey && Date.now() - lastSavedAt < 15000)) {
        addHistory(v, { thumb, source: "live scan", name: "" });
        lastSavedKey = key; lastSavedAt = Date.now();
        announce(v.status);
      }
      lastFrameKey = null;
      return holdResult(v);
    }
    lastFrameKey = key;
  } catch (e) {
    $("scanStatus").textContent = "scan error: " + e.message;
  }
  scheduleScan(SCAN_INTERVAL_MS);
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
function holdResult(v) {
  frozen = true;
  scanning = false; clearTimeout(scanTimer);
  lastVerdict = v;
  $("video").pause();
  const status = v.possible ? "pkg_check" : v.status;
  const color = FX_COLOR[status] || COLOR[status] || "#9e9e9e";
  $("camWrap").style.setProperty("--c", color);
  $("camWrap").style.setProperty("--ink", fxInk(status));
  $("heldWord").textContent = FX_WORD[status] || "";
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
    frozen = false;
    awaitClear = true;
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
    const v = await evaluateImage(video, { rotations: [0] });
    const thumb = thumbnailOf(video);
    showLive(v, thumb);
    addHistory(v, { thumb, source: "capture", name: "" });
    announce(v.status);
    if (frozen) holdResult(v);
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
      const v = await evaluateImage(img);
      const thumb = thumbnailOf(img);
      addHistory(v, { thumb, source, name: file.name });
      if (files.length === 1) announce(v.status);   // single photo from the camera app: same cue as live scan
      out.insertAdjacentHTML("afterbegin", cardHtml(v, { thumb, source: file.name, when: nowIso() }));
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
  $("liveResult").addEventListener("click", () => { if (lastVerdict) { unlockAudio(); announce(lastVerdict.status); } });
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
    const b = e.target.closest("[data-del]"); if (!b) return;
    history = history.filter((x) => x.id !== b.dataset.del); saveHistory();
  });
  $("btnExport").addEventListener("click", () => exportCsv(false));
  $("btnShare").addEventListener("click", () => exportCsv(true));
  $("btnClear").addEventListener("click", () => {
    if (confirm(`Clear all ${isPkg() ? "packaging" : "parts"} history on this phone? Export the CSV first if you need it.`)) {
      history = history.filter((e) => entryMode(e) !== mode); saveHistory();
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
window.__ppm = { get catalog() { return catalog; }, get pkgCatalog() { return pkgCatalog; }, get history() { return history; }, get mode() { return mode; },
  setMode, evaluateImage, loadCatalogFile, processFiles, normalizePart, historyCsv, checkManual };
