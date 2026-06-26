/* ============================================================
   FlowMark — Water system schematic editor for Legionella RAs
   Vanilla JS. Single canvas. Offline-first PWA.
   ============================================================ */
'use strict';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const uid = () => Math.random().toString(36).slice(2, 9);
const GRID = 20;

/* ---------- Page (printable sheet) ----------
   World units == CSS px @96dpi. A4 is ~1.414:1; we use 1120×800 so the sheet
   lands on whole grid cells (56×40). The page sits at world origin (0,0). */
const A4 = { long: 1120, short: 800 };
function pageDims() {
  return (state.page && state.page.orientation === 'portrait')
    ? { w: A4.short, h: A4.long }
    : { w: A4.long, h: A4.short };
}
function pageBounds() { const d = pageDims(); return { x: 0, y: 0, w: d.w, h: d.h }; }

/* ---------- Asset & pipe definitions ---------- */
const ASSETS = {
  tank:     { w: 84, h: 54, name: 'Cold water storage tank', tag: 'TK', fields: ['volume', 'risk'] },
  softener: { w: 40, h: 60, name: 'Water softener', tag: 'WS', fields: ['volume', 'risk'] },
  heater:   { w: 46, h: 56, name: 'Water heater / calorifier', tag: 'WH', fields: ['volume', 'risk'] },
  boiler:   { w: 52, h: 60, name: 'Steam boiler', tag: 'SB', fields: ['volume', 'risk'] },
  pump:   { w: 30, h: 30, name: 'Pump', tag: 'P', fields: [] },
  tmv:    { w: 28, h: 28, name: 'Thermostatic mixing valve', tag: 'T', fields: ['risk'] },
  mixer:  { w: 28, h: 28, name: 'Mixer tap', tag: 'M', fields: [] },
  shower: { w: 32, h: 36, name: 'Shower', tag: 'SH', fields: ['risk'] },
  outlet: { w: 22, h: 22, name: 'Outlet / tap', tag: '', fields: [] },
  cap:    { w: 22, h: 22, name: 'Capped / blanked end', tag: '', fields: [] },
};
const PIPES = {
  coldMains: { color: '#16a34a', width: 2,   dash: [],     name: 'Cold — mains' },
  coldTank:  { color: '#2563eb', width: 2,   dash: [7, 5], name: 'Cold — tank' },
  hotFlow:   { color: '#dc2626', width: 2,   dash: [],     name: 'Hot — flow' },
  hotReturn: { color: '#dc2626', width: 2,   dash: [7, 5], name: 'Hot — return' },
  deadleg:   { color: '#000000', width: 3,   dash: [],     name: 'Deadleg' },
};
const RISK = { A: '#16a34a', B: '#65a30d', C: '#d97706', D: '#ea580c', E: '#dc2626' };
const ZONE_COLORS = ['#e0f2fe', '#dcfce7', '#fef9c3', '#fae8ff', '#ffedd5', '#e2e8f0'];

/* ---------- State ---------- */
let state = blankState();
function blankState() {
  return { name: 'Untitled schematic', page: { orientation: 'landscape' }, meta: { customer: '', site: '', date: '' }, zones: [], nodes: [], pipes: [], texts: [] };
}
let view = { scale: 1, ox: 0, oy: 0 };
let tool = 'select';
let pipeKind = 'coldMains';
let assetKind = 'tank';
let sel = null;               // {kind:'node'|'pipe'|'zone'|'text', id}  — single selection (drives inspector)
let group = [];               // multi-selection: array of {kind,id}. When >1, sel is null.
let draft = null;             // pipe being drawn
let ortho = true;             // right-angle pipe mode
let showGrid = true, snapOn = true, showLegend = true, showFooter = true;
let dirty = false;

/* undo stack */
const undoStack = [], redoStack = [];
function snapshot() { undoStack.push(JSON.stringify(state)); if (undoStack.length > 60) undoStack.shift(); redoStack.length = 0; }
function commit() { dirty = true; autosave(); updateStatus(); draw(); }
function mutate(fn) { snapshot(); fn(); commit(); }

/* ---------- Canvas setup ---------- */
const canvas = $('#canvas');
const ctx = canvas.getContext('2d');
let dpr = Math.max(1, window.devicePixelRatio || 1);
function resize() {
  dpr = Math.max(1, window.devicePixelRatio || 1);
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  draw();
}
window.addEventListener('resize', resize);

/* ---------- Coordinate transforms ---------- */
const sx = wx => wx * view.scale + view.ox;
const sy = wy => wy * view.scale + view.oy;
const wx = px => (px - view.ox) / view.scale;
const wy = py => (py - view.oy) / view.scale;
const snap = v => snapOn ? Math.round(v / GRID) * GRID : v;
function pointerWorld(e) {
  const r = canvas.getBoundingClientRect();
  return { x: wx(e.clientX - r.left), y: wy(e.clientY - r.top) };
}

/* ---------- Node helpers ---------- */
const nodeById = id => state.nodes.find(n => n.id === id);
function ptPos(pt) { if (pt.node) { const n = nodeById(pt.node); if (n) return { x: n.x, y: n.y }; } return { x: pt.x, y: pt.y }; }

/* Where a pipe should meet an asset: a point on the asset's bounding-box
   edge facing the approaching segment, rather than its centre. When the
   approach lines up with a face it gives a clean perpendicular join (the
   orthogonal look); otherwise it clips the centre→approach ray to the box. */
function edgePoint(n, from) {
  const cx = n.x, cy = n.y, hw = n.w / 2, hh = n.h / 2;
  const dx = from.x - cx, dy = from.y - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  const horiz = Math.abs(dx) / hw >= Math.abs(dy) / hh;
  if (horiz) {
    if (from.y >= cy - hh && from.y <= cy + hh) return { x: cx + Math.sign(dx) * hw, y: from.y };
  } else {
    if (from.x >= cx - hw && from.x <= cx + hw) return { x: from.x, y: cy + Math.sign(dy) * hh };
  }
  const tx = dx ? hw / Math.abs(dx) : Infinity;
  const ty = dy ? hh / Math.abs(dy) : Infinity;
  const t = Math.min(tx, ty);
  return { x: cx + dx * t, y: cy + dy * t };
}

/* Resolve a list of pipe point descriptors to world positions, snapping any
   node-bound point to the asset edge facing its neighbour. */
function resolvePipePts(pts) {
  const raw = pts.map(ptPos);
  return pts.map((pt, i) => {
    if (!pt.node) return raw[i];
    const n = nodeById(pt.node);
    if (!n) return raw[i];
    const ref = raw[i - 1] || raw[i + 1];
    return ref ? edgePoint(n, ref) : raw[i];
  });
}

/* ---------- Text label layout (multi-line + word-wrap) ----------
   Labels may contain explicit line breaks (\n) and/or an optional
   `wrap` width (world units) that word-wraps long room names. A `align`
   of 'center' centres each wrapped line under the widest one; the label
   anchor (t.x, t.y) stays the top-left / first-line baseline so existing
   single-line labels render exactly where they always did. */
const LABEL_FONT_STACK = 'Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const labelFont = px => `${px}px ${LABEL_FONT_STACK}`;

/* ============================================================
   ARA BRANDING — title-block footer
   A solid dark-purple banner across the foot of the sheet: the white Ara logo
   in the corner, then Customer / Site / Date fields. Drawn in world space inside
   drawScene so it appears identically on screen and in PDF/JPG exports, sitting
   on top of the schematic as a reserved title-block region.
   ============================================================ */
const BRAND = {
  purple:  '#1a0f2f',          // dark brand purple — solid footer block
  accent:  '#a179f5',          // logo dot purple — field labels
  text:    '#ffffff',
  ruleA:   'rgba(255,255,255,.16)',
  ruleB:   'rgba(255,255,255,.12)',
};
const FOOT_H = 64;             // title-block band height, world units
const LOGO_ASPECT = 9.3166;   // white linear logo, width : height
const araLogo = new Image();
let araLogoReady = false;
araLogo.onload = () => { araLogoReady = true; draw(); };
araLogo.src = 'data:image/png;base64,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';

/* Footer band in world units — a full-width strip at the foot of the sheet. */
function footerWorldRect() { const d = pageDims(); return { x: 0, y: d.h - FOOT_H, w: d.w, h: FOOT_H }; }

/* Trim a string with an ellipsis so it fits maxW px in the current ctx font. */
function fitText(c, str, maxW) {
  if (c.measureText(str).width <= maxW) return str;
  const ell = '…';
  let lo = 0, hi = str.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (c.measureText(str.slice(0, mid) + ell).width <= maxW) lo = mid; else hi = mid - 1;
  }
  return lo > 0 ? str.slice(0, lo) + ell : ell;
}

/* Draw the branded title-block band. T maps world->device px (same transform the
   scene is drawn with), so the band scales with the sheet on screen and prints
   at true size in exports (compose = 1). */
function drawFooter(c, T) {
  const S = T.scale, OX = T.ox, OY = T.oy;
  const r = footerWorldRect();
  const x = r.x * S + OX, y = r.y * S + OY, w = r.w * S, h = r.h * S;
  const cy = y + h / 2;
  const pad = 20 * S, gap = 16 * S;

  c.save();
  // solid brand-purple block
  c.fillStyle = BRAND.purple;
  c.fillRect(x, y, w, h);

  // --- white logo (corner) ---
  let cx = x + pad;
  const logoH = 22 * S, logoW = logoH * LOGO_ASPECT;
  if (araLogoReady) {
    c.drawImage(araLogo, cx, cy - logoH / 2, logoW, logoH);
  } else {
    // graceful fallback wordmark until the logo image decodes
    c.fillStyle = BRAND.accent;
    c.beginPath(); c.arc(cx + 6 * S, cy, 6 * S, 0, Math.PI * 2); c.fill();
    c.beginPath(); c.arc(cx + 20 * S, cy, 6 * S, 0, Math.PI * 2); c.fill();
    c.fillStyle = BRAND.text; c.textAlign = 'left'; c.textBaseline = 'middle';
    c.font = `800 ${18 * S}px ${LABEL_FONT_STACK}`;
    c.fillText('ARA', cx + 32 * S, cy + 1 * S);
  }
  cx += logoW + gap;

  // divider after the logo
  c.strokeStyle = BRAND.ruleA; c.lineWidth = Math.max(1, S);
  c.beginPath(); c.moveTo(cx, y + 12 * S); c.lineTo(cx, y + h - 12 * S); c.stroke();
  cx += gap;

  // --- fields: Customer / Site / Date ---
  const m = state.meta || {};
  const dateStr = (m.date && m.date.trim()) || new Date().toLocaleDateString('en-GB');
  const fields = [
    ['CUSTOMER', (m.customer || '').trim() || '—'],
    ['SITE',     (m.site || '').trim()     || '—'],
    ['DATE',     dateStr],
  ];
  const right = x + w - pad;
  const colGap = gap;
  const colW = (right - cx - colGap * (fields.length - 1)) / fields.length;
  const labelFs = Math.max(7, 8.5 * S), valueFs = 13 * S;
  for (let i = 0; i < fields.length; i++) {
    const colX = cx + i * (colW + colGap);
    if (i > 0) {   // thin rule between columns
      const dx = colX - colGap / 2;
      c.strokeStyle = BRAND.ruleB; c.lineWidth = Math.max(1, S);
      c.beginPath(); c.moveTo(dx, y + 12 * S); c.lineTo(dx, y + h - 12 * S); c.stroke();
    }
    c.textAlign = 'left'; c.textBaseline = 'alphabetic';
    c.fillStyle = BRAND.accent; c.font = `700 ${labelFs}px ${LABEL_FONT_STACK}`;
    c.fillText(fields[i][0], colX, cy - 4 * S);
    c.fillStyle = BRAND.text; c.font = `600 ${valueFs}px ${LABEL_FONT_STACK}`;
    c.fillText(fitText(c, String(fields[i][1]), colW), colX, cy + valueFs * 0.92);
  }
  c.restore();
}
const _measCtx = document.createElement('canvas').getContext('2d');

function wrapWords(line, font, maxW) {
  _measCtx.font = font;
  if (_measCtx.measureText(line).width <= maxW) return [line];
  const out = []; let cur = '';
  for (let word of line.split(' ')) {
    // hard-break a single word that can't fit on a line on its own
    while (_measCtx.measureText(word).width > maxW && word.length > 1) {
      let i = 1;
      while (i < word.length && _measCtx.measureText(word.slice(0, i + 1)).width <= maxW) i++;
      if (cur) { out.push(cur); cur = ''; }
      out.push(word.slice(0, i)); word = word.slice(i);
    }
    const test = cur ? cur + ' ' + word : word;
    if (cur && _measCtx.measureText(test).width > maxW) { out.push(cur); cur = word; }
    else cur = test;
  }
  if (cur) out.push(cur);
  return out.length ? out : [''];
}
/* Zone name tab geometry (world units). The tab is a fixed-height banner sized
   to the label; `z.labelPos` ('tl' default, plus tc/tr/bl/bc/br) places it on a
   chosen corner or edge-centre so it can be moved clear of schematic content.
   Returns null for unlabelled zones. Used by both the renderer and hit-test so
   the grab band always tracks the drawn tab. */
const ZONE_TAB_H = 20;          // screen px, constant regardless of zoom
function zoneLabelRect(z, S) {
  if (!z.label) return null;
  _measCtx.font = `700 ${Math.max(11, 13 * Math.min(S, 1.4))}px ${LABEL_FONT_STACK}`;
  const ww = (_measCtx.measureText(z.label).width + 16) / S;
  const hh = ZONE_TAB_H / S;
  const pos = z.labelPos || 'tl';
  let lx = z.x, ly = z.y;
  if (pos === 'tr' || pos === 'br') lx = z.x + z.w - ww;
  else if (pos === 'tc' || pos === 'bc') lx = z.x + (z.w - ww) / 2;
  if (pos[0] === 'b') ly = z.y + z.h - hh;
  return { x: lx, y: ly, w: ww, h: hh };
}

function textLines(t) {
  const raw = String(t.text == null ? '' : t.text).split(/\r?\n/);
  const wrap = +t.wrap || 0;
  if (!wrap) return raw.length ? raw : [''];
  const font = labelFont(t.size || 14);
  const out = [];
  for (const ln of raw) out.push(...wrapWords(ln, font, wrap));
  return out.length ? out : [''];
}
/* World-unit metrics for hit-testing and export/fit bounds. */
function textBlock(t) {
  const size = t.size || 14;
  const lines = textLines(t);
  _measCtx.font = labelFont(size);
  let maxW = 0;
  for (const ln of lines) maxW = Math.max(maxW, _measCtx.measureText(ln).width);
  const lineH = size * 1.3;
  return { lines, size, lineH, w: maxW, h: (lines.length - 1) * lineH + size, ascent: size * 0.82 };
}
function drawText(c, t, S, X, Y) {
  const size = t.size || 14;
  const fs = size * Math.min(S, 1.6);   // same readability cap used by other labels
  const lh = fs * 1.3;
  const lines = textLines(t);
  c.font = labelFont(fs);
  c.textAlign = 'left'; c.textBaseline = 'alphabetic';
  c.fillStyle = t.color || '#1f2c3a';
  const bx = X(t.x), by = Y(t.y);
  if (t.align === 'center') {
    let maxW = 0; const widths = lines.map(ln => { const w = c.measureText(ln).width; if (w > maxW) maxW = w; return w; });
    for (let i = 0; i < lines.length; i++) c.fillText(lines[i], bx + (maxW - widths[i]) / 2, by + i * lh);
  } else {
    for (let i = 0; i < lines.length; i++) c.fillText(lines[i], bx, by + i * lh);
  }
}

/* ============================================================
   RENDER
   ============================================================ */
function draw() {
  const W = canvas.width, H = canvas.height;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const cssW = W / dpr, cssH = H / dpr;
  drawDesk(cssW, cssH);          // neutral surface behind the sheet
  drawPage();                    // white A4 sheet (shadow + border)
  if (showGrid) drawGrid();      // grid is clipped to the sheet
  drawScene(ctx, view, { legend: showLegend, footer: showFooter, legendFrame: { x: 0, y: 0, w: cssW, h: cssH }, legendMargin: 14 });
  if (sel) drawSelection();
  if (group.length) drawSelection();
  if (drag && drag.mode === 'marquee') drawMarquee();
  if (draft) drawDraft();
}

/* The "desk" — everything outside the page reads as off-sheet. */
function drawDesk(cssW, cssH) {
  ctx.fillStyle = '#e7edf3';
  ctx.fillRect(0, 0, cssW, cssH);
}

/* The printable A4 sheet at world origin, drawn as paper with a soft shadow. */
function drawPage() {
  const d = pageDims();
  const x = sx(0), y = sy(0), w = d.w * view.scale, h = d.h * view.scale;
  ctx.save();
  ctx.shadowColor = 'rgba(15,30,50,.18)';
  ctx.shadowBlur = 18; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 6;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x, y, w, h);
  ctx.restore();
  ctx.strokeStyle = '#c2cedb'; ctx.lineWidth = 1;
  ctx.strokeRect(x + .5, y + .5, Math.round(w), Math.round(h));
}

