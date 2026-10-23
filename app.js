// Photo → Part Match — PWA front end. Matching logic lives in matcher.js (shared with tests).
import {
  buildCatalog, evaluateLines, normalizePart, STATUS_ORDER, STATUS_LABEL, STATUS_COLOR,
} from "./matcher.js?v=1.6.1";

const VERSION = "1.6.1";
const LS_CATALOG = "ppm.catalog.v1";
const LS_HISTORY = "ppm.history.v1";
const LS_AUTHOR = "ppm.author.v1";
const HISTORY_CAP = 400;
const MIN_LINE_CONF = 0.45;        // recognition confidence 0-1 (same threshold as the PC tool)
const PHOTO_MAX_SIDE = 1280;       // longest side fed to detection for whole photos
const SCAN_INTERVAL_MS = 650;
const HIT_PAUSE_MS = 2500;

const $ = (id) => document.getElementById(id);
const work = $("work");
const wctx = work.getContext("2d", { willReadFrequently: true });

let catalog = null;
let catalogMeta = null;
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
let histFilter = new Set(["exact_match", "possible_match", "ambiguous", "not_in_catalog"]);

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

// ------------------------------------------------------------------ catalog
function setCatalogFromRows(rows, meta) {
  catalog = buildCatalog(rows);
  catalogMeta = { ...meta, parts: catalog.size, duplicates: catalog.duplicateRows };
  localStorage.setItem(LS_CATALOG, JSON.stringify({ rows, meta: catalogMeta }));
  renderCatalogChip();
}

function renderCatalogChip() {
  const b = $("btnList"), l = $("listLabel");
  if (catalog) {
    b.classList.add("ok");
    l.textContent = `${catalogMeta.parts} parts · ${catalogMeta.name}`;
    b.title = `Loaded ${catalogMeta.loaded} (${catalogMeta.duplicates} duplicate rows skipped). Tap to load another list.`;
  } else {
    b.classList.remove("ok");
    l.textContent = "Load part list";
  }
  $("needList").classList.toggle("hidden", !!catalog);
  $("btnCam").disabled = !catalog;
}

function restoreCatalog() {
  try {
    const saved = JSON.parse(localStorage.getItem(LS_CATALOG) || "null");
    if (saved && saved.rows) { catalog = buildCatalog(saved.rows); catalogMeta = saved.meta; }
  } catch { /* ignore corrupt cache */ }
  renderCatalogChip();
}

/** Published list next to the app (partlist.json, written by publish_web_app_to_repo.ps1).
 *  Loaded on every open when online; a newer published list replaces an older auto-loaded one,
 *  but never replaces a list the user loaded by hand. */
async function autoLoadRemoteList() {
  try {
    const res = await fetch("partlist.json", { cache: "no-cache" });
    if (!res.ok) return;
    const data = await res.json();
    if (!data || !Array.isArray(data.rows)) return;
    const stamp = data.source_modified || data.generated || "";
    if (catalog && catalogMeta && catalogMeta.origin === "manual") return;
    if (catalog && catalogMeta && catalogMeta.origin === "published" && catalogMeta.stamp === stamp) return;
    setCatalogFromRows(data.rows, { name: `${data.source || "published list"} (${stamp})`, loaded: nowIso(), origin: "published", stamp });
    toast(`Part list ${stamp}: ${catalog.size} parts`);
  } catch { /* offline or not published: keep whatever is cached */ }
}

async function loadCatalogFile(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  setCatalogFromRows(rows, { name: file.name, loaded: nowIso(), sheet: wb.SheetNames[0], origin: "manual" });
  toast(`Loaded ${catalog.size} part numbers from ${file.name}`);
}

function requireCatalog() {
  if (catalog) return true;
  toast("Load the part list first — Scan tab, Step 1", 3500);
  switchTab("scan");
  return false;
}

