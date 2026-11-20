// End-to-end: record the send page's barcode as an MJPEG "camera", then decode it on the
// receive page and check the saved file byte for byte.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OUT, sleep, startServer, launchBrowser, openPage, foreignRequests } from "./harness.mjs";

const FIX = join(OUT, "fixtures");
const NAME = "<img src=x onerror=alert(1)>.bin"; // hostile name travels inside the barcode
const source = join(FIX, NAME);
const video = join(OUT, "sender.mjpeg");
const downloads = join(OUT, "downloads");
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

let server, payload;
before(async () => {
  mkdirSync(FIX, { recursive: true });
  payload = randomBytes(20 * 1024);
  writeFileSync(source, payload);
  server = await startServer(18093);

  // Record the sender.
  const sender = await launchBrowser();
  try {
    const page = await openPage(sender, server.base + "send.html", { width: 1280, height: 900 });
    await page.waitFor("!document.querySelector('#choose').disabled", 20000);
    await page.setFiles("#file", [source]);
    await page.waitFor("document.body.dataset.state === 'playing'");
    await sleep(1000);
    const frames = [];
    for (let i = 0; i < 90; i++) frames.push(await page.capture("jpeg", 92));
    writeFileSync(video, Buffer.concat(frames));
  } finally {
    await sender.close();
  }
});
after(() => server?.stop());

const ready = "!document.querySelector('#start').disabled";

async function downloadVia(page, cdp) {
  rmSync(downloads, { recursive: true, force: true });
  mkdirSync(downloads, { recursive: true });
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: downloads, eventsEnabled: true });
  const done = new Promise((resolve) => {
    let suggested;
    const off = cdp.on((msg) => {
      if (msg.method === "Browser.downloadWillBegin") suggested = msg.params.suggestedFilename;
      if (msg.method === "Browser.downloadProgress" && msg.params.state === "completed") {
        off();
        resolve({ guid: msg.params.guid, suggested });
      }
    });
  });
  await page.eval("document.querySelector('#save').click()");
  const { guid, suggested } = await done;
  return { bytes: readFileSync(join(downloads, guid)), suggested };
}

