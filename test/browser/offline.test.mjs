// The core promise: after one visit, the app works with the server gone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OUT, sleep, startServer, launchBrowser, openPage } from "./harness.mjs";

test("every page works offline after the first visit", async () => {
  const fixture = join(OUT, "fixtures", "offline.txt");
  mkdirSync(join(OUT, "fixtures"), { recursive: true });
  writeFileSync(fixture, "sent while offline\n");

  const server = await startServer(18094);
  const browser = await launchBrowser(["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"]);
  try {
    const page = await openPage(browser, server.base);
    const expected = JSON.parse((await (await fetch(server.base + "sw.js")).text()).match(/const FILES = (\[.*\]);/)[1]).length;
    await page.waitFor(`navigator.serviceWorker.ready.then(() => caches.keys())
      .then((keys) => keys.length === 1 && caches.open(keys[0]))
      .then((c) => c && c.keys()).then((k) => !!k && k.length === ${expected})`, 30000);

    server.stop();
    await sleep(300);
    assert.equal(await page.eval("fetch('/sw.js', { cache: 'no-store' }).then(() => 'up', () => 'down')"), "down", "server should be gone");

    await page.goto(server.base);
    assert.equal(await page.eval("document.title"), "Lumen Drop");
    assert.equal(await page.eval("getComputedStyle(document.querySelector('.wordmark')).fontFamily.includes('Unbounded')"), true);

    await page.goto(server.base + "send.html");
    await page.waitFor("!document.querySelector('#choose').disabled", 20000);
    await page.setFiles("#file", [fixture]);
    await page.waitFor("document.body.dataset.state === 'playing'");

    await page.goto(server.base + "recv.html");
    await page.waitFor("!document.querySelector('#start').disabled", 20000);
    await page.eval("document.querySelector('#start').click()");
    await page.waitFor("document.body.dataset.state === 'scanning'");
    await sleep(1000);
    assert.equal(await page.eval("document.body.dataset.state"), "scanning");

    assert.deepEqual(page.log.errors.filter((e) => !e.includes("/sw.js")), []);
  } finally {
    await browser.close();
    server.stop();
  }
});
