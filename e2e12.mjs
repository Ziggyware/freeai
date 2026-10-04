import { chromium } from "playwright-core";
import fs from "node:fs";
const html = fs.readFileSync("app/page.html", "utf8");
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox", "--headless=new"], ignoreDefaultArgs: ["--headless=old"] });
const p = await b.newPage({ viewport: { width: 1400, height: 800 } }); const errs = []; p.on("pageerror", e => errs.push(e.message));
let q = 0, compactPosts = 0, compactGets = 0;
await p.route("**/*", async (route) => { const u = new URL(route.request().url()); const m = route.request().method();
  if (u.host !== "app.local") return route.abort();
  if (u.search.startsWith("?compact") && m === "POST") { compactPosts++; return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, before: 41000, after: 2900, covered: 22, uptoId: 88 }) }); }
  if (u.search.startsWith("?compact")) { compactGets++; return route.fulfill({ contentType: "application/json", body: JSON.stringify({ compact: compactPosts ? { summary: "GOAL — test", covered: 22, uptoId: 88, chars: 2900, ts: 1 } : null }) }); }
  if (u.search.startsWith("?q")) { q++; const body = JSON.parse(route.request().postData()); await new Promise(r => setTimeout(r, 200));
    if (q <= 3 && !body.settings.continuation) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { message: "router 503: ALL_PROVIDERS_EXHAUSTED_OR_COOLING", details: ["x"] } }) });
    // then: truncated replies forever (until stopped), the 4th with needsCompact
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ reply: "part " + q + " of a very long answer that keeps going", truncated: true, toolEvents: [], meta: {}, needsCompact: q === 4 }) }); }
  if (u.search.includes("?progress")) return route.fulfill({ contentType: "application/json", body: '{"events":[],"next":0}' });
  if (u.search && !u.search.startsWith("?s=")) return route.fulfill({ contentType: "application/json", body: "[]" });
  return route.fulfill({ contentType: "text/html", body: html }); });
await p.goto("https://app.local/", { waitUntil: "load" }); await p.waitForTimeout(400);
// retryMinutes 0 would normally mean "no retry"; autoContinue 1 would normally stop after one continue. untilStopped overrides both.
await p.evaluate(() => { SETTINGS.set('retryMinutes', 0); SETTINGS.set('autoContinue', 1); SETTINGS.set('untilStopped', true); });
await p.fill("#inp", "write the whole thing"); await p.keyboard.press("Enter");
await p.waitForTimeout(34000); // 3 × 503 with jittered 8/16/24 s waits ≈ 48 s worst case… we sample mid-way
const mid = await p.evaluate(() => ({ typing: document.getElementById('typing-label').textContent, bar: document.getElementById('bar-status')?.textContent }));
await p.waitForTimeout(26000);
const before = await p.evaluate(() => ({ ai: document.querySelectorAll('.msg-wrap.ai').length, compactCards: [...document.querySelectorAll('.msg-wrap.sys .role-tag')].filter(x => x.textContent === 'COMPACT').length, inflight: window.inflightTurn() }));
await p.evaluate(() => stopGen()); await p.waitForTimeout(1500);
const after = await p.evaluate(() => ({ inflight: window.inflightTurn(), last: [...document.querySelectorAll('.msg-wrap.ai .msg-body')].pop()?.textContent.slice(-40) }));
console.log(JSON.stringify({ mid, q, compactPosts, compactGets, before, after }, null, 1)); console.log("errors:", errs);
await b.close();
