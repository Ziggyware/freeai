// SCHEDULED-BUILD DRIVER (client half of the step queue).
//
// app-swarm.ts says it in its own comment: "GET ?build_status&job=<id> -> runs a tick, THEN reports. The
// poll IS the engine." Nothing polled it. main-script.ts had no reference to `scheduled` or `build_status`
// anywhere, so a chat turn that scheduled a build printed "poll ?build_status&job=… to continue it" and
// then sat there: after the one short tick inside the request that created it, the queue only moved if the
// interval val happened to be deployed, at a one-minute cadence, invisibly. From the user's seat the
// system did not schedule anything at all - which is exactly what was reported.
//
// This drives it: poll after poll, each one claiming and running whatever steps fit in its budget, with
// the progress rendered in the chat as it happens. Claims are atomic conditional UPDATEs server-side, so
// this racing the interval val (or a second tab) cannot run the same step twice.
//
// A polling loop that cannot stop is worse than no polling loop, so every exit is explicit and named:
// complete, queue drained, stalled, too many polls, too many transport errors, cancelled, session changed.
//
// Lives in its own file because main-script.ts is at Val Town's 80,000-character ceiling. Classic scripts
// share one global lexical scope, so this tag - emitted after main-script's in main-html.tsx - sees
// addMsg/fetchT/wait/currentSession and main-script sees BUILD. There is no module boundary to cross.
export const buildScript: string = String.raw`
const BUILD = (() => {
  const KEY = 'omni.job.';        // localStorage: one in-flight job id per session, so a reload resumes it
  const MAX_POLLS = 40;           // ~40s of server work each: a ceiling of roughly 25 minutes per job
  const STALL_POLLS = 4;          // consecutive polls with no new file and nothing running = stalled
  const MAX_ERRS = 3;             // consecutive transport failures before giving up
  const DIM = 'color:var(--dim);font-size:11px';
  let run = null;                 // { job, session, cancelled } for the one active drive

  const remember = (s, j) => { try { if (j) localStorage.setItem(KEY + s, j); else localStorage.removeItem(KEY + s); } catch (e) { /* private mode */ } };
  const savedJob = (s) => { try { return localStorage.getItem(KEY + s); } catch (e) { return null; } };
  const visible = (s) => window.currentSession === s;

  /** The live card. One per drive, updated in place - never a new message per poll. */
  function makeCard(job) {
    const w = document.createElement('div');
    w.className = 'msg-wrap sys';
    const head = document.createElement('div');
    head.innerHTML = '<div class="msg-label"><span class="role-tag">BUILD</span><span class="msg-ts">' + ts() + '</span></div>';
    const status = document.createElement('div'); status.style.cssText = 'font-size:12px;margin:2px 0 6px';
    const files = document.createElement('div'); files.style.cssText = 'display:grid;grid-template-columns:1fr auto;gap:2px 10px;' + DIM;
    const note = document.createElement('div'); note.style.cssText = DIM + ';margin-top:6px;white-space:pre-wrap';
    // The conformance verdict gets its own line, above the file rows and not in the dim style: a build
    // that is 12/12 complete and built the wrong thing is the failure being reported, and it is invisible
    // if it renders like a footnote.
    const drift = document.createElement('div'); drift.style.cssText = 'font-size:12px;margin:0 0 6px;white-space:pre-wrap';
    const stopBtn = document.createElement('button');
    stopBtn.className = 'act-btn'; stopBtn.textContent = 'stop'; stopBtn.style.marginTop = '6px';
    stopBtn.onclick = () => { if (run && run.job === job) run.cancelled = true; stopBtn.remove(); };
    w.appendChild(head); w.appendChild(status); w.appendChild(drift); w.appendChild(files); w.appendChild(note); w.appendChild(stopBtn);
    chat.insertBefore(w, typing); chat.scrollTop = chat.scrollHeight;
    return {
      set(p, label) {
        const built = Number(p.builtFiles || 0), planned = Number(p.plannedFiles || 0);
        const waiting = Number(p.blocked || 0);
        status.textContent = (p.title || 'build') + ' — ' + built + '/' + planned + ' files · ' + label
          + (waiting ? ' · ' + waiting + ' waiting on something' : '');
        const c = p.conform;
        if (!c) { drift.textContent = ''; }
        else if (c.matches) { drift.textContent = 'matches your request: ' + (c.built || ''); drift.style.color = 'inherit'; }
        else {
          drift.style.color = 'var(--bad, inherit)';
          drift.textContent = 'THIS IS NOT WHAT YOU ASKED FOR.\nIt built: ' + (c.built || '(unclear)')
            + (c.mismatches && c.mismatches.length ? '\nMissing or replaced:\n' + c.mismatches.map(function (m) { return '• ' + m; }).join('\n') : '')
            + (c.extra && c.extra.length ? '\nBuilt without being asked:\n' + c.extra.map(function (m) { return '• ' + m; }).join('\n') : '');
        }
        // TASKS, not just files. A file row says "queued" whether the task is next up or blocked behind
        // four others; the task graph says which, and that is the difference between a progress bar and
        // an explanation. Falls back to the file rows when an older server does not send tasks.
        const rows = (p.tasks && p.tasks.length)
          ? p.tasks.map(function (t) {
              return {
                path: t.label,
                status: t.status + (t.ms != null ? ' · ' + (t.ms / 1000).toFixed(1) + 's' : ''),
                error: t.blockedBy || t.error,
              };
            })
          : (p.files || []);
        files.innerHTML = '';
        for (const f of rows) {
          const a = document.createElement('div'); a.textContent = f.path || '(unnamed)';
          const b = document.createElement('div');
          b.textContent = f.status + (f.error ? ' — ' + String(f.error).slice(0, 60) : '');
          b.style.color = f.status === 'done' ? 'var(--ok, inherit)' : (f.status === 'failed' || f.status === 'blocked') ? 'var(--bad, inherit)' : 'inherit';
          files.appendChild(a); files.appendChild(b);
        }
      },
      end(text) { note.textContent = text; stopBtn.remove(); },
    };
  }

  /** Poll ?build_status until the job reaches a terminal state. Returns the reason it stopped. */
  async function drive(job, session) {
    if (!job) return 'no job';
    if (run && !run.cancelled && run.job === job) return 'already driving';   // one driver per job
    if (run) run.cancelled = true;                                            // a new job supersedes the old
    run = { job: job, session: session, cancelled: false };
    const me = run;
    remember(session, job);
    const card = visible(session) ? makeCard(job) : null;
    let errs = 0, stall = 0, lastBuilt = -1, last = null, reason = 'unknown';
    for (let poll = 1; poll <= MAX_POLLS; poll++) {
      if (me.cancelled) { reason = 'stopped'; break; }
      if (!visible(session) && window.currentSession !== session) { /* keep driving: the job is the session's, not the view's */ }
      if (card) card.set(last || { title: '', files: [] }, 'polling ' + poll + '/' + MAX_POLLS);
      if (visible(session)) { barStatus.textContent = 'building — poll ' + poll; tabProgress('build ' + poll); }
      let p = null;
      try {
        const r = await fetchT('?build_status&job=' + encodeURIComponent(job), {}, 60000);
        p = await r.json();
        if (p && p.error) throw new Error(p.error.message || 'build_status failed');
        errs = 0;
      } catch (e) {
        errs++;
        if (errs >= MAX_ERRS) { reason = 'the server stopped answering: ' + String(e.message || e).slice(0, 120); break; }
        await wait(3000);
        continue;
      }
      last = p;
      if (card) card.set(p, p.done ? 'queue drained' : 'running');
      if (p.artifactId && typeof ART !== 'undefined' && visible(session)) { ART.listForSession(session); if (ART.current() && ART.current().id === p.artifactId) ART.refresh(p.artifactId); }
      // Stopping on p.complete ALONE would stop before the verdict exists: conform is the last step in
      // the graph and every planned file is already written by the time it is claimed. Wait for it.
      if (p.complete && p.conform) {
        // "complete" is a statement about the FILE LIST. If the judge says the file list was the wrong
        // file list, reporting "complete" and nothing else is how a wrong build gets accepted.
        reason = p.conform.matches === false
          ? 'built ' + p.builtFiles + '/' + p.plannedFiles + ' files, but it does not match your request — see above'
          : 'complete: ' + p.builtFiles + '/' + p.plannedFiles + ' files, and it matches your request';
        break;
      }
      if (p.done) {
        // The queue drained without the artifact being complete. That is a real outcome, not a reason to
        // keep polling an empty queue - say what is missing and stop.
        reason = (p.complete && !p.conform)
          ? 'every planned file was written, but the check against your original request did not run — treat "complete" as "the file list is finished", not as "this is what you asked for"'
          : 'the queue drained with ' + (p.missing || []).length + ' file(s) still missing'
            + ((p.missing || []).length ? ':\n' + p.missing.map((m) => '• ' + m).join('\n') : '')
            + (p.failedSteps ? '\n' + p.failedSteps + ' step(s) failed or were blocked' : '');
        break;
      }
      const built = Number(p.builtFiles || 0);
      stall = built > lastBuilt ? 0 : stall + 1;
      lastBuilt = Math.max(lastBuilt, built);
      if (stall >= STALL_POLLS) { reason = 'no file finished in ' + STALL_POLLS + ' consecutive polls — stopping so this does not spin'; break; }
      if (poll === MAX_POLLS) reason = 'poll limit (' + MAX_POLLS + ') reached — the job is still queued and resumes if you ask again';
    }
    if (me === run) run = null;
    remember(session, null);
    if (card) card.end(reason);
    if (visible(session)) { barStatus.textContent = reason.split('\n')[0]; tabProgress(''); }
    return reason;
  }

  /** Called on load and on every session switch: pick up a job this browser left in flight. */
  async function resume(session) {
    const job = savedJob(session);
    if (!job) return null;
    return drive(job, session);
  }

  return {
    drive: drive,
    resume: resume,
    stop: () => { if (run) run.cancelled = true; },
    active: () => (run ? run.job : null),
  };
})();
document.addEventListener('omni:session', (e) => { BUILD.stop(); BUILD.resume(e.detail && e.detail.id); });
BUILD.resume(window.currentSession);
`;
