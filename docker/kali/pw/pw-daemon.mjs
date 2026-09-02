#!/usr/bin/env node
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";

const PORT = 18765;
const SCREENSHOT = "/workspace/pw-last.png";

let browser;
let context;
let page;
/** @type {Map<string, string>} */
const refs = new Map();

async function ensurePage() {
  if (!browser) {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-extensions"],
    });
    context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 720 } });
    page = await context.newPage();
  }
  if (!page || page.isClosed()) page = await context.newPage();
  return page;
}

async function snapshot(p) {
  refs.clear();
  const items = await p.evaluate(() => {
    const sel = 'a, button, input, textarea, select, [role="button"], [role="link"], [role="textbox"]';
    const nodes = [...document.querySelectorAll(sel)].slice(0, 80);
    const pathOf = (el) => {
      if (el.id) return `#${CSS.escape(el.id)}`;
      const parts = [];
      let cur = el;
      while (cur && cur.nodeType === 1 && parts.length < 6) {
        let i = 1;
        let sib = cur.previousElementSibling;
        while (sib) {
          if (sib.tagName === cur.tagName) i += 1;
          sib = sib.previousElementSibling;
        }
        parts.unshift(`${cur.tagName.toLowerCase()}:nth-of-type(${i})`);
        cur = cur.parentElement;
      }
      return parts.join(" > ");
    };
    return nodes.map((el, i) => ({
      ref: `e${i + 1}`,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type"),
      name: el.getAttribute("name"),
      href: el.getAttribute("href"),
      text: String(el.innerText || el.value || el.getAttribute("aria-label") || "").slice(0, 80),
      css: pathOf(el),
    }));
  });
  for (const it of items) refs.set(it.ref, it.css);
  return {
    url: p.url(),
    title: await p.title(),
    elements: items.map(({ css: _css, ...rest }) => rest),
  };
}

function resolveLocator(p, cmd) {
  if (cmd.selector) return p.locator(String(cmd.selector)).first();
  const css = refs.get(String(cmd.ref ?? ""));
  if (!css) throw new Error(`unknown ref ${cmd.ref}; call snapshot first`);
  return p.locator(css).first();
}

async function handle(cmd) {
  const op = String(cmd.op ?? "");
  const timeout = Number(cmd.timeout_ms ?? 15_000);
  if (op === "status") {
    return { browser: Boolean(browser), url: page && !page.isClosed() ? page.url() : null, refs: refs.size };
  }
  const p = await ensurePage();
  switch (op) {
    case "goto": {
      const url = String(cmd.url ?? "");
      if (!url) throw new Error("url required");
      const resp = await p.goto(url, { waitUntil: "domcontentloaded", timeout });
      const snap = await snapshot(p);
      return { status: resp?.status() ?? null, finalUrl: p.url(), ...snap };
    }
    case "snapshot":
      return snapshot(p);
    case "click":
      await resolveLocator(p, cmd).click({ timeout });
      return snapshot(p);
    case "type":
      await resolveLocator(p, cmd).fill(String(cmd.text ?? ""), { timeout });
      return { typed: true, url: p.url() };
    case "press":
      await p.keyboard.press(String(cmd.key ?? "Enter"));
      return snapshot(p);
    case "wait":
      await p.waitForTimeout(Math.min(timeout, 10_000));
      return snapshot(p);
    case "back":
      await p.goBack({ timeout });
      return snapshot(p);
    case "content": {
      const text = await p.locator("body").innerText().catch(() => "");
      return { url: p.url(), title: await p.title(), text: text.slice(0, 8000) };
    }
    case "screenshot": {
      mkdirSync("/workspace", { recursive: true });
      const buf = await p.screenshot({ fullPage: false });
      writeFileSync(SCREENSHOT, buf);
      return { path: SCREENSHOT, bytes: buf.length, url: p.url() };
    }
    default:
      throw new Error(`unknown playwright op ${op}`);
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "rionext-playwright" }));
    return;
  }
  try {
    const cmd = JSON.parse((await readBody(req)) || "{}");
    const result = await handle(cmd);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, ...result }));
  } catch (err) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`rionext-playwright listening on 127.0.0.1:${PORT}\n`);
});
