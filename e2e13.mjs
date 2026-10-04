import { chromium } from "playwright-core";
import fs from "node:fs";
const html = fs.readFileSync("app/page.html", "utf8");
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox", "--headless=new"], ignoreDefaultArgs: ["--headless=old"] });
const p = await b.newPage({ viewport: { width: 1400, height: 800 } }); const errs = []; p.on("pageerror", e => errs.push(e.message));
const posts = []; let phase = "write";
await p.route("**/*", async (route) => { const u = new URL(route.request().url());
  if (u.host !== "app.local") return route.abort();
  if (u.search.startsWith("?q")) { const body = JSON.parse(route.request().postData()); posts.push(body.q.slice(0, 40)); await new Promise(r => setTimeout(r, 150));
    const wrote = phase === "write" || !/^The task is complete/.test(body.q);
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ reply: /FINALIZE/.test(body.q) ? "final summary" : "shipped round", toolEvents: wrote ? [{ hop: 0, tool: "update_artifact", args: { id: 7 }, result: { ok: true, id: 7 } }] : [], meta: {}, completion: { done: true, remaining: [] } }) }); }
  if (u.search.includes("?progress")) return route.fulfill({ contentType: "application/json", body: '{"events":[],"next":0}' });
  if (u.search.startsWith("?compact")) return route.fulfill({ contentType: "application/json", body: '{"compact":null,"needs":false}' });
  if (u.search && !u.search.startsWith("?s=")) return route.fulfill({ contentType: "application/json", body: "[]" });
  return route.fulfill({ contentType: "text/html", body: html }); });
await p.goto("https://app.local/", { waitUntil: "load" }); await p.waitForTimeout(400);
await p.evaluate(() => { SETTINGS.set('untilStopped', true); });
// A) rounds keep coming while every round writes; "finalize" typed in the composer ends the chain with one closing turn
await p.fill("#inp", "build me a thing"); await p.keyboard.press("Enter"); await p.waitForTimeout(6000);
const midA = { posts: posts.length, bar: await p.evaluate(() => document.getElementById('bar-status').textContent) };
await p.fill("#inp", "finalize"); await p.keyboard.press("Enter"); await p.waitForTimeout(3000);
const afterA = { posts: [...posts], inflight: await p.evaluate(() => window.inflightTurn()), last: await p.evaluate(() => [...document.querySelectorAll('.msg-wrap.ai .msg-body')].pop()?.textContent) };
// B) idle stop: rounds that write nothing end after two
posts.length = 0; phase = "idle";
await p.fill("#inp", "another thing"); await p.keyboard.press("Enter"); await p.waitForTimeout(6000);
const afterB = { posts: [...posts], inflight: await p.evaluate(() => window.inflightTurn()), autoCard: await p.evaluate(() => [...document.querySelectorAll('.msg-wrap.sys .msg-body')].some(x => /no further upgrades/.test(x.textContent))) };
console.log(JSON.stringify({ midA, afterA, afterB }, null, 1)); console.log("errors:", errs);
await b.close();
