"use strict";
// Receive page. Camera frames go to a pool of libcimbar decoder workers
// (vendor/cimbar/recv-worker.*.js). The bytes they extract are fed to the fountain
// decoder and zstd decompressor here on the main thread (cimbar_js.*.js, `window.Module`).
(() => {
  const WORKER_URL = "vendor/cimbar/recv-worker.2026-11-18T0531.js";
  const MODES = [66, 68, 67, 4]; // Bu, B, Bm, 4C: tried in turn until one decodes, then locked
  const PIXEL_FORMATS = ["NV12", "I420"]; // VideoFrame formats the decoder reads directly
  const MAX_IN_FLIGHT = 30;
  const RING = 2 * Math.PI * 26;

  const video = UI.$("#video");
  const stage = UI.$("#stage");
  const startBtn = UI.$("#start");
  const errorBox = UI.$("#error");
  const status = UI.$("#status");

  const workers = [];
  let workersReady = 0;
  let nextWorker = 0;
  let inFlight = 0;

  let running = false;
  let session = 0;        // bumped on every start/stop, so a late camera grant can tell it was cancelled
  let stream = null;
  let frameHandle = 0;
  let frames = 0;
  let lastSeen = -1000;   // frame number when a code was last found
  let lastBytes = -1000;  // frame number when a code last yielded data
  let progress = 0;
  let mode = 0;
  let fountain = null;    // {ptr, size} in the WASM heap
  let scratch = null;     // {ptr, size} for report and file name strings
  let useVideoFrame = typeof VideoFrame === "function";
  let resultUrl = null;
  let lastId = null;      // id of the file libcimbar rebuilt last

  // ---------- WASM heap helpers (views are re-made every time: the heap can grow) ----------

  function alloc(size) {
    return { ptr: Module._malloc(size), size };
  }

  function readString(fn) {
    if (!scratch) scratch = alloc(1024);
    const len = fn(scratch.ptr, scratch.size);
    return len > 0 ? new TextDecoder().decode(Module.HEAPU8.subarray(scratch.ptr, scratch.ptr + len)) : "";
  }

  // ---------- states ----------

  function setStatus(text) {
    if (status.textContent !== text) status.textContent = text;
  }

  function setProgress(p) {
    progress = Math.max(0, Math.min(1, p));
    UI.$("#ring").setAttribute("stroke-dashoffset", String(RING * (1 - progress)));
    UI.$("#pct").textContent = `${Math.floor(progress * 100)}%`;
  }

  function stopCamera() {
    running = false;
    session++;
    if (frameHandle) {
      if ("cancelVideoFrameCallback" in video) video.cancelVideoFrameCallback(frameHandle);
      else cancelAnimationFrame(frameHandle);
      frameHandle = 0;
    }
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
    stage.hidden = true;
    UI.exitFullscreen();
    UI.releaseAwake();
  }

  function fail(message) {
    stopCamera();
    errorBox.textContent = message;
    UI.setState("error");
  }

  function cameraError(err) {
    switch (err && err.name) {
      case "NotAllowedError":
      case "SecurityError":
        return "Camera access is blocked. Allow camera access for this site in your browser settings, then tap Try again.";
      case "NotFoundError":
      case "OverconstrainedError":
        return "No camera was found on this device.";
      case "NotReadableError":
        return "The camera is busy in another app. Close that app, then tap Try again.";
      default:
        return `The camera didn't start (${(err && err.name) || "unknown error"}). Tap Try again.`;
    }
  }

  async function start() {
    if (document.body.dataset.state === "scanning") return;
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    resultUrl = null;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      fail("This page needs a secure (https) connection to use the camera.");
      return;
    }
    if (mode) {
      // libcimbar's fountain sink ignores files it has already finished and has no reset
      // call; it is rebuilt only when the decode mode changes. Switch away so the next
      // detected mode starts a fresh sink, then detect the mode again.
      Module._cimbard_configure_decode(mode === 68 ? 66 : 68);
      Module._free(fountain.ptr);
      fountain = null;
      mode = 0;
    }
    frames = 0;
    lastSeen = lastBytes = -1000;
    setProgress(0);
    setStatus("Point the camera at the code on the other screen.");
    stage.hidden = false;
    UI.setState("scanning");
    UI.enterFullscreen();
    UI.keepAwake();
    const mine = ++session;

    try {
      const granted = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: "environment",
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 15 },
        },
      });
      if (mine !== session) {
        granted.getTracks().forEach((t) => t.stop()); // Stop was tapped while the camera started
        return;
      }
      stream = granted;
      video.srcObject = stream;
      await video.play();
    } catch (err) {
      if (mine === session) fail(cameraError(err));
      return;
    }
    if (mine !== session) return;
    running = true;
    schedule();
  }

  function cancel() {
    stopCamera();
    UI.setState("start");
  }

  // ---------- frame loop ----------

  function schedule() {
    if (!running) return;
    frameHandle = "requestVideoFrameCallback" in video
      ? video.requestVideoFrameCallback(onFrame)
      : requestAnimationFrame(onFrame);
  }

  async function onFrame() {
    if (!running) return;
    frames++;
    try {
      if (workersReady === workers.length && inFlight < MAX_IN_FLIGHT && video.videoWidth) {
        const msg = await grab(mode || MODES[frames % MODES.length]);
        if (msg && running) post(msg);
      }
      if (frames % 8 === 0) updateStatus();
    } catch {
      // A frame that can't be captured is skipped; the next one may work.
    } finally {
      schedule();
    }
  }

  async function grab(frameMode) {
    if (useVideoFrame) {
      let vf;
      try {
        vf = new VideoFrame(video, { timestamp: Math.round(performance.now() * 1000) });
      } catch {
        useVideoFrame = false;
        return null;
      }
      try {
        const opts = PIXEL_FORMATS.includes(vf.format) ? {} : { format: "RGBA" };
        const pixels = new Uint8Array(vf.allocationSize(opts));
        await vf.copyTo(pixels, opts);
        const format = opts.format || vf.format;
        if (format === "RGBA" && pixels.length !== vf.displayWidth * vf.displayHeight * 4) {
          useVideoFrame = false;
          return null;
        }
        return { pixels, format, width: vf.displayWidth, height: vf.displayHeight, mode: frameMode };
      } catch {
        useVideoFrame = false; // e.g. no RGBA conversion support: use the bitmap path
        return null;
      } finally {
        vf.close();
      }
    }
    const bitmap = await createImageBitmap(video);
    return { bitmap, format: "RGBA", width: video.videoWidth, height: video.videoHeight, mode: frameMode };
  }

  function post(msg) {
    const worker = workers[nextWorker++ % workers.length];
    inFlight++;
    try {
      worker.postMessage(msg, [msg.pixels ? msg.pixels.buffer : msg.bitmap]);
    } catch {
      inFlight--;
      if (msg.bitmap) msg.bitmap.close();
    }
  }

  function updateStatus() {
    if (frames - lastBytes < 30) setStatus(`Receiving… keep holding steady.`);
    else if (frames - lastSeen < 30) setStatus("Code found. Hold steady and fill more of the view with it.");
    else setStatus("Point the camera at the code on the other screen.");
  }

  // ---------- decoding ----------

  function onWorkerMessage(event) {
    const data = event.data;
    if (data.type === "startWasm") {
      workersReady++;
      return;
    }
    inFlight = Math.max(0, inFlight - 1);
    if (!running) return;
    if (data.buff && data.buff.length) {
      if (mode && data.mode !== mode) return;
      if (chunkFileId(data.buff) === lastId) {
        reloadAndScan();
        return;
      }
      lastSeen = lastBytes = frames;
      feed(data.buff, data.mode);
    } else if (data.nodata) {
      lastSeen = frames;
    }
  }

  // Every fountain chunk starts with its file id (4 bytes, little-endian).
  function chunkFileId(buff) {
    return (buff[0] | (buff[1] << 8) | (buff[2] << 16) | (buff[3] << 24)) >>> 0;
  }

  // libcimbar keeps only the file it rebuilt last and can't rebuild that id again in this
  // page load. Reload for a fresh decoder and carry on scanning.
  function reloadAndScan() {
    stopCamera();
    history.replaceState(null, "", "#scan");
    location.reload();
  }

  function feed(buff, frameMode) {
    if (!mode) {
      // First successful frame: lock the mode and size the fountain buffer for it.
      mode = frameMode;
      Module._cimbard_configure_decode(mode);
      fountain = alloc(Module._cimbard_get_bufsize());
    }
    if (buff.length > fountain.size) return;
    Module.HEAPU8.set(buff, fountain.ptr);
    const res = Module._cimbard_fountain_decode(fountain.ptr, buff.length);

    const report = readString(Module._cimbard_get_report);
    try {
      const parts = JSON.parse(report);
      if (Array.isArray(parts) && parts.length) setProgress(Math.max(...parts));
    } catch {
      // not a progress report
    }

    const complete = typeof res === "bigint" ? res > 0n : res > 0;
    if (complete) {
      const id = typeof res === "bigint" ? Number(res & 0xffffffffn) : res >>> 0;
      finish(id);
    }
  }

  function finish(id) {
    stopCamera();
    lastId = id;
    try {
      const name = readString((ptr, size) => Module._cimbard_get_filename(id, ptr, size)) || `received-${id}`;
      const chunkSize = Module._cimbard_get_decompress_bufsize();
      const buf = Module._malloc(chunkSize);
      const chunks = [];
      try {
        // A broken stream reads as 0 bytes once before the error code appears, so the
        // end of the file is two empty reads in a row.
        for (let empty = 0; empty < 2;) {
          const n = Module._cimbard_decompress_read(id, buf, chunkSize);
          if (n < 0) throw new Error(`decompress failed (${n})`);
          if (n === 0) {
            empty++;
          } else {
            empty = 0;
            chunks.push(Module.HEAPU8.slice(buf, buf + n));
          }
        }
      } finally {
        Module._free(buf);
      }
      showResult(name, new Blob(chunks, { type: "application/octet-stream" }));
    } catch (err) {
      fail(`The file arrived but couldn't be rebuilt (${err.message}). Tap Try again to receive it again.`);
    }
  }

  // The file is untrusted: it is offered only as a download or a share, never opened here.
  function showResult(name, blob) {
    resultUrl = URL.createObjectURL(blob);
    const save = UI.$("#save");
    save.href = resultUrl;
    save.download = name;
    UI.$("#recv-name").textContent = name;
    UI.$("#recv-size").textContent = UI.formatBytes(blob.size);

    const share = UI.$("#share");
    const file = new File([blob], name, { type: "application/octet-stream" });
    share.hidden = !(navigator.canShare && navigator.canShare({ files: [file] }));
    share.onclick = () => navigator.share({ files: [file], title: name }).catch(() => {});

    setProgress(1);
    UI.setState("done");
    save.focus();
  }

  // ---------- setup ----------

  const cores = navigator.hardwareConcurrency || 4;
  const workerCount = Math.max(3, Math.min(Math.floor(cores / 2) + 1, 6));
  for (let i = 0; i < workerCount; i++) {
    const w = new Worker(WORKER_URL);
    w.onmessage = onWorkerMessage;
    w.onerror = () => fail("The decoder failed to start. Reload the page to try again.");
    workers.push(w);
  }

  window.Module = {
    onRuntimeInitialized() {
      startBtn.textContent = "Start camera";
      startBtn.disabled = false;
      UI.setState("start");
      if (location.hash === "#scan") {
        history.replaceState(null, "", location.pathname);
        start();
      }
    },
    onAbort() {
      fail("The decoder failed to start. Reload the page to try again.");
    },
  };

  UI.$("#ring").setAttribute("stroke-dasharray", String(RING));
  setProgress(0);
  startBtn.addEventListener("click", start);
  UI.$("#retry").addEventListener("click", start);
  UI.$("#again").addEventListener("click", start);
  UI.$("#cancel").addEventListener("click", cancel);

  UI.registerSW();
})();
