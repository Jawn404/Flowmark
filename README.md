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
- **Define zones** for floors and workspaces (Ground / 1st / 2nd floor,
  workshop, office, plant room, etc.).
- **Inspect & label** every asset — tag, volume, size, location, risk rating
  (A–E) and notes — via the side panel.
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
| `Del` | Delete selected |
| `Ctrl/⌘ + Z` | Undo |
| `Ctrl/⌘ + Shift + Z` | Redo |

---

Built as a practical tool — adjust the asset list or line styles in `app.js`
to match your own drawing conventions.
