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
  tank:   { w: 84, h: 54, name: 'Cold water storage tank', tag: 'TK', fields: ['volume', 'risk'] },
  heater: { w: 46, h: 56, name: 'Water heater / calorifier', tag: 'WH', fields: ['volume', 'risk'] },
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
  return { name: 'Untitled schematic', page: { orientation: 'landscape' }, zones: [], nodes: [], pipes: [], texts: [] };
}
let view = { scale: 1, ox: 0, oy: 0 };
let tool = 'select';
let pipeKind = 'coldMains';
let assetKind = 'tank';
let sel = null;               // {kind:'node'|'pipe'|'zone'|'text', id}  — single selection (drives inspector)
let group = [];               // multi-selection: array of {kind,id}. When >1, sel is null.
let draft = null;             // pipe being drawn
let ortho = true;             // right-angle pipe mode
let showGrid = true, snapOn = true, showLegend = true;
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
  drawScene(ctx, view, { legend: showLegend, legendFrame: { x: 0, y: 0, w: cssW, h: cssH }, legendMargin: 14 });
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
      c.font = `700 ${Math.max(11, 13 * Math.min(S, 1.4))}px var(--sans,system-ui)`;
      const lw = c.measureText(z.label).width + 16;
      c.fillStyle = '#475569'; c.globalAlpha = .9;
      c.fillRect(x, y, lw, 20); c.globalAlpha = 1;
      c.fillStyle = '#fff'; c.textAlign = 'left'; c.textBaseline = 'middle';
      c.fillText(z.label, x + 8, y + 11);
    }
  }
  // pipes
  for (const p of state.pipes) drawPipe(c, p, S, OX, OY);
  // nodes
  for (const n of state.nodes) drawNode(c, n, S, OX, OY);
  // texts (multi-line + optional word-wrap)
  for (const t of state.texts) drawText(c, t, S, X, Y);
  if (opts.legend) {
    const frame = opts.legendFrame || { x: 0, y: 0, w: 0, h: 0 };
    const [lx, ly] = placeLegend(c, T, frame, opts.legendMargin ?? 14, opts.legendExtra || []);
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
    if (wpt.x >= z.x && wpt.x <= z.x + 120 && wpt.y >= z.y && wpt.y <= z.y + 20 / view.scale) return z;
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
  if (p) { select({ kind: 'pipe', id: p.id }); snapshot(); drag = { mode: 'pipe', pipe: p, last: w }; return; }
  const t = hitText(w);
  if (t) { select({ kind: 'text', id: t.id }); snapshot(); drag = { mode: 'text', text: t, dx: w.x - t.x, dy: w.y - t.y }; return; }
  const z = hitZoneLabel(w);
  if (z) { select({ kind: 'zone', id: z.id }); snapshot(); drag = { mode: 'zone', zone: z, last: w }; return; }
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
    const dx = w.x - drag.last.x, dy = w.y - drag.last.y;
    for (const pt of drag.pipe.pts) if (!pt.node) { pt.x = snap(pt.x + dx); pt.y = snap(pt.y + dy); }
    drag.last = w; dirty = true; draw(); return;
  }
  if (drag.mode === 'zone') {
    const dx = w.x - drag.last.x, dy = w.y - drag.last.y;
    drag.zone.x = snap(drag.zone.x + dx); drag.zone.y = snap(drag.zone.y + dy);
    drag.last = w; dirty = true; draw(); return;
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
function normalize(s) { s.zones ||= []; s.nodes ||= []; s.pipes ||= []; s.texts ||= []; s.page ||= { orientation: 'landscape' }; if (s.page.orientation !== 'portrait') s.page.orientation = 'landscape'; s.name ||= 'Untitled schematic'; for (const n of s.nodes) n.props ||= {}; return s; }

$('#btnSave').onclick = () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  download(blob, (state.name || 'schematic').replace(/[^\w\-]+/g, '_') + '.flowmark.json');
  dirty = false; updateStatus(); toast('Project saved to file');
};
$('#btnOpen').onclick = () => $('#fileOpen').click();
$('#fileOpen').onchange = e => {
  const f = e.target.files[0]; if (!f) return;
  const rd = new FileReader();
  rd.onload = () => { try { state = normalize(JSON.parse(rd.result)); sel = null; renderInspector(); fitView(); updateStatus(); dirty = false; toast('Project opened'); } catch (err) { toast('That file could not be read'); } };
  rd.readAsText(f); e.target.value = '';
};
$('#btnNew').onclick = () => { if (dirty && !confirm('Start a new schematic? Unsaved changes will be lost.')) return; state = blankState(); sel = null; renderInspector(); dirty = false; updateStatus(); fitView(); };

