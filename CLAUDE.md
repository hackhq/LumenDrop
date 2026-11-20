# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

Lumen Drop is a web app (installable PWA) for moving files between devices via screen → camera only, using [libcimbar](https://github.com/sz3/libcimbar) color barcodes. **Nothing is implemented yet.** `PLAN.md` is the source of truth for scope, the planned file layout, and milestones M1–M5 — read it first. Items under "Ideas for later" (multi-stream big files, passphrase encryption, SHA-256 display) are out of scope unless explicitly requested.

The plan's tree is rooted at `lumen-drop/`; whether files live at this repo's root or in a subfolder is not yet decided.

## Commands

No build, lint, or test tooling exists yet. Update this section when any is added.

- **WASM artifacts:** download from [libcimbar releases](https://github.com/sz3/libcimbar/releases/latest) or build with Docker per libcimbar's `WASM.md`; they go in `vendor/cimbar/`.
- **Local testing:** `localhost` is exempt from the HTTPS requirement for camera access, so the receive page can be tested on a local desktop webcam.
- **Testing is manual and cross-device:** computer → iPhone, then iPhone → computer, starting at 1 MB and stepping up to ~33 MB. iPhone Safari decoding may be slow — test it early rather than last.

## Architecture (planned)

Static files only — no backend. Plain HTML/CSS/JS pages (`index.html`, `send.html`, `recv.html`) with per-page scripts in `js/`. The planned `nginx.conf` is only for static HTTPS hosting.

**Send pipeline** (`send.js` + `ui.js`): read file → libcimbar encoder (WASM) → draw frames to a `<canvas>` in a `requestAnimationFrame` loop, fullscreen, with `navigator.wakeLock` holding the screen on.

**Receive pipeline** (`recv.js` → `recv-worker.js`): `getUserMedia({video:{facingMode:"environment"}})` → `OffscreenCanvas` → `postMessage` frames to a Web Worker that runs the WASM decoder → progress reported back to the page → on completion build a `Blob` and trigger download. Decoding must stay in the worker so the UI and camera preview stay responsive.

**libcimbar integration:** the `.js` + `.wasm` build goes in `vendor/cimbar/`. Learn the exported API from libcimbar's own `web/send.js`, `web/recv.js`, and `web/recv-worker.js` (the reference implementation) — do not guess function names or signatures.

## Constraints

- **Offline after first visit:** everything the app ships, including the `.wasm`, must be cached by the service worker (`sw.js`), alongside a `manifest.json` for install.
- **HTTPS is mandatory in deployment** — iPhone will not grant camera access otherwise.
- **`.wasm` must be served as `application/wasm`** (in Nginx: `types { application/wasm wasm; }`).
- **Throughput limits:** files up to ~33 MB after zstd compression, at roughly 100 KB/s.
- **Licensing:** libcimbar is MPL-2.0 — any modified libcimbar files must remain open source. Keep app code separate from vendored libcimbar code so the boundary stays clear.