function pickCatalog() {
  const inp = document.createElement("input");
  inp.type = "file";
  // Spreadsheet types only, so phone choosers offer Files / OneDrive and never the camera.
  inp.accept = ".xlsx,.xlsm,.xls,.csv";
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

const DECISIVE = new Set(["exact_match", "possible_match", "ambiguous", "not_in_catalog"]);

/** Full-image evaluation with rotation fallback: keep rotating until a Sodecia part number is found
 *  (garbage tokens from upside-down text must not stop the search). */
async function evaluateImage(source, { rotations = [0, 180, 90, 270], maxSide = PHOTO_MAX_SIDE } = {}) {
  let best = null;
  for (const rot of rotations) {
    const canvas = prepare(source, { rotate: rot, maxSide });
    const lines = await ocrCanvas(canvas);
    const v = evaluateLines(lines, catalog);
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

function cardHtml(v, { thumb = "", source = "", when = "", id = null, foundBy = null } = {}) {
  const color = STATUS_COLOR[v.status];
  const desc = v.parts.map((p) => [p.description, p.model, p.comment].filter(Boolean).join(" · ")).filter(Boolean).join(" | ");
  return `<div class="card" style="border-left-color:${color}" data-id="${id ?? ""}">
    ${thumb ? `<img class="thumb" src="${thumb}" alt="">` : ""}
    <div class="status" style="color:${color}">${esc(STATUS_LABEL[v.status])}</div>
    <div class="part">${esc(partHeadline(v))}</div>
    ${desc ? `<div class="desc">${esc(desc)}</div>` : ""}
    ${v.note ? `<div class="note">${esc(v.note)}</div>` : ""}
    ${v.tokens.length ? `<div class="tokens">read: ${esc(v.tokens.join(" · "))}</div>` : ""}
    ${foundBy !== null ? `<div class="meta">Found by: <b>${esc(foundBy || "— (type your name under the camera)")}</b></div>` : ""}
    <div class="meta">${when ? `<span>${esc(when)}</span>` : ""}${source ? `<span>${esc(source)}</span>` : ""}</div>
  </div>`;
}

function showLive(v, thumb) {
  const el = $("liveResult");
  el.innerHTML = cardHtml(v, { thumb, source: "live scan", when: nowIso() });
  el.classList.remove("hidden");
  $("guide").classList.toggle("hit", v.status === "exact_match" || v.status === "not_in_catalog" || v.status === "possible_match");
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
    when: nowIso(),
    source, name,
    foundBy: author(),
    status: v.status,
    parts: v.parts.map((p) => p.partNumber),
    description: v.parts.map((p) => p.description).filter(Boolean).join("; "),
    comment: v.parts.map((p) => p.comment).filter(Boolean).join("; "),
    unlisted: v.unlisted,
    tokens: v.tokens,
    lines: v.lines,
    note: v.note,
    thumb,
  };
  history.unshift(entry);
  saveHistory();
  if (!entry.foundBy && !addHistory.nagged && entry.status !== "manual_review") {
    addHistory.nagged = true;
    toast("Tip: type your name in “Found by” so finds are attributed to you", 4000);
  }
  return entry;
}

function entryToVerdict(e) {
  return {
    status: e.status, note: e.note, tokens: e.tokens, unlisted: e.unlisted, lines: e.lines,
    parts: e.parts.map((pn, i) => ({ partNumber: pn, description: i === 0 ? e.description : "", comment: i === 0 ? e.comment : "", model: "" })),
  };
}

function renderHistory() {
  $("histCount").textContent = history.length ? String(history.length) : "";
  const q = ($("histSearch").value || "").trim().toUpperCase();
  const shown = history.filter((e) => histFilter.has(e.status) && (!q || [e.name, e.foundBy, ...e.parts, ...e.unlisted, ...e.tokens].join(" ").toUpperCase().includes(q)));
  $("histList").innerHTML = shown.length
    ? shown.map((e) => cardHtml(entryToVerdict(e), { thumb: e.thumb, source: `${e.source}${e.name ? " · " + e.name : ""}`, when: e.when, id: e.id, foundBy: e.foundBy || "" })
        .replace("</div>\n  </div>", `</div><div class="actions"><button data-del="${e.id}">Delete</button></div></div>`)).join("")
    : `<p class="hint">Nothing here yet${history.length ? " for the selected filters" : ""}.</p>`;
  const counts = Object.fromEntries(STATUS_ORDER.map((s) => [s, history.filter((e) => e.status === s).length]));
  $("histFilters").innerHTML = STATUS_ORDER.map((s) =>
    `<button class="filter ${histFilter.has(s) ? "on" : ""}" data-f="${s}" style="--c:${STATUS_COLOR[s]}">${esc(STATUS_LABEL[s])} ${counts[s]}</button>`).join("");
}

function historyCsv() {
  const cols = ["when", "found_by", "source", "image_name", "status", "matched_part_numbers", "catalog_description", "catalog_comment",
    "sodecia_numbers_not_in_catalog", "part_tokens", "ocr_text", "notes"];
  const q = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  const rows = history.map((e) => [e.when, e.foundBy || "", e.source, e.name, e.status, e.parts.join("; "), e.description, e.comment,
    e.unlisted.join("; "), e.tokens.join("; "), (e.lines || []).join(" | "), e.note].map(q).join(","));
  return "\uFEFF" + [cols.join(","), ...rows].join("\r\n");
}

async function exportCsv(share) {
  if (!history.length) return toast("History is empty");
  const name = `photo_part_match_${new Date().toISOString().slice(0, 10)}.csv`;
  const blob = new Blob([historyCsv()], { type: "text/csv" });
  const file = new File([blob], name, { type: "text/csv" });
  if (share && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: "Photo part match" }); return; } catch { /* fall through */ }
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
  if (status === "exact_match") {            // rising three-note fanfare, twice
    for (const off of [0, 0.75]) { tone(880, t + off, 0.16); tone(1175, t + off + 0.17, 0.16); tone(1568, t + off + 0.34, 0.32); }
  } else if (status === "not_in_catalog" || status === "no_match") {   // low double buzz, twice: not on the list
    for (const off of [0, 0.7]) { tone(240, t + off, 0.22, 0.6, "sawtooth"); tone(180, t + off + 0.26, 0.30, 0.6, "sawtooth"); }
  } else if (status === "possible_match" || status === "ambiguous") {  // three quick blips: look at it
    for (const off of [0, 0.55]) { tone(620, t + off, 0.10); tone(620, t + off + 0.15, 0.10); tone(620, t + off + 0.30, 0.10); }
  }
}

