/* ============================================================
   FlowMark — PDF report import
   Reads a Legionella risk assessment PDF, detects the assets it
   describes, lets the user review them, then lays them out on the
   A4 sheet grouped into floor areas.

   Loaded after app.js and uses its globals (state, ASSETS, snap,
   pageDims, FOOT_H, showFooter, ZONE_COLORS, snapshot, commit,
   fitView, toast, esc, loadScript, closeMenu, uid, $ / $$).

   The detection and layout code (FMImport) is pure — no DOM — so it
   can be exercised from Node for testing.
   ============================================================ */
'use strict';

const FMImport = (() => {

  /* ---------------- text → lines ----------------
     pdf.js returns loose text runs. Joining them with spaces (the old
     approach) destroys table structure, so we rebuild visual lines:
     runs sharing a baseline are one line, and a wide horizontal gap
     between runs becomes a " | " cell separator. */
  function itemsToLines(items, pageNo) {
    const its = items.filter(i => i.str && i.str.trim());
    its.sort((a, b) => b.y - a.y || a.x - b.x);
    const rows = [];
    for (const it of its) {
      const tol = Math.max(2, (it.h || 10) * 0.45);
      let row = null;
      for (let k = rows.length - 1; k >= Math.max(0, rows.length - 4); k--) if (Math.abs(rows[k].y - it.y) <= tol) { row = rows[k]; break; }
      if (!row) { row = { y: it.y, items: [] }; rows.push(row); }
      row.items.push(it);
    }
    const out = [];
    for (const r of rows) {
      r.items.sort((a, b) => a.x - b.x);
      let s = '', end = null; const xs = [];
      for (const it of r.items) {
        const em = Math.max(4, it.h || 10);
        if (end == null) xs.push(it.x);
        else {
          const gap = it.x - end;
          if (gap > em * 1.4) { s += ' | '; xs.push(it.x); }
          else if (gap > em * 0.12 && !/\s$/.test(s) && !/^\s/.test(it.str)) s += ' ';
        }
        s += it.str;
        end = it.x + (it.w || it.str.length * em * 0.5);
      }
      s = s.replace(/[ \t\u00a0]+/g, ' ').trim();
      // drop cells that ended up empty, keeping each cell's x position
      const parts = s.split(' | '), keep = [], kx = [];
      parts.forEach((p, i) => { if (p.trim()) { keep.push(p.trim()); kx.push(xs[i]); } });
      if (keep.length) out.push({ page: pageNo, text: keep.join(' | '), xs: kx });
    }
    return out;
  }

  /* Drop running headers/footers (same text on many pages) and page numbers. */
  function stripRepeats(lines) {
    const pages = new Set(lines.map(l => l.page)).size;
    if (pages < 3) return lines;
    const key = t => t.toLowerCase().replace(/\d+/g, '#');
    const seen = new Map();
    for (const l of lines) { const k = key(l.text); (seen.get(k) || seen.set(k, new Set()).get(k)).add(l.page); }
    return lines.filter(l => {
      if (/^(?:page\s*)?#?\d+(?:\s*(?:of|\/)\s*\d+)?$/i.test(l.text.trim())) return false;
      const n = seen.get(key(l.text)).size;
      return !(n >= 3 && n >= pages * 0.4);
    });
  }

  /* ---------------- vocabulary ---------------- */
  // Order matters: the first match classifies a line.
  const TYPES = [
    { type: 'deadleg', prefix: ['DL'], auto: 'DL', re: /\bdead[\s-]?legs?\b/i },
    { type: 'tank', prefix: ['TK', 'CWST', 'CWT'], auto: 'TK', re: /\b(?:cold water storage (?:tanks?|cisterns?)|CWSTs?|storage (?:tanks?|cisterns?)|break tanks?|header tanks?|water tanks?|cisterns?)\b/i, not: /\b(?:WC|toilet|urinal|flush(?:ing)?|closet|cistern) (?:cisterns?|flush(?:es)?|levers?)\b/i },
    { type: 'softener', prefix: ['WS'], auto: 'WS', re: /\b(?:water )?softeners?\b/i },
    { type: 'pump', prefix: ['BP'], auto: 'P', re: /\bbooster (?:pumps?|sets?)\b/i },
    { type: 'heater', prefix: ['WH', 'CAL', 'HWC'], auto: 'WH', re: /\b(?:calorifiers?|(?:hot )?water heaters?|(?:hot water|unvented|vented|indirect|direct) cylinders?|unvented units?|combi(?:nation)? boilers?|point[- ]of[- ]use (?:water )?heaters?|POU (?:water )?heaters?|under[- ]?sink (?:water )?heaters?|instantaneous (?:water )?heaters?|multi-?point (?:water )?heaters?)\b/i },
    { type: 'shower', prefix: ['SH'], auto: '', re: /\b(?:showers?|shower ?heads?|shower units?|shower valves?)\b/i, not: /\bshower ?(?:rooms?|trays?|curtains?|screens?|cubicles?|enclosures?)\b/i },
    { type: 'tmv', prefix: ['TMV'], auto: 'T', re: /\b(?:TMV ?[23]?s?|thermostatic mixing valves?|thermostatic mixers?|blending valves?)\b/i },
    { type: 'mixer', prefix: ['MX'], auto: 'M', re: /\b(?:mixer taps?|monobloc(?: mixers?| taps?)?|(?:basin|sink|bath) mixers?)\b/i },
    { type: 'outlet', prefix: [], auto: '', re: /\b(?:wash hand basins?|WHBs?|hand ?wash basins?|cleaner'?s?'? sinks?|sinks?|basins?|baths?|bib taps?|pillar taps?|taps?|drinking (?:water )?(?:fountains?|points?)|eye ?wash(?: stations?)?|hose ?reels?|spray taps?|outlets?)\b/i, not: /\b(?:sentinel outlets?|outlets? (?:temperatures?|temps?)|all outlets|outlets? (?:should|must|were|are))\b/i },
  ];
  const BY_TYPE = Object.fromEntries(TYPES.map(t => [t.type, t]));
  const PREFIX_TYPE = {};
  for (const t of TYPES) for (const p of t.prefix) PREFIX_TYPE[p] = t.type;
  const TAG_RE = new RegExp(`\\b(${Object.keys(PREFIX_TYPE).sort((a, b) => b.length - a.length).join('|')})\\s?[-.]?\\s?(\\d{1,3})\\b(?![.,]\\d)`, 'g');

  const CATEGORY = {
    tank: 'Cold water storage tanks', softener: 'Water softeners', pump: 'Booster pumps', heater: 'Water heaters',
    shower: 'Showers', tmv: 'TMVs', mixer: 'Mixer taps', outlet: 'Outlets', deadleg: 'Deadlegs',
  };
  const DESC = {
    tank: 'Storage tank', softener: 'Water softener', pump: 'Booster pump', heater: 'Water heater', shower: 'Shower',
    tmv: 'Thermostatic mixing valve', mixer: 'Mixer tap', outlet: 'Outlet', deadleg: 'Deadleg',
  };
  // Which FlowMark asset each detected type becomes.
  const NODE_TYPE = { tank: 'tank', softener: 'softener', pump: 'pump', heater: 'heater', shower: 'shower', tmv: 'tmv', mixer: 'mixer', outlet: 'outlet', deadleg: 'cap' };
  const ORDER = ['tank', 'softener', 'pump', 'heater', 'tmv', 'mixer', 'shower', 'outlet', 'deadleg'];
  const PLANT = new Set(['tank', 'softener', 'pump', 'heater']);

  /* ---------------- floors & locations ---------------- */
  const ORD = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };
  const ORD_NAME = ['Ground', 'First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth'];
  const FLOOR_RULES = [
    [/\b(?:roof(?:\s*(?:space|void|top|level))?|rooftop)\b/i, 'Roof', 100],
    [/\b(?:loft(?:\s*space)?|attic)\b/i, 'Loft', 99],
    [/\b(?:lower[\s-]ground(?:\s*floor)?|LGF)\b/i, 'Lower Ground Floor', -0.5],
    [/\b(?:upper[\s-]ground(?:\s*floor)?|UGF)\b/i, 'Upper Ground Floor', 0.5],
    [/\b(?:sub[\s-]?)?basement\b|\bcellar\b/i, 'Basement', -1],
    [/\bmezz(?:anine)?\b/i, 'Mezzanine', 0.6],
    [/\bground\s*(?:floor|flr|level)?\b(?!\s*(?:source|water|loop|works?))|\bG\/?F\b/i, 'Ground Floor', 0],
    [/\b(?:external(?:ly)?|outside|exterior|outbuildings?|yard)\b/i, 'External', -5],
  ];
  function floorOf(s) {
    if (!s) return null;
    let m = /\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+(?:floor|flr|level)\b/i.exec(s);
    if (m) { const n = ORD[m[1].toLowerCase()]; return { name: ORD_NAME[n] + ' Floor', level: n, match: m[0] }; }
    m = /\b(\d{1,2})(?:st|nd|rd|th)\s*(?:floor|flr)\b|\b(?:level|lvl|floor)\s*(\d{1,2})\b/i.exec(s);
    if (m) { const n = +(m[1] || m[2]); return { name: n === 0 ? 'Ground Floor' : (ORD_NAME[n] ? ORD_NAME[n] + ' Floor' : `Floor ${n}`), level: n, match: m[0] }; }
    for (const [re, name, level] of FLOOR_RULES) { m = re.exec(s); if (m) return { name, level, match: m[0] }; }
    return null;
  }
  const ROOM_RE = /\b(?:toilets?|WCs?|wash ?rooms?|kitchen(?:ette)?s?|changing|shower ?rooms?|bath ?rooms?|en[\s-]?suites?|offices?|plant ?rooms?|boiler ?rooms?|stores?|cleaner'?s?'?|corridors?|staff|gents|ladies|male|female|disabled|accessible|utility|laundry|canteen|tea ?points?|rest ?rooms?|rooms?\s*\d+\w?|flats?\s*\d+\w?|bedrooms?|lab(?:oratory)?|workshops?|reception|cupboard|riser|lobby|hall|classroom|ward|bay|unit\s*\d+)\b/i;
  const LABEL_STOP = /\s+(?:[A-Z][a-z]+(?:\s+[a-z]+){0,2}\s*\([^)]*\)|[A-Z][A-Za-z]+(?:\s+[A-Za-z]+){0,2})\s*:\s*.*$/;

  function cleanLoc(s) {
    if (!s) return null;
    s = s.replace(LABEL_STOP, '').replace(/^[\s:,\-–]+|[\s:,.\-–]+$/g, '').replace(/\s{2,}/g, ' ');
    if (!s || s.length < 2 || /^(?:n\/?a|none|nil|tbc|-+)$/i.test(s)) return null;
    return s.length > 60 ? s.slice(0, 57).trim() + '…' : s;
  }
  function locationFromLine(text, typeRe) {
    let m = /\b(?:location|room|area|position)\s*(?:\/\s*[a-z]+\s*)?[:\-–]\s*([^|]{2,80})/i.exec(text);
    if (m) { const v = cleanLoc(m[1]); if (v) return v; }
    const cells = text.split(' | ').map(c => c.trim()).filter(Boolean);
    if (cells.length > 1) {
      const loc = cells.filter(c => c.length <= 60 && (floorOf(c) || ROOM_RE.test(c)) && !(typeRe && typeRe.test(c) && !floorOf(c) && !ROOM_RE.test(c.replace(typeRe, ''))));
      if (loc.length) return cleanLoc(loc.slice(0, 2).join(', '));
      return null;
    }
    const f = floorOf(text);
    if (f) {
      // "… in the Ground Floor Gents WC" → take the floor phrase plus a couple of words after it
      const i = text.indexOf(f.match);
      const tail = text.slice(i).split(/[.;,(]|\s[-–]\s|\s+(?:is|was|has|with|which|serving|supplies|supplying|and)\b/i)[0];
      return cleanLoc(tail.split(/\s+/).slice(0, 6).join(' '));
    }
    return null;
  }
  function roomOf(loc, floor) {
    if (!loc) return '';
    let r = floor ? loc.replace(floor.match, '') : loc;
    return r.replace(/^[\s,\-–/]+|[\s,\-–/]+$/g, '').toLowerCase();
  }

  /* ---------------- counts ---------------- */
  const NUMWORD = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };
  const num = s => /^\d+$/.test(s) ? +s : NUMWORD[s.toLowerCase()];
  const NOUN = {
    tank: '(?:cold water storage (?:tanks?|cisterns?)|CWSTs?|storage (?:tanks?|cisterns?)|water tanks?|tanks?)',
    softener: '(?:water )?softeners?',
    heater: '(?:calorifiers?|water heaters?|hot water cylinders?|unvented cylinders?|cylinders?)',
    shower: '(?:showers?|shower heads?|shower units?)',
    tmv: '(?:TMV ?[23]?s?|thermostatic mixing valves?)',
    mixer: '(?:mixer taps?)',
    deadleg: '(?:dead[\\s-]?legs?)',
  };
  const NW = '(\\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)';
  function explicitCount(lines, type) {
    const noun = NOUN[type]; if (!noun) return null;
    const pats = [
      new RegExp(`\\b${NW}\\s*(?:x|no\\.?|nr\\.?|number of)?\\s*(?:[a-z-]+\\s){0,2}?${noun}\\b`, 'i'),
      new RegExp(`\\b(?:number|no\\.?|qty|quantity)\\s*(?:of)?\\s*${noun}\\s*(?:\\([^)]*\\))?\\s*[:|\\-–=]?\\s*${NW}\\b(?![.,]\\d|\\s*(?:°|deg|mm|l\\b|litre|%))`, 'i'),
      new RegExp(`^${noun}\\s*(?:\\([^)]*\\))?\\s*[:|\\-–=]\\s*${NW}\\b(?![.,]\\d|\\s*(?:°|deg|mm|l\\b|litre|%))`, 'i'),
      new RegExp(`\\b${noun}\\s+(\\d{1,3})\\s+of\\s+(\\d{1,3})\\b`, 'i'),
    ];
    const zero = [
      new RegExp(`\\b(?:there (?:are|were|is) no|no(?!\\.)(?!\\s+of\\b)|nil)\\s+(?:[a-z-]+\\s){0,2}?${noun}\\b`, 'i'),
      new RegExp(`\\b${noun}\\s*(?:\\([^)]*\\))?\\s*[:|\\-–]\\s*(?:none|nil|n\\/a|no|0)\\b(?![.,]?\\d)`, 'i'),
    ];
    const votes = new Map(); let zeroHit = null;
    for (const l of lines) {
      if (/\.{4,}/.test(l.text)) continue;               // contents page leaders
      for (const z of zero) if (z.test(l.text)) zeroHit = zeroHit || l.text;
      for (let k = 0; k < pats.length; k++) {
        const m = pats[k].exec(l.text); if (!m) continue;
        const n = k === 3 ? Math.max(+m[1], +m[2]) : num(m[1]);
        if (n && n < 200) { const v = votes.get(n) || { n, c: 0, src: l.text }; v.c++; votes.set(n, v); }
      }
    }
    if (votes.size) {
      const best = [...votes.values()].sort((a, b) => b.c - a.c || b.n - a.n)[0];
      return { n: best.n, src: best.src };
    }
    if (zeroHit) return { n: 0, src: zeroHit };
    return null;
  }

  /* ---------------- main detection ---------------- */
  function mentions(t, text) {
    return t.re.test(text) && !(t.not && !t.re.test(text.replace(new RegExp(t.not.source, 'gi'), ' ')));
  }
  function classify(text) {
    for (const t of TYPES) {
      if (!t.re.test(text)) continue;
      if (t.not && !t.re.test(text.replace(new RegExp(t.not.source, 'gi'), ' '))) continue;
      return t.type;
    }
    return null;
  }
  const isProse = t => !t.includes(' | ') && !/^[A-Za-z][A-Za-z /()]{1,40}:/.test(t) && t.split(/\s+/).length > 14;
  const volumeIn = t => { const m = /(\d{1,5})\s*(?:litres?|ltrs?|L)\b/i.exec(t) || /\b(?:volume|capacity)\b[^|\d]{0,24}(\d{1,5})\b(?![.,]\d)/i.exec(t); return m ? +m[1] : null; };
  const lengthIn = t => { const m = /(\d{2,5})\s*mm\b/i.exec(t) || /length[^|\d]{0,12}(\d{2,5})/i.exec(t); return m ? +m[1] : null; };

  /* Tables: remember the most recent header row on a page ("Asset ID | Type |
     Floor | Room | Volume") so the rows under it can be read by column. */
  const COLKEYS = [
    ['id', /^(?:asset\s*)?(?:id|ref(?:erence)?|tag|no\.?|number)$/i],
    ['type', /\b(?:asset\s*type|type|description|asset|outlet|item|equipment)\b/i],
    ['floor', /\b(?:floor|level|storey)\b/i],
    ['loc', /\b(?:location|room|area|position|building reference)\b/i],
    ['volume', /\b(?:volume|capacity|litres)\b/i],
    ['length', /\blength\b/i],
    ['qty', /\b(?:qty|quantity|count)\b/i],
  ];
  function colKey(c) { for (const [k, re] of COLKEYS) if (re.test(c)) return k; return null; }
  function annotate(lines) {
    let head = null;
    for (const l of lines) {
      const cells = l.text.split(' | ').map(c => c.trim());
      l.cells = cells;
      if (cells.length >= 2 && !/\d[.,]\d/.test(l.text)) {
        const keys = cells.map(colKey);
        if (keys.filter(Boolean).length >= 2 && !cells.some(c => c.length > 40)) { head = { page: l.page, keys, xs: l.xs }; continue; }
      }
      if (head && l.page - head.page <= 1 && cells.length >= 2 && cells.length <= head.keys.length) {
        // match each cell to the header column it sits under (cells can be blank)
        const f = {};
        cells.forEach((c, i) => {
          let col = i;
          if (l.xs && head.xs && l.xs.length === cells.length) {
            col = 0; for (let k = 0; k < head.xs.length; k++) if (l.xs[i] >= head.xs[k] - 8) col = k;
          }
          const key = head.keys[col]; if (key && !f[key]) f[key] = c;
        });
        l.fields = f;
      } else if (head && l.page !== head.page && cells.length < 2) head = null;
    }
  }
  function locOf(l, typeRe) {
    const f = l.fields;
    if (f && (f.floor || f.loc)) {
      const parts = [f.floor, f.loc].filter(v => v && !/^(?:n\/?a|-+)$/i.test(v));
      if (f.floor && f.loc && f.loc.toLowerCase().includes(f.floor.toLowerCase())) parts.shift();
      const v = cleanLoc(parts.join(', '));
      if (v) return v;
    }
    return locationFromLine(l.text, typeRe);
  }
  const numIn = s => { const m = /(\d{1,5})/.exec(s || ''); return m ? +m[1] : null; };

  function detect(rawLines) {
    const lines = stripRepeats(rawLines).map(l => ({ ...l }));
    annotate(lines);
    const items = [];

    /* 1. Tagged assets (WH1, TK2, SH3, TMV4…) — the most reliable signal.
       A tag that starts a line or a table cell ("TK1 | Cold water…", "Asset ID: WH1")
       is where the asset is defined; elsewhere it's just a reference to it.
       TMV2/TMV3 are also TMV *classes*, so those only count when defined. */
    const tags = new Map();
    lines.forEach((l, idx) => {
      TAG_RE.lastIndex = 0; let m;
      while ((m = TAG_RE.exec(l.text))) {
        const prefix = m[1].toUpperCase(), n = +m[2], tag = prefix + n;
        const before = l.text.slice(0, m.index);
        if (prefix === 'TMV' && (n === 2 || n === 3) && l.fields && l.fields.type && l.fields.type.includes(m[0]) && !(l.fields.id && l.fields.id.includes(m[0]))) continue;
        const defining = /(?:^|\|\s*|\b(?:asset\s*)?(?:id|ref(?:erence)?|tag|code|no\.?)\s*[:#.]?\s*)$/i.test(before);
        if (/\b(?:type|class|model|category|grade)\s*[:\-–]?\s*$/i.test(before)) continue;   // "Type: TMV3" is a class, not an ID
        if (prefix === 'TMV' && (n === 2 || n === 3) && !defining) continue;
        if (!tags.has(tag)) tags.set(tag, { tag, type: PREFIX_TYPE[prefix], refs: [], def: [] });
        const t = tags.get(tag); t.refs.push(idx); if (defining) t.def.push(idx);
      }
    });
    for (const [k, t] of tags) if (/^TMV[23]$/.test(k) && !t.def.length) tags.delete(k);
    const tagTypes = new Set();
    for (const t of tags.values()) {
      tagTypes.add(t.type);
      const first = t.def.length ? t.def : t.refs;
      let location = null, volume = null, length = null, src = lines[first[0]].text;
      // the tag's defining lines first, then its other mentions, then the lines just below (form-style registers)
      const near = [...first, ...t.refs.filter(i => !first.includes(i))];
      for (const i of first) for (let d = 1; d <= 3; d++) if (lines[i + d] && lines[i + d].page === lines[i].page) near.push(i + d);
      for (const i of near) {
        const l = lines[i], tx = l.text;
        // don't borrow details from a line that defines a different tag
        TAG_RE.lastIndex = 0; const other = [...tx.matchAll(TAG_RE)].some(mm => mm[1].toUpperCase() + (+mm[2]) !== t.tag && tags.has(mm[1].toUpperCase() + (+mm[2])));
        if (other && !t.refs.includes(i)) continue;
        if (!location) { location = locOf(l, BY_TYPE[t.type].re); if (location) src = tx; }
        if (volume == null && (t.type === 'heater' || t.type === 'tank' || t.type === 'softener')) volume = (l.fields && numIn(l.fields.volume)) || volumeIn(tx);
        if (length == null && t.type === 'deadleg') length = (l.fields && numIn(l.fields.length)) || lengthIn(tx);
      }
      items.push({ type: t.type, tag: t.tag, location, volume, length, conf: 'high', src });
    }

    /* 2. Register rows: short structured lines naming an asset type and a place. */
    const rec = new Map();   // key → {type, location, perPage: Map(page→count), src}
    const TYPE_FIELD = /^(?:asset|outlet|equipment|item)\s*(?:type|description)\s*[:|\-–]/i;
    lines.forEach((l, idx) => {
      const tx = l.text;
      if (isProse(tx) || /\.{4,}/.test(tx) || tx.length > 220) return;
      const type = (l.fields && l.fields.type && classify(l.fields.type)) || classify(tx); if (!type || tagTypes.has(type)) return;
      let location = locOf(l, BY_TYPE[type].re);
      let block = [tx];
      // form-style register: "Asset Type: Shower" with "Location: …" on the following lines
      if (TYPE_FIELD.test(tx)) {
        for (let d = 1; d <= 6; d++) {
          const n = lines[idx + d]; if (!n || n.page !== l.page || TYPE_FIELD.test(n.text)) break;
          block.push(n.text);
          if (!location && /\b(?:location|room|area|position)\b/i.test(n.text)) location = locationFromLine(n.text, null);
        }
      }
      if (!location) return;
      const btx = block.join(' | ');
      // a header row ("Asset type | Location | Floor") names no actual asset
      if (!TYPE_FIELD.test(tx) && tx.includes(' | ') && /\b(?:asset\s*type|description|location)\b/i.test(tx) && !floorOf(tx) && !/\d/.test(tx)) return;
      const qm = /\b(?:qty|quantity)\s*[:|]?\s*(\d{1,2})\b|\b(\d{1,2})\s*(?:x|no\.?|nr)\s/i.exec(btx);
      const q = Math.min(20, (l.fields && numIn(l.fields.qty)) || (qm ? Math.max(1, +(qm[1] || qm[2])) : 1));
      const key = type + '|' + location.toLowerCase();
      const r = rec.get(key) || rec.set(key, { type, location, perPage: new Map(), src: tx, volume: null, length: null }).get(key);
      r.perPage.set(l.page, (r.perPage.get(l.page) || 0) + q);
      if (r.volume == null) r.volume = (l.fields && numIn(l.fields.volume)) || volumeIn(btx);
      if (r.length == null) r.length = (l.fields && numIn(l.fields.length)) || lengthIn(btx);
    });
    const recCount = {};
    for (const r of rec.values()) {
      const n = Math.min(40, Math.max(...r.perPage.values()));   // same table repeated in another section → don't double up
      recCount[r.type] = (recCount[r.type] || 0) + n;
      for (let i = 0; i < n; i++) items.push({ type: r.type, tag: null, location: r.location, volume: r.volume, length: r.length, conf: 'high', src: r.src });
    }

    /* 3. Stated counts ("6 showers", "Number of TMVs: 4") and 4. bare mentions. */
    for (const t of TYPES) {
      const type = t.type;
      if (tagTypes.has(type)) continue;
      const have = recCount[type] || 0;
      const ec = explicitCount(lines, type);
      if (ec && ec.n === 0 && !have) continue;
      if (ec && ec.n > have) {
        for (let i = have; i < Math.min(ec.n, 60); i++) items.push({ type, tag: null, location: null, conf: have ? 'low' : 'med', src: ec.src, note: have ? 'Count stated in report; location not found' : 'Count stated in report' });
        continue;
      }
      if (have || type === 'outlet' || type === 'pump') continue;
      const mention = lines.find(l => !/\.{4,}/.test(l.text) && mentions(t, l.text));
      if (mention) items.push({ type, tag: null, location: null, conf: 'low', src: mention.text, note: 'Mentioned — quantity not stated' });
    }

    /* Floors, rooms, labels. */
    for (const it of items) {
      it.floor = floorOf(it.location);
      it.room = roomOf(it.location, it.floor);
      if (it.src && it.src.length > 160) it.src = it.src.slice(0, 157) + '…';
    }
    const used = new Set(items.filter(i => i.tag).map(i => i.tag));
    const nextNo = {};
    items.sort((a, b) => ORDER.indexOf(a.type) - ORDER.indexOf(b.type)
      || (a.tag && b.tag ? tagNum(a.tag) - tagNum(b.tag) : (a.tag ? -1 : b.tag ? 1 : 0)));
    for (const it of items) {
      if (it.tag) { it.label = BY_TYPE[it.type].auto === '' && it.type !== 'deadleg' ? '' : it.tag; continue; }
      const p = BY_TYPE[it.type].auto;
      if (!p) { it.label = ''; continue; }
      let n = nextNo[p] || 1; while (used.has(p + n)) n++;
      it.label = p + n; used.add(it.label); nextNo[p] = n + 1;
    }
    return { items, title: titleFields(lines), lineCount: lines.length };
  }
  const tagNum = t => +(/(\d+)$/.exec(t) || [0, 0])[1];

  /* ---------------- title block ---------------- */
  const POSTCODE = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/;
  function titleFields(lines) {
    const grab = (re, multi) => {
      for (let i = 0; i < lines.length; i++) {
        const m = re.exec(lines[i].text); if (!m) continue;
        let v = (m[1] || '').replace(/^[\s:|\-–]+/, '').split(' | ')[0].trim();
        const next = lines[i + 1] && lines[i + 1].page === lines[i].page ? lines[i + 1].text.split(' | ')[0].trim() : '';
        if (!v && next && !/:\s*$/.test(next)) v = next;
        else if (multi && v && !POSTCODE.test(v) && POSTCODE.test(next) && next.length < 60) v += ', ' + next;
        v = v.replace(/^[:\-–\s]+/, '').trim();
        if (v && v.length >= 2 && v.length < 120) return v;
      }
      return null;
    };
    const customer = grab(/^(?:client(?:\s*name)?|customer(?:\s*name)?|prepared for|company(?:\s*name)?)\s*[:|\-–]?\s*(.*)$/i);
    const site = grab(/^(?:site address|property address|premises address|address of (?:site|premises)|site location|site(?:\s*name)?|address)\s*[:|\-–]?\s*(.*)$/i, true);
    let date = grab(/^(?:date of (?:assessment|survey|inspection|site visit|visit)|assessment date|survey date|inspection date|date assessed|date of report|report date|date)\s*[:|\-–]?\s*(.*)$/i);
    if (date) date = normDate(date);
    return { customer, site, date };
  }
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  function normDate(s) {
    let m = /\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})\b/.exec(s);
    const pad = n => String(n).padStart(2, '0');
    if (m) return `${pad(m[1])}/${pad(m[2])}/${m[3].length === 2 ? '20' + m[3] : m[3]}`;
    m = /\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/.exec(s);
    if (m) { const mi = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()); if (mi >= 0) return `${pad(m[1])}/${pad(mi + 1)}/${m[3]}`; }
    m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(s);
    if (m) return `${m[3]}/${m[2]}/${m[1]}`;
    return null;
  }

  /* ---------------- layout ----------------
     One area per floor (only floors that actually hold assets), stacked
     with the highest level at the top, sized to their contents and kept
     inside the sheet above the title-block footer. Plant goes first in
     each area, then assets grouped by room. */
  function layout(items, o) {
    const G = o.grid || 20;
    const sn = v => Math.round(v / G) * G;
    const floors = new Map();
    for (const it of items) if (it.floor) floors.set(it.floor.name, it.floor.level);
    const UNK = 'Location not stated';
    const groups = new Map();
    for (const it of items) {
      let name = it.floor ? it.floor.name : (floors.size === 1 ? [...floors.keys()][0] : (floors.size ? UNK : ''));
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(it);
    }
    const levelOf = n => n === UNK ? -1000 : n === '' ? 0 : floors.get(n);
    const names = [...groups.keys()].sort((a, b) => levelOf(b) - levelOf(a));
    for (const n of names) groups.get(n).sort((a, b) => {
      const pa = PLANT.has(a.type) ? 0 : 1, pb = PLANT.has(b.type) ? 0 : 1;
      return pa - pb || (pa ? a.room.localeCompare(b.room) : 0) || ORDER.indexOf(a.type) - ORDER.indexOf(b.type) || tagNum(a.label || '') - tagNum(b.label || '');
    });

    const M = 40, X0 = o.x0 || 0;
    const left = X0 + M, right = X0 + o.pageW - M, top = M, bottom = o.pageH - o.footH - 20;
    const tries = [{ cw: 80, ch: 84, head: 40, gap: 20 }, { cw: 70, ch: 72, head: 36, gap: 16 }, { cw: 60, ch: 62, head: 32, gap: 12 }];
    let plan;
    for (const t of tries) {
      plan = planWith(t); if (plan.h <= bottom - top) break;
    }
    function planWith(t) {
      const innerW = right - left - 2 * 20;
      const cols = Math.max(1, Math.floor(innerW / t.cw));
      let y = 0, used = 0; const zs = [];
      for (const n of names) {
        const list = groups.get(n); let col = 0, row = 0; const pos = [];
        for (const it of list) {
          const a = o.assets[NODE_TYPE[it.type]];
          const span = Math.max(1, Math.ceil((a.w + 22) / t.cw));
          if (col + span > cols) { col = 0; row++; }
          pos.push({ it, col, row, span }); col += span; used = Math.max(used, col);
        }
        const rows = list.length ? row + 1 : 0;
        const h = t.head + rows * t.ch + 4;
        zs.push({ name: n, y, h, pos }); y += h + t.gap;
      }
      // Areas share one width, sized to the fullest floor plus a spare column for
      // pipework — not the full sheet, so the legend keeps a clear corner.
      const w = Math.min(right - left, 40 + Math.max(used + 1, 6) * t.cw);
      return { t, zs, h: y - t.gap, w };
    }
    const { t, zs, w: zoneW } = plan;
    const zones = [], nodes = [];
    zs.forEach((z, zi) => {
      const zy = top + z.y;
      if (z.name) zones.push({ label: z.name, x: left, y: zy, w: sn(zoneW), h: sn(z.h), color: o.colors[zi % o.colors.length] });
      for (const p of z.pos) {
        const it = p.it, type = NODE_TYPE[it.type], a = o.assets[type];
        const cx = left + 20 + (p.col + p.span / 2) * t.cw;
        const cy = zy + t.head + p.row * t.ch + t.ch / 2 - 8;
        const props = {};
        if (it.location) props.location = it.location;
        if (it.volume) props.volume = String(it.volume);
        if (it.type === 'deadleg' && it.length) props.notes = it.length + ' mm';
        nodes.push({ type, x: sn(cx), y: sn(cy), w: a.w, h: a.h, label: it.label || '', props });
      }
    });
    return { zones, nodes, overflow: plan.h > bottom - top };
  }

  return { itemsToLines, stripRepeats, detect, layout, floorOf, normDate, CATEGORY, DESC, ORDER };
})();
if (typeof module !== 'undefined') module.exports = FMImport;

