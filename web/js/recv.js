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
  let lastBytesAt = 0;    // time of the last data; a locked mode with none for a while is released
  const RELOCK_MS = 3000;
  let progress = 0;
  let mode = 0;
  let fountain = null;    // {ptr, size} in the WASM heap
  let scratch = null;     // {ptr, size} for report and file name strings
  // #debug-bitmap skips VideoFrame and uses the createImageBitmap path, for comparing the two.
  let useVideoFrame = typeof VideoFrame === "function" && location.hash !== "#debug-bitmap";
  let resultUrl = null;

  // Open recv.html#debug to see what the camera delivers and what the decoder says.
  const DEBUG = location.hash.startsWith("#debug");
  // ?camfps=30 asks for more camera frames per second, which also caps the shutter time
  // (iOS can expose for up to 1/fps), so fewer frames blend two codes together.
  const requestedFps = Number(new URLSearchParams(location.search).get("camfps"));
  const CAMERA_FPS = requestedFps >= 1 && requestedFps <= 60 ? requestedFps : 15;
  const stats = { frame: "", luma: "", posted: 0, bytes: 0, found: 0, missed: 0, errors: 0, last: "" };

  // Brightness of a sample of the pixels handed to the decoder: an all-black or flat frame
  // means the browser gave us no usable image.
  function lumaStats(px, format, width, height) {
    let min = 255;
    let max = 0;
    let sum = 0;
    let count = 0;
    for (let i = 0; i < width * height; i += 997) {
      const v = format === "RGBA" ? Math.round(px[i * 4] * 0.299 + px[i * 4 + 1] * 0.587 + px[i * 4 + 2] * 0.114) : px[i];
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
      count++;
    }
    return `luma min ${min} max ${max} mean ${Math.round(sum / count)}`;
  }
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
    if (DEBUG) showDebug();
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
          // Not 4K: libcimbar's decoder runs out of WASM memory on 2160x3840 frames.
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: CAMERA_FPS },
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
    // The sender may have switched symbol size: if the locked mode has gone quiet, detect
    // again. The same mode re-locks without losing progress (libcimbar keeps its sink).
    if (mode && performance.now() - lastBytesAt > RELOCK_MS) mode = 0;
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
        if (DEBUG) {
          const vr = vf.visibleRect || { width: 0, height: 0 };
          stats.frame = `VideoFrame ${vf.format} coded ${vf.codedWidth}x${vf.codedHeight} visible ${vr.width}x${vr.height} display ${vf.displayWidth}x${vf.displayHeight}${vf.rotation ? ` rotation ${vf.rotation}` : ""}`;
        }
        const opts = PIXEL_FORMATS.includes(vf.format) ? {} : { format: "RGBA" };
        const pixels = new Uint8Array(vf.allocationSize(opts));
        await vf.copyTo(pixels, opts);
        const format = opts.format || vf.format;
        if (format === "RGBA" && pixels.length !== vf.displayWidth * vf.displayHeight * 4) {
          useVideoFrame = false;
          return null;
        }
        if (DEBUG) stats.luma = lumaStats(pixels, format, vf.displayWidth, vf.displayHeight);
        return { pixels, format, width: vf.displayWidth, height: vf.displayHeight, mode: frameMode };
      } catch {
        useVideoFrame = false; // e.g. no RGBA conversion support: use the bitmap path
        return null;
      } finally {
        vf.close();
      }
    }
    if (DEBUG) {
      stats.frame = `bitmap ${video.videoWidth}x${video.videoHeight}`;
      stats.luma = "luma n/a (converted in the worker)";
    }
    const bitmap = await createImageBitmap(video);
    return { bitmap, format: "RGBA", width: video.videoWidth, height: video.videoHeight, mode: frameMode };
  }

  function post(msg) {
    const worker = workers[nextWorker++ % workers.length];
    inFlight++;
    stats.posted++;
    try {
      worker.postMessage(msg, [msg.pixels ? msg.pixels.buffer : msg.bitmap]);
    } catch {
      inFlight--;
      if (msg.bitmap) msg.bitmap.close();
    }
  }

  // Debug: save the current camera frame at full resolution, to study it offline.
  function saveFrame() {
    const c = document.createElement("canvas");
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    c.getContext("2d").drawImage(video, 0, 0);
    c.toBlob((blob) => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `lumen-frame-${c.width}x${c.height}-${frames}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }, "image/png");
  }

  function showDebug() {
    const box = UI.$("#debug");
    box.hidden = false;
    box.textContent = [
      `frame ${stats.frame || "(none yet)"}`,
      `pixels ${stats.luma || "-"}`,
      `video ${video.videoWidth}x${video.videoHeight}  workers ${workersReady}/${workers.length}  mode ${mode || "auto"}`,
      `frames ${frames}  posted ${stats.posted}  in flight ${inFlight}`,
      `replies: data ${stats.bytes}  code found ${stats.found}  no code ${stats.missed}  errors ${stats.errors}`,
      `last: ${stats.last || "-"}`,
      navigator.userAgent,
    ].join("\n");
  }

  function updateStatus() {
    if (DEBUG) showDebug();
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
    if (DEBUG) {
      if (data.buff && data.buff.length) stats.bytes++;
      else if (data.nodata) stats.found++;
      else if (data.failed_extract) stats.missed++;
      else stats.errors++;
      if (typeof data.res === "string" || typeof data.error === "string") stats.last = String(data.res || data.error).slice(0, 160);
    }
    if (!running) return;
    if (data.buff && data.buff.length) {
      if (mode && data.mode !== mode) return;
      if (chunkFileId(data.buff) === lastId) {
        reloadAndScan();
        return;
      }
      lastSeen = lastBytes = frames;
      lastBytesAt = performance.now();
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
      if (fountain) Module._free(fountain.ptr);
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
  if (DEBUG) {
    UI.$("#save-frame").hidden = false;
    UI.$("#save-frame").addEventListener("click", saveFrame);
  }

  UI.registerSW();
})();