function drawMarquee() {
  const a = drag.start, b = drag.cur;
  const x = sx(Math.min(a.x, b.x)), y = sy(Math.min(a.y, b.y));
  const w = Math.abs(b.x - a.x) * view.scale, h = Math.abs(b.y - a.y) * view.scale;
  ctx.save();
  ctx.fillStyle = 'rgba(10,166,196,.10)';
  ctx.strokeStyle = '#0aa6c4'; ctx.lineWidth = 1; ctx.setLineDash([5, 3]);
  ctx.fillRect(x, y, w, h); ctx.strokeRect(x + .5, y + .5, w, h);
  ctx.restore();
}

function drawGrid() {
  const cssW = canvas.width / dpr, cssH = canvas.height / dpr;
  const step = GRID * view.scale;
  if (step < 6) return;
  // Confine the grid to the sheet so the page edge stays legible.
  const d = pageDims();
  ctx.save();
  ctx.beginPath();
  ctx.rect(sx(0), sy(0), d.w * view.scale, d.h * view.scale);
  ctx.clip();
  const x0 = ((view.ox % step) + step) % step;
  const y0 = ((view.oy % step) + step) % step;
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#e8eef4';
  ctx.beginPath();
  for (let x = x0; x < cssW; x += step) { ctx.moveTo(x + .5, 0); ctx.lineTo(x + .5, cssH); }
  for (let y = y0; y < cssH; y += step) { ctx.moveTo(0, y + .5); ctx.lineTo(cssW, y + .5); }
  ctx.stroke();
  // stronger every 5
  const big = step * 5;
  const bx = ((view.ox % big) + big) % big, by = ((view.oy % big) + big) % big;
  ctx.strokeStyle = '#d7e0ea';
  ctx.beginPath();
  for (let x = bx; x < cssW; x += big) { ctx.moveTo(x + .5, 0); ctx.lineTo(x + .5, cssH); }
  for (let y = by; y < cssH; y += big) { ctx.moveTo(0, y + .5); ctx.lineTo(cssW, y + .5); }
  ctx.stroke();
  ctx.restore();
}

/* Transform-based grid, clipped to the sheet. Works for any world->device
   transform T, so the export path can lay the same grid behind the scene. The
   on-screen drawGrid above stays as-is; this one is used by renderExportCanvas. */
function drawGridOn(c, T) {
  const S = T.scale, OX = T.ox, OY = T.oy;
  if (GRID * S < 6) return;
  const d = pageDims();
  const X = w => w * S + OX, Y = h => h * S + OY;
  const x0 = X(0), y0 = Y(0), x1 = X(d.w), y1 = Y(d.h);
  c.save();
  c.beginPath(); c.rect(x0, y0, d.w * S, d.h * S); c.clip();
  c.lineWidth = 1;
  c.strokeStyle = '#e8eef4';                       // minor lines
  c.beginPath();
  for (let gx = 0; gx <= d.w + .5; gx += GRID) { const px = X(gx); c.moveTo(px, y0); c.lineTo(px, y1); }
  for (let gy = 0; gy <= d.h + .5; gy += GRID) { const py = Y(gy); c.moveTo(x0, py); c.lineTo(x1, py); }
  c.stroke();
  c.strokeStyle = '#d7e0ea';                       // stronger every 5
  c.beginPath();
  const big = GRID * 5;
  for (let gx = 0; gx <= d.w + .5; gx += big) { const px = X(gx); c.moveTo(px, y0); c.lineTo(px, y1); }
  for (let gy = 0; gy <= d.h + .5; gy += big) { const py = Y(gy); c.moveTo(x0, py); c.lineTo(x1, py); }
  c.stroke();
  c.restore();
}

/* Reusable scene render. T maps world->device-css px. */
function drawScene(c, T, opts = {}) {
  const S = T.scale, OX = T.ox, OY = T.oy;
  const X = wxv => wxv * S + OX, Y = wyv => wyv * S + OY;
  // zones (behind)
  for (const z of state.zones) {
    const x = X(z.x), y = Y(z.y), w = z.w * S, h = z.h * S;
    c.fillStyle = z.color || '#eef2f7';
    c.globalAlpha = 0.5; c.fillRect(x, y, w, h); c.globalAlpha = 1;
    c.strokeStyle = '#7c93a8'; c.lineWidth = 1.5; c.setLineDash([6, 5]);
    c.strokeRect(x, y, w, h); c.setLineDash([]);
    if (z.label) {
      const lr = zoneLabelRect(z, S);
      const lx = X(lr.x), ly = Y(lr.y), lw = lr.w * S, lh = lr.h * S;
      c.font = `700 ${Math.max(11, 13 * Math.min(S, 1.4))}px ${LABEL_FONT_STACK}`;
      c.fillStyle = '#475569'; c.globalAlpha = .9;
      c.fillRect(lx, ly, lw, lh); c.globalAlpha = 1;
      c.fillStyle = '#fff'; c.textAlign = 'left'; c.textBaseline = 'middle';
      c.fillText(z.label, lx + 8, ly + lh / 2 + 1);
    }
  }
  // pipes
  for (const p of state.pipes) drawPipe(c, p, S, OX, OY);
  // nodes
  for (const n of state.nodes) drawNode(c, n, S, OX, OY);
  // texts (multi-line + optional word-wrap)
  for (const t of state.texts) drawText(c, t, S, X, Y);
  // branded title-block footer (drawn on top, as a reserved band)
  let legendExtra = opts.legendExtra || [];
  if (opts.footer) {
    drawFooter(c, T);
    const r = footerWorldRect();
    legendExtra = legendExtra.concat([{ x: X(r.x), y: Y(r.y), w: r.w * S, h: r.h * S }]);
  }
  if (opts.legend) {
    const frame = opts.legendFrame || { x: 0, y: 0, w: 0, h: 0 };
    const [lx, ly] = placeLegend(c, T, frame, opts.legendMargin ?? 14, legendExtra);
    drawLegend(c, lx, ly);
  }
}

function drawPipe(c, p, S, OX, OY) {
  const cfg = PIPES[p.type] || PIPES.coldMains;
  const pts = resolvePipePts(p.pts);
  if (pts.length < 2) return;
  c.beginPath();
  c.moveTo(pts[0].x * S + OX, pts[0].y * S + OY);
  for (let i = 1; i < pts.length; i++) c.lineTo(pts[i].x * S + OX, pts[i].y * S + OY);
  c.strokeStyle = cfg.color;
  c.lineWidth = cfg.width * Math.max(.8, Math.min(S, 1.6));
  c.lineJoin = 'round'; c.lineCap = 'round';
  c.setLineDash(cfg.dash.map(d => d * Math.max(.8, Math.min(S, 1.4))));
  c.stroke(); c.setLineDash([]);
  // deadleg end cap marker
  if (p.type === 'deadleg') {
    const e = pts[pts.length - 1], b = pts[pts.length - 2];
    const ang = Math.atan2(e.y - b.y, e.x - b.x) + Math.PI / 2;
    const ex = e.x * S + OX, ey = e.y * S + OY, len = 6 * Math.min(S, 1.6);
    c.beginPath();
    c.moveTo(ex + Math.cos(ang) * len, ey + Math.sin(ang) * len);
    c.lineTo(ex - Math.cos(ang) * len, ey - Math.sin(ang) * len);
    c.strokeStyle = cfg.color; c.lineWidth = cfg.width * Math.min(S, 1.4); c.stroke();
  }
}

function drawNode(c, n, S, OX, OY) {
  const cx = n.x * S + OX, cy = n.y * S + OY;
  const w = n.w * S, h = n.h * S;
  const x = cx - w / 2, y = cy - h / 2;
  c.lineJoin = 'round';
  const lab = n.label || ASSETS[n.type].tag;
  const monoFont = wt => `${wt} ${Math.max(8, 11 * Math.min(S, 1.5))}px var(--mono,monospace)`;
  c.textAlign = 'center'; c.textBaseline = 'middle';

  switch (n.type) {
    case 'tank': {
      c.fillStyle = '#eaf1f8'; c.strokeStyle = '#33485f'; c.lineWidth = 1.6;
      roundRect(c, x, y, w, h, 3); c.fill(); c.stroke();
      c.strokeStyle = '#9db4c9'; c.lineWidth = 1;
      c.beginPath();
      c.moveTo(x + 4, y + h * 0.42); c.lineTo(x + w - 4, y + h * 0.42);
      c.moveTo(x + 4, y + h * 0.66); c.lineTo(x + w - 4, y + h * 0.66);
      c.stroke();
      // lid line
      c.strokeStyle = '#33485f'; c.beginPath(); c.moveTo(x, y + 5); c.lineTo(x + w, y + 5); c.stroke();
      c.fillStyle = '#1f2c3a'; c.font = monoFont(700);
      c.fillText(lab, cx, cy + 2);
      break;
    }
    case 'softener': {
      // Resin/brine vessel: tall body, a valve head on top, and a granular
      // resin bed in the lower third — distinct from the flat CWST tank.
      const cap = Math.min(S, 1.4);
      const headH = h * 0.14;
      const bodyY = y + headH;
      c.fillStyle = '#eef4fa'; c.strokeStyle = '#33485f'; c.lineWidth = 1.6;
      roundRect(c, x, bodyY, w, h - headH, 6); c.fill(); c.stroke();
      // valve head block on top
      c.fillStyle = '#d7e2ee';
      roundRect(c, x + w * 0.28, y, w * 0.44, headH + 5, 2); c.fill(); c.stroke();
      // resin bed band (lower portion) with granule dots, clipped to the body
      const bandTop = y + h * 0.62;
      c.save();
      roundRect(c, x, bodyY, w, h - headH, 6); c.clip();
      c.fillStyle = '#dce8f3'; c.fillRect(x, bandTop, w, (y + h) - bandTop);
      c.fillStyle = '#9db4c9';
      const dot = Math.max(0.7, cap), gstep = 5.5 * cap;
      for (let gy = bandTop + 3; gy < y + h - 2; gy += gstep)
        for (let gx = x + 4; gx < x + w - 2; gx += gstep) { c.beginPath(); c.arc(gx, gy, dot, 0, 7); c.fill(); }
      c.restore();
      c.strokeStyle = '#9db4c9'; c.lineWidth = 1;
      c.beginPath(); c.moveTo(x, bandTop); c.lineTo(x + w, bandTop); c.stroke();
      // label in the clear upper part of the body
      c.fillStyle = '#1f2c3a'; c.font = monoFont(700);
      c.fillText(lab, cx, bodyY + (bandTop - bodyY) * 0.5 + 1);
      break;
    }
    case 'heater': {
      c.fillStyle = '#fdeeee'; c.strokeStyle = '#b03636'; c.lineWidth = 1.6;
      roundRect(c, x, y, w, h, 6); c.fill(); c.stroke();
      // heating element dot
      c.fillStyle = '#dc2626'; c.beginPath(); c.arc(cx, y + h - 8 * Math.min(S, 1.4), 2.4 * Math.min(S, 1.4), 0, 7); c.fill();
      c.fillStyle = '#7a2020'; c.font = monoFont(700);
      c.fillText(lab, cx, cy - (n.props && n.props.volume ? 6 : 0));
      if (n.props && n.props.volume) { c.font = `${Math.max(7, 8.5 * Math.min(S, 1.4))}px var(--mono,monospace)`; c.fillText(n.props.volume + 'L', cx, cy + 9 * Math.min(S, 1.3)); }
      break;
    }
    case 'boiler': {
      // Steam boiler: warm pressure vessel with steam plumes rising and a
      // burner flame beneath — reads as the hot, steam-raising side of plant.
      const cap = Math.min(S, 1.4);
      const steamH = h * 0.20, flameH = h * 0.16;
      const bodyY = y + steamH, bodyH = h - steamH - flameH;
      c.fillStyle = '#fdeeee'; c.strokeStyle = '#b03636'; c.lineWidth = 1.6;
      roundRect(c, x, bodyY, w, bodyH, 6); c.fill(); c.stroke();
      // water level line
      c.strokeStyle = '#d99'; c.lineWidth = 1;
      c.beginPath(); c.moveTo(x + 4, bodyY + bodyH * 0.4); c.lineTo(x + w - 4, bodyY + bodyH * 0.4); c.stroke();
      // steam plumes rising from the crown
      c.strokeStyle = '#9db4c9'; c.lineWidth = 1.2 * Math.max(.8, cap); c.lineCap = 'round';
      for (let i = -1; i <= 1; i++) {
        const px = cx + i * w * 0.26;
        c.beginPath();
        c.moveTo(px, bodyY);
        c.bezierCurveTo(px - w * 0.12, y + steamH * 0.6, px + w * 0.12, y + steamH * 0.35, px, y + 1.5);
        c.stroke();
      }
      c.lineCap = 'butt';
      // burner flame beneath the vessel (outer + inner cone)
      const fb = y + h - flameH, fw = w * 0.18;
      c.fillStyle = '#ea580c';
      c.beginPath();
      c.moveTo(cx - fw, y + h);
      c.quadraticCurveTo(cx - fw, fb + flameH * 0.2, cx, fb);
      c.quadraticCurveTo(cx + fw, fb + flameH * 0.2, cx + fw, y + h);
      c.closePath(); c.fill();
      c.fillStyle = '#fbbf24';
      c.beginPath();
      c.moveTo(cx - fw * 0.45, y + h);
      c.quadraticCurveTo(cx - fw * 0.45, fb + flameH * 0.5, cx, fb + flameH * 0.35);
      c.quadraticCurveTo(cx + fw * 0.45, fb + flameH * 0.5, cx + fw * 0.45, y + h);
      c.closePath(); c.fill();
      // label inside the vessel
      c.fillStyle = '#7a2020'; c.font = monoFont(700);
      c.fillText(lab, cx, bodyY + bodyH * 0.62);
      break;
    }
    case 'pump': {
      const r = w / 2;
      c.fillStyle = '#fff'; c.strokeStyle = '#33485f'; c.lineWidth = 1.6;
      c.beginPath(); c.arc(cx, cy, r, 0, 7); c.fill(); c.stroke();
      // Equilateral triangle inscribed in the circle — its apex is the flow
      // arrow. n.rot (degrees, 0 = apex pointing down) spins it to match the
      // direction of flow. The circle is symmetric so only the arrow turns.
      c.save();
      c.translate(cx, cy);
      c.rotate((n.rot || 0) * Math.PI / 180);
      c.beginPath();
      c.moveTo(-r * 0.866, -r * 0.5);
      c.lineTo(r * 0.866, -r * 0.5);
      c.lineTo(0, r);
      c.closePath();
      c.stroke();
      c.restore();
      break;
    }
    case 'tmv': case 'mixer': {
      c.fillStyle = '#fff'; c.strokeStyle = n.type === 'tmv' ? '#0883a0' : '#475569'; c.lineWidth = 1.8;
      c.beginPath(); c.arc(cx, cy, w / 2, 0, 7); c.fill(); c.stroke();
      c.fillStyle = c.strokeStyle; c.font = `700 ${Math.max(9, 12 * Math.min(S, 1.5))}px var(--mono,monospace)`;
      c.fillText(n.type === 'tmv' ? 'T' : 'M', cx, cy + 1);
      break;
    }
    case 'shower': {
      c.strokeStyle = '#475569'; c.lineWidth = 1.6; c.fillStyle = '#e2e8f0';
      // head
      c.beginPath();
      c.moveTo(cx - w * .42, y + h * .3); c.lineTo(cx + w * .42, y + h * .3);
      c.lineTo(cx + w * .30, y + h * .5); c.lineTo(cx - w * .30, y + h * .5); c.closePath();
      c.fill(); c.stroke();
      // arm
      c.beginPath(); c.moveTo(cx, y); c.lineTo(cx, y + h * .3); c.stroke();
      // spray
      c.strokeStyle = '#2563eb'; c.lineWidth = 1; c.setLineDash([1.5, 3]);
      for (let i = -2; i <= 2; i++) { c.beginPath(); c.moveTo(cx + i * w * .12, y + h * .52); c.lineTo(cx + i * w * .12, y + h); c.stroke(); }
      c.setLineDash([]);
      break;
    }
    case 'outlet': {
      c.fillStyle = '#fff'; c.strokeStyle = '#475569'; c.lineWidth = 1.5;
      c.beginPath(); c.arc(cx, cy, w / 2 - 1, 0, 7); c.fill(); c.stroke();
      c.beginPath(); c.arc(cx, cy, w / 5, 0, 7); c.fillStyle = '#475569'; c.fill();
      break;
    }
    case 'cap': {
      c.strokeStyle = '#000000'; c.lineWidth = 2.4;
      c.beginPath(); c.moveTo(cx - w * .4, cy); c.lineTo(cx + w * .15, cy); c.stroke();
      c.beginPath(); c.moveTo(cx + w * .15, cy - h * .35); c.lineTo(cx + w * .15, cy + h * .35); c.stroke();
      break;
    }
  }
  // risk badge
  if (n.props && n.props.risk && RISK[n.props.risk]) {
    const r = 4.5 * Math.min(S, 1.4);
    c.fillStyle = RISK[n.props.risk];
    c.beginPath(); c.arc(x + w, y, r, 0, 7); c.fill();
    c.fillStyle = '#fff'; c.font = `700 ${Math.max(6, 7 * Math.min(S, 1.4))}px var(--sans,system-ui)`;
    c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(n.props.risk, x + w, y + .5);
  }
  // external label for small symbols
  if (['pump', 'tmv', 'mixer', 'shower', 'outlet'].includes(n.type) && n.label) {
    c.fillStyle = '#1f2c3a'; c.font = `${Math.max(8, 10 * Math.min(S, 1.4))}px var(--mono,monospace)`;
    c.textAlign = 'center'; c.textBaseline = 'top';
    c.fillText(n.label, cx, y + h + 2);
  }
}

