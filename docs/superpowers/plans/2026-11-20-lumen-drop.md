# LumenDrop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Send/Receive web app over screen→camera using libcimbar, served from one Go binary behind Caddy, offline-capable.

**Architecture:** Go stdlib server embeds `web/` and generates `sw.js` at startup. Pages are plain HTML/CSS/JS calling the vendored libcimbar WASM (unmodified release files). Sender = upstream `Send` on main thread; receiver = pool of upstream `recv-worker` + our main-thread fountain decode/decompress.

**Tech Stack:** Go 1.26 stdlib (`net/http`, `embed`, `io/fs`), vanilla JS, libcimbar v0.6.9 WASM, Caddy (deploy only).

**Spec:** `docs/superpowers/specs/2026-11-20-lumen-drop-design.md`

## Global Constraints
- Go stdlib only; `go.mod` has no `require`.
- Default listen `127.0.0.1:8080` (`-addr` flag).
- No inline `<script>`/`style=`/`on*=` handlers; no third-party URLs anywhere in `web/`.
- CSP: `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'` (add `'unsafe-eval'` only if console proves `cimbar_js` needs it).
- Every dynamic string reaches the DOM via `textContent`.
- Barcode `<canvas>`: no border-radius, filter, opacity, transform-animation, or overlapping elements.
- `web/vendor/cimbar/*` byte-identical to release `v0.6.9`; our JS never copies upstream web code. Our code MIT.
- No git repo exists: skip commit steps unless the user asks.

## Review Focus
1. Received file name containing markup (`<img src=x onerror=alert(1)>.txt`) → shown literally, never executed.
2. Camera permission denied / no camera → readable error + Retry button, no uncaught exception.
3. Sending on a portrait phone → barcode rotated (upstream `rotate_window`) and fully on screen.
4. Second transfer in one session (send a new file while playing; receive another after done) → clean reset.
5. WebGL unavailable on send → clear message instead of a blank screen.

---

### Task 1: Go server

**Files:** Create `go.mod`, `main.go`, `server.go`, `sw.go`, `server_test.go`; placeholder `web/index.html`.

**Interfaces — Produces:**
- `func newHandler(site fs.FS) (http.Handler, error)` — wraps `http.FileServerFS(site)`, adds headers, serves generated `/sw.js`.
- `func buildServiceWorker(site fs.FS) ([]byte, error)` — `CACHE` = `"lumen-" + first 12 hex of sha256 over (path+content) of all files`; `FILES` = every file except `sw.js`, as `./<path>`, with `index.html` → `./`.
- `main.go`: `//go:embed all:web`, `fs.Sub(..., "web")`, `mime.AddExtensionType(".wasm","application/wasm")`, `http.Server{ReadHeaderTimeout: 10s}`.

- [ ] **Step 1: Write failing tests** in `server_test.go` using `fstest.MapFS`:
  - `TestSecurityHeaders`: GET `/` → `Content-Security-Policy` equals the Global Constraints value; `X-Content-Type-Options: nosniff`; `Referrer-Policy: no-referrer`.
  - `TestWasmMime`: GET `/vendor/x.wasm` → `Content-Type: application/wasm`.
  - `TestServiceWorker`: GET `/sw.js` → 200, `Cache-Control: no-cache`, body contains `"./"` and `"./send.html"`, not `"./index.html"`, not `"./sw.js"`; changing a file's content changes the cache name.
  - `TestNotFound`: GET `/nope` → 404.
- [ ] **Step 2:** `go test ./...` → FAIL (undefined: newHandler).
- [ ] **Step 3:** Implement the interfaces above. SW JS: install → `cache.addAll(FILES)` + `skipWaiting`; activate → delete other caches + `clients.claim`; fetch (GET, same-origin) → `caches.match(req, {ignoreSearch:true})` then network.
- [ ] **Step 4:** `go test ./... && go vet ./...` → PASS. `go run . &` then `curl -sI 127.0.0.1:8080/` shows the headers.

### Task 2: Vendor libcimbar

**Files:** Create `web/vendor/cimbar/{cimbar_js.2026-11-18T0531.js,.wasm, send.2026-11-18T0531.js, recv-worker.2026-11-18T0531.js, LICENSE, SHA256SUMS, README.md}`, `web/vendor/cimbar/third_party/<lib>-LICENSE` (base91, concurrentqueue, cxxopts, fmt, intx, libcorrect, libpopcnt, PicoSHA2, stb, wirehair, zstd, OpenCV).

**Interfaces — Produces:** globals `Module`, `Send` (`init_window(canvas)`, `setMode(68)`, `nextFrame()`, `importFile(file)`, `rotate_window(bool)`, `togglePause(bool)`); worker URL `vendor/cimbar/recv-worker.2026-11-18T0531.js`; stamp constant `2026-11-18T0531` appears only in HTML script tags and `recv.js`.

- [ ] **Step 1:** Copy from release tarball / tag clone; write `SHA256SUMS`; README notes tag, source URL, MPL-2.0.
- [ ] **Step 2:** `cd web/vendor/cimbar && sha256sum -c SHA256SUMS` → all OK; `cmp` each against the release tarball → identical.

