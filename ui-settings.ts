// Settings drawer: markup + logic. State lives in localStorage("omni.settings");
// `SETTINGS.current()` is read by main-script on every send, and appearance is
// applied as CSS variables / body classes so the page re-skins without reload.
export const settingsHtml: string = `
<div id="settings" class="closed" aria-hidden="true">
  <div id="st-hdr"><span>settings</span><button class="ib" onclick="SETTINGS.toggle(false)" title="close (Esc)"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4l8 8M12 4l-8 8"/></svg></button></div>
  <div id="st-body">
    <section><h4>appearance</h4>
      <label>width <select data-k="width"><option value="600">narrow</option><option value="760">reading</option><option value="920">wide</option><option value="9999">full</option></select></label>
      <label>font <select data-k="font"><option value="mono">mono</option><option value="sans">sans</option></select></label>
      <label>size <input type="range" min="11" max="17" data-k="fontSize"><output></output></label>
      <label>theme <select data-k="theme"><option value="midnight">midnight</option><option value="black">black</option><option value="paper">paper</option></select></label>
      <label>accent <input type="color" data-k="accent"></label>
      <label>density <select data-k="density"><option value="cozy">cozy</option><option value="compact">compact</option></select></label>
      <label><input type="checkbox" data-k="timestamps"> timestamps</label>
      <label><input type="checkbox" data-k="telemetry"> telemetry tags</label>
      <label><input type="checkbox" data-k="codeWrap"> wrap long code lines</label>
    </section>
    <section><h4>thinking &amp; tools</h4>
      <label>thinking <select data-k="thinking"><option value="collapsed">collapsed</option><option value="open">expanded</option><option value="hidden">hidden</option></select></label>
      <label><input type="checkbox" data-k="showTools"> show tool chain</label>
      <label><input type="checkbox" data-k="liveThinking"> live thinking while generating</label>
    </section>
    <section><h4>router</h4>
      <label>router url <input type="text" data-k="routerUrl" placeholder="blank = this app (the router is built in)"></label>
      <label>router key <input type="text" data-k="routerKey" placeholder="OMNI_CLIENT_KEYS entry (optional)"></label>
      <label>vendor order <input type="text" data-k="vendorOrder" placeholder="openrouter, groq, together  (blank = best quality first)"></label>
      <label>key rotation <select data-k="keyPolicy"><option value="">spread (default)</option><option value="depth">depth — one account until it fails, then the next</option><option value="rr">spread — least-used account first</option><option value="breadth">breadth — slot 0 of every vendor, then slot 1…</option></select></label>
      <div class="st-row"><button class="st-btn" onclick="SETTINGS.routerStatus()">test / status</button><span id="rt-state" class="pr-hint"></span></div>
      <div id="rt-table"></div>
      <div class="st-row"><button class="st-btn" onclick="SETTINGS.copyDiagnostics()">copy diagnostics</button><span id="diag-state" class="pr-hint"></span></div>
    </section>
    <section><h4>model</h4>
      <label>routing <select data-k="mode"><option value="auto">best free</option><option value="fast">fastest</option><option value="coder">coder</option><option value="reasoning">reasoning</option><option value="pin">pin…</option></select></label>
      <label class="pin-row">pin <input type="text" data-k="pin" placeholder="groq  ·  groq:openai/gpt-oss-120b  ·  huggingface"></label>
      <label>reasoning effort <select data-k="reasoning"><option value="">model default</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option></select></label>
      <label>temperature <input type="range" min="-1" max="20" data-k="temp10"><output></output></label>
      <label>max_tokens policy <select data-k="maxMode"><option value="auto">auto — sized to the task, clamped by vendor caps</option><option value="fixed">fixed — the number below</option><option value="max">max — ask for the ceiling, router clamps</option></select></label>
      <label>fixed max_tokens <select data-k="maxTokens"><option value="0">(none)</option><option value="1024">1k</option><option value="4096">4k</option><option value="8192">8k</option><option value="16384">16k</option><option value="32768">32k</option></select></label>
      <label>history sent to the model <select data-k="contextChars"><option value="8000">small — fits Groq free tier (≈2k tokens)</option><option value="16000">medium (≈4k tokens)</option><option value="40000">large (≈10k tokens; skips small-context vendors)</option><option value="100000">max (≈25k tokens)</option></select></label>
      <label>expected length <select data-k="expect"><option value="auto">auto (detect)</option><option value="short">short</option><option value="long">long</option><option value="max">max</option></select></label>
      <label>in-turn continues <input type="range" min="0" max="8" data-k="continueMax"><output></output></label>
      <label>auto-continue across turns <input type="range" min="0" max="12" data-k="autoContinue"><output></output></label>
      <label>auto-continue unfinished work (rounds) <input type="range" min="0" max="10" data-k="autoComplete"><output></output></label>
      <label>keep retrying when providers are exhausted (min) <input type="range" min="0" max="15" data-k="retryMinutes"><output></output></label>
      <label>swarm builders in parallel <input type="range" min="1" max="8" data-k="swarm"><output></output></label>
      <label><input type="checkbox" data-k="untilStopped"> work until I say /finalize — unlimited retries and continues; after each completed round, ship the next upgrades</label>
      <label><input type="checkbox" data-k="autoCompact"> auto-compact history when it outgrows the context budget</label>
      <label><input type="checkbox" data-k="examples"> two top-tier examples in every prompt (few-shot; off saves input tokens on tight free tiers)</label>
      <label><input type="checkbox" data-k="autoSwarm"> app-scale asks go through /build automatically (architect → parallel builders → integrate)</label>
      <label><input type="checkbox" data-k="cardPreview"> inline preview on artifact cards</label>
      <label>turn budget (s) <input type="range" min="15" max="52" data-k="budgetS"><output></output></label>
    </section>
    <section><h4>governor</h4>
      <label><input type="checkbox" data-k="plan"> plan before answering (complex asks)</label>
      <label><input type="checkbox" data-k="verify"> verification pass</label>
      <label><input type="checkbox" data-k="ensemble"> ensemble on high-stakes</label>
      <label><input type="checkbox" data-k="memory"> long-term memory</label>
    </section>
    <section><h4>tools</h4><div id="st-tools"></div></section>
    <section><h4>custom instructions</h4>
      <textarea data-k="system" rows="5" placeholder="How the assistant should behave, what it should know about you, output conventions…"></textarea>
    </section>
    <section><h4>prompts</h4>
      <label>edit <select id="pr-key"></select></label>
      <div id="pr-vars" class="pr-hint"></div>
      <textarea id="pr-text" rows="12" spellcheck="false"></textarea>
      <div class="st-row"><span id="pr-state" class="pr-hint"></span><button class="st-btn" onclick="SETTINGS.promptReset()">reset this</button><button class="st-btn" onclick="SETTINGS.promptResetAll()">reset all</button><button class="st-btn" onclick="SETTINGS.promptExport()">export</button><label class="st-btn" style="cursor:pointer">import<input type="file" accept="application/json" style="display:none" onchange="SETTINGS.promptImport(this.files[0])"></label></div>
    </section>
    <section><h4>skills</h4>
      <div class="pr-hint">Instruction packs the model receives as binding rules. <b>always</b> = every turn; <b>auto</b> = when the message matches the keywords (comma-separated) or a /regex/i.</div>
      <div id="sk-list"></div>
      <div class="st-row"><button class="st-btn" onclick="SETTINGS.skillAdd()">+ skill</button><select id="sk-preset" class="st-btn"><option value="">presets…</option></select></div>
    </section>
    <section><h4>input</h4>
      <label>send with <select data-k="sendKey"><option value="enter">Enter (Shift+Enter = newline)</option><option value="ctrl">Ctrl/⌘+Enter</option></select></label>
      <label><input type="checkbox" data-k="autoScroll"> auto-scroll to new replies</label>
    </section>
    <section><h4>data</h4>
      <div class="st-row"><button class="st-btn" onclick="SETTINGS.exportChat()">export chat json</button><button class="st-btn" onclick="SETTINGS.reset()">reset settings</button></div>
    </section>
  </div>
</div>
<div id="st-scrim" onclick="SETTINGS.toggle(false)"></div>
`;

