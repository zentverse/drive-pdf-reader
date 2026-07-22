# drive-pdf-reader

Rebuilds a local PDF from a Google Drive document you can **view but not download**.

Give it a Drive link, it reconstructs the document page by page from Drive's own renderer
and hands you a PDF — either through a small browser UI with a native Save-As dialog, or
from the command line.

> **Before you use it:** only extract documents you are permitted to retain a copy of.
> View-only is sometimes a deliberate retention control, not just a convenience setting.

---

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Running the UI](#running-the-ui)
- [Running from the command line](#running-from-the-command-line)
- [Size and quality](#size-and-quality)
- [How it works](#how-it-works)
- [Verification](#verification)
- [Limitations](#limitations)
- [Troubleshooting](#troubleshooting)
- [Project layout](#project-layout)

---

## Requirements

| | |
|---|---|
| **Node.js** | 20 or newer. Tested on 24.13.1. |
| **npm** | Any recent version. Tested on 11.8.0. |
| **Chromium** | Installed through Playwright (see below). Used for ~3 seconds per run. |
| **Browser** | Chrome or Edge for the native Save-As dialog. Firefox works but falls back to an ordinary download. |
| **OS** | Windows, macOS or Linux. Developed and tested on Windows 11. |
| **Network** | Outbound access to `drive.google.com`. |
| **Disk** | ~110 MB for `node_modules`, plus ~150 MB for Chromium (shared across all Playwright projects on the machine). |

Node 20 is the floor because the code relies on global `fetch`, `node:util`'s `parseArgs`
and `AbortSignal.timeout`. TypeScript runs directly through `tsx` — there is no build step.

---

## Install

```bash
cd "E:\New folder\ZenT\drive-pdf-reader"
npm install
```

Then install the browser Playwright drives:

```bash
npx playwright install chromium
```

That download is one-time and shared between projects — if you have used Playwright on
this machine before, it is probably already there and the command will exit immediately.

Verify the install:

```bash
npm run typecheck
```

Silence means success.

---

## Running the UI

This is the easier way, and the only way that lets you choose where each PDF is saved.

```bash
npm run ui
```

You should see:

```
drive-pdf-reader UI running at http://127.0.0.1:5174
  Ctrl+C to stop.
```

Your browser opens automatically. If it does not, go to **<http://127.0.0.1:5174>**.

Then:

1. Paste the Drive link into the box.
2. *(optional)* Open **Options** to change width, JPEG quality, concurrency, or switch to
   lossless PNG.
3. Press **Extract PDF**. The page shows the document title, total pages, and a live
   counter as pages arrive.
4. When it finishes, press **Save PDF…** and pick any folder you like.
5. Press **Extract another** to do the next one.

**Leave the terminal window open** — that is the server. Closing it or pressing Ctrl+C
stops the UI.

### Notes on the UI

- **The Save dialog** is a real native Save-As window, provided by the browser's File
  System Access API. That is the whole reason the UI exists: Node cannot open that dialog
  without bundling Electron, and Chrome and Edge already have one.
- **Nothing is written to disk by the server.** The finished PDF is held in memory under a
  job id and handed to the page, which owns the save. Jobs are discarded after 30 minutes.
- **The server listens on `127.0.0.1` only.** It drives a headless browser and fetches URLs
  on request, so it is deliberately not reachable from your network.
- **Use a different port** with `npm run ui -- --port=5175`, or set `PORT=5175`.

---

## Running from the command line

Useful for scripting or batches. Output goes to `output/` relative to the current
directory, rather than to a folder you pick.

```bash
npx tsx src/cli.ts "https://drive.google.com/file/d/<FILE_ID>/view"
```

Quote the URL — Drive links contain `&` and `?`, which your shell will otherwise split on.

| Flag | Default | Effect |
|---|---|---|
| `--width=<px>` | `1600` | Render width per page. Automatically clamped to the document's `maxPageWidth`. |
| `--quality=<1-100>` | `82` | JPEG quality for re-encoded pages. |
| `--png` | off | Embed lossless PNG instead of JPEG. **Very** large output. |
| `--concurrency=<n>` | `8` | Parallel page fetches. |
| `--out=<dir>` | `output` | Output directory. |
| `--keep-pages` | off | Also write each page image to `work/<fileId>/`. |
| `--help` | | Usage. |

Existing files are never overwritten — a second run writes `… (2).pdf`.

### Worked example

A 159-page slide deck:

```bash
npx tsx src/cli.ts "https://drive.google.com/file/d/18zM6cKYhTF2MRd0Ml8Vo3rGZTpckOfxd/view"
```

```
File ID: 18zM6cKYhTF2MRd0Ml8Vo3rGZTpckOfxd
Trying direct download...
View-only. Capturing viewer token...
Document: 1 - INTRODUCTION TO BARS & BARTENDER ATTRIBUTES
  159 pages, max render width 3200px
  rendering at 1600px as JPEG q82, 8 at a time
  pages 159/159 (100%)
Assembling PDF...

Done.
  output\1 - INTRODUCTION TO BARS & BARTENDER ATTRIBUTES.pdf
  159 pages, 12.93 MB
```

About one minute end to end. Exit code is `0` on success, `1` on failure or a failed
verification.

---

## Size and quality

Drive's endpoint serves **PNG or WebP only — never JPEG**. Raw PNG is far too large to
ship, so pages are re-encoded to JPEG through `sharp` by default. Measured on the deck
above:

| Setting | Per page | 159 pages |
|---|---|---|
| `--width=800` | ~219 KB PNG | ~34 MB |
| `--width=1600` **(default)** | ~930 KB PNG | ~148 MB |
| `--width=3200` | ~2.4 MB PNG | ~390 MB |
| `--width=1600 --quality=82` **(actual output)** | ~83 KB JPEG | **12.9 MB** |

Guidance:

- **Leave the defaults alone** for slides and ordinary spec pages — they are legible and
  the file stays small.
- **`--width=3200`** for small print, dense tables, or figures you need to zoom into.
  Expect roughly four times the size.
- **`--png`** only when you need pixel-exact fidelity, and expect ~148 MB for a deck this
  long.

Memory scales with the document: pages are held in RAM until the PDF is assembled. A
159-page run at defaults is comfortable; `--png --width=3200` on a long document can reach
several hundred megabytes.

---

## How it works

Drive's viewer renders each page server-side and fetches it from a parameterised endpoint:

```
GET /viewer/img?id={viewerToken}&page={n}&w={pixels}
```

Given the token, any page can be requested directly — in any order, at a chosen
resolution. So this tool does **not** scroll the viewer, wait for lazy rendering, or take
screenshots. A headless browser runs for about three seconds purely to capture the token,
then closes; every page after that is a plain HTTP request with no cookies.

```
resolve URL → try direct download → capture token → read page count
            → fetch pages (concurrent) → JPEG re-encode → assemble → verify
```

If Drive will still serve the original file, the tool takes it and skips everything else.
That path yields the publisher's real PDF — selectable text, vectors, a fraction of the
size — so it is always tried first.

### The viewer token

The `ACFrOgB…` token is minted per viewer session, is **not** the file ID, and is
short-lived:

- A run cannot be paused and resumed hours later; start again instead.
- If pages fail partway through with "response was not a PNG", the token expired. Re-run —
  a fresh one is minted each time.
- The token authenticates by itself, so page fetches deliberately send no cookies and are
  never bound to whichever Google account happens to be signed in.

`ARCHITECTURE.md` has the full design, the measured endpoint behaviour, and diagrams.

---

## Verification

The tool refuses to quietly hand over a broken document. After assembly it checks that:

- the page count matches the viewer's own figure,
- every page index appears exactly once,
- no page is too small to be a real render,
- nothing rendered identically to another page (a warning, not a failure — section
  dividers legitimately repeat).

If a hard check fails, the PDF is **still produced** but named `.partial.pdf`, the problems
are listed, and the CLI exits non-zero. A truncated PDF that reports success is worse than
no PDF, because nobody notices until much later.

---

## Limitations

- **Folder links are not supported.** Pass individual file links; it tells you so rather
  than half-working.
- **Output is raster.** Text is not selectable and the PDF is not searchable. The page
  images are high enough resolution to OCR well if that is added later.
- **Viewer watermarks are captured** along with the page — they are part of the render.
- **Files needing a signed-in session are refused.** The tool creates no Google session and
  says so plainly rather than hanging.
- **Closing the browser tab mid-extract** stops the progress display but does not cancel
  the work; the run finishes server-side and is then discarded.

---

## Troubleshooting

### The UI

| Symptom | Cause | Fix |
|---|---|---|
| Page will not load | Server is not running | Run `npm run ui` and leave the terminal open |
| `Port 5174 is already in use` | Another copy is running, or something else holds the port | `npm run ui -- --port=5175` |
| Browser did not open by itself | Auto-open is best-effort | Go to <http://127.0.0.1:5174> manually |
| No Save-As dialog, file just downloads | Firefox has no File System Access API | Use Chrome or Edge, or accept the download folder |
| `That result expired` | Job passed its 30-minute lifetime | Extract again |
| `Lost connection to the extractor` | Server stopped mid-run | Check the terminal for the error, restart it |
| Progress freezes at 100% | Assembling a long document | Give it a few seconds |

### Extraction

| Symptom | Cause | Fix |
|---|---|---|
| `redirected to a Google sign-in page` | File is not link-shared | Only publicly viewable files work |
| `No viewer token appeared within 45s` | Not a previewable document, or Drive changed | Confirm the link previews in a normal browser |
| `response was not a PNG` | Viewer token expired mid-run | Re-run |
| `rejected with HTTP 400` | Requested width above the document's maximum | Omit `--width`; it clamps automatically |
| `Folder links are not supported` | You passed a folder URL | Open the folder, pick the file, use its link |
| Many pages fail at once | Rate limiting | Lower it: `--concurrency=4` |
| Output much larger than expected | `--png` is on | Drop `--png` |
| Verification failed, got `.partial.pdf` | Truncated capture, usually an expired token | Re-run; if it repeats, lower `--concurrency` |

### Install

| Symptom | Cause | Fix |
|---|---|---|
| `sharp could not be loaded` | Native binary missing for your platform | `npm rebuild sharp`. Without it the tool still works but embeds PNG, so files are large |
| `Executable doesn't exist` / Chromium error | Playwright browser not installed | `npx playwright install chromium` |
| `Cannot find module` | Dependencies not installed | `npm install` |

Set `DEBUG=1` for full stack traces:

```bash
DEBUG=1 npx tsx src/cli.ts "<url>"
```

On PowerShell: `$env:DEBUG=1` first.

---

## Project layout

| File | Role |
|---|---|
| `src/types.ts` | Shared contract; documents the measured endpoint behaviour |
| `src/resolve.ts` | Drive URL → file ID; file vs folder |
| `src/probe.ts` | Fast path; `%PDF-` magic check, never throws |
| `src/viewer.ts` | Token and title capture (the only browser step), page-count metadata |
| `src/capture.ts` | Bounded worker pool, retries, re-encode, **sorts by page index** |
| `src/assemble.ts` | `pdf-lib`, per-page box sizing |
| `src/verify.ts` | Pure post-assembly integrity pass |
| `src/pipeline.ts` | The flow itself, progress as events — shared by both front ends |
| `src/cli.ts` | Flags, terminal progress, exit codes |
| `src/server.ts` | Local HTTP, SSE progress, in-memory job store |
| `src/ui.html` | Browser UI and Save-As handling |

`output/` holds finished PDFs from CLI runs, `work/` holds per-page images when
`--keep-pages` is set. Both are gitignored.

The CLI and the UI are both thin shells over `src/pipeline.ts`, so they run identical
stages and cannot drift apart.

### npm scripts

| Command | Does |
|---|---|
| `npm run ui` | Start the browser UI on port 5174 |
| `npm start -- "<url>"` | Run the CLI |
| `npm run typecheck` | Typecheck the whole project |
| `npm run install:browser` | Install Chromium for Playwright |