const LEGEND_ITEMS = [
  ['coldMains', 'Cold — mains'], ['coldTank', 'Cold — tank'],
  ['hotFlow', 'Hot — flow'], ['hotReturn', 'Hot — return'], ['deadleg', 'Deadleg'],
];
const LEGEND_M = { rowH: 18, padX: 12, padY: 10, sample: 30, gap: 8, font: '11px var(--sans,system-ui)' };

/* Legend box dimensions without drawing, so placement can reason about it. */
function legendSize(c) {
  const M = LEGEND_M;
  c.font = M.font;
  let maxW = 0; for (const [, t] of LEGEND_ITEMS) maxW = Math.max(maxW, c.measureText(t).width);
  return { w: M.padX * 2 + M.sample + M.gap + maxW, h: M.padY * 2 + M.rowH * LEGEND_ITEMS.length };
}

/* (lx, ly) is the legend's bottom-left anchor (kept for backward compatibility). */
function drawLegend(c, lx, ly) {
  const M = LEGEND_M;
  const { w: boxW, h: boxH } = legendSize(c);
  const x = lx, y = ly - boxH;
  c.fillStyle = 'rgba(255,255,255,.94)'; c.strokeStyle = '#cbd5e1'; c.lineWidth = 1;
  roundRect(c, x, y, boxW, boxH, 8); c.fill(); c.stroke();
  c.textAlign = 'left'; c.textBaseline = 'middle';
  LEGEND_ITEMS.forEach(([k, t], i) => {
    const cy = y + M.padY + M.rowH * i + M.rowH / 2;
    const cfg = PIPES[k];
    c.strokeStyle = cfg.color; c.lineWidth = cfg.width; c.setLineDash(cfg.dash);
    c.beginPath(); c.moveTo(x + M.padX, cy); c.lineTo(x + M.padX + M.sample, cy); c.stroke(); c.setLineDash([]);
    c.fillStyle = '#1f2c3a'; c.fillText(t, x + M.padX + M.sample + M.gap, cy + .5);
  });
}

/* ---------- Legend auto-placement ----------
   Keep the legend clear of the schematic. We measure the on-screen footprint of
   every asset, pipe, zone and label, then try the four corners of the sheet (or
   viewport) in priority order and use the first one the legend box does not touch.
   If the drawing genuinely reaches every corner, we fall back to the corner with
   the least overlap so the legend still lands in the calmest available spot. */
function contentObstacles(T) {
  const S = T.scale, OX = T.ox, OY = T.oy;
  const X = wx => wx * S + OX, Y = wy => wy * S + OY;
  const rects = [];
  for (const n of state.nodes) rects.push({ x: X(n.x - n.w / 2), y: Y(n.y - n.h / 2), w: n.w * S, h: n.h * S });
  for (const z of state.zones) rects.push({ x: X(z.x), y: Y(z.y), w: z.w * S, h: z.h * S });
  for (const t of state.texts) { const m = textBlock(t); rects.push({ x: X(t.x), y: Y(t.y - m.ascent), w: m.w * S, h: m.h * S }); }
  for (const p of state.pipes) {
    const rp = resolvePipePts(p.pts);
    const infl = (PIPES[p.type]?.width || 2) / 2 + 3;   // half the stroke + a little breathing room
    for (let i = 1; i < rp.length; i++) {
      const ax = X(rp[i - 1].x), ay = Y(rp[i - 1].y), bx = X(rp[i].x), by = Y(rp[i].y);
      rects.push({ x: Math.min(ax, bx) - infl, y: Math.min(ay, by) - infl, w: Math.abs(bx - ax) + infl * 2, h: Math.abs(by - ay) + infl * 2 });
    }
  }
  return rects;
}
function rectOverlapArea(a, b) {
  const ox = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const oy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return ox * oy;
}
/* Returns the bottom-left anchor [lx, ly] for the clearest corner of `frame`. */
function placeLegend(c, T, frame, margin, extra = []) {
  const sz = legendSize(c), m = margin;
  const corners = [
    [frame.x + m, frame.y + frame.h - m],                                   // bottom-left (current default)
    [frame.x + frame.w - m - sz.w, frame.y + frame.h - m],                  // bottom-right
    [frame.x + m, frame.y + m + sz.h],                                      // top-left
    [frame.x + frame.w - m - sz.w, frame.y + m + sz.h],                     // top-right
  ];
  const obstacles = contentObstacles(T).concat(extra);
  let best = corners[0], bestScore = Infinity;
  for (const [lx, ly] of corners) {
    const box = { x: lx, y: ly - sz.h, w: sz.w, h: sz.h };
    let score = 0; for (const o of obstacles) score += rectOverlapArea(box, o);
    if (score === 0) return [lx, ly];
    if (score < bestScore) { bestScore = score; best = [lx, ly]; }
  }
  return best;
}

function roundRect(c, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
}

/* selection overlay (screen only) */
function drawSelection() {
  ctx.save();
  if (group.length) { for (const ref of group) outlineRef(ref, true); }
  else if (sel) outlineRef(sel, false);
  ctx.restore();
}
function outlineRef(ref, multi) {
  if (ref.kind === 'node') {
    const n = nodeById(ref.id); if (!n) return;
    const x = sx(n.x - n.w / 2), y = sy(n.y - n.h / 2), w = n.w * view.scale, h = n.h * view.scale;
    ctx.strokeStyle = '#0aa6c4'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
    ctx.strokeRect(x - 3, y - 3, w + 6, h + 6); ctx.setLineDash([]);
  } else if (ref.kind === 'pipe') {
    const p = state.pipes.find(p => p.id === ref.id); if (!p) return;
    const rp = resolvePipePts(p.pts);
    if (multi) {
      // group mode: trace the run faintly for context, then mark only the
      // vertices caught by the marquee — those are the points that will move.
      const verts = ref.verts || rp.map((_, i) => i);
      ctx.strokeStyle = '#0aa6c4'; ctx.globalAlpha = .18;
      ctx.lineWidth = (PIPES[p.type].width) * Math.max(.8, Math.min(view.scale, 1.6)) + 5;
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(sx(rp[0].x), sy(rp[0].y));
      for (let i = 1; i < rp.length; i++) ctx.lineTo(sx(rp[i].x), sy(rp[i].y));
      ctx.stroke(); ctx.globalAlpha = 1;
      for (const i of verts) if (rp[i]) handle(sx(rp[i].x), sy(rp[i].y), '#0aa6c4');
    } else {
      p.pts.forEach((pt, i) => handle(sx(rp[i].x), sy(rp[i].y), pt.node ? '#16a34a' : '#0aa6c4'));
    }
  } else if (ref.kind === 'zone') {
    const z = state.zones.find(z => z.id === ref.id); if (!z) return;
    const x = sx(z.x), y = sy(z.y), w = z.w * view.scale, h = z.h * view.scale;
    ctx.strokeStyle = '#0aa6c4'; ctx.lineWidth = 1.5;
    if (multi) { ctx.setLineDash([4, 3]); ctx.strokeRect(x, y, w, h); ctx.setLineDash([]); }
    else { ctx.strokeRect(x, y, w, h); for (const [hx, hy] of zoneHandles(z)) handle(sx(hx), sy(hy), '#0aa6c4'); }
  } else if (ref.kind === 'text') {
    const t = state.texts.find(t => t.id === ref.id); if (!t) return;
    if (multi) {
      const m = textBlock(t);
      const x = sx(t.x), y = sy(t.y - m.ascent), w = m.w * view.scale, h = m.h * view.scale;
      ctx.strokeStyle = '#0aa6c4'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
      ctx.strokeRect(x - 3, y - 3, w + 6, h + 6); ctx.setLineDash([]);
    } else handle(sx(t.x), sy(t.y), '#0aa6c4');
  }
}
function handle(x, y, col) {
  ctx.fillStyle = '#fff'; ctx.strokeStyle = col; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.rect(x - 4, y - 4, 8, 8); ctx.fill(); ctx.stroke();
}
function zoneHandles(z) {
  return [[z.x, z.y], [z.x + z.w, z.y], [z.x, z.y + z.h], [z.x + z.w, z.y + z.h],
  [z.x + z.w / 2, z.y], [z.x + z.w / 2, z.y + z.h], [z.x, z.y + z.h / 2], [z.x + z.w, z.y + z.h / 2]];
}

function drawDraft() {
  const descr = draft.pts.slice();
  if (draft.preview) descr.push(draft.preview);
  const pts = resolvePipePts(descr);
  if (pts.length < 1) return;
  const cfg = PIPES[draft.type];
  ctx.strokeStyle = cfg.color; ctx.lineWidth = cfg.width; ctx.globalAlpha = .8;
  ctx.setLineDash(cfg.dash); ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(sx(pts[0].x), sy(pts[0].y));
  for (let i = 1; i < pts.length; i++) ctx.lineTo(sx(pts[i].x), sy(pts[i].y));
  ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
  const rp = resolvePipePts(draft.pts);
  for (let i = 0; i < draft.pts.length; i++) handle(sx(rp[i].x), sy(rp[i].y), '#0aa6c4');
}

/* ============================================================
   HIT TESTING
   ============================================================ */
function hitNode(wpt) {
  for (let i = state.nodes.length - 1; i >= 0; i--) {
    const n = state.nodes[i];
    if (Math.abs(wpt.x - n.x) <= n.w / 2 + 4 && Math.abs(wpt.y - n.y) <= n.h / 2 + 4) return n;
  }
  return null;
}
function hitPipe(wpt) {
  const tol = 7 / view.scale;
  for (let i = state.pipes.length - 1; i >= 0; i--) {
    const pts = resolvePipePts(state.pipes[i].pts);
    for (let j = 0; j < pts.length - 1; j++)
      if (distToSeg(wpt, pts[j], pts[j + 1]) < tol) return state.pipes[i];
  }
  return null;
}
function hitPipeVertex(p, wpt) {
  const tol = 8 / view.scale;
  const rp = resolvePipePts(p.pts);
  for (let i = 0; i < rp.length; i++) { const q = rp[i]; if (Math.hypot(q.x - wpt.x, q.y - wpt.y) < tol) return i; }
  return -1;
}
function hitText(wpt) {
  for (let i = state.texts.length - 1; i >= 0; i--) {
    const t = state.texts[i], m = textBlock(t);
    const top = t.y - m.ascent;
    if (wpt.x >= t.x - 4 && wpt.x <= t.x + m.w + 4 && wpt.y >= top - 4 && wpt.y <= top + m.h + 4) return t;
  }
  return null;
}
function hitZoneHandle(z, wpt) {
  const tol = 8 / view.scale, hs = zoneHandles(z);
  for (let i = 0; i < hs.length; i++) if (Math.hypot(hs[i][0] - wpt.x, hs[i][1] - wpt.y) < tol) return i;
  return -1;
}
function hitZoneLabel(wpt) {
  for (let i = state.zones.length - 1; i >= 0; i--) {
    const z = state.zones[i];
    const lr = zoneLabelRect(z, view.scale);
    if (lr && wpt.x >= lr.x && wpt.x <= lr.x + lr.w && wpt.y >= lr.y && wpt.y <= lr.y + lr.h) return z;
    // border band
    const onBorder = (Math.abs(wpt.x - z.x) < 6 / view.scale || Math.abs(wpt.x - (z.x + z.w)) < 6 / view.scale) && wpt.y >= z.y - 6 && wpt.y <= z.y + z.h + 6
      || (Math.abs(wpt.y - z.y) < 6 / view.scale || Math.abs(wpt.y - (z.y + z.h)) < 6 / view.scale) && wpt.x >= z.x - 6 && wpt.x <= z.x + z.w + 6;
    if (onBorder) return z;
  }
  return null;
}
function distToSeg(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  if (!l2) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2; t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
function nodeNear(wpt, maxScreen = 20) {
  const tol = maxScreen / view.scale; let best = null, bd = tol;
  for (const n of state.nodes) { const d = Math.hypot(n.x - wpt.x, n.y - wpt.y); if (d < bd) { bd = d; best = n; } }
  return best;
}

/* ---------- marquee + group selection ---------- */
const rectFromPts = (a, b) => ({ x1: Math.min(a.x, b.x), y1: Math.min(a.y, b.y), x2: Math.max(a.x, b.x), y2: Math.max(a.y, b.y) });
const rectsOverlap = (a, b) => a.x1 <= b.x2 && a.x2 >= b.x1 && a.y1 <= b.y2 && a.y2 >= b.y1;
const ptInRect = (r, p) => p.x >= r.x1 && p.x <= r.x2 && p.y >= r.y1 && p.y <= r.y2;
function segSeg(p1, p2, p3, p4) {
  const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
  if (!d) return false;
  const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
  const u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}
function segHitsRect(r, a, b) {
  if (ptInRect(r, a) || ptInRect(r, b)) return true;
  const c1 = { x: r.x1, y: r.y1 }, c2 = { x: r.x2, y: r.y1 }, c3 = { x: r.x2, y: r.y2 }, c4 = { x: r.x1, y: r.y2 };
  return segSeg(a, b, c1, c2) || segSeg(a, b, c2, c3) || segSeg(a, b, c3, c4) || segSeg(a, b, c4, c1);
}
/* Assets/pipes/labels use "crossing" selection (touch to grab); zones, being big
   backgrounds, are only grabbed when fully enclosed, so a marquee drawn inside a
   floor doesn't sweep up the floor itself. */
function collectInMarquee(r) {
  const g = [];
  for (const n of state.nodes) {
    const nb = { x1: n.x - n.w / 2, y1: n.y - n.h / 2, x2: n.x + n.w / 2, y2: n.y + n.h / 2 };
    if (rectsOverlap(r, nb)) g.push({ kind: 'node', id: n.id });
  }
  for (const p of state.pipes) {
    // Grab the individual movable vertices that fall inside the box, rather than
    // the whole run. Asset-bound endpoints (green handles) are left out so they
    // keep following their asset; points outside the box stay put and the run
    // flexes between the moved and the anchored points.
    const pts = resolvePipePts(p.pts);
    const verts = [];
    for (let i = 0; i < pts.length; i++) {
      if (p.pts[i].node) continue;          // endpoint pinned to an asset
      if (ptInRect(r, pts[i])) verts.push(i);
    }
    if (verts.length) g.push({ kind: 'pipe', id: p.id, verts });
  }
  for (const t of state.texts) {
    const m = textBlock(t);
    const tb = { x1: t.x, y1: t.y - m.ascent, x2: t.x + m.w, y2: t.y - m.ascent + m.h };
    if (rectsOverlap(r, tb)) g.push({ kind: 'text', id: t.id });
  }
  for (const z of state.zones) {
    if (r.x1 <= z.x && r.x2 >= z.x + z.w && r.y1 <= z.y && r.y2 >= z.y + z.h) g.push({ kind: 'zone', id: z.id });
  }
  return g;
}
function hitAny(w) {
  const n = hitNode(w); if (n) return { kind: 'node', id: n.id };
  const p = hitPipe(w); if (p) return { kind: 'pipe', id: p.id };
  const t = hitText(w); if (t) return { kind: 'text', id: t.id };
  const z = hitZoneLabel(w); if (z) return { kind: 'zone', id: z.id };
  return null;
}
const inGroup = ref => group.some(r => r.kind === ref.kind && r.id === ref.id);

// A bare pipe ref (a click / shift-click, which has no vertex list) selects all
// of that pipe's movable vertices. Asset-bound endpoints are excluded.
function withPipeVerts(ref) {
  if (ref.kind !== 'pipe' || ref.verts) return ref;
  const p = state.pipes.find(p => p.id === ref.id);
  const verts = p ? p.pts.map((pt, i) => (pt.node ? -1 : i)).filter(i => i >= 0) : [];
  return { kind: 'pipe', id: ref.id, verts };
}

function setGroup(g) {
  group = g; sel = null; renderInspector(); draw();
  if (window.innerWidth <= 880) $('#inspector').classList.add('open');
}
function toggleGroup(ref) {
  if (!group.length && sel) group = [withPipeVerts({ ...sel })];   // seed from current single selection
  const i = group.findIndex(r => r.kind === ref.kind && r.id === ref.id);
  if (i >= 0) group.splice(i, 1); else group.push(withPipeVerts(ref));
  if (group.length === 1) select(group[0]);          // collapse to a normal single selection
  else if (group.length === 0) select(null);
  else { sel = null; renderInspector(); draw(); }
}
function finishMarquee() {
  const r = rectFromPts(drag.start, drag.cur);
  const tiny = Math.abs(drag.cur.x - drag.start.x) * view.scale < 4 && Math.abs(drag.cur.y - drag.start.y) * view.scale < 4;
  if (tiny) { select(null); return; }
  const g = collectInMarquee(r);
  if (g.length === 0) { select(null); return; }
  // A single non-pipe item behaves like a normal click-select. A single pipe is
  // kept as a vertex selection so only the boxed points move, not the whole run.
  if (g.length === 1 && g[0].kind !== 'pipe') { select(g[0]); return; }
  setGroup(g);
}
function startGroupDrag(w) {
  const items = group.map(ref => {
    if (ref.kind === 'node') { const n = nodeById(ref.id); return n && { kind: 'node', id: ref.id, x: n.x, y: n.y }; }
    if (ref.kind === 'text') { const t = state.texts.find(t => t.id === ref.id); return t && { kind: 'text', id: ref.id, x: t.x, y: t.y }; }
    if (ref.kind === 'zone') { const z = state.zones.find(z => z.id === ref.id); return z && { kind: 'zone', id: ref.id, x: z.x, y: z.y }; }
    if (ref.kind === 'pipe') {
      const p = state.pipes.find(p => p.id === ref.id);
      if (!p) return null;
      // only the selected, non-asset-bound vertices travel with the group
      const verts = (ref.verts || p.pts.map((_, i) => i)).filter(i => p.pts[i] && !p.pts[i].node);
      return { kind: 'pipe', id: ref.id, verts, orig: verts.map(i => ({ x: p.pts[i].x, y: p.pts[i].y })) };
    }
  }).filter(Boolean);
  return { mode: 'group', origin: w, items };
}

/* Move the current selection (single or multi) by a world-space delta —
   used by the arrow keys. Asset-bound pipe endpoints (green handles) follow
   their node, so they're skipped here, matching drag behaviour. Rapid presses
   within a short window coalesce into a single undo step so holding an arrow
   doesn't flood the undo stack.

   gridAlign (set when grid-snap is on and Shift isn't held): instead of a raw
   delta, dx/dy carry only a direction (±1/0). We snap a single anchor to the
   next grid line in that direction and move the whole selection by that delta,
   so items land on the same positions the grid snaps to while the selection
   keeps its internal layout. Shift bypasses this for exact 1px precision. */
let nudgeBurst = 0;
function nudgeAnchor(ref) {
  if (ref.kind === 'node') { const n = nodeById(ref.id); return n ? { x: n.x, y: n.y } : null; }
  if (ref.kind === 'text') { const t = state.texts.find(t => t.id === ref.id); return t ? { x: t.x, y: t.y } : null; }
  if (ref.kind === 'zone') { const z = state.zones.find(z => z.id === ref.id); return z ? { x: z.x, y: z.y } : null; }
  if (ref.kind === 'pipe') {
    const p = state.pipes.find(p => p.id === ref.id); if (!p) return null;
    const verts = ref.verts || p.pts.map((_, i) => i);
    for (const i of verts) { const pt = p.pts[i]; if (pt && !pt.node) return { x: pt.x, y: pt.y }; }
    return null;
  }
  return null;
}
function nudgeSelection(dx, dy, gridAlign) {
  const refs = group.length ? group : (sel ? [sel] : []);
  if (!refs.length) return;
  if (gridAlign) {
    const a = nudgeAnchor(refs[0]);
    if (a) {
      if (dx) { const t = dx > 0 ? (Math.floor(a.x / GRID) + 1) * GRID : (Math.ceil(a.x / GRID) - 1) * GRID; dx = t - a.x; }
      if (dy) { const t = dy > 0 ? (Math.floor(a.y / GRID) + 1) * GRID : (Math.ceil(a.y / GRID) - 1) * GRID; dy = t - a.y; }
    } else { dx = dx ? Math.sign(dx) * GRID : 0; dy = dy ? Math.sign(dy) * GRID : 0; }
  }
  if (!dx && !dy) return;
  const now = Date.now();
  if (now - nudgeBurst > 700) snapshot();   // first nudge of a burst => undo point
  nudgeBurst = now;
  for (const ref of refs) {
    if (ref.kind === 'node') { const n = nodeById(ref.id); if (n) { n.x += dx; n.y += dy; } }
    else if (ref.kind === 'text') { const t = state.texts.find(t => t.id === ref.id); if (t) { t.x += dx; t.y += dy; } }
    else if (ref.kind === 'zone') { const z = state.zones.find(z => z.id === ref.id); if (z) { z.x += dx; z.y += dy; } }
    else if (ref.kind === 'pipe') {
      const p = state.pipes.find(p => p.id === ref.id);
      if (p) {
        const verts = ref.verts || p.pts.map((_, i) => i);
        for (const i of verts) { const pt = p.pts[i]; if (pt && !pt.node) { pt.x += dx; pt.y += dy; } }
      }
    }
  }
  commit();
}

/* ============================================================
   POINTER / TOOLS
   ============================================================ */
const pointers = new Map();
let drag = null;       // active drag descriptor
let pinch = null;
let pointerWorldPos = null;   // last cursor position in world coords (for paste-at-cursor)
let pointerInCanvas = false;  // is the cursor currently over the canvas?

canvas.addEventListener('pointerdown', e => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) { startPinch(); drag = null; draft = null; return; }
  if (pointers.size > 2) return;
  onDown(e);
});
canvas.addEventListener('pointermove', e => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && pointers.size >= 2) { movePinch(); return; }
  onMove(e);
});
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerleave', () => { pointerInCanvas = false; });
function endPointer(e) {
  pointers.delete(e.pointerId);
  if (pinch && pointers.size < 2) pinch = null;
  if (pointers.size === 0) onUp(e);
}