test("receive page decodes the sender's barcode and saves the exact file", async () => {
  const browser = await launchBrowser([
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-video-capture=${video}`,
  ]);
  try {
    const page = await openPage(browser, server.base + "recv.html", { width: 390, height: 844, mobile: true });
    assert.equal(await page.eval("document.title"), "Receive a file - Lumen Drop");
    await page.waitFor(ready, 20000);
    await page.eval("document.querySelector('#start').click()");
    await page.waitFor("document.body.dataset.state === 'scanning'");
    await sleep(1500);
    await page.screenshot("recv-scanning-phone.png");
    await page.waitFor("document.body.dataset.state === 'done'", 90000);

    assert.equal(await page.eval("document.querySelector('#recv-name').textContent"), NAME);
    assert.equal(await page.eval("document.querySelector('#result img')"), null);
    assert.equal(await page.eval("document.querySelector('#recv-size').textContent"), "20 KB");
    assert.equal(await page.eval("document.querySelector('#save').getAttribute('download')"), NAME);
    assert.equal(await page.eval("document.querySelector('#video').srcObject"), null, "camera stopped");
    await page.screenshot("recv-done-phone.png");

    const { bytes, suggested } = await downloadVia(page, browser.cdp);
    assert.equal(sha256(bytes), sha256(payload));
    assert.ok(!suggested.includes("/"), `unsafe download name: ${suggested}`);

    // A second transfer in the same session. The sender still shows the same file, which
    // libcimbar can't rebuild twice in one page load: the page must notice on the first
    // chunk (before any progress) and reload to scan again.
    await page.eval(`(() => {
      const pct = document.querySelector('#pct');
      new MutationObserver(() => sessionStorage.setItem('oldPagePct', pct.textContent))
        .observe(pct, { childList: true, characterData: true, subtree: true });
      return true;
    })()`);
    await page.eval("document.querySelector('#again').click()");
    await page.waitFor("document.body.dataset.state === 'scanning'");
    await page.waitFor("document.body.dataset.state === 'done'", 90000);
    const again = await downloadVia(page, browser.cdp);
    assert.equal(sha256(again.bytes), sha256(payload));
    assert.equal(await page.eval("sessionStorage.getItem('oldPagePct')"), "0%", "repeat must be caught before receiving it");

    assert.deepEqual(page.log.errors, []);
    assert.deepEqual(foreignRequests(page.log, server.base), []);
  } finally {
    await browser.close();
  }
});

test("blocked camera shows how to fix it and a retry button", async () => {
  const browser = await launchBrowser(["--use-fake-device-for-media-stream"]);
  try {
    await browser.cdp.send("Browser.setPermission", {
      permission: { name: "camera" }, setting: "denied", origin: server.base.replace(/\/$/, ""),
    });
    const page = await openPage(browser, server.base + "recv.html");
    await page.waitFor(ready, 20000);
    await page.eval("document.querySelector('#start').click()");
    await page.waitFor("document.body.dataset.state === 'error'");
    assert.match(await page.eval("document.querySelector('#error').textContent"), /Camera access is blocked/);
    assert.equal(await page.eval("getComputedStyle(document.querySelector('#retry')).display !== 'none'"), true);
    assert.equal(await page.eval("document.querySelector('#stage').hidden"), true);
    await page.screenshot("recv-blocked.png");
    assert.deepEqual(page.log.errors, []);
  } finally {
    await browser.close();
  }
});

// ---- review fixes ----

const fakeCam = () => launchBrowser([
  "--use-fake-ui-for-media-stream",
  "--use-fake-device-for-media-stream",
  `--use-file-for-fake-video-capture=${video}`,
]);

test("Stop while the camera is still starting leaves no camera running", async () => {
  const browser = await fakeCam();
  try {
    const page = await openPage(browser, server.base + "recv.html");
    await page.waitFor(ready, 20000);
    await page.eval(`(() => {
      window.__streams = [];
      const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = (c) =>
        new Promise((r) => setTimeout(r, 1500)).then(() => gum(c)).then((s) => (__streams.push(s), s));
      return true;
    })()`);
    await page.eval("document.querySelector('#start').click()");
    await page.eval("document.querySelector('#cancel').click()");
    await sleep(2500);
    assert.equal(await page.eval("document.body.dataset.state"), "start");
    assert.equal(await page.eval("document.querySelector('#video').srcObject"), null);
    assert.equal(await page.eval("__streams.length"), 1);
    assert.equal(await page.eval("__streams.every((s) => s.getTracks().every((t) => t.readyState === 'ended'))"), true, "camera left running");
    assert.deepEqual(page.log.errors, []);
  } finally {
    await browser.close();
  }
});

test("a frame that fails to capture doesn't stop scanning", async () => {
  const browser = await fakeCam();
  try {
    const page = await openPage(browser, server.base + "recv.html");
    await page.waitFor(ready, 20000);
    await page.eval(`(() => {
      delete window.VideoFrame; // force the createImageBitmap path
      const orig = window.createImageBitmap;
      let calls = 0;
      window.createImageBitmap = (...a) => (++calls === 1 ? Promise.reject(new Error("capture failed")) : orig(...a));
      return true;
    })()`);
    await page.eval("document.querySelector('#start').click()");
    await page.waitFor("document.body.dataset.state === 'done'", 60000);
    assert.equal(await page.eval("document.querySelector('#recv-name').textContent"), NAME);
  } finally {
    await browser.close();
  }
});

test("a broken compressed stream is reported, not saved as a short file", async () => {
  const browser = await fakeCam();
  try {
    const page = await openPage(browser, server.base + "recv.html");
    await page.waitFor(ready, 20000);
    // libcimbar signals a zstd error with 0 bytes first and the error code on the next read.
    await page.eval(`(() => {
      const read = Module._cimbard_decompress_read;
      let calls = 0;
      Module._cimbard_decompress_read = (id, buf, size) => (++calls === 2 ? 0 : calls === 3 ? -14 : read(id, buf, size));
      return true;
    })()`);
    await page.eval("document.querySelector('#start').click()");
    await page.waitFor("['done', 'error'].includes(document.body.dataset.state)", 60000);
    assert.equal(await page.eval("document.body.dataset.state"), "error");
    assert.match(await page.eval("document.querySelector('#error').textContent"), /couldn't be rebuilt/);
  } finally {
    await browser.close();
  }
});

test("recv.html#debug shows live decoder diagnostics", async () => {
  // Chrome's built-in test pattern has no code in it, so the page keeps scanning.
  const browser = await launchBrowser(["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"]);
  try {
    const page = await openPage(browser, server.base + "recv.html#debug");
    await page.waitFor(ready, 20000);
    await page.eval("document.querySelector('#start').click()");
    await page.waitFor("document.body.dataset.state === 'scanning'");
    await page.waitFor("/workers \\d+\\/\\d+/.test(document.querySelector('#debug').textContent)", 10000);
    const text = await page.eval("document.querySelector('#debug').textContent");
    assert.match(text, /frame (VideoFrame|bitmap)/);
    assert.match(text, /video \d+x\d+/);
    assert.match(text, /posted \d+/);
    assert.match(text, /pixels luma min \d+ max \d+ mean \d+/);
    assert.equal(await page.eval("document.querySelector('#debug').hidden"), false);
  } finally {
    await browser.close();
  }
});

test("debug panel stays hidden without #debug", async () => {
  const browser = await fakeCam();
  try {
    const page = await openPage(browser, server.base + "recv.html");
    await page.waitFor(ready, 20000);
    assert.equal(await page.eval("document.querySelector('#debug')?.hidden"), true);
  } finally {
    await browser.close();
  }
});

test("recv.html#debug-bitmap forces the createImageBitmap path and still decodes", async () => {
  const browser = await fakeCam();
  try {
    const page = await openPage(browser, server.base + "recv.html#debug-bitmap");
    await page.waitFor(ready, 20000);
    await page.eval("document.querySelector('#start').click()");
    await page.waitFor("/frame bitmap/.test(document.querySelector('#debug').textContent) || document.body.dataset.state === 'done'", 20000);
    await page.waitFor("document.body.dataset.state === 'done'", 60000);
    assert.match(await page.eval("document.querySelector('#debug').textContent"), /frame bitmap/);
  } finally {
    await browser.close();
  }
});

test("#debug Save frame downloads a full-resolution PNG of the camera frame", async () => {
  const browser = await launchBrowser(["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"]);
  try {
    const page = await openPage(browser, server.base + "recv.html#debug");
    await page.waitFor(ready, 20000);
    await page.eval("document.querySelector('#start').click()");
    await page.waitFor("document.body.dataset.state === 'scanning' && document.querySelector('#video').videoWidth > 0");
    const [w, h] = await page.eval("[document.querySelector('#video').videoWidth, document.querySelector('#video').videoHeight]");
    rmSync(downloads, { recursive: true, force: true });
    mkdirSync(downloads, { recursive: true });
    await browser.cdp.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: downloads, eventsEnabled: true });
    const done = new Promise((resolve) => {
      const off = browser.cdp.on((m) => {
        if (m.method === "Browser.downloadProgress" && m.params.state === "completed") { off(); resolve(m.params.guid); }
      });
    });
    assert.equal(await page.eval("document.querySelector('#save-frame').hidden"), false);
    await page.eval("document.querySelector('#save-frame').click()");
    const png = readFileSync(join(downloads, await done));
    assert.equal(png.toString("latin1", 1, 4), "PNG");
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [w, h]);
  } finally {
    await browser.close();
  }
});

test("#debug-4k asks the camera for 3840x2160", async () => {
  const browser = await launchBrowser(["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"]);
  try {
    const page = await openPage(browser, server.base + "recv.html#debug-4k");
    await page.waitFor(ready, 20000);
    await page.eval(`(() => {
      const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = (c) => { window.__asked = c; return gum(c); };
      return true;
    })()`);
    await page.eval("document.querySelector('#start').click()");
    await page.waitFor("!!window.__asked");
    assert.deepEqual(await page.eval("[__asked.video.width.ideal, __asked.video.height.ideal]"), [3840, 2160]);
  } finally {
    await browser.close();
  }
});
