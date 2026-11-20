// Minimal headless-Chromium harness over the DevTools Protocol (no npm deps).
// Run all browser tests with: node --test --test-concurrency=1 test/browser/
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

export const ROOT = new URL("../../", import.meta.url).pathname;
export const OUT = join(ROOT, "test-output");
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startServer(port) {
  mkdirSync(OUT, { recursive: true });
  const bin = join(OUT, "lumendrop-test");
  execFileSync("go", ["build", "-o", bin, "."], { cwd: ROOT, stdio: "inherit" });
  const proc = spawn(bin, ["-addr", `127.0.0.1:${port}`], { stdio: "ignore" });
  const base = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(base);
      return { base, stop: () => proc.kill() };
    } catch {
      await sleep(100);
    }
  }
  proc.kill();
  throw new Error("server did not start");
}

export async function launchBrowser(extraArgs = []) {
  mkdirSync(OUT, { recursive: true });
  const profile = mkdtempSync(join(OUT, "chrome-"));
  const proc = spawn("chromium", [
    "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
    "--enable-unsafe-swiftshader", "--use-angle=swiftshader", "--ignore-gpu-blocklist",
    ...extraArgs, "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = "";
    proc.stderr.on("data", (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) resolve(m[1]);
    });
    proc.on("exit", () => reject(new Error("chromium exited:\n" + buf)));
  });
  const cdp = await connect(wsUrl);
  return {
    cdp,
    close: async () => {
      cdp.close();
      proc.kill();
      await sleep(200);
      // Chrome can still be writing its profile for a moment after the kill.
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let next = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else {
      for (const fn of listeners) fn(msg);
    }
  };
  return {
    send(method, params = {}, sessionId) {
      const id = ++next;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params, sessionId }));
      });
    },
    on: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    close: () => ws.close(),
  };
}

// Opens url in a new tab. Collects page errors, console output, CSP violations and requested URLs.
export async function openPage(browser, url, { width = 1280, height = 800, mobile = false } = {}) {
  const { cdp } = browser;
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const s = (method, params) => cdp.send(method, params, sessionId);
  const log = { errors: [], console: [], requests: [] };
  const off = cdp.on((msg) => {
    if (msg.sessionId !== sessionId) return;
    const p = msg.params;
    if (msg.method === "Runtime.exceptionThrown") {
      log.errors.push(p.exceptionDetails.exception?.description || p.exceptionDetails.text);
    } else if (msg.method === "Runtime.consoleAPICalled") {
      const text = p.args.map((a) => a.value ?? a.description).join(" ");
      log.console.push(`${p.type}: ${text}`);
      if (p.type === "error") log.errors.push(text);
    } else if (msg.method === "Log.entryAdded" && p.entry.level === "error") {
      log.errors.push(`${p.entry.source}: ${p.entry.text}${p.entry.url ? " " + p.entry.url : ""}`);
    } else if (msg.method === "Network.requestWillBeSent") {
      log.requests.push(p.request.url);
    }
  });
  await s("Runtime.enable");
  await s("Log.enable");
  await s("Network.enable");
  await s("Page.enable");
  await s("Page.addScriptToEvaluateOnNewDocument", {
    source: "document.addEventListener('securitypolicyviolation', e => console.error('CSP violation:', e.violatedDirective, e.blockedURI));",
  });
  // Background tabs get no video frames or animation callbacks: keep this one in front.
  await s("Page.bringToFront");
  await s("Emulation.setFocusEmulationEnabled", { enabled: true });
  await s("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile });
  if (mobile) await s("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });

  const page = {
    s, log, targetId, sessionId,
    async eval(expression) {
      const r = await s("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    },
    async waitFor(expression, timeout = 10000) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        try { if (await page.eval(expression)) return; } catch { /* page navigating */ }
        await sleep(100);
      }
      throw new Error(`timed out waiting for: ${expression}`);
    },
    async goto(target) {
      await s("Page.navigate", { url: target });
      await page.waitFor("document.readyState === 'complete'");
    },
    async capture(format = "png", quality) {
      const { data } = await s("Page.captureScreenshot", { format, quality });
      return Buffer.from(data, "base64");
    },
    async screenshot(name) {
      const { data } = await s("Page.captureScreenshot", { format: "png" });
      writeFileSync(join(OUT, name), Buffer.from(data, "base64"));
    },
    // Sets files on <input type=file> matching selector, as if the user picked them.
    async setFiles(selector, files) {
      const { root } = await s("DOM.getDocument", {});
      const { nodeId } = await s("DOM.querySelector", { nodeId: root.nodeId, selector });
      await s("DOM.setFileInputFiles", { nodeId, files });
    },
    async close() { off(); await cdp.send("Target.closeTarget", { targetId }); },
  };
  await page.goto(url);
  return page;
}

// Requests to anything other than our own server (or blob:/data:) break offline use and privacy.
export function foreignRequests(log, base) {
  return log.requests.filter((u) => !u.startsWith(base) && !u.startsWith("blob:") && !u.startsWith("data:"));
}

// Decodes the 8-bit RGB/RGBA non-interlaced PNGs that Chromium screenshots produce.
export function decodePNG(buf) {
  let pos = 8, width, height, bpp;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0 || (data[9] !== 2 && data[9] !== 6)) throw new Error("unsupported PNG");
      bpp = data[9] === 6 ? 4 : 3;
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const px = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? px[(y - 1) * stride + x - bpp] : 0;
      let v = raw[row + x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[y * stride + x] = v & 255;
    }
  }
  return { width, height, bpp, px };
}

// Fraction of strongly colored (saturated) pixels inside rect {x, y, w, h}.
export function colorfulFraction(img, rect) {
  let hits = 0, total = 0;
  const x0 = Math.max(0, Math.floor(rect.x)), y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(img.width, Math.floor(rect.x + rect.w)), y1 = Math.min(img.height, Math.floor(rect.y + rect.h));
  for (let y = y0; y < y1; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const i = (y * img.width + x) * img.bpp;
      const r = img.px[i], g = img.px[i + 1], b = img.px[i + 2];
      if (Math.max(r, g, b) - Math.min(r, g, b) > 80) hits++;
      total++;
    }
  }
  return total ? hits / total : 0;
}