function startPinch() {
  const [a, b] = [...pointers.values()];
  pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, scale: view.scale, ox: view.ox, oy: view.oy };
}
function movePinch() {
  const [a, b] = [...pointers.values()];
  const d = Math.hypot(a.x - b.x, a.y - b.y);
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
  const r = canvas.getBoundingClientRect();
  const f = d / pinch.d;
  const ns = Math.max(.2, Math.min(4, pinch.scale * f));
  // keep midpoint stable
  const mxW = (pinch.cx - r.left - pinch.ox) / pinch.scale;
  const myW = (pinch.cy - r.top - pinch.oy) / pinch.scale;
  view.scale = ns;
  view.ox = (cx - r.left) - mxW * ns;
  view.oy = (cy - r.top) - myW * ns;
  updateZoomLabel(); draw();
}

let lastMoveWorld = null;
function onDown(e) {
  const w = pointerWorld(e);
  lastMoveWorld = w;

  if (tool === 'pan' || e.button === 1 || spaceDown) { drag = { mode: 'pan', sx: e.clientX, sy: e.clientY, ox: view.ox, oy: view.oy }; return; }

  if (tool === 'pipe') { pipeClick(w); return; }

  if (tool === 'asset') {
    mutate(() => {
      const a = ASSETS[assetKind];
      const n = { id: uid(), type: assetKind, x: snap(w.x), y: snap(w.y), w: a.w, h: a.h, label: autoLabel(assetKind), props: {} };
      state.nodes.push(n); select({ kind: 'node', id: n.id });
    });
    return;
  }

  if (tool === 'zone') { drag = { mode: 'zoneNew', start: { x: snap(w.x), y: snap(w.y) }, id: null }; return; }

  if (tool === 'text') {
    const txt = prompt('Label text:'); if (!txt) return;
    mutate(() => { const t = { id: uid(), x: snap(w.x), y: snap(w.y), text: txt, size: 14 }; state.texts.push(t); select({ kind: 'text', id: t.id }); });
    setTool('select'); return;
  }

  /* --- select tool --- */
  // shift-click toggles an item in/out of the multi-selection
  if (e.shiftKey) {
    const ref = hitAny(w);
    if (ref) { toggleGroup(ref); drag = null; return; }
  }
  // press on any member of the current group → move the whole group
  if (group.length) {
    const ref = hitAny(w);
    if (ref && inGroup(ref)) { snapshot(); drag = startGroupDrag(w); return; }
  }
  // vertex of selected pipe?
  if (sel && sel.kind === 'pipe') {
    const p = state.pipes.find(p => p.id === sel.id);
    if (p) { const vi = hitPipeVertex(p, w); if (vi >= 0) { snapshot(); drag = { mode: 'vertex', pipe: p, vi }; return; } }
  }
  // zone handle of selected zone?
  if (sel && sel.kind === 'zone') {
    const z = state.zones.find(z => z.id === sel.id);
    if (z) { const hi = hitZoneHandle(z, w); if (hi >= 0) { snapshot(); drag = { mode: 'zoneResize', zone: z, hi }; return; } }
  }
  const n = hitNode(w);
  if (n) { select({ kind: 'node', id: n.id }); snapshot(); drag = { mode: 'node', node: n, dx: w.x - n.x, dy: w.y - n.y }; return; }
  const p = hitPipe(w);
  if (p) { select({ kind: 'pipe', id: p.id }); snapshot(); drag = { mode: 'pipe', pipe: p, origin: w, orig: p.pts.map(pt => ({ x: pt.x, y: pt.y })) }; return; }
  const t = hitText(w);
  if (t) { select({ kind: 'text', id: t.id }); snapshot(); drag = { mode: 'text', text: t, dx: w.x - t.x, dy: w.y - t.y }; return; }
  const z = hitZoneLabel(w);
  if (z) { select({ kind: 'zone', id: z.id }); snapshot(); drag = { mode: 'zone', zone: z, origin: w, ox: z.x, oy: z.y }; return; }
  // empty space: start a marquee (drag-box) selection. Pan is still available via
  // space-drag, middle mouse, the Pan tool (H), the wheel/trackpad, or two fingers.
  select(null);
  drag = { mode: 'marquee', start: w, cur: w };
}

function onMove(e) {
  const w = pointerWorld(e);
  pointerWorldPos = w; pointerInCanvas = true;
  updateCoords(w);

  if (tool === 'pipe' && draft) {
    let prev = draft.pts.length ? ptPos(draft.pts[draft.pts.length - 1]) : null;
    let pv = { x: snap(w.x), y: snap(w.y) };
    const near = nodeNear(w); if (near) pv = prev ? edgePoint(near, prev) : { x: near.x, y: near.y };
    else if (prev && ortho) pv = orthoConstrain(prev, pv);
    draft.preview = pv; draw(); return;
  }
  if (!drag) return;

  if (drag.mode === 'pan') { view.ox = drag.ox + (e.clientX - drag.sx); view.oy = drag.oy + (e.clientY - drag.sy); draw(); return; }
  if (drag.mode === 'marquee') { drag.cur = w; draw(); return; }
  if (drag.mode === 'group') {
    let dx = w.x - drag.origin.x, dy = w.y - drag.origin.y;
    if (snapOn) { dx = Math.round(dx / GRID) * GRID; dy = Math.round(dy / GRID) * GRID; }
    for (const it of drag.items) {
      if (it.kind === 'node') { const n = nodeById(it.id); if (n) { n.x = it.x + dx; n.y = it.y + dy; } }
      else if (it.kind === 'text') { const t = state.texts.find(t => t.id === it.id); if (t) { t.x = it.x + dx; t.y = it.y + dy; } }
      else if (it.kind === 'zone') { const z = state.zones.find(z => z.id === it.id); if (z) { z.x = it.x + dx; z.y = it.y + dy; } }
      else if (it.kind === 'pipe') {
        const p = state.pipes.find(p => p.id === it.id);
        if (p) it.verts.forEach((vi, k) => { const pt = p.pts[vi], o = it.orig[k]; if (pt && o && !pt.node) { pt.x = o.x + dx; pt.y = o.y + dy; } });
      }
    }
    dirty = true; draw(); return;
  }
  if (drag.mode === 'node') { drag.node.x = snap(w.x - drag.dx); drag.node.y = snap(w.y - drag.dy); dirty = true; draw(); return; }
  if (drag.mode === 'text') { drag.text.x = snap(w.x - drag.dx); drag.text.y = snap(w.y - drag.dy); dirty = true; draw(); return; }
  if (drag.mode === 'vertex') {
    const near = nodeNear(w);
    if (near) { drag.pipe.pts[drag.vi] = { x: near.x, y: near.y, node: near.id }; }
    else { drag.pipe.pts[drag.vi] = { x: snap(w.x), y: snap(w.y) }; }
    dirty = true; draw(); return;
  }
  if (drag.mode === 'pipe') {
    let dx = w.x - drag.origin.x, dy = w.y - drag.origin.y;
    if (snapOn) { dx = Math.round(dx / GRID) * GRID; dy = Math.round(dy / GRID) * GRID; }
    drag.pipe.pts.forEach((pt, i) => { const o = drag.orig[i]; if (pt && o && !pt.node) { pt.x = o.x + dx; pt.y = o.y + dy; } });
    dirty = true; draw(); return;
  }
  if (drag.mode === 'zone') {
    let dx = w.x - drag.origin.x, dy = w.y - drag.origin.y;
    if (snapOn) { dx = Math.round(dx / GRID) * GRID; dy = Math.round(dy / GRID) * GRID; }
    drag.zone.x = drag.ox + dx; drag.zone.y = drag.oy + dy;
    dirty = true; draw(); return;
  }
  if (drag.mode === 'zoneNew') {
    if (!drag.id) { const z = { id: uid(), x: drag.start.x, y: drag.start.y, w: GRID, h: GRID, label: 'Area', color: ZONE_COLORS[state.zones.length % ZONE_COLORS.length] }; state.zones.unshift(z); drag.id = z.id; snapshot(); }
    const z = state.zones.find(z => z.id === drag.id);
    z.x = Math.min(drag.start.x, snap(w.x)); z.y = Math.min(drag.start.y, snap(w.y));
    z.w = Math.max(GRID, Math.abs(snap(w.x) - drag.start.x)); z.h = Math.max(GRID, Math.abs(snap(w.y) - drag.start.y));
    dirty = true; draw(); return;
  }
  if (drag.mode === 'zoneResize') { resizeZone(drag.zone, drag.hi, snap(w.x), snap(w.y)); dirty = true; draw(); return; }
}

function onUp() {
  if (drag && drag.mode === 'marquee') { finishMarquee(); drag = null; return; }
  if (drag && drag.mode === 'group') { commit(); drag = null; return; }
  if (drag && drag.mode === 'zoneNew' && drag.id) {
    const z = state.zones.find(z => z.id === drag.id);
    if (z) { select({ kind: 'zone', id: z.id }); }
    setTool('select');
  }
  if (drag && ['node', 'text', 'vertex', 'pipe', 'zone', 'zoneResize'].includes(drag.mode)) commit();
  drag = null;
}

function pipeClick(w) {
  const near = nodeNear(w);
  let pt;
  if (near) pt = { x: near.x, y: near.y, node: near.id };
  else {
    let q = { x: snap(w.x), y: snap(w.y) };
    if (draft && draft.pts.length && ortho) { const prev = ptPos(draft.pts[draft.pts.length - 1]); q = orthoConstrain(prev, q); }
    pt = q;
  }
  if (!draft) { draft = { type: pipeKind, pts: [pt], preview: null }; hint('Click to add bends · click an asset to connect · double-click or Enter to finish'); }
  else {
    draft.pts.push(pt);
    if (near && draft.pts.length >= 2) finishPipe();
  }
  draw();
}
function orthoConstrain(prev, q) {
  return Math.abs(q.x - prev.x) >= Math.abs(q.y - prev.y) ? { x: q.x, y: prev.y } : { x: prev.x, y: q.y };
}
function finishPipe() {
  if (draft && draft.pts.length >= 2) {
    const p = { id: uid(), type: draft.type, pts: draft.pts };
    mutate(() => { state.pipes.push(p); select({ kind: 'pipe', id: p.id }); });
  }
  draft = null; hint(''); draw();
}
function cancelDraft() { draft = null; hint(''); draw(); }

canvas.addEventListener('dblclick', () => { if (draft) { draft.pts = draft.pts.slice(0, -0); finishPipe(); } });

/* desktop wheel: pan, ctrl/⌘ = zoom */
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) { zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.1 : 1 / 1.1); }
  else { view.ox -= e.deltaX; view.oy -= e.deltaY; draw(); }
}, { passive: false });

function zoomAt(clientX, clientY, factor) {
  const r = canvas.getBoundingClientRect();
  const px = clientX - r.left, py = clientY - r.top;
  const wxp = (px - view.ox) / view.scale, wyp = (py - view.oy) / view.scale;
  view.scale = Math.max(.2, Math.min(4, view.scale * factor));
  view.ox = px - wxp * view.scale; view.oy = py - wyp * view.scale;
  updateZoomLabel(); draw();
}

function resizeZone(z, hi, x, y) {
  const r = { x1: z.x, y1: z.y, x2: z.x + z.w, y2: z.y + z.h };
  const map = { 0: ['x1', 'y1'], 1: ['x2', 'y1'], 2: ['x1', 'y2'], 3: ['x2', 'y2'], 4: ['y1'], 5: ['y2'], 6: ['x1'], 7: ['x2'] };
  for (const k of map[hi]) { if (k[0] === 'x') r[k] = x; else r[k] = y; }
  z.x = Math.min(r.x1, r.x2); z.y = Math.min(r.y1, r.y2);
  z.w = Math.max(GRID, Math.abs(r.x2 - r.x1)); z.h = Math.max(GRID, Math.abs(r.y2 - r.y1));
}

