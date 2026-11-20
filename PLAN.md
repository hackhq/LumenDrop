# Lumen Drop — Plan

Web app for sending and receiving files through the screen and the camera (no internet, Bluetooth, or cables), built on [libcimbar](https://github.com/sz3/libcimbar).
- Static files only, no server
- Installs as a PWA and works offline on iPhone, Android, and computers

## Goals
- **Send page:** pick a file, then play cimbar barcodes fullscreen
- **Receive page:** turn on the camera, show progress, download the file when done
- Files up to ~33 MB (after zstd compression), ~100 KB/s
- Works offline after the first visit

## File structure
```
lumen-drop/
├── index.html          # home: Send / Receive buttons
├── send.html           # pick a file -> fullscreen barcode animation
├── recv.html           # camera + progress bar + download button
├── css/style.css
├── js/
│   ├── send.js         # read file -> encoder -> draw frames to canvas
│   ├── recv.js         # getUserMedia -> send frames to worker
│   ├── recv-worker.js  # decode in a Web Worker (keeps UI responsive)
│   └── ui.js           # fullscreen, Wake Lock, camera picker
├── vendor/cimbar/      # .js + .wasm built from libcimbar
├── manifest.json       # PWA manifest
├── sw.js               # service worker: cache everything for offline use
├── nginx.conf          # HTTPS + wasm MIME type
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
   - HTTPS is required (iPhone camera access).
   - In Nginx add `types { application/wasm wasm; }`.
6. **Test**
   - Computer -> iPhone, then iPhone -> computer.
   - Start with 1 MB, then step up to 33 MB.

## Milestones
- [ ] M1: WASM loads, send page shows an animated barcode
- [ ] M2: receive page decodes a small file on desktop webcam
- [ ] M3: works on iPhone Safari and Android Chrome
- [ ] M4: PWA offline install
- [ ] M5: deployed on HTTPS

## Notes
- `localhost` allows camera access without HTTPS for local testing.
- Browser decoding on iPhone Safari may be slower than the Android CFC app; test early.
- libcimbar is MPL-2.0: modified libcimbar files must stay open source (your own app code can use any license).

## Ideas for later
- Multiple parallel streams for files >33 MB (see cimbar-bigfile)
- Optional passphrase encryption before encoding (Web Crypto AES-GCM)
- SHA-256 check shown after receiving
