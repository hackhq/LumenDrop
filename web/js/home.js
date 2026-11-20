"use strict";
// Home hero: one frozen "frame" of color symbols that lights up once, like a code being sent.
(() => {
  const plate = UI.$(".plate");
  const colors = ["var(--cyan)", "var(--yellow)", "var(--magenta)", "var(--green)"];
  const cols = 12;
  const rows = 7;
  const anchors = new Set([0, cols - 1, (rows - 1) * cols]); // corner finder marks, as on a real cimbar frame

  let seed = 11; // fixed seed: the same frame on every visit
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

  plate.style.setProperty("--cols", cols);
  const frag = document.createDocumentFragment();
  for (let i = 0; i < rows * cols; i++) {
    const cell = document.createElement("span");
    cell.className = anchors.has(i) ? "cell cell--anchor" : "cell";
    cell.style.setProperty("--c", colors[Math.floor(rand() * colors.length)]);
    cell.style.setProperty("--d", ((i % cols) + Math.floor(i / cols)) * 40);
    if (!anchors.has(i) && rand() < 0.3) cell.style.setProperty("--o", 0.16);
    frag.append(cell);
  }
  plate.append(frag);

  UI.registerSW();
})();
