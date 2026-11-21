"use strict";
// Scans camera frames for txqr QR codes and rebuilds the file, in WebAssembly
// (vendor/qr/qr.wasm, built from ../../qr). One message per frame, answered in order.
importScripts("../vendor/qr/wasm_exec.js");

let ready = false;

(async () => {
  const go = new Go();
  let result;
  try {
    result = await WebAssembly.instantiateStreaming(fetch("../vendor/qr/qr.wasm"), go.importObject);
  } catch {
    const bytes = await (await fetch("../vendor/qr/qr.wasm")).arrayBuffer();
    result = await WebAssembly.instantiate(bytes, go.importObject);
  }
  go.run(result.instance); // sets self.LumenQR
  ready = true;
  postMessage({ type: "ready" });
})().catch((err) => postMessage({ type: "failed", message: String(err) }));

onmessage = (event) => {
  const msg = event.data;
  if (msg.type === "reset") {
    if (ready) LumenQR.reset();
    return;
  }
  if (!ready) {
    postMessage({ type: "status", gen: msg.gen, found: false, valid: false });
    return;
  }
  const st = LumenQR.scanFeed(msg.lum, msg.width, msg.height);
  const out = { type: "status", gen: msg.gen, ...st };
  if (st.done) {
    const r = LumenQR.result();
    out.name = r.name;
    out.data = r.data;
    postMessage(out, [r.data.buffer]);
    return;
  }
  postMessage(out);
};
