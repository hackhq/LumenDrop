# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Lumen Drop moves a file between devices via screen → camera only, using [libcimbar](https://github.com/sz3/libcimbar) color barcodes. Two modes: Send (`web/send.html`) and Receive (`web/recv.html`). A Go binary embeds the static site; Caddy terminates HTTPS in deployment. `PLAN.md` holds scope and milestones; `docs/superpowers/specs/` holds the approved design.

## Commands

```sh
go run .                                          # serve on 127.0.0.1:8080 (camera works on localhost)
go test ./...                                     # Go: headers, MIME, generated service worker
(cd qr && go test ./...)                          # QR codec (separate module): round trips through real QR images
qr/build.sh                                       # rebuild web/vendor/qr/qr.wasm after changing qr/ (commit the output)
node --test --test-concurrency=1 test/browser/    # all browser tests (headless chromium on PATH, Node 22+)
node --test --test-concurrency=1 --test-name-pattern="Stop returns" test/browser/send.test.mjs   # one test
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o lumendrop .                                    # deploy binary
```

Browser tests build the binary, start it on a fixed port per file, and drive Chromium over the DevTools Protocol (`test/browser/harness.mjs`, no npm deps). Screenshots and fixtures go to `test-output/` (gitignored). `recv.test.mjs` records the send page into `test-output/sender.mjpeg` and feeds it to the receive page as a fake camera, then checks the downloaded file's SHA-256.

## Architecture

- **Server** (`main.go`, `server.go`, `sw.go`): `//go:embed web` → `http.FileServerFS`, wrapped with CSP/nosniff/no-referrer headers. `sw.js` is not a file: it is generated at startup with a cache name hashed from all embedded files and a precache list of every file (`index.html` → `./`, because the file server redirects `/index.html`). Any change under `web/` therefore updates clients automatically: `UI.registerSW()` reloads the page on `controllerchange` (only when it was already controlled, and never while `body[data-state]` is playing/scanning/done); install precaches with `cache: "reload"`. `test/browser/update.test.mjs` builds two variants of the site to test this.
- **Vendored libcimbar** (`web/vendor/cimbar/`): v0.6.9 release files, byte-identical (checked by `SHA256SUMS`). One WASM serves both encoder (`_cimbare_*`) and decoder (`_cimbard_*`). The timestamp stamp `2026-11-18T0531` appears in `send.html`, `recv.html` and `js/recv.js`; the upstream worker `importScripts` the stamped name, so never rename the files. Upgrade steps are in that folder's README.
- **Send** (`js/send.js`): defines `window.Report` (callbacks the vendored `Send` driver calls) and `window.Module` (must exist before the `cimbar_js` script tag runs). Mode B (68) is fixed; `fit()` sizes the canvas to the code's aspect ratio inside the stage.
- **Receive** (`js/recv.js`): camera frames (`VideoFrame` NV12/I420, else `createImageBitmap`) are round-robined to 3–6 upstream `recv-worker`s; the main-thread `Module` locks the mode on the first successful frame, runs the fountain decoder, then streams `_cimbard_decompress_read` into a Blob offered via Save/Share.
- **Shared** (`js/ui.js`): global `UI` (state via `body[data-state]`, wake lock, fullscreen overlay, SW registration). Pages show/hide sections with CSS keyed on `body[data-state]`.

## QR code mode (txqr)

- `qr/` is its own Go module so the server stays dependency-free. `qr/txqr/` holds txqr's protocol files unmodified (upstream go.mod pins a module that no longer exists). `qr/codec` adds a container with the file name (`LDQ1` + name), base64 (as txqr's tools do), QR rendering (go-qrcode, ECC M) and scanning (gozxing, ISO-8859-1 so XORed fountain bytes pass through unchanged; hybrid then global binarizer). `qr/cmd/wasm` exports `LumenQR`; every export recovers panics. Limits: 1 MiB files, header bounds checked before allocating.
- Send: `js/qr-send.js` loads the runtime on first use and draws frames on `#qr-canvas` (2D, integer pixels per module, 4-module quiet zone); the cimbar loop isn't started. Resolution Low/Medium/High = 200/400/600 bytes per QR (measured in `qr/codec/sweep_test.go`, `SWEEP=1`).
- Receive: `js/qr-recv.js` + `js/qr-worker.js`. While `format` is unknown every 3rd frame (own counter) goes to the QR worker at half resolution; a valid txqr frame locks `format = "qr"` (full resolution, cimbar workers idle), cimbar data locks `"color"`; 3 s without data unlocks. Replies carry a generation id so frames from before a reset are ignored.

## libcimbar quirks (v0.6.9)

- The fountain sink has no reset API and ignores finished file ids; it is rebuilt only when `_cimbard_configure_decode` gets a different mode. `start()` in `recv.js` relies on this for "Receive another".
- The decoder keeps only the last rebuilt file id; rebuilding the same id again yields 0 bytes. `finish()` reloads the page with `#scan` (auto-start) in that case.
- `Send` has no stop API; its render loop keeps running after Stop (and keeps calling `Report.prevent_sleep`, so that callback checks the page state).
- `Send.importFile` is an uncancellable async FileReader chain feeding one shared compressor. `send.js` wraps `Module._cimbare_encode` to learn when an import ends (first return of `0`; `1` = more chunks; negative = failure) and queues any file picked meanwhile; never start two imports at once.
- Each fountain chunk starts with its 4-byte little-endian file id; `recv.js` uses it to spot a repeat of the last rebuilt file on the first chunk.
- Large files abort the encoder with OOM (~30 MB+ in desktop Chromium); `onAbort` during an import shows a "too big" error.

## Sender/receiver tuning

- Send stage controls: Resolution Low/Medium/High = libcimbar modes Bu (66) / Bm (67) / B (68, default); speed 5/8/12/15 fps via `Send.setFPS`. Saved in `localStorage` (`lumen-send-mode`, `lumen-send-fps`); `send.html?fps=N` overrides the saved speed. Changing resolution re-encodes the current file (libcimbar drops a stream that doesn't fit a new mode).
- Receiver: locks the first mode that yields data; releases the lock after 3 s without data (`RELOCK_MS`) so it follows a resolution change. `recv.html?camfps=N` sets the camera frame rate (default 15). Camera stays at ideal 1920x1080: 4K frames make the decoder abort with OOM.
- Debug: `recv.html#debug` (live counters, pixel brightness, Save frame), `#debug-bitmap` (forces the `createImageBitmap` path). Decoder result `-3` means the four corner anchors weren't found.
- The code shifts a few pixels every frame on purpose (libcimbar `shake()`): blended frames then show doubled anchors and fail fast at the scan step. Real-device failures so far (iPhone + laptop LCD) were all frames blending two codes, not pixel-format problems.

## Constraints

- No inline scripts, styles, or `on*=` handlers (CSP `script-src 'self' 'wasm-unsafe-eval'`, `style-src 'self'`); setting styles via CSSOM (`el.style.setProperty`) is fine.
- No third-party URLs in `web/` (offline + privacy). Fonts are self-hosted.
- Any string from a file or the barcode reaches the DOM via `textContent`. Received files are offered only as `application/octet-stream` downloads/shares, never opened in-app.
- Never style the barcode `<canvas>` (radius, filters, opacity, overlays) — cameras must read it as drawn.
- Licensing: our code is MIT; `web/vendor/cimbar/` stays MPL-2.0 and unmodified; do not copy code from upstream `web/*.js` into our files (it would make them MPL).
