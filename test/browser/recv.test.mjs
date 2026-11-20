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

    // A second transfer in the same session.
    await page.eval("document.querySelector('#again').click()");
    await page.waitFor("document.body.dataset.state === 'scanning'");
    await page.waitFor("document.body.dataset.state === 'done'", 90000);
    const again = await downloadVia(page, browser.cdp);
    assert.equal(sha256(again.bytes), sha256(payload));

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
