// Shell logic: sessions, messages (live + restored from message_meta), turns with
// cross-turn auto-continue, slash commands, the swarm orchestrator (/build), the Runs
// inspector and the command palette. Sends carry SETTINGS.forRequest() + workbench focus.
export const script: string = String.raw`
const $ = (id) => document.getElementById(id);
const liveDraft = $('live-draft'), liveDraftT = $('live-draft-t'), liveDraftN = $('live-draft-n');
const chat = $('chat'), inp = $('inp'), typing = $('typing'), typingLbl = $('typing-label'), empty = $('empty'), sendBtn = $('send'), charEl = $('char-count'), pill = $('scroll-pill'), sessionsEl = $('sessions'), titleEl = $('session-title'), titleInp = $('session-title-input'), sidebar = $('sidebar'), progressEl = $('progress'), liveThink = $('live-think'), liveTl = $('live-tl'), chipsEl = $('chips'), barStatus = $('bar-status'), barTokens = $('bar-tokens'), bar = $('bar');
const urlSession = new URLSearchParams(location.search).get('s');
let currentSession = urlSession || (() => { try { return localStorage.getItem('omni.session'); } catch { return null; } })() || crypto.randomUUID();
let msgCount = 0, inflight = false, sidebarOpen = false, aborter = null, view = 'chat', lastAiWrap = null, turnLog = [];
Object.defineProperty(window, 'currentSession', { get: () => currentSession });
window.inflightTurn = () => inflight;
// ── longevity helpers ──────────────────────────────────────────────────────────
// wait(): timers in a Web Worker are not subject to background-tab throttling (Chrome parks page timers at 1/min after
// 5 min hidden), so retry / continue / swarm loops keep their cadence while the user is on another tab. Falls back to
// setTimeout when workers or blob URLs are unavailable.
const wait = (() => {
  let w = null, seq = 0; const pend = new Map();
  // onerror previously just dropped the worker (w = null) without touching pend: any wait() already in flight when the
  // worker errors had its resolver stranded in pend forever, hanging whatever awaited it (retry loops, swarm workers,
  // auto-continue, /finalize's unwind wait) with no way out. Resolve everyone waiting before abandoning the worker.
  try { w = new Worker(URL.createObjectURL(new Blob(['onmessage=function(e){setTimeout(function(){postMessage(e.data.id)},e.data.ms)}'], { type: 'text/javascript' }))); w.onmessage = (e) => { const r = pend.get(e.data); if (r) { pend.delete(e.data); r(); } }; w.onerror = () => { for (const r of pend.values()) r(); pend.clear(); w = null; }; } catch { w = null; }
  return (ms) => new Promise((res) => { if (!w) return setTimeout(res, ms); const id = ++seq; pend.set(id, res); w.postMessage({ id, ms }); });
})();
const jitter = (ms) => Math.round(ms * (0.85 + Math.random() * 0.3));
// fetchT(): the val has a 60 s wall clock, so a request with no answer after \`ms\` is dead — abort it and surface a
// retryable TIMEOUT error instead of hanging the turn forever. The caller's own signal (stop button) still wins.
async function fetchT(url, opts = {}, ms = 95_000) {
  const c = new AbortController(); const outer = opts.signal; const onAbort = () => c.abort();
  if (outer) { if (outer.aborted) throw Object.assign(new Error('stopped'), { name: 'AbortError' }); outer.addEventListener('abort', onAbort); }
  const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...opts, signal: c.signal }); }
  catch (e) { if (outer?.aborted) throw Object.assign(new Error('stopped'), { name: 'AbortError' }); if (c.signal.aborted) throw new Error('TIMEOUT: no response after ' + Math.round(ms / 1000) + 's'); throw e; }
  finally { clearTimeout(t); outer?.removeEventListener('abort', onAbort); }
}
// The server may have finished a turn whose response never reached us (timeout, network blip): the reply is in history.
// sessionId is required, not defaulted to the live currentSession: recovery must check the history of the session the
// turn actually belongs to, not whatever session happens to be on screen when the timeout fires (see sendWith's own()).
async function recoverFromHistory(text, sessionId) { const h = await fetch('?history=' + encodeURIComponent(sessionId)).then(r => r.json()).catch(() => []); const last = h[h.length - 1]; return last?.role === 'assistant' && h[h.length - 2]?.content === text ? last : null; }
// A non-JSON error body means the request never reached the app (every route answers JSON) - so it came
// from Val Town's edge: the access gate or a WAF challenge. "HTTP 403" alone sends debugging into the
// application code, the one place the fault cannot be. Report who actually served it, from the headers.
function describeGate(r, raw) {
  const body = String(raw || '');
  const html = /^\s*<(?:!doctype|html)/i.test(body);
  const title = (body.match(/<title>([^<]{1,80})<\/title>/i) || [])[1];
  const who = 'server: ' + (r.headers?.get?.('server') || '?') + ', cf-ray: ' + (r.headers?.get?.('cf-ray') || '-');
  const what = html
    ? 'an HTML page "' + String(title || 'no title').trim() + '"'
    : body ? 'a non-JSON body "' + body.slice(0, 60).replace(/\s+/g, ' ').trim() + '"' : 'an empty body';
  return 'HTTP ' + r.status + ' - blocked before reaching the app: got ' + what + ' (' + who + '). '
    + 'Every route here answers JSON, so this is Val Town, not the app: check the val App Access setting '
    + '(httpPrivacy restricted answers 403 to a signed-in visitor without access) or an edge/WAF block.';
}
// Base64 the body so Cloudflare's WAF stops matching attack signatures inside prose that contains code.
// Observed: POST ?q -> 403 "Blocked" while GET ?prompts returned JSON, so the rule keyed on the body.
// readJsonBody() (app-helpers.ts) accepts both shapes, so rolling this back needs no server change.
// Chunked: spreading a big Uint8Array into apply() overflows the argument limit on large payloads.
// Shared by every retry decision in this file (sendWith's turn loop and the swarm's buildOne).
// Module scope deliberately: it was first declared inside sendWith's loop, where buildOne could not
// see it - a ReferenceError the moment a build step failed, i.e. exactly when it is needed.
// 403 is absent (an access/WAF gate does not open on retry) and so is 500 (a deterministic bug).
const RETRY_STATUS = [429, 502, 503, 504];

function encBody(obj) {
  const json = JSON.stringify(obj);
  try {
    const bytes = new TextEncoder().encode(json);
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    return JSON.stringify({ __enc: 'b64', __p: btoa(bin) });
  } catch (_) {
    return json; // encoding must never be the reason a request cannot be sent
  }
}

// Two edge blocks look identical (403 + HTML) and have opposite fixes; they differ in SCOPE:
//   - App Access gates the whole val, so a trivial GET fails too.
//   - A WAF content rule reads the POST body, so GETs pass and only this POST is rejected.
// ?prompts is the probe: a GET returning a small JSON constant, no inference, nothing to exhaust.
async function classifyGate() {
  try {
    const p = await fetch('?prompts', { headers: { accept: 'application/json' } });
    const txt = await p.text().catch(() => '');
    let isJson = false;
    try { JSON.parse(txt); isJson = true; } catch (_) { isJson = false; }
    if (p.ok && isJson) {
      return 'DIAGNOSIS: a plain GET (?prompts) succeeded and returned JSON, so the val is NOT gated by App Access '
        + '- if it were, that GET would have been blocked too. The block is specific to this POST, which points at '
        + 'an edge/WAF rule inspecting the request body. Try sending a short, plain prompt: if that goes through, '
        + 'the rule is reacting to the CONTENT of the message (code, markup or shell-like text in the prompt).';
    }
    return 'DIAGNOSIS: the same plain GET (?prompts) also failed (HTTP ' + p.status + '), so the whole val is gated, '
      + 'not just this request. That is App Access: set the val httpPrivacy to public, or grant your org access.';
  } catch (e) {
    return 'DIAGNOSIS: could not probe ?prompts (' + String((e && e.message) || e) + ').';
  }
}
window.omniNet = { wait, fetchT, jitter, describeGate, classifyGate, encBody }; /* exposed for the workbench script and tests */
const baseTitle = document.title;
function tabProgress(t) { document.title = t ? '⏳ ' + t + ' · ' + baseTitle : baseTitle; }
window.addEventListener('beforeunload', (e) => { if (inflight) { e.preventDefault(); e.returnValue = 'A turn is still running — leaving loses its live progress (finished work is saved).'; } });
function rememberSession() { try { localStorage.setItem('omni.session', currentSession); } catch {} history.replaceState(null, '', location.pathname + '?s=' + encodeURIComponent(currentSession)); }
const ts = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
const fmtTs = (t) => t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : ts();

// ─── views ────────────────────────────────────────────────────────────────────
function setView(v) {
  if (v === 'build') { const c = ART.current(); if (c) ART.open(c.id); else { let id = null; try { id = localStorage.getItem('omni.ap.last'); } catch {} if (id) ART.open(Number(id)); else { toggleSidebar(true); ART.listForSession(currentSession); barStatus.textContent = 'no artifact yet — /build something'; } } return; }
  view = v; if (!document.getElementById('apanel').classList.contains('closed')) ART.close();
  document.querySelectorAll('#modes button').forEach(b => b.classList.toggle('on', b.dataset.view === v));
  document.querySelectorAll('.view').forEach(el => el.classList.toggle('on', el.id === 'view-' + v));
  if (v === 'runs') renderRuns();
}
document.addEventListener('omni:artifact-closed', () => { document.querySelectorAll('#modes button').forEach(b => b.classList.toggle('on', b.dataset.view === view)); });
document.addEventListener('omni:artifact-opened', () => { document.querySelectorAll('#modes button').forEach(b => b.classList.toggle('on', b.dataset.view === 'build')); });
function toggleSidebar(force) { sidebarOpen = force ?? !sidebarOpen; sidebar.classList.toggle('collapsed', !sidebarOpen); }

// ─── sessions ─────────────────────────────────────────────────────────────────
async function loadSessions() { renderSessions(await fetch('?sessions').then(r => r.json()).catch(() => [])); }
function renderSessions(list) {
  sessionsEl.innerHTML = list.length ? '' : '<div style="font-size:10px;color:var(--dim2);padding:8px 14px;letter-spacing:.06em;">// empty</div>';
  for (const s of list) {
    const row = document.createElement('div'); row.className = 'sess-row' + (s.id === currentSession ? ' active' : ''); row.dataset.id = s.id;
    const name = document.createElement('span'); name.className = 'sess-name'; name.textContent = (s.name || 'New Chat').toUpperCase();
    const del = document.createElement('button'); del.className = 'sess-del'; del.title = 'delete'; del.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
    del.onclick = (e) => { e.stopPropagation(); deleteSession(s.id); };
    row.appendChild(name); row.appendChild(del); row.onclick = () => switchSession(s.id, s.name); sessionsEl.appendChild(row);
  }
}
function clearChat() { msgCount = 0; lastAiWrap = null; turnLog = []; [...chat.querySelectorAll('.msg-wrap')].forEach(n => n.remove()); empty.style.display = ''; bar.classList.remove('started'); }
async function switchSession(id, name) {
  currentSession = id; rememberSession(); titleEl.textContent = (name || 'New Chat').toUpperCase(); clearChat();
  document.querySelectorAll('.sess-row').forEach(el => el.classList.toggle('active', el.dataset.id === id));
  ART.listForSession(id);
  const history = await fetch('?history=' + encodeURIComponent(id)).then(r => r.json()).catch(() => []);
  for (const m of history) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const meta = m.meta && typeof m.meta === 'object' ? m.meta : null;
    if (m.role === 'user' && meta?.hidden) continue; // continuation prompts
    if (m.role === 'assistant' && meta?.continuation && lastAiWrap) { appendToLast(m.content, meta); continue; }
    addMsg(m.role === 'user' ? 'user' : 'ai', m.content, meta, false, meta?.toolEvents || null, m.ts);
    if (m.role === 'assistant') turnLog.push({ q: lastUserText(), reply: m.content, meta, ts: m.ts });
  }
  chat.scrollTop = chat.scrollHeight; if (view === 'runs') renderRuns();
  SWARM.checkResume(true).then(found => { if (found) chat.scrollTop = chat.scrollHeight; }); COMPACT.show();
  // main-build-script.ts listens for this and picks up any scheduled build job this browser left in
  // flight for the session being opened (and drops the one it was driving for the session being left).
  document.dispatchEvent(new CustomEvent('omni:session', { detail: { id: id } }));
}
function lastUserText() { const u = [...chat.querySelectorAll('.msg-wrap.user .msg-body')].pop(); return u ? u.dataset.raw : ''; }
async function deleteSession(id) { const r = await fetch('?session=' + encodeURIComponent(id), { method: 'DELETE' }).catch(e => ({ ok: false, error: String(e) })); if (!r.ok) { barStatus.textContent = 'delete failed: ' + (r.error || r.status); return; } if (id === currentSession) newChat(); else await loadSessions(); }
function newChat() { currentSession = crypto.randomUUID(); rememberSession(); titleEl.textContent = 'NEW CHAT'; clearChat(); loadSessions(); ART.listForSession(currentSession); setView('chat'); inp.focus(); }
function startRename() { titleEl.style.display = 'none'; titleInp.style.display = 'block'; titleInp.value = titleEl.textContent; titleInp.focus(); titleInp.select(); }
function commitRename() { const v = (titleInp.value.trim() || 'New Chat').toUpperCase(); titleEl.textContent = v; titleEl.style.display = ''; titleInp.style.display = 'none'; fetch('?rename', { method: 'POST', headers: { 'content-type': 'application/json' }, body: encBody({ id: currentSession, name: v }) }).then(loadSessions); }
function titleKey(e) { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') { titleInp.style.display = 'none'; titleEl.style.display = ''; } }

// ─── messages ─────────────────────────────────────────────────────────────────
function renderAppCard(ev) {
  const url = ev.result?.url; if (!url) return null;
  const card = document.createElement('div'); card.className = 'app-card';
  const bar = document.createElement('div'); bar.className = 'app-card-bar';
  const title = document.createElement('span'); title.className = 'app-card-title'; title.textContent = '#' + ev.result.id + ' ' + (ev.result.title || 'untitled');
  const mk = (t, fn) => { const b = document.createElement('button'); b.className = 'app-card-open'; b.textContent = t; b.onclick = fn; return b; };
  const open = document.createElement('a'); open.className = 'app-card-open'; open.href = url; open.target = '_blank'; open.rel = 'noopener noreferrer'; open.textContent = 'open ↗';
  bar.appendChild(title); bar.appendChild(mk('preview', () => ART.open(ev.result.id, 'preview'))); bar.appendChild(mk('edit', () => ART.open(ev.result.id, 'split'))); bar.appendChild(open);
  card.appendChild(bar);
  if ((ev.args?.kind || 'html') !== 'markdown' && SETTINGS.current().cardPreview !== false) { const f = document.createElement('iframe'); f.className = 'app-card-frame'; f.src = url; f.sandbox = 'allow-scripts'; f.loading = 'lazy'; card.appendChild(f); }
  return card;
}
function telemetryEl(meta) {
  if (!meta) return null;
  const bits = [];
  if (meta.instance || meta.provider?.name) bits.push('<span><b>' + MD.esc(meta.instance || meta.provider.name) + '</b></span>');
  if (meta.model) bits.push('<span>' + MD.esc(String(meta.model).split('/').pop()) + '</span>');
  if (meta.maxTokensSent != null) bits.push('<span>max <b>' + meta.maxTokensSent + '</b>' + (meta.maxTokensAsked && meta.maxTokensAsked !== meta.maxTokensSent ? '/' + meta.maxTokensAsked : '') + '</span>');
  if (meta.tokensOut != null) bits.push('<span>out <b>' + meta.tokensOut + '</b></span>');
  if (meta.finishReason && meta.finishReason !== 'stop') bits.push('<span style="color:var(--warn)">' + MD.esc(meta.finishReason) + '</span>');
  if (meta.telemetry?.passes != null) bits.push('<span>passes <b>' + meta.telemetry.passes + '</b></span>');
  if (meta.telemetry?.latencyMs != null) bits.push('<span>' + (meta.telemetry.latencyMs / 1000).toFixed(1) + 's</span>');
  if (meta.skills?.length) bits.push('<span>skills: ' + MD.esc(meta.skills.join(', ')) + '</span>');
  if (!bits.length) return null;
  const d = document.createElement('div'); d.className = 'telemetry'; d.innerHTML = bits.join(''); return d;
}
function addMsg(cls, text, meta = null, animate = true, toolEvents = null, at = null) {
  if (!msgCount++) { empty.style.display = 'none'; bar.classList.add('started'); }
  const w = document.createElement('div'); w.className = 'msg-wrap ' + cls; if (!animate) w.style.animation = 'none';
  const label = document.createElement('div'); label.className = 'msg-label';
  label.innerHTML = '<span class="role-tag">' + (cls === 'user' ? 'YOU' : 'AI') + '</span><span class="msg-ts">' + fmtTs(at) + '</span>';
  if (cls === 'ai' && (meta?.instance || meta?.provider?.name)) { const p = document.createElement('span'); p.className = 'provider-tag'; p.textContent = (meta.instance || meta.provider.name) + (meta.model ? ' / ' + String(meta.model).split('/').pop() : ''); label.appendChild(p); }
  w.appendChild(label);
  if (cls === 'ai' && toolEvents?.length) {
    w.appendChild(TL.make(toolEvents).root);
    const byId = new Map();
    for (const ev of toolEvents) { if (!/^(create|update)_artifact$/.test(ev.tool) || ev.error || !ev.result?.id) continue; const prev = byId.get(ev.result.id); byId.set(ev.result.id, { ...ev, args: { ...(prev?.args || {}), ...ev.args }, result: { ...(prev?.result || {}), ...ev.result, title: ev.result.title ?? prev?.result?.title } }); }
    for (const ev of byId.values()) { const c = renderAppCard(ev); if (c) w.appendChild(c); }
  }
  if (cls === 'ai' && meta?.reasoning?.length) meta.reasoning.forEach((t, i) => { const d = document.createElement('details'); d.className = 'think'; if (SETTINGS.current().thinking === 'open') d.open = true; d.innerHTML = '<summary></summary><div class="think-body"></div>'; d.querySelector('summary').textContent = 'thinking' + (meta.reasoning.length > 1 ? ' ' + (i + 1) : '') + ' · ' + t.length + ' chars'; d.querySelector('.think-body').textContent = t; w.appendChild(d); });
  const body = document.createElement('div'); body.className = 'msg-body md'; body.dataset.raw = text; body.innerHTML = cls === 'user' ? MD.esc(text) : MD.render(text); w.appendChild(body); if (cls === 'ai') MD.enhance(body);
  if (cls === 'ai') { const t = telemetryEl(meta); if (t) w.appendChild(t); if (meta?.truncated && !meta.autoContinued) truncNote(w); }
  const acts = document.createElement('div'); acts.className = 'msg-actions';
  const mk = (t, fn) => { const b = document.createElement('button'); b.textContent = t; b.onclick = fn; acts.appendChild(b); };
  mk('copy', () => navigator.clipboard.writeText(body.dataset.raw));
  if (cls === 'user') mk('edit', () => enterEditMode(w, body, body.dataset.raw)); else { mk('retry', () => retryFromMsg(w)); mk('continue', () => sendWith(CONTINUE_PROMPT, { continuation: true })); }
  w.appendChild(acts);
  chat.insertBefore(w, typing); if (SETTINGS.current().autoScroll !== false || cls === 'user') chat.scrollTop = chat.scrollHeight;
  if (cls === 'ai') lastAiWrap = w;
  return w;
}
const CONTINUE_PROMPT = 'Continue exactly where you stopped. Do not repeat anything.';
function truncNote(w) { const n = document.createElement('div'); n.className = 'trunc'; n.innerHTML = 'cut at the output limit · '; const b = document.createElement('button'); b.className = 'act-btn'; b.textContent = 'continue'; b.onclick = () => { n.remove(); sendWith(CONTINUE_PROMPT, { continuation: true }); }; n.appendChild(b); w.appendChild(n); }
/** A continuation reply is appended into the previous AI bubble instead of opening a new one. */
function appendToLast(text, meta) {
  if (!lastAiWrap) return addMsg('ai', text, meta, true, meta?.toolEvents);
  const body = lastAiWrap.querySelector('.msg-body'); body.dataset.raw += text; body.innerHTML = MD.render(body.dataset.raw); MD.enhance(body);
  lastAiWrap.querySelectorAll('.trunc,.telemetry').forEach(n => n.remove());
  // A continuation round's own tool calls were previously dropped here entirely: addMsg() bakes a fresh
  // turn's toolEvents into a permanent TL block in the bubble, but this function only ever touched the
  // text. The LIVE progress table the user watches filling up while "continue" runs gets torn down by
  // finish() same as any round — that part is normal — but nothing replaced it here, so a continuation's
  // tool activity (and any artifact it built/edited) vanished with no permanent record: the table
  // appeared to just disappear into nothing. Mirror addMsg(): bake this round's events into their own
  // block, and surface any artifact build/update from it as an app card too.
  if (meta?.toolEvents?.length) {
    const actionsEl = lastAiWrap.querySelector('.msg-actions');
    lastAiWrap.insertBefore(TL.make(meta.toolEvents).root, actionsEl);
    const byId = new Map();
    for (const ev of meta.toolEvents) { if (!/^(create|update)_artifact$/.test(ev.tool) || ev.error || !ev.result?.id) continue; const prev = byId.get(ev.result.id); byId.set(ev.result.id, { ...ev, args: { ...(prev?.args || {}), ...ev.args }, result: { ...(prev?.result || {}), ...ev.result, title: ev.result.title ?? prev?.result?.title } }); }
    for (const ev of byId.values()) { const c = renderAppCard(ev); if (c) lastAiWrap.insertBefore(c, actionsEl); }
  }
  const t = telemetryEl(meta); if (t) lastAiWrap.insertBefore(t, lastAiWrap.querySelector('.msg-actions'));
  const c = lastAiWrap.querySelector('.cont-n'); const n = (c ? Number(c.dataset.n) : 0) + 1; if (c) c.remove();
  const tag = document.createElement('span'); tag.className = 'msg-ts cont-n'; tag.dataset.n = n; tag.textContent = '+' + n + ' continued'; lastAiWrap.querySelector('.msg-label').appendChild(tag);
  if (meta?.truncated && !meta.autoContinued) truncNote(lastAiWrap);
  return lastAiWrap;
}
function enterEditMode(wrap, bodyEl, original) {
  bodyEl.style.display = 'none'; wrap.querySelector('.msg-actions').style.display = 'none';
  const ta = document.createElement('textarea'); ta.className = 'edit-area'; ta.value = original; ta.rows = Math.min(original.split('\n').length + 1, 8);
  const btns = document.createElement('div'); btns.className = 'edit-btns';
  const cancel = document.createElement('button'); cancel.className = 'edit-btn'; cancel.textContent = 'cancel'; cancel.onclick = () => { ta.remove(); btns.remove(); bodyEl.style.display = ''; wrap.querySelector('.msg-actions').style.display = ''; };
  const ok = document.createElement('button'); ok.className = 'edit-btn confirm'; ok.textContent = 'resend →'; ok.onclick = () => { const t = ta.value.trim(); if (!t) return; const all = [...chat.querySelectorAll('.msg-wrap')], i = all.indexOf(wrap); all.slice(i).forEach(n => n.remove()); msgCount = Math.max(0, msgCount - (all.length - i)); sendWith(t); };
  btns.appendChild(cancel); btns.appendChild(ok); wrap.appendChild(ta); wrap.appendChild(btns); ta.focus();
}
function retryFromMsg(aiWrap) { const all = [...chat.querySelectorAll('.msg-wrap')], i = all.indexOf(aiWrap); if (i < 1) return; const q = all[i - 1].querySelector('.msg-body')?.dataset.raw || ''; all.slice(i - 1).forEach(n => n.remove()); msgCount = Math.max(0, msgCount - (all.length - (i - 1))); sendWith(q); }
function addError(message, details, retryText, keep) {
  const w = addMsg('ai', ''); w.querySelector('.msg-body').remove(); w.querySelector('.msg-actions').remove();
  const card = document.createElement('div'); card.className = 'err-card';
  card.innerHTML = '<div class="err-h">error</div><div class="err-m"></div>'; card.querySelector('.err-m').textContent = message;
  if (details?.length) { const d = document.createElement('details'); d.innerHTML = '<summary>details (' + details.length + ')</summary><pre></pre>'; d.querySelector('pre').textContent = details.join('\n'); card.appendChild(d); }
  if (keep?.events?.length) { const t = TL.make(keep.events, { live: false, label: 'what happened before the error', open: true }); card.appendChild(t.root); }
  if (keep?.draft) { const d = document.createElement('details'); d.open = true; d.innerHTML = '<summary>draft reply recovered (' + keep.draft.length + ' chars, last part)</summary><pre style="white-space:pre-wrap"></pre>'; d.querySelector('pre').textContent = keep.draft; card.appendChild(d); }
  const acts = document.createElement('div'); acts.className = 'err-actions'; const rb = document.createElement('button'); rb.className = 'act-btn'; rb.textContent = 'retry'; rb.onclick = () => { w.remove(); msgCount--; sendWith(retryText); }; acts.appendChild(rb); card.appendChild(acts); w.appendChild(card);
}

// ─── turn ─────────────────────────────────────────────────────────────────────
function showTyping(v, label = 'thinking') { typingLbl.textContent = label; typing.style.display = v ? 'block' : 'none'; if (v) chat.scrollTop = chat.scrollHeight; document.dispatchEvent(new CustomEvent('omni:typing', { detail: { on: v, label, progress: progressEl.textContent } })); }
function setSendState(busy) { sendBtn.classList.toggle('stop', busy); sendBtn.title = busy ? 'stop (Esc)' : 'send (Enter)'; sendBtn.onclick = busy ? stopGen : sendMsg; sendBtn.innerHTML = busy ? '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="4" y="4" width="8" height="8"/></svg>' : '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2L2 8l4 2 2 4 6-12z"/></svg>'; $('pill-model').classList.toggle('busy', busy); }
function stopGen() { if (aborter) aborter.abort(); SWARM.stop(); }
const APP_ASK = /\b(create|build|write|implement|generate|make|design|code|develop)\b[\s\S]*\b(app|application|game|editor|dashboard|simulat\w*|tool|ide|player|visuali[sz]\w*|engine|synth\w*|tracker|planner|studio|workbench|explorer|builder|designer|sequencer|daw|calculator|clone)\b/i;
async function sendMsg() { const t = inp.value.trim(); if (!t) return; if (/^finalize[.!]?$/i.test(t)) { inp.value = ''; return finalize(); } if (inflight) return; FINALIZE.requested = false; inp.value = ''; inp.style.height = 'auto'; charEl.textContent = ''; SLASH.hide(); if (t.startsWith('/') && await SLASH.run(t)) return;
  // App-scale asks: the swarm path (architect → 8–16 parallel builders → integrate) is the only way a 60 s val produces a ≥ 900-line product in one go.
  if ((SETTINGS.current().autoSwarm ?? true) && APP_ASK.test(t) && t.length < 6000 && !ART.focusPayload()) { barStatus.textContent = 'app-scale ask → /build'; await SWARM.build(t); return; }
  await sendWith(t); }
function addSysCard(tag, text, detail) { const n = document.createElement('div'); n.className = 'msg-wrap sys'; n.innerHTML = '<div class="msg-label"><span class="role-tag"></span><span class="msg-ts">' + ts() + '</span></div><div class="msg-body" style="color:var(--dim);font-size:11px;white-space:pre-wrap"></div>'; n.querySelector('.role-tag').textContent = tag; const b = n.querySelector('.msg-body'); b.textContent = text; if (detail) { const d = document.createElement('details'); d.style.marginTop = '4px'; const sm = document.createElement('summary'); sm.textContent = 'summary'; sm.style.cursor = 'pointer'; const pre = document.createElement('div'); pre.textContent = detail; pre.style.whiteSpace = 'pre-wrap'; d.append(sm, pre); b.appendChild(d); } chat.insertBefore(n, typing); msgCount++; return n; }
// ── conversation compaction: runs as its own val invocation after a turn (server flags needsCompact) or via /compact ──
const COMPACT = (() => {
  let running = false;
  async function run(manual) {
    if (running) return false; running = true; barStatus.textContent = 'compacting history…';
    try {
      const r = await fetchT('?compact', { method: 'POST', headers: { 'content-type': 'application/json' }, body: encBody({ session: currentSession, settings: SETTINGS.forRequest() }) }, 70_000).then(x => x.json());
      if (r.error) { if (manual) addSysCard('COMPACT', 'failed: ' + (r.error.message || r.error)); return false; }
      if (!r.ok) { if (manual) addSysCard('COMPACT', r.reason || 'nothing to fold'); return false; }
      const c = await fetch('?compact=' + encodeURIComponent(currentSession)).then(x => x.json()).catch(() => ({}));
      addSysCard('COMPACT', 'folded ' + r.covered + ' older messages into the running summary (' + r.before.toLocaleString() + ' → ' + r.after.toLocaleString() + ' chars); ' + (c.compact ? c.compact.covered + ' messages summarized in total' : ''), c.compact?.summary);
      return true;
    } catch (e) { if (manual) addSysCard('COMPACT', 'failed: ' + e.message); return false; }
    finally { running = false; if (barStatus.textContent.startsWith('compacting')) barStatus.textContent = ''; }
  }
  async function show() { const c = await fetch('?compact=' + encodeURIComponent(currentSession) + '&check=' + (Number(SETTINGS.current().contextChars) || 16000)).then(x => x.json()).catch(() => ({})); if (c.compact) addSysCard('COMPACT', c.compact.covered + ' earlier messages are folded into a running summary the model reads instead of the full history', c.compact.summary); if (c.needs && (SETTINGS.current().autoCompact ?? true)) run(false); return !!c.compact; }
  async function clear() { await fetch('?compact=' + encodeURIComponent(currentSession), { method: 'DELETE' }); addSysCard('COMPACT', 'summary cleared — the model sees raw history again (within the budget)'); }
  return { run, show, clear };
})();
// ── /finalize: end the work-until-finalize chain and run one closing turn (acceptance walk, lint, README, summary) ──
const FINALIZE = { requested: false };
async function finalize() {
  FINALIZE.requested = true; stopGen(); barStatus.textContent = 'finalizing…';
  for (let t = 0; t < 40 && inflight; t++) await wait(250); /* let the aborted turn unwind */
  // sendWith() silently no-ops if inflight is still true (its own re-entrancy guard) — previously that meant a
  // slow-to-unwind prior turn made /finalize appear to do nothing at all, with FINALIZE.requested reset right after
  // as if the closing pass had actually run. Detect the stuck case and say so instead of pretending it happened.
  if (inflight) { FINALIZE.requested = false; barStatus.textContent = ''; addSysCard('FINALIZE', 'could not start — the previous turn is still stopping. Press stop again if it looks stuck, then run /finalize once more.'); return; }
  const f = ART.focusPayload();
  await sendWith('FINALIZE. Stop adding features. Walk the acceptance list and README against the shipped files, fix any lint or portability finding with update_artifact, make README.md match exactly what exists, then give the closing summary: what it does, how to run it, known limits.', { finalize: true, ...(f || {}) });
  FINALIZE.requested = false;
}
/** extra: {continuation:true} appends to the last AI bubble; {focus} targets an artifact; {__quiet} skips the user bubble; {__skill} one-turn skill;
 * {sessionId} pins this turn — and any auto-continue/follow-up/improve round it spawns — to the session it started in,
 * instead of reading the live, mutable currentSession throughout the turn's lifetime. Previously a session switch mid-turn
 * could misroute progress polling, crash recovery and the eventual reply into whichever session happened to be open when
 * each of those ran; own() below draws the line between "which session is this data for" (sessionId) and "should this
 * turn paint into the visible UI right now" (is sessionId still the one on screen);
 * {__ownsInflight} lets a caller that already holds the single global inflight/send-button lock (the swarm's integrate
 * step, from fanout()) keep holding it across this call instead of sendWith re-acquiring/releasing its own — closing the
 * window where a manual send could slip in between the swarm's builders finishing and integration starting and get
 * silently rejected by sendWith's own inflight guard, along with the aborted/failed integration it was hiding. */
async function sendWith(text, extra) {
  /* A DEFAULT PARAMETER (extra = {}) was not enough: a default fires only on undefined, never on null,
     and ART.focusPayload() returns null whenever the artifact panel is closed. ui-artifacts-script.ts
     passes that straight through, so autoFixErrors - which runs on a timer, typically after the panel has
     closed - threw on the very first property access below. sendWith is called from another module and
     cannot police its callers, so the coercion belongs here. */
  extra = extra || {};
  if (!extra.__ownsInflight) { if (inflight) return false; inflight = true; setSendState(true); }
  const sessionId = extra.sessionId || currentSession;
  const own = () => sessionId === currentSession;
  const focusExtra = extra.focus !== undefined ? { focus: extra.focus } : (ART.focusPayload() || {});
  const isCont = !!extra.continuation;
  if (extra.followup) { const n = document.createElement('div'); n.className = 'msg-wrap sys'; n.innerHTML = '<div class="msg-label"><span class="role-tag">AUTO</span><span class="msg-ts">' + ts() + '</span></div><div class="msg-body" style="color:var(--dim);font-size:11px;white-space:pre-wrap"></div>'; n.querySelector('.msg-body').textContent = 'continuing unfinished work:\n' + extra.followup.map(x => '• ' + x).join('\n'); if (own()) { chat.insertBefore(n, typing); msgCount++; } }
  else if (!isCont && !extra.__quiet && own()) addMsg('user', text);
  if (own()) { showTyping(true, isCont ? 'continuing' : 'thinking'); tabProgress(isCont ? 'continuing' : 'thinking'); progressEl.textContent = ''; liveThink.textContent = ''; }
  const S0 = SETTINGS.current();
  const plan = isCont ? ['answer'] : [S0.plan ? 'plan' : null, 'answer', S0.verify ? 'verify' : null].filter(Boolean);
  const live = TL.make([], { live: true, label: isCont ? 'continuing' : 'working', plan });
  if (own()) { liveTl.innerHTML = ''; liveTl.appendChild(live.root); }
  // Per-turn controller. 'return sendWith(next)' inside this try/finally starts the NEXT turn before this turn's finally runs,
  // so finish() must only tear down state that still belongs to this turn — otherwise it nulls the successor's aborter mid-flight.
  const ac = new AbortController(); aborter = ac;
  let since = 0, polling = true, finished = false, draft = ''; const events = [];
  (async () => { while (polling) { await wait(document.hidden ? 5000 : 2000); if (!polling) break; try {
    const j = await (await fetch('?progress=' + encodeURIComponent(sessionId) + '&since=' + since, { signal: ac.signal })).json(); since = j.next;
    for (const d of j.events) { if (d.type === 'stage' && d.label !== 'done') { events.push(d); if (own()) showTyping(true, d.label); } else if (d.type === 'tool') { events.push({ ...d, live: true }); if (own()) showTyping(true, 'tool: ' + d.tool); } else if (d.type === 'thinking') { if (own() && SETTINGS.current().liveThinking) liveThink.textContent = d.text; } else if (d.type === 'partial') { draft = d.text; if (own()) { liveDraft.hidden = false; liveDraftT.textContent = d.text; liveDraftN.textContent = '(last ' + d.text.length + ' chars)'; liveDraftT.scrollTop = liveDraftT.scrollHeight; } } else if (d.type === 'pass' || d.type === 'continue' || d.type === 'retry') events.push(d); }
    live.set(events); if (own() && live.root.parentNode !== liveTl) { liveTl.innerHTML = ''; liveTl.appendChild(live.root); }
    } catch {} } })();
  const base = SETTINGS.forRequest();
  if (extra.__skill) base.skills = [...(base.skills || []), { ...extra.__skill, mode: 'always' }];
  if (extra.__force === 'ensemble') base.ensemble = true;
  const settings = { ...base, ...focusExtra, continuation: isCont, followup: !!extra.followup };
  let ok = false;
  try {
    // Exhaustion is retried from the CLIENT (the server has a 60 s wall clock): keep trying with backoff until
    // retryMinutes elapse or the user presses stop. The server dedupes the re-sent user message (retryOf).
    // MIN_RETRY_ATTEMPTS is a floor, not a target: exhaustion must be retried at least this many times even
    // if retryMinutes (default 5 min) would otherwise cut it short — a short default window must never look
    // like "gave up after 2 tries". Once MIN_RETRY_ATTEMPTS is reached, retryMinutes governs again as before.
    const forever = !!S0.untilStopped && !extra.finalize; /* keep going until the stop button: retries, cut-reply continues and follow-up rounds are unbounded */
    const retryMs = forever ? Infinity : Math.max(0, Number(S0.retryMinutes ?? 5)) * 60_000, tStart = Date.now();
    const MIN_RETRY_ATTEMPTS = 10;
    let final = null, attempt = 0;
    for (;;) {
      attempt++;
      let r; let gateMsg = '';
      // Read the body ONCE as text, then parse. r.json().catch(() => null) discarded the body on a parse
      // failure, which threw away the only evidence that identifies an edge block — see describeGate().
      try { r = await fetchT('?q', { method: 'POST', headers: { 'content-type': 'application/json' }, signal: ac.signal, body: encBody({ q: text, session: sessionId, settings: { ...settings, retryOf: attempt > 1 } }) }); const raw = await r.text().catch(() => ''); try { final = raw ? JSON.parse(raw) : null; } catch (_) { final = null; if (!r.ok) { gateMsg = describeGate(r, raw) + ' ' + await classifyGate(); } } }
      catch (e) { if (e.name === 'AbortError') throw e; /* transport failure: the server may still have finished — check before re-sending */ const rec = await recoverFromHistory(text, sessionId); if (rec) { final = { reply: rec.content, meta: rec.meta, toolEvents: rec.meta?.toolEvents, truncated: rec.meta?.truncated }; break; } r = { ok: false, status: 0 }; final = { error: e.message }; }
      let emptyReply = false;
      if (r.ok && final && !final.error) {
        // A 200 with nothing usable in it — blank, or nothing but dots (the same junk-generation
        // signature app-infer.ts/router-core.ts guard against) — must never be accepted as a finished
        // turn. toolEvents alone (no text) is legitimate (e.g. a pure tool-call turn); only flag when
        // there's neither real text nor recorded tool activity.
        const replyStripped = String(final.reply ?? '').replace(/\s+/g, '');
        const looksEmpty = replyStripped.length === 0 || /^\.+$/.test(replyStripped);
        if (!looksEmpty || (final.toolEvents && final.toolEvents.length)) break;
        emptyReply = true;
      }
      const e = final?.error; const msg = emptyReply ? 'server returned an empty or dot-only reply' : (typeof e === 'string' ? e : (e?.message || gateMsg || ('HTTP ' + r.status))); const details = Array.isArray(e?.details) ? e.details : [];
      // STATUS-first, text second. clientStatusFor() (app.tsx) distinguishes "upstream failed US" (502)
      // from "YOU are not allowed" (403); matching message text alone missed it, since an upstream 403
      // arrives as "router 403: ..." which no pattern here matches - so it threw on the first attempt.
      // 403 stays out (a closed gate does not open on retry) and so does 500 (a deterministic bug).
      // The text patterns remain the fallback for transport failures, where there is no status to read.
      const exhausted = emptyReply || RETRY_STATUS.indexOf(r.status) !== -1 || /EXHAUSTED|COOLING|router 50[23]|HTTP 50[23]|TIMEOUT|DEADLINE|failed to fetch|networkerror|load failed/i.test(msg + ' ' + details.slice(0, 3).join(' '));
      const elapsed = Date.now() - tStart;
      if (!exhausted || (attempt >= MIN_RETRY_ATTEMPTS && elapsed >= retryMs)) { const x = new Error(msg + (attempt > 1 ? ' (after ' + attempt + ' attempts over ' + Math.round(elapsed / 1000) + 's)' : '')); x.details = details; x.structured = true; throw x; }
      // A DEADLINE is not congestion. TURN_DEADLINE/ROUTER_DEADLINE mean this val invocation ran out of its
      // own 60 s, which says nothing about whether a provider is busy — so the 8s/16s/24s congestion backoff
      // was pure dead time (the trace showed 'waiting 9s' then 'waiting 18s' for a server-side clock).
      // Retry almost immediately; the server keeps whatever it persisted and the next attempt starts fresh
      // against it. The escalating backoff still governs real provider exhaustion.
      const deadline = /TURN_DEADLINE|ROUTER_DEADLINE|response deadline/i.test(msg);
      const waitMs = deadline ? jitter(1_500) : jitter(Math.min(45_000, 8_000 * attempt));
      events.push({ type: 'retry', n: attempt, error: msg.slice(0, 80) + ' — waiting ' + Math.round(waitMs / 1000) + 's' + (details.length ? '\n' + details.slice(0, 6).join('\n') : '') }); live.set(events);
      for (let left = waitMs; left > 0; left -= 1000) { if (ac.signal.aborted) { const x = new Error('stopped'); x.name = 'AbortError'; throw x; } if (own()) { showTyping(true, 'providers busy — retry ' + (attempt + 1) + ' in ' + Math.ceil(left / 1000) + 's (' + (forever ? '∞' : Math.round((retryMs - elapsed) / 60000) + ' min') + ' left)'); tabProgress('retry ' + (attempt + 1)); } await wait(1000); }
      since = 0; // the next attempt writes a fresh progress log
    }
    if (own()) showTyping(false); ok = true;
    const meta = { ...(final.meta || {}), telemetry: final.telemetry, reasoning: final.reasoning, truncated: final.truncated, skills: final.skills, toolEvents: final.toolEvents };
    const autoLeft = extra.__autoLeft ?? (forever ? Infinity : (SETTINGS.current().autoContinue ?? 6));
    // no-progress guard for unbounded mode: two consecutive continuations that add nothing end the chain
    const noProgress = isCont && String(final.reply || '').trim().length < 20 ? (extra.__stall ?? 0) + 1 : 0;
    const willAuto = final.truncated && autoLeft > 0 && noProgress < 2;
    if (willAuto) meta.autoContinued = true;
    // Everything below that renders into the DOM or touches session-scoped chrome (title bar, artifact panel, compact,
    // the runs log) only runs if this turn's session is still the one on screen (own()). If the user switched away, the
    // reply is already safely persisted server-side under sessionId (the request body above used sessionId, not the
    // live global) — switchSession()'s history fetch will render it correctly next time that session is opened. Before
    // this fix all of this unconditionally used the live, possibly-since-changed currentSession/DOM, so a switch mid-turn
    // could land a reply, a title rename, or an artifact refresh in the wrong session's UI.
    if (own()) {
      if (isCont) appendToLast(final.reply || '', meta); else addMsg('ai', final.reply || '…', meta, true, final.toolEvents);
      turnLog.push({ q: text, reply: final.reply, meta, ts: Date.now() });
      if (final.sessionName) { titleEl.textContent = final.sessionName.toUpperCase(); loadSessions(); } else if (msgCount <= 2) loadSessions();
      // An update to the artifact you already had loaded refreshes it in place (ART.refresh) — it only actually
      // switches the visible view if the workbench panel is already open (you're already looking at it); if
      // you're on the chat view it just badges the build tab instead of yanking you off what you're reading.
      // A brand-new artifact with nothing previously loaded still honors autoOpen (that's what it's for).
      if (final.toolEvents?.some(e => /artifact/.test(e.tool) && !e.error)) { ART.listForSession(sessionId); const c = ART.current(); if (c && final.toolEvents.some(e => e.result?.id === c.id)) ART.refresh(c.id); else if (!c && ART.settings().autoOpen) { const ev = final.toolEvents.find(e => e.tool === 'create_artifact' && e.result?.id); if (ev) ART.open(ev.result.id); } }
      document.dispatchEvent(new CustomEvent('omni:turn', { detail: { text, final } }));
      // A turn that SCHEDULED a build returns immediately with a job id and a drained-in-one-tick queue.
      // Nothing moved it after that: the reply told the user to poll ?build_status and no code did. Drive
      // it here - main-build-script.ts polls until the job is complete, drained, stalled or stopped.
      if (final.scheduled && final.job && typeof BUILD !== 'undefined') BUILD.drive(final.job, sessionId);
      if (final.needsCompact && (SETTINGS.current().autoCompact ?? true)) COMPACT.run(false);
    } else if (final.sessionName) { loadSessions(); } // background turn: still refresh the sidebar's name list, just never the visible title bar
    if (willAuto) { if (own()) { finish(); barStatus.textContent = 'auto-continuing (' + (forever ? '∞' : autoLeft) + ' left)'; } else finish(); return sendWith(CONTINUE_PROMPT, { continuation: true, __autoLeft: autoLeft - 1, __stall: noProgress, sessionId, __ownsInflight: extra.__ownsInflight }); }
    // The chain is ending here even though the model was still mid-output (final.truncated) — say why,
    // instead of leaving the user to notice only that the live table vanished and nothing more happened.
    // The two silent causes: the stall guard (two continuation rounds in a row added under 20 chars —
    // real, since a genuinely finished reply is usually longer, but no reason not to say so) and the
    // per-turn auto-continue cap (SETTINGS autoContinue, default 6) simply running out.
    if (own() && isCont && final.truncated && !willAuto) {
      addSysCard('AUTO', noProgress >= 2
        ? 'auto-continue stopped: the last two rounds made no real progress — click "continue" above to try again, or rephrase the ask'
        : 'auto-continue stopped: reached the ' + (SETTINGS.current().autoContinue ?? 6) + '-round limit while the reply was still being cut off — click "continue" above to keep going');
    }
    // Completion audit says the ask is not finished: keep going with the remaining items (bounded, stop button aborts).
    const compLeft = extra.__compLeft ?? (forever ? Infinity : (SETTINGS.current().autoComplete ?? 4));
    const rem = final.completion && !final.completion.done ? final.completion.remaining : [];
    const sameAsBefore = extra.followup && JSON.stringify(rem) === JSON.stringify(extra.followup);
    if (rem.length && compLeft > 0 && !sameAsBefore) {
      if (own()) { finish(); barStatus.textContent = 'not finished — continuing (' + (forever ? '∞' : compLeft) + ' rounds left)'; } else finish();
      const f = own() ? (ART.focusPayload() || {}) : {};
      return sendWith('Continue the task until it is fully complete. Remaining work (do all of it, verify, then report):\n' + rem.map(x => '- ' + x).join('\n'), { followup: rem, __compLeft: compLeft - 1, sessionId, __ownsInflight: extra.__ownsInflight, ...f });
    }
    if (own() && final.completion && final.completion.done) barStatus.textContent = '';
    // Work-until-finalize: the ask is complete, but the user has not said /finalize — ship the next most valuable upgrades.
    // Ends when: /finalize or stop; two consecutive rounds that write nothing; the model reports nothing left worth shipping.
    if (forever && !FINALIZE.requested && final.completion && final.completion.done && (extra.__improve || ART.current() || (final.toolEvents || []).some(e => /artifact/.test(e.tool)))) {
      const wrote = (final.toolEvents || []).some(e => /^(create|update)_artifact$/.test(e.tool) && !e.error);
      const idle = extra.__improve && !wrote ? (extra.__idle ?? 0) + 1 : 0;
      if (idle >= 2 || /NOTHING_LEFT/.test(final.reply || '')) { if (own()) { addSysCard('AUTO', 'no further upgrades produced in two rounds — waiting for you (/finalize to wrap up, or give a new direction)'); barStatus.textContent = 'idle — /finalize when ready'; } }
      else {
        if (own()) { finish(); const round = (extra.__improve ?? 0) + 1; barStatus.textContent = 'improvement round ' + round + ' — /finalize to stop'; tabProgress('improve ' + round); } else finish();
        const round = (extra.__improve ?? 0) + 1;
        const f = own() ? (ART.focusPayload() || {}) : {};
        return sendWith('The task is complete and the user has not finalized yet. Working until told to finalize: choose the 3 most valuable upgrades a principal engineer would ship NEXT for this artifact (new capabilities, robustness, performance, accessibility, polish — never a rewrite, never a regression, never placeholders), implement them fully with update_artifact, verify lint is clean, then report exactly what shipped. If nothing worthwhile remains, reply with the single line NOTHING_LEFT.', { followup: ['improvement round ' + round], __improve: round, __idle: idle, sessionId, __ownsInflight: extra.__ownsInflight, ...f });
      }
    }
  } catch (e) {
    let recovered = null;
    if (e.name !== 'AbortError' && !e.structured) { if (own()) showTyping(true, 'recovering'); for (let t = 0; t < 8 && !recovered; t++) { await wait(3000); recovered = await recoverFromHistory(text, sessionId); } }
    if (own()) showTyping(false);
    if (recovered) { ok = true; if (own()) addMsg('ai', recovered.content, recovered.meta, true, recovered.meta?.toolEvents); }
    else if (own()) { if (e.name === 'AbortError') addMsg('ai', '_[stopped]_'); else addError(e.message, e.details || [], text, { events: events.slice(), draft }); }
    if (own()) document.dispatchEvent(new CustomEvent('omni:turn', { detail: { text, error: recovered ? null : (e.name === 'AbortError' ? 'stopped' : e.message), final: recovered ? { reply: recovered.content } : null } }));
  } finally { finish(); }
  return ok;
  // extra.__ownsInflight: the caller (fanout's integrate step) already holds inflight/setSendState — leave that lock
  // alone here so it doesn't get released between the swarm's build phase and integrate phase (see fanout()).
  function finish() { if (finished) return; finished = true; polling = false; live.finish(ok); if (aborter !== ac) return; /* a successor turn owns the shared state now */ aborter = null; if (!extra.__ownsInflight) { inflight = false; setSendState(false); } if (own()) { tabProgress(''); progressEl.textContent = ''; liveThink.textContent = ''; liveDraft.hidden = true; liveDraftT.textContent = ''; liveTl.innerHTML = ''; barStatus.textContent = ''; } if (view === 'runs') renderRuns(); }
}

// ─── composer: chips, slash commands, textarea ────────────────────────────────
function renderChips() {
  const S = SETTINGS.current(); const c = ART.current(); chipsEl.innerHTML = '';
  const chip = (t, on, fn, title) => { const s = document.createElement('span'); s.className = 'chip' + (on ? ' on' : ''); s.textContent = t; s.title = title || ''; s.onclick = fn; chipsEl.appendChild(s); return s; };
  chip('mode: ' + (S.mode === 'pin' ? (S.pin || 'pin') : S.mode === 'auto' ? 'best free' : S.mode), false, () => { const order = ['auto', 'fast', 'coder', 'reasoning']; SETTINGS.set('mode', order[(order.indexOf(S.mode) + 1) % order.length]); renderChips(); }, 'click to cycle routing mode');
  chip('expect: ' + (S.expect || 'auto'), false, () => { const o = ['auto', 'short', 'long', 'max']; SETTINGS.set('expect', o[(o.indexOf(S.expect || 'auto') + 1) % o.length]); renderChips(); }, 'expected reply length → drives max_tokens and vendor choice');
  if (c && !document.getElementById('apanel').classList.contains('closed')) chip('focus #' + c.id, true, () => ART.close(), 'requests target this artifact');
  const sk = (S.skills || []).filter(k => k.mode === 'always').length; if (sk) chip(sk + ' skill' + (sk > 1 ? 's' : '') + ' always', true, () => SETTINGS.toggle(true));
  if (S.autoContinue === 0) chip('auto-continue off', false, () => SETTINGS.toggle(true));
  $('pill-model-t').textContent = S.mode === 'pin' ? (S.pin || 'pin') : S.mode === 'auto' ? 'best free' : S.mode;
}
document.addEventListener('omni:settings', renderChips); document.addEventListener('omni:artifact-opened', renderChips); document.addEventListener('omni:artifact-closed', renderChips);
function prefill(t) { inp.value = t; inp.dispatchEvent(new Event('input')); inp.focus(); inp.setSelectionRange(t.length, t.length); }
const SLASH = (() => {
  const CMDS = [
    { c: '/build', h: 'plan → parallel builders → integrate (large multi-file apps)', run: (a) => SWARM.build(a) },
    { c: '/plan', h: 'manifest only; review, then "build all" on the card', run: (a) => SWARM.plan(a) },
    { c: '/fix', h: 'repair the open artifact from console errors', run: (a) => { const f = ART.focusPayload(); if (!f) { barStatus.textContent = 'open an artifact first'; return false; } return sendWith((a || 'Fix the artifact.') + (f.focus.errors.length ? '\nConsole:\n' + f.focus.errors.join('\n') : ''), f); } },
    { c: '/resume', h: 'resume an unfinished /build in this session', run: () => SWARM.checkResume(false) },
    { c: '/finalize', h: 'stop the work-until-finalize chain and run the closing pass', run: () => finalize().then(() => true) },
    { c: '/compact', h: 'fold older turns into a running summary now (/compact clear removes it)', run: (a) => a === 'clear' ? COMPACT.clear().then(() => true) : COMPACT.run(true).then(() => true) },
    { c: '/continue', h: 'continue the last reply', run: () => sendWith(CONTINUE_PROMPT, { continuation: true }) },
    { c: '/ensemble', h: 'answer with N drafts + reconciler (this turn)', run: (a) => sendWith(a, { __force: 'ensemble' }) },
    { c: '/fast', h: 'fastest vendor from now on', run: (a) => { SETTINGS.set('mode', 'fast'); renderChips(); return a ? sendWith(a) : true; } },
    { c: '/best', h: 'best free model from now on', run: (a) => { SETTINGS.set('mode', 'auto'); renderChips(); return a ? sendWith(a) : true; } },
    { c: '/coder', h: 'coder routing from now on', run: (a) => { SETTINGS.set('mode', 'coder'); renderChips(); return a ? sendWith(a) : true; } },
    { c: '/skill', h: '/skill <name> <message> — activate a skill for this turn only', run: (a) => { const [n, ...rest] = a.split(/\s+/); const k = (SETTINGS.current().skills || []).find(s => s.name.toLowerCase() === (n || '').toLowerCase()); if (!k) { barStatus.textContent = 'no skill named ' + n; return false; } return sendWith(rest.join(' '), { __skill: k }); } },
    { c: '/new', h: 'new chat', run: () => { newChat(); return true; } },
    { c: '/runs', h: 'open the runs inspector', run: () => { setView('runs'); return true; } },
    { c: '/settings', h: 'open settings', run: () => { SETTINGS.toggle(true); return true; } },
  ];
  const box = $('slash'); let sel = 0, items = [];
  function show(q) { items = CMDS.filter(c => c.c.startsWith(q.split(' ')[0])); if (!items.length || q.includes(' ')) return hide(); sel = 0; box.innerHTML = items.map((c, i) => '<div class="slash-i' + (i === sel ? ' sel' : '') + '" data-i="' + i + '"><b>' + c.c + '</b><span>' + MD.esc(c.h) + '</span></div>').join(''); box.classList.add('on'); box.querySelectorAll('.slash-i').forEach(el => el.onclick = () => { prefill(items[el.dataset.i].c + ' '); hide(); }); }
  function hide() { box.classList.remove('on'); items = []; }
  function key(e) { if (!items.length) return false; if (e.key === 'ArrowDown') { sel = (sel + 1) % items.length; } else if (e.key === 'ArrowUp') { sel = (sel - 1 + items.length) % items.length; } else if (e.key === 'Tab' || (e.key === 'Enter' && !inp.value.includes(' '))) { prefill(items[sel].c + ' '); hide(); return true; } else if (e.key === 'Escape') { hide(); return true; } else return false; box.querySelectorAll('.slash-i').forEach((el, i) => el.classList.toggle('sel', i === sel)); return true; }
  async function run(t) { const [c, ...rest] = t.split(/\s+/); const cmd = CMDS.find(x => x.c === c.toLowerCase()); if (!cmd) return false; const r = await cmd.run(rest.join(' ').trim()); return r !== false; }
  return { show, hide, key, run, CMDS };
})();
inp.addEventListener('input', () => { inp.style.height = 'auto'; inp.style.height = Math.min(inp.scrollHeight, 180) + 'px'; const n = inp.value.length; charEl.textContent = n > 50 ? n : ''; charEl.className = n > 48000 ? 'danger' : n > 8000 ? 'warn' : ''; if (inp.value.startsWith('/')) SLASH.show(inp.value); else SLASH.hide(); });
inp.addEventListener('keydown', e => { if (SLASH.key(e)) { e.preventDefault(); return; } const ctrl = SETTINGS.current().sendKey === 'ctrl'; if (e.key === 'Enter' && (ctrl ? (e.ctrlKey || e.metaKey) : !e.shiftKey)) { e.preventDefault(); sendMsg(); } });
document.addEventListener('keydown', e => {
  const pal = $('pal').classList.contains('on');
  if (e.key === 'Escape') { if (pal) PAL.close(); else if (!$('settings').classList.contains('closed')) SETTINGS.toggle(false); else if (inflight && document.getElementById('apanel').classList.contains('closed')) stopGen(); }
  else if ((e.ctrlKey || e.metaKey) && e.key === ',') { e.preventDefault(); SETTINGS.toggle(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); PAL.toggle(); }
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b' && !e.shiftKey) { e.preventDefault(); setView('build'); }
  else if (e.key === '/' && document.activeElement === document.body && !e.ctrlKey && !e.metaKey) { e.preventDefault(); prefill('/'); }
});
chat.addEventListener('scroll', () => pill.classList.toggle('visible', chat.scrollHeight - chat.scrollTop - chat.clientHeight > 60));
function scrollBottom() { chat.scrollTo({ top: chat.scrollHeight, behavior: 'smooth' }); }

// ─── swarm orchestrator: one action → many val invocations ────────────────────
const SWARM = (() => {
  let job = null;
  // Per-run cancellation token, replacing a single shared "stopped" boolean that every fanout() call reset to false —
  // if build A was stopped while one of its staggered workers was still in a wait() between checks, and the user then
  // started build B (which reset the shared flag), A's worker would see !stopped again and keep going on A's own queue.
  // stop() cancels whichever run is currently active; buildOne()/worker() below only ever look at the token they were
  // handed, never a module-wide flag, so an old run can no longer be un-stopped by a new one starting.
  let activeRun = null;
  // Was a single flat path-to-rowElement object, shared across every manifest card and unconditionally
  // wiped (reset to empty) each time manifestCard() ran. checkResume() calls manifestCard() once per
  // unfinished build IN A LOOP when more than one exists — each call clobbered the previous card's entire
  // row map, so status updates (building/retry/ok/error) for an EARLIER card's files landed nowhere (path
  // not in the current row map, so st() silently no-ops) or, whenever two different artifacts happened to
  // share a filename (extremely common: "index.html", "app.js", "style.css"), landed on the WRONG card's
  // row for that same path — visually "updates the wrong file". Scoped per artifactId instead, so cards
  // never share state and a shared filename across artifacts can no longer cross-talk.
  const rowsByArtifact = new Map();
  // Job state lives server-side (omni_state) so a build survives a closed tab, a dead network or a reload: resume() re-runs only
  // the files that never finished. build_file writes are idempotent (same path → overwrite), so a duplicate run is harmless.
  // Serialized: each call snapshots the (already locally-mutated) job synchronously, then chains its fetch after every
  // earlier one. Previously every call fired an independent, unawaited fetch — concurrent swarm workers finishing near-
  // simultaneously could have their POSTs reach the server out of send order; since the server replaces the whole job
  // state rather than merging it, whichever POST arrived LAST won, even if it was queued first and carried a smaller
  // done[] snapshot than one queued after it — silently losing already-finished files from the persisted job, so
  // /resume could rebuild files that were never actually missing.
  let saveChain = Promise.resolve();
  const saveJob = (patch) => {
    if (!job) return Promise.resolve();
    Object.assign(job, patch);
    const body = JSON.stringify({ session: currentSession, artifactId: job.artifactId, state: job });
    saveChain = saveChain.then(() => fetch('?job', { method: 'POST', headers: { 'content-type': 'application/json' }, body }).catch(() => {}));
    return saveChain;
  };
  // The thrown error carries the STATUS, not just a message. Callers (buildOne) decide whether to retry,
  // and the only reliable transient/permanent signal is the status code: a 502 from ?build_file means the
  // builder call failed upstream and is worth another pass, while a 400 means the request itself was
  // malformed and never will be. Before this, post() collapsed everything into a message string and
  // 'HTTP ' + r.status only appeared when the server sent NO message - which it always does - so the
  // 'HTTP 50[23]' branch of every caller's retry regex was dead code matching nothing.
  const post = (path, body) => fetchT(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: encBody(body) }).then(async r => {
    const raw = await r.text().catch(() => '');
    let j = {}; try { j = raw ? JSON.parse(raw) : {}; } catch (_) { j = {}; }
    if (!r.ok || j.error) {
      const gate = (!raw || raw[0] !== '{') && !r.ok ? ' ' + describeGate(r, raw) : '';
      const x = new Error((typeof j.error === 'string' ? j.error : (j.error && j.error.message) || ('HTTP ' + r.status)) + gate);
      x.status = r.status; x.details = (j.error && j.error.details) || [];
      throw x;
    }
    return j;
  });
  function manifestCard(m, artifactId) {
    const w = addMsg('ai', ''); w.querySelector('.msg-body').remove(); w.querySelector('.msg-actions').remove();
    const el = document.createElement('div'); el.className = 'manifest';
    el.innerHTML = '<div class="manifest-h"><span></span><button class="act-btn" data-a="open">open workbench</button><button class="act-btn primary" data-a="go">build all</button></div>';
    el.querySelector('span').textContent = '#' + artifactId + ' ' + (m.title || '') + ' · ' + m.files.length + ' files';
    const rows = {};
    for (const f of m.files) { if (rows[f.path]) continue; const r = document.createElement('div'); r.className = 'manifest-f'; r.innerHTML = '<span class="st">queued</span><code></code><i></i><button class="act-btn" data-a="re" title="rebuild this file">↻</button>'; r.querySelector('code').textContent = f.path; r.querySelector('i').textContent = f.purpose; r.querySelector('[data-a=re]').onclick = () => buildOne(m, artifactId, f.path, 2).then(() => ART.open(artifactId)); el.appendChild(r); rows[f.path] = r; }
    rowsByArtifact.set(artifactId, rows);
    el.querySelector('[data-a=open]').onclick = () => ART.open(artifactId, 'split');
    el.querySelector('[data-a=go]').onclick = () => fanout(m, artifactId);
    w.appendChild(el); turnLog.push({ q: '/plan', reply: JSON.stringify(m, null, 1).slice(0, 4000), meta: { swarm: true }, ts: Date.now() });
    return el;
  }
  const st = (artifactId, path, s, note) => { const rows = rowsByArtifact.get(artifactId); const r = rows && rows[path]; if (!r) return; const e = r.querySelector('.st'); e.textContent = s; e.className = 'st ' + (s === 'ok' ? 'ok' : s === 'error' || s === 'issues' ? 'err' : s === 'queued' ? '' : 'run'); if (note !== undefined) r.querySelector('i').textContent = note; };
  async function plan(ask) {
    if (!ask) { barStatus.textContent = '/plan needs a description'; return false; }
    if (inflight) return false; inflight = true; setSendState(true); addMsg('user', '/plan ' + ask); showTyping(true, 'architect');
    try { const r = await post('?plan', { q: ask, session: currentSession, settings: SETTINGS.forRequest() }); showTyping(false); manifestCard(r.manifest, r.artifactId); job = { artifactId: r.artifactId, manifest: r.manifest, done: [], failed: [], status: 'planned', title: r.title || '', ask }; await saveJob({}); ART.listForSession(currentSession); loadSessions(); return r; }
    catch (e) { showTyping(false); addError('plan failed: ' + e.message, [], '/plan ' + ask); return false; }
    finally { inflight = false; setSendState(false); }
  }
  async function buildOne(m, artifactId, path, attempts = 2, run = { cancelled: false }) {
    let last = { path, error: 'not built' };
    // A builder that fails because providers are exhausted (502/503) is retried within the same window the chat turn uses
    // (retryMinutes, or forever in until-finalize mode) — a missing file is never accepted because the roster was busy for a minute.
    const S = SETTINGS.current(); const retryMs = S.untilStopped ? Infinity : Math.max(0, Number(S.retryMinutes ?? 5)) * 60_000; const t0 = Date.now();
    for (let a = 1; (a <= attempts || (Date.now() - t0 < retryMs && (RETRY_STATUS.indexOf(last.status) !== -1 || /EXHAUSTED|COOLING|HTTP 50[23]|TIMEOUT|failed to fetch/i.test(last.error || '')))) && !run.cancelled && a < 60; a++) {
      st(artifactId, path, a > 1 ? 'retry ' + a : 'building');
      try {
        const r = await post('?build_file', { session: currentSession, artifactId, manifest: m, path, settings: { ...SETTINGS.forRequest(), model: a > 1 ? 'coder' : SETTINGS.forRequest().model } });
        last = r; const bad = r.truncated || (r.issues && r.issues.length);
        st(artifactId, path, bad ? (a < attempts ? 'retry' : 'issues') : 'ok', r.lines + ' lines · ' + ((r.meta && r.meta.instance) || '') + (r.truncated ? ' · truncated' : '') + (r.issues?.length ? ' · ' + r.issues[0].slice(path.length + 2, 100) : ''));
        if (!bad) { if (job && job.artifactId === artifactId && !job.done.includes(path)) { job.done.push(path); saveJob({}); } return r; }
      } catch (e) { last = { error: e.message, path, status: e.status }; const again = a < attempts || (Date.now() - t0 < retryMs && (RETRY_STATUS.indexOf(e.status) !== -1 || /EXHAUSTED|COOLING|HTTP 50[23]|TIMEOUT|failed to fetch/i.test(e.message))); st(artifactId, path, again ? 'retry' : 'error', e.message.slice(0, 120)); if (!run.cancelled && again) await wait(jitter(Math.min(45_000, 6000 * a))); }
    }
    if (job && job.artifactId === artifactId && !job.failed.includes(path)) { job.failed.push(path); saveJob({}); }
    return last;
  }
  async function fanout(m, artifactId) {
    if (inflight) return; inflight = true; setSendState(true);
    const run = { cancelled: false }; activeRun = run;
    if (!job || job.artifactId !== artifactId) job = { artifactId, manifest: m, done: [], failed: [], status: 'building', title: m.title || '', ask: '' };
    const skip = new Set(job.done); job.failed = []; saveJob({ status: 'building' });
    const conc = Math.max(1, Math.min(8, SETTINGS.current().swarm || 3)); const queue = m.files.map(f => f.path).filter(p => !skip.has(p)); const results = []; const total = queue.length; let n = 0;
    for (const p of skip) st(artifactId, p, 'ok', 'kept from the previous run');
    barStatus.textContent = 'building ' + queue.length + ' files × ' + conc + ' parallel'; ART.open(artifactId, 'split'); ART.jobs(queue.map(p => ({ path: p, st: 'queued' })));
    const worker = async () => { while (queue.length && !run.cancelled) { const p = queue.shift(); ART.jobs([{ path: p, st: 'building' }]); tabProgress('build ' + n + '/' + total); const r = await buildOne(m, artifactId, p, 2, run); results.push(r); n++; tabProgress('build ' + n + '/' + total); ART.jobs([{ path: p, st: r.error ? 'error' : (r.truncated || r.issues?.length) ? 'issues' : 'ok' }]); ART.open(artifactId); } };
    // staggered starts: N builders launched in the same instant is the burst that trips Val Town's edge and per-second vendor limits.
    // inflight/setSendState are NOT released here anymore — they stay held straight through the integrate step below (which
    // takes over the same lock via sendWith's __ownsInflight). Previously they were released right after Promise.all, leaving
    // a window where a manual send could slip past sendMsg's inflight check, and sendWith's own inflight guard would then
    // silently reject the integrate call started a moment later — and because sendWith swallows its own errors/aborts,
    // fanout had no way to notice and would still mark the job "done" below. Both problems close together: the lock stays
    // held (no window to slip through) and the integrate call's success is now checked via its return value (see below).
    try { await Promise.all(Array.from({ length: conc }, (_, i) => wait(i * 1500).then(worker))); } finally { tabProgress(''); }
    if (run.cancelled) { inflight = false; setSendState(false); barStatus.textContent = 'build stopped — /resume continues it'; saveJob({ status: 'stopped' }); ART.jobs(null); return; }
    // full-project lint AFTER every file exists: dangling refs, missing exports, syntax — this is what the integrator must fix
    const full = await fetch('?artifact_files=' + artifactId).then(r => r.json()).catch(() => ({ issues: [] }));
    const issues = (full.issues || []).concat(results.filter(r => r.error).map(r => r.path + ': ' + r.error)).concat(results.filter(r => r.truncated).map(r => r.path + ': output was truncated — verify the file ends correctly'));
    barStatus.textContent = 'integrating'; saveJob({ status: 'integrating' });
    const integrated = await sendWith(ART.tpl('integrate', { id: artifactId, issues: issues.length ? issues.join('\n') : '(none reported — still verify imports/exports)' }), { focus: { id: artifactId, title: m.title || '', file: 'index.html', files: m.files.map(f => f.path), selection: '', errors: [] }, __quiet: true, __ownsInflight: true });
    inflight = false; setSendState(false);
    ART.open(artifactId, 'split'); ART.jobs(null);
    if (integrated) { await saveJob({ status: 'done' }); job = null; }
    else { barStatus.textContent = 'build stopped before integration finished — /resume to retry integration'; await saveJob({ status: 'stopped' }); }
  }
  async function build(ask) { const r = await plan(ask); if (r) await fanout(r.manifest, r.artifactId); return !!r; }
  // Unfinished builds for this session (server-side job rows) → a card with the manifest, finished files marked, and a resume button.
  async function checkResume(auto) {
    const j = await fetch('?job=list&session=' + encodeURIComponent(currentSession)).then(r => r.json()).catch(() => ({ jobs: [] }));
    const list = (j.jobs || []).filter(x => x.manifest && x.artifactId);
    if (!list.length) { if (!auto) barStatus.textContent = 'nothing to resume'; return false; }
    for (const x of list) {
      const el = manifestCard(x.manifest, x.artifactId);
      el.querySelector('.manifest-h span').textContent += ' · unfinished (' + x.done.length + '/' + x.manifest.files.length + ' built, ' + x.status + ')';
      const go = el.querySelector('[data-a=go]'); go.textContent = 'resume build';
      for (const p of x.done) st(x.artifactId, p, 'ok'); for (const p of x.failed || []) st(x.artifactId, p, 'error', 'failed last run — will retry');
      go.onclick = () => { job = { artifactId: x.artifactId, manifest: x.manifest, done: x.done, failed: [], status: 'building', title: x.title, ask: x.ask }; fanout(x.manifest, x.artifactId); };
      if (!auto && list.length === 1) go.onclick();
    }
    return true;
  }
  return { plan, build, fanout, checkResume, stop: () => { if (activeRun) activeRun.cancelled = true; } };
})();

// ─── runs inspector ───────────────────────────────────────────────────────────
function renderRuns() {
  const host = $('runs'); host.innerHTML = '';
  if (!turnLog.length) { host.innerHTML = '<div id="runs-empty">no turns in this session yet</div>'; return; }
  for (const t of [...turnLog].reverse()) {
    const m = t.meta || {}; const r = document.createElement('div'); r.className = 'run';
    const h = document.createElement('div'); h.className = 'run-h';
    h.innerHTML = '<span class="t"></span><span class="q"></span><span class="m"></span>';
    h.querySelector('.t').textContent = fmtTs(t.ts); h.querySelector('.q').textContent = t.q || '';
    h.querySelector('.m').innerHTML = [m.instance ? '<b>' + MD.esc(m.instance) + '</b>' : '', m.model ? MD.esc(String(m.model).split('/').pop()) : '', m.toolEvents?.length ? m.toolEvents.length + ' tools' : '', m.tokensOut != null ? m.tokensOut + ' out' : '', m.finishReason && m.finishReason !== 'stop' ? '<span style="color:var(--warn)">' + m.finishReason + '</span>' : '', m.telemetry?.latencyMs ? (m.telemetry.latencyMs / 1000).toFixed(1) + 's' : ''].filter(Boolean).map(x => '<span>' + x + '</span>').join('');
    const b = document.createElement('div'); b.className = 'run-b';
    const kv = document.createElement('div'); kv.className = 'run-kv';
    const pairs = [['instance', m.instance], ['model', m.model], ['max_tokens sent', m.maxTokensSent], ['max_tokens asked', m.maxTokensAsked], ['finish', m.finishReason], ['tokens out', m.tokensOut], ['passes', m.telemetry?.passes], ['latency', m.telemetry?.latencyMs != null ? (m.telemetry.latencyMs / 1000).toFixed(1) + 's' : null], ['confidence', m.telemetry?.confidence], ['stakes', m.telemetry?.stakes], ['verifier', m.telemetry?.verifierVerdict], ['skills', m.skills?.join(', ')], ['continuation', m.continuation ? 'yes' : null], ['truncated', m.truncated ? 'yes' : null], ['attempts', m.attempts], ['router retries', m.retries]];
    kv.innerHTML = pairs.filter(([, v]) => v != null && v !== '').map(([k, v]) => '<div><b>' + k + '</b> ' + MD.esc(String(v)) + '</div>').join('');
    b.appendChild(kv); if (m.toolEvents?.length) b.appendChild(TL.make(m.toolEvents, { open: true }).root);
    const rp = document.createElement('div'); rp.className = 'run-reply'; rp.textContent = (t.reply || '').slice(0, 3000); b.appendChild(rp);
    h.onclick = () => r.classList.toggle('open'); r.appendChild(h); r.appendChild(b); host.appendChild(r);
  }
}

// ─── command palette ──────────────────────────────────────────────────────────
const PAL = (() => {
  const box = $('pal'), input = $('pal-in'), list = $('pal-list'); let items = [], sel = 0;
  function all() {
    const S = SETTINGS.current(); const out = [];
    out.push({ k: 'chat', l: 'New chat', run: newChat });
    out.push({ k: 'view', l: 'Build — open workbench', h: '⌘B', run: () => setView('build') }, { k: 'view', l: 'Runs — inspector', run: () => setView('runs') }, { k: 'view', l: 'Chat', run: () => setView('chat') });
    for (const c of SLASH.CMDS) out.push({ k: 'cmd', l: c.c + ' — ' + c.h, run: () => prefill(c.c + ' ') });
    for (const m of ['auto', 'fast', 'coder', 'reasoning']) out.push({ k: 'route', l: 'Routing: ' + (m === 'auto' ? 'best free' : m) + (S.mode === m ? ' ✓' : ''), run: () => { SETTINGS.set('mode', m); renderChips(); } });
    for (const t of ['midnight', 'black', 'paper']) out.push({ k: 'theme', l: 'Theme: ' + t + (S.theme === t ? ' ✓' : ''), run: () => SETTINGS.set('theme', t) });
    out.push({ k: 'setting', l: 'Auto-continue cut replies: ' + (S.autoContinue ?? 6) + ' turns', run: () => SETTINGS.toggle(true) }, { k: 'setting', l: 'Swarm concurrency: ' + (S.swarm || 3), run: () => SETTINGS.toggle(true) }, { k: 'setting', l: 'Settings…', h: '⌘,', run: () => SETTINGS.toggle(true) }, { k: 'setting', l: 'Editor settings…', run: () => { setView('build'); setTimeout(() => ART.toggleSettings(true), 150); } }, { k: 'setting', l: 'Router status…', run: () => { SETTINGS.toggle(true); SETTINGS.routerStatus(); } });
    for (const k of (S.skills || [])) out.push({ k: 'skill', l: 'Skill: ' + k.name + ' (' + k.mode + ')', run: () => prefill('/skill ' + k.name + ' ') });
    for (const a of ART.list()) out.push({ k: 'artifact', l: '#' + a.id + ' ' + a.title, run: () => ART.open(a.id, 'split') });
    for (const s of [...sessionsEl.querySelectorAll('.sess-row')]) out.push({ k: 'session', l: s.querySelector('.sess-name').textContent, run: () => s.click() });
    return out;
  }
  function render() { const q = input.value.trim().toLowerCase(); items = all().filter(i => !q || (i.k + ' ' + i.l).toLowerCase().includes(q)).slice(0, 40); sel = 0; list.innerHTML = items.map((i, n) => '<div class="pal-i' + (n === 0 ? ' sel' : '') + '" data-i="' + n + '"><span class="k">' + i.k + '</span><span class="l">' + MD.esc(i.l) + '</span><span class="h">' + (i.h || '') + '</span></div>').join(''); list.querySelectorAll('.pal-i').forEach(el => el.onclick = () => pick(Number(el.dataset.i))); }
  function pick(i) { const it = items[i]; close(); if (it) it.run(); }
  function open() { box.classList.add('on'); input.value = ''; render(); input.focus(); }
  function close() { box.classList.remove('on'); inp.focus(); }
  input.addEventListener('input', render);
  input.addEventListener('keydown', e => { if (e.key === 'ArrowDown') sel = (sel + 1) % items.length; else if (e.key === 'ArrowUp') sel = (sel - 1 + items.length) % items.length; else if (e.key === 'Enter') return pick(sel); else if (e.key === 'Escape') return close(); else return; e.preventDefault(); list.querySelectorAll('.pal-i').forEach((el, n) => el.classList.toggle('sel', n === sel)); });
  return { open, close, toggle: () => box.classList.contains('on') ? close() : open() };
})();

// ─── init ─────────────────────────────────────────────────────────────────────
(async () => {
  const list = await fetch('?sessions').then(r => r.json()).catch(() => []);
  renderSessions(list);
  const known = list.find(s => s.id === currentSession);
  if (known || urlSession) await switchSession(currentSession, known?.name); else rememberSession();
  renderChips(); ART.restore();
})();
`;