/* ============================================================
   Browser wiring: read PDF → review modal → place on canvas
   ============================================================ */
if (typeof document !== 'undefined') {
  let pdfjsLoading;
  window.ensurePdfJs = async function ensurePdfJs() {
    if (window.pdfjsLib) return window.pdfjsLib;
    pdfjsLoading ||= loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
    await pdfjsLoading;
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    return window.pdfjsLib;
  };

  async function pdfLines(buf) {
    const pdfjs = await ensurePdfJs();
    const pdf = await pdfjs.getDocument({ data: buf }).promise;
    const lines = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      const items = tc.items.map(it => ({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width, h: it.height || Math.hypot(it.transform[2], it.transform[3]) }));
      lines.push(...FMImport.itemsToLines(items, i));
    }
    return lines;
  }

  let pendingImport = null;   // { result, lines }

  $('#btnImport').onclick = () => $('#filePdf').click();
  $('#filePdf').onchange = async e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    toast('Reading PDF…', 4000);
    let lines;
    try { lines = await pdfLines(await f.arrayBuffer()); }
    catch (err) { console.error(err); toast('Could not read that PDF (needs a connection the first time)'); return; }
    if (!lines.length) { toast('That PDF has no readable text — it may be a scan. Draw manually instead.', 3600); return; }
    openImportModal(FMImport.detect(lines), lines);
  };

  window.openImportModal = function openImportModal(result, lines) {
    const { items, title } = result;
    const titleRows = [['customer', 'Customer'], ['site', 'Site address'], ['date', 'Date']].filter(([k]) => title[k]);
    if (!items.length && !titleRows.length) {
      toast('No assets recognised in that PDF — draw manually or try another report.', 3200);
      return;
    }
    pendingImport = { result, lines };
    let h = `<div class="import-note">Read from the report's asset register and text. Asset IDs (WH1, TK1, SH3…) are matched first, then register rows, then stated counts. Rows marked <b>check</b> are guesses and start unticked. Hover a row to see the report line it came from.</div>`;

    if (titleRows.length) {
      h += `<div class="det-group">Title block</div>`;
      for (const [k, name] of titleRows) {
        const cur = (state.meta && state.meta[k]) || '';
        h += `<label class="det-row"><input type="checkbox" data-title="${k}" ${cur ? '' : 'checked'}><span class="tag">${name}</span><span class="desc">${esc(title[k])}</span>${cur ? `<span class="loc">replaces “${esc(cur)}”</span>` : ''}</label>`;
      }
    }

    const byType = {};
    items.forEach((it, i) => (byType[it.type] ||= []).push([it, i]));
    for (const type of FMImport.ORDER) {
      const list = byType[type]; if (!list) continue;
      const allOn = list.every(([it]) => it.conf !== 'low');
      h += `<div class="det-group"><label><input type="checkbox" class="det-all" data-type="${type}" ${allOn ? 'checked' : ''}>${FMImport.CATEGORY[type]} <span class="det-n">${list.length}</span></label></div>`;
      for (const [it, i] of list) {
        const low = it.conf === 'low';
        const where = it.location || (it.note ? '' : 'Location not found');
        h += `<label class="det-row${low ? ' low' : ''}" title="${esc('From the report: ' + (it.src || ''))}">`
          + `<input type="checkbox" data-idx="${i}" data-type="${type}" ${low ? '' : 'checked'}>`
          + `<span class="tag">${esc(it.label || '•')}</span>`
          + `<span class="desc">${esc(it.volume ? it.volume + ' litres' : it.type === 'deadleg' && it.length ? it.length + ' mm deadleg' : FMImport.DESC[type])}${low ? ' <em class="chk">check</em>' : ''}</span>`
          + `<span class="loc">${esc(it.note || where)}</span></label>`;
      }
    }
    const floors = [...new Set(items.filter(i => i.floor).map(i => i.floor.name))];
    if (floors.length) h += `<div class="det-group">Areas to create</div><div class="import-note" style="margin-top:0">${floors.map(esc).join(' · ')}${items.some(i => !i.floor) && floors.length > 1 ? ' · Location not stated' : ''}</div>`;

    $('#importBody').innerHTML = h;
    $$('#importBody .det-all').forEach(all => all.onchange = () => {
      $$(`#importBody input[data-idx][data-type="${all.dataset.type}"]`).forEach(cb => cb.checked = all.checked);
      updateImportSummary();
    });
    $$('#importBody input[data-idx]').forEach(cb => cb.onchange = () => {
      const all = $(`#importBody .det-all[data-type="${cb.dataset.type}"]`);
      const sib = $$(`#importBody input[data-idx][data-type="${cb.dataset.type}"]`);
      all.checked = sib.every(s => s.checked); all.indeterminate = !all.checked && sib.some(s => s.checked);
      updateImportSummary();
    });
    $$('#importBody .det-all').forEach(all => { const sib = $$(`#importBody input[data-idx][data-type="${all.dataset.type}"]`); all.indeterminate = !all.checked && sib.some(s => s.checked); });
    updateImportSummary();
    closeMenu();
    $('#toast').hidden = true;
    $('#importModal').hidden = false;
  };
  function updateImportSummary() {
    const n = $$('#importBody input[data-idx]').length, on = $$('#importBody input[data-idx]:checked').length;
    $('#importSummary').textContent = `${on} of ${n} assets selected`;
  }

  window.closeImportModal = function closeImportModal() { $('#importModal').hidden = true; pendingImport = null; };
  $('#importClose').onclick = $('#importCancel').onclick = closeImportModal;
  $('#importPlace').onclick = () => { placeImported(); closeImportModal(); };
  $('#importModal').addEventListener('click', e => { if (e.target === e.currentTarget) closeImportModal(); });
  $('#importCopy').onclick = async () => {
    if (!pendingImport) return;
    const txt = pendingImport.lines.map(l => `[p${l.page}] ${l.text}`).join('\n');
    try { await navigator.clipboard.writeText(txt); toast('Report text copied — paste it to help tune detection'); }
    catch (e) { toast('Could not copy to the clipboard'); }
  };

  function placeImported() {
    if (!pendingImport) return;
    const { result } = pendingImport;
    const picked = $$('#importBody input[data-idx]:checked').map(cb => result.items[+cb.dataset.idx]);
    const titleKeys = $$('#importBody input[data-title]:checked').map(cb => cb.dataset.title);
    if (!picked.length && !titleKeys.length) return;
    snapshot();
    for (const k of titleKeys) { state.meta ||= {}; state.meta[k] = result.title[k]; }

    // Lay out on the sheet; if the sheet already has content, build beside it instead of on top of it.
    const d = pageDims();
    const busy = state.nodes.length || state.zones.length || state.pipes.length || state.shapes.length || state.texts.length;
    const L = FMImport.layout(picked, {
      pageW: d.w, pageH: d.h, footH: showFooter ? FOOT_H : 0, grid: GRID,
      x0: busy ? d.w + 80 : 0, assets: ASSETS, colors: ZONE_COLORS,
    });
    for (const z of L.zones) state.zones.push({ id: uid(), ...z });
    for (const n of L.nodes) state.nodes.push({ id: uid(), ...n });
    commit(); fitView();
    const msg = !picked.length ? 'Title block updated'
      : busy ? 'Placed beside the sheet (it already had content) — drag into place'
      : L.overflow ? 'Placed — too many to fit the sheet, so areas run below it. Try portrait, or trim the list.'
      : 'Assets placed by floor — drag to reposition and add pipework';
    toast(msg, 3400);
  }
}
