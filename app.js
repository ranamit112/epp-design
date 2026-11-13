// Quilt Planner – EPP fabric planner. No build step, no server; everything is stored on-device (IndexedDB).
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const uid = () => Math.random().toString(36).slice(2, 10);

/* ------------------------------------------------------------------ storage */
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('quilt-planner', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('projects', { keyPath: 'id' });
      r.onsuccess = () => { DB.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  tx(mode, fn) {
    return new Promise((res, rej) => {
      const t = DB.db.transaction('projects', mode);
      const req = fn(t.objectStore('projects'));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
    });
  },
  all: () => DB.tx('readonly', s => s.getAll()),
  put: p => DB.tx('readwrite', s => s.put(p)),
  del: id => DB.tx('readwrite', s => s.delete(id)),
};

/* -------------------------------------------------------------------- state */
let P = null;                 // current project
let seg = null;               // segmentation result for current pattern
let doc = document.createElement('canvas');   // composited current variant (pattern resolution)
let docDirty = true;
let sel = new Set();          // selected region ids
let activeFabric = null;      // fabric id shown in Adjust tab
let moveMode = false, showOutline = false;
const fabImgs = new Map();    // fabric id -> mip levels [canvas...]
const V = { s: 1, x: 0, y: 0 };  // view transform (css px)
let undoStack = [];
let saveTimer = 0;

const curVariant = () => P.variants.find(v => v.id === P.cur) || P.variants[0];
const fabById = id => P.fabrics.find(f => f.id === id);

function toast(msg, ms = 1800) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.add('hidden'), ms);
}
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { if (P) { P.updated = Date.now(); DB.put(P); } }, 400);
}