/* ---------- labels ---------- */
function autoLabel(type) {
  const tag = ASSETS[type].tag; if (!tag) return '';
  let max = 0;
  for (const n of state.nodes) if (n.type === type && n.label) { const m = /(\d+)$/.exec(n.label); if (m) max = Math.max(max, +m[1]); }
  return tag + (max + 1);
}

/* ============================================================
   SELECTION + INSPECTOR
   ============================================================ */
function select(s) { group = []; sel = s; renderInspector(); draw(); if (s && window.innerWidth <= 880) $('#inspector').classList.add('open'); }

/* Zone name-tab placement options, laid out as a 3×2 grid (top row / bottom row).
   Each glyph shows the area box with the tab marked at the matching corner/edge. */
const ZONE_LABELPOS = [
  ['tl', 'Top left'], ['tc', 'Top centre'], ['tr', 'Top right'],
  ['bl', 'Bottom left'], ['bc', 'Bottom centre'], ['br', 'Bottom right'],
];
function zoneLabelPosIcon(pos) {
  const tx = (pos === 'tr' || pos === 'br') ? 13 : (pos === 'tc' || pos === 'bc') ? 8 : 3;
  const ty = pos[0] === 'b' ? 16 : 4;
  return `<svg viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="16" rx="1.5" stroke="currentColor" stroke-width="1.6"/><rect x="${tx}" y="${ty}" width="8" height="4" rx="1" fill="currentColor"/></svg>`;
}

function renderInspector() {
  const body = $('#inspBody'), empty = $('#inspEmpty');
  if (group.length >= 1) {
    empty.hidden = true; body.hidden = false;
    const counts = { node: 0, point: 0, zone: 0, text: 0 };
    for (const r of group) {
      if (r.kind === 'pipe') counts.point += (r.verts ? r.verts.length : 0);
      else counts[r.kind]++;
    }
    const total = counts.node + counts.point + counts.zone + counts.text;
    const noun = { node: 'asset', point: 'pipe point', zone: 'area', text: 'label' };
    const parts = Object.entries(counts).filter(([, n]) => n > 0)
      .map(([k, n]) => `${n} ${noun[k]}${n > 1 ? 's' : ''}`).join(' · ');
    const movable = alignableUnits().length;
    body.innerHTML = `<div class="insp-head"><span class="badge">×${total}</span><h3>${total > 1 ? 'Multiple items' : 'Selection'}</h3></div>`
      + `<p class="muted" style="font-size:12px;margin:4px 0 10px">${parts}.<br>Drag any selected item to move them together — boxed pipe points move while the rest of each run stays put. Shift-click to add or remove. Delete removes the selected items and points.</p>`
      + (movable >= 2 ? alignSection(movable) : '')
      + `<button class="btn-del" data-delgroup>Delete ${total} item${total > 1 ? 's' : ''}</button>`;
    const d = $('[data-delgroup]', body); if (d) d.addEventListener('click', deleteSelected);
    $$('[data-align]', body).forEach(b => b.addEventListener('click', () => alignSelection(b.dataset.align)));
    $$('[data-dist]', body).forEach(b => b.addEventListener('click', () => distributeSelection(b.dataset.dist)));
    return;
  }
  if (!sel) { empty.hidden = false; body.hidden = true; return; }
  empty.hidden = true; body.hidden = false;
  let h = '';
  if (sel.kind === 'node') {
    const n = nodeById(sel.id); if (!n) return select(null);
    const a = ASSETS[n.type];
    h += `<div class="insp-head"><span class="badge">${a.tag || '•'}</span><h3>${a.name}</h3></div>`;
    h += row('Label', `<input class="i-label" value="${esc(n.label)}">`, 'mono');
    if (n.type === 'pump')
      h += row('Flow direction', `<div class="rot-row"><button type="button" class="i-rot-btn" title="Rotate 90°">⟳ 90°</button><input class="i-rot" type="number" value="${n.rot || 0}" step="15" min="0" max="359"><span class="rot-unit">°</span></div>`);
    if (a.fields.includes('volume'))
      h += row('Volume (litres)', `<input class="i-vol" type="number" value="${n.props.volume || ''}" placeholder="e.g. 240">`);
    if (n.type === 'tank' || n.type === 'heater')
      h += row('Size', `<select class="i-size"><option ${n.props.size === 's' ? 'selected' : ''} value="s">Small</option><option ${(!n.props.size || n.props.size === 'm') ? 'selected' : ''} value="m">Medium</option><option ${n.props.size === 'l' ? 'selected' : ''} value="l">Large</option></select>`);
    h += row('Location / area', `<input class="i-loc" value="${esc(n.props.location || '')}" placeholder="e.g. Ground floor plant room">`);
    if (a.fields.includes('risk')) h += riskRow(n.props.risk);
    h += row('Notes', `<textarea class="i-notes" rows="2" placeholder="Observations…">${esc(n.props.notes || '')}</textarea>`);
    h += `<button class="btn-del" data-del>Delete asset</button>`;
  } else if (sel.kind === 'pipe') {
    const p = state.pipes.find(p => p.id === sel.id); if (!p) return select(null);
    h += `<div class="insp-head"><span class="badge" style="background:${PIPES[p.type].color}">PIPE</span><h3>Pipework</h3></div>`;
    h += row('Type', `<select class="i-ptype">${Object.entries(PIPES).map(([k, v]) => `<option value="${k}" ${p.type === k ? 'selected' : ''}>${v.name}</option>`).join('')}</select>`);
    h += `<p class="muted" style="font-size:12px;margin:4px 0 10px">${p.pts.length} points. Select and drag the square handles to reshape. Endpoints on an asset (green) follow it when moved.</p>`;
    h += `<button class="btn-del" data-del>Delete pipe</button>`;
  } else if (sel.kind === 'zone') {
    const z = state.zones.find(z => z.id === sel.id); if (!z) return select(null);
    h += `<div class="insp-head"><span class="badge">AREA</span><h3>Floor / area</h3></div>`;
    h += row('Name', `<input class="i-zlabel" value="${esc(z.label)}">`);
    h += `<div class="insp-row"><label>Name position</label><div class="pos-grid">${ZONE_LABELPOS.map(([p, t]) => `<button type="button" class="${(z.labelPos || 'tl') === p ? 'sel' : ''}" data-zpos="${p}" title="${t}">${zoneLabelPosIcon(p)}</button>`).join('')}</div></div>`;
    h += `<div class="insp-row"><label>Fill colour</label><div class="swatch-row">${ZONE_COLORS.map(c => `<div class="swatch ${z.color === c ? 'sel' : ''}" data-zc="${c}" style="background:${c}"></div>`).join('')}</div></div>`;
    h += `<button class="btn-del" data-del>Delete area</button>`;
  } else if (sel.kind === 'text') {
    const t = state.texts.find(t => t.id === sel.id); if (!t) return select(null);
    h += `<div class="insp-head"><span class="badge">TEXT</span><h3>Label</h3></div>`;
    h += row('Text', `<textarea class="i-text" rows="3" placeholder="Room name — press Enter for a new line">${esc(t.text)}</textarea>`);
    h += row('Alignment', `<select class="i-talign"><option value="left" ${t.align !== 'center' ? 'selected' : ''}>Left</option><option value="center" ${t.align === 'center' ? 'selected' : ''}>Centre</option></select>`);
    h += row('Wrap width (0 = off)', `<input class="i-twrap" type="number" min="0" step="10" value="${t.wrap || 0}" placeholder="e.g. 140">`);
    h += row('Size', `<input class="i-tsize" type="number" value="${t.size || 14}" min="8" max="48">`);
    h += `<button class="btn-del" data-del>Delete label</button>`;
  }
  body.innerHTML = h;
  wireInspector();
}
function row(label, inner, cls = '') { return `<div class="insp-row ${cls}"><label>${label}</label>${inner}</div>`; }
function riskRow(cur) {
  return `<div class="insp-row"><label>Risk rating</label><div class="risk-row">${['A', 'B', 'C', 'D', 'E'].map(r => `<button data-risk="${r}" class="${cur === r ? 'sel' : ''}" style="${cur === r ? `background:${RISK[r]};border-color:${RISK[r]}` : ''}">${r}</button>`).join('')}</div></div>`;
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/* Normalise a rotation value to an integer 0–359. */
function normRot(v) { let r = Math.round(+v || 0) % 360; if (r < 0) r += 360; return r; }
/* Rotate a node by a delta (degrees), snapshot + commit so it's undoable. */
function rotateNode(n, delta) { mutate(() => { n.rot = normRot((n.rot || 0) + delta); }); renderInspector(); }

function wireInspector() {
  const body = $('#inspBody');
  const set = (sels, ev, fn) => { const el = $(sels, body); if (el) el.addEventListener(ev, fn); };
  if (sel.kind === 'node') {
    const n = nodeById(sel.id);
    set('.i-label', 'input', e => { n.label = e.target.value; dirty = true; draw(); });
    set('.i-rot', 'input', e => { n.rot = normRot(e.target.value); dirty = true; draw(); });
    set('.i-rot', 'change', e => { n.rot = normRot(e.target.value); e.target.value = n.rot; commit(); });
    set('.i-rot-btn', 'click', () => rotateNode(n, 90));
    set('.i-vol', 'input', e => { n.props.volume = e.target.value; dirty = true; draw(); });
    set('.i-loc', 'input', e => { n.props.location = e.target.value; dirty = true; });
    set('.i-notes', 'input', e => { n.props.notes = e.target.value; dirty = true; });
    set('.i-size', 'change', e => { n.props.size = e.target.value; const sc = e.target.value === 's' ? .8 : e.target.value === 'l' ? 1.3 : 1; const a = ASSETS[n.type]; n.w = Math.round(a.w * sc); n.h = Math.round(a.h * sc); commit(); });
    $$('[data-risk]', body).forEach(b => b.addEventListener('click', () => { n.props.risk = n.props.risk === b.dataset.risk ? '' : b.dataset.risk; renderInspector(); commit(); }));
  } else if (sel.kind === 'pipe') {
    const p = state.pipes.find(p => p.id === sel.id);
    set('.i-ptype', 'change', e => { p.type = e.target.value; commit(); renderInspector(); });
  } else if (sel.kind === 'zone') {
    const z = state.zones.find(z => z.id === sel.id);
    set('.i-zlabel', 'input', e => { z.label = e.target.value; dirty = true; draw(); });
    $$('[data-zpos]', body).forEach(b => b.addEventListener('click', () => { z.labelPos = b.dataset.zpos; renderInspector(); commit(); }));
    $$('[data-zc]', body).forEach(s => s.addEventListener('click', () => { z.color = s.dataset.zc; renderInspector(); commit(); }));
  } else if (sel.kind === 'text') {
    const t = state.texts.find(t => t.id === sel.id);
    set('.i-text', 'input', e => { t.text = e.target.value; dirty = true; draw(); });
    set('.i-talign', 'change', e => { t.align = e.target.value; commit(); });
    set('.i-twrap', 'input', e => { t.wrap = Math.max(0, +e.target.value || 0); dirty = true; draw(); });
    set('.i-tsize', 'input', e => { t.size = +e.target.value || 14; dirty = true; draw(); });
  }
  const del = $('[data-del]', body); if (del) del.addEventListener('click', deleteSelected);
}

function deleteSelected() {
  if (group.length) {
    const nodeIds = new Set(), zoneIds = new Set(), textIds = new Set();
    const pipeVerts = new Map();   // pipe id → Set of vertex indices to remove
    for (const r of group) {
      if (r.kind === 'node') nodeIds.add(r.id);
      else if (r.kind === 'zone') zoneIds.add(r.id);
      else if (r.kind === 'text') textIds.add(r.id);
      else if (r.kind === 'pipe') {
        const set = pipeVerts.get(r.id) || new Set();
        (r.verts || []).forEach(i => set.add(i));
        pipeVerts.set(r.id, set);
      }
    }
    mutate(() => {
      if (nodeIds.size) {
        state.nodes = state.nodes.filter(n => !nodeIds.has(n.id));
        for (const p of state.pipes) for (const pt of p.pts) if (pt.node && nodeIds.has(pt.node)) delete pt.node;
      }
      if (pipeVerts.size) {
        for (const [id, set] of pipeVerts) {
          const p = state.pipes.find(p => p.id === id);
          if (p) p.pts = p.pts.filter((_, i) => !set.has(i));
        }
        // a run left with fewer than two points is no longer a line — drop it
        state.pipes = state.pipes.filter(p => p.pts.length >= 2);
      }
      if (zoneIds.size) state.zones = state.zones.filter(z => !zoneIds.has(z.id));
      if (textIds.size) state.texts = state.texts.filter(t => !textIds.has(t.id));
      select(null);
    });
    return;
  }
  if (!sel) return;
  mutate(() => {
    if (sel.kind === 'node') {
      state.nodes = state.nodes.filter(n => n.id !== sel.id);
      // detach pipe points that referenced this node
      for (const p of state.pipes) for (const pt of p.pts) if (pt.node === sel.id) delete pt.node;
    } else if (sel.kind === 'pipe') state.pipes = state.pipes.filter(p => p.id !== sel.id);
    else if (sel.kind === 'zone') state.zones = state.zones.filter(z => z.id !== sel.id);
    else if (sel.kind === 'text') state.texts = state.texts.filter(t => t.id !== sel.id);
    select(null);
  });
}

/* ============================================================
   ALIGN & DISTRIBUTE (multi-selection)
   Treat each selected item as one unit with a world-space bounding box, then
   shift whole units so their edges or centres line up, or space them evenly.
   Asset-bound pipe endpoints (green) never move — only free pipe points do, and
   the boxed points of one run move together so the run keeps its shape.
   Results are deliberately NOT grid-snapped: matching an edge or centre exactly
   matters more than the grid, and even gaps are often fractional. Snapping would
   pull items back out of line.
   ============================================================ */

const ALIGN_ICONS = {
  left:    `<svg viewBox="0 0 24 24"><line x1="4" y1="4" x2="4" y2="20" stroke="currentColor" stroke-width="1.6" opacity=".55"/><rect x="6" y="7" width="13" height="3.4" rx="1" fill="currentColor"/><rect x="6" y="13.6" width="8" height="3.4" rx="1" fill="currentColor"/></svg>`,
  hcenter: `<svg viewBox="0 0 24 24"><line x1="12" y1="3" x2="12" y2="21" stroke="currentColor" stroke-width="1.6" opacity=".55"/><rect x="4.5" y="7" width="15" height="3.4" rx="1" fill="currentColor"/><rect x="7" y="13.6" width="10" height="3.4" rx="1" fill="currentColor"/></svg>`,
  right:   `<svg viewBox="0 0 24 24"><line x1="20" y1="4" x2="20" y2="20" stroke="currentColor" stroke-width="1.6" opacity=".55"/><rect x="5" y="7" width="13" height="3.4" rx="1" fill="currentColor"/><rect x="10" y="13.6" width="8" height="3.4" rx="1" fill="currentColor"/></svg>`,
  top:     `<svg viewBox="0 0 24 24"><line x1="4" y1="4" x2="20" y2="4" stroke="currentColor" stroke-width="1.6" opacity=".55"/><rect x="7" y="6" width="3.4" height="13" rx="1" fill="currentColor"/><rect x="13.6" y="6" width="3.4" height="8" rx="1" fill="currentColor"/></svg>`,
  vcenter: `<svg viewBox="0 0 24 24"><line x1="3" y1="12" x2="21" y2="12" stroke="currentColor" stroke-width="1.6" opacity=".55"/><rect x="7" y="4.5" width="3.4" height="15" rx="1" fill="currentColor"/><rect x="13.6" y="7" width="3.4" height="10" rx="1" fill="currentColor"/></svg>`,
  bottom:  `<svg viewBox="0 0 24 24"><line x1="4" y1="20" x2="20" y2="20" stroke="currentColor" stroke-width="1.6" opacity=".55"/><rect x="7" y="5" width="3.4" height="13" rx="1" fill="currentColor"/><rect x="13.6" y="10" width="3.4" height="8" rx="1" fill="currentColor"/></svg>`,
  disth:   `<svg viewBox="0 0 24 24"><rect x="4" y="6" width="3.2" height="12" rx="1" fill="currentColor"/><rect x="10.4" y="6" width="3.2" height="12" rx="1" fill="currentColor"/><rect x="16.8" y="6" width="3.2" height="12" rx="1" fill="currentColor"/></svg>`,
  distv:   `<svg viewBox="0 0 24 24"><rect x="6" y="4" width="12" height="3.2" rx="1" fill="currentColor"/><rect x="6" y="10.4" width="12" height="3.2" rx="1" fill="currentColor"/><rect x="6" y="16.8" width="12" height="3.2" rx="1" fill="currentColor"/></svg>`,
};

/* Build the Align & Distribute panel for the multi-select inspector. `count` is
   the number of items that can actually move (distribute needs at least 3). */
function alignSection(count) {
  const canDist = count >= 3;
  const a = (op, title) => `<button type="button" data-align="${op}" title="${title}">${ALIGN_ICONS[op]}</button>`;
  const d = (ax, title) => `<button type="button" data-dist="${ax}" title="${title}"${canDist ? '' : ' disabled'}>${ALIGN_ICONS['dist' + ax]}</button>`;
  return `<div class="insp-row align-section">`
    + `<label>Align edges &amp; centres</label>`
    + `<div class="align-grid">`
    + a('left', 'Align left edges') + a('hcenter', 'Align horizontal centres') + a('right', 'Align right edges')
    + a('top', 'Align top edges') + a('vcenter', 'Align vertical centres') + a('bottom', 'Align bottom edges')
    + `</div>`
    + `<label style="margin-top:10px">Distribute evenly${canDist ? '' : ' (needs 3+)'}</label>`
    + `<div class="align-grid">` + d('h', 'Space evenly left → right') + d('v', 'Space evenly top → bottom') + `</div>`
    + `</div>`;
}

/* Movable (non-asset-bound) vertex indices for a pipe group ref. */
function pipeMoveVerts(ref, p) {
  const all = ref.verts || p.pts.map((_, i) => i);
  return all.filter(i => p.pts[i] && !p.pts[i].node);
}

/* World-space bounding box for one selected ref, or null if it can't move
   (e.g. a pipe whose only boxed points are pinned to assets). */
function refBBox(ref) {
  if (ref.kind === 'node') {
    const n = nodeById(ref.id); if (!n) return null;
    return { x1: n.x - n.w / 2, y1: n.y - n.h / 2, x2: n.x + n.w / 2, y2: n.y + n.h / 2 };
  }
  if (ref.kind === 'zone') {
    const z = state.zones.find(z => z.id === ref.id); if (!z) return null;
    return { x1: z.x, y1: z.y, x2: z.x + z.w, y2: z.y + z.h };
  }
  if (ref.kind === 'text') {
    const t = state.texts.find(t => t.id === ref.id); if (!t) return null;
    const m = textBlock(t);
    return { x1: t.x, y1: t.y - m.ascent, x2: t.x + m.w, y2: t.y - m.ascent + m.h };
  }
  if (ref.kind === 'pipe') {
    const p = state.pipes.find(p => p.id === ref.id); if (!p) return null;
    const verts = pipeMoveVerts(ref, p);
    if (!verts.length) return null;
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const i of verts) { const pt = p.pts[i]; if (pt.x < x1) x1 = pt.x; if (pt.y < y1) y1 = pt.y; if (pt.x > x2) x2 = pt.x; if (pt.y > y2) y2 = pt.y; }
    return { x1, y1, x2, y2 };
  }
  return null;
}