const FX_COLOR = { exact_match: "#2e7d32", possible_match: "#ef6c00", ambiguous: "#ef6c00", not_in_catalog: "#c62828", no_match: "#c62828" };

/** Light chasing the screen perimeter + short tint, in the verdict colour. */
function showVerdictFx(status, ms = 3200) {
  const color = FX_COLOR[status];
  const fx = $("verdictFx");
  if (!color) return;
  fx.classList.add("hidden");
  void fx.offsetWidth;                        // restart the CSS animations
  fx.style.setProperty("--c", color);
  fx.classList.remove("hidden");
  clearTimeout(showVerdictFx._t);
  showVerdictFx._t = setTimeout(() => fx.classList.add("hidden"), ms);
}

function buzz(status) {
  if (!navigator.vibrate) return;
  navigator.vibrate(status === "exact_match" ? [120, 60, 120, 60, 250] : status === "possible_match" || status === "ambiguous" ? [80, 60, 80, 60, 80] : [300, 100, 300]);
}

/** Everything that should happen when a verdict is produced for the user. */
function announce(status) {
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

async function startCamera() {
  if (!requireCatalog()) return;
  unlockAudio();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return toast("Camera not available in this browser; use the Photos tab.", 4000);
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false,
    });
  } catch (e) {
    return toast("Camera permission denied or unavailable: " + e.message, 4000);
  }
  const video = $("video");
  video.srcObject = stream;
  await video.play().catch(() => {});
  $("btnCam").textContent = "Stop live scan";
  $("btnShot").disabled = false;
  const track = stream.getVideoTracks()[0];
  $("btnTorch").disabled = false;
  $("btnTorch").title = "Flashlight (Android; iPhones do not allow it from web pages)";
  // Chrome needs a moment before torch shows up in capabilities; re-check lazily for the tooltip only.
  setTimeout(() => { try { torchSupported = !!(track.getCapabilities && track.getCapabilities().torch); } catch { /* ignore */ } }, 1500);
  getOcr().then(() => { $("scanStatus").textContent = "scanning…"; scanning = true; scheduleScan(0); });
}

function stopCamera() {
  scanning = false;
  frozen = false;
  clearTimeout(scanTimer);
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  $("video").srcObject = null;
  $("btnCam").textContent = "Start live scan";
  $("btnShot").disabled = true;
  $("btnShot").textContent = "Capture frame";
  $("btnTorch").disabled = true;
  $("btnTorch").style.background = "";
  toggleTorch.on = false;
  $("scanStatus").textContent = "camera off";
  $("guide").classList.remove("hit");
  setZoom(1);
}

