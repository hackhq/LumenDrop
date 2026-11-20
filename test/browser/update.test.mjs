// A deploy must reach people without a second manual reload, but never mid-transfer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import { ROOT, OUT, sleep, launchBrowser, openPage } from "./harness.mjs";

const PORT = 18086;
const base = `http://127.0.0.1:${PORT}/`;

// Builds the current working tree, optionally with a marker in the home page, as a separate binary.
function buildVariant(marker) {
  const dir = mkdtempSync(join(OUT, "variant-"));
  for (const f of ["go.mod", "main.go", "server.go", "sw.go"]) cpSync(join(ROOT, f), join(dir, f));
  cpSync(join(ROOT, "web"), join(dir, "web"), { recursive: true });
  if (marker) {
    const page = join(dir, "web", "index.html");
    const html = readFileSync(page, "utf8");
    const changed = html.replace("Works offline after the first visit.", `Works offline after the first visit. ${marker}`);
    assert.notEqual(changed, html, "marker not inserted");
    writeFileSync(page, changed);
  }
  execFileSync("go", ["build", "-o", join(dir, "bin"), "."], { cwd: dir, stdio: "inherit" });
  return dir;
}

async function serve(dir) {
  const proc = spawn(join(dir, "bin"), ["-addr", `127.0.0.1:${PORT}`], { stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(base);
      return proc;
    } catch {
      await sleep(100);
    }
  }
  proc.kill();
  throw new Error("variant server did not start");
}

async function swapServer(proc, dir) {
  proc.kill();
  await sleep(300);
  return serve(dir);
}

const v1 = buildVariant(null);
const v2 = buildVariant("[v2]");
process.on("exit", () => {
  rmSync(v1, { recursive: true, force: true });
  rmSync(v2, { recursive: true, force: true });
});

test("a deploy reaches an open app after one reload", async () => {
  let proc = await serve(v1);
  const browser = await launchBrowser();
  try {
    const page = await openPage(browser, base);
    await page.waitFor("navigator.serviceWorker.controller !== null", 20000);
    proc = await swapServer(proc, v2);
    await page.goto(base); // the single reload a person does
    await page.waitFor("document.querySelector('.credit').textContent.includes('[v2]')", 20000);
  } finally {
    await browser.close();
    proc.kill();
  }
});

test("an update never reloads a page that is sending", async () => {
  let proc = await serve(v1);
  const browser = await launchBrowser();
  try {
    const page = await openPage(browser, base + "send.html");
    await page.waitFor("navigator.serviceWorker.controller !== null", 20000);
    await page.goto(base + "send.html"); // a return visit: this page loads under the service worker
    await page.waitFor("!document.querySelector('#choose').disabled", 20000);
    writeFileSync(join(OUT, "fixtures", "update.txt"), "update test\n");
    await page.setFiles("#file", [join(OUT, "fixtures", "update.txt")]);
    await page.waitFor("document.body.dataset.state === 'playing'");
    await page.eval(`(window.__samePage = true, navigator.serviceWorker.addEventListener("controllerchange", () => { window.__changed = true; }), true)`);
    proc = await swapServer(proc, v2);
    await page.eval("navigator.serviceWorker.getRegistration().then((r) => r.update()).then(() => true)");
    await page.waitFor("window.__changed === true", 20000);
    await sleep(1000);
    assert.equal(await page.eval("window.__samePage === true && document.body.dataset.state"), "playing");
  } finally {
    await browser.close();
    proc.kill();
  }
});
