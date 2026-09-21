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

The importer reads the **text** of a report and matches it against the patterns
used in typical Legionella assessments (tanks, water heaters, TMVs, showers,
outlets, dead-legs). It is a **best-effort heuristic, not OCR or AI** — it
shows everything it found in a review list so you can tick/untick before
anything is placed, and it will sometimes over- or under-count. Treat it as a
head-start, then adjust by hand. Scanned/image-only PDFs (no embedded text)
won't yield results.

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
| `app.js` | Editor: canvas, tools, assets, pipes, export, PDF import |
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
| `Del` | Delete selected |
| `Ctrl/⌘ + Z` | Undo |
| `Ctrl/⌘ + Shift + Z` | Redo |

---

Built as a practical tool — adjust the asset list or line styles in `app.js`
to match your own drawing conventions.