/* Nudge a ref's anchor(s) by (dx, dy). Pipes move only their boxed free points. */
function translateRef(ref, dx, dy) {
  if (!dx && !dy) return;
  if (ref.kind === 'node') { const n = nodeById(ref.id); if (n) { n.x += dx; n.y += dy; } }
  else if (ref.kind === 'zone') { const z = state.zones.find(z => z.id === ref.id); if (z) { z.x += dx; z.y += dy; } }
  else if (ref.kind === 'text') { const t = state.texts.find(t => t.id === ref.id); if (t) { t.x += dx; t.y += dy; } }
  else if (ref.kind === 'pipe') {
    const p = state.pipes.find(p => p.id === ref.id); if (!p) return;
    for (const i of pipeMoveVerts(ref, p)) { p.pts[i].x += dx; p.pts[i].y += dy; }
  }
}

/* Collect the selected refs that have a movable bounding box. */
function alignableUnits() {
  return group.map(ref => ({ ref, b: refBBox(ref) })).filter(u => u.b);
}

/* op: left | right | hcenter | top | bottom | vcenter. Edges align to the
   selection's outer bounds; centres align to the selection's mid-point. */
function alignSelection(op) {
  const units = alignableUnits();
  if (units.length < 2) return;
  let minX1 = Infinity, maxX2 = -Infinity, minY1 = Infinity, maxY2 = -Infinity;
  for (const { b } of units) {
    if (b.x1 < minX1) minX1 = b.x1; if (b.x2 > maxX2) maxX2 = b.x2;
    if (b.y1 < minY1) minY1 = b.y1; if (b.y2 > maxY2) maxY2 = b.y2;
  }
  const midX = (minX1 + maxX2) / 2, midY = (minY1 + maxY2) / 2;
  mutate(() => {
    for (const { ref, b } of units) {
      let dx = 0, dy = 0;
      if (op === 'left') dx = minX1 - b.x1;
      else if (op === 'right') dx = maxX2 - b.x2;
      else if (op === 'hcenter') dx = midX - (b.x1 + b.x2) / 2;
      else if (op === 'top') dy = minY1 - b.y1;
      else if (op === 'bottom') dy = maxY2 - b.y2;
      else if (op === 'vcenter') dy = midY - (b.y1 + b.y2) / 2;
      translateRef(ref, dx, dy);
    }
  });
  renderInspector();
}

/* axis: 'h' or 'v'. Equal-gap distribution — the two outermost items hold their
   positions and everything between is spaced so the gaps between boxes match. */
function distributeSelection(axis) {
  const units = alignableUnits();
  if (units.length < 3) return;
  const lo = axis === 'h' ? 'x1' : 'y1';
  const hi = axis === 'h' ? 'x2' : 'y2';
  units.sort((a, c) => a.b[lo] - c.b[lo]);
  const start = units[0].b[lo];
  const end = units[units.length - 1].b[hi];
  let sizes = 0; for (const { b } of units) sizes += b[hi] - b[lo];
  const gap = (end - start - sizes) / (units.length - 1);
  mutate(() => {
    let cursor = start;
    for (const { ref, b } of units) {
      const delta = cursor - b[lo];
      translateRef(ref, axis === 'h' ? delta : 0, axis === 'h' ? 0 : delta);
      cursor += (b[hi] - b[lo]) + gap;
    }
  });
  renderInspector();
}

/* ============================================================
   CLIPBOARD (in-app copy / paste of selected items)
   ============================================================ */
const cloneObj = o => JSON.parse(JSON.stringify(o));
let clipboard = null;   // { nodes, pipes, zones, texts } — self-contained snapshot of a selection
let pasteSeq = 0;       // grows per offset-paste so repeated pastes cascade instead of stacking

/* The current selection as a flat list of refs, whether single or grouped. */
function selectionRefs() {
  if (group.length) return group.slice();
  if (sel) return [sel];
  return [];
}

const clipboardCount = () =>
  clipboard ? clipboard.nodes.length + clipboard.pipes.length + clipboard.zones.length + clipboard.texts.length : 0;

/* Snapshot the current selection into the in-app clipboard. Returns item count. */
function captureToClipboard() {
  const refs = selectionRefs();
  if (!refs.length) return 0;
  const ids = { node: new Set(), pipe: new Set(), zone: new Set(), text: new Set() };
  for (const r of refs) ids[r.kind] && ids[r.kind].add(r.id);
  clipboard = {
    nodes: state.nodes.filter(n => ids.node.has(n.id)).map(cloneObj),
    pipes: state.pipes.filter(p => ids.pipe.has(p.id)).map(cloneObj),
    zones: state.zones.filter(z => ids.zone.has(z.id)).map(cloneObj),
    texts: state.texts.filter(t => ids.text.has(t.id)).map(cloneObj),
  };
  pasteSeq = 0;   // next offset-paste starts one step from the originals
  return clipboardCount();
}

function copySelection() {
  const total = captureToClipboard();
  if (!total) return;
  toast(`Copied ${total} item${total > 1 ? 's' : ''}`);
}

function cutSelection() {
  const total = captureToClipboard();
  if (!total) return;
  deleteSelected();   // own snapshot/undo step; clipboard already holds the copy
  toast(`Cut ${total} item${total > 1 ? 's' : ''}`);
}

/* World-space bounding box of everything on the clipboard (for cursor paste). */
function clipboardBounds() {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  const ext = (ax, ay, bx, by) => { if (ax < x1) x1 = ax; if (ay < y1) y1 = ay; if (bx > x2) x2 = bx; if (by > y2) y2 = by; };
  for (const n of clipboard.nodes) ext(n.x - n.w / 2, n.y - n.h / 2, n.x + n.w / 2, n.y + n.h / 2);
  for (const p of clipboard.pipes) for (const pt of p.pts) ext(pt.x, pt.y, pt.x, pt.y);
  for (const z of clipboard.zones) ext(z.x, z.y, z.x + z.w, z.y + z.h);
  for (const t of clipboard.texts) { const m = textBlock(t); ext(t.x, t.y - m.ascent, t.x + m.w, t.y - m.ascent + m.h); }
  return x1 === Infinity ? null : { x1, y1, x2, y2 };
}

function pasteClipboard() {
  if (!clipboardCount()) return;

  // Drop the copy under the cursor when it's over the canvas; otherwise (e.g. a
  // keyboard paste with the mouse elsewhere) fall back to a cascading offset.
  let dx, dy;
  const b = clipboardBounds();
  if (pointerInCanvas && pointerWorldPos && b) {
    const cx = (b.x1 + b.x2) / 2, cy = (b.y1 + b.y2) / 2;
    dx = snap(pointerWorldPos.x - cx); dy = snap(pointerWorldPos.y - cy);
    pasteSeq = 0;
  } else {
    dx = dy = GRID * 2 * (++pasteSeq);
  }

  mutate(() => {
    const idMap = new Map();   // original node id → new node id (for re-wiring pipes)
    const placed = [];

    for (const n of clipboard.nodes) {
      const nn = cloneObj(n); nn.id = uid();
      nn.x = snap(n.x + dx); nn.y = snap(n.y + dy);
      idMap.set(n.id, nn.id);
      state.nodes.push(nn); placed.push({ kind: 'node', id: nn.id });
    }

    for (const p of clipboard.pipes) {
      const np = cloneObj(p); np.id = uid();
      np.pts = np.pts.map(pt => {
        const out = { x: snap(pt.x + dx), y: snap(pt.y + dy) };
        // Keep the connection only if its asset was copied too; otherwise the
        // endpoint becomes a free point so the paste doesn't snap onto the original.
        if (pt.node && idMap.has(pt.node)) out.node = idMap.get(pt.node);
        return out;
      });
      state.pipes.push(np); placed.push({ kind: 'pipe', id: np.id });
    }

    for (const z of clipboard.zones) {
      const nz = cloneObj(z); nz.id = uid();
      nz.x = snap(z.x + dx); nz.y = snap(z.y + dy);
      state.zones.unshift(nz); placed.push({ kind: 'zone', id: nz.id });
    }

    for (const t of clipboard.texts) {
      const nt = cloneObj(t); nt.id = uid();
      nt.x = snap(t.x + dx); nt.y = snap(t.y + dy);
      state.texts.push(nt); placed.push({ kind: 'text', id: nt.id });
    }

    if (placed.length === 1) select(placed[0]);
    else setGroup(placed);
  });
  const total = clipboardCount();
  toast(`Pasted ${total} item${total > 1 ? 's' : ''}`);
}

/* ============================================================
   TOOLBAR / TOOLS WIRING
   ============================================================ */
function setTool(t, opts = {}) {
  tool = t;
  if (t === 'pipe' && opts.pipe) pipeKind = opts.pipe;
  if (t === 'asset' && opts.asset) assetKind = opts.asset;
  if (t !== 'pipe') cancelDraft();
  $$('.tool').forEach(b => b.classList.remove('active'));
  let selector = `.tool[data-tool="${t}"]`;
  if (t === 'pipe') selector = `.tool[data-pipe="${pipeKind}"]`;
  if (t === 'asset') selector = `.tool[data-asset="${assetKind}"]`;
  const btn = $(selector); if (btn) btn.classList.add('active');
  $('#statusTool').textContent = ({ select: 'Select', pan: 'Pan', zone: 'Area', text: 'Label', pipe: PIPES[pipeKind].name, asset: ASSETS[assetKind].name })[t] || t;
  canvas.style.cursor = t === 'pan' ? 'grab' : t === 'select' ? 'default' : 'crosshair';
  if (t === 'pipe') hint('Click to start a run. Click bends, then click an asset or double-click to finish.');
  else if (t === 'asset') hint('Click on the grid to drop a ' + ASSETS[assetKind].name + '.');
  else if (t === 'zone') hint('Drag to draw a floor or area zone.');
}
$$('.tool').forEach(b => b.addEventListener('click', () => setTool(b.dataset.tool, { pipe: b.dataset.pipe, asset: b.dataset.asset })));

/* view controls */
$('#zoomIn').onclick = () => zoomAt(canvas.width / dpr / 2, canvas.height / dpr / 2, 1.2);
$('#zoomOut').onclick = () => zoomAt(canvas.width / dpr / 2, canvas.height / dpr / 2, 1 / 1.2);
$('#zoomLevel').onclick = () => { view.scale = 1; updateZoomLabel(); draw(); };
$('#zoomFit').onclick = fitView;
$('#toggleGrid').onclick = e => { showGrid = !showGrid; e.currentTarget.classList.toggle('active', showGrid); draw(); };
$('#toggleSnap').onclick = e => { snapOn = !snapOn; e.currentTarget.classList.toggle('active', snapOn); };
$('#toggleLegend').onclick = e => { showLegend = !showLegend; e.currentTarget.classList.toggle('active', showLegend); draw(); };
$('#toggleFooter').onclick = e => { showFooter = !showFooter; e.currentTarget.classList.toggle('active', showFooter); draw(); };
$('#togglePage').onclick = () => {
  mutate(() => {
    state.page ||= { orientation: 'landscape' };
    state.page.orientation = state.page.orientation === 'portrait' ? 'landscape' : 'portrait';
  });
  // Re-frame so the re-proportioned sheet stays fully in view.
  fitView();
};
function updatePageBtn() {
  const portrait = state.page && state.page.orientation === 'portrait';
  const b = $('#togglePage');
  if (b) b.textContent = portrait ? 'Portrait' : 'Landscape';
}
function updateZoomLabel() { $('#zoomLevel').textContent = Math.round(view.scale * 100) + '%'; }

function contentBounds(pad = 60) {
  let xs = [], ys = [];
  for (const n of state.nodes) { xs.push(n.x - n.w / 2, n.x + n.w / 2); ys.push(n.y - n.h / 2, n.y + n.h / 2); }
  for (const z of state.zones) { xs.push(z.x, z.x + z.w); ys.push(z.y, z.y + z.h); }
  for (const p of state.pipes) for (const pt of p.pts) { const q = ptPos(pt); xs.push(q.x); ys.push(q.y); }
  for (const t of state.texts) { const m = textBlock(t); xs.push(t.x, t.x + m.w); ys.push(t.y - m.ascent, t.y - m.ascent + m.h); }
  if (!xs.length) return null;
  return { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, w: Math.max(...xs) - Math.min(...xs) + pad * 2, h: Math.max(...ys) - Math.min(...ys) + pad * 2 };
}
function fitView() {
  const p = pageBounds(), pad = 40;
  let b = { x: p.x - pad, y: p.y - pad, w: p.w + pad * 2, h: p.h + pad * 2 };
  const c = contentBounds();
  if (c) {
    const minx = Math.min(b.x, c.x), miny = Math.min(b.y, c.y);
    const maxx = Math.max(b.x + b.w, c.x + c.w), maxy = Math.max(b.y + b.h, c.y + c.h);
    b = { x: minx, y: miny, w: maxx - minx, h: maxy - miny };
  }
  const cssW = canvas.width / dpr, cssH = canvas.height / dpr;
  const s = Math.min(cssW / b.w, cssH / b.h, 2.5);
  view.scale = Math.max(.2, s);
  view.ox = (cssW - b.w * view.scale) / 2 - b.x * view.scale;
  view.oy = (cssH - b.h * view.scale) / 2 - b.y * view.scale;
  updateZoomLabel(); draw();
}

/* ============================================================
   STATUS / HINTS
   ============================================================ */
function updateStatus() { updatePageBtn(); $('#statusCounts').textContent = `${state.nodes.length} assets · ${state.pipes.length} pipes`; $('#statusSaved').textContent = dirty ? 'Unsaved' : 'Saved'; $('#statusSaved').classList.toggle('unsaved', dirty); $('#projectName').textContent = state.name; }
function updateCoords(w) { $('#statusCoords').textContent = `${Math.round(w.x)}, ${Math.round(w.y)}`; }
let hintTimer;
function hint(msg) { const el = $('#hint'); clearTimeout(hintTimer); if (!msg) { el.classList.remove('show'); return; } el.textContent = msg; el.classList.add('show'); }
function toast(msg, ms = 2200) { const el = $('#toast'); el.textContent = msg; el.hidden = false; clearTimeout(el._t); el._t = setTimeout(() => el.hidden = true, ms); }

/* ============================================================
   SAVE / LOAD / AUTOSAVE
   ============================================================ */