/* -------------------------------------------------------------- segmentation */
// Finds the closed areas (the patches) between the dark printed lines of the pattern.
function segment(img, thr, minArea, dropBg) {
  const w = img.width, h = img.height, N = w * h;
  const base = document.createElement('canvas'); base.width = w; base.height = h;
  const bx = base.getContext('2d', { willReadFrequently: true });
  bx.fillStyle = '#fff'; bx.fillRect(0, 0, w, h); bx.drawImage(img, 0, 0);
  const src = bx.getImageData(0, 0, w, h), d = src.data;
  const label = new Int32Array(N);                 // 0 = unvisited, -2 = line pixel, >0 component
  for (let i = 0, j = 0; i < N; i++, j += 4)
    if ((d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8 <= thr) label[i] = -2;

  const stack = new Int32Array(N), comps = [null];
  let nc = 0;
  for (let s = 0; s < N; s++) {
    if (label[s] !== 0) continue;
    nc++; let sp = 0; stack[sp++] = s; label[s] = nc;
    const c = { area: 0, sx: 0, sy: 0, x0: w, y0: h, x1: 0, y1: 0, border: false, r: 0, g: 0, b: 0, seed: s };
    while (sp) {
      const p = stack[--sp], px = p % w, py = (p / w) | 0;
      c.area++; c.sx += px; c.sy += py;
      if (px < c.x0) c.x0 = px; if (px > c.x1) c.x1 = px; if (py < c.y0) c.y0 = py; if (py > c.y1) c.y1 = py;
      if (px === 0 || py === 0 || px === w - 1 || py === h - 1) c.border = true;
      const j = p * 4; c.r += d[j]; c.g += d[j + 1]; c.b += d[j + 2];
      if (px > 0 && label[p - 1] === 0) { label[p - 1] = nc; stack[sp++] = p - 1; }
      if (px < w - 1 && label[p + 1] === 0) { label[p + 1] = nc; stack[sp++] = p + 1; }
      if (py > 0 && label[p - w] === 0) { label[p - w] = nc; stack[sp++] = p - w; }
      if (py < h - 1 && label[p + w] === 0) { label[p + w] = nc; stack[sp++] = p + w; }
    }
    comps.push(c);
  }
  // the outside paper = biggest component touching the border (if it is really big)
  let bg = 0;
  if (dropBg) {
    let best = 0;
    for (let i = 1; i <= nc; i++) if (comps[i].border && comps[i].area > best) { best = comps[i].area; bg = i; }
    if (best < N * 0.2) bg = 0;
  }
  const map = new Int32Array(nc + 1), regions = [];
  for (let i = 1; i <= nc; i++) {
    const c = comps[i];
    if (i === bg) { map[i] = -1; continue; }
    if (c.area < minArea) { map[i] = 0; continue; }
    const id = regions.length + 1; map[i] = id;
    regions.push({
      id, area: c.area, cx: c.sx / c.area, cy: c.sy / c.area, seed: c.seed,
      color: [c.r / c.area, c.g / c.area, c.b / c.area],
      x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1,
    });
  }
  for (let i = 0; i < N; i++) { const l = label[i]; label[i] = l > 0 ? map[l] : 0; }

  // line layer: everything that is not a patch (lines, numbers, outside) stays on top, opaque
  const lineImg = new ImageData(w, h), ld = lineImg.data;
  for (let i = 0, j = 0; i < N; i++, j += 4) {
    if (label[i] > 0) continue;
    ld[j] = d[j]; ld[j + 1] = d[j + 1]; ld[j + 2] = d[j + 2]; ld[j + 3] = 255;
  }
  const lineCanvas = document.createElement('canvas'); lineCanvas.width = w; lineCanvas.height = h;
  lineCanvas.getContext('2d').putImageData(lineImg, 0, 0);

  // grow patches under the lines so fabric reaches the middle of each line
  let cur = label;
  for (let pass = 0; pass < 3; pass++) {
    const nxt = cur.slice();
    for (let i = 0; i < N; i++) {
      if (cur[i] !== 0) continue;
      const x = i % w;
      let l = 0;
      if (x > 0 && cur[i - 1] > 0) l = cur[i - 1];
      else if (x < w - 1 && cur[i + 1] > 0) l = cur[i + 1];
      else if (i >= w && cur[i - w] > 0) l = cur[i - w];
      else if (i < N - w && cur[i + w] > 0) l = cur[i + w];
      if (l) nxt[i] = l;
    }
    cur = nxt;
  }
  for (const r of regions) { r.x0 = Math.max(0, r.x0 - 3); r.y0 = Math.max(0, r.y0 - 3); r.x1 = Math.min(w - 1, r.x1 + 3); r.y1 = Math.min(h - 1, r.y1 + 3); }

  // outlines (for the "show detected shapes" debug view)
  const oi = new ImageData(w, h), od = oi.data;
  for (let i = 0, j = 0; i < N; i++, j += 4) {
    const l = cur[i]; if (l <= 0) continue;
    const x = i % w;
    if ((x < w - 1 && cur[i + 1] !== l) || (i < N - w && cur[i + w] !== l) || (x > 0 && cur[i - 1] !== l) || (i >= w && cur[i - w] !== l)) {
      od[j] = 230; od[j + 1] = 20; od[j + 2] = 90; od[j + 3] = 255;
    }
  }
  const outlineCanvas = document.createElement('canvas'); outlineCanvas.width = w; outlineCanvas.height = h;
  outlineCanvas.getContext('2d').putImageData(oi, 0, 0);

  return { w, h, label: cur, regions, baseCanvas: base, lineCanvas, outlineCanvas, masks: new Map(), tints: new Map() };
}

// Picks the line/fill cut-off from the image itself: lines are the darkest mode of the brightness
// histogram, and the cut-off sits in the valley after it (so mid-tone fills are not mistaken for lines).
function autoThreshold(img) {
  const k = Math.min(1, 800 / Math.max(img.width, img.height));
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
  const x = c.getContext('2d', { willReadFrequently: true });
  x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(img, 0, 0, c.width, c.height);
  const d = x.getImageData(0, 0, c.width, c.height).data, raw = new Float64Array(256), n = c.width * c.height;
  for (let i = 0; i < d.length; i += 4) raw[(d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8]++;
  const h = raw.map((_, i) => { let s = 0, m = 0; for (let j = Math.max(0, i - 3); j <= Math.min(255, i + 3); j++) { s += raw[j]; m++; } return s / m; });
  let peak = -1;
  for (let i = 1; i < 200 && peak < 0; i++) {
    if (h[i] >= h[i - 1] && h[i] > h[i + 1]) { let mass = 0; for (let j = Math.max(0, i - 10); j <= i + 10; j++) mass += raw[j]; if (mass > n * 0.004) peak = i; }
  }
  if (peak < 0) peak = h[0] >= h[1] ? 0 : 20;
  let v = peak;
  while (v < 200 && h[v + 1] <= h[v]) v++;
  return Math.max(50, Math.min(170, v));
}

function maskOf(id) {
  let m = seg.masks.get(id); if (m) return m;
  const r = seg.regions[id - 1], bw = r.x1 - r.x0 + 1, bh = r.y1 - r.y0 + 1;
  m = document.createElement('canvas'); m.width = bw; m.height = bh;
  const x = m.getContext('2d'), im = x.createImageData(bw, bh), o = im.data;
  for (let y = 0; y < bh; y++) {
    let li = (y + r.y0) * seg.w + r.x0;
    for (let xx = 0; xx < bw; xx++, li++) if (seg.label[li] === id) o[(y * bw + xx) * 4 + 3] = 255;
  }
  x.putImageData(im, 0, 0);
  seg.masks.set(id, m);
  return m;
}
function tintOf(id) {
  let t = seg.tints.get(id); if (t) return t;
  // selection = a coloured border just inside the shape's edge (the fabric itself is left untouched)
  const m = maskOf(id), bw = m.width, bh = m.height;
  const a = m.getContext('2d').getImageData(0, 0, bw, bh).data;
  let cur = new Uint8Array(bw * bh);
  for (let i = 0; i < cur.length; i++) cur[i] = a[i * 4 + 3] ? 1 : 0;
  const inside = cur.slice();
  for (let pass = 0; pass < 6; pass++) {          // erode 6px; the ring is what was removed
    const nxt = new Uint8Array(bw * bh);
    for (let y = 1; y < bh - 1; y++) for (let xx = 1; xx < bw - 1; xx++) {
      const i = y * bw + xx;
      if (cur[i] && cur[i - 1] && cur[i + 1] && cur[i - bw] && cur[i + bw]) nxt[i] = 1;
    }
    cur = nxt;
  }
  t = document.createElement('canvas'); t.width = bw; t.height = bh;
  const x = t.getContext('2d'), im = x.createImageData(bw, bh), o = im.data;
  for (let i = 0; i < inside.length; i++) if (inside[i] && !cur[i]) { o[i * 4] = 0; o[i * 4 + 1] = 110; o[i * 4 + 2] = 255; o[i * 4 + 3] = 255; }
  x.putImageData(im, 0, 0);
  seg.tints.set(id, t);
  return t;
}

/* ------------------------------------------------------------------ fabrics */
function fabricLevels(f) {
  let lv = fabImgs.get(f.id);
  return lv || null;
}
async function loadFabricImage(f) {
  if (f.type !== 'photo') return;
  const im = await loadImg(f.img);
  const lv = [im];
  let c = im;
  while (c.width > 64 && c.height > 64 && lv.length < 6) {
    const n = document.createElement('canvas'); n.width = c.width >> 1; n.height = c.height >> 1;
    const x = n.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(c, 0, 0, n.width, n.height);
    lv.push(n); c = n;
  }
  fabImgs.set(f.id, lv);
}
function loadImg(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
}

/* ---------------------------------------------------------------- composite */
const tmp = document.createElement('canvas');
function composite(variant, target) {
  const { w, h } = seg;
  target.width = w; target.height = h;
  const x = target.getContext('2d');
  x.drawImage(seg.baseCanvas, 0, 0);
  for (const key in variant.assign) {
    const a = variant.assign[key], r = seg.regions[key - 1], f = fabById(a.f);
    if (!r || !f) continue;
    const bw = r.x1 - r.x0 + 1, bh = r.y1 - r.y0 + 1;
    tmp.width = bw; tmp.height = bh;
    const t = tmp.getContext('2d');
    if (f.type === 'color') { t.fillStyle = f.color; t.fillRect(0, 0, bw, bh); }
    else {
      const lv = fabricLevels(f); if (!lv) continue;
      // choose a pre-shrunk copy to avoid aliasing when the fabric is shown small
      const k = Math.min(lv.length - 1, Math.max(0, Math.floor(Math.log2(1 / f.scale))));
      const im = lv[k], sc = f.scale * (1 << k);
      t.imageSmoothingQuality = 'high';
      t.translate(r.cx - r.x0 + (a.dx || 0), r.cy - r.y0 + (a.dy || 0));
      t.rotate((a.rot || 0) * Math.PI / 180);
      t.scale(sc, sc);
      t.translate(-im.width / 2, -im.height / 2);
      t.fillStyle = t.createPattern(im, 'repeat');
      t.fillRect(-1e5, -1e5, 2e5, 2e5);
      t.setTransform(1, 0, 0, 1, 0, 0);
    }
    t.globalCompositeOperation = 'destination-in';
    t.drawImage(maskOf(r.id), 0, 0);
    x.drawImage(tmp, r.x0, r.y0);
  }
  x.drawImage(seg.lineCanvas, 0, 0);
}

/* -------------------------------------------------------------------- view */
const view = $('#view'), vctx = view.getContext('2d');
let raf = 0;
function redraw() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); }
function draw() {
  if (!seg) return;
  const dpr = devicePixelRatio || 1, W = view.clientWidth, H = view.clientHeight;
  if (view.width !== Math.round(W * dpr) || view.height !== Math.round(H * dpr)) { view.width = Math.round(W * dpr); view.height = Math.round(H * dpr); }
  if (docDirty) { composite(curVariant(), doc); docDirty = false; }
  vctx.setTransform(1, 0, 0, 1, 0, 0);
  vctx.clearRect(0, 0, view.width, view.height);
  vctx.setTransform(dpr * V.s, 0, 0, dpr * V.s, dpr * V.x, dpr * V.y);
  vctx.imageSmoothingEnabled = true; vctx.imageSmoothingQuality = 'high';
  vctx.shadowColor = 'rgba(0,0,0,.3)'; vctx.shadowBlur = 12 * dpr / V.s;
  vctx.fillStyle = '#fff'; vctx.fillRect(0, 0, seg.w, seg.h);
  vctx.shadowColor = 'transparent';
  vctx.drawImage(doc, 0, 0);
  if (showOutline) vctx.drawImage(seg.outlineCanvas, 0, 0);
  for (const id of sel) { const r = seg.regions[id - 1]; if (r) vctx.drawImage(tintOf(id), r.x0, r.y0); }
}
// zoom to the detected shapes (not the whole page), so margins around the pattern don't waste screen space
function fitView() {
  const W = view.clientWidth, H = view.clientHeight;
  let x0 = 0, y0 = 0, x1 = seg.w, y1 = seg.h;
  if (seg.regions.length) {
    x0 = Math.min(...seg.regions.map(r => r.x0)); y0 = Math.min(...seg.regions.map(r => r.y0));
    x1 = Math.max(...seg.regions.map(r => r.x1)); y1 = Math.max(...seg.regions.map(r => r.y1));
  }
  const m = 0.02 * Math.max(x1 - x0, y1 - y0), bw = x1 - x0 + 2 * m, bh = y1 - y0 + 2 * m;
  V.s = Math.min(W / bw, H / bh);
  V.x = (W - bw * V.s) / 2 - (x0 - m) * V.s; V.y = (H - bh * V.s) / 2 - (y0 - m) * V.s;
  redraw();
}
function zoomAt(cx, cy, f) {
  const ns = Math.min(Math.max(V.s * f, 0.05), 12), k = ns / V.s;
  V.x = cx - (cx - V.x) * k; V.y = cy - (cy - V.y) * k; V.s = ns; redraw();
}
let lastW = 0, lastH = 0;
new ResizeObserver(() => {      // keep the same part of the pattern centred when the canvas area changes size
  const W = view.clientWidth, H = view.clientHeight;
  if (lastW && seg) { V.x += (W - lastW) / 2; V.y += (H - lastH) / 2; }
  lastW = W; lastH = H;
  if (seg) redraw();
}).observe($('#stage'));
const dirty = () => { docDirty = true; redraw(); scheduleSave(); };

