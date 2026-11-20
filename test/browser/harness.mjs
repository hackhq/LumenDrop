// Minimal headless-Chromium harness over the DevTools Protocol (no npm deps).
// Run all browser tests with: node --test --test-concurrency=1 test/browser/
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
      rmSync(profile, { recursive: true, force: true });
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
      log.errors.push(`${p.entry.source}: ${p.entry.text}`);
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