const LS_KEY = 'flowmark.project.v1';
let saveTimer;
function autosave() { clearTimeout(saveTimer); saveTimer = setTimeout(() => { try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) { } }, 400); }
function loadAutosave() { try { const s = localStorage.getItem(LS_KEY); if (s) { state = normalize(JSON.parse(s)); return true; } } catch (e) { } return false; }
function normalize(s) { s.zones ||= []; s.nodes ||= []; s.pipes ||= []; s.texts ||= []; s.page ||= { orientation: 'landscape' }; if (s.page.orientation !== 'portrait') s.page.orientation = 'landscape'; s.name ||= 'Untitled schematic'; s.meta ||= {}; s.meta.customer ??= ''; s.meta.site ??= ''; s.meta.date ??= ''; for (const n of s.nodes) n.props ||= {}; return s; }

/* File System Access API lets us write straight back over an existing file
   (a real "Save as" dialog + silent overwrite of the chosen file). Falls back
   to a download for browsers that don't support it (e.g. Firefox, Safari). */
let fileHandle = null;
const FS_SAVE = typeof window.showSaveFilePicker === 'function';
const FS_OPEN = typeof window.showOpenFilePicker === 'function';
const FS_TYPES = [{ description: 'FlowMark project', accept: { 'application/json': ['.json'] } }];
function projectFilename() { return (state.name || 'schematic').replace(/[^\w\-]+/g, '_') + '.flowmark.json'; }

async function saveProject(forceDialog = false) {
  const text = JSON.stringify(state, null, 2);
  if (FS_SAVE) {
    try {
      // No file chosen yet (or "Save as"): open the Save-as dialog so the
      // user can pick / overwrite a file. After that, plain Save writes
      // straight back to it with no dialog.
      if (!fileHandle || forceDialog) {
        const opts = { suggestedName: fileHandle ? fileHandle.name : projectFilename(), types: FS_TYPES };
        if (fileHandle) opts.startIn = fileHandle;
        fileHandle = await window.showSaveFilePicker(opts);
      }
      const w = await fileHandle.createWritable();
      await w.write(text);
      await w.close();
      dirty = false; updateStatus(); toast('Saved to ' + fileHandle.name);
    } catch (err) {
      if (err && err.name === 'AbortError') return; // user cancelled the dialog
      console.error(err); toast('Could not save to that file');
    }
    return;
  }
  // Fallback: trigger a download (cannot overwrite in place on these browsers).
  const blob = new Blob([text], { type: 'application/json' });
  download(blob, projectFilename());
  dirty = false; updateStatus(); toast('Project saved to file');
}

$('#btnSave').onclick = () => saveProject(false);

$('#btnOpen').onclick = async () => {
  if (FS_OPEN) {
    try {
      const [h] = await window.showOpenFilePicker({ multiple: false, types: [{ description: 'FlowMark project', accept: { 'application/json': ['.json', '.flowmark'] } }] });
      const f = await h.getFile();
      const txt = await f.text();
      state = normalize(JSON.parse(txt));
      fileHandle = h; // future saves overwrite the file that was opened
      sel = null; renderInspector(); fitView(); updateStatus(); dirty = false; toast('Project opened');
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      console.error(err); toast('That file could not be read');
    }
    return;
  }
  $('#fileOpen').click(); // fallback for browsers without the picker
};
$('#fileOpen').onchange = e => {
  const f = e.target.files[0]; if (!f) return;
  const rd = new FileReader();
  rd.onload = () => { try { state = normalize(JSON.parse(rd.result)); fileHandle = null; sel = null; renderInspector(); fitView(); updateStatus(); dirty = false; toast('Project opened'); } catch (err) { toast('That file could not be read'); } };
  rd.readAsText(f); e.target.value = '';
};
$('#btnNew').onclick = () => { if (dirty && !confirm('Start a new schematic? Unsaved changes will be lost.')) return; state = blankState(); fileHandle = null; sel = null; renderInspector(); dirty = false; updateStatus(); fitView(); };

$('#projectName').onclick = () => { const v = prompt('Project name:', state.name); if (v != null) { state.name = v.trim() || 'Untitled schematic'; dirty = true; updateStatus(); } };

function download(blob, name) { const u = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = u; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(u), 1500); }

/* ============================================================
   EXPORT  (JPG + PDF)
   ============================================================ */
function renderExportCanvas(ss = 3, compose = 1) {
  // ss      = supersample factor — output resolution / crispness only.
  //           3.0 puts a 1120×800 sheet at ~3360×2400 px, ≈314 DPI on the A4
  //           print area — clears the 300 DPI print standard with headroom.
  // compose = world->css scale the scene is composed at. Kept at 1 (100%) so the
  //           text:geometry ratio matches the on-screen app, since label/line sizes
  //           use Math.min(S, cap) clamps that only stay proportional while S <= cap.
  if (!contentBounds(0)) { toast('Nothing on the page to export yet'); return null; }
  const b = pageBounds();   // export exactly the A4 sheet, in its chosen orientation
  const cw = Math.ceil(b.w * compose), ch = Math.ceil(b.h * compose);
  const c = document.createElement('canvas');
  c.width = Math.ceil(cw * ss); c.height = Math.ceil(ch * ss);
  const cx = c.getContext('2d');
  cx.setTransform(ss, 0, 0, ss, 0, 0);                 // uniform supersample for crisp output
  cx.fillStyle = '#ffffff'; cx.fillRect(0, 0, cw, ch);
  const T = { scale: compose, ox: -b.x * compose, oy: -b.y * compose };
  // Grid background — follows the on-screen Grid toggle, so exports are WYSIWYG.
  if (showGrid) drawGridOn(cx, T);
  // scene (composed at 100% => WYSIWYG label sizing). Anything off the sheet is
  // naturally clipped by the canvas bounds, matching what the page boundary shows.
  // The branded title-block footer is drawn by drawScene; the legend auto-places
  // to a clear corner of the sheet, avoiding both the schematic and the footer.
  drawScene(cx, T, { legend: showLegend, footer: showFooter, legendFrame: { x: 0, y: 0, w: cw, h: ch }, legendMargin: 16 });
  return { canvas: c, bounds: b };
}

$('#btnExportImg').onclick = () => {
  const r = renderExportCanvas(); if (!r) return;
  r.canvas.toBlob(b => { download(b, (state.name || 'schematic').replace(/[^\w\-]+/g, '_') + '.jpg'); toast('JPG exported'); }, 'image/jpeg', 0.96);
};

let jspdfLoading;
async function ensureJsPDF() {
  if (window.jspdf) return window.jspdf.jsPDF;
  jspdfLoading ||= loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
  await jspdfLoading; return window.jspdf.jsPDF;
}
$('#btnExportPdf').onclick = async () => {
  const r = renderExportCanvas(); if (!r) return;
  toast('Building PDF…', 1500);
  try {
    const jsPDF = await ensureJsPDF();
    const landscape = pageDims().w >= pageDims().h;
    const pdf = new jsPDF({ orientation: landscape ? 'l' : 'p', unit: 'mm', format: 'a4' });
    const pw = pdf.internal.pageSize.getWidth(), ph = pdf.internal.pageSize.getHeight();
    // Line art at 314 DPI: JPEG q0.95 keeps ringing sub-pixel at print size
    // while holding the file to ~1-2MB. PNG here is lossless but balloons to
    // ~30MB because the browser encoder stores every antialiased edge pixel.
    // The print-perfect + small route is a true vector PDF (drawScene via
    // jsPDF context2d) — deferred: drawScene's Math.min(S,cap) width/font
    // clamps assume S≈1, so it needs a compose-at-1-then-scale path first.
    const img = r.canvas.toDataURL('image/jpeg', 0.95);
    // Fill the whole A4 page edge-to-edge so the branded footer bleeds to the
    // paper edge with no white margin. The sheet aspect (1.40) is within ~1% of
    // true A4 (1.414), so filling applies an imperceptible stretch rather than
    // letterboxing the sheet with white bars on the sides and bottom.
    pdf.addImage(img, 'JPEG', 0, 0, pw, ph);
    pdf.save((state.name || 'schematic').replace(/[^\w\-]+/g, '_') + '.pdf');
    toast('PDF exported');
  } catch (e) { toast('PDF export needs a connection the first time'); }
};

function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('load ' + src)); document.head.appendChild(s); }); }

/* ============================================================
   PDF IMPORT  +  ASSET DETECTION
   ============================================================ */
let pdfjsLoading;
async function ensurePdfJs() {
  if (window.pdfjsLib) return window.pdfjsLib;
  pdfjsLoading ||= loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
  await pdfjsLoading;
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  return window.pdfjsLib;
}
$('#btnImport').onclick = () => $('#filePdf').click();
$('#filePdf').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  toast('Reading PDF…', 4000);
  try {
    const pdfjs = await ensurePdfJs();
    const buf = await f.arrayBuffer();
    const pdf = await pdfjs.getDocument({ data: buf }).promise;
    let text = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      text += '\n' + tc.items.map(it => it.str).join(' ');
    }
    const detected = detectAssets(text);
    openImportModal(detected);
  } catch (err) { console.error(err); toast('Could not read that PDF (needs a connection the first time)'); }
};

function detectAssets(raw) {
  const text = raw.replace(/\s+/g, ' ');
  const lc = text.toLowerCase();
  const uniq = a => [...new Set(a)];
  const found = { tanks: [], heaters: [], showers: 0, tmvs: 0, mixers: 0, deadlegs: [], outlets: [], floors: [] };

  // --- water heaters: WH1, WH 15, WH-2 ---
  const whTags = uniq((text.match(/\bWH\s?-?\s?\d{1,3}\b/gi) || []).map(s => s.replace(/\s|-/g, '').toUpperCase()));
  whTags.sort((a, b) => (+a.replace(/\D/g, '')) - (+b.replace(/\D/g, '')));
  for (const tag of whTags) {
    const vol = nearVolume(text, tag);
    const loc = nearField(text, tag, /(?:Building Reference\s*\/\s*Location|Location)\s*[:\-]?\s*([A-Za-z0-9 ,\.&\/]{3,40})/i);
    found.heaters.push({ tag, volume: vol, location: loc });
  }
  if (!found.heaters.length && /(water heater|calorifier)/i.test(lc)) found.heaters.push({ tag: 'WH1', volume: null, location: null });

  // --- cold water storage tanks ---
  let tankCount = 0;
  const cfg = /Number of tanks\s*\/?\s*configuration\s*[:\-]?\s*(\d+)/i.exec(text);
  if (cfg) tankCount = +cfg[1];
  const tankTags = uniq((text.match(/\b(?:CWST|TK)\s?-?\s?\d{0,2}\b/gi) || []).map(s => s.replace(/\s|-/g, '').toUpperCase()));
  const tankNums = uniq((text.match(/\bTank\s?\d{1,2}\b/gi) || []).map(s => s.replace(/\s/g, '').toUpperCase()));
  let tanks = uniq([...tankTags.filter(t => /\d/.test(t)), ...tankNums.map(t => t.replace('TANK', 'TK'))]);
  if (!tanks.length && (tankCount || /cold water storage|CWST/i.test(text))) tanks = Array.from({ length: Math.max(1, tankCount || 1) }, (_, i) => 'TK' + (i + 1));
  else if (tankCount > tanks.length) for (let i = tanks.length; i < tankCount; i++) tanks.push('TK' + (i + 1));
  const tankLoc = (/(?:Building Reference\s*\/\s*Location|Building reference\/location)\s*[:\-]?\s*([A-Za-z0-9 ,\.&\/]{3,40})/i.exec(text) || [])[1];
  found.tanks = tanks.map((t, i) => ({ tag: t.startsWith('TK') ? t : 'TK' + (i + 1), location: tankLoc || null }));

  // --- showers ---
  let sh = 0;
  const shMatch = /Showers?\s+(\d+)\s+of\s+(\d+)/i.exec(text);
  if (shMatch) sh = Math.max(+shMatch[1], +shMatch[2]);
  else sh = (lc.match(/\bshower/g) || []).length;
  if (/shower[s]?\s*(?:[:\-]?\s*)?(none|n\/a|nil)/i.test(lc)) sh = 0;
  found.showers = Math.min(sh, 30);

  // --- TMVs ---
  if (/thermostatic mixing valve|(\bTMV\b)/i.test(text)) {
    const none = /(?:TMV[s]?|thermostatic mixing valve[s]?)\s*(?:\(TMV\)\s*)?[:\-]?\s*(none|n\/a|nil)/i.test(text);
    const cnt = (text.match(/\bTMV\d*\b/gi) || []).length;
    found.tmvs = none ? 0 : Math.max(cnt, 1);
    found.tmvs = Math.min(found.tmvs, 20);
  }

  // --- mixers ---
  if (/\bmixer\b/i.test(lc)) found.mixers = Math.min((lc.match(/\bmixer/g) || []).length, 20) || 1;

  // --- deadlegs ---
  const dlBlocks = text.match(/dead\s?leg[\s\S]{0,80}?Length\s*\(mm\)\s*[:\-]?\s*(\d+)/gi) || [];
  for (const blk of dlBlocks) { const m = /(\d+)\s*$/.exec(blk.trim()); found.deadlegs.push({ length: m ? +m[1] : null }); }
  if (!found.deadlegs.length) { const c = (lc.match(/dead\s?leg/g) || []).length; for (let i = 0; i < Math.min(c, 12); i++) found.deadlegs.push({ length: null }); }

  // --- outlets by location ---
  const outRe = /Location\s*[:\-]?\s*([A-Za-z0-9 ,\.&\/]{3,34}?)\s+(?:Hot outlet|Cold outlet|Clarity|Aerosol|Asset Type)/gi;
  let m, seen = new Set();
  while ((m = outRe.exec(text)) && found.outlets.length < 40) { const loc = m[1].trim(); const key = loc.toLowerCase(); if (!seen.has(key)) { seen.add(key); found.outlets.push({ location: loc }); } }

  // --- floors / areas ---
  const floorRe = /\b(Ground Floor|First Floor|1st Floor|Second Floor|2nd Floor|Third Floor|3rd Floor|Basement|Plant Room|Roof|Mezzanine|Workshop|Office|Kitchen)\b/gi;
  found.floors = uniq((text.match(floorRe) || []).map(s => s.replace(/1st/i, 'First').replace(/2nd/i, 'Second').replace(/3rd/i, 'Third')
    .replace(/\b\w/g, c => c.toUpperCase())));
  // normalise duplicates like "Ground Floor"
  found.floors = uniq(found.floors);

  return found;
}
function nearVolume(text, tag) {
  const i = text.indexOf(tag); if (i < 0) return null;
  const window = text.slice(i, i + 220);
  const m = /Volume\s*\(litres\)\s*[:\-]?\s*(\d{1,4})/i.exec(window) || /(\d{2,4})\s*(?:litre|l\b)/i.exec(window);
  return m ? +m[1] : null;
}
function nearField(text, tag, re) {
  const i = text.indexOf(tag); if (i < 0) return null;
  const window = text.slice(Math.max(0, i - 40), i + 220);
  const m = re.exec(window); return m ? m[1].trim() : null;
}

/* ---- import modal ---- */
let pendingDetected = null;
function openImportModal(d) {
  pendingDetected = d;
  const body = $('#importBody');
  const total = d.tanks.length + d.heaters.length + d.showers + d.tmvs + d.mixers + d.deadlegs.length + d.outlets.length;
  let h = `<div class="import-note">Detected from the report text by matching the standard Legionella asset-register fields. It won't catch everything and may over- or under-count — untick anything wrong, then place and reposition on the canvas.</div>`;
  const group = (title, rows) => rows.length ? `<div class="det-group">${title}</div>` + rows.join('') : '';
  const rowHtml = (cat, idx, tag, desc, loc) => `<label class="det-row"><input type="checkbox" data-cat="${cat}" data-idx="${idx}" checked><span class="tag">${tag || '•'}</span><span class="desc">${esc(desc)}</span>${loc ? `<span class="loc">${esc(loc)}</span>` : ''}</label>`;

  h += group('Cold water storage tanks', d.tanks.map((t, i) => rowHtml('tanks', i, t.tag, 'Storage tank', t.location)));
  h += group('Water heaters', d.heaters.map((t, i) => rowHtml('heaters', i, t.tag, t.volume ? t.volume + ' litres' : 'Water heater', t.location)));
  if (d.tmvs) h += group('TMVs', Array.from({ length: d.tmvs }, (_, i) => rowHtml('tmvs', i, 'T' + (i + 1), 'Thermostatic mixing valve', null)));
  if (d.mixers) h += group('Mixers', Array.from({ length: d.mixers }, (_, i) => rowHtml('mixers', i, 'M' + (i + 1), 'Mixer tap', null)));
  if (d.showers) h += group('Showers', Array.from({ length: d.showers }, (_, i) => rowHtml('showers', i, 'SH' + (i + 1), 'Shower', null)));
  h += group('Deadlegs', d.deadlegs.map((t, i) => rowHtml('deadlegs', i, 'DL' + (i + 1), t.length ? t.length + ' mm deadleg' : 'Deadleg', null)));
  h += group('Outlets', d.outlets.map((t, i) => rowHtml('outlets', i, '', 'Outlet', t.location)));
  if (d.floors.length) h += `<div class="det-group">Areas to create</div><div class="import-note" style="margin-top:0">${d.floors.map(esc).join(' · ')}</div>`;
  if (total === 0) {
    // Nothing useful found — don't trap the user behind an empty modal.
    pendingDetected = null;
    toast('No standard assets recognised in that PDF — draw manually or try another report.', 3200);
    return;
  }
  body.innerHTML = h;
  $('#importSummary').textContent = total ? `${total} assets detected` : '';
  closeMenu();
  $('#importModal').hidden = false;
}
function closeImportModal() { $('#importModal').hidden = true; pendingDetected = null; }
$('#importClose').onclick = $('#importCancel').onclick = closeImportModal;
$('#importPlace').onclick = () => { placeDetected(); $('#importModal').hidden = true; pendingDetected = null; };
// Click the dimmed area (outside the dialog) to dismiss.
$('#importModal').addEventListener('click', e => { if (e.target === e.currentTarget) closeImportModal(); });