// gestures: 1 finger = tap/pan (or drag the fabric in move mode), 2 fingers = pinch zoom + pan
const ptrs = new Map();
let tapInfo = null, pinch = null, moveSnap = false;
view.addEventListener('pointerdown', e => {
  view.setPointerCapture(e.pointerId);
  ptrs.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
  if (ptrs.size === 1) { tapInfo = { x: e.offsetX, y: e.offsetY, t: performance.now(), moved: false }; moveSnap = false; }
  else { tapInfo = null; startPinch(); }
});
function startPinch() {
  const [a, b] = [...ptrs.values()];
  pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
}
view.addEventListener('pointermove', e => {
  const p = ptrs.get(e.pointerId); if (!p) return;
  const nx = e.offsetX, ny = e.offsetY;
  if (ptrs.size >= 2) {
    p.x = nx; p.y = ny;
    const [a, b] = [...ptrs.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y) || 1, cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    V.x += cx - pinch.cx; V.y += cy - pinch.cy;
    zoomAt(cx, cy, d / pinch.d);
    pinch = { d, cx, cy };
    return;
  }
  const dx = nx - p.x, dy = ny - p.y; p.x = nx; p.y = ny;
  if (tapInfo && !tapInfo.moved && Math.hypot(nx - tapInfo.x, ny - tapInfo.y) > 8) tapInfo.moved = true;
  if (!tapInfo || !tapInfo.moved) return;
  if (moveMode && sel.size) {
    if (!moveSnap) { snapshot(); moveSnap = true; }
    const v = curVariant();
    for (const id of sel) { const a = v.assign[id]; if (a) { a.dx = (a.dx || 0) + dx / V.s; a.dy = (a.dy || 0) + dy / V.s; } }
    dirty();
  } else { V.x += dx; V.y += dy; redraw(); }
});
const endPtr = e => {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.delete(e.pointerId);
  if (ptrs.size === 1) { tapInfo = null; }
  if (ptrs.size === 0) {
    if (tapInfo && !tapInfo.moved && performance.now() - tapInfo.t < 600 && e.type === 'pointerup') tapAt(tapInfo.x, tapInfo.y);
    tapInfo = null;
  }
};
view.addEventListener('pointerup', endPtr);
view.addEventListener('pointercancel', endPtr);
view.addEventListener('wheel', e => { e.preventDefault(); zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * 0.0015)); }, { passive: false });

