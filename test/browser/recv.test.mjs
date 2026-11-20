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

test("the camera is asked for 1080p, never 4K (the decoder runs out of memory on 4K frames)", async () => {
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
    assert.deepEqual(await page.eval("[__asked.video.width.ideal, __asked.video.height.ideal]"), [1920, 1080]);
  } finally {
    await browser.close();
  }
});

test("recv.html?camfps=30 asks the camera for 30 fps", async () => {
  const browser = await launchBrowser(["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"]);
  try {
    const page = await openPage(browser, server.base + "recv.html?camfps=30");
    await page.waitFor(ready, 20000);
    await page.eval(`(() => {
      const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = (c) => { window.__asked = c; return gum(c); };
      return true;
    })()`);
    await page.eval("document.querySelector('#start').click()");
    await page.waitFor("!!window.__asked");
    assert.equal(await page.eval("__asked.video.frameRate.ideal"), 30);
  } finally {
    await browser.close();
  }
});

test("receiver follows the sender when it switches resolution mid-transfer", async () => {
  // Record a 60 KB file as High (B) frames, too few to finish it, then as Low (Bu) frames.
  const payload2 = randomBytes(60 * 1024);
  const src = join(FIX, "switch.bin");
  writeFileSync(src, payload2);
  const small = [];
  const large = [];
  const sender = await launchBrowser();
  try {
    const page = await openPage(sender, server.base + "send.html", { width: 1280, height: 900 });
    await page.eval("localStorage.clear(), localStorage.setItem('lumen-send-mode', '68'), true");
    await page.goto(server.base + "send.html?fps=5");
    await page.waitFor("!document.querySelector('#choose').disabled", 20000);
    await page.setFiles("#file", [src]);
    await page.waitFor("document.body.dataset.state === 'playing' && !document.querySelector('#stage').classList.contains('is-preparing')");
    for (let i = 0; i < 6; i++) { await sleep(200); small.push((await page.capture("jpeg", 85)).toString("base64")); }
    await page.eval("document.querySelector('[data-mode=\"66\"]').click()");
    await page.waitFor("!document.querySelector('#stage').classList.contains('is-preparing')");
    for (let i = 0; i < 40; i++) { await sleep(200); large.push((await page.capture("jpeg", 85)).toString("base64")); }
  } finally {
    await sender.close();
  }

  // Play them to the receive page through a canvas "camera" we control.
  const browser = await launchBrowser();
  try {
    const page = await openPage(browser, server.base + "recv.html#debug");
    await page.waitFor(ready, 20000);
    await page.eval(`(async () => {
      const load = (list) => Promise.all(list.map((b64) =>
        createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: "image/jpeg" }))));
      window.__clips = { small: await load(${JSON.stringify(small)}), large: await load(${JSON.stringify(large)}) };
      window.__clip = "small";
      const c = document.createElement("canvas");
      c.width = 1280; c.height = 900;
      const g = c.getContext("2d");
      let i = 0;
      setInterval(() => { const f = __clips[__clip]; g.drawImage(f[i++ % f.length], 0, 0); }, 66);
      const stream = c.captureStream(30);
      navigator.mediaDevices.getUserMedia = async () => stream;
      return true;
    })()`);
    await page.eval("document.querySelector('#start').click()");
    await page.waitFor("/mode 68/.test(document.querySelector('#debug').textContent) && document.querySelector('#pct').textContent !== '0%'", 30000);
    await page.eval("(window.__clip = 'large', true)"); // the sender switched to Low
    await page.waitFor("document.body.dataset.state === 'done'", 60000);
    assert.match(await page.eval("document.querySelector('#debug').textContent"), /mode 66/);
    assert.equal(await page.eval("document.querySelector('#recv-name').textContent"), "switch.bin");
    const { bytes } = await downloadVia(page, browser.cdp);
    assert.equal(sha256(bytes), sha256(payload2));
  } finally {
    await browser.close();
  }
});

