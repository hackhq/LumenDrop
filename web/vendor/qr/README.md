# QR code runtime

`qr.wasm` is built from this repository's `qr/` Go module (`qr/build.sh`), which wraps the
[txqr](https://github.com/divan/txqr) protocol (fountain-coded QR frames) for the browser:
encoding a file into QR frames, rendering each frame's modules, scanning camera frames
(gozxing) and rebuilding the file. `wasm_exec.js` is the matching loader from the Go
distribution. Rebuild after changing `qr/`, then commit both files and `SHA256SUMS`.

## Licenses

Everything compiled into `qr.wasm` (see `licenses/`):

| Component | License |
|---|---|
| txqr (protocol files vendored in `qr/txqr/`) | MIT |
| github.com/google/gofountain | Apache-2.0 |
| github.com/skip2/go-qrcode | MIT |
| github.com/makiuchi-d/gozxing | MIT |
| golang.org/x/text, golang.org/x/xerrors | BSD-3-Clause |
| Go runtime and `wasm_exec.js` | BSD-3-Clause |
