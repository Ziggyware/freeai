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
// IT DOES NOT STOP UNTIL THE JOB SAYS IT IS SETTLED. The first version stopped on `done` — "nothing is
// ready or running" — which is not the same question as "the work is finished". For a repair the queue
// routinely drains BETWEEN rounds (round 1's builds are done, round 2's diagnose has not been claimed
// yet), so a driver that stopped on `done` abandoned the repair mid-flight and reported "queue drained"
// while the reported error was still in the file. The server now publishes `settled` (resolved, stopped,
// exhausted, or — for a build — drained), and that is the only terminal condition the loop honours.
//
// Lives in its own file because main-script.ts is at Val Town's 80,000-character ceiling. Classic scripts
// share one global lexical scope, so this tag - emitted after main-script's in main-html.tsx - sees
// addMsg/fetchT/wait/currentSession and main-script sees BUILD. There is no module boundary to cross.
export const buildScript: string = String.raw`
const BUILD = (() => {
  const KEY = 'omni.job.';        // localStorage: one in-flight job id per session, so a reload resumes it
  const MAX_POLLS = 240;          // ~40s of server work each: a ceiling of roughly two and a half hours
  const STALL_POLLS = 6;          // consecutive polls with nothing moving and nothing running = stalled
  const MAX_ERRS = 3;             // consecutive transport failures before giving up
  const DIM = 'color:var(--dim);font-size:11px';
  // ONE DRIVER PER JOB, NOT ONE PER BROWSER. A running job is driven by a poll loop, and a loop that
  // stops because the user opened another chat is a loop that stops working for no reason: the job is
  // per-session, the DOM writes are gated on `visible(session)`, so several loops can coexist and each
  // keeps its own session's work moving. `runs[job]` is also the anti-double-drive guard.
  const runs = {};                // job -> { job, session, cancelled, stopped }

  const remember = (s, j) => { try { if (j) localStorage.setItem(KEY + s, j); else localStorage.removeItem(KEY + s); } catch (e) { /* private mode */ } };
  const savedJob = (s) => { try { return localStorage.getItem(KEY + s); } catch (e) { return null; } };
  const visible = (s) => window.currentSession === s;
  const line = (arr) => (arr || []).map(function (x) { return '\u2022 ' + x; }).join('\n');

  /** Ask the SERVER to stop the job. The old stop button only stopped this loop, so the cron kept running
   *  the queue and a "stopped" repair kept writing files. */
  async function cancelOnServer(job) {
    try { await fetchT('?build_cancel&job=' + encodeURIComponent(job), { method: 'POST' }, 15000); }
    catch (e) { /* the loop still stops locally; the next poll would have told us it is stopped anyway */ }
  }

  /** The live card. One per drive, updated in place - never a new message per poll. */
  function makeCard(job) {
    const w = document.createElement('div');
    w.className = 'msg-wrap sys';
    const head = document.createElement('div');
    head.innerHTML = '<div class="msg-label"><span class="role-tag">BUILD</span><span class="msg-ts">' + ts() + '</span></div>';
    const status = document.createElement('div'); status.style.cssText = 'font-size:12px;margin:2px 0 6px';
    const goal = document.createElement('div'); goal.style.cssText = DIM + ';margin:0 0 6px;white-space:pre-wrap';
    const files = document.createElement('div'); files.style.cssText = 'display:grid;grid-template-columns:1fr auto;gap:2px 10px;' + DIM;
    const note = document.createElement('div'); note.style.cssText = DIM + ';margin-top:6px;white-space:pre-wrap';
    // The verdict gets its own line, above the file rows and not in the dim style: a job that is 12/12
    // complete and still broken is the failure being reported, and it is invisible as a footnote.
    const drift = document.createElement('div'); drift.style.cssText = 'font-size:12px;margin:0 0 6px;white-space:pre-wrap';
    const stopBtn = document.createElement('button');
    stopBtn.className = 'act-btn'; stopBtn.textContent = 'stop'; stopBtn.style.marginTop = '6px';
    stopBtn.onclick = () => {
      const me = runs[job];
      if (me) { me.stopped = true; me.cancelled = true; }
      stopBtn.textContent = 'stopping…'; stopBtn.disabled = true;
      cancelOnServer(job).then(function () { stopBtn.remove(); });
    };
    w.appendChild(head); w.appendChild(status); w.appendChild(goal); w.appendChild(drift); w.appendChild(files); w.appendChild(note); w.appendChild(stopBtn);
    chat.insertBefore(w, typing); chat.scrollTop = chat.scrollHeight;
    return {
      set(p, label) {
        const built = Number(p.builtFiles || 0), planned = Number(p.plannedFiles || 0);
        const waiting = Number(p.blocked || 0);
        const isRepair = p.kind === 'repair';
        const round = (isRepair && p.rounds != null) ? ' \u00b7 round ' + p.rounds + (p.maxRounds ? '/' + p.maxRounds : '') : '';
        status.textContent = (p.title || (isRepair ? 'repair' : 'build')) + ' \u2014 ' + built + '/' + planned + (isRepair ? ' file(s) fixed' : ' files')
          + ' \u00b7 ' + label + round
          + (waiting ? ' \u00b7 ' + waiting + ' waiting on something' : '');
        goal.textContent = p.goal ? (isRepair ? 'fixing: ' : 'asked for: ') + p.goal : '';
        const c = p.conform;
        const fixed = isRepair && p.resolved;
        if (fixed) { drift.style.color = 'var(--ok, inherit)'; drift.textContent = 'FIXED' + (p.whatWasWrong ? '\n' + p.whatWasWrong : ''); }
        else if (isRepair && p.stopped) { drift.style.color = 'inherit'; drift.textContent = 'stopped \u2014 nothing further will run'; }
        else if (isRepair && (p.unresolved || []).length) { drift.style.color = 'var(--bad, inherit)'; drift.textContent = 'still broken after round ' + (p.rounds || 0) + ':\n' + line(p.unresolved); }
        else if (!c) { drift.textContent = ''; }
        else if (c.matches) { drift.textContent = 'matches your request: ' + (c.built || ''); drift.style.color = 'inherit'; }
        else {
          drift.style.color = 'var(--bad, inherit)';
          drift.textContent = 'THIS IS NOT WHAT YOU ASKED FOR.\nIt built: ' + (c.built || '(unclear)')
            + (c.mismatches && c.mismatches.length ? '\nMissing or replaced:\n' + line(c.mismatches) : '')
            + (c.extra && c.extra.length ? '\nBuilt without being asked:\n' + line(c.extra) : '');
        }
        // TASKS, not just files. A file row says "queued" whether the task is next up or blocked behind
        // four others; the task graph says which, and that is the difference between a progress bar and
        // an explanation. Falls back to the file rows when an older server does not send tasks.
        // FOR A REPAIR, THE ROWS ARE THE REPAIR'S TARGETS - not every build step the job ever had. The job
        // id is shared with the artifact's original build, so `p.files` is mostly history; a card that lists
        // twelve files while correcting one is the reason a user cannot tell what is being fixed. The status
        // shown per target is the LATEST step for that path (a later round overwrites an earlier attempt).
        let rows = (p.tasks && p.tasks.length)
          ? p.tasks.map(function (t) {
              return {
                path: t.label,
                status: t.status + (t.ms != null ? ' \u00b7 ' + (t.ms / 1000).toFixed(1) + 's' : ''),
                error: t.blockedBy || t.error,
              };
            })
          : (p.files || []);
        if (isRepair && (p.targets || []).length) {
          const latest = {};
          for (const f of (p.files || [])) if (f && f.path) latest[f.path] = f;
          const unresolved = p.unresolved || [];
          rows = p.targets.map(function (path) {
            const f = latest[path];
            const st = f ? f.status : 'queued';
            const bad = unresolved.indexOf(path) >= 0 && (p.done || p.settled);
            return {
              path: path,
              status: (p.rounds ? 'round ' + p.rounds + ' \u00b7 ' : '') + (bad ? 'still broken' : st === 'done' ? 'edited' : st),
              error: f ? f.error : null,
            };
          });
        }
        files.innerHTML = '';
        for (const f of rows) {
          const a = document.createElement('div'); a.textContent = f.path || '(unnamed)';
          const b = document.createElement('div');
          b.textContent = f.status + (f.error ? ' \u2014 ' + String(f.error).slice(0, 60) : '');
          b.style.color = f.status === 'done' ? 'var(--ok, inherit)' : (f.status === 'failed' || f.status === 'blocked') ? 'var(--bad, inherit)' : 'inherit';
          files.appendChild(a); files.appendChild(b);
        }
      },
      end(text) { note.textContent = text; stopBtn.remove(); },
      stop() { stopBtn.remove(); },
    };
  }

  /** Poll ?build_status until the job is SETTLED. Returns the reason it stopped. */
  async function drive(job, session) {
    if (!job) return 'no job';
    if (runs[job] && !runs[job].cancelled) return 'already driving';   // one driver per job
    const me = runs[job] = { job: job, session: session, cancelled: false, stopped: false };
    remember(session, job);
    const card = visible(session) ? makeCard(job) : null;
    let errs = 0, stall = 0, lastActivity = '', last = null, polls = 0, idleRounds = 0, reason = 'unknown';
    for (polls = 1; polls <= MAX_POLLS; polls++) {
      if (me.cancelled) { reason = me.stopped ? 'stopped \u2014 the server-side queue was cancelled too' : 'stopped'; break; }
      if (card) card.set(last || { title: '', files: [] }, 'polling ' + polls + '/' + MAX_POLLS);
      if (visible(session)) { barStatus.textContent = 'building \u2014 poll ' + polls; tabProgress('build ' + polls); }
      let p = null;
      try {
        const r = await fetchT('?build_status&job=' + encodeURIComponent(job), {}, 60000);
        p = await r.json();
        if (p && p.error) throw new Error(p.error.message || 'build_status failed');
        errs = 0;
      } catch (e) {
        if (me.cancelled) { reason = 'stopped'; break; }
        errs++;
        if (errs >= MAX_ERRS) { reason = 'the server stopped answering: ' + String(e.message || e).slice(0, 120); break; }
        await wait(3000);
        continue;
      }
      last = p;
      if (card) card.set(p, p.stopped ? 'stopped' : p.resolved ? 'fixed' : p.done ? 'between rounds' : 'running');
      if (p.artifactId && typeof ART !== 'undefined' && visible(session)) { ART.listForSession(session); if (ART.current() && ART.current().id === p.artifactId) ART.refresh(p.artifactId); }
      const isRepair = p.kind === 'repair';
      // ── TERMINAL STATES, AS THE SERVER DEFINES THEM ──────────────────────────────────────────────
      // `settled` is the server's answer to "will anything else happen?" — resolved, stopped, exhausted,
      // or (for a build) the queue drained. `done` alone means "nothing is running RIGHT NOW", which is
      // exactly the state a repair sits in between rounds, so it is never sufficient on its own.
      if (p.stopped) { reason = 'stopped \u2014 nothing further will run'; break; }
      if (isRepair && p.resolved) {
        // WHAT ACTUALLY HAPPENED, not what we hope: the server can prove the target files CHANGED and that
        // the static lint no longer names them. It cannot re-observe the browser's runtime error, so the
        // card says exactly that instead of claiming the console is clean.
        reason = 'repaired \u2014 ' + (p.whatWasWrong || 'the target changed and its static defects are gone');
        if (typeof addSysCard === 'function') addSysCard('FIXED', 'artifact #' + (p.artifactId || '?') + ' \u2014 ' + (p.primary || 'the reported file') + ' repaired' + ((p.tried || []).length ? ' (' + p.tried.length + ' file(s) edited)' : '') + (p.whatWasWrong ? '\n' + p.whatWasWrong : '') + '\nreload the preview to confirm the console is clean.');
        break;
      }
      if (isRepair && (p.outcome === 'exhausted' || p.outcome === 'budget')) {
        reason = 'could not fix it in ' + (p.rounds != null ? p.rounds : '?') + ' round(s)'
          + ((p.unresolved || []).length ? ' \u2014 still broken: ' + p.unresolved.join(', ') : '');
        break;
      }
      if (!isRepair && p.complete && p.conform) {
        reason = p.conform.matches === false
          ? 'built ' + p.builtFiles + '/' + p.plannedFiles + ' files, but it does not match your request \u2014 see above'
          : 'complete: ' + p.builtFiles + '/' + p.plannedFiles + ' files, and it matches your request';
        break;
      }
      if (p.settled) {
        reason = isRepair
          ? 'the repair job ended without resolving the reported failure' + ((p.unresolved || []).length ? ': ' + p.unresolved.join(', ') : '')
          : (p.complete && !p.conform)
            ? 'every planned file was written, but the check against your original request did not run \u2014 treat "complete" as "the file list is finished", not as "this is what you asked for"'
            : 'the queue drained with ' + (p.missing || []).length + ' file(s) still missing'
              + ((p.missing || []).length ? ':\n' + line(p.missing) : '')
              + (p.failedSteps ? '\n' + p.failedSteps + ' step(s) failed or were blocked' : '');
        break;
      }
      // NOT SETTLED: a repair between rounds, or work still queued. Keep polling — the next poll IS the
      // engine that runs the next round — and only call it stalled when nothing moved AND nothing ran.
      // PROGRESS IS THE STEP GRAPH MOVING, not one counter going up. `builtFiles` counts what exists on
      // disk, so during a SECOND round of a one-file repair it is already 1 and stays 1 for the whole
      // round - which made an actively running repair look stalled. The activity string folds in the
      // round, the per-status step counts and the file count: any step claimed, finishing or failing
      // changes it, and a genuinely frozen job changes nothing.
      const built = Number(p.builtFiles || 0);
      const by = p.by || {};
      const activity = built + '|' + (p.rounds || 0) + '|' + JSON.stringify(by);
      stall = activity !== lastActivity ? 0 : stall + 1;
      lastActivity = activity;
      // BETWEEN ROUNDS is the one state where "nothing is running" is expected: round N's builds are done
      // and the server is about to queue round N+1. It is exempt from the stall guard, but only while
      // rounds remain and only for a bounded number of polls \u2014 otherwise a job whose loop died without
      // reporting it would be polled forever.
      const betweenRounds = isRepair && p.done && !p.settled && (p.rounds == null || p.maxRounds == null || p.rounds < p.maxRounds);
      if (betweenRounds) {
        idleRounds++;
        if (idleRounds > 8) { reason = 'no further repair round was queued in 8 polls \u2014 stopping so this does not spin'; break; }
      } else {
        idleRounds = 0;
      }
      // ...and never while the queue has work: `ready`/`running` steps are the definition of "something
      // is happening", so a job mid-step is only stopped for the transport/server failures handled above.
      const busy = Number(by.running || 0) + Number(by.ready || 0) > 0;
      if (!betweenRounds && !busy && stall >= STALL_POLLS) {
        reason = 'nothing moved in ' + STALL_POLLS + ' polls and nothing is queued or running \u2014 stopping so this does not spin';
        break;
      }
      if (polls === MAX_POLLS) reason = 'poll limit (' + MAX_POLLS + ') reached \u2014 the job is still queued and resumes if you ask again';
    }
    if (runs[job] === me) delete runs[job];
    // A FAILURE THE USER NEVER SAW IS REMEMBERED. `remember(session, null)` cleared the job id on every
    // exit, so a repair that gave up while the tab was on another session existed only in the log: it was
    // gone on reload and the session looked like nothing had ever been asked. When the card was rendered
    // the user has seen the outcome, so the key is cleared; when it was not, the key survives and
    // `resume()` re-reads the settled status and renders the final card the first time that session is
    // opened (then clears it).
    const unseenFailure = !card && /^(nothing moved|no further repair round|could not fix|the repair job ended|the server stopped answering|poll limit)/.test(reason);
    remember(session, unseenFailure ? job : null);
    if (card) card.end(reason);
    if (visible(session)) { barStatus.textContent = reason.split('\n')[0]; tabProgress(''); }
    return reason;
  }

  /** Called on load and on every session switch: pick up a job this browser left in flight.
   *
   *  Only for the session being opened — a stored job for a session that is not on screen waits until it
   *  is, because rendering its card into the visible chat would show one chat's build inside another. */
  async function resume(session) {
    if (!session || !visible(session)) return null;
    const job = savedJob(session);
    if (!job || runs[job]) return null;
    return drive(job, session);
  }

  return {
    drive: drive,
    resume: resume,
    /** Stop is a USER ACTION: it stops every loop and asks the server to stop the jobs for real. */
    stop: () => {
      const jobs = Object.keys(runs);
      for (const j of jobs) { runs[j].stopped = true; runs[j].cancelled = true; }
      for (const j of jobs) cancelOnServer(j);
      return jobs;
    },
    active: () => Object.keys(runs),
  };
})();
// NO BUILD.stop() HERE. Switching sessions used to cancel the driver - and `stop()` cancels the JOB on the
// server too, so opening another chat killed a repair the user never asked to stop. The loops are
// session-gated on every DOM write; they keep running, which is the whole promise of a background job.
document.addEventListener('omni:session', (e) => { BUILD.resume(e.detail && e.detail.id); });
BUILD.resume(window.currentSession);
`;
