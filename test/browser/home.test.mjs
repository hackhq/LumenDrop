import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, launchBrowser, openPage, foreignRequests } from "./harness.mjs";

let server, browser;
before(async () => { server = await startServer(18091); browser = await launchBrowser(); });
after(async () => { await browser?.close(); server?.stop(); });

for (const [name, opts] of [["phone", { width: 390, height: 844, mobile: true }], ["desktop", { width: 1440, height: 900 }]]) {
  test(`home page on ${name}: two modes, credit, no errors`, async () => {
    const page = await openPage(browser, server.base, opts);
    assert.equal(await page.eval("document.title"), "Lumen Drop");
    assert.equal(await page.eval(`document.querySelector('a[href="send.html"]')?.textContent.includes("Send a file")`), true);
    assert.equal(await page.eval(`document.querySelector('a[href="recv.html"]')?.textContent.includes("Receive a file")`), true);
    assert.equal(await page.eval(`!!document.querySelector('a[href="https://github.com/sz3/libcimbar"]')`), true, "libcimbar credit link");
    assert.equal(await page.eval(`!!document.querySelector('a[href="https://github.com/divan/txqr"]')`), true, "txqr credit link");
    assert.equal(await page.eval(`document.querySelector('link[rel="manifest"]')?.getAttribute("href")`), "manifest.json");
    assert.equal(await page.eval("document.documentElement.scrollWidth <= window.innerWidth"), true, "no horizontal scroll");
    await page.waitFor("navigator.serviceWorker.controller !== null || navigator.serviceWorker.ready.then(() => true)");
    await page.eval("Promise.all(document.getAnimations().map((a) => a.finished)).then(() => true)");
    await page.screenshot(`home-${name}.png`);
    assert.deepEqual(page.log.errors, []);
    assert.deepEqual(foreignRequests(page.log, server.base), []);
    await page.close();
  });
}

test("manifest is valid and its icons exist", async () => {
  const m = await (await fetch(server.base + "manifest.json")).json();
  assert.equal(m.name, "Lumen Drop");
  assert.equal(m.start_url, "./");
  assert.ok(m.icons.some((i) => i.sizes === "512x512" && i.purpose === "maskable"));
  for (const icon of m.icons) {
    const res = await fetch(new URL(icon.src, server.base));
    assert.equal(res.status, 200, icon.src);
    assert.equal(res.headers.get("content-type"), icon.type);
  }
});

test("every precached URL in sw.js resolves", async () => {
  const sw = await (await fetch(server.base + "sw.js")).text();
  const files = JSON.parse(sw.match(/const FILES = (\[.*\]);/)[1]);
  assert.ok(files.length > 5);
  for (const f of files) {
    const res = await fetch(new URL(f, server.base), { redirect: "manual" });
    assert.equal(res.status, 200, f);
  }
});