$('#projectName').onclick = () => { const v = prompt('Project name:', state.name); if (v != null) { state.name = v.trim() || 'Untitled schematic'; dirty = true; updateStatus(); } };

function download(blob, name) { const u = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = u; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(u), 1500); }

/* ============================================================
   EXPORT  (JPG + PDF)
   ============================================================ */
function renderExportCanvas(ss = 2.5, compose = 1) {
  // ss      = supersample factor — output resolution / crispness only.
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
  // Footer caption text + its on-sheet footprint (in compose units) so legend
  // placement treats the caption as an obstacle and never lands on top of it.
  const footText = `${state.name}   ·   ${new Date().toLocaleDateString('en-GB')}`;
  const footFs = 13 * (ss / 2.5);                       // device px
  cx.font = `${footFs}px system-ui`;
  const footW = cx.measureText(footText).width;         // device px (unaffected by transform)
  const footRect = {
    x: (c.width - 16 - footW) / ss, y: (c.height - 8 - footFs * 1.25) / ss,
    w: (footW + 16) / ss, h: (footFs * 1.6) / ss,
  };
  // scene (composed at 100% => WYSIWYG label sizing). Anything off the sheet is
  // naturally clipped by the canvas bounds, matching what the page boundary shows.
  // The legend auto-places to a clear corner of the sheet, avoiding both the
  // schematic geometry and the footer caption below.
  drawScene(cx, T, { legend: showLegend, legendFrame: { x: 0, y: 0, w: cw, h: ch }, legendMargin: 16, legendExtra: [footRect] });
  // footer caption — drawn in raw device px so it stays a small, fixed-size caption
  cx.setTransform(1, 0, 0, 1, 0, 0);
  cx.fillStyle = '#475569'; cx.font = `${footFs}px system-ui`; cx.textAlign = 'right'; cx.textBaseline = 'bottom';
  cx.fillText(footText, c.width - 16, c.height - 8);
  return { canvas: c, bounds: b };
}

$('#btnExportImg').onclick = () => {
  const r = renderExportCanvas(2.5); if (!r) return;
  r.canvas.toBlob(b => { download(b, (state.name || 'schematic').replace(/[^\w\-]+/g, '_') + '.jpg'); toast('JPG exported'); }, 'image/jpeg', 0.92);
};

let jspdfLoading;
async function ensureJsPDF() {
  if (window.jspdf) return window.jspdf.jsPDF;
  jspdfLoading ||= loadScript('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
  await jspdfLoading; return window.jspdf.jsPDF;
}
$('#btnExportPdf').onclick = async () => {
  const r = renderExportCanvas(2.5); if (!r) return;
  toast('Building PDF…', 1500);
  try {
    const jsPDF = await ensureJsPDF();
    const landscape = pageDims().w >= pageDims().h;
    const pdf = new jsPDF({ orientation: landscape ? 'l' : 'p', unit: 'mm', format: 'a4' });
    const pw = pdf.internal.pageSize.getWidth(), ph = pdf.internal.pageSize.getHeight();
    const margin = 8;
    const aw = pw - margin * 2, ah = ph - margin * 2;
    const ratio = Math.min(aw / r.canvas.width, ah / r.canvas.height);
    const w = r.canvas.width * ratio, h = r.canvas.height * ratio;
    const img = r.canvas.toDataURL('image/jpeg', 0.92);
    pdf.addImage(img, 'JPEG', (pw - w) / 2, (ph - h) / 2, w, h);
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
$('#menuSheet').addEventListener('click', e => {
  // Click on the dimmed backdrop (not the white sheet) closes the menu.
  if (e.target === e.currentTarget) { closeMenu(); return; }
  const btn = e.target.closest('button[data-act]'); if (!btn) return;
  const act = btn.dataset.act;
  closeMenu();
  if (act === 'clear') { if (confirm('Clear everything on the canvas?')) mutate(() => { Object.assign(state, blankState(), { name: state.name }); select(null); }); }
  else if (act === 'sample') loadSample();
  else if (act === 'help') alert('FlowMark — quick guide\n\n• Pick an asset on the left, click the grid to drop it.\n• Pick a pipe type, click to start, click bends, click an asset to connect, double-click/Enter to finish.\n• Draw Areas for floors/rooms; drag the label tab to move them.\n• Select anything to edit its label, size, risk and notes on the right.\n• Import PDF reads a Legionella report and detects assets.\n• Export to PDF or JPG from the top bar.\n\nShortcuts: V select · H pan · P pipe · Z area · T label · R rotate pump · Del delete · Ctrl/⌘+C copy · Ctrl/⌘+X cut · Ctrl/⌘+V paste (at cursor) · Ctrl/⌘+Z undo.');
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
  state = blankState(); state.name = 'Sample — single plant room';
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
