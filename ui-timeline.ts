// Run timeline: ONE renderer for everything the AI did in a turn — live (fed by
// ?progress events) and from history (fed by message_meta.toolEvents). Collapsed to a
// summary line; each row expands to the request args and the response, pretty-printed.
export const timelineStyle: string = `
.tl{margin:4px 0 8px;border:1px solid var(--line);background:var(--s0);font-size:11px}
.tl-h{display:flex;gap:8px;align-items:center;padding:4px 8px;cursor:pointer;color:var(--dim);letter-spacing:.06em;user-select:none}
.tl-h::before{content:"▸";color:var(--acc);font-size:10px} .tl.open .tl-h::before{content:"▾"}
.tl-h .tl-sum{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap} .tl-h .tl-n{color:var(--dim2);font-size:10px}
.tl-body{display:none;border-top:1px solid var(--line)} .tl.open .tl-body{display:block}
.tl-row{display:flex;gap:8px;align-items:center;padding:3px 8px;border-bottom:1px solid var(--line);cursor:pointer} .tl-row:last-child{border-bottom:0} .tl-row:hover{background:var(--s1)}
.tl-k{font-size:9px;letter-spacing:.12em;text-transform:uppercase;padding:1px 6px;border:1px solid var(--line2);color:var(--dim);white-space:nowrap;min-width:52px;text-align:center}
.tl-k.ok{border-color:rgba(198,255,127,.35);color:var(--acc2)} .tl-k.err{border-color:rgba(255,107,107,.4);color:var(--err)} .tl-k.sys{border-color:transparent;color:var(--dim2)} .tl-k.live{border-color:var(--acc);color:var(--acc)}
.tl-d{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text)} .tl-t{color:var(--dim2);font-size:10px;white-space:nowrap}
.tl-x{display:none;padding:6px 8px 8px;background:var(--bg);border-bottom:1px solid var(--line)} .tl-row.open+.tl-x{display:grid;grid-template-columns:1fr 1fr;gap:8px} @media (max-width:800px){.tl-row.open+.tl-x{grid-template-columns:1fr}}
.tl-x h5{font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim2);margin:0 0 4px;font-weight:500;display:flex;justify-content:space-between} .tl-x h5 button{background:none;border:0;color:var(--dim2);font:inherit;cursor:pointer} .tl-x h5 button:hover{color:var(--acc)}
.tl-x pre{margin:0;white-space:pre-wrap;word-break:break-word;font-size:11px;line-height:1.45;color:var(--dim);max-height:320px;overflow:auto} .tl-x pre.full{max-height:none}
.tl-x .tl-more{color:var(--acc);cursor:pointer;font-size:10px;margin-top:4px;display:inline-block}
.tl.live .tl-h{color:var(--acc)}
.tl-st{font-size:9px;letter-spacing:.12em;text-transform:uppercase;min-width:56px;text-align:right;color:var(--dim2)}
.tl-row.st-done .tl-st{color:var(--acc2)} .tl-row.st-failed .tl-st{color:var(--err)} .tl-row.st-repeated .tl-st{color:var(--warn)} .tl-row.st-running .tl-st{color:var(--acc)} .tl-row.st-running .tl-st::after{content:"";display:inline-block;width:6px;height:6px;background:var(--acc);margin-left:5px;animation:blink 1s infinite}
.tl-row.st-failed .tl-k{border-color:rgba(255,107,107,.4);color:var(--err)} .tl-row.st-done .tl-k{border-color:rgba(198,255,127,.3);color:var(--acc2)} .tl-row[data-kind=step] .tl-k{border-color:transparent;color:var(--dim2)}
.tl-plan{display:flex;gap:4px;flex-wrap:wrap;padding:5px 8px;border-bottom:1px solid var(--line)} .tl-pl{font-size:9px;letter-spacing:.12em;text-transform:uppercase;padding:1px 8px;border:1px solid var(--line2);color:var(--dim2)} .tl-pl::before{content:"○ "} .tl-pl.st-running{border-color:var(--acc);color:var(--acc)} .tl-pl.st-running::before{content:"● "} .tl-pl.st-done{border-color:rgba(198,255,127,.3);color:var(--acc2)} .tl-pl.st-done::before{content:"✓ "} .tl-pl.st-failed{border-color:var(--err);color:var(--err)} .tl-pl.st-failed::before{content:"✗ "} .tl-pl.st-skipped{opacity:.5} .tl-pl.st-skipped::before{content:"– "}
.tl-row[data-kind=route] .tl-k{border-color:rgba(3,180,246,.3);color:var(--acc)}
.tl-row.open[data-kind=route]+.tl-x{grid-template-columns:1fr}
.tl-route{display:flex;flex-wrap:wrap;gap:3px 2px;align-items:center;margin-bottom:8px}
.tl-rn{font-size:9px;letter-spacing:.04em;padding:2px 7px;border:1px solid var(--line2);color:var(--dim2);white-space:nowrap;cursor:default}
.tl-rn.ok{border-color:var(--acc2);color:var(--acc2);background:rgba(198,255,127,.08);font-weight:600}
.tl-rn.failed{border-color:var(--err);color:var(--err)}
.tl-rn.skipped{opacity:.5;font-style:italic}
.tl-rn.demoted{border-style:dashed;opacity:.65}
.tl-rn.untried{opacity:.3;border-style:dashed}
.tl-arrow{color:var(--dim2);font-size:10px;padding:0 1px}
`;