export const settingsScript: string = String.raw`
// Runtime error ring buffer, installed at module load (this script loads before main-script.ts's own
// bootstrap — see main-html.tsx's script order) so it catches errors from the moment the page is live,
// not just from when the settings drawer happens to be opened. Feeds SETTINGS.copyDiagnostics() below.
const DIAG_LOG = [];
function diagPush(kind, parts) {
  try {
    const msg = parts.map(a => { try { return typeof a === 'string' ? a : JSON.stringify(a); } catch { return String(a); } }).join(' ').slice(0, 400);
    DIAG_LOG.push({ t: Date.now(), kind, msg });
    if (DIAG_LOG.length > 40) DIAG_LOG.shift();
  } catch {}
}
(() => {
  const origError = console.error.bind(console);
  console.error = (...args) => { diagPush('console.error', args); origError(...args); };
  window.addEventListener('error', (e) => diagPush('window.onerror', [e.message + ' @ ' + (e.filename || '?') + ':' + (e.lineno || '?')]));
  window.addEventListener('unhandledrejection', (e) => diagPush('unhandledrejection', [String((e.reason && e.reason.message) || e.reason)]));
})();

const SETTINGS = (() => {
  const KEY = 'omni.settings';
  const DEF = { width: '760', font: 'mono', fontSize: 13, theme: 'midnight', accent: '#4f8cff', density: 'cozy', timestamps: true, telemetry: true, codeWrap: false,
    thinking: 'collapsed', showTools: true, liveThinking: true, mode: 'auto', pin: '', reasoning: '', temp10: -1, maxTokens: 0, continueMax: 3, budgetS: 52,
    plan: true, verify: true, ensemble: true, memory: true, tools: null, system: '', sendKey: 'enter', autoScroll: true, prompts: {}, skills: [],
    routerUrl: '', routerKey: '', maxMode: 'auto', expect: 'auto', autoContinue: 6, swarm: 3, cardPreview: true, autoSwarm: true, examples: true, untilStopped: false, autoCompact: true, keyPolicy: '', contextChars: 16000, retryMinutes: 5, vendorOrder: 'openrouter', autoComplete: 4 };
  const PRESETS = {
    'single-file html': { name: 'single-file html', mode: 'auto', when: 'html, webgl, canvas, shader, game, app, visuali', body: 'Deliver browser artifacts as ONE self-contained index.html: inline all CSS in <style> and all JS in <script>; no sibling files, no external URLs. Split into files only if the user explicitly asks for multiple files.' },
    'strict typescript': { name: 'strict typescript', mode: 'auto', when: 'typescript, ts, deno, node', body: 'TypeScript: strict mode semantics, no "any", exhaustive switch via "never", discriminated unions over boolean flags, readonly inputs, explicit return types on exported functions, Result-style errors instead of throw for expected failures.' },
    'terse': { name: 'terse', mode: 'always', when: '', body: 'Answer in the fewest sentences that fully answer. No headings for short answers, no restating the question, no closing summary. Code first, prose after, only where the code is not self-explanatory.' },
    'review mode': { name: 'review mode', mode: 'auto', when: 'review, critique, audit, check my', body: 'Act as a hostile reviewer: list defects ordered by severity with file:line, a one-line repro or failing input for each, and the minimal fix. No praise, no summary of what the code does.' },
  };
  const TOOLS = ['web_search', 'eval_js', 'create_artifact', 'read_artifact', 'search_artifact', 'update_artifact', 'memory_recall', 'memory_write', 'session_clear', 'session_delete'];
  let s = { ...DEF };
  try { s = { ...DEF, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch {}
  const root = document.documentElement;
  const el = document.getElementById('settings');

  function apply() {
    root.style.setProperty('--content-w', s.width + 'px');
    root.style.setProperty('--fs', s.fontSize + 'px');
    root.style.setProperty('--acc', s.accent);
    root.style.setProperty('--inf', s.accent);
    document.body.dataset.theme = s.theme;
    document.body.dataset.font = s.font;
    document.body.dataset.density = s.density;
    document.body.classList.toggle('no-ts', !s.timestamps);
    document.body.classList.toggle('no-tel', !s.telemetry);
    document.body.classList.toggle('code-wrap', !!s.codeWrap);
    document.body.classList.toggle('no-tools', !s.showTools);
    document.body.dataset.thinking = s.thinking;
    el.querySelector('.pin-row').style.display = s.mode === 'pin' ? '' : 'none';
    document.querySelectorAll('.mode').forEach(b => b.classList.toggle('on', b.dataset.mode === s.mode));
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {} apply(); document.dispatchEvent(new CustomEvent('omni:settings')); }
  function set(k, v) { s[k] = v; save(); syncForm(); }

  function syncForm() {
    el.querySelectorAll('[data-k]').forEach(inp => {
      const k = inp.dataset.k;
      if (inp.type === 'checkbox') inp.checked = !!s[k];
      else inp.value = s[k] ?? '';
      const out = inp.nextElementSibling;
      if (out && out.tagName === 'OUTPUT') out.textContent = k === 'temp10' ? (s.temp10 < 0 ? 'auto' : (s.temp10 / 10).toFixed(1)) : k === 'budgetS' ? s.budgetS + 's' : s[k];
    });
    const tl = document.getElementById('st-tools');
    tl.innerHTML = '';
    for (const t of TOOLS) {
      const on = !s.tools || s.tools.includes(t);
      const l = document.createElement('label');
      l.innerHTML = '<input type="checkbox"> ' + t;
      l.firstChild.checked = on;
      l.firstChild.onchange = (e) => { const cur = new Set(s.tools ?? TOOLS); e.target.checked ? cur.add(t) : cur.delete(t); s.tools = cur.size === TOOLS.length ? null : [...cur]; save(); };
      tl.appendChild(l);
    }
  }
  // ─── skills ────────────────────────────────────────────────────────────────
  const skList = document.getElementById('sk-list'), skPreset = document.getElementById('sk-preset');
  skPreset.innerHTML += Object.keys(PRESETS).map(k => '<option value="' + k + '">' + k + '</option>').join('');
  skPreset.addEventListener('change', () => { const p = PRESETS[skPreset.value]; skPreset.value = ''; if (!p) return; s.skills = [...(s.skills || []).filter(k => k.name !== p.name), { ...p }]; save(); renderSkills(); });
  function renderSkills() {
    skList.innerHTML = '';
    (s.skills || []).forEach((k, i) => {
      const d = document.createElement('details'); d.className = 'sk';
      d.innerHTML = '<summary><span class="sk-name"></span><span class="sk-mode"></span></summary>' +
        '<label>name <input type="text" data-sk="name"></label><label>mode <select data-sk="mode"><option value="auto">auto (keywords)</option><option value="always">always</option></select></label>' +
        '<label>when <input type="text" data-sk="when" placeholder="webgl, shader  ·  /^fix/i"></label><textarea data-sk="body" rows="5" spellcheck="false"></textarea>' +
        '<div class="st-row"><button class="st-btn" data-act="del">delete</button><button class="st-btn" data-act="dup">duplicate</button></div>';
      const sync = () => { d.querySelector('.sk-name').textContent = k.name || '(unnamed)'; d.querySelector('.sk-mode').textContent = k.mode === 'always' ? 'always' : ('auto: ' + (k.when || '—')); };
      d.querySelectorAll('[data-sk]').forEach(inp => { inp.value = k[inp.dataset.sk] ?? ''; inp.addEventListener('input', () => { k[inp.dataset.sk] = inp.value; save(); sync(); }); });
      d.querySelector('[data-act="del"]').onclick = () => { s.skills.splice(i, 1); save(); renderSkills(); };
      d.querySelector('[data-act="dup"]').onclick = () => { s.skills.splice(i + 1, 0, { ...k, name: k.name + ' copy' }); save(); renderSkills(); };
      sync(); skList.appendChild(d);
    });
  }
  function skillAdd() { s.skills = [...(s.skills || []), { name: 'skill ' + ((s.skills || []).length + 1), mode: 'auto', when: '', body: '' }]; save(); renderSkills(); skList.lastElementChild.open = true; skList.lastElementChild.querySelector('input').focus(); }

  el.addEventListener('input', (e) => {
    const inp = e.target; const k = inp.dataset?.k; if (!k) return;
    let v = inp.type === 'checkbox' ? inp.checked : inp.value;
    if (inp.type === 'range' || ['maxTokens', 'contextChars'].includes(k)) v = Number(v);
    if (k === 'routerUrl') v = v.trim();
    s[k] = v; save();
    const out = inp.nextElementSibling;
    if (out && out.tagName === 'OUTPUT') out.textContent = k === 'temp10' ? (v < 0 ? 'auto' : (v / 10).toFixed(1)) : k === 'budgetS' ? v + 's' : v;
    if (k === 'mode') el.querySelector('.pin-row').style.display = v === 'pin' ? '' : 'none';
  });

  function toggle(open) {
    const o = open ?? el.classList.contains('closed');
    el.classList.toggle('closed', !o); el.setAttribute('aria-hidden', String(!o));
    document.getElementById('st-scrim').classList.toggle('on', o);
    if (o) loadPrompts();
  }

  // ─── prompt editor ─────────────────────────────────────────────────────────
  let PR = null; // { defaults, vars } from the server
  const prKey = document.getElementById('pr-key'), prText = document.getElementById('pr-text'), prVars = document.getElementById('pr-vars'), prState = document.getElementById('pr-state');
  async function loadPrompts() {
    if (PR) return;
    try { PR = await (await fetch('?prompts')).json(); } catch { return; }
    prKey.innerHTML = Object.keys(PR.defaults).map(k => '<option value="' + k + '">' + k + '</option>').join('');
    showPrompt(prKey.value);
  }
  function showPrompt(k) {
    if (!PR) return;
    const custom = s.prompts && s.prompts[k];
    prText.value = custom || PR.defaults[k];
    prVars.textContent = (PR.vars[k] && PR.vars[k].length) ? 'placeholders: ' + PR.vars[k].map(v => '{{' + v + '}}').join(' ') : 'no placeholders';
    prState.textContent = custom ? 'custom' : 'default';
    prText.classList.toggle('custom', !!custom);
  }
  prKey.addEventListener('change', () => showPrompt(prKey.value));
  prText.addEventListener('input', () => {
    if (!PR) return;
    const k = prKey.value, v = prText.value;
    s.prompts = { ...(s.prompts || {}) };
    if (!v.trim() || v.trim() === PR.defaults[k].trim()) delete s.prompts[k]; else s.prompts[k] = v;
    save(); prState.textContent = s.prompts[k] ? 'custom' : 'default'; prText.classList.toggle('custom', !!s.prompts[k]);
  });
  function promptReset() { if (!PR) return; delete s.prompts[prKey.value]; save(); showPrompt(prKey.value); }
  function promptResetAll() { s.prompts = {}; save(); if (PR) showPrompt(prKey.value); }
  function promptExport() {
    const blob = new Blob([JSON.stringify({ prompts: s.prompts || {}, system: s.system, skills: s.skills || [], editor: (window.ART && ART.settings) ? ART.settings() : undefined }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'omni-prompts.json'; a.click();
  }
  async function promptImport(file) {
    if (!file) return;
    try { const j = JSON.parse(await file.text()); if (j.prompts && typeof j.prompts === 'object') s.prompts = j.prompts; if (typeof j.system === 'string') s.system = j.system; if (Array.isArray(j.skills)) s.skills = j.skills; if (j.editor && window.ART) ART.setSettings(j.editor); save(); syncForm(); renderSkills(); if (PR) showPrompt(prKey.value); } catch (e) { prState.textContent = 'import failed: invalid json'; }
  }
  // ─── router status: instance roster from the router's /health ──────────────
  // The router is a module of THIS app, so the default is a relative URL: it
  // resolves to whatever origin is serving the page, which is the correct answer
  // under a val alias, a custom domain, or a proxy. A value here means the
  // operator pointed this deployment at a different router on purpose.
  const routerBase = () => (s.routerUrl || '').replace(/\/+$/, '');
  async function routerStatus() {
    const st = document.getElementById('rt-state'), tb = document.getElementById('rt-table');
    const base = routerBase();
    st.textContent = 'checking ' + base + ' …'; tb.innerHTML = '';
    try {
      const h = await (await fetch(base + '/health', { headers: s.routerKey ? { authorization: 'Bearer ' + s.routerKey } : {} })).json();
      st.textContent = h.status + ' · ' + h.providers_configured + ' instances · policy ' + (h.key_policy || 'depth') + (h.auth ? ' · auth on' : '');
      // Item 8: catalog order buries the providers you'd actually want to look at first (cooling down, or
      // erroring even while technically CLOSED) among a long list of healthy ones. Sort urgency-first —
      // cooling, then any last_error, then highest fail count — everything else keeps catalog order as the
      // stable tiebreak so a full-health board still reads the same as before this change.
      // A malformed key outranks everything: it is the one state that no cooldown, retry or reset will ever
      // fix on its own. Then an instance whose model ids are all dead upstream, then cooling, then last_error.
      const allDead = (i) => i.models > 0 && i.dead_models >= i.models;
      const urgency = (i) => (i.key_issue ? 0 : allDead(i) ? 1 : i.cooling ? 2 : i.last_error ? 3 : 4);
      const sorted = (h.instances || []).map((i, idx) => ({ i, idx })).sort((a, b) =>
        urgency(a.i) - urgency(b.i) || (b.i.failed - a.i.failed) || (a.idx - b.idx)
      ).map((x) => x.i);
      const stateOf = (i) => i.key_issue ? 'KEY: ' + i.key_issue
        : allDead(i) ? 'no live models (' + i.dead_models + '/' + i.models + ' dead)'
        : i.cooling ? 'cooling ' + Math.ceil(i.cooling.ms_left / 1000) + ' s' : 'ready';
      const rows = sorted.map(i => '<tr><td>' + i.name + '</td><td>' + (i.key || '') + '</td><td>' + i.requests + '</td><td>' + i.ok + '</td><td>' + i.failed + '</td><td class="' + (i.key_issue || allDead(i) ? 'dead' : i.cooling ? 'cool' : '') + '" title="' + MD.esc((i.cooling && i.cooling.reason) || (allDead(i) ? i.dead_models + ' of ' + i.models + ' model ids dead upstream' : '') || i.last_error || '') + '">' + stateOf(i) + '</td></tr>').join('');
      tb.innerHTML = '<table class="rt"><tr><th>instance</th><th>key</th><th>req</th><th>ok</th><th>fail</th><th>state</th></tr>' + rows + '</table><div class="st-row" style="margin-top:6px"><button class="st-btn" onclick="SETTINGS.routerReset()">clear cooldowns</button> <button class="st-btn" onclick="SETTINGS.routerResetStats()">reset stats</button></div>';
    } catch (e) { st.textContent = 'unreachable: ' + e.message; }
  }
  async function routerReset() { const base = routerBase(); await fetch(base + '/api/reset', { method: 'POST', headers: { 'content-type': 'application/json', ...(s.routerKey ? { authorization: 'Bearer ' + s.routerKey } : {}) }, body: '{}' }).catch(() => {}); routerStatus(); }
  // Item 4: separate from routerReset() (which clears live cooldowns) — this clears the durable
  // requests/ok/failed counters so, e.g., three freshly re-bound OpenRouter models don't have their new
  // success rate permanently diluted by every failed attempt made against the old stale binding.
  async function routerResetStats() { const base = routerBase(); await fetch(base + '/api/reset-stats', { method: 'POST', headers: { 'content-type': 'application/json', ...(s.routerKey ? { authorization: 'Bearer ' + s.routerKey } : {}) }, body: '{}' }).catch(() => {}); routerStatus(); }
  // Everything Claude would otherwise ask you to paste in, one click: router health, provider catalog,
  // this session's recent turns (with their routing flowcharts — see ui-timeline.ts/app.tsx's PassMeter),
  // your settings, and any runtime errors this page has actually thrown. All from endpoints that already
  // exist (/health, /api/providers, ?history=) — no new server surface, so it can't drift from what
  // routerStatus()/exportChat() already show you.
  async function copyDiagnostics() {
    const st = document.getElementById('diag-state');
    st.textContent = 'gathering…';
    const base = routerBase();
    const authHdr = s.routerKey ? { authorization: 'Bearer ' + s.routerKey } : {};
    const session = window.currentSession || 'default';
    const [health, providers, hist] = await Promise.allSettled([
      fetch(base + '/health', { headers: authHdr }).then(r => r.json()),
      fetch(base + '/api/providers').then(r => r.json()),
      fetch('?history=' + encodeURIComponent(session)).then(r => r.json()),
    ]);
    const val = (r, fallback) => r.status === 'fulfilled' ? r.value : { error: String(r.reason) , fallback };
    const h = val(health, null), p = val(providers, []), m = val(hist, []);
    const recent = Array.isArray(m) ? m.slice(-8) : [];
    const L = [];
    L.push('=== OMNIROUTER DIAGNOSTICS === ' + new Date().toISOString());
    L.push('url: ' + location.href, 'userAgent: ' + navigator.userAgent, 'viewport: ' + window.innerWidth + 'x' + window.innerHeight, 'session: ' + session);
    L.push('', '-- SETTINGS --', JSON.stringify({ ...s, routerKey: s.routerKey ? '(set)' : '' }, null, 1));
    L.push('', '-- HEALTH (' + base + '/health) --', h && !h.error ? JSON.stringify({ status: h.status, providers_configured: h.providers_configured, inflight: h.inflight_requests, key_policy: h.key_policy, instances: h.instances }, null, 1) : 'ERROR: ' + (h && h.error));
    L.push('', '-- CATALOG (' + base + '/api/providers) --', Array.isArray(p) ? JSON.stringify(p.map(x => ({ name: x.name, vendor: x.vendor, hasKey: x.hasKey, keySlots: x.keySlots, currentModel: x.currentModel })), null, 1) : 'ERROR: ' + (p && p.error));
    L.push('', '-- RECENT MESSAGES (session ' + session + ', last ' + recent.length + ' of ' + (Array.isArray(m) ? m.length : '?') + ') --');
    for (const msg of recent) {
      L.push('[' + msg.role + ' #' + msg.id + '] ' + new Date(msg.ts).toISOString());
      const meta = msg.meta;
      if (msg.role === 'assistant' && meta) {
        L.push('  provider=' + (meta.instance || '?') + ' model=' + (meta.model || '?') + ' finish=' + (meta.finishReason || '?') + ' truncated=' + !!meta.truncated + ' attempts=' + (meta.attempts ?? '?'));
        const tools = meta.toolEvents || [];
        if (tools.length) L.push('  tools: ' + tools.map(e => e.tool + (e.error ? '(FAILED: ' + String(e.error).slice(0, 80) + ')' : '')).join(', '));
        const routeEv = tools.find(e => e.tool === 'route');
        if (routeEv) L.push('  routing: ' + JSON.stringify(routeEv.result || routeEv.args));
      }
      L.push('  ' + String(msg.content || '').slice(0, 300).replace(/\s+/g, ' '));
    }
    L.push('', '-- RUNTIME ERRORS THIS PAGE LOAD (' + DIAG_LOG.length + ') --', DIAG_LOG.length ? DIAG_LOG.map(e => '[' + new Date(e.t).toISOString() + '] ' + e.kind + ': ' + e.msg).join('\n') : '(none)');
    // Items 6 & 7: this session's stale-binding bug (three OpenRouter rows manually Bound to the wrong
    // upstream model via /api/update) and its sibling class — a key slot that's never once been tried
    // despite its row-mates carrying real traffic — both had to be found by hand from a raw diagnostics
    // dump. Surfacing both automatically here doesn't fix anything (a manual Bind can be entirely
    // intentional), it just puts the anomaly in front of the person who'd otherwise have to spot it in a
    // wall of JSON.
    const flags = [];
    if (Array.isArray(p)) {
      for (const x of p) {
        if (x.currentModel && x.fallbackModel && x.currentModel !== x.fallbackModel) {
          flags.push('BIND OVERRIDE: ' + x.name + ' → "' + x.currentModel + '" (catalog default: "' + x.fallbackModel + '") — confirm this is the model you meant to bind, not a stale/crossed override.');
        }
      }
    }
    if (h && Array.isArray(h.instances)) {
      const byBase = new Map();
      for (const inst of h.instances) {
        const base = String(inst.name).split('#')[0];
        if (!byBase.has(base)) byBase.set(base, []);
        byBase.get(base).push(inst);
      }
      for (const [base, group] of byBase) {
        if (group.length < 2) continue;
        const untried = group.filter(g => !g.requests);
        const active = group.filter(g => g.requests > 0);
        // routeChat() (router.ts) returns on the FIRST successful attempt in ranked order — it never walks
        // past a winner — so a later key slot sitting at 0 requests while an earlier sibling is winning is
        // the expected shape of a healthy multi-key provider, not an anomaly. (Vendor round-robin puts slot
        // 0 of every vendor ahead of slot 1 of any vendor, which is the same shape one level up; only the
        // "rr" key policy deliberately equalises slots, by leading with the least-used one.) Originally this fired
        // whenever untried.length && active.length, which is true for almost every multi-slot provider on
        // almost every turn (verified against a live diagnostics dump: 5 of 6 multi-slot provider groups
        // flagged this way, and in every one of those 5 an earlier sibling was successfully winning turns —
        // 100% false-positive rate against real data, drowning the one group where it actually mattered).
        // Only worth surfacing when EVERY reached sibling has zero successes despite real traffic — that's
        // the one shape early-exit-on-success can't explain: the group is failing end-to-end and the untried
        // slot(s) are unproven, not merely unneeded.
        if (untried.length && active.length && active.every(g => !g.ok)) {
          flags.push('UNREACHED SLOT: ' + untried.map(g => g.name).join(', ') + ' — 0 requests, and every reached sibling in this group (' + active.map(g => g.name + ' ' + g.ok + '/' + g.requests + ' ok').join(', ') + ') has zero successes despite real traffic; the group itself may be misconfigured (wrong bound model, tier-restricted, bad key) rather than the untried slot(s) specifically — check any BIND OVERRIDE flag for this provider first.');
        }
      }
    }
    if (h && Array.isArray(h.key_issues)) for (const k of h.key_issues) flags.unshift('MALFORMED SECRET: ' + k.env + ' (' + k.instance + ') — ' + k.issue + '. Re-paste the raw token; no retry or reset will fix this.');
    if (h && Array.isArray(h.instances)) for (const i of h.instances) if (i.models > 0 && i.dead_models >= i.models) flags.push('NO LIVE MODELS (' + i.dead_models + '/' + i.models + ' ids dead upstream): ' + i.name + ' — discovery will be attempted on the next call; clear cooldowns to retry sooner.');
    L.push('', '-- AUTO-FLAGGED ANOMALIES (' + flags.length + ') --', flags.length ? flags.map((f, i) => (i + 1) + '. ' + f).join('\n') : '(none detected)');
    // Per-provider outcome histogram across the recent turns' routing trails: answers "who is actually
    // winning, who only ever fails, who never gets reached" without reading every flowchart by hand.
    const outcomes = new Map();
    for (const msg of recent) {
      const ev = (msg.meta && msg.meta.toolEvents || []).find(e => e.tool === 'route');
      const attempts = ev && ev.result && ev.result.attempts || [];
      for (const a of attempts) {
        // Fields the router's trail actually carries: pass>1 means the vendor's
        // first model id was dead and a fallback within the same vendor answered;
        // dropped means a 400 accused a parameter and the retry went without it.
        const row = outcomes.get(a.provider) || { won: 0, failed: 0, skipped: 0, fallback: 0, repaired: 0, lat: [] };
        if (a.ok) { row.won++; if (a.latencyMs) row.lat.push(a.latencyMs); } else if (a.skipped) row.skipped++; else row.failed++;
        if (a.pass > 1) row.fallback++;
        if (a.dropped && a.dropped.length) row.repaired++;
        outcomes.set(a.provider, row);
      }
    }
    const med = (xs) => { if (!xs.length) return '-'; const s2 = [...xs].sort((a, b) => a - b); return s2[Math.floor(s2.length / 2)] + 'ms'; };
    L.push('', '-- PROVIDER OUTCOMES (last ' + recent.length + ' turns) --', outcomes.size
      ? [...outcomes].sort((a, b) => b[1].won - a[1].won || b[1].failed - a[1].failed).map(([n, r]) => n.padEnd(34) + ' won=' + r.won + ' failed=' + r.failed + ' skipped=' + r.skipped + (r.fallback ? ' model_fallback=' + r.fallback : '') + (r.repaired ? ' param_repair=' + r.repaired : '') + ' median_ok=' + med(r.lat)).join('\n')
      : '(no routing trails in recent turns)');
    const text = L.join('\n');
    try { await navigator.clipboard.writeText(text); st.textContent = 'copied ' + text.length.toLocaleString() + ' chars ✓'; }
    catch (e) { st.textContent = 'copy failed (' + e.message + ') — select the text manually below'; console.log(text); }
    setTimeout(() => { st.textContent = ''; }, 6000);
  }
  /** Request payload for the backend — only what the server acts on. */
  function forRequest() {
    return {
      router: s.routerUrl ? { url: s.routerUrl, key: s.routerKey || null } : null, maxMode: s.maxMode || 'auto', expect: s.expect || 'auto', keyPolicy: s.keyPolicy || 'rr', examples: s.examples !== false, /* spread: every alternate account is used, least-used first; depth parks keys 1..n behind an un-cooled key 0 */ contextChars: Number(s.contextChars) || 16000, vendorOrder: s.vendorOrder || '',
      model: s.mode === 'pin' ? (s.pin.trim() || 'auto') : s.mode,
      reasoning: s.reasoning || null, temperature: s.temp10 < 0 ? null : s.temp10 / 10,
      maxTokens: s.maxTokens || null, system: s.system, tools: s.tools, plan: s.plan, verify: s.verify, ensemble: s.ensemble, memory: s.memory,
      continueMax: s.continueMax, budgetMs: s.budgetS * 1000, prompts: s.prompts || {},
      skills: (s.skills || []).filter(k => k.name && k.body && k.body.trim()),
    };
  }
  async function exportChat() {
    const id = window.currentSession; const hist = await (await fetch('?history=' + encodeURIComponent(id))).json();
    const blob = new Blob([JSON.stringify({ session: id, exported: new Date().toISOString(), messages: hist }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'chat-' + id.slice(0, 8) + '.json'; a.click();
  }
  function reset() { s = { ...DEF, skills: [] }; save(); syncForm(); renderSkills(); }
  apply(); syncForm(); renderSkills();
  return { toggle, set, current: () => s, forRequest, exportChat, reset, setMode: (m) => set('mode', m), promptReset, promptResetAll, promptExport, promptImport, skillAdd, routerStatus, routerReset, routerResetStats, copyDiagnostics };
})();
window.SETTINGS = SETTINGS;
`;
