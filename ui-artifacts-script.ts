// Workbench logic. Editor = CodeMirror 5 (cdnjs, lazy) behind a tiny ED facade with a
// textarea fallback, so every feature (live preview, find, selection → AI) works either
// way. Files may live in folders (a/b/c.js); binaries are stored as data: URLs.
export const artifactScript: string = String.raw`
const ART = (() => {
  const $ = (id) => document.getElementById(id);
  const el = $('apanel'), frame = $('ap-frame'), treeB = $('ap-tree-b'), ta = $('ap-editor'), gutter = $('ap-gutter'), state = $('ap-state'), pos = $('ap-pos'), title = $('ap-title'), openA = $('ap-open'), lint = $('ap-lint'), bin = $('ap-bin'), edwrap = $('ap-edwrap');
  const con = $('ap-console'), conBody = $('ap-con-body'), liveCb = $('ap-livecb'), askIn = $('ap-ask-in'), askSt = $('ap-ask-st'), askGo = $('ap-ask-go'), reply = $('ap-reply'), replyB = $('ap-reply-b'), setEl = $('ap-set'), jobsEl = $('ap-jobs');
  const EKEY = 'omni.editor';
  const PDEF = {
    pAsk: 'Update artifact #{{id}} ({{title}}): ',
    pFix: 'Fix artifact #{{id}} ({{title}}). The preview console shows:\n{{errors}}\nFind the root cause in the files, apply the smallest correct fix with update_artifact, and say what was wrong.',
    pSel: 'In {{file}} of artifact #{{id}}, about this selection:\n\n{{selection}}\n\n',
    pPrefix: '',
    pLint: 'Artifact #{{id}} ({{title}}) has lint issues. Fix every one with update_artifact (batched edits; write real implementations, never remove features), then re-check:\n{{lint}}',
    pIntegrate: 'Integration pass on artifact #{{id}}: independent builders wrote the files against manifest.json. Fix every lint issue below, verify each import path exists and each imported name is exported with the same signature, remove duplicate definitions, make index.html load scripts in dependency order, and check the acceptance list. read_artifact only what you need, then ONE update_artifact with batched edits. Report ≤6 lines.\n\nLint issues:\n{{issues}}',
  };
  const DEF = { hideChat: true, side: 'right', defaultView: 'split', split: 50, width: 52, live: true, liveDelay: 700, console: 'auto', consoleMax: 200, previewBg: '#ffffff', runOnOpen: true,
    fontSize: 12, tabSize: 2, softTabs: true, lineNumbers: true, wrap: false, autoIndent: true, closeBrackets: true, lintOnType: false, codemirror: true, showTree: true,
    autoSave: false, autoSaveDelay: 1500, saveBeforeAsk: true, autoOpen: true, reopen: true, focusReply: true, errorsToAI: 6, autoFixLint: true, autoFixErrors: true, autoFixRounds: 3, ...PDEF };
  let E = { ...DEF };
  try { E = { ...DEF, ...JSON.parse(localStorage.getItem(EKEY) || '{}') }; } catch {}
  let cur = null, active = null, viewMode = E.defaultView, liveTimer = null, saveTimer = null, lastErrors = [], errReports = [], listCache = [], closedDirs = new Set();
  const isBin = (p, c) => (c !== undefined ? String(c).startsWith('data:') : /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|mp3|ogg|wav|mp4|webm|bin|wasm)$/i.test(p));
  // Artifact bodies are generated source — the single most WAF-triggering payload this app sends.
  // encBody is defined in main-script.ts and shared via window.omniNet; fall back to plain JSON if the
  // workbench script somehow loads first, so a save is never lost to a missing helper.
  const post = (path, body) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: (window.omniNet && window.omniNet.encBody ? window.omniNet.encBody(body) : JSON.stringify(body)) });

  // ─── editor facade: CodeMirror 5 when available, textarea otherwise ─────────
  let cm = null, cmLoading = null;
  const MODES = { js: 'javascript', mjs: 'javascript', ts: 'text/typescript', tsx: 'text/typescript-jsx', jsx: 'text/jsx', mts: 'text/typescript', cts: 'text/typescript', json: { name: 'javascript', json: true }, html: 'htmlmixed', htm: 'htmlmixed', css: 'css', svg: 'xml', xml: 'xml', md: 'markdown', glsl: 'x-shader/x-fragment', frag: 'x-shader/x-fragment', vert: 'x-shader/x-vertex', wgsl: 'text/x-csrc', txt: null, csv: null };
  const modeFor = (p) => { const ext = (p.split('.').pop() || '').toLowerCase(); return ext in MODES ? MODES[ext] : null; };
  function loadCM() {
    if (window.CodeMirror) return Promise.resolve(true);
    if (cmLoading) return cmLoading;
    const base = 'https://cdnjs.cloudflare.com/ajax/libs/codemirror/5.65.16/';
    const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = base + 'codemirror.min.css'; document.head.appendChild(css);
    const js = (f) => new Promise((res, rej) => { const s = document.createElement('script'); s.src = base + f; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
    cmLoading = js('codemirror.min.js').then(() => Promise.all(['mode/javascript/javascript.min.js', 'mode/xml/xml.min.js', 'mode/css/css.min.js', 'mode/htmlmixed/htmlmixed.min.js', 'mode/clike/clike.min.js', 'mode/markdown/markdown.min.js', 'addon/edit/closebrackets.min.js', 'addon/edit/matchbrackets.min.js', 'addon/search/searchcursor.min.js', 'addon/selection/active-line.min.js'].map(js))).then(() => true).catch(() => { cmLoading = null; return false; });
    return cmLoading;
  }
  const ED = {
    get: () => cm ? cm.getValue() : ta.value,
    set: (v) => { if (cm) { cm.setValue(v); cm.clearHistory(); } else ta.value = v; renderGutter(); },
    sel: () => cm ? cm.getSelection() : ta.value.slice(ta.selectionStart, ta.selectionEnd),
    cursor: () => { if (cm) { const c = cm.getCursor(); return [c.line + 1, c.ch + 1, cm.getSelection().length]; } const v = ta.value.slice(0, ta.selectionStart).split('\n'); return [v.length, v[v.length - 1].length + 1, ta.selectionEnd - ta.selectionStart]; },
    focus: () => (cm || ta).focus(),
    mode: (p) => { if (cm) cm.setOption('mode', modeFor(p) || 'text/plain'); },
    apply: () => { if (cm) { cm.setOption('lineNumbers', !!E.lineNumbers); cm.setOption('lineWrapping', !!E.wrap); cm.setOption('tabSize', E.tabSize); cm.setOption('indentUnit', E.tabSize); cm.setOption('indentWithTabs', !E.softTabs); cm.setOption('autoCloseBrackets', !!E.closeBrackets); cm.setOption('smartIndent', !!E.autoIndent); cm.refresh(); } },
    refresh: () => { if (cm) { cm.setSize('100%', '100%'); cm.refresh(); } },
  };
  async function ensureEditor() {
    if (!E.codemirror || cm) { if (!E.codemirror && cm) { cm.getWrapperElement().remove(); cm = null; ta.hidden = false; gutter.hidden = false; } return; }
    if (!(await loadCM())) return;
    if (cm || !E.codemirror) return;
    ta.hidden = true; gutter.hidden = true;
    cm = CodeMirror((node) => edwrap.insertBefore(node, ta), { value: ta.value, theme: 'omni', lineNumbers: !!E.lineNumbers, lineWrapping: !!E.wrap, tabSize: E.tabSize, indentUnit: E.tabSize, indentWithTabs: !E.softTabs, autoCloseBrackets: !!E.closeBrackets, matchBrackets: true, smartIndent: !!E.autoIndent, styleActiveLine: true, extraKeys: { 'Cmd-S': () => save(), 'Ctrl-S': () => save(), 'Cmd-Enter': () => reload(true), 'Ctrl-Enter': () => reload(true), 'Cmd-F': () => findToggle(true), 'Ctrl-F': () => findToggle(true), 'Esc': () => { if (!$('ap-find').hidden) findToggle(false); }, Tab: (c) => { if (c.somethingSelected()) c.indentSelection('add'); else c.replaceSelection(E.softTabs ? ' '.repeat(E.tabSize) : '\t', 'end'); }, 'Shift-Tab': (c) => c.indentSelection('subtract') } });
    cm.setSize('100%', '100%');
    cm.on('change', (_, ch) => { if (ch.origin !== 'setValue') onEdit(); });
    // CodeMirror measures once; any change of the wrapper's box (window resize, split drag, tree toggle, side change) needs a refresh
    if (window.ResizeObserver) new ResizeObserver(() => { if (cm) cm.refresh(); }).observe(edwrap);
    cm.on('cursorActivity', updPos);
    if (active) ED.mode(active);
  }

  // ─── settings ───────────────────────────────────────────────────────────────
  function applyE() {
    const root = document.documentElement;
    root.style.setProperty('--ap-w', E.width + 'vw'); root.style.setProperty('--ap-split', E.split + '%'); root.style.setProperty('--ap-fs', E.fontSize + 'px'); root.style.setProperty('--ap-tab', E.tabSize); root.style.setProperty('--ap-bg', E.previewBg);
    el.dataset.side = E.side; el.classList.toggle('wrap', !!E.wrap); el.classList.toggle('no-gutter', !E.lineNumbers || !!E.wrap); el.classList.toggle('no-tree', !E.showTree);
    liveCb.checked = !!E.live;
    document.body.classList.toggle('ap-full', !!E.hideChat && document.body.classList.contains('ap-open'));
    if (E.console === 'open') con.hidden = false; else if (E.console === 'hidden') con.hidden = true;
    renderGutter(); ED.apply(); if (!el.classList.contains('closed')) ensureEditor();
  }
  function saveE() { try { localStorage.setItem(EKEY, JSON.stringify(E)); } catch {} applyE(); }
  function syncE() {
    setEl.querySelectorAll('[data-e]').forEach(inp => { const k = inp.dataset.e; if (inp.type === 'checkbox') inp.checked = !!E[k]; else inp.value = E[k] ?? ''; const o = inp.nextElementSibling; if (o && o.tagName === 'OUTPUT') o.textContent = E[k] + (k === 'split' || k === 'width' ? '%' : ''); });
    const wb = $('ap-p-workbench'); const S = window.SETTINGS ? SETTINGS.current() : null;
    if (S && S.prompts && S.prompts.workbench) wb.value = S.prompts.workbench; else fetch('?prompts').then(r => r.json()).then(j => { if (!wb.value) wb.value = j.defaults.workbench || ''; wb.dataset.def = j.defaults.workbench || ''; }).catch(() => {});
  }
  setEl.addEventListener('input', (e) => {
    const inp = e.target; const k = inp.dataset && inp.dataset.e;
    if (inp.id === 'ap-p-workbench' && window.SETTINGS) { const S = SETTINGS.current(); S.prompts = { ...(S.prompts || {}) }; if (inp.value.trim() && inp.value.trim() !== (inp.dataset.def || '').trim()) S.prompts.workbench = inp.value; else delete S.prompts.workbench; SETTINGS.set('prompts', S.prompts); return; }
    if (!k) return;
    let v = inp.type === 'checkbox' ? inp.checked : inp.value; if (inp.type === 'range' || k === 'tabSize') v = Number(v);
    E[k] = v; saveE(); const o = inp.nextElementSibling; if (o && o.tagName === 'OUTPUT') o.textContent = v + (k === 'split' || k === 'width' ? '%' : '');
    if (k === 'live') reload(!v);
  });
  function toggleSettings(open) { const o = open ?? setEl.classList.contains('closed'); setEl.classList.toggle('closed', !o); if (o) syncE(); }
  function resetPrompts() { Object.assign(E, PDEF); saveE(); syncE(); }
  function resetSettings() { E = { ...DEF }; saveE(); syncE(); }
  const tpl = (s, v) => String(s || '').replace(/\{\{(\w+)\}\}/g, (_, k) => v[k] ?? '');
  function vars() {
    const f = cur && cur.files.find(x => x.path === active);
    return cur ? { id: cur.id, title: cur.title, file: active || '', files: cur.files.map(x => x.path).join(', '), selection: ED.sel(), errors: lastErrors.slice(-E.errorsToAI).join('\n'), content: f ? f.content : '' } : {};
  }

  // ─── console capture ────────────────────────────────────────────────────────
  // JSON.stringify(errorInstance) === "{}" — message/stack are non-enumerable own properties on Error, so the
  // previous version of this hook silently swallowed the ONE thing an artifact's own catch(e){console.error(...)}
  // actually passes: the Error object itself. Confirmed against a real failure mode (init.js's own error
  // boundary logging "Initialization error:", e) — this is why the console panel showed "Initialization error: {}"
  // instead of the TypeError/SyntaxError text. Fix: serialize Error instances (and error-shaped plain objects —
  // some transpiled/bundled code throws non-Error objects with .message/.stack) via their stack/message, not JSON.
  // Item 10: an artifact's own bug (a runaway console.log/error in a loop) can flood postMessage far
  // faster than the parent's conBody DOM cap (consoleMax, trimmed one child at a time in the handler
  // below) can keep up with — every flooded message still round-trips through structured-clone
  // postMessage and a DOM append before its turn to be trimmed. A hard per-load counter stops posting
  // once a runaway is evident, with one final message announcing the cutoff so it's visible, not silent.
  const HOOK = '<script>(function(){var fmt=function(x){if(x instanceof Error)return x.stack||(x.name+": "+x.message);if(x&&typeof x==="object"&&typeof x.message==="string"&&(x.stack||x.name))return x.stack||((x.name||"Error")+": "+x.message);return typeof x==="string"?x:JSON.stringify(x)};var n=0,capped=false;var s=function(l,a){if(capped)return;n++;if(n>500){capped=true;try{parent.postMessage({omniConsole:1,level:"error",text:"[console flood guard] over 500 messages this load — suppressing further output (likely a runaway loop)"},"*")}catch(e){}return}try{parent.postMessage({omniConsole:1,level:l,text:Array.from(a).map(function(x){try{return fmt(x)}catch(e){return String(x)}}).join(" ")},"*")}catch(e){}};["log","info","warn","error"].forEach(function(l){var o=console[l];console[l]=function(){s(l,arguments);o&&o.apply(console,arguments)}});window.addEventListener("error",function(e){if(e&&e.target&&e.target!==window&&(e.target.src||e.target.href)){s("error",["failed to load "+(e.target.tagName||"resource").toLowerCase()+" "+String(e.target.src||e.target.href).split("/").slice(-1)[0]+" (404 or blocked)"]);return}s("error",[e.message+" ("+(e.filename||"").split("/").pop()+":"+e.lineno+")"])},true);window.addEventListener("unhandledrejection",function(e){s("error",["unhandled: "+fmt(e.reason)])})})();<\/script>';
  window.addEventListener('message', (e) => {
    if (!e.data || !e.data.omniConsole) return;
    const isErr = e.data.level === 'error';
    const isWarn = e.data.level === 'warn';
    if (E.console === 'auto' || (E.console === 'errors' && (isErr || isWarn))) con.hidden = false;
    const d = document.createElement('div'); d.className = 'con-line con-' + (isErr ? 'err' : isWarn ? 'warn' : 'log'); d.textContent = e.data.text; conBody.appendChild(d); conBody.scrollTop = conBody.scrollHeight;
    if (isErr || isWarn) { lastErrors.push(e.data.text); if (lastErrors.length > 40) lastErrors.shift(); scheduleErrorFix(); }
    if (e.data && e.data.omniError) {
      /* Collapse duplicates by (kind, message, first stack line). Six identical masked errors are one
         fact, and sending six copies to the model spends the whole error budget saying it once. */
      const sig = e.data.kind + '|' + e.data.message + '|' + String(e.data.stack || '').split('\n')[1];
      const hit = errReports.find(x => x.__sig === sig);
      if (hit) { hit.__n = (hit.__n || 1) + 1; }
      else { e.data.__sig = sig; e.data.__n = 1; errReports.push(e.data); if (errReports.length > 20) errReports.shift(); }
      scheduleErrorFix();
    }
    while (conBody.children.length > E.consoleMax) conBody.firstChild.remove();
  });
  // ── unhandled errors in the preview are fixed automatically: one fix turn per distinct error set, unlimited retries ──
  let errFixTimer = null; const errFixed = {};
  function scheduleErrorFix() { if (!E.autoFixErrors || !cur) return; clearTimeout(errFixTimer); errFixTimer = setTimeout(autoFixErrors, 1200); }
  function autoFixErrors() {
    if (!E.autoFixErrors || !cur || !lastErrors.length || typeof sendWith !== 'function') return;
    if (window.inflightTurn && window.inflightTurn()) { errFixTimer = setTimeout(autoFixErrors, 3000); return; } /* wait for the running turn, then re-evaluate: it may have fixed them */
    const uniq = [...new Set(lastErrors.map(x => x.replace(/\?v=\d+/g, '').replace(/:\d+[:\)]/, ':?)')))].slice(-E.errorsToAI); const key = uniq.join('|');
    const st = errFixed[cur.id] = errFixed[cur.id] || { rounds: 0, last: '', t: 0 };
    /* retry if error set changed, or 8s+ since last attempt (artifact may have been edited/reloaded) */
    if (st.last !== key) st.escalated = false;   // a DIFFERENT failure is a new request, with its own budget
    if (st.last === key && (Date.now() - st.t < 8000)) return;
    /* E.autoFixRounds is offered in the settings panel as "rounds per artifact" and was never checked
       here - only the 8s/same-error damper was. A preview whose errors keep CHANGING therefore looped
       forever, spending a model call each round with no ceiling. maybeAutoFix() has always enforced its
       own cap; this is the same rule, using the number the user actually set. */
    // THE INLINE BUDGET RUNNING OUT IS NOT THE REQUEST FAILING. It means the next attempt must be the
    // durable one: the repair job re-diagnoses, repairs, re-checks and repeats by itself, survives a closed
    // tab, and stops only when the reported errors are gone or the user presses stop. The old line said
    // "auto-fix stopped (N rounds)" and left the errors on screen with nothing running.
    if (st.rounds >= Math.max(1, Number(E.autoFixRounds) || 3)) { escalateRepair(st, uniq, st.rounds); return; }
    st.rounds++; st.last = key; st.t = Date.now(); askSt.textContent = 'auto-fixing ' + uniq.length + ' error' + (uniq.length > 1 ? 's' : '') + ' (round ' + st.rounds + ')';
    /* Enrich server-side first: the server has the artifact's source, so it can resolve every stack frame
       to real lines, the enclosing function and its scope chain. Sending the flat console strings instead
       makes the model guess at code it cannot see, and a guessed fix is how one round becomes six.
       If enrichment is unavailable for any reason the flat strings still go, so a fix is never blocked. */
    (async () => {
      let detail = uniq.join('\n');
      try {
        const r = await fetch('?report_errors', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ artifactId: cur.id, reports: errReports.slice(-E.errorsToAI), maxRounds: Math.max(1, Number(E.autoFixRounds) || 3) }) });
        if (r.ok) {
          const j = await r.json();
          if (j.brief) detail = j.brief;
          // The server's own inline-round ceiling is the same signal as the local one: stop retrying INSIDE
          // a chat turn, hand the request to the durable repair job instead of declaring failure.
          if (j.exhausted || j.unchanged) {
            const st2 = errFixed[cur.id] = errFixed[cur.id] || { rounds: 0, last: '', t: 0 };
            const why = j.unchanged ? 'the last inline repair changed nothing' : j.round + ' inline rounds are used';
            const d = detail || uniq.join('\n');
            escalateRepair(st2, uniq, st2.rounds, why + '; the preview still reports these errors:\n' + d);
            return;
          }
        }
      } catch (e) { /* enrichment is an optimisation, not a gate */ }
      const v = { ...vars(), errors: detail };
      sendWith(tpl(E.pFix, v), focusPayload() || {});
    })();
  }
  /** Inline rounds are spent: send ONE ask that the durable repair job picks up.
   *
   *  The client cannot run a background loop, and pretending it can is how "auto-fix stopped after 3 rounds"
   *  became the answer to a request that said "fix everything". The server can: a repair job re-reads the
   *  files, repairs only what is still broken, verifies that the round changed something, and repeats until
   *  the failure is gone or it has exhausted its bounded rounds. So the last inline attempt is worded for
   *  the job path and sent once per (artifact, error set). */
  function escalateRepair(st, uniq, rounds, brief) {
    if (!cur) return;
    if (st.escalated) { askSt.textContent = 'repair job already handed off \u2014 the BUILD card reports it (stop is on the card)'; return; }
    st.escalated = true;
    const v = { ...vars(), errors: String(brief || uniq.join('\n')).slice(0, 6000) };
    askSt.textContent = 'inline rounds used (' + (rounds || 0) + ') \u2014 continuing as a durable repair job';
    // The ask is an ordinary repair ask: the server decides whether it fits one turn or becomes a job, and
    // if the inline attempt does not land the job takes over in the same response (wireTurn.after).
    sendWith(tpl(E.pFix, v), focusPayload() || {});
  }
  function clearConsole() { conBody.innerHTML = ''; lastErrors = []; if (E.console !== 'open') con.hidden = true; }
  function hideConsole() { con.hidden = true; }

  // ─── open / close / restore ─────────────────────────────────────────────────
  // Fetch + merge (keeping unsaved buffers) into cur. Shared by open() (which also makes the panel visible)
  // and refresh() (which updates cur — and the panel, if it's already visible — without ever opening it).
  async function loadArtifactData(id) {
    const r = await fetch('?artifact_files=' + id);
    if (!r.ok) { state.textContent = 'artifact not found'; return null; }
    const data = await r.json();
    if (cur && cur.id === data.id && cur.dirty.size) { // keep unsaved buffers, refresh the rest
      for (const f of data.files) { const mine = cur.files.find(x => x.path === f.path); if (mine && cur.dirty.has(f.path)) f.content = mine.content; }
      for (const p of cur.dirty) if (!data.files.some(f => f.path === p)) { const mine = cur.files.find(x => x.path === p); if (mine) data.files.push(mine); }
      data.dirty = cur.dirty; data.orig = Object.fromEntries(data.files.map(f => [f.path, cur.dirty.has(f.path) ? cur.orig[f.path] : f.content]));
    } else { data.dirty = new Set(); data.orig = Object.fromEntries(data.files.map(f => [f.path, f.content])); }
    const same = cur && cur.id === data.id;
    cur = data; active = same && cur.files.some(f => f.path === active) ? active : (cur.files.find(f => /^index\.html?$/.test(f.path)) || cur.files[0])?.path ?? null;
    return { same };
  }
  // Toggles a badge on the "build" tab (chat/build/runs mode switcher — a separate DOM element from this
  // panel, shared global scope) so an update to an artifact you're not currently looking at is visible
  // without pulling you off whatever you ARE looking at.
  function setUpdated(on) {
    const btn = document.querySelector('#modes button[data-view="build"]');
    if (btn) btn.classList.toggle('has-update', on);
  }
  async function open(id, v) {
    const res = await loadArtifactData(id);
    if (!res) return;
    const { same } = res;
    title.textContent = '#' + cur.id + ' · ' + cur.title; openA.href = '/artifact/' + cur.id + '/';
    el.classList.remove('closed'); el.setAttribute('aria-hidden', 'false'); document.body.classList.add('ap-open'); document.body.classList.toggle('ap-full', !!E.hideChat);
    try { localStorage.setItem('omni.ap.open', String(cur.id)); localStorage.setItem('omni.ap.last', String(cur.id)); } catch {}
    await ensureEditor();
    showLint(cur.issues); view(v || viewMode); renderTree(); showFile(active); if (!same) clearConsole(); reload(!!E.runOnOpen);
    setUpdated(false);
    document.dispatchEvent(new CustomEvent('omni:artifact-opened', { detail: { id: cur.id } }));
  }
  // Re-fetches an artifact and, ONLY if the workbench is already visible, refreshes what's on screen (tree,
  // active file, lint, live preview) in place. Never opens the panel and never touches document.body's
  // ap-open/ap-full classes — those are what steal focus from the chat view. If the panel is hidden, this
  // just keeps cur current for whenever you do switch, and badges the build tab so you know something changed.
  async function refresh(id) {
    const wasOpen = !el.classList.contains('closed');
    const res = await loadArtifactData(id);
    if (!res) return;
    title.textContent = '#' + cur.id + ' · ' + cur.title; openA.href = '/artifact/' + cur.id + '/';
    if (wasOpen) { showLint(cur.issues); renderTree(); showFile(active); reload(!!E.runOnOpen); setUpdated(false); }
    else setUpdated(true);
  }
  function close() { el.classList.add('closed'); el.setAttribute('aria-hidden', 'true'); document.body.classList.remove('ap-open', 'ap-full'); frame.removeAttribute('srcdoc'); frame.src = 'about:blank'; try { localStorage.removeItem('omni.ap.open'); } catch {} document.dispatchEvent(new CustomEvent('omni:artifact-closed')); }
  function restore() { if (!E.reopen) return; let id = null; try { id = localStorage.getItem('omni.ap.open'); } catch {} if (id) open(Number(id)); }
  function view(v) { viewMode = v; el.dataset.view = v; document.querySelectorAll('.ap-tab').forEach(t => t.classList.toggle('on', t.dataset.view === v)); ED.refresh(); }

  // ─── live preview ───────────────────────────────────────────────────────────
  function buildLive() {
    const idx = cur.files.find(f => /^index\.html?$/.test(f.path)) || cur.files.find(f => /\.html?$/.test(f.path));
    if (!idx) return null;
    const dir = idx.path.includes('/') ? idx.path.slice(0, idx.path.lastIndexOf('/') + 1) : '';
    const get = (p) => { const rel = (dir + p.replace(/^\.\//, '')).replace(/\/\.\//g, '/'); const f = cur.files.find(x => x.path === rel || x.path === p.replace(/^\.\//, '')); return f && !isBin(f.path, f.content) ? f.content : undefined; };
    let html = idx.content;
    // ES modules: unsaved buffers become data: URLs (allowed from the sandbox's opaque origin, unlike blob:), with their
    // own relative imports rewritten recursively; saved/unknown/cyclic imports fall back to the server copy.
    const serverUrl = (p) => location.origin + '/artifact/' + cur.id + '/' + p;
    const resolve = (from, spec) => { const d = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : ''; const parts = (d + spec.replace(/^\.\//, '')).split('/'); const out = []; for (const x of parts) { if (x === '..') out.pop(); else if (x !== '.') out.push(x); } return out.join('/'); };
    const memo = new Map();
    const moduleUrl = (path, stack) => {
      if (memo.has(path)) return memo.get(path);
      const f = cur.files.find(x => x.path === path); if (!f || isBin(f.path, f.content) || stack.includes(path)) return serverUrl(path);
      const src = f.content.replace(/((?:^|[^\w$])(?:import|export)\s*(?:[^'"]*?\s*from\s*)?|import\s*\(\s*)(["'])(\.{1,2}\/[^"']+)\2/g, (m, pre, q, spec) => { const t = resolve(path, spec); return cur.files.some(x => x.path === t) ? pre + q + moduleUrl(t, [...stack, path]) + q : pre + q + serverUrl(t) + q; });
      const url = 'data:text/javascript;charset=utf-8,' + encodeURIComponent(src).replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29'); /* quotes/parens would break the importer's string literal */ memo.set(path, url); return url;
    };
    html = html.replace(/<script([^>]*?)\ssrc=(?:["']([^"']+)["']|([^\s>]+))([^>]*)><\/script>/gi, (m, a, s1, s2, b) => {
      const rel = resolve(idx.path, s1 || s2);
      if (/type=["']?module/i.test(a + b)) return cur.files.some(x => x.path === rel) ? '<script' + a + ' src="' + moduleUrl(rel, []) + '"' + b + '><\/script>' : m;
      const c = get(s1 || s2); return c === undefined ? m : '<script' + a + b + '>' + c.replace(/<\/script/gi, '<\\/script') + '<\/script>'; });
    html = html.replace(/(<script[^>]*type=["']?module["']?[^>]*>)([\s\S]*?)(<\/script>)/gi, (m, o, code, c) => /\ssrc=/i.test(o) ? m : o + code.replace(/((?:^|[^\w$])(?:import|export)\s*(?:[^'"]*?\s*from\s*)?|import\s*\(\s*)(["'])(\.{1,2}\/[^"']+)\2/g, (mm, pre, q, spec) => { const t = resolve(idx.path, spec); return pre + q + (cur.files.some(x => x.path === t) ? moduleUrl(t, []) : serverUrl(t)) + q; }) + c);
    html = html.replace(/<link\b([^>]*)>/gi, (m, attrs) => { if (!/rel=["']?stylesheet/i.test(attrs)) return m; const h = attrs.match(/href=(?:["']([^"']+)["']|([^\s>]+))/i); const c = h ? get(h[1] || h[2]) : undefined; return c === undefined ? m : '<style>' + c + '</style>'; });
    const base = '<base href="' + location.origin + '/artifact/' + cur.id + '/' + dir + '">';
    html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + base + HOOK) : base + HOOK + html;
    return html;
  }
  function reload(fromServer) {
    if (!cur) return;
    if (!fromServer && liveCb.checked) { const doc = buildLive(); if (doc !== null) { frame.srcdoc = doc; return; } }
    frame.removeAttribute('srcdoc'); frame.src = '/artifact/' + cur.id + '/?v=' + Date.now();
  }
  function scheduleLive() { if (!liveCb.checked) return; clearTimeout(liveTimer); liveTimer = setTimeout(() => { clearConsole(); reload(false); }, E.liveDelay); }
  function scheduleSave() { if (!E.autoSave) return; clearTimeout(saveTimer); saveTimer = setTimeout(() => save(), E.autoSaveDelay); }

  // ─── file tree ──────────────────────────────────────────────────────────────
  function renderTree() {
    treeB.innerHTML = '';
    const root = {};
    for (const f of [...cur.files].sort((a, b) => a.path.localeCompare(b.path))) { const parts = f.path.split('/'); let n = root; for (const p of parts.slice(0, -1)) n = n[p] = n[p] || {}; n[parts[parts.length - 1]] = f; }
    const walk = (node, host, prefix, depth) => {
      const names = Object.keys(node).sort((a, b) => (typeof node[a].path === 'string') - (typeof node[b].path === 'string') || a.localeCompare(b));
      for (const name of names) {
        const v = node[name];
        if (typeof v.path === 'string') { const d = document.createElement('div'); d.className = 'tr-f' + (v.path === active ? ' on' : '') + (cur.dirty.has(v.path) ? ' dirty' : ''); d.style.paddingLeft = (8 + depth * 12) + 'px'; d.textContent = name; d.title = v.path; d.onclick = () => showFile(v.path); host.appendChild(d); }
        else { const dir = prefix + name + '/'; const d = document.createElement('div'); d.className = 'tr-d' + (closedDirs.has(dir) ? ' closed' : ''); d.style.paddingLeft = (6 + depth * 12) + 'px'; d.textContent = name; d.onclick = () => { closedDirs.has(dir) ? closedDirs.delete(dir) : closedDirs.add(dir); renderTree(); }; host.appendChild(d); const kids = document.createElement('div'); kids.className = 'tr-kids'; host.appendChild(kids); walk(v, kids, dir, depth + 1); }
      }
    };
    walk(root, treeB, '', 0);
  }
  function showFile(p) {
    if (!cur) return; const f = cur.files.find(x => x.path === p); if (!f) return;
    active = p;
    if (isBin(p, f.content)) { bin.hidden = false; ta.hidden = true; gutter.hidden = true; if (cm) cm.getWrapperElement().style.display = 'none'; bin.innerHTML = /^data:image\//.test(f.content) ? '<img>' : '<span class="bin-note">binary · ' + Math.round(f.content.length * 0.75 / 1024) + ' KB</span>'; if (bin.querySelector('img')) bin.querySelector('img').src = f.content; }
    else { bin.hidden = true; if (cm) { cm.getWrapperElement().style.display = ''; } else { ta.hidden = false; gutter.hidden = !E.lineNumbers || !!E.wrap; } ED.mode(p); ED.set(f.content); }
    renderTree(); updState(); updPos(); ED.refresh();
  }
  function onEdit() { if (!cur || !active) return; const f = cur.files.find(x => x.path === active); if (!f || isBin(active, f.content)) return; f.content = ED.get(); cur.dirty.add(active); renderTree(); updState(); renderGutter(); lintLocal(); scheduleLive(); scheduleSave(); }
  function renderGutter() { if (cm || !E.lineNumbers || E.wrap) return; const n = ta.value.split('\n').length; if (gutter.dataset.n == n) return; gutter.dataset.n = n; let s = ''; for (let i = 1; i <= n; i++) s += i + '\n'; gutter.textContent = s; }
  ta.addEventListener('scroll', () => { gutter.scrollTop = ta.scrollTop; });
  function updState() { const f = cur.files.find(x => x.path === active); state.textContent = (f ? (isBin(f.path, f.content) ? 'binary' : f.content.length + ' chars · ' + f.content.split('\n').length + ' lines') : '') + (cur.dirty.size ? ' · ' + cur.dirty.size + ' unsaved' : ''); }
  function updPos() { const [l, c, s] = ED.cursor(); pos.textContent = l + ':' + c + (s ? ' (' + s + ' sel)' : ''); }
  let lintIssues = []; const autoFixed = {}; // artifact id → rounds used
  function showLint(issues) {
    lintIssues = issues || [];
    if (lintIssues.length) { lint.hidden = false; $('ap-lint-n').textContent = lintIssues.length + ' lint issue' + (lintIssues.length > 1 ? 's' : ''); $('ap-lint-b').textContent = lintIssues.join('\n'); maybeAutoFix(); }
    else lint.hidden = true;
  }
  function lintVars() { return { ...vars(), lint: lintIssues.join('\n') }; }
  function fixLint() { if (!cur || !lintIssues.length || typeof sendWith !== 'function') return; const text = tpl(E.pLint, lintVars()); askSt.textContent = 'fixing lint'; sendWith(text, focusPayload() || {}); }
  function copyLint() { navigator.clipboard.writeText(lintIssues.join('\n')); }
  function maybeAutoFix() {
    if (!E.autoFixLint || !cur || !lintIssues.length || (window.inflightTurn && window.inflightTurn())) return;
    const key = cur.id + ':' + lintIssues.join('|');
    autoFixed[cur.id] = autoFixed[cur.id] || { rounds: 0, last: '' };
    const st = autoFixed[cur.id]; if (st.rounds >= 2 || st.last === key) return;
    st.rounds++; st.last = key; setTimeout(fixLint, 400);
  }
  function lintLocal() { if (!E.lintOnType || !active || !/\.m?js$/.test(active)) return; try { new Function(ED.get().replace(/^\s*import\s[\s\S]*?from\s*["'][^"']+["']\s*;?/gm, '').replace(/^\s*export\s*\{[\s\S]*?\}\s*;?/gm, '').replace(/^\s*export\s+(default\s+)?/gm, '')); showLint(null); } catch (e) { showLint([active + ': ' + e.message]); } }
  // textarea fallback keys
  ta.addEventListener('input', onEdit); ta.addEventListener('keyup', updPos); ta.addEventListener('click', updPos);
  ta.addEventListener('keydown', (e) => {
    const s = ta.selectionStart, en = ta.selectionEnd, ind = E.softTabs ? ' '.repeat(E.tabSize) : '\t';
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
    else if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); reload(true); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); findToggle(true); }
    else if (e.key === 'Tab') { e.preventDefault(); ta.setRangeText(ind, s, en, 'end'); ta.dispatchEvent(new Event('input')); }
    else if (e.key === 'Enter' && E.autoIndent) { const line = ta.value.slice(0, s).split('\n').pop(); const base = line.match(/^\s*/)[0] + (/[{(\[:]\s*$/.test(line) ? ind : ''); e.preventDefault(); ta.setRangeText('\n' + base, s, en, 'end'); ta.dispatchEvent(new Event('input')); }
  });

  // ─── find / replace ─────────────────────────────────────────────────────────
  const fbox = $('ap-find'), fin = $('ap-find-in'), frep = $('ap-find-rep'), fn = $('ap-find-n'), fall = $('ap-find-all');
  function findToggle(open) { const o = open ?? fbox.hidden; fbox.hidden = !o; if (o) { fin.value = ED.sel() || fin.value; fin.focus(); fin.select(); } else ED.focus(); }
  function rx() { try { return new RegExp(fin.value, 'gi'); } catch { return new RegExp(fin.value.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&'), 'gi'); } }
  function findNext(dir) {
    if (!fin.value) return;
    if (fall.checked) { const hits = cur.files.filter(f => !isBin(f.path, f.content) && rx().test(f.content)); fn.textContent = hits.length + ' files'; const i = hits.findIndex(f => f.path === active); const nxt = hits[(i + (dir > 0 ? 1 : hits.length - 1)) % Math.max(1, hits.length)]; if (nxt && nxt.path !== active) { showFile(nxt.path); } }
    const v = ED.get(), re = rx(); const all = [...v.matchAll(re)]; fn.textContent = (fall.checked ? fn.textContent + ' · ' : '') + all.length + ' here'; if (!all.length) return;
    const from = cm ? cm.indexFromPos(dir > 0 ? cm.getCursor('to') : cm.getCursor('from')) : (dir > 0 ? ta.selectionEnd : ta.selectionStart);
    const m = dir > 0 ? (all.find(x => x.index >= from) || all[0]) : ([...all].reverse().find(x => x.index < from) || all[all.length - 1]);
    if (cm) { cm.setSelection(cm.posFromIndex(m.index), cm.posFromIndex(m.index + m[0].length)); cm.scrollIntoView(cm.posFromIndex(m.index), 60); } else { ta.focus(); ta.setSelectionRange(m.index, m.index + m[0].length); }
  }
  function replaceOne() { const sel = ED.sel(); if (!sel || !rx().test(sel)) { findNext(1); return; } if (cm) cm.replaceSelection(sel.replace(rx(), frep.value)); else { ta.setRangeText(sel.replace(rx(), frep.value), ta.selectionStart, ta.selectionEnd, 'end'); ta.dispatchEvent(new Event('input')); } if (cm) onEdit(); findNext(1); }
  function replaceAll() {
    if (!fin.value) return; let n = 0;
    const targets = fall.checked ? cur.files.filter(f => !isBin(f.path, f.content)) : cur.files.filter(f => f.path === active);
    for (const f of targets) { const out = f.content.replace(rx(), (m) => { n++; return frep.value; }); if (out !== f.content) { f.content = out; cur.dirty.add(f.path); } }
    fn.textContent = n + ' replaced'; showFile(active); scheduleLive();
  }
  fin.addEventListener('keydown', (e) => { if (e.key === 'Enter') findNext(e.shiftKey ? -1 : 1); if (e.key === 'Escape') findToggle(false); });

  // ─── save / files ───────────────────────────────────────────────────────────
  async function save() {
    if (!cur || !cur.dirty.size) return true;
    const files = [...cur.dirty].map(p => cur.files.find(x => x.path === p)).filter(Boolean).map(f => ({ path: f.path, content: f.content }));
    const r = await post('?artifact_save_many', { id: cur.id, session: cur.session, files });
    if (!r.ok) { state.textContent = 'save failed: ' + r.status; return false; }
    const j = await r.json(); for (const f of files) { cur.dirty.delete(f.path); cur.orig[f.path] = f.content; }
    showLint(j.issues); renderTree(); updState(); state.textContent += ' · saved'; clearConsole(); reload(true); return true;
  }
  function ask(label, def) { return new Promise((res) => { const box = $('ap-prompt'), inp = $('ap-prompt-in'); inp.placeholder = label; inp.value = def || ''; box.hidden = false; inp.focus(); inp.select();
    const done = (v) => { box.hidden = true; $('ap-prompt-ok').onclick = $('ap-prompt-no').onclick = null; inp.onkeydown = null; res(v); };
    $('ap-prompt-ok').onclick = () => done(inp.value.trim()); $('ap-prompt-no').onclick = () => done(null); inp.onkeydown = (e) => { if (e.key === 'Enter') done(inp.value.trim()); if (e.key === 'Escape') done(null); }; }); }
  async function addFile() { const p = await ask('path, e.g. src/game/enemy.js'); if (!p || !cur) return; const clean = p.replace(/^\/+/, ''); if (!cur.files.some(f => f.path === clean)) cur.files.push({ path: clean, content: '' }); cur.dirty.add(clean); showFile(clean); ED.focus(); }
  async function renameFile() {
    if (!cur || !active || /^index\.html?$/.test(active)) return; const p = await ask('new path', active); if (!p || p === active) return;
    const f = cur.files.find(x => x.path === active); const old = active;
    const w = await post('?artifact_save_many', { id: cur.id, session: cur.session, files: [{ path: p, content: f.content }] });
    if (!w || !w.ok) { askSt.textContent = 'rename failed writing ' + p + ' (' + ((w && w.status) || 'network') + ')'; return; }
    const d = await post('?artifact_delete_file', { id: cur.id, path: old });
    if (!d || !d.ok) { askSt.textContent = 'renamed to ' + p + ' but could not remove ' + old + ' (' + ((d && d.status) || 'network') + ')'; }
    f.path = p; cur.dirty.delete(old); cur.orig[p] = f.content; showFile(p); reload(true);
  }
  async function deleteFile() {
    if (!cur || !active || /^index\.html?$/.test(active)) return; const ok = await ask('type DELETE to remove ' + active); if (ok !== 'DELETE') return;
    /* post() is a bare fetch: it RESOLVES on 4xx/5xx. Dropping the file from cur.files without checking
       made a refused delete look like it worked until reload(true) put the file straight back. */
    const r = await post('?artifact_delete_file', { id: cur.id, path: active });
    if (!r || !r.ok) { askSt.textContent = 'delete failed (' + ((r && r.status) || 'network') + ') — ' + active + ' was not removed'; return; }
    cur.files = cur.files.filter(f => f.path !== active); cur.dirty.delete(active); showFile(cur.files[0].path); reload(true);
  }
  function revert() { if (!cur || !active) return; const f = cur.files.find(x => x.path === active); f.content = cur.orig[active] ?? f.content; cur.dirty.delete(active); showFile(active); scheduleLive(); }
  function copy() { if (cur && active) navigator.clipboard.writeText(cur.files.find(x => x.path === active)?.content ?? ''); }
  async function loadZip() { if (!window.JSZip) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); }); return window.JSZip; }
  async function zip() {
    if (!cur) return; const J = await loadZip(); const z = new J();
    for (const f of cur.files) { if (isBin(f.path, f.content)) { const m = f.content.match(/^data:[^;,]*;base64,(.*)$/s); if (m) z.file(f.path, m[1], { base64: true }); } else z.file(f.path, f.content); }
    const blob = await z.generateAsync({ type: 'blob' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = (cur.title || 'artifact').replace(/[^\w.-]+/g, '_') + '.zip'; a.click();
  }
  /** Upload loose files or a .zip into the open artifact (or create a new artifact from a zip when none is open). Text as-is, binaries as data: URLs. */
  async function upload(fileList) {
    const files = [];
    const readText = (f) => f.text(); const readData = (f) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(f); });
    for (const f of fileList) {
      if (/\.zip$/i.test(f.name)) { const J = await loadZip(); const z = await J.loadAsync(f); const names = Object.keys(z.files).filter(n => !z.files[n].dir && !/(^|\/)(\.|__MACOSX)/.test(n)); const strip = names.every(n => n.includes('/')) && new Set(names.map(n => n.split('/')[0])).size === 1 ? names[0].split('/')[0].length + 1 : 0;
        for (const n of names) { const path = n.slice(strip); if (!path) continue; if (isBin(path)) { const b64 = await z.files[n].async('base64'); files.push({ path, content: 'data:' + (mimeOf(path)) + ';base64,' + b64 }); } else files.push({ path, content: await z.files[n].async('string') }); } }
      else files.push({ path: f.name, content: isBin(f.name) ? await readData(f) : await readText(f) });
    }
    if (!files.length) return;
    if (!cur) { const r = await post('?artifact_save_many', { session: window.currentSession, title: files.find(f => /\.zip$/i.test(f.path))?.path || 'Imported', files }); const j = await r.json(); if (j.id) { open(j.id, 'split'); listForSession(window.currentSession); } return; }
    for (const f of files) { const ex = cur.files.find(x => x.path === f.path); if (ex) ex.content = f.content; else cur.files.push(f); cur.dirty.add(f.path); }
    renderTree(); updState(); state.textContent = files.length + ' file' + (files.length > 1 ? 's' : '') + ' added (unsaved)'; if (!E.autoSave) scheduleLive(); else scheduleSave();
  }
  const mimeOf = (p) => ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', mp4: 'video/mp4', webm: 'video/webm', wasm: 'application/wasm' })[(p.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';
  const tree = $('ap-tree');
  ['dragenter', 'dragover'].forEach(ev => tree.addEventListener(ev, (e) => { e.preventDefault(); tree.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(ev => tree.addEventListener(ev, (e) => { e.preventDefault(); tree.classList.remove('drag'); if (ev === 'drop' && e.dataTransfer?.files?.length) upload(e.dataTransfer.files); }));

  // ─── jobs strip (swarm builds) ──────────────────────────────────────────────
  const jobs = {};
  function setJobs(list) { if (list === null) { jobsEl.hidden = true; jobsEl.innerHTML = ''; for (const k in jobs) delete jobs[k]; return; } for (const j of list) jobs[j.path] = j.st; jobsEl.hidden = false; jobsEl.innerHTML = Object.entries(jobs).map(([p, s]) => '<span class="job ' + s + '" title="' + s + '">' + p.split('/').pop() + '</span>').join(''); }

  // ─── composer ───────────────────────────────────────────────────────────────
  function prefill(text) { askIn.value = text; askIn.dispatchEvent(new Event('input')); askIn.focus(); askIn.setSelectionRange(askIn.value.length, askIn.value.length); }
  function askEdit() { if (cur) prefill(tpl(E.pAsk, vars())); }
  function askFix() { if (cur) prefill(tpl(E.pFix, vars())); }
  function askSelection() { if (!cur) return; const v = vars(); if (!v.selection) { state.textContent = 'select some text first'; return; } prefill(tpl(E.pSel, v)); }
  function focusPayload() { if (!cur || el.classList.contains('closed')) return null; const v = vars(); return { focus: { id: cur.id, title: cur.title, file: active || '', files: cur.files.map(f => f.path), selection: (v.selection || '').slice(0, 4000), errors: lastErrors.slice(-E.errorsToAI) } }; }
  async function send() {
    const t = askIn.value.trim(); if (!t || !cur || typeof sendWith !== 'function') return;
    const fp = focusPayload(), text = (E.pPrefix ? tpl(E.pPrefix, vars()) + '\n' : '') + t;
    if (E.saveBeforeAsk && cur.dirty.size) { askSt.textContent = 'saving'; if (!(await save())) return; }
    askIn.value = ''; askIn.dispatchEvent(new Event('input')); askGo.disabled = true; askSt.textContent = 'sending';
    sendWith(text, fp || {});
  }
  askIn.addEventListener('input', () => { askIn.style.height = 'auto'; askIn.style.height = Math.min(askIn.scrollHeight, 120) + 'px'; });
  askIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } });
  document.addEventListener('omni:typing', (e) => { if (el.classList.contains('closed')) return; askSt.textContent = e.detail.on ? (e.detail.label + (e.detail.progress ? ' · ' + e.detail.progress.replace(/<[^>]+>/g, '') : '')) : ''; });
  document.addEventListener('omni:turn', (e) => {
    askGo.disabled = false; askSt.textContent = e.detail.error ? 'error' : '';
    if (el.classList.contains('closed') || !E.focusReply) return;
    const f = e.detail.final; reply.hidden = false; $('ap-reply-t').textContent = e.detail.error ? 'error' : 'reply';
    replyB.innerHTML = e.detail.error ? '<span style="color:var(--err)">' + MD.esc(e.detail.error) + '</span>' : MD.render(f && f.reply || '');
    if (!e.detail.error && window.MD && MD.enhance) MD.enhance(replyB);
  });
  function hideReply() { reply.hidden = true; }

  // ─── resize + keys ──────────────────────────────────────────────────────────
  const drag = (handle, onMove) => handle.addEventListener('pointerdown', (e) => { e.preventDefault(); handle.setPointerCapture(e.pointerId); frame.style.pointerEvents = 'none'; const mv = (ev) => onMove(ev); const up = () => { handle.removeEventListener('pointermove', mv); handle.removeEventListener('pointerup', up); frame.style.pointerEvents = ''; saveE(); }; handle.addEventListener('pointermove', mv); handle.addEventListener('pointerup', up); });
  drag($('ap-resize'), (ev) => { E.width = Math.round(Math.max(30, Math.min(100, (window.innerWidth - ev.clientX) / window.innerWidth * 100))); document.documentElement.style.setProperty('--ap-w', E.width + 'vw'); });
  drag($('ap-divider'), (ev) => { const body = $('ap-body'), r = body.getBoundingClientRect(); const horiz = getComputedStyle(body).flexDirection === 'row'; let pct = horiz ? (ev.clientX - r.left) / r.width * 100 : (ev.clientY - r.top) / r.height * 100; if (E.side !== 'left') pct = 100 - pct; E.split = Math.round(Math.max(15, Math.min(85, pct))); document.documentElement.style.setProperty('--ap-split', E.split + '%'); ED.refresh(); });
  liveCb.addEventListener('change', () => { E.live = liveCb.checked; saveE(); reload(!liveCb.checked); });
  const narrow = () => el.classList.toggle('narrow', window.innerWidth < 1000); window.addEventListener('resize', () => { narrow(); ED.refresh(); }); narrow();
  document.addEventListener('keydown', (e) => {
    if (el.classList.contains('closed')) return;
    if (e.key === 'Escape') { if (!fbox.hidden) findToggle(false); else if (!setEl.classList.contains('closed')) toggleSettings(false); else if (document.activeElement !== ta && !(cm && cm.hasFocus()) && $('ap-prompt').hidden) close(); }
    else if ((e.ctrlKey || e.metaKey) && e.key === ',') { e.preventDefault(); toggleSettings(); }
  });

  // ─── sidebar list ───────────────────────────────────────────────────────────
  async function listForSession(session) {
    const host = $('sb-artifacts'); if (!host) return;
    try { listCache = await (await fetch('?artifacts&session=' + encodeURIComponent(session))).json();
      host.innerHTML = listCache.length ? '<div class="sb-h">artifacts</div>' : '';
      for (const a of listCache) { const b = document.createElement('button'); b.className = 'sb-art'; b.textContent = '#' + a.id + ' ' + a.title; b.onclick = () => open(a.id); host.appendChild(b); }
    } catch {}
  }
  applyE();
  return { open, close, refresh, restore, view, reload, save, addFile, renameFile, deleteFile, revert, copy, zip, upload, askEdit, askFix, askSelection, send, hideReply, clearConsole, hideConsole, listForSession, toggleSettings, resetPrompts, resetSettings,
    findToggle, findNext, replaceOne, replaceAll, fixLint, copyLint, jobs: setJobs, tpl: (k, v) => tpl(E['p' + k[0].toUpperCase() + k.slice(1)] || PDEF['p' + k[0].toUpperCase() + k.slice(1)], v), list: () => listCache, lastErrors: () => lastErrors.slice(-E.errorsToAI),
    focusPayload, settings: () => E, setSettings: (o) => { if (o && typeof o === 'object') { E = { ...DEF, ...o }; saveE(); } }, current: () => cur };
})();
window.ART = ART;
`;