export const timelineScript: string = String.raw`
const TL = (() => {
  const LABEL = { web_search: 'search', eval_js: 'eval', create_artifact: 'build', update_artifact: 'edit', read_artifact: 'read', search_artifact: 'grep', memory_recall: 'recall', memory_write: 'remember', name_session: 'name', session_clear: 'clear', session_delete: 'delete', route: 'route', model: 'model' };
  // Aligned with ui-markdown.ts's esc(), which also escapes ' as &#39; — this one didn't, so a value
  // containing a single quote (e.g. data-p="' + esc(p) + '") could break out of a single-quoted attribute
  // if this template's own quoting ever changes, and was simply inconsistent with the other escaper in the
  // same codebase for no reason tied to this file's own (all double-quoted) attribute usage.
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const short = (v) => { if (v == null) return ''; if (typeof v === 'string') return v; try { return JSON.stringify(v); } catch { return String(v); } };
  const pretty = (v) => { if (v == null) return ''; if (typeof v === 'string') return v; try { return JSON.stringify(v, null, 2); } catch { return String(v); } };
  function desc(ev) {
    const a = ev.args || {}, r = ev.result;
    switch (ev.tool) {
      case 'web_search': return 'search: ' + (a.query || '');
      case 'eval_js': return 'eval: ' + String(a.code || a.expression || '').slice(0, 80).replace(/\s+/g, ' ');
      case 'create_artifact': return 'built ' + (a.title || (r && r.title) || '') + (a.files ? ' (' + (1 + (a.files.length || 0)) + ' files)' : '');
      case 'update_artifact': { const n = (a.edits && a.edits.length) || 0, f = (a.files && a.files.length) || 0; return 'edit #' + (a.id ?? (r && r.id) ?? '') + (n ? ' · ' + n + ' edit' + (n > 1 ? 's' : '') : '') + (f ? ' · ' + f + ' file' + (f > 1 ? 's' : '') : '') + (a.delete ? ' · delete' : ''); }
      case 'search_artifact': return 'grep: ' + (a.query || '') + (r && r.matches != null ? ' → ' + r.matches + ' hits' : '');
      case 'read_artifact': return 'read #' + (a.id ?? '') + (a.all ? ' (all files)' : a.path ? ' ' + a.path : '');
      case 'memory_recall': return 'recall: ' + (a.query || '');
      case 'memory_write': return 'remember: ' + String(a.fact || a.value || '').slice(0, 80);
      case 'name_session': return 'title: ' + (a.name || '');
      // r (result) only exists once persisted; live, only a.winner/a.tried/a.planned (see app.tsx's recordRoute) are known yet — both read the same way.
      case 'route': { const n = (r && r.attempts && r.attempts.length) || a.tried || 0; const tot = (r && r.plan && r.plan.length) || a.planned || n; const win = (r && r.winner) || a.winner; return (win ? 'routed → ' + win : 'routing exhausted') + ' (' + n + '/' + tot + ' tried' + (a.model ? ', ' + a.model : '') + ')'; }
      // Model calls previously rendered as an inert "model call N/14" with nothing to expand (no \`.tool\`
      // on the progress event at all — see app.tsx's PassMeter.recordModelCall). Now a real tool row: this
      // is the collapsed-row summary; the expanded request/response panes come from the generic branch in
      // row() below, same as every other tool.
      case 'model': {
        if (!r) return (a.label ? a.label + ': ' : '') + (ev.error ? 'failed before responding: ' + (a.model || 'auto') : 'calling ' + (a.model || 'auto') + '…');
        const who = r.provider ? r.provider.split('/').pop() : (r.model || '?');
        const fin = r.finishReason && r.finishReason !== 'stop' ? ' [' + r.finishReason + ']' : '';
        const tc = r.toolCalls && r.toolCalls.length ? ' · ' + r.toolCalls.length + ' tool call' + (r.toolCalls.length > 1 ? 's' : '') : '';
        const tok = r.tokensOut != null ? ' · ' + r.tokensOut + ' out' : '';
        return (a.label ? a.label + ': ' : '') + who + fin + tc + tok;
      }
      default: return ev.tool + ' ' + short(a).slice(0, 80);
    }
  }
  // The routing flowchart itself: plan order as a chain of nodes, colored by what actually happened to each
  // (untried/skipped/failed/ok), the winner starred. Built once per route event, not re-derived on every render.
  function routeFlow(result) {
    const wrap = document.createElement('div');
    const h = document.createElement('h5'); h.textContent = 'routing — ' + ((result.attempts || []).length) + ' tried of ' + ((result.plan || []).length || (result.attempts || []).length) + ' planned';
    wrap.appendChild(h);
    const flow = document.createElement('div'); flow.className = 'tl-route';
    const byName = new Map();
    (result.attempts || []).forEach((a) => { if (!byName.has(a.provider)) byName.set(a.provider, []); byName.get(a.provider).push(a); });
    const plan = (result.plan && result.plan.length) ? result.plan : [...byName.keys()];
    plan.forEach((name, i) => {
      if (i) { const arrow = document.createElement('span'); arrow.className = 'tl-arrow'; arrow.textContent = '→'; flow.appendChild(arrow); }
      const tries = byName.get(name) || [];
      const last = tries[tries.length - 1];
      const n = document.createElement('span');
      const cls = !last ? 'untried' : last.ok ? 'ok' : last.skipped ? 'skipped' : 'failed';
      n.className = 'tl-rn ' + cls + (last && last.demoted ? ' demoted' : '');
      const isWinner = result.winner && name === result.winner && last && last.ok;
      n.textContent = name + (tries.length > 1 ? ' ×' + tries.length : '') + (isWinner ? ' ★' : '') + (last && last.demoted ? ' ↓' : '');
      if (last) n.title = (last.demoted ? '[demoted: config-dead, tried last] ' : '') + (last.ok ? 'ok' : (last.error || 'skipped')) + (last.latencyMs ? ' · ' + last.latencyMs + 'ms' : '') + (last.timeoutMs ? ' · budget ' + Math.round(last.timeoutMs / 1000) + 's' : '');
      flow.appendChild(n);
    });
    wrap.appendChild(flow);
    wrap.appendChild(pane('raw attempts', result.attempts || []));
    return wrap;
  }
  function stageText(ev) {
    if (ev.type === 'pass') return 'model call ' + ev.n + '/' + ev.of + (typeof ev.leftMs === 'number' ? ' · budget ' + (ev.leftMs / 1000).toFixed(1) + 's left' : '');
    if (ev.type === 'continue') return 'reply cut at the vendor cap after ' + (ev.chars ? ev.chars.toLocaleString() + ' chars' : 'a partial reply') + ' — continuing (' + ev.n + ')' + (ev.tail ? '\n…' + ev.tail : '');
    if (ev.type === 'retry') return 'retry ' + ev.n + (ev.error ? ' — ' + ev.error : '');
    if (ev.type === 'thinking') return 'thinking…';
    return ev.label || ev.text || ev.type;
  }
  function summary(events) {
    const tools = events.filter(e => e.tool && e.tool !== 'route' && e.tool !== 'model');
    const errs = tools.filter(e => e.error && e.error !== 'repeated').length;
    const parts = [tools.length + ' tool' + (tools.length === 1 ? '' : 's')];
    const files = tools.filter(e => /artifact/.test(e.tool) && !e.error).length; if (files) parts.push(files + ' artifact op' + (files > 1 ? 's' : ''));
    if (errs) parts.push(errs + ' failed');
    const routes = events.filter(e => e.tool === 'route'); if (routes.length) { const ex = routes.filter(e => e.error).length; parts.push(routes.length + ' route' + (routes.length > 1 ? 's' : '') + (ex ? ' (' + ex + ' exhausted)' : '')); }
    const models = events.filter(e => e.tool === 'model'); if (models.length) { const ex = models.filter(e => e.error).length; parts.push(models.length + ' model call' + (models.length > 1 ? 's' : '') + (ex ? ' (' + ex + ' flagged)' : '')); }
    const conts = events.filter(e => e.type === 'continue').length; if (conts) parts.push(conts + ' continued');
    const retries = events.filter(e => e.type === 'retry').length; if (retries) parts.push(retries + ' retr' + (retries > 1 ? 'ies' : 'y'));
    return parts.join(' · ');
  }
  function pane(title, value) {
    const s = pretty(value), cut = s.length > 4000;
    const wrap = document.createElement('div');
    const h = document.createElement('h5'); h.innerHTML = esc(title) + (s ? ' <button title="copy">copy</button>' : '');
    const pre = document.createElement('pre'); pre.textContent = cut ? s.slice(0, 4000) + '\n…' : s;
    wrap.appendChild(h); wrap.appendChild(pre);
    if (h.querySelector('button')) h.querySelector('button').onclick = (e) => { e.stopPropagation(); navigator.clipboard.writeText(s); h.querySelector('button').textContent = 'copied'; };
    if (cut) { const m = document.createElement('span'); m.className = 'tl-more'; m.textContent = 'show all ' + s.length.toLocaleString() + ' chars'; m.onclick = (e) => { e.stopPropagation(); pre.textContent = s; pre.classList.add('full'); m.remove(); }; wrap.appendChild(m); }
    return wrap;
  }
  // status vocabulary: waiting · running · done · failed · repeated · skipped
  function statusOf(ev, isLast, live) {
    if (ev.tool) return ev.error === 'repeated' || (ev.result && ev.result.repeated) ? 'repeated' : ev.error ? 'failed' : 'done';
    if (ev.type === 'retry') return 'failed';
    return live && isLast ? 'running' : 'done';
  }
  function row(ev, status) {
    const isRoute = ev.tool === 'route';
    const r = document.createElement('div'); r.className = 'tl-row st-' + status; r.dataset.kind = isRoute ? 'route' : ev.tool ? 'tool' : 'step';
    const k = document.createElement('span'); k.className = 'tl-k'; k.textContent = ev.tool ? (LABEL[ev.tool] || ev.tool.replace(/^rojs_/, 'rojs ').slice(0, 10)) : (ev.type === 'pass' ? 'model' : ev.type === 'stage' ? 'step' : ev.type);
    const d = document.createElement('span'); d.className = 'tl-d'; d.textContent = ev.tool ? desc(ev) + (!isRoute && ev.error && ev.error !== 'repeated' ? ' — ' + ev.error : '') : stageText(ev);
    const st = document.createElement('span'); st.className = 'tl-st'; st.textContent = status;
    const isModel = ev.tool === 'model';
    const t = document.createElement('span'); t.className = 'tl-t'; t.textContent = ev.ms ? (ev.ms / 1000).toFixed(1) + 's' : (ev.result && ev.result.latencyMs) ? (ev.result.latencyMs / 1000).toFixed(1) + 's' : ev.hop != null && ev.tool && !isRoute && !isModel ? 'hop ' + (ev.hop + 1) : '';
    r.appendChild(k); r.appendChild(d); r.appendChild(st); r.appendChild(t);
    if (!ev.tool) return [r];
    const x = document.createElement('div'); x.className = 'tl-x';
    if (isRoute) {
      x.appendChild(routeFlow(ev.result || {}));
    } else {
      x.appendChild(pane('request · ' + ev.tool, ev.args)); x.appendChild(pane(ev.error && ev.error !== 'repeated' ? 'error' : 'response', ev.error && ev.error !== 'repeated' ? ev.error : ev.result));
    }
    r.onclick = () => r.classList.toggle('open');
    return [r, x];
  }
  /** Build a timeline. Rendering is INCREMENTAL: rows already on screen are kept (so an expanded row stays expanded
   *  while live events stream in); only new events are appended and the previous last step is re-labelled done.
   *  opts.live: expanded, elapsed clock, checklist of planned stages (opts.plan: ['plan','answer','verify']). */
  function make(events, opts = {}) {
    const root = document.createElement('div'); root.className = 'tl' + (opts.live ? ' live open' : (opts.open ? ' open' : ''));
    const h = document.createElement('div'); h.className = 'tl-h';
    const sum = document.createElement('span'); sum.className = 'tl-sum'; const clock = document.createElement('span'); clock.className = 'tl-n';
    h.appendChild(sum); h.appendChild(clock); h.onclick = () => root.classList.toggle('open');
    const body = document.createElement('div'); body.className = 'tl-body';
    let plan = null;
    if (opts.live && opts.plan && opts.plan.length) { plan = document.createElement('div'); plan.className = 'tl-plan'; plan.innerHTML = opts.plan.map(p => '<span class="tl-pl st-waiting" data-p="' + esc(p) + '">' + esc(p) + '</span>').join(''); root.appendChild(plan); }
    root.appendChild(h); root.appendChild(body);
    const t0 = Date.now(); let rendered = 0, lastStepRow = null, timer = null;
    const api = {
      root, events: [],
      set(evs) {
        api.events = evs;
        if (evs.length < rendered) { body.innerHTML = ''; rendered = 0; lastStepRow = null; } // not append-only: rebuild
        for (let i = rendered; i < evs.length; i++) {
          const ev = evs[i]; if (ev.type === 'thinking') continue;
          if (lastStepRow) { lastStepRow.classList.remove('st-running'); lastStepRow.classList.add('st-done'); lastStepRow.querySelector('.tl-st').textContent = 'done'; lastStepRow = null; }
          const status = statusOf(ev, i === evs.length - 1, !!opts.live);
          const els = row(ev, status); for (const el of els) body.appendChild(el);
          if (status === 'running') lastStepRow = els[0];
          if (plan && ev.type === 'stage') { const key = String(ev.label || '').toLowerCase(); plan.querySelectorAll('.tl-pl').forEach(pl => { const p = pl.dataset.p; if (key.startsWith(p) || (p === 'answer' && /answer|summar/.test(key)) || (p === 'plan' && key.startsWith('plan')) || (p === 'verify' && key.startsWith('verif'))) { plan.querySelectorAll('.tl-pl.st-running').forEach(o => { o.className = 'tl-pl st-done'; }); pl.className = 'tl-pl st-running'; } }); }
        }
        rendered = evs.length;
        const now = evs.filter(e => e.type !== 'thinking').slice(-1)[0];
        sum.textContent = opts.live ? ((opts.label || 'working') + (now ? ' · now: ' + (now.tool ? desc(now) : stageText(now)) : '') + ' · ' + summary(evs)) : summary(evs);
        if (!opts.live) clock.textContent = evs.length ? evs.length + ' step' + (evs.length > 1 ? 's' : '') : '';
      },
      label(l) { opts.label = l; api.set(api.events); },
      finish(ok) { clearInterval(timer); if (lastStepRow) { lastStepRow.classList.remove('st-running'); lastStepRow.classList.add(ok ? 'st-done' : 'st-failed'); lastStepRow.querySelector('.tl-st').textContent = ok ? 'done' : 'failed'; } if (plan) plan.querySelectorAll('.tl-pl').forEach(pl => { if (pl.classList.contains('st-running')) pl.className = 'tl-pl ' + (ok ? 'st-done' : 'st-failed'); else if (pl.classList.contains('st-waiting')) pl.className = 'tl-pl st-skipped'; }); },
    };
    if (opts.live) timer = setInterval(() => { clock.textContent = Math.round((Date.now() - t0) / 1000) + 's'; }, 1000);
    api.set(events || []);
    return api;
  }
  return { make, summary, desc };
})();
window.TL = TL;
`;
