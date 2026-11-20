"use strict";
// Send page. libcimbar's vendored encoder driver (vendor/cimbar/send.*.js) provides the
// global `Send` and calls back into the global `Report` defined below. This script must
// load before cimbar_js.*.js, which picks up `window.Module` when it starts.
(() => {
  const MODE_B = 68; // libcimbar's default mode; the receiver detects it automatically
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

  function showError(message) {
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
    if (!ready || !file) return;
    errorBox.hidden = true;
    UI.$("#name").textContent = file.name;
    UI.$("#size").textContent = UI.formatBytes(file.size);
    document.title = `Sending ${file.name} - Lumen Drop`;

    stage.hidden = false;
    UI.setState("playing");
    UI.enterFullscreen();
    fit();

    Send.importFile(file);
    if (!looping) {
      looping = true;
      Send.nextFrame(); // starts libcimbar's own requestAnimationFrame loop
    }
    UI.keepAwake();
  }

  function stop() {
    stage.hidden = true;
    UI.setState("pick");
    UI.exitFullscreen();
    UI.releaseAwake();
    input.value = ""; // lets the same file be picked again
    document.title = TITLE;
    choose.focus();
  }

  window.Report = {
    setTitle() {},       // we set our own title in play()
    setHTML() {},        // upstream status text; our UI shows its own
    setActive() {},      // the stage is already showing
    prevent_sleep() { UI.keepAwake(); },
    setAspectRatio(ratio) { aspect = ratio || 1; fit(); },
  };

  window.Module = {
    canvas,
    onRuntimeInitialized() {
      ready = true;
      Send.init_window(canvas);
      Send.setMode(MODE_B);
      choose.textContent = "Choose a file";
      choose.disabled = false;
      UI.setState("pick");
    },
    onAbort() {
      showError("The encoder failed to start. Reload the page to try again.");
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
