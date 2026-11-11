# Quilt Planner

A phone-friendly web app (installable PWA, works offline) for planning English paper piecing quilts:
try solid colours or photographed fabrics on each shape of your pattern and compare options before cutting.

## How it works
1. **New pattern** – pick a photo/screenshot or a PDF page of one block (or the whole quilt).
   Closed areas between the printed lines are detected automatically as shapes.
2. **Select shapes** – tap shapes, or use *Same shape* / *Same pattern colour* / *Same fabric* / *Unassigned*.
3. **Pick a fabric** – 🎨 colour (palette + wheel), 📷 take a photo of a fabric, or 🖼 choose one from the gallery.
   Tap a fabric to apply it to the selected shapes.
4. **Adjust** – rotate the fabric inside the selected shapes, slide it (✥ drag mode) for fussy cutting,
   and set the size of the *whole fabric* (one scale per fabric; optionally in real cm after entering the pattern width).
5. **Options** – make several variants (＋ New option / ⧉ Copy this) and use ⧉ in the top bar to compare them side by side.
   Undo (↶) and "save picture" (⋯ menu) are available.

Everything is stored locally on the device (IndexedDB); no account, no server.

## Run / install on Android
Needs to be served over HTTPS for "Add to Home screen" and offline mode.
- **GitHub Pages**: in the repo go to *Settings → Pages → Source: GitHub Actions*, merge to `main`
  (the workflow in `.github/workflows/pages.yml` deploys it). Open the URL in Chrome on the phone →
  menu → *Install app / Add to Home screen*.
- **Locally**: `python3 -m http.server 8000` and open `http://localhost:8000`
  (camera/PWA install need HTTPS or localhost).

No build step. PDF support uses a vendored copy of pdf.js (`vendor/`, Apache-2.0).