function regionAt(sx, sy) {
  const x = Math.floor((sx - V.x) / V.s), y = Math.floor((sy - V.y) / V.s);
  if (x < 0 || y < 0 || x >= seg.w || y >= seg.h) return 0;
  let l = seg.label[y * seg.w + x]; if (l > 0) return l;
  const rad = Math.max(2, Math.ceil(10 / V.s));      // tap on a line → nearest shape
  let best = 0, bd = 1e9;
  for (let yy = Math.max(0, y - rad); yy <= Math.min(seg.h - 1, y + rad); yy++)
    for (let xx = Math.max(0, x - rad); xx <= Math.min(seg.w - 1, x + rad); xx++) {
      const q = seg.label[yy * seg.w + xx];
      if (q > 0) { const dd = (xx - x) ** 2 + (yy - y) ** 2; if (dd < bd) { bd = dd; best = q; } }
    }
  return best;
}
function tapAt(sx, sy) {
  const id = regionAt(sx, sy);
  if (!id) sel.clear(); else if (sel.has(id)) sel.delete(id); else sel.add(id);
  onSelectionChanged();
}

/* ---------------------------------------------------------------- selection */
function onSelectionChanged() {
  const v = curVariant();
  if (sel.size) {
    const first = [...sel].map(id => v.assign[id]).find(Boolean);
    if (first) activeFabric = first.f;
  }
  $('#selInfo').textContent = sel.size ? `${sel.size} selected` : 'Tap shapes to select';
  refreshUI(); redraw();
}
function selectWhere(pred) {
  const v = curVariant();
  for (const r of seg.regions) if (pred(r, v.assign[r.id])) sel.add(r.id);
  onSelectionChanged();
}
$('#selbar').addEventListener('click', e => {
  const k = e.target.dataset.sel; if (!k) return;
  const v = curVariant();
  const ref = [...sel].map(id => seg.regions[id - 1]);
  if (k === 'none') sel.clear();
  else if (k === 'all') seg.regions.forEach(r => sel.add(r.id));
  else if (k === 'unassigned') { sel.clear(); seg.regions.forEach(r => { if (!v.assign[r.id]) sel.add(r.id); }); }
  else if (!ref.length) { toast('Select a shape first'); return; }
  else if (k === 'color') {
    selectWhere(r => ref.some(q => Math.hypot(q.color[0] - r.color[0], q.color[1] - r.color[1], q.color[2] - r.color[2]) < 40));
    if (sel.size === seg.regions.length && ref.length) toast('Pattern has no colours – all shapes match');
    return;
  } else if (k === 'shape') selectWhere(r => ref.some(q => Math.abs(q.area - r.area) / q.area < 0.05));
  else if (k === 'fabric') selectWhere((r, a) => a && ref.some(q => v.assign[q.id] && v.assign[q.id].f === a.f));
  onSelectionChanged();
});

/* --------------------------------------------------------------------- undo */
function snapshot() {
  undoStack.push(JSON.stringify({ variants: P.variants, cur: P.cur, fab: P.fabrics.map(f => [f.id, f.color, f.scale]) }));
  if (undoStack.length > 40) undoStack.shift();
}
$('#btnUndo').onclick = () => {
  const s = undoStack.pop(); if (!s) { toast('Nothing to undo'); return; }
  const o = JSON.parse(s);
  P.variants = o.variants; P.cur = o.cur;
  for (const [id, color, scale] of o.fab) { const f = fabById(id); if (f) { f.color = color; f.scale = scale; } }
  renderVariants(); refreshUI(); dirty();
};

/* ---------------------------------------------------------------------- UI */
function renderVariants() {
  const b = $('#vbar'); b.innerHTML = '';
  P.variants.forEach(v => {
    const el = document.createElement('button'); el.textContent = v.name;
    if (v.id === P.cur) el.classList.add('on');
    el.onclick = () => { P.cur = v.id; sel.clear(); renderVariants(); onSelectionChanged(); dirty(); };
    b.appendChild(el);
  });
  const add = document.createElement('button'); add.textContent = '＋ New option';
  add.onclick = () => addVariant(false); b.appendChild(add);
  const dup = document.createElement('button'); dup.textContent = '⧉ Copy this';
  dup.onclick = () => addVariant(true); b.appendChild(dup);
}
function addVariant(copy) {
  snapshot();
  const cur = curVariant();
  const v = { id: uid(), name: 'Option ' + String.fromCharCode(65 + P.variants.length % 26) + (P.variants.length >= 26 ? P.variants.length : ''), assign: copy ? JSON.parse(JSON.stringify(cur.assign)) : {} };
  P.variants.push(v); P.cur = v.id; sel.clear();
  renderVariants(); onSelectionChanged(); dirty();
}

