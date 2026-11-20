"use strict";
// Send page. libcimbar's vendored encoder driver (vendor/cimbar/send.*.js) provides the
// global `Send` and calls back into the global `Report` defined below. This script must
// load before cimbar_js.*.js, which picks up `window.Module` when it starts.
(() => {
  // libcimbar modes by symbol size on screen: S = B (68, default), M = Bm (67), L = Bu (66).
  // Larger symbols suit weaker cameras but carry less per frame. The receiver detects the mode.
  const MODES = [68, 67, 66];
  const DEFAULT_MODE = 68;
  const MODE_KEY = "lumen-send-mode";
  const DEFAULT_FPS = 15;
  const FPS_KEY = "lumen-send-fps";
  const TITLE = document.title;

  const canvas = UI.$("#canvas");
  const area = UI.$("#area");
  const stage = UI.$("#stage");
  const choose = UI.$("#choose");
  const input = UI.$("#file");
  const errorBox = UI.$("#error");

  let ready = false;
  let looping = false;
  let aspect = 1;
  let importing = false; // libcimbar is still reading/compressing a file
  let outcome = null;    // first decisive encode result of the current import: 0 = ready, < 0 = failed
  let pending = null;    // a file picked meanwhile; starts when the current import ends
  let currentFile = null; // the file on screen, re-encoded when the symbol size changes

  function showError(message) {
    stage.hidden = true;
    UI.exitFullscreen();
    UI.releaseAwake();
    errorBox.textContent = message;
    errorBox.hidden = false;
    choose.disabled = true;
    UI.setState("error");
  }

  // Size the canvas to the largest box with the code's aspect ratio that fits the stage,
  // turning the code sideways when that uses a portrait screen better.
  function fit() {
    const pad = getComputedStyle(area);
    const w = area.clientWidth - parseFloat(pad.paddingLeft) - parseFloat(pad.paddingRight);
    const h = area.clientHeight - parseFloat(pad.paddingTop) - parseFloat(pad.paddingBottom);
    if (!ready || !w || !h) return;
    const rotate = aspect > 1 && h > w;
    Send.rotate_window(rotate);
    const long = rotate ? h : w;
    const short = rotate ? w : h;
    let codeW = long;
    let codeH = long / aspect;
    if (codeH > short) {
      codeH = short;
      codeW = short * aspect;
    }
    canvas.style.width = `${Math.floor(rotate ? codeH : codeW)}px`;
    canvas.style.height = `${Math.floor(rotate ? codeW : codeH)}px`;
  }

  function play(file) {
    if (!ready || !file || document.body.dataset.state === "error") return;
    currentFile = file;
    errorBox.hidden = true;
    UI.$("#name").textContent = file.name;
    UI.$("#size").textContent = UI.formatBytes(file.size);
    document.title = `Sending ${file.name} - Lumen Drop`;

    stage.hidden = false;
    stage.classList.add("is-preparing");
    UI.setState("playing");
    UI.enterFullscreen();
    fit();
    UI.keepAwake();

    // libcimbar's import can't be cancelled and feeds one shared compressor, so a
    // second import must wait for the first to end or their bytes would mix.
    if (importing) pending = file;
    else begin(file);
  }

  function begin(file) {
    importing = true;
    outcome = null;
    Send.importFile(file);
    if (!looping) {
      looping = true;
      Send.nextFrame(); // starts libcimbar's own requestAnimationFrame loop
    }
  }

  // Called for every chunk libcimbar's encoder takes. Results: 1 = more to come, 0 = the file
  // is ready, negative = failure (a flush after "ready" also returns -1, which is harmless).
  // The driver always ends an import with one zero-length flush, so that call, not the
  // first 0, is when the next import may start.
  function onEncoded(result, len) {
    if (!importing) return;
    if (outcome === null && (result === 0 || (result < 0 && len > 0))) outcome = result;
    if (len > 0) return;
    if (outcome === null) outcome = result;
    importing = false;
    if (pending) {
      const next = pending;
      pending = null;
      begin(next);
      return;
    }
    if (document.body.dataset.state !== "playing") return; // stopped meanwhile
    if (outcome === 0) stage.classList.remove("is-preparing");
    else showError(`Lumen Drop couldn't prepare this file for sending (error ${outcome}). Try a smaller file, or reload the page.`);
  }

  function stop() {
    currentFile = null;
    stage.hidden = true;
    UI.setState("pick");
    UI.exitFullscreen();
    UI.releaseAwake();
    input.value = ""; // lets the same file be picked again
    document.title = TITLE;
    choose.focus();
  }

  // Slower speeds keep each frame up longer, which helps cameras that blend consecutive
  // frames (slow shutter in dim rooms, slow LCDs). Changes apply immediately.
  function setSpeed(fps) {
    Send.setFPS(fps);
    for (const b of document.querySelectorAll("[data-fps]")) {
      b.setAttribute("aria-pressed", String(Number(b.dataset.fps) === fps));
    }
  }

  function setSymbolMode(mode) {
    Send.setMode(mode); // reports the new aspect ratio, which re-fits the canvas
    for (const b of document.querySelectorAll("[data-mode]")) {
      b.setAttribute("aria-pressed", String(Number(b.dataset.mode) === mode));
    }
  }

  function initialMode() {
    try {
      const saved = Number(localStorage.getItem(MODE_KEY));
      if (MODES.includes(saved)) return saved;
    } catch {
      // storage unavailable: use the default
    }
    return DEFAULT_MODE;
  }

  function initialSpeed() {
    const fromUrl = Number(new URLSearchParams(location.search).get("fps"));
    if (fromUrl >= 1 && fromUrl <= 30) return fromUrl;
    try {
      const saved = Number(localStorage.getItem(FPS_KEY));
      if (saved >= 1 && saved <= 30) return saved;
    } catch {
      // storage unavailable (private mode): use the default
    }
    return DEFAULT_FPS;
  }

  window.Report = {
    setTitle() {},       // we set our own title in play()
    setHTML() {},        // upstream status text; our UI shows its own
    setActive() {},      // the stage is already showing
    prevent_sleep() {
      // libcimbar's loop keeps calling this after Stop; only honor it while sending.
      if (document.body.dataset.state === "playing") UI.keepAwake();
    },
    setAspectRatio(ratio) { aspect = ratio || 1; fit(); },
  };

  window.Module = {
    canvas,
    onRuntimeInitialized() {
      ready = true;
      Send.init_window(canvas);
      setSymbolMode(initialMode());
      setSpeed(initialSpeed());
      const encode = Module._cimbare_encode;
      Module._cimbare_encode = (ptr, len) => {
        const result = encode(ptr, len);
        onEncoded(result, len);
        return result;
      };
      choose.textContent = "Choose a file";
      choose.disabled = false;
      UI.setState("pick");
    },
    onAbort() {
      showError(importing
        ? "This file is too big for this browser's memory. Reload the page, then try a smaller file."
        : "The encoder stopped working. Reload the page to try again.");
    },
  };

  const probe = document.createElement("canvas");
  if (!probe.getContext("webgl2") && !probe.getContext("webgl")) {
    // cimbar_js would fail later anyway; stop it from trying.
    window.Module.onRuntimeInitialized = () => {};
    showError("This browser has WebGL turned off, so it can't draw the codes. Turn on hardware acceleration in its settings, or use another browser.");
  }

  choose.addEventListener("click", () => input.click());
  input.addEventListener("change", () => play(input.files[0]));
  UI.$("#stop").addEventListener("click", stop);
  for (const b of document.querySelectorAll("[data-mode]")) {
    b.addEventListener("click", () => {
      const mode = Number(b.dataset.mode);
      setSymbolMode(mode);
      try {
        localStorage.setItem(MODE_KEY, String(mode));
      } catch {
        // not remembered; still applies now
      }
      // Re-encode for the new layout (libcimbar drops streams that don't fit a new mode).
      if (currentFile && document.body.dataset.state === "playing") play(currentFile);
    });
  }
  for (const b of document.querySelectorAll("[data-fps]")) {
    b.addEventListener("click", () => {
      const fps = Number(b.dataset.fps);
      setSpeed(fps);
      try {
        localStorage.setItem(FPS_KEY, String(fps));
      } catch {
        // not remembered; still applies now
      }
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.body.dataset.state === "playing") stop();
  });
  window.addEventListener("resize", fit);

  // Drop a file anywhere on the page.
  document.addEventListener("dragover", (e) => {
    e.preventDefault();
    UI.$("#drop").classList.add("is-over");
  });
  document.addEventListener("dragleave", (e) => {
    if (!e.relatedTarget) UI.$("#drop").classList.remove("is-over");
  });
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    UI.$("#drop").classList.remove("is-over");
    play(e.dataTransfer.files[0]);
  });

  UI.registerSW();
})();
