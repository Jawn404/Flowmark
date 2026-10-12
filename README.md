# FlowMark

A lightweight, installable **Progressive Web App** for drawing water-system
schematics for **Legionella Risk Assessments**. Runs entirely in the browser,
works offline once loaded, and installs to the home screen / desktop on any
device (phone, tablet, laptop).

No build step, no server, no accounts — it's plain HTML, CSS and JavaScript.

---

## What it does

- **Place pre-made assets** that snap to a grid: cold water storage tanks,
  water heaters (small / medium / large), mixer taps, TMVs, showers, pumps,
  outlets and capped dead-leg ends.
- **Draw pipework** between assets as connecting lines, with five engineering
  line styles:
  - Cold – mains (solid blue)
  - Cold – tank fed (dashed blue)
  - Hot – flow (solid red)
  - Hot – return (dashed red)
  - Dead-leg (dash-dot amber, with an end-cap marker)
- **Continue an existing run** — with a pipe tool selected, hover over the open
  end of a run of the same type (it highlights with a ring) and click it to
  carry on drawing from there. The new legs join the original run, so it stays
  one pipe with one set of properties. Or select any pipe and use *Continue run
  → From start / From end* in the side panel (this also works from an end
  that's connected to an asset), or press `C` to continue from the selected
  run's end — from its start if the first point is the active one. Bends,
  curves, asset connections and double-click / Enter to finish all work as
  normal; Esc abandons the extension, and one Undo removes it.
- **Cap off any pipe run** — select a pipe and set *Capped end* to Start, End or
  Both. The blanking bar is drawn in the pipe's own colour, so a capped hot leg
  still reads as hot and a capped cold leg as cold. Deadlegs are capped at the
  far end by default (set them to *None* to remove it). The *Cap* asset also
  works: end a pipe on it and it lines up with the run and takes its colour;
  on its own it can be rotated (`R` or the inspector).
- **Show flow direction** — select a pipe and set *Flow direction* to
  *Forward* (from where the run was started to where it ends) or *Reverse*.
  Small chevrons in the pipe's colour are spaced evenly along the run, follow
  curves, and appear in PDF/JPG exports.
- **Crossover bridges** — where two pipe runs cross, the run drawn later hops
  over the earlier one with a small semicircular bridge, so each run can be
  followed straight through the crossing. Bridges stand up on horizontal runs
  and lean left on vertical ones, follow curves, stay solid on dashed runs, and
  merge into one wider hop over tight bundles. Tees (a run ending on another)
  and runs meeting at an asset are junctions, not crossings, so get no bridge.
  Toggle them with *Bridges* in the view bar; they appear in PDF/JPG exports.
- **Curve pipe runs** — while drawing, press, hold and drag instead of
  clicking: the cursor sets the corner the pipe bends round (snaps to the grid,
  so quarter bends are easy). Curves can end on an asset too. Select a pipe and
  drag its round handle to reshape a curve, or use *Straighten curves*.
- **Draw simple shapes** — rectangles and ellipses (Shift for square / circle)
  with adjustable line colour, fill, weight and dashed/solid style.
- **Define zones** for floors and workspaces (Ground / 1st / 2nd floor,
  workshop, office, plant room, etc.).
- **Inspect & label** every asset — tag, volume, size, location, risk rating
  (A–E) and notes — via the side panel.
- **Format text labels** — select a label and use the *Format* buttons for
  **bold**, *italic*, underline and strikethrough (or Ctrl/⌘+B / I / U,
  Ctrl/⌘+Shift+X), align left / centre / right, pick a text colour, and add a
  highlight box so labels stay readable over pipework. Select several labels
  to format them all at once.
- **Export** the finished schematic to **PDF** (A4 landscape) or **JPG**.
- **Import a Legionella report PDF** and have it suggest the on-site assets it
  finds, which you review and place on the canvas, then reposition freely.
- **Autosaves** to the browser and can save/open `.flowmark.json` project files.

### A note on PDF import

The importer (`pdf-import.js`) rebuilds the report's lines and table columns
from the PDF text, then detects assets in order of reliability:

1. **Asset IDs** — `TK1`, `CWST1`, `WH1`, `CAL1`, `SH3`, `TMV4`, `WS1`, `DL1`…
   (TMV2/TMV3 are treated as valve classes unless they start a row or cell).
2. **Register rows** — table rows or `Asset Type: … / Location: …` blocks that
   name an asset type and a place. Tables repeated in another section aren't
   double-counted.
   Ara's own layout is read directly: the key/value asset forms
   (`Location | Roof Void`, `Designation / asset no. | CWST1`, volume, risk)
   and the outlet survey table, where each room's outlets are listed as
   `1 x M`, `1 x Shwr`, `1 x C`, `1 x Dishwasher` (WCs aren't drawn).
3. **Stated counts** — "6 showers", "Number of TMVs: 4", "No showers on site".
4. **Bare mentions** — one row, unticked, marked *check*.

Floors are read from each asset's location (Roof, Loft, Second–Ground Floor,
Mezzanine, Basement, External…) and only floors that hold assets become areas,
stacked highest first and fitted inside the sheet above the title block.
Within each floor, assets are grouped by the room they were found in (plant
rooms first, then A–Z) and each group gets the room name as a label above it,
so every asset arrives paired with its room. Untick *Room labels* in the review
list to place them without. The
customer, site address and assessment date are offered for the title block.
Hover a row in the review list to see the report line it came from; **Copy
report text** copies what was read, which helps tune detection for a new
report layout. Scanned/image-only PDFs (no embedded text) won't yield results.

---

## Running locally

Because service workers need a real origin, open it through a tiny local
server rather than double-clicking the file:

```bash
# Python (any version 3.x)
cd flowmark
python3 -m http.server 8000
# then visit http://localhost:8000
```

PDF export and PDF import pull two small libraries (jsPDF and pdf.js) from a CDN
the first time you use them online; after that the service worker caches them so
both work offline.

---

## Deploy to GitHub + Cloudflare Pages

### 1. Put the files in a GitHub repo

```bash
cd flowmark
git init
git add .
git commit -m "FlowMark PWA"
git branch -M main
git remote add origin https://github.com/<your-username>/flowmark.git
git push -u origin main
```

(Or use **Add file → Upload files** in the GitHub web UI and drag the whole
folder in.)

### 2. Connect it to Cloudflare Pages

1. In the Cloudflare dashboard go to **Workers & Pages → Create → Pages →
   Connect to Git**.
2. Pick your `flowmark` repository.
3. Build settings:
   - **Framework preset:** *None*
   - **Build command:** *(leave blank)*
   - **Build output directory:** `/`  (the files are already static)
4. **Save and Deploy.**

Cloudflare gives you a `https://flowmark-xxxx.pages.dev` URL. Open it on any
device and use the browser's **Install app / Add to Home Screen** option to
install FlowMark. Every push to `main` redeploys automatically.

> If you ever change files and the app looks stale, bump the cache name in
> `sw.js` (e.g. `flowmark-v1` → `flowmark-v2`) so the service worker refreshes.

---

## Files

| File | Purpose |
|------|---------|
| `index.html` | App shell and layout |
| `styles.css` | Design system and responsive layout |
| `app.js` | Editor: canvas, tools, assets, pipes, export |
| `pdf-import.js` | Report import: PDF text → asset detection → review list → floor-by-floor layout |
| `pipe-continue.js` | Continue an existing pipe run (loads after `app.js` and hooks its pipe-drawing functions) |
| `manifest.webmanifest` | PWA metadata (name, icons, colours) |
| `sw.js` | Service worker for offline caching |
| `icons/` | App icons |

---

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `V` | Select / move |
| `H` | Pan |
| `P` | Pipe |
| `Z` | Zone |
| `T` | Text |
| `R` | Rectangle (rotates a selected pump or free-standing cap instead) |
| `E` | Ellipse |
| `C` | Continue the selected pipe run (from its end, or its start if that point is active) |
| `Del` | Delete selected (with a pipe point clicked: delete just that point) |
| `Ctrl/⌘ + Z` | Undo |
| `Ctrl/⌘ + Shift + Z` | Redo |

---

Built as a practical tool — adjust the asset list or line styles in `app.js`
to match your own drawing conventions.