function swatchStyle(f) { return f.type === 'color' ? `background:${f.color}` : `background-image:url(${f.img})`; }
function renderTray() {
  const t = $('#tray'); t.innerHTML = '';
  P.fabrics.forEach(f => {
    const b = document.createElement('button'); b.className = 'sw' + (f.id === activeFabric ? ' on' : '');
    b.style.cssText = swatchStyle(f); b.setAttribute('aria-label', 'fabric');
    b.onclick = () => chooseFabric(f.id);
    t.appendChild(b);
  });
  if (!P.fabrics.length) t.innerHTML = '<div class="muted small">No fabrics yet – add a colour or take a photo of a fabric.</div>';
}
function chooseFabric(id) {
  activeFabric = id;
  if (sel.size) {
    snapshot();
    const v = curVariant();
    for (const rid of sel) { const o = v.assign[rid]; v.assign[rid] = { f: id, rot: o ? o.rot : 0, dx: 0, dy: 0 }; }
    dirty();
  }
  refreshUI();
}
function selRot() { const v = curVariant(); const a = [...sel].map(i => v.assign[i]).find(Boolean); return a ? a.rot || 0 : 0; }

const SC_MIN = 0.02, SC_MAX = 6;
const scToSlider = s => Math.round(1000 * Math.log(s / SC_MIN) / Math.log(SC_MAX / SC_MIN));
const sliderToSc = v => SC_MIN * Math.pow(SC_MAX / SC_MIN, v / 1000);
const pxPerCm = () => (P.patCm ? seg.w / P.patCm : 0);

function refreshUI() {
  if (!P) return;
  renderTray();
  const f = activeFabric && fabById(activeFabric);
  const hasSel = [...sel].some(id => curVariant().assign[id]);
  $('#rot').value = selRot(); $('#rotVal').textContent = Math.round(selRot()) + '°';
  $('#scaleBox').classList.toggle('hidden', !(f && f.type === 'photo'));
  $('#btnEditFab').classList.toggle('hidden', !(f && f.type === 'color'));
  $('#btnDelFab').classList.toggle('hidden', !f);
  $('#btnClear').disabled = !hasSel;
  if (f && f.type === 'photo') {
    $('#scale').value = scToSlider(f.scale);
    const ppc = pxPerCm();
    $('#scaleVal').textContent = Math.round(f.scale * 100) + '%';
    $('#fabCm').value = ppc ? +(f.scale * f.w / ppc).toFixed(1) : '';
    $('#cmHint').textContent = ppc ? '' : 'Set the pattern width (Pattern tab) to use cm';
    $('#fabCm').disabled = !ppc;
  }
  $('#btnMove').classList.toggle('on', moveMode);
  $('#btnOutline').classList.toggle('on', showOutline);
  $('#btnBg').classList.toggle('on', !!P.dropBg);
  $('#thr').value = P.thr; $('#thrVal').textContent = P.thr;
  $('#minArea').value = P.minArea; $('#minVal').textContent = P.minArea;
  $('#patCm').value = P.patCm || '';
  $('#shapeCount').textContent = `${seg.regions.length} shapes detected`;
  $('#title').textContent = P.name;
}

$$('.tabs button[data-tab]').forEach(b => b.onclick = () => {
  const sheet = $('#sheet');
  // tapping the open tab again folds the panel away to give the pattern the full height
  if (b.classList.contains('on') && !sideLayout) { setCollapsed(!sheet.classList.contains('collapsed')); return; }
  $$('.tabs button[data-tab]').forEach(x => x.classList.toggle('on', x === b));
  $$('.panel').forEach(p => p.classList.toggle('hidden', p.id !== 'tab-' + b.dataset.tab));
  setCollapsed(false);
});
function setCollapsed(c) {
  $('#sheet').classList.toggle('collapsed', c);
  $('#sheetToggle').textContent = c ? '▴' : '▾';
}
$('#sheetToggle').onclick = () => setCollapsed(!$('#sheet').classList.contains('collapsed'));

// panel position: bottom (phone) or right (wide / unfolded foldable). "auto" picks by screen shape.
let sideLayout = false;
const getPanelPref = () => { try { return localStorage.getItem('panelPos') || 'auto'; } catch { return 'auto'; } };
function applyLayout() {
  const pref = getPanelPref(), w = innerWidth, h = innerHeight;
  const side = pref === 'right' || (pref === 'auto' && (w >= 700 || (w >= 520 && w > h * 1.1)));
  if (side !== sideLayout || !applyLayout.done) {
    sideLayout = side; applyLayout.done = true;
    $('#editor').classList.toggle('side', side);
    if (side) setCollapsed(false);
    $('#sheetToggle').classList.toggle('hidden', side);
    if (seg) requestAnimationFrame(fitView);
  }
  const lab = { auto: 'Auto', bottom: 'Bottom', right: 'Right side' }[pref];
  const b = $('[data-m="layout"]'); if (b) b.textContent = `Panel position: ${lab} (tap to change)`;
}
addEventListener('resize', applyLayout);