// Records `count` distinct sender frames (one per rendered code) as base64 JPEGs.
async function recordSender(file, mode, count) {
  const sender = await launchBrowser();
  try {
    const page = await openPage(sender, server.base + "send.html", { width: 1280, height: 900 });
    await page.eval(`(localStorage.setItem("lumen-send-mode", "${mode}"), true)`);
    await page.goto(server.base + "send.html?fps=4");
    await page.waitFor("!document.querySelector('#choose').disabled", 20000);
    await page.setFiles("#file", [file]);
    await page.waitFor("document.body.dataset.state === 'playing' && !document.querySelector('#stage').classList.contains('is-preparing')");
    await page.eval(`(() => { window.__f = 0; const f = Module._cimbare_next_frame; Module._cimbare_next_frame = (...a) => (__f++, f(...a)); return true; })()`);
    const frames = [];
    let last = await page.eval("__f");
    while (frames.length < count) {
      const f = await page.eval("__f");
      if (f !== last) {
        await sleep(150);
        const shot = await page.capture("jpeg", 90);
        if (shot.length > 60000) frames.push(shot.toString("base64")); // skip the blank first renders
        last = f;
      }
      await sleep(30);
    }
    await page.eval("localStorage.clear(), true");
    return frames;
  } finally {
    await sender.close();
  }
}

test("decodes through phone-camera glare (bright screen blooming over the code)", async () => {
  // Small enough that the 32 looped camera frames hold every block it needs (a real sender
  // keeps producing new frames, so size isn't limited by this in practice).
  const payload3 = randomBytes(8 * 1024);
  const src = join(FIX, "glare.bin");
  writeFileSync(src, payload3);
  const frames = await recordSender(src, 66, 32);

  const browser = await launchBrowser();
  try {
    const page = await openPage(browser, server.base + "recv.html#debug");
    await page.waitFor(ready, 20000);
    // A portrait 1080x1920 "phone camera": the code slightly tilted and blurred, blacks lifted,
    // and glare from bright areas spilling into the dark around them.
    await page.eval(`(async () => {
      const list = ${JSON.stringify(frames)};
      const bitmaps = await Promise.all(list.map((b64) =>
        createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: "image/jpeg" }))));
      // Render each degraded camera frame once (software rendering of the filters is slow),
      // then play them back like a camera.
      const shots = [];
      for (const f of bitmaps) {
        const o = new OffscreenCanvas(1080, 1920);
        const g = o.getContext("2d");
        const w = 1040, h = Math.round(f.height * 1040 / f.width);
        g.fillStyle = "rgb(30,30,34)";
        g.fillRect(0, 0, 1080, 1920);
        g.save();
        g.translate(540, 480 + h / 2);
        g.rotate(0.03);
        g.filter = "blur(1.2px) brightness(1.2)";
        g.drawImage(f, -w / 2, -h / 2, w, h);
        g.globalCompositeOperation = "lighter";
        g.filter = "brightness(0.62) contrast(12) blur(7px) brightness(0.6)";
        g.drawImage(f, -w / 2, -h / 2, w, h);
        g.restore();
        g.filter = "none";
        g.globalCompositeOperation = "lighter"; // lift the blacks, as a camera does
        g.fillStyle = "rgb(22,22,26)";
        g.fillRect(0, 0, 1080, 1920);
        g.getImageData(0, 0, 1, 1); // rasterize now, not lazily when the camera first shows it
        shots.push(o.transferToImageBitmap());
      }
      const c = document.createElement("canvas");
      c.width = 1080; c.height = 1920;
      const g = c.getContext("2d");
      let i = 0;
      const draw = () => g.drawImage(shots[i++ % shots.length], 0, 0);
      draw();
      setInterval(draw, 100);
      window.__cameraShot = () => c.toDataURL("image/jpeg", 0.9);
      const stream = c.captureStream(30);
      navigator.mediaDevices.getUserMedia = async () => stream;
      return true;
    })()`);
    await sleep(500);
    writeFileSync(join(OUT, "glare-camera.jpg"), Buffer.from((await page.eval("__cameraShot()")).split(",")[1], "base64"));
    await page.eval("document.querySelector('#start').click()");
    // Slow on a busy machine: a software-rendered canvas camera stands in for the phone's.
    await page.waitFor("document.body.dataset.state === 'done'", 180000);
    assert.equal(await page.eval("document.querySelector('#recv-name').textContent"), "glare.bin");
    const { bytes } = await downloadVia(page, browser.cdp);
    assert.equal(sha256(bytes), sha256(payload3));
  } finally {
    await browser.close();
  }
});
