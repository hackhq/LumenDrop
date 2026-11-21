"use strict";
// QR code receiving: hands camera frames (as brightness) to js/qr-worker.js, which scans
// them for txqr QR codes and rebuilds the file. recv.js decides which frames come here.
const QRRecv = (() => {
  const YUV = ["NV12", "I420"]; // VideoFrame formats whose first plane is already brightness

  let worker = null;
  let ready = false;
  let busy = false;
  let gen = 0; // bumped on reset, so answers about frames from before it are ignored
  let handlers = { status() {}, result() {}, failed() {} };
  const stats = { sent: 0, found: 0, valid: 0, scanMs: 0, blocks: 0, chunks: 0, size: "" };

  // Half-resolution copy (2x2 average): four times cheaper to scan, and a QR code that fills
  // the view still has several pixels per module. Used while checking whether QR is in play.
  function halve(lum, w, h) {
    const hw = w >> 1;
    const hh = h >> 1;
    const out = new Uint8Array(hw * hh);
    for (let y = 0; y < hh; y++) {
      const r0 = 2 * y * w;
      const r1 = r0 + w;
      for (let x = 0; x < hw; x++) {
        const i = 2 * x;
        out[y * hw + x] = (lum[r0 + i] + lum[r0 + i + 1] + lum[r1 + i] + lum[r1 + i + 1]) >> 2;
      }
    }
    return { lum: out, width: hw, height: hh };
  }

  // Brightness of the current video frame, at full resolution.
  async function luminance(video) {
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (typeof VideoFrame === "function") {
      let vf;
      try {
        vf = new VideoFrame(video, { timestamp: Math.round(performance.now() * 1000) });
        if (YUV.includes(vf.format)) {
          const buf = new Uint8Array(vf.allocationSize());
          await vf.copyTo(buf);
          return { lum: buf, width: vf.displayWidth, height: vf.displayHeight };
        }
      } catch {
        // fall through to the canvas path
      } finally {
        if (vf) vf.close();
      }
    }
    const c = new OffscreenCanvas(w, h);
    const g = c.getContext("2d", { willReadFrequently: true });
    g.drawImage(video, 0, 0);
    const rgba = g.getImageData(0, 0, w, h).data;
    const lum = new Uint8Array(w * h);
    for (let i = 0, j = 0; j < lum.length; i += 4, j++) {
      lum[j] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
    }
    return { lum, width: w, height: h };
  }

  function onMessage(event) {
    const msg = event.data;
    if (msg.type === "ready") {
      ready = true;
      return;
    }
    if (msg.type === "failed") {
      handlers.failed(msg.message);
      return;
    }
    if (msg.gen !== gen) return;
    busy = false;
    if (msg.found) stats.found++;
    if (msg.valid) {
      stats.valid++;
      stats.blocks = msg.blocks;
      stats.chunks = msg.chunks;
    }
    if (msg.scanMs) stats.scanMs = msg.scanMs;
    handlers.status(msg);
    if (msg.done && msg.data) handlers.result(msg.name, msg.data);
  }

  return {
    stats,
    get ready() { return ready; },
    get busy() { return busy; },

    init(on) {
      handlers = { ...handlers, ...on };
      worker = new Worker("js/qr-worker.js");
      worker.onmessage = onMessage;
      worker.onerror = () => handlers.failed("the QR decoder stopped");
    },

    // Sends the current frame to the decoder unless it is still busy with the last one.
    // `full` = full resolution (once QR is known to be in play); otherwise half.
    async offer(video, full) {
      if (!ready || busy || !video.videoWidth) return false;
      busy = true;
      try {
        let { lum, width, height } = await luminance(video);
        if (!full) ({ lum, width, height } = halve(lum, width, height));
        stats.size = `${width}x${height}`;
        worker.postMessage({ type: "frame", gen, lum, width, height }, [lum.buffer]);
        stats.sent++;
        return true;
      } catch {
        busy = false;
        return false;
      }
    },

    reset() {
      gen++;
      busy = false;
      Object.assign(stats, { sent: 0, found: 0, valid: 0, scanMs: 0, blocks: 0, chunks: 0, size: "" });
      if (worker) worker.postMessage({ type: "reset" });
    },
  };
})();