// rotation
const rotInput = $('#rot');
rotInput.addEventListener('pointerdown', snapshot);
rotInput.addEventListener('input', () => {
  const v = curVariant(), val = +rotInput.value;
  for (const id of sel) if (v.assign[id]) v.assign[id].rot = val;
  $('#rotVal').textContent = val + '°'; dirty();
});
$$('[data-rot]').forEach(b => b.onclick = () => {
  if (![...sel].some(id => curVariant().assign[id])) { toast('Select shapes that have a fabric'); return; }
  snapshot();
  const v = curVariant(), d = +b.dataset.rot;
  for (const id of sel) { const a = v.assign[id]; if (a) { a.rot = (((a.rot || 0) + d + 180) % 360 + 360) % 360 - 180; } }
  refreshUI(); dirty();
});
// scale (whole fabric)
$('#scale').addEventListener('pointerdown', snapshot);
$('#scale').addEventListener('input', e => {
  const f = fabById(activeFabric); if (!f) return;
  f.scale = sliderToSc(+e.target.value);
  $('#scaleVal').textContent = Math.round(f.scale * 100) + '%';
  const ppc = pxPerCm(); if (ppc) $('#fabCm').value = +(f.scale * f.w / ppc).toFixed(1);
  dirty();
});
$('#fabCm').addEventListener('change', e => {
  const f = fabById(activeFabric), cm = +e.target.value, ppc = pxPerCm();
  if (!f || !ppc || !(cm > 0)) return;
  snapshot(); f.scale = Math.min(SC_MAX, Math.max(SC_MIN, cm * ppc / f.w)); refreshUI(); dirty();
});
$('#patCm').addEventListener('change', e => { P.patCm = +e.target.value || 0; refreshUI(); scheduleSave(); });
$('#btnMove').onclick = () => { moveMode = !moveMode; refreshUI(); toast(moveMode ? 'Drag on the pattern to slide the fabric in selected shapes' : 'Drag pans the view'); };
$('#btnCenter').onclick = () => { snapshot(); const v = curVariant(); for (const id of sel) if (v.assign[id]) { v.assign[id].dx = 0; v.assign[id].dy = 0; } dirty(); };
$('#btnClear').onclick = () => { snapshot(); const v = curVariant(); for (const id of sel) delete v.assign[id]; refreshUI(); dirty(); };
$('#btnDelFab').onclick = () => {
  if (!confirm('Delete this fabric from the project (and from every option)?')) return;
  P.fabrics = P.fabrics.filter(f => f.id !== activeFabric);
  P.variants.forEach(v => { for (const k in v.assign) if (v.assign[k].f === activeFabric) delete v.assign[k]; });
  fabImgs.delete(activeFabric); activeFabric = null; undoStack = []; refreshUI(); dirty();
};
$('#btnOutline').onclick = () => { showOutline = !showOutline; refreshUI(); redraw(); };
$('#btnBg').onclick = () => { P.dropBg = !P.dropBg; resegment(); };
let segT = 0;
for (const id of ['thr', 'minArea']) {
  $('#' + id).addEventListener('input', e => { $('#' + (id === 'thr' ? 'thrVal' : 'minVal')).textContent = e.target.value; });
  $('#' + id).addEventListener('change', e => { P[id] = +e.target.value; resegment(); });
}

async function resegment() {
  const old = seg;
  const img = await loadImg(P.patternUrl);
  const ns = segment(img, P.thr, P.minArea, P.dropBg);
  if (old) {        // keep assignments: map old shapes to the new shape at the same spot
        const remap = id => { const r = old.regions[id - 1]; if (!r) return 0; const l = ns.label[r.seed]; return l > 0 ? l : ns.label[Math.round(r.cy) * ns.w + Math.round(r.cx)]; };
    for (const v of P.variants) {
      const na = {};
      for (const k in v.assign) { const n = remap(+k); if (n > 0) na[n] = v.assign[k]; }
      v.assign = na;
    }
    sel = new Set([...sel].map(remap).filter(x => x > 0));
  }
  seg = ns; docDirty = true; refreshUI(); redraw();
}

/* ------------------------------------------------------- adding fabrics */
async function fileToCanvas(file, maxDim) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImg(url);
    const k = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c;
  } finally { URL.revokeObjectURL(url); }
}
async function addPhotoFabric(file) {
  if (!file) return;
  const c = await fileToCanvas(file, 1024);
  const med = [...seg.regions].map(r => Math.sqrt(r.area)).sort((a, b) => a - b)[seg.regions.length >> 1] || 100;
  const f = { id: uid(), type: 'photo', img: c.toDataURL('image/jpeg', 0.88), w: c.width, h: c.height, scale: Math.min(SC_MAX, Math.max(SC_MIN, med * 6 / c.width)) };
  P.fabrics.push(f); await loadFabricImage(f);
  chooseFabric(f.id); scheduleSave();
  toast('Fabric added – adjust size/rotation in the Adjust tab');
}
$('#fileCam').onchange = async e => { await addPhotoFabric(e.target.files[0]); e.target.value = ''; };
$('#fileGal').onchange = async e => { await addPhotoFabric(e.target.files[0]); e.target.value = ''; };

