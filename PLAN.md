# Lumen Drop — Plan

Web app for sending and receiving files through the screen and the camera (no internet, Bluetooth, or cables), built on [libcimbar](https://github.com/sz3/libcimbar).
- Static front end in one Go binary (embeds the site); no server-side processing, files never touch the server
- Installs as a PWA and works offline on iPhone, Android, and computers

## Goals
- **Send page:** pick a file, then play cimbar barcodes fullscreen
- **Receive page:** turn on the camera, show progress, download the file when done
- Files up to ~33 MB (after zstd compression), ~100 KB/s
- Works offline after the first visit

## File structure
```
LumenDrop/
├── main.go, server.go, sw.go   # Go server: embeds web/, security headers, generates sw.js
├── web/
│   ├── index.html              # home: Send / Receive
│   ├── send.html, recv.html
│   ├── css/style.css
│   ├── js/ui.js, home.js, send.js, recv.js
│   ├── vendor/cimbar/          # libcimbar v0.6.9 release files, unmodified (MPL-2.0)
│   ├── fonts/, icons/, manifest.json
├── test/browser/               # headless Chromium tests (node:test + CDP)
├── Caddyfile                   # HTTPS reverse proxy example
└── README.md
```

## Steps
1. **WASM**
   - Build with Docker per `WASM.md` in libcimbar, or download from [releases](https://github.com/sz3/libcimbar/releases/latest).
   - Read `web/send.js`, `web/recv.js`, `web/recv-worker.js` in the libcimbar repo to see the exported API, and use them as the reference implementation.
2. **Send page**
   - `FileReader` -> encoder -> `<canvas>` with `requestAnimationFrame`.
   - Fullscreen API + `navigator.wakeLock` to keep the screen on.
3. **Receive page**
   - `getUserMedia({video:{facingMode:"environment"}})` -> `OffscreenCanvas` -> `postMessage` to the worker.
   - Show % progress; when complete, build a `Blob` and trigger the download.
4. **PWA**
   - `manifest.json` + `sw.js`, caching all assets including `.wasm`.
5. **Deploy**
   - HTTPS is required (iPhone camera access): Caddy reverse proxy in front of the Go binary.
   - The Go server sets `application/wasm` itself.
6. **Test**
   - Computer -> iPhone, then iPhone -> computer.
   - Start with 1 MB, then step up to 33 MB.

## Milestones
- [x] M1: WASM loads, send page shows an animated barcode
- [ ] M2: receive page decodes a small file on desktop webcam — decoding verified end to end in headless Chromium with recorded sender frames as a fake camera; a real webcam is still untested
- [ ] M3: works on iPhone Safari and Android Chrome
- [ ] M4: PWA offline install — offline use verified in headless Chromium; installing to a home screen not yet tested
- [ ] M5: deployed on HTTPS

## Notes
- `localhost` allows camera access without HTTPS for local testing.
- Browser decoding on iPhone Safari may be slower than the Android CFC app; test early.
- libcimbar is MPL-2.0: modified libcimbar files must stay open source (your own app code can use any license).

## Ideas for later
- Multiple parallel streams for files >33 MB (see cimbar-bigfile)
- Optional passphrase encryption before encoding (Web Crypto AES-GCM)
- SHA-256 check shown after receiving