// ------------------------------------------------------------------ manual entry
function checkManual() {
  if (!requireCatalog()) return;
  const raw = ($("manual").value || "").trim();
  if (!raw) return toast("Type a part / job number first");
  const v = evaluateLines([raw], catalog);
  if (!v.tokens.length) {           // too short / not number-like for the extractor: still try it verbatim
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
    let v = evaluateLines(lines, catalog);
    if (!DECISIVE.has(v.status)) {
      // No Sodecia number upright: try the label upside down, then sideways (alternating per frame to stay fast).
      const rot = ROT_FALLBACK[rotIdx++ % ROT_FALLBACK.length];
      canvas = prepare(video, { crop, rotate: rot, maxSide: 1100, minWidth: rot % 180 ? 0 : 800 });
      lines = await ocrCanvas(canvas);
      const v2 = evaluateLines(lines, catalog);
      if (DECISIVE.has(v2.status) || v2.tokens.length > v.tokens.length) { v = v2; v.orientation = rot; }
    }
    // Anything with a readable number is reportable: matches, unlisted Sodecia numbers, and labels where
    // only customer / serial numbers were read (so the user knows the label was seen but holds no part number).
    const key = v.status === "manual_review" ? null : `${v.status}|${partHeadline(v)}|${v.status === "no_match" ? v.tokens.slice(0, 3).join(",") : ""}`;
    $("scanStatus").textContent = key ? "reading…" : "scanning…";
    if (key && (key === lastFrameKey || v.status === "exact_match")) {
      const thumb = thumbnailOf(video);
      showLive(v, thumb);
      if (!(key === lastSavedKey && Date.now() - lastSavedAt < 15000)) {
        addHistory(v, { thumb, source: "live scan", name: "" });
        lastSavedKey = key; lastSavedAt = Date.now();
        announce(v.status);
      }
      lastFrameKey = null;
      return scheduleScan(v.status === "no_match" ? HIT_PAUSE_MS / 2 : HIT_PAUSE_MS);
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

async function captureFrame() {
  if (!stream || !requireCatalog()) return;
  const video = $("video");
  if (frozen) {                       // second tap: unfreeze and resume live scanning
    frozen = false;
    await video.play().catch(() => {});
    $("btnShot").textContent = "Capture frame";
    $("guide").classList.remove("hit");
    scanning = true; $("scanStatus").textContent = "scanning…"; scheduleScan(200);
    return;
  }
  frozen = true;
  scanning = false; clearTimeout(scanTimer);
  video.pause();                      // the preview stays on the frozen frame
  $("btnShot").textContent = "Resume";
  $("scanStatus").textContent = "frozen — reading full frame…";
  try {
    const v = await evaluateImage(video, { rotations: [0] });
    const thumb = thumbnailOf(video);
    showLive(v, thumb);
    addHistory(v, { thumb, source: "capture", name: "" });
    announce(v.status);
    if (frozen) $("scanStatus").textContent = "frozen — tap Resume to continue";
  } catch (e) {
    if (frozen) $("scanStatus").textContent = "frozen — read failed: " + e.message;
  }
}

async function toggleTorch() {
  const track = stream && stream.getVideoTracks()[0];
  if (!track) return toast("Start the live scan first");
  const want = !toggleTorch.on;
  // Don't trust getCapabilities() (Android Chrome often reports no torch right after start): just try.
  try {
    await track.applyConstraints({ advanced: [{ torch: want }] });
  } catch (e) {
    try {   // some Android builds only accept it as a plain constraint
      await track.applyConstraints({ torch: want });
    } catch (e2) {
      toggleTorch.on = false; $("btnTorch").style.background = "";
      const caps = track.getCapabilities ? track.getCapabilities() : {};
      return toast(caps.torch === undefined
        ? "This browser does not expose the flashlight to web pages (iPhone never; some Android browsers). Try Chrome, or add more light."
        : "Flashlight refused by the phone: " + (e2.message || e2), 5000);
    }
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

function init() {
  $("ver").textContent = "v" + VERSION;
  $("legend").innerHTML = STATUS_ORDER.map((s) => `<li><span class="tag" style="background:${STATUS_COLOR[s]}">${esc(STATUS_LABEL[s])}</span> — ${esc({
    exact_match: "a number on the label equals a part on the obsolete list",
    possible_match: "same number ± revision letter, or look-alike characters; confirm by eye",
    ambiguous: "a garbled read is close to several list entries",
    not_in_catalog: "a clean Sodecia job number was read but it is not on the list — needs an inventory decision",
    no_match: "a number was read, but it is a customer / serial / lot number, not a Sodecia part number — the label was seen but has nothing to match",
    manual_review: "nothing readable — get closer or try again",
  }[s])}</li>`).join("");

  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
  $("btnList").addEventListener("click", pickCatalog);
  $("btnListBig").addEventListener("click", pickCatalog);
  $("btnCam").addEventListener("click", () => (stream ? stopCamera() : startCamera()));
  $("btnShot").addEventListener("click", captureFrame);
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
  $("btnClear").addEventListener("click", () => { if (confirm("Clear all history on this phone?")) { history = []; saveHistory(); } });
  document.addEventListener("visibilitychange", () => { if (document.hidden && stream) stopCamera(); });

  restoreCatalog();
  loadHistory();
  autoLoadRemoteList();
  if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => {});
}

init();

// Exposed for automated tests (Playwright) — not used by the UI.
window.__ppm = { get catalog() { return catalog; }, get history() { return history; }, evaluateImage, loadCatalogFile, processFiles, normalizePart, historyCsv };