/* --------------------------------------------------------- colour picker */
const wheel = $('#wheel'), wctx = wheel.getContext('2d'), dot = $('#wheelDot');
const HSV = { h: 0, s: 0, v: 1 }; let editingFab = null;
function hsv2rgb(h, s, v) {
  const f = n => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [f(5) * 255, f(3) * 255, f(1) * 255].map(Math.round);
}
function rgb2hsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; let h = 0;
  if (d) h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s: mx ? d / mx : 0, v: mx };
}
const toHex = ([r, g, b]) => '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
function drawWheel() {
  const n = 240, im = wctx.createImageData(n, n), R = n / 2;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const dx = x - R + .5, dy = y - R + .5, r = Math.hypot(dx, dy), i = (y * n + x) * 4;
    if (r > R) continue;
    const h = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
    const [cr, cg, cb] = hsv2rgb(h, r / R, HSV.v);
    im.data[i] = cr; im.data[i + 1] = cg; im.data[i + 2] = cb; im.data[i + 3] = 255;
  }
  wctx.putImageData(im, 0, 0);
  const a = HSV.h * Math.PI / 180, rr = HSV.s * R;
  dot.style.left = R + Math.cos(a) * rr + 'px'; dot.style.top = R + Math.sin(a) * rr + 'px';
  const hex = toHex(hsv2rgb(HSV.h, HSV.s, HSV.v));
  $('#hex').value = hex; $('#colPrev').style.background = hex; $('#val').value = HSV.v * 100;
}
function wheelPick(e) {
  const rect = wheel.getBoundingClientRect(), R = rect.width / 2;
  const dx = e.clientX - rect.left - R, dy = e.clientY - rect.top - R;
  HSV.h = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360; HSV.s = Math.min(1, Math.hypot(dx, dy) / R); drawWheel();
}
wheel.addEventListener('pointerdown', e => { wheel.setPointerCapture(e.pointerId); wheelPick(e); });
wheel.addEventListener('pointermove', e => { if (wheel.hasPointerCapture(e.pointerId)) wheelPick(e); });
$('#val').addEventListener('input', e => { HSV.v = e.target.value / 100; drawWheel(); });
$('#hex').addEventListener('change', e => {
  const m = /^#?([0-9a-f]{6})$/i.exec(e.target.value.trim()); if (!m) return;
  const n = parseInt(m[1], 16); Object.assign(HSV, rgb2hsv(n >> 16, (n >> 8) & 255, n & 255)); drawWheel();
});
const PALETTE = ['#ffffff', '#f5f0e6', '#d9d9d9', '#8a8a8a', '#3a3a3a', '#000000', '#f4c7c3', '#e57373',
  '#c62828', '#8e1b3a', '#ffb74d', '#f57c00', '#ffe082', '#fdd835', '#c5e1a5', '#7cb342',
  '#2e7d32', '#1b5e20', '#80cbc4', '#26a69a', '#81d4fa', '#1e88e5', '#0d47a1', '#1a237e',
  '#ce93d8', '#8e24aa', '#4a148c', '#f8bbd0', '#ec407a', '#a1887f', '#6d4c41', '#3e2723'];
$('#palette').innerHTML = '';
PALETTE.forEach(c => {
  const b = document.createElement('button'); b.style.background = c; b.setAttribute('aria-label', c);
  b.onclick = () => { const n = parseInt(c.slice(1), 16); Object.assign(HSV, rgb2hsv(n >> 16, (n >> 8) & 255, n & 255)); drawWheel(); };
  $('#palette').appendChild(b);
});
function openColor(fab) {
  editingFab = fab || null;
  const c = fab ? fab.color : '#e57373', n = parseInt(c.slice(1), 16);
  Object.assign(HSV, rgb2hsv(n >> 16, (n >> 8) & 255, n & 255)); drawWheel();
  $('#dlgColor').showModal();
}
$('#addColor').onclick = () => openColor(null);
$('#btnEditFab').onclick = () => { const f = fabById(activeFabric); if (f && f.type === 'color') openColor(f); };
$('#colCancel').onclick = () => $('#dlgColor').close();
$('#colOk').onclick = () => {
  const hex = toHex(hsv2rgb(HSV.h, HSV.s, HSV.v));
  $('#dlgColor').close();
  if (editingFab) { snapshot(); editingFab.color = hex; refreshUI(); dirty(); }
  else {
    const f = { id: uid(), type: 'color', color: hex }; P.fabrics.push(f); chooseFabric(f.id); scheduleSave();
  }
};

/* -------------------------------------------------------- compare / menu */
$('#btnCompare').onclick = () => {
  const g = $('#cmpGrid'); g.innerHTML = '';
  const c = document.createElement('canvas');
  for (const v of P.variants) {
    composite(v, c);
    const card = document.createElement('div'); card.className = 'cmpcard';
    const cv = document.createElement('canvas'); const k = Math.min(1, 900 / c.width);
    cv.width = Math.round(c.width * k); cv.height = Math.round(c.height * k);
    cv.getContext('2d').drawImage(c, 0, 0, cv.width, cv.height);
    const t = document.createElement('div'); t.textContent = v.name + (v.id === P.cur ? ' (current)' : '');
    card.append(cv, t);
    card.onclick = () => { P.cur = v.id; sel.clear(); $('#dlgCompare').close(); renderVariants(); onSelectionChanged(); dirty(); };
    g.appendChild(card);
  }
  $('#dlgCompare').showModal();
};
$('#cmpClose').onclick = () => $('#dlgCompare').close();

$('#btnMenu').onclick = () => $('#dlgMenu').showModal();
$('#dlgMenu').addEventListener('click', async e => {
  const m = e.target.dataset.m; if (!m) return;
  const dlg = $('#dlgMenu'); const v = curVariant();
  if (m === 'close') return dlg.close();
  if (m === 'replace') { $('#fileReplace').click(); return; }
  if (m === 'layout') {
    const next = { auto: 'right', right: 'bottom', bottom: 'auto' }[getPanelPref()];
    try { localStorage.setItem('panelPos', next); } catch {}
    applyLayout(); return;
  }
  dlg.close();
  if (m === 'rename-v') { const n = prompt('Name for this option', v.name); if (n) { v.name = n; renderVariants(); scheduleSave(); } }
  if (m === 'dup-v') addVariant(true);
  if (m === 'del-v') {
    if (P.variants.length < 2) return toast('Need at least one option');
    if (!confirm(`Delete "${v.name}"?`)) return;
    P.variants = P.variants.filter(x => x !== v); P.cur = P.variants[0].id; sel.clear(); undoStack = [];
    renderVariants(); onSelectionChanged(); dirty();
  }
  if (m === 'rename-p') { const n = prompt('Project name', P.name); if (n) { P.name = n; refreshUI(); scheduleSave(); } }
  if (m === 'export') exportPng();
  if (m === 'del-p') { if (confirm('Delete this whole project?')) { await DB.del(P.id); P = null; goHome(); } }
});
function exportPng() {
  const c = document.createElement('canvas'); composite(curVariant(), c);
  c.toBlob(b => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `${P.name} - ${curVariant().name}.png`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); });
}
$('#zIn').onclick = () => zoomAt(view.clientWidth / 2, view.clientHeight / 2, 1.4);
$('#zOut').onclick = () => zoomAt(view.clientWidth / 2, view.clientHeight / 2, 1 / 1.4);
$('#zFit').onclick = fitView;

