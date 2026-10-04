// lint strip: fix button sends a focused fix; auto-fix fires once; completion audit → automatic follow-up turn
import { chromium } from "playwright-core";
import fs from "node:fs";
const html = fs.readFileSync("app/page.html", "utf8");
const files = { "index.html": "<!doctype html><html><body><script src=app.js></script></body></html>", "app.js": "function init() {}\n" };
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox", "--headless=new"], ignoreDefaultArgs: ["--headless=old"] });
const p = await b.newPage({ viewport: { width: 1400, height: 800 } }); const errs = []; p.on("pageerror", e => errs.push(e.message));
const posts = [];
await p.route("**/*", async (route) => { const u = new URL(route.request().url());
  if (u.host !== "app.local") return route.abort();
  if (u.search.includes("?artifact_files=")) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ id: 7, title: "T", kind: "html", session: "s", files: Object.entries(files).map(([path, content]) => ({ path, content })), issues: ["app.js:1: empty function body — \"function init() {}\" — replace with the real implementation"] }) });
  if (u.search.startsWith("?q")) { const body = JSON.parse(route.request().postData()); posts.push({ q: body.q.slice(0, 60), focus: body.settings.focus?.id, followup: body.settings.followup }); await new Promise(r => setTimeout(r, 300));
    const first = posts.length === 1 && !/Continue the task/.test(body.q);
    // the SUCCESSOR turn (auto follow-up) hits a 503 once: its retry loop must use its own AbortController (regression: "Cannot read properties of null (reading 'signal')")
    if (posts.length === 2 && !body.settings.retryOf) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "router 503: ALL_PROVIDERS_EXHAUSTED_OR_COOLING", details: ["x"] } }) });
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ reply: "did part " + posts.length, toolEvents: [{ hop: 0, tool: "update_artifact", args: { id: 7 }, result: { ok: true, id: 7, url: "/artifact/7/", title: "T" } }], meta: {}, completion: posts.length < 3 ? { done: false, remaining: ["wire the keyboard handler in input.js", "add the score display"] } : { done: true, remaining: [] } }) }); }
  if (u.search.includes("?progress")) return route.fulfill({ contentType: "application/json", body: '{"events":[],"next":0}' });
  if (u.pathname.startsWith("/artifact/")) return route.fulfill({ contentType: "text/html", body: files["index.html"] });
  if (u.search) return route.fulfill({ contentType: "application/json", body: "[]" });
  return route.fulfill({ contentType: "text/html", body: html }); });
await p.goto("https://app.local/", { waitUntil: "load" }); await p.waitForTimeout(300);
await p.evaluate(() => { ART.setSettings({ ...ART.settings(), codemirror: false, autoFixLint: true }); ART.open(7, 'split'); }); await p.waitForTimeout(1200);
const r1 = await p.evaluate(() => ({ lintShown: !document.getElementById('ap-lint').hidden, n: document.getElementById('ap-lint-n').textContent, btn: !!document.querySelector('#ap-lint-h button') }));
await p.waitForTimeout(16000); // auto-fix turn + completion follow-ups
const r2 = await p.evaluate(() => ({ auto: [...document.querySelectorAll('.msg-wrap.sys .msg-body')].map(x => x.textContent.split('\n')[0]), ai: document.querySelectorAll('.msg-wrap.ai').length }));
console.log(JSON.stringify({ r1, posts, r2 }, null, 1)); console.log("errors:", errs);
await b.close();
