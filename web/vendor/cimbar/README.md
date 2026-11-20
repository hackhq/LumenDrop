# Vendored libcimbar

These files come unmodified from **libcimbar v0.6.9** by sz3:
<https://github.com/sz3/libcimbar> (release asset `cimbar.wasm.tar.gz`,
sha256 `f847edd99779583dcca75b37d39cfe1f557f4fadb68638c5e8b6d6f0ef14ada0`, source commit `0eee8920f9c35188b29e81ec995bb7cac2216de1`).

| File | Role |
|---|---|
| `cimbar_js.2026-11-18T0531.js` / `.wasm` | Emscripten build of the encoder (`cimbare_*`) and decoder (`cimbard_*`) |
| `send.2026-11-18T0531.js` | Encoder driver (global `Send`), used by `send.html` |
| `recv-worker.2026-11-18T0531.js` | Decoder Web Worker, used by `js/recv.js` |

Keep the timestamped names: the worker loads `cimbar_js.2026-11-18T0531.js` by that exact name.
`SHA256SUMS` pins every file; check with `sha256sum -c SHA256SUMS` from this directory.

## License

libcimbar is licensed under the Mozilla Public License 2.0 (`LICENSE`). Its source code is
available at the URL above. The WASM build also contains third-party libraries; their
licenses are in `third_party/` (OpenCV, zstd, wirehair, libcorrect, base91, fmt, stb, intx,
libpopcnt, PicoSHA2, concurrentqueue, cxxopts).

To upgrade: replace these files with a newer release, update the stamp in `send.html`,
`recv.html` and `js/recv.js`, then regenerate `SHA256SUMS`.
