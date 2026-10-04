import { chromium } from "playwright-core";
import fs from "node:fs";
const html = fs.readFileSync("app/page.html", "utf8");
const manifest = { title: "Demo", shared: "x", files: [{ path: "index.html", purpose: "entry" }, { path: "a.js", purpose: "a" }, { path: "b.js", purpose: "b" }, { path: "c.js", purpose: "c" }] };
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox", "--headless=new"], ignoreDefaultArgs: ["--headless=old"] });
const p = await b.newPage({ viewport: { width: 1400, height: 800 } }); const errs = []; p.on("pageerror", e => errs.push(e.message));
const built = [], jobPosts = [], planCalls = []; let qBodies = [];
await p.route("**/*", async (route) => { const u = new URL(route.request().url());
  if (u.host === "cdnjs.cloudflare.com") { const m = u.pathname.match(/codemirror\/5\.65\.16\/(.*)$/); const f = m ? "/tmp/cm/" + m[1] : null; if (f && fs.existsSync(f)) return route.fulfill({ contentType: f.endsWith(".css") ? "text/css" : "text/javascript", body: fs.readFileSync(f, "utf8") }); return route.abort(); }
  if (u.host !== "app.local") return route.abort();
  if (u.search.startsWith("?sessions")) return route.fulfill({ contentType: "application/json", body: JSON.stringify([{ id: "S1", name: "demo", ts: 1 }]) });
  if (u.search.startsWith("?history")) return route.fulfill({ contentType: "application/json", body: "[]" });
  if (u.search.startsWith("?job=list")) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ jobs: [{ artifactId: 7, manifest, done: ["index.html", "a.js"], failed: ["b.js"], status: "building", title: "Demo", ask: "make demo" }] }) });
  if (u.search.startsWith("?job")) { jobPosts.push(JSON.parse(route.request().postData())); return route.fulfill({ contentType: "application/json", body: "{\"ok\":true}" }); }
  if (u.search.startsWith("?plan")) { planCalls.push(JSON.parse(route.request().postData()).q); return route.fulfill({ contentType: "application/json", body: JSON.stringify({ manifest, artifactId: 9, title: "Demo" }) }); }
  if (u.search.startsWith("?build_file")) { const body = JSON.parse(route.request().postData()); built.push(body.path); await new Promise(r => setTimeout(r, 300)); return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, path: body.path, lines: 10, issues: [], meta: { instance: "openrouter#2" } }) }); }
  if (u.search.includes("?artifact_files=")) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ id: 7, title: "Demo", kind: "html", session: "S1", files: [{ path: "index.html", content: "<h1>x</h1>" }], issues: [] }) });
  if (u.search.startsWith("?q")) { qBodies.push(JSON.parse(route.request().postData())); return route.fulfill({ contentType: "application/json", body: JSON.stringify({ reply: "integrated", toolEvents: [], meta: {}, completion: { done: true, remaining: [] } }) }); }
  if (u.search.startsWith("?slow")) { await new Promise(r => setTimeout(r, 20000)); return route.fulfill({ body: "late" }); }
  if (u.pathname.startsWith("/artifact/")) return route.fulfill({ contentType: "text/html", body: "<h1>x</h1>" });
  if (u.search && !u.search.startsWith("?s=")) return route.fulfill({ contentType: "application/json", body: "[]" });
  return route.fulfill({ contentType: "text/html", body: html }); });
await p.goto("https://app.local/?s=S1", { waitUntil: "load" }); await p.waitForTimeout(800);
// A) worker-backed wait + fetchT timeout
const a = await p.evaluate(async () => { const t0 = performance.now(); await omniNet.wait(300); const dt = performance.now() - t0; let err = null; try { await omniNet.fetchT('?slow', {}, 1200); } catch (e) { err = e.message; } let stopped = null; const c = new AbortController(); setTimeout(() => c.abort(), 200); try { await omniNet.fetchT('?slow', { signal: c.signal }, 5000); } catch (e) { stopped = e.name; } return { dt: Math.round(dt), err, stopped }; });
// B) resume card rendered from the server job row
const cardTxt = await p.evaluate(() => { const c = document.querySelector('.manifest'); return c ? { head: c.querySelector('.manifest-h span').textContent, btn: c.querySelector('[data-a=go]').textContent, st: [...c.querySelectorAll('.manifest-f')].map(r => r.querySelector('code').textContent + '=' + r.querySelector('.st').textContent) } : null; });
await p.click('.manifest [data-a=go]'); await p.waitForTimeout(2500);
const after = await p.evaluate(() => ({ st: [...document.querySelectorAll('.manifest-f')].map(r => r.querySelector('code').textContent + '=' + r.querySelector('.st').textContent), reply: [...document.querySelectorAll('.msg-wrap.ai .msg-body')].pop()?.textContent, title: document.title }));
// C) app-scale ask auto-routes to the swarm
await p.evaluate(() => ART.close()); await p.waitForTimeout(300);
await p.fill("#inp", "build a step sequencer app with effects"); await p.keyboard.press("Enter"); await p.waitForTimeout(2500);
await p.evaluate(() => ART.close()); await p.waitForTimeout(300); await p.fill("#inp", "what time is it"); await p.keyboard.press("Enter"); await p.waitForTimeout(800);
const c = { planCalls, qAfter: qBodies.length, builtTotal: built.length };
console.log(JSON.stringify({ c, a, cardTxt, built, after, jobStatuses: jobPosts.map(j => j.state.status + ':' + j.state.done.length), integrateQ: qBodies.length, integrateFocus: qBodies[0]?.settings?.focus?.id }, null, 1));
console.log("errors:", errs);
await b.close();