### Task 3: Shell, design system, home page, PWA manifest

**Files:** Create `web/index.html`, `web/css/style.css`, `web/js/ui.js`, `web/manifest.json`, `web/icons/{icon.svg,icon-192.png,icon-512.png,maskable-512.png,apple-touch-icon.png}`.

**Interfaces — Produces (`ui.js`, global `UI`):** `UI.$(sel)`, `UI.formatBytes(n) -> string`, `UI.keepAwake() / UI.releaseAwake()`, `UI.enterFullscreen(el)` (fixed overlay class + Fullscreen API if present), `UI.exitFullscreen()`, `UI.registerSW()` (called last on each page).

- [ ] **Step 1:** Load `frontend-design` skill; build dark, system-font design tokens in `style.css`; home = two large cards (Send / Receive) + footer "Powered by libcimbar · sz3" linking `https://github.com/sz3/libcimbar`.
- [ ] **Step 2:** Icons: author `icon.svg`, render PNGs with headless Chromium.
- [ ] **Step 3: Verify:** headless Chromium screenshots at 390×844 and 1440×900; console has no errors/CSP violations; `curl` of every URL in the generated SW list → 200.

### Task 4: Send page

**Files:** Create `web/send.html`, `web/js/send.js`.

**Interfaces — Consumes:** `Send`, `Module` (Task 2), `UI` (Task 3). **Produces:** global `Report` with `setTitle(s)`, `setHTML(id,s)` (textContent), `setActive()` (idempotent → show barcode view), `prevent_sleep()` (→ `UI.keepAwake`), `setAspectRatio(r)` (→ fit canvas: rotate if `r>1 && h>w`, size by ratio).

- [ ] **Step 1:** States: *pick* (drop zone + file button + photosensitivity line) → *playing* (fullscreen black, canvas centered, small top bar: name, size, Stop). Stop reloads state to *pick* (re-import of a new file allowed while playing).
- [ ] **Step 2:** Init order: `Module = {canvas, onRuntimeInitialized}` set in `send.js` before the `cimbar_js` script tag; on init `Send.init_window(canvas); Send.setMode(68); Send.nextFrame()`. WebGL check → error card (Review Focus 5).
- [ ] **Step 3: Verify:** headless Chromium (SwiftShader) load, set a 1 KB file via CDP, screenshot shows a barcode; portrait 390×844 screenshot shows rotated barcode fully visible; no console errors.

### Task 5: Receive page

**Files:** Create `web/recv.html`, `web/js/recv.js`.

**Interfaces — Consumes:** `Module` `_cimbard_*` exports, worker messages `{type:'startWasm'}` / `{nodata}` / `{failed_extract}` / `{res}` / `{error}` / `{mode, buff}`.

- [ ] **Step 1:** States: *start* (Start camera button) → *scanning* (fullscreen video, aim frame, progress ring %, status text) → *done* (file name, size, **Save file**, **Share** if `navigator.canShare({files})`, Receive another) / *error* (message + Retry).
- [ ] **Step 2:** Pipeline: workers = clamp(hwConcurrency/2+1, 3, 6); camera `{width:{ideal:1920},height:{ideal:1080},facingMode:'environment',frameRate:{ideal:15}}`; frame loop with `requestVideoFrameCallback`→rAF; `VideoFrame` (NV12/I420 else RGBA) → `createImageBitmap` fallback; in-flight cap 30; cycle modes `[66,68,67,4]` until first bytes, then `_cimbard_configure_decode(mode)` + allocate fountain buffer once; fountain decode result → BigInt-safe uint32 id; progress from `_cimbard_get_report` JSON array; on id: stop loop + tracks, read filename/size, stream `_cimbard_decompress_read` chunks (`.slice()` from fresh `HEAPU8` view) into `Blob([...], {type:'application/octet-stream'})`.
- [ ] **Step 3: Verify (e2e):** capture ~300 send-page frames of a known 20 KB random file via CDP screenshots → MJPEG; launch Chromium with `--use-fake-device-for-media-stream --use-file-for-fake-video-capture=<mjpeg>`; receive page reaches *done*; saved bytes' sha256 equals the source. Also: deny-permission run shows error card (Review Focus 2); filename from Review Focus 1 renders literally.

### Task 6: Offline, deploy files, docs

**Files:** Create `LICENSE` (MIT, "LumenDrop contributors"), `README.md`, `Caddyfile`; modify `PLAN.md`, `CLAUDE.md`.

- [ ] **Step 1:** README: what it is, `go run .`, build `CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o lumendrop .`, Caddyfile, non-root systemd unit, security note (barcodes not encrypted), Credits + license split.
- [ ] **Step 2: Verify offline:** load `/`, `/send.html`, `/recv.html` once; kill server; reload each → renders, WASM loads (send shows barcode for a file).
- [ ] **Step 3:** Update `PLAN.md` (Go+Caddy, layout, M1/M2/M4 checkboxes only if verified) and `CLAUDE.md` (commands, layout, stamp locations); run `graphify update .`.
