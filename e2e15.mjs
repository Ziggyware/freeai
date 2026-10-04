import { chromium } from "playwright-core";
import fs from "node:fs";
const html = fs.readFileSync("app/page.html", "utf8");
const HOOK = "<script>(function(){var s=function(l,a){try{parent.postMessage({omniConsole:1,level:l,text:Array.from(a).map(function(x){try{return typeof x===\"string\"?x:JSON.stringify(x)}catch(e){return String(x)}}).join(\" \")},\"*\")}catch(e){}};[\"log\",\"info\",\"warn\",\"error\"].forEach(function(l){var o=console[l];console[l]=function(){s(l,arguments);o&&o.apply(console,arguments)}});window.addEventListener(\"error\",function(e){if(e&&e.target&&e.target!==window&&(e.target.src||e.target.href)){s(\"error\",[\"failed to load \"+(e.target.tagName||\"resource\").toLowerCase()+\" \"+String(e.target.src||e.target.href).split(\"/\").slice(-1)[0]+\" (404 or blocked)\"]);return}s(\"error\",[e.message+\" (\"+(e.filename||\"\").split(\"/\").pop()+\":\"+e.lineno+\")\"])},true);window.addEventListener(\"unhandledrejection\",function(e){s(\"error\",[\"unhandled: \"+(e.reason&&e.reason.message||e.reason)])})})();</script>";
const files = { "index.html": "<!doctype html><html><head><link rel=stylesheet href=style.css></head><body><h1>x</h1><script src=missing.js></script><script>setTimeout(()=>{ nope.call() }, 50)</script></body></html>" };
const manifest = { title: "T", shared: "", files: [{ path: "index.html", purpose: "e" }, { path: "a.js", purpose: "a" }] };
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox", "--headless=new"], ignoreDefaultArgs: ["--headless=old"] });
const p = await b.newPage({ viewport: { width: 1400, height: 800 } }); const errs = []; p.on("pageerror", e => errs.push(e.message));
const posts = []; let buildTries = 0;
await p.route("**/*", async (route) => { const u = new URL(route.request().url());
  if (u.host === "cdnjs.cloudflare.com") return route.abort();
  if (u.host !== "app.local") return route.abort();
  if (u.search.includes("?artifact_files=")) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ id: 61, title: "T", kind: "html", session: "s", files: Object.entries(files).map(([path, content]) => ({ path, content })), issues: [] }) });
  if (u.search.startsWith("?q")) { const body = JSON.parse(route.request().postData()); posts.push({ q: body.q.slice(0, 50), errors: body.settings.focus?.errors }); await new Promise(r => setTimeout(r, 200)); return route.fulfill({ contentType: "application/json", body: JSON.stringify({ reply: "fixed", toolEvents: [], meta: {}, completion: { done: true, remaining: [] } }) }); }
  if (u.search.startsWith("?build_file")) { buildTries++; const body = JSON.parse(route.request().postData()); if (buildTries <= 2) return route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: { message: "build a.js failed: router 503: ALL_PROVIDERS_EXHAUSTED_OR_COOLING" } }) }); return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, path: body.path, lines: 10, issues: [], meta: {} }) }); }
  if (u.search.startsWith("?job")) return route.fulfill({ contentType: "application/json", body: '{"ok":true,"jobs":[]}' });
  if (u.search.startsWith("?plan")) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ manifest, artifactId: 61, title: "T" }) });
  if (u.search.includes("?progress")) return route.fulfill({ contentType: "application/json", body: '{"events":[],"next":0}' });
  if (u.pathname === "/artifact/61/" ) return route.fulfill({ contentType: "text/html", body: files["index.html"].replace("<head>", "<head>" + HOOK) });
  if (u.pathname.startsWith("/artifact/")) return route.fulfill({ status: 404, body: "" });
  if (u.search && !u.search.startsWith("?s=")) return route.fulfill({ contentType: "application/json", body: "[]" });
  return route.fulfill({ contentType: "text/html", body: html }); });
await p.goto("https://app.local/", { waitUntil: "load" }); await p.waitForTimeout(400);
await p.evaluate(() => { ART.setSettings({ ...ART.settings(), codemirror: false, autoFixLint: false, autoFixErrors: true, live: false }); SETTINGS.set('retryMinutes', 1); });
// A) preview errors → one automatic fix turn carrying the errors; same error set again → no second turn
await p.evaluate(() => ART.open(61, 'split')); await p.waitForTimeout(3500);
const a = { posts: posts.map(x => x.q), errorsSent: posts[0]?.errors, console: await p.evaluate(() => [...document.querySelectorAll('#ap-con-body .con-err')].map(x => x.textContent)) };
await p.evaluate(() => ART.open(61)); await p.waitForTimeout(3000);
const a2 = { postsAfterReload: posts.length };
// B) builder retried through a 502 window
await p.evaluate(() => ART.close());
await p.fill("#inp", "/build a thing"); await p.keyboard.press("Enter"); await p.waitForTimeout(16000);
const bres = { buildTries, rows: await p.evaluate(() => [...document.querySelectorAll('.manifest-f')].map(r => r.querySelector('code').textContent + '=' + r.querySelector('.st').textContent)) };
console.log(JSON.stringify({ a, a2, bres }, null, 1)); console.log("errors:", errs);
await b.close();
