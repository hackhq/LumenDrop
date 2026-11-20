import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { OUT, sleep, startServer, launchBrowser, openPage, foreignRequests, decodePNG, colorfulFraction } from "./harness.mjs";

const FIX = join(OUT, "fixtures");
const small = join(FIX, "small.bin");
const second = join(FIX, "second.txt");
const markup = join(FIX, "<img src=x onerror=alert(1)>.txt");

let server, browser;
before(async () => {
  mkdirSync(FIX, { recursive: true });
  writeFileSync(small, randomBytes(4096));
  writeFileSync(second, "hello from the second file\n");
  writeFileSync(markup, "markup name\n");
  server = await startServer(18092);
  browser = await launchBrowser();
});
after(async () => { await browser?.close(); server?.stop(); });

const ready = "!document.querySelector('#choose').disabled";

async function play(page, file) {
  await page.waitFor(ready, 20000);
  await page.setFiles("#file", [file]);
  await page.waitFor("document.body.dataset.state === 'playing'");
  await sleep(1500); // let a few frames render
}

async function canvasRect(page) {
  return page.eval(`(() => {
    const r = document.querySelector('#canvas').getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight };
  })()`);
}

test("send page loads the encoder and offers a file picker", async () => {
  const page = await openPage(browser, server.base + "send.html");
  assert.equal(await page.eval("document.title"), "Send a file - Lumen Drop");
  assert.equal(await page.eval("document.querySelector('h1').textContent"), "Send a file");
  assert.equal(await page.eval("document.querySelector('a.back').getAttribute('href')"), "./");
  await page.waitFor(ready, 20000);
  assert.match(await page.eval("document.querySelector('.caution').textContent"), /Flashing colors/);
  assert.deepEqual(page.log.errors, []);
  assert.deepEqual(foreignRequests(page.log, server.base), []);
  await page.close();
});

for (const [name, opts] of [["desktop", { width: 1280, height: 800 }], ["phone", { width: 390, height: 844, mobile: true }]]) {
  test(`picking a file plays a barcode that fits the ${name} screen`, async () => {
    const page = await openPage(browser, server.base + "send.html", opts);
    await play(page, small);
    const r = await canvasRect(page);
    assert.ok(r.w > 200 && r.h > 200, `canvas too small: ${JSON.stringify(r)}`);
    assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= r.vw + 0.5 && r.y + r.h <= r.vh + 0.5, `canvas off screen: ${JSON.stringify(r)}`);
    assert.equal(await page.eval("document.querySelector('#name').textContent"), "small.bin");
    assert.equal(await page.eval("document.querySelector('#size').textContent"), "4.0 KB");
    const shot = decodePNG(await page.capture());
    assert.ok(colorfulFraction(shot, r) > 0.05, "barcode area should contain colored symbols");
    await page.screenshot(`send-playing-${name}.png`);
    assert.deepEqual(page.log.errors, []);
    await page.close();
  });
}

test("Stop returns to the picker and a second file plays", async () => {
  const page = await openPage(browser, server.base + "send.html");
  await play(page, small);
  await page.eval("document.querySelector('#stop').click()");
  await page.waitFor("document.body.dataset.state === 'pick'");
  assert.equal(await page.eval("document.querySelector('#stage').hidden"), true);
  await play(page, second);
  assert.equal(await page.eval("document.querySelector('#name').textContent"), "second.txt");
  assert.deepEqual(page.log.errors, []);
  await page.close();
});

test("a file name with markup is shown as plain text", async () => {
  const page = await openPage(browser, server.base + "send.html");
  await play(page, markup);
  assert.equal(await page.eval("document.querySelector('#name').textContent"), "<img src=x onerror=alert(1)>.txt");
  assert.equal(await page.eval("document.querySelector('#stage img')"), null);
  assert.deepEqual(page.log.errors, []);
  await page.close();
});

