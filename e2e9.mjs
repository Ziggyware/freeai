import { chromium } from "playwright-core";
import fs from "node:fs";
const html = fs.readFileSync("app/page.html", "utf8");
const files = { "index.html": "<!doctype html><html><body><h1>x</h1><script src=app.js></script></body></html>", "app.js": "console.log(1);\n".repeat(40) };
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox", "--headless=new"], ignoreDefaultArgs: ["--headless=old"] });
const p = await b.newPage({ viewport: { width: 1400, height: 800 } }); const errs = []; p.on("pageerror", e => errs.push(e.message));
let qCount = 0, progressCalls = 0;
await p.route("**/*", async (route) => { const u = new URL(route.request().url());
  if (u.host === "cdnjs.cloudflare.com") { const m = u.pathname.match(/codemirror\/5\.65\.16\/(.*)$/); const f = m ? "/tmp/cm/" + m[1] : null; if (f && fs.existsSync(f)) return route.fulfill({ contentType: f.endsWith(".css") ? "text/css" : "text/javascript", body: fs.readFileSync(f) }); return route.abort(); }
  if (u.host !== "app.local") return route.abort();
  if (u.search.includes("?artifact_files=")) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ id: 1, title: "T", kind: "html", session: "s", files: Object.entries(files).map(([path, content]) => ({ path, content })), issues: [] }) });
  if (u.search.startsWith("?q")) { qCount++; const body = JSON.parse(route.request().postData()); await new Promise(r => setTimeout(r, 2500));
    if (qCount === 1) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "router 503: ALL_PROVIDERS_EXHAUSTED_OR_COOLING", details: ["groq: cooling 20s — rate", "openrouter: TIMEOUT"] } }) });
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ reply: "done after retry (retryOf=" + body.settings.retryOf + ")", toolEvents: [{ hop: 0, tool: "eval_js", args: { code: "1" }, result: 1 }], meta: {} }) }); }
  if (u.search.includes("?progress")) { progressCalls++; return route.fulfill({ contentType: "application/json", body: JSON.stringify({ events: [{ type: "stage", label: "answering" }, { type: "pass", n: 1, of: 8 }, { type: "tool", hop: 0, tool: "read_artifact", args: { id: 1 } }, { type: "tool", hop: 0, tool: "eval_js", args: { code: "1" } }].slice(0, Math.min(4, progressCalls)), next: 4 }) }); }
  if (u.pathname.startsWith("/artifact/")) return route.fulfill({ contentType: "text/html", body: files["index.html"] });
  if (u.search) return route.fulfill({ contentType: "application/json", body: "[]" });
  return route.fulfill({ contentType: "text/html", body: html }); });
await p.goto("https://app.local/", { waitUntil: "load" }); await p.waitForTimeout(300);
// A) editor resizes with the window
await p.evaluate(() => ART.open(1, 'split')); await p.waitForTimeout(900);
const h1 = await p.evaluate(() => document.querySelector('.CodeMirror').getBoundingClientRect().height);
await p.setViewportSize({ width: 1000, height: 500 }); await p.waitForTimeout(400);
const h2 = await p.evaluate(() => ({ cm: document.querySelector('.CodeMirror').getBoundingClientRect().height | 0, wrap: document.getElementById('ap-edwrap').getBoundingClientRect().height | 0, scroll: document.querySelector('.CodeMirror-scroll').clientHeight | 0 }));
await p.setViewportSize({ width: 1400, height: 800 }); await p.keyboard.press("Escape"); await p.waitForTimeout(300);
// B) live timeline: statuses, expanded row survives polling, retry loop
await p.evaluate(() => { SETTINGS.set('retryMinutes', 1); });
await p.fill("#inp", "hello"); await p.keyboard.press("Enter");
await p.waitForFunction(() => !!document.querySelector('#live-tl .tl .tl-row[data-kind=tool]'), null, { timeout: 15000 }); // a tool row has arrived (2 s polling cadence)
const r1 = await p.evaluate(() => { const tl = document.querySelector('#live-tl .tl'); const rows = [...tl.querySelectorAll('.tl-row')]; rows.find(r => r.dataset.kind === 'tool')?.click(); return { plan: [...tl.querySelectorAll('.tl-pl')].map(x => x.className.replace('tl-pl ', '') + ':' + x.textContent), rows: rows.map(r => r.querySelector('.tl-k').textContent + '=' + r.querySelector('.tl-st').textContent), header: tl.querySelector('.tl-sum').textContent, label: document.getElementById('typing-label').textContent }; });
await p.waitForTimeout(2600); // more polls → the expanded row must still be open
const r2 = await p.evaluate(() => { const tl = document.querySelector('#live-tl .tl'); return { stillOpen: !!tl.querySelector('.tl-row.open'), xVisible: tl.querySelector('.tl-row.open + .tl-x') ? getComputedStyle(tl.querySelector('.tl-row.open + .tl-x')).display : 'MISSING', html: tl.innerHTML.slice(0, 300), rows: tl.querySelectorAll('.tl-row').length, label: document.getElementById('typing-label').textContent }; });
await p.waitForTimeout(12000); // retry wait (8s + jitter) then second attempt
const r3 = await p.evaluate(() => ({ q: document.querySelectorAll('.msg-wrap.ai').length, reply: [...document.querySelectorAll('.msg-wrap.ai .msg-body')].pop()?.textContent, err: document.querySelectorAll('.err-card').length }));
console.log(JSON.stringify({ h1, h2, r1, r2, r3, qCount }, null, 1)); console.log("errors:", errs.filter(e => !/cdnjs/.test(e)));
await b.close();
