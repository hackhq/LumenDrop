"use strict";
// Helpers shared by every page. Plain global, loaded first with `defer`.
const UI = (() => {
  let wakeLock = null;
  let wantAwake = false;

  async function requestWake() {
    if (!wantAwake || wakeLock || !("wakeLock" in navigator) || document.visibilityState !== "visible") return;
    try {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    } catch {
      // Denied or unsupported: the screen may dim, nothing else breaks.
    }
  }
  // The browser drops the lock whenever the tab is hidden; take it back on return.
  document.addEventListener("visibilitychange", requestWake);

  return {
    $: (selector, root = document) => root.querySelector(selector),

    formatBytes(n) {
      if (!Number.isFinite(n) || n < 0) return "";
      const units = ["B", "KB", "MB", "GB"];
      let i = 0;
      while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
      return `${i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
    },

    // Pages show and hide their sections with CSS keyed on body[data-state].
    setState(name) { document.body.dataset.state = name; },

    keepAwake() { wantAwake = true; requestWake(); },
    releaseAwake() {
      wantAwake = false;
      if (wakeLock) wakeLock.release().catch(() => {});
      wakeLock = null;
    },

    // The fixed full-viewport stage is the real mechanism (iPhone Safari has no
    // Fullscreen API); real fullscreen is an extra where the browser allows it.
    enterFullscreen() {
      document.documentElement.classList.add("is-immersive");
      const el = document.documentElement;
      if (el.requestFullscreen && !document.fullscreenElement) {
        el.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
      }
    },
    exitFullscreen() {
      document.documentElement.classList.remove("is-immersive");
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    },

    registerSW() {
      if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
    },
  };
})();
