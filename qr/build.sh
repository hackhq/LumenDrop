#!/bin/sh
# Builds the QR codec to WebAssembly into web/vendor/qr/ (commit the output).
set -eu
cd "$(dirname "$0")"
out=../web/vendor/qr
mkdir -p "$out"
GOOS=js GOARCH=wasm go build -trimpath -ldflags="-s -w" -o "$out/qr.wasm" ./cmd/wasm
cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" "$out/wasm_exec.js"
(cd "$out" && sha256sum qr.wasm wasm_exec.js > SHA256SUMS)
echo "built $out/qr.wasm ($(wc -c < "$out/qr.wasm") bytes) with $(go version | cut -d' ' -f3)"
