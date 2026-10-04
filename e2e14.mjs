import { chromium } from "playwright-core";
import fs from "node:fs";
const html = fs.readFileSync("app/page.html", "utf8");
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--no-sandbox", "--headless=new"], ignoreDefaultArgs: ["--headless=old"] });
const p = await b.newPage({ viewport: { width: 1400, height: 800 } }); const errs = []; p.on("pageerror", e => errs.push(e.message));
let q = 0;
await p.route("**/*", async (route) => { const u = new URL(route.request().url());
  if (u.host !== "app.local") return route.abort();
  if (u.search.startsWith("?q")) { q++; await new Promise(r => setTimeout(r, 5000)); return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { message: "Val timed out after 1m" } }) }); }
  if (u.search.includes("?progress")) return route.fulfill({ contentType: "application/json", body: JSON.stringify({ next: 3, events: [{ type: "stage", label: "answering" }, { type: "partial", text: "const store = createStore(reducer, init);\nexport function mount() {" }, { type: "continue", n: 1, chars: 1840, tail: "export function mount() {" }] }) });
  if (u.search.startsWith("?history")) return route.fulfill({ contentType: "application/json", body: "[]" });
  if (u.search && !u.search.startsWith("?s=")) return route.fulfill({ contentType: "application/json", body: "[]" });
  return route.fulfill({ contentType: "text/html", body: html }); });
await p.goto("https://app.local/", { waitUntil: "load" }); await p.waitForTimeout(400);
await p.evaluate(() => { SETTINGS.set('retryMinutes', 0); });
await p.fill("#inp", "fix the lint"); await p.keyboard.press("Enter");
await p.waitForTimeout(3000);
const live = await p.evaluate(() => ({ draftShown: !document.getElementById('live-draft').hidden, draft: document.getElementById('live-draft-t').textContent.slice(0, 40), contRow: [...document.querySelectorAll('#live-tl .tl-row')].map(r => r.textContent).find(t => /cut at the vendor cap/.test(t))?.slice(0, 90) }));
await p.waitForTimeout(30000); // error + recovery polls (8 × 3 s)
const after = await p.evaluate(() => { const c = document.querySelector('.err-card'); return { err: c?.querySelector('.err-m')?.textContent, keptTimelineRows: c?.querySelectorAll('.tl-row').length ?? 0, keptDraft: /draft reply recovered/.test(c?.textContent || ''), draftText: c?.querySelector('details pre')?.textContent.slice(0, 30) }; });
console.log(JSON.stringify({ live, after, q }, null, 1)); console.log("errors:", errs);
await b.close();