/* --------------------------------------------------- pattern import (+PDF) */
let pdfjs = null;
async function loadPdfjs() {
  if (pdfjs) return pdfjs;
  pdfjs = await import('./vendor/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;
  return pdfjs;
}
async function renderPdfPage(pdf, n, maxDim) {
  const page = await pdf.getPage(n), vp0 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: maxDim / Math.max(vp0.width, vp0.height) });
  const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: x, viewport: vp }).promise;
  return c;
}
// returns a canvas for an image or chosen PDF page, or null if cancelled
async function pickPatternCanvas(file) {
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
    const lib = await loadPdfjs();
    const pdf = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
    if (pdf.numPages === 1) return renderPdfPage(pdf, 1, 2000);
    let n = 1;
    const show = async () => {
      $('#pdfNo').textContent = n; $('#pdfN').textContent = pdf.numPages;
      const c = await renderPdfPage(pdf, n, 700); const p = $('#pdfPrev'); p.width = c.width; p.height = c.height; p.getContext('2d').drawImage(c, 0, 0);
    };
    await show();
    return new Promise(res => {
      const dlg = $('#dlgPdf'); dlg.showModal();
      $('#pdfPrevBtn').onclick = () => { if (n > 1) { n--; show(); } };
      $('#pdfNextBtn').onclick = () => { if (n < pdf.numPages) { n++; show(); } };
      $('#pdfCancel').onclick = () => { dlg.close(); res(null); };
      $('#pdfOk').onclick = async () => { dlg.close(); res(await renderPdfPage(pdf, n, 2000)); };
    });
  }
  return fileToCanvas(file, 2000);
}
const canvasToBlob = c => new Promise(r => c.toBlob(r, 'image/png'));

$('#fileNew').onchange = async e => {
  const file = e.target.files[0]; e.target.value = ''; if (!file) return;
  try {
    const c = await pickPatternCanvas(file); if (!c) return;
    const blob = await canvasToBlob(c);
    const p = {
      id: uid(), name: file.name.replace(/\.[^.]+$/, '') || 'My quilt', pattern: blob, thr: autoThreshold(c), minArea: 60, dropBg: true, patCm: 0,
      fabrics: [], variants: [{ id: 'a', name: 'Option A', assign: {} }], cur: 'a', updated: Date.now(),
    };
    await DB.put(p); await openProject(p);
    toast('Tap a shape, then pick a fabric. If shapes look wrong, see the Pattern tab.', 4000);
  } catch (err) { console.error(err); alert('Could not open that file: ' + err.message); }
};
$('#fileReplace').onchange = async e => {
  const file = e.target.files[0]; e.target.value = ''; $('#dlgMenu').close(); if (!file) return;
  const c = await pickPatternCanvas(file); if (!c) return;
  if (!confirm('Replace the pattern image? Fabric assignments are kept where shapes overlap.')) return;
  URL.revokeObjectURL(P.patternUrl);
  P.pattern = await canvasToBlob(c); P.patternUrl = URL.createObjectURL(P.pattern);
  await resegment(); dirty();
};

/* ------------------------------------------------------------- navigation */
async function openProject(p) {
  P = p; undoStack = []; sel = new Set(); activeFabric = null; moveMode = false; showOutline = false; fabImgs.clear();
  P.patternUrl = URL.createObjectURL(P.pattern);
  $('#home').classList.add('hidden'); $('#editor').classList.remove('hidden');
  seg = null; await resegment();
  for (const f of P.fabrics) await loadFabricImage(f);
  renderVariants(); refreshUI(); docDirty = true;
  requestAnimationFrame(() => { fitView(); });
}
async function goHome() {
  if (P) {
    try {
      if (seg) { composite(curVariant(), doc); const t = document.createElement('canvas'); const k = 320 / Math.max(doc.width, doc.height); t.width = doc.width * k; t.height = doc.height * k; t.getContext('2d').drawImage(doc, 0, 0, t.width, t.height); P.thumb = t.toDataURL('image/jpeg', 0.8); }
      clearTimeout(saveTimer); P.updated = Date.now();
      const { patternUrl, ...rest } = P; await DB.put(rest);
    } catch (e) { console.error(e); }
    URL.revokeObjectURL(P.patternUrl);
  }
  P = null; seg = null;
  $('#editor').classList.add('hidden'); $('#home').classList.remove('hidden');
  renderHome();
}
// patternUrl is runtime-only: never persist it
const _put = DB.put;
DB.put = p => { const { patternUrl, ...rest } = p; return _put(rest); };
$('#btnBack').onclick = goHome;

async function renderHome() {
  const list = (await DB.all()).sort((a, b) => b.updated - a.updated), box = $('#projects');
  box.innerHTML = '';
  for (const p of list) {
    const el = document.createElement('div'); el.className = 'proj';
    const img = document.createElement('img'); img.alt = '';
    img.src = p.thumb || URL.createObjectURL(p.pattern);
    const t = document.createElement('div'); t.textContent = p.name;
    el.append(img, t); el.onclick = () => openProject(p); box.appendChild(el);
  }
  if (!list.length) box.innerHTML = '<p class="muted">No projects yet.</p>';
}

/* -------------------------------------------------------------------- boot */
(async () => {
  await DB.open();
  applyLayout();
  renderHome();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  navigator.storage && navigator.storage.persist && navigator.storage.persist();
  window.__app = { get P() { return P; }, get seg() { return seg; }, sel: () => sel }; // handy for debugging/tests
})();