test("without WebGL the page explains instead of going blank", async () => {
  const noGL = await launchBrowser(["--disable-webgl", "--disable-3d-apis"]);
  try {
    const page = await openPage(noGL, server.base + "send.html");
    await page.waitFor("document.body.dataset.state === 'error'");
    assert.match(await page.eval("document.querySelector('#error').textContent"), /WebGL/);
    assert.equal(await page.eval("document.querySelector('#choose').disabled"), true);
    assert.equal(await page.eval("getComputedStyle(document.querySelector('#drop')).display"), "none", "no useless picker");
    await page.screenshot("send-no-webgl.png");
  } finally {
    await noGL.close();
  }
});

// ---- review fixes ----

async function spyEncoder(page) {
  await page.eval(`(() => {
    window.__enc = [];
    const init = Module._cimbare_init_encode;
    Module._cimbare_init_encode = (...a) => { __enc.push({ init: true }); return init(...a); };
    const enc = Module._cimbare_encode;
    Module._cimbare_encode = (p, n) => { const r = enc(p, n); __enc.push({ n, r }); return r; };
    return true;
  })()`);
}

test("picking another file while one is still being prepared never mixes their bytes", async () => {
  const a = join(FIX, "A.bin");
  const b = join(FIX, "B.bin");
  writeFileSync(a, randomBytes(9 * 1024 * 1024));
  writeFileSync(b, randomBytes(5 * 1024 * 1024));
  const page = await openPage(browser, server.base + "send.html");
  await page.waitFor(ready, 20000);
  await spyEncoder(page);
  await page.setFiles("#file", [a]);
  await sleep(60);
  await page.eval("document.querySelector('#stop').click()");
  await page.setFiles("#file", [b]);
  await page.waitFor("!document.querySelector('#stage').classList.contains('is-preparing') && document.body.dataset.state === 'playing'", 30000);
  await sleep(500);
  const log = await page.eval("__enc");
  const lastInit = log.map((e) => !!e.init).lastIndexOf(true);
  const afterB = log.slice(lastInit + 1).reduce((s, e) => s + (e.n || 0), 0);
  assert.equal(afterB, 5 * 1024 * 1024, "only B's bytes may follow B's init");
  assert.equal(await page.eval("document.querySelector('#name').textContent"), "B.bin");
  assert.deepEqual(page.log.errors, []);
  await page.close();
});

test("a file the encoder can't prepare closes the stage and explains", async () => {
  const page = await openPage(browser, server.base + "send.html");
  await page.waitFor(ready, 20000);
  // Skipping init leaves libcimbar without a compressor, so its encode genuinely returns -1.
  await page.eval("Module._cimbare_init_encode = () => 0, true");
  await page.setFiles("#file", [small]);
  await page.waitFor("document.body.dataset.state === 'error'");
  assert.equal(await page.eval("document.querySelector('#stage').hidden"), true);
  assert.match(await page.eval("document.querySelector('#error').textContent"), /couldn't prepare/);
  await page.close();
});

test("a file too big for browser memory closes the stage and says so", async () => {
  const big = join(FIX, "big.bin");
  writeFileSync(big, randomBytes(40 * 1024 * 1024));
  const page = await openPage(browser, server.base + "send.html");
  await page.waitFor(ready, 20000);
  await page.setFiles("#file", [big]);
  await page.waitFor("document.body.dataset.state === 'error'", 60000);
  assert.equal(await page.eval("document.querySelector('#stage').hidden"), true);
  assert.match(await page.eval("document.querySelector('#error').textContent"), /too big/);
  await page.screenshot("send-too-big.png");
  await page.close();
});

test("after Stop the page no longer keeps the screen awake", async () => {
  const page = await openPage(browser, server.base + "send.html");
  await page.eval(`(() => {
    window.__wake = 0;
    const fake = { release: async () => {}, addEventListener() {} };
    Object.defineProperty(navigator, "wakeLock", { value: { request: async () => { __wake++; return fake; } } });
    return true;
  })()`);
  await play(page, small);
  await page.eval("document.querySelector('#stop').click()");
  const before = await page.eval("__wake");
  await sleep(3000);
  assert.equal(await page.eval("__wake"), before, "wake lock requested again after Stop");
  await page.close();
});