function placeDetected() {
  const d = pendingDetected; if (!d) return;
  const checked = {};
  $$('#importBody input[type=checkbox]').forEach(cb => { if (cb.checked) { (checked[cb.dataset.cat] ||= new Set()).add(+cb.dataset.idx); } });
  const keep = (cat, i) => checked[cat] && checked[cat].has(i);

  snapshot();
  // origin near current view centre, snapped
  const cssW = canvas.width / dpr, cssH = canvas.height / dpr;
  let ox = snap(wx(cssW / 2) - 200), oy = snap(wy(cssH / 2) - 120);

  // floors → stacked zones
  const floors = d.floors.length ? d.floors : ['Ground Floor'];
  const zoneW = 880, zoneH = 150, gap = 20;
  const zoneByFloor = {};
  floors.forEach((f, i) => {
    const z = { id: uid(), x: ox + 160, y: oy + i * (zoneH + gap), w: zoneW, h: zoneH, label: f, color: ZONE_COLORS[i % ZONE_COLORS.length] };
    state.zones.push(z); zoneByFloor[f] = z;
  });
  const floorOf = loc => { if (!loc) return floors[0]; const f = floors.find(fl => loc.toLowerCase().includes(fl.toLowerCase().split(' ')[0])); return f || floors[0]; };
  const cursor = {}; floors.forEach(f => cursor[f] = 0);
  const placeIn = (floor, w, h) => { const z = zoneByFloor[floor]; const col = cursor[floor]++; const perRow = Math.floor((z.w - 40) / 90); const r = Math.floor(col / perRow), cc = col % perRow; return { x: z.x + 50 + cc * 90, y: z.y + 50 + r * 70 }; };

  // tanks + pump (left of zones)
  let ty = oy + 20;
  d.tanks.forEach((t, i) => { if (!keep('tanks', i)) return; const a = ASSETS.tank; state.nodes.push({ id: uid(), type: 'tank', x: ox + 60, y: ty + i * 70, w: a.w, h: a.h, label: t.tag, props: { location: t.location || '' } }); });
  if (d.tanks.some((t, i) => keep('tanks', i))) state.nodes.push({ id: uid(), type: 'pump', x: ox + 130, y: ty, w: ASSETS.pump.w, h: ASSETS.pump.h, label: 'P', props: {} });

  d.heaters.forEach((t, i) => { if (!keep('heaters', i)) return; const f = floorOf(t.location); const p = placeIn(f, 46, 56); state.nodes.push({ id: uid(), type: 'heater', x: snap(p.x), y: snap(p.y), w: ASSETS.heater.w, h: ASSETS.heater.h, label: t.tag, props: { volume: t.volume || '', location: t.location || '' } }); });
  for (let i = 0; i < d.tmvs; i++) if (keep('tmvs', i)) { const p = placeIn(floors[0], 28, 28); state.nodes.push({ id: uid(), type: 'tmv', x: snap(p.x), y: snap(p.y), w: 28, h: 28, label: 'T' + (i + 1), props: {} }); }
  for (let i = 0; i < d.mixers; i++) if (keep('mixers', i)) { const p = placeIn(floors[0], 28, 28); state.nodes.push({ id: uid(), type: 'mixer', x: snap(p.x), y: snap(p.y), w: 28, h: 28, label: 'M' + (i + 1), props: {} }); }
  for (let i = 0; i < d.showers; i++) if (keep('showers', i)) { const p = placeIn(floors[floors.length - 1], 32, 36); state.nodes.push({ id: uid(), type: 'shower', x: snap(p.x), y: snap(p.y), w: 32, h: 36, label: 'SH' + (i + 1), props: {} }); }
  d.outlets.forEach((t, i) => { if (!keep('outlets', i)) return; const f = floorOf(t.location); const p = placeIn(f, 22, 22); state.nodes.push({ id: uid(), type: 'outlet', x: snap(p.x), y: snap(p.y), w: 22, h: 22, label: '', props: { location: t.location || '' } }); });
  d.deadlegs.forEach((t, i) => { if (!keep('deadlegs', i)) return; const f = floors[0]; const p = placeIn(f, 22, 22); state.nodes.push({ id: uid(), type: 'cap', x: snap(p.x), y: snap(p.y), w: 22, h: 22, label: 'DL' + (i + 1), props: { notes: t.length ? t.length + ' mm' : '' } }); });

  pendingDetected = null;
  commit(); fitView();
  toast('Assets placed — drag to reposition');
}

/* ============================================================
   BULK LABELS  — paste a list of room names, one per line
   ============================================================ */
function bulkNames() {
  return $('#bulkText').value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}
function updateBulkSummary() {
  const n = bulkNames().length;
  $('#bulkSummary').textContent = n ? `${n} label${n > 1 ? 's' : ''} ready` : '';
  $('#bulkPlace').disabled = !n;
}
function openBulkModal() { closeMenu(); $('#bulkModal').hidden = false; updateBulkSummary(); $('#bulkText').focus(); }
function closeBulkModal() { $('#bulkModal').hidden = true; }

function placeBulkLabels() {
  const names = bulkNames();
  if (!names.length) { toast('Paste at least one room name first'); return; }
  const size = Math.min(48, Math.max(8, +$('#bulkSize').value || 14));
  const wrap = Math.max(0, +$('#bulkWrap').value || 0);
  const cols = Math.min(12, Math.max(1, +$('#bulkCols').value || 3));
  const center = $('#bulkCenter').checked;
  const align = center ? 'center' : 'left';

  // Column width from the wrap setting (or a sensible default); row height from
  // the tallest label once wrapped, so nothing overlaps in the grid.
  const colW = (wrap || 160) + 40;
  let maxLines = 1;
  for (const name of names) maxLines = Math.max(maxLines, textLines({ text: name, size, wrap, align }).length);
  const rowH = maxLines * size * 1.3 + 34;

  const usedCols = Math.min(cols, names.length);
  const rows = Math.ceil(names.length / cols);
  const cssW = canvas.width / dpr, cssH = canvas.height / dpr;
  // Centre the whole block on the current view.
  const ox = snap(wx(cssW / 2) - (usedCols * colW) / 2);
  const oy = snap(wy(cssH / 2) - (rows * rowH) / 2);

  mutate(() => {
    names.forEach((name, i) => {
      const r = Math.floor(i / cols), c = i % cols;
      const x = snap(ox + c * colW);
      const y = snap(oy + r * rowH) + size;   // +size so the first-line baseline sits below the cell top
      state.texts.push({ id: uid(), x, y, text: name, size, wrap: wrap || 0, align });
    });
    select(null);
  });
  closeBulkModal();
  toast(`${names.length} label${names.length > 1 ? 's' : ''} added — drag to position`);
}

$('#btnBulkLabels').onclick = openBulkModal;
$('#bulkClose').onclick = $('#bulkCancel').onclick = closeBulkModal;
$('#bulkText').addEventListener('input', updateBulkSummary);
$('#bulkPlace').onclick = placeBulkLabels;
$('#bulkModal').addEventListener('click', e => { if (e.target === e.currentTarget) closeBulkModal(); });

/* ============================================================
   MENU SHEET
   ============================================================ */
function closeMenu() { $('#menuSheet').hidden = true; }
function openMenu() { closeImportModal(); $('#menuSheet').hidden = false; }
$('#btnMenu').onclick = openMenu;

/* ---------- Title block (Customer / Site / Date) ---------- */
function openTitleModal() {
  const m = state.meta || (state.meta = { customer: '', site: '', date: '' });
  $('#tbCustomer').value = m.customer || '';
  $('#tbSite').value = m.site || '';
  $('#tbDate').value = m.date || '';
  $('#titleModal').hidden = false;
  setTimeout(() => $('#tbCustomer').focus(), 30);
}
function closeTitleModal() { $('#titleModal').hidden = true; }
function saveTitleBlock() {
  mutate(() => {
    state.meta = {
      customer: $('#tbCustomer').value.trim(),
      site: $('#tbSite').value.trim(),
      date: $('#tbDate').value.trim(),
    };
  });
  closeTitleModal();
  toast('Title block updated');
}
$('#titleClose').onclick = closeTitleModal;
$('#titleCancel').onclick = closeTitleModal;
$('#titlePlace').onclick = saveTitleBlock;
$('#titleModal').addEventListener('click', e => { if (e.target === e.currentTarget) closeTitleModal(); });
const tbBtn = $('#tbOpen'); if (tbBtn) tbBtn.onclick = openTitleModal;

$('#menuSheet').addEventListener('click', e => {
  // Click on the dimmed backdrop (not the white sheet) closes the menu.
  if (e.target === e.currentTarget) { closeMenu(); return; }
  const btn = e.target.closest('button[data-act]'); if (!btn) return;
  const act = btn.dataset.act;
  closeMenu();
  if (act === 'saveas') saveProject(true);
  else if (act === 'titleblock') openTitleModal();
  else if (act === 'clear') { if (confirm('Clear everything on the canvas?')) mutate(() => { Object.assign(state, blankState(), { name: state.name }); select(null); }); }
  else if (act === 'sample') loadSample();
  else if (act === 'help') alert('FlowMark — quick guide\n\n• Pick an asset on the left, click the grid to drop it.\n• Pick a pipe type, click to start, click bends, click an asset to connect, double-click/Enter to finish.\n• Draw Areas for floors/rooms; drag the label tab to move them.\n• Select anything to edit its label, size, risk and notes on the right.\n• Import PDF reads a Legionella report and detects assets.\n• Export to PDF or JPG from the top bar.\n\nShortcuts: V select · H pan · P pipe · Z area · T label · R rotate pump · Arrow keys nudge (snaps to grid when Snap is on; Shift = 1 px fine) · Del delete · Ctrl/⌘+C copy · Ctrl/⌘+X cut · Ctrl/⌘+V paste (at cursor) · Ctrl/⌘+Z undo.');
  else if (act === 'about') alert('FlowMark\nWater system schematics for Legionella Risk Assessments.\nWorks offline once installed. Your projects stay on this device unless you save them to a file.');
  else if (act === 'install') triggerInstall();
});

/* ============================================================
   KEYBOARD
   ============================================================ */
let spaceDown = false;
window.addEventListener('keydown', e => {
  if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
  if (e.key === ' ') { spaceDown = true; canvas.style.cursor = 'grab'; }
  if (e.key === 'Enter' && draft) finishPipe();
  if (e.key === 'Escape') {
    if (!$('#menuSheet').hidden) { closeMenu(); return; }
    if (!$('#titleModal').hidden) { closeTitleModal(); return; }
    if (!$('#bulkModal').hidden) { closeBulkModal(); return; }
    if (!$('#importModal').hidden) { closeImportModal(); return; }
    if (draft) cancelDraft(); else select(null);
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && (sel || group.length)) { e.preventDefault(); deleteSelected(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') { e.preventDefault(); copySelection(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x') { e.preventDefault(); cutSelection(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') { e.preventDefault(); pasteClipboard(); }
  // Arrow keys nudge the selection. With grid-snap on, a plain arrow moves the
  // selection onto the next grid line (so it lands on the grid snap positions),
  // and Shift+arrow gives exact 1px precision. With snap off, plain arrow is 1px
  // and Shift+arrow steps a full grid cell. Skipped while drawing a pipe, and
  // while typing (handled by the INPUT/TEXTAREA/SELECT guard at the top).
  if (!e.ctrlKey && !e.metaKey && !e.altKey && !draft && (sel || group.length) &&
      (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    e.preventDefault();
    const dirX = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
    const dirY = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
    if (snapOn && !e.shiftKey) {
      nudgeSelection(dirX, dirY, true);
    } else {
      const step = (!snapOn && e.shiftKey) ? GRID : 1;
      nudgeSelection(dirX * step, dirY * step, false);
    }
    return;
  }
  if (!e.ctrlKey && !e.metaKey) {
    const k = e.key.toLowerCase();
    if (k === 'r' && sel && sel.kind === 'node') {
      const n = nodeById(sel.id);
      if (n && n.type === 'pump') { e.preventDefault(); rotateNode(n, 90); return; }
    }
    if (k === 'v') setTool('select'); else if (k === 'h') setTool('pan');
    else if (k === 'p') setTool('pipe', { pipe: pipeKind }); else if (k === 'z') setTool('zone');
    else if (k === 't') setTool('text');
  }
});
window.addEventListener('keyup', e => { if (e.key === ' ') { spaceDown = false; canvas.style.cursor = tool === 'pan' ? 'grab' : tool === 'select' ? 'default' : 'crosshair'; } });

function undo() { if (!undoStack.length) return; redoStack.push(JSON.stringify(state)); state = normalize(JSON.parse(undoStack.pop())); sel = null; renderInspector(); commit(); }
function redo() { if (!redoStack.length) return; undoStack.push(JSON.stringify(state)); state = normalize(JSON.parse(redoStack.pop())); sel = null; renderInspector(); commit(); }

/* ============================================================
   SAMPLE LAYOUT
   ============================================================ */
function loadSample() {
  snapshot();
  state = blankState(); state.name = 'Sample — single plant room'; fileHandle = null;
  const Z = (x, y, w, h, label, color) => { const z = { id: uid(), x, y, w, h, label, color }; state.zones.push(z); return z; };
  const N = (type, x, y, label, props = {}) => { const a = ASSETS[type]; const n = { id: uid(), type, x, y, w: a.w, h: a.h, label, props }; state.nodes.push(n); return n; };
  const P = (type, pts) => state.pipes.push({ id: uid(), type, pts });

  Z(180, 40, 760, 150, 'Ground Floor', ZONE_COLORS[0]);
  Z(180, 210, 760, 150, 'First Floor', ZONE_COLORS[1]);
  const tk1 = N('tank', 80, 110, 'TK1', { volume: 1500, risk: 'B', location: 'Plant room' });
  const pump = N('pump', 140, 110, 'P');
  const wh1 = N('heater', 280, 110, 'WH1', { volume: 240, risk: 'B' });
  const wh2 = N('heater', 420, 110, 'WH2', { volume: 90, risk: 'B' });
  const sh1 = N('shower', 760, 110, 'SH1', { risk: 'C' });
  const tmv1 = N('tmv', 620, 110, 'T1');
  const wh3 = N('heater', 300, 280, 'WH3', { volume: 50 });
  const cap = N('cap', 820, 280, 'DL1', { notes: '1500 mm' });

  P('coldMains', [{ x: 20, y: 110 }, { x: tk1.x - tk1.w / 2, y: 110, node: tk1.id }]);
  P('coldTank', [{ x: tk1.x, y: tk1.y, node: tk1.id }, { x: pump.x, y: pump.y, node: pump.id }]);
  P('coldTank', [{ x: pump.x, y: pump.y, node: pump.id }, { x: 280, y: 175 }, { x: wh1.x, y: wh1.y + 28, node: wh1.id }]);
  P('coldTank', [{ x: 280, y: 175 }, { x: 760, y: 175 }, { x: sh1.x, y: sh1.y + 18, node: sh1.id }]);
  P('hotFlow', [{ x: wh1.x, y: wh1.y - 28, node: wh1.id }, { x: wh1.x, y: 70 }, { x: 620, y: 70 }, { x: tmv1.x, y: tmv1.y - 14, node: tmv1.id }]);
  P('hotReturn', [{ x: 660, y: 110 }, { x: 660, y: 60 }, { x: wh1.x + 23, y: 60 }, { x: wh1.x + 23, y: wh1.y - 28, node: wh1.id }]);
  P('coldTank', [{ x: 300, y: 245 }, { x: 300, y: 280, node: wh3.id }]);
  P('deadleg', [{ x: 760, y: 280 }, { x: cap.x, y: cap.y, node: cap.id }]);

  sel = null; renderInspector(); commit(); fitView(); toast('Sample layout loaded');
}

/* ============================================================
   PWA INSTALL + SERVICE WORKER
   ============================================================ */
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredPrompt = e; $('#menuInstall').style.display = 'block'; });
function triggerInstall() { if (deferredPrompt) { deferredPrompt.prompt(); deferredPrompt = null; } else toast('Use your browser menu → Add to Home Screen / Install'); }
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => { }));

/* ============================================================
   INIT
   ============================================================ */
function init() {
  const restored = loadAutosave();
  resize();
  setTool('select');
  updateZoomLabel(); updateStatus();
  if (restored && (state.nodes.length || state.zones.length)) fitView();
  else { fitView(); }
  window.addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
}
init();
