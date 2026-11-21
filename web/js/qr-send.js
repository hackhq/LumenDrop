"use strict";
// QR code sending: the txqr protocol (vendor/qr/qr.wasm, built from ../../qr) splits a file
// into fountain-coded frames, played here as plain QR codes on a 2D canvas. The WebAssembly
// runtime loads only when QR mode is first used.
const QRSend = (() => {
  const MAX_FILE_SIZE = 1 << 20; // keep in sync with codec.MaxFileSize
  const QUIET = 4; // modules of white margin around the code, as the QR standard asks

  const canvas = document.getElementById("qr-canvas");
  const area = document.getElementById("area");
  const g = canvas.getContext("2d", { alpha: false });

  let runtime = null;
  let timer = 0;
  let fps = 15;
  let frame = 0;
  let count = 0;
  let drawn = 0;

  async function instantiate(go) {
    try {
      return await WebAssembly.instantiateStreaming(fetch("vendor/qr/qr.wasm"), go.importObject);
    } catch {
      const bytes = await (await fetch("vendor/qr/qr.wasm")).arrayBuffer();
      return WebAssembly.instantiate(bytes, go.importObject);
    }
  }

  function load() {
    runtime ??= new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "vendor/qr/wasm_exec.js";
      script.onload = async () => {
        try {
          const go = new Go();
          const { instance } = await instantiate(go);
          go.run(instance); // sets window.LumenQR, then waits for calls
          resolve();
        } catch (err) {
          runtime = null;
          reject(err);
        }
      };
      script.onerror = () => {
        runtime = null;
        reject(new Error("couldn't load the QR encoder"));
      };
      document.head.append(script);
    });
    return runtime;
  }

  // Largest whole number of device pixels per module that fits the stage, so every module
  // is a crisp square.
  function draw() {
    const m = LumenQR.matrix(frame);
    if (m.error) return;
    const pad = getComputedStyle(area);
    const w = area.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight);
    const h = area.clientHeight - parseFloat(pad.paddingTop) - parseFloat(pad.paddingBottom);
    const dpr = window.devicePixelRatio || 1;
    const total = m.size + 2 * QUIET;
    const scale = Math.max(1, Math.floor((Math.min(w, h) * dpr) / total));
    const px = total * scale;
    if (canvas.width !== px) {
      canvas.width = canvas.height = px;
      canvas.style.width = canvas.style.height = `${px / dpr}px`;
    }
    g.fillStyle = "#fff";
    g.fillRect(0, 0, px, px);
    g.fillStyle = "#000";
    for (let y = 0; y < m.size; y++) {
      for (let x = 0; x < m.size; x++) {
        if (m.bits[y * m.size + x]) g.fillRect((x + QUIET) * scale, (y + QUIET) * scale, scale, scale);
      }
    }
    canvas.dataset.frame = String(++drawn); // advances on every new code (tests watch it)
    frame = (frame + 1) % count;
  }

  function loop() {
    clearInterval(timer);
    timer = setInterval(draw, 1000 / fps);
  }

  return {
    maxFileSize: MAX_FILE_SIZE,

    // Loads the runtime, encodes the file and starts playing. Resolves to {frames} or {error}.
    async start(file, chunkLen) {
      this.stop();
      try {
        await load();
      } catch (err) {
        return { error: err.message };
      }
      const data = new Uint8Array(await file.arrayBuffer());
      const result = LumenQR.newSender(file.name, data, chunkLen);
      if (result.error) return result;
      count = result.frames;
      frame = 0;
      draw();
      loop();
      return result;
    },

    setFps(value) {
      fps = value;
      if (timer) loop();
    },

    stop() {
      clearInterval(timer);
      timer = 0;
    },
  };
})();
