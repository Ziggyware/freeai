// BRUTALIST MINIMALIST. One surface at a time; nothing on screen that is not actionable right now.
//
// The rules, and why each one is a rule rather than a taste:
//
//  · NO WEBFONT. The old sheet opened with an @import of two Google families — a render-blocking
//    third-party request before the first pixel, on an app whose whole premise is small quick
//    callbacks. System monospace is already on every machine, costs nothing, and never fails to load.
//  · NO RADIUS, NO SHADOW, NO GRADIENT. Structure is carried by 1px rules and by space. A border that
//    is also a corner radius and also a shadow is three encodings of one boundary.
//  · NO TRANSITION except where state genuinely takes time. Hover fades and slide-ins put 150-200ms
//    between an intent and its acknowledgement, on every interaction, forever. The only motion kept is
//    the caret blink and the working indicator, because both report that something IS happening.
//  · TWO INKS AND ONE SIGNAL. Foreground, dim, and a single accent. Errors get the accent's opposite.
//    A palette of nine greys is a palette nobody can hold in their head, so nothing reads as emphatic.
//  · UPPERCASE MICROLABELS, lowercase content. Hierarchy from letterspacing and weight, not size ramps.
//  · DENSITY BY GRID. Padding is 0 / 4 / 8 / 12 / 16 and nothing else.
//
// Both themes are real: `paper` is not an inversion filter, it is a second set of ink values chosen so
// hairlines stay visible against white, which an inversion does not guarantee.
export const style: string = `
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent;}
:root{
  --bg:#000;--s0:#0a0a0a;--s1:#111;--s2:#171717;--s3:#1f1f1f;
  --line:#2a2a2a;--line2:#3d3d3d;
  --text:#f2f2f2;--dim:#a0a0a0;--dim2:#6a6a6a;
  --acc:#ffffff;--acc2:#00ff9c;--err:#ff3b30;--warn:#ffb000;--inf:#a0a0a0;
  --mono:ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace;
  --sans:var(--mono);
  --r:0;--content-w:820px;--fs:13px;
}
html,body{height:100dvh;overflow:hidden;position:fixed;width:100%;background:var(--bg);}
body{font-family:var(--mono);color:var(--text);display:flex;font-size:12px;line-height:1.5;-webkit-font-smoothing:antialiased;}
button,input,textarea{font-family:inherit;font-size:inherit;color:inherit;border-radius:0;}
::-webkit-scrollbar{width:10px;height:10px;} ::-webkit-scrollbar-thumb{background:var(--line);border:3px solid var(--bg);} ::-webkit-scrollbar-thumb:hover{background:var(--line2);} ::-webkit-scrollbar-track{background:transparent;}
::selection{background:var(--acc2);color:#000;}
:focus-visible{outline:1px solid var(--acc2);outline-offset:1px;}

/* ── controls ─────────────────────────────────────────────────────────────── */
.ib{background:none;border:0;color:var(--dim);width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;}
.ib:hover{color:var(--bg);background:var(--acc);} .ib svg{width:14px;height:14px;}
.act-btn{background:none;border:1px solid var(--line2);color:var(--dim);font:inherit;font-size:10px;letter-spacing:.12em;text-transform:uppercase;padding:3px 8px;cursor:pointer;white-space:nowrap;}
.act-btn:hover{background:var(--acc);border-color:var(--acc);color:var(--bg);}
.act-btn.primary{border-color:var(--acc);color:var(--text);}
.act-btn:disabled{opacity:.3;cursor:default;} .act-btn:disabled:hover{background:none;color:var(--dim);border-color:var(--line2);}

/* ── sidebar ──────────────────────────────────────────────────────────────── */
#sidebar{width:232px;flex-shrink:0;background:var(--bg);border-right:1px solid var(--line);display:flex;flex-direction:column;}
#sidebar.collapsed{margin-left:-232px;}
#sb-hdr{display:flex;align-items:center;justify-content:space-between;padding:8px 8px 8px 12px;border-bottom:1px solid var(--line);}
.wordmark{font-size:10px;letter-spacing:.34em;text-transform:uppercase;color:var(--text);font-weight:500;}
#new-btn{margin:8px;display:flex;align-items:center;gap:8px;background:none;border:1px solid var(--line2);color:var(--dim);font:inherit;font-size:10px;letter-spacing:.12em;text-transform:uppercase;padding:6px 10px;cursor:pointer;}
#new-btn:hover{background:var(--acc);border-color:var(--acc);color:var(--bg);} #new-btn svg{width:11px;height:11px;}
#sessions{flex:1;overflow:auto;padding:0;}
.sess-row{display:flex;align-items:center;padding:5px 8px 5px 12px;cursor:pointer;color:var(--dim);font-size:11px;gap:6px;border-left:2px solid transparent;}
.sess-row:hover{background:var(--s1);color:var(--text);}
.sess-row.active{color:var(--text);background:var(--s1);border-left-color:var(--acc2);}
.sess-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.sess-del{background:none;border:0;color:var(--dim2);width:18px;height:18px;cursor:pointer;opacity:0;display:inline-flex;align-items:center;justify-content:center;}
.sess-row:hover .sess-del{opacity:1;} .sess-del:hover{color:var(--err);} .sess-del svg{width:10px;height:10px;}

/* ── shell ────────────────────────────────────────────────────────────────── */
#main{flex:1;display:flex;flex-direction:column;overflow:hidden;height:100dvh;min-width:0;}
#top{display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:1px solid var(--line);background:var(--bg);flex-shrink:0;}
#session-title{font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:var(--text);cursor:text;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;}
#session-title-input{display:none;flex:1;background:var(--bg);border:1px solid var(--acc2);color:var(--text);font:inherit;font-size:10px;letter-spacing:.2em;text-transform:uppercase;padding:2px 6px;outline:0;}
.modes{display:flex;border:1px solid var(--line2);}
.modes button{background:none;border:0;border-right:1px solid var(--line2);color:var(--dim2);font:inherit;font-size:10px;letter-spacing:.16em;text-transform:uppercase;padding:4px 12px;cursor:pointer;}
.modes button:last-child{border-right:0;}
.modes button.on{color:var(--bg);background:var(--acc);}
.modes button:hover:not(.on){color:var(--text);}
.modes button.has-update:not(.on){color:var(--acc2);}
.modes button.has-update::after{content:"*";margin-left:5px;color:var(--acc2);}
.pill{font-size:10px;letter-spacing:.1em;color:var(--dim);border:1px solid var(--line2);padding:3px 8px;cursor:pointer;white-space:nowrap;display:inline-flex;gap:6px;align-items:center;text-transform:uppercase;}
.pill:hover{border-color:var(--acc);color:var(--text);} .pill b{color:var(--text);font-weight:500;}
.pill .dot{width:5px;height:5px;background:var(--acc2);}
.pill.busy .dot{background:var(--warn);animation:blink 1s steps(2) infinite;}
.pill.err .dot{background:var(--err);}
@keyframes blink{50%{opacity:0}}
.view{display:none;flex:1;min-height:0;flex-direction:column;} .view.on{display:flex;}

/* ── chat ─────────────────────────────────────────────────────────────────── */
#chat-wrap{flex:1;position:relative;min-height:0;} #chat{height:100%;overflow-y:auto;padding:16px 16px 24px;}
#chat>.msg-wrap,#typing,#empty,.bar-inner,.bar-meta,#jobs{max-width:var(--content-w);margin-left:auto;margin-right:auto;width:100%;}
#empty{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;color:var(--dim2);gap:12px;}
.empty-mark{font-size:10px;letter-spacing:.34em;text-transform:uppercase;color:var(--dim2);}
#empty h3{font-family:var(--mono);font-weight:400;font-size:15px;letter-spacing:.06em;color:var(--dim);text-transform:uppercase;}
.hints{display:flex;gap:6px;flex-wrap:wrap;justify-content:center;margin-top:8px;}
.hint{border:1px solid var(--line);color:var(--dim);font-size:10px;padding:4px 10px;cursor:pointer;}
.hint:hover{background:var(--acc);border-color:var(--acc);color:var(--bg);}
.msg-wrap{padding:12px 0;border-bottom:1px solid var(--line);}
.msg-wrap:last-child{border-bottom:0;}
.msg-wrap.sys .role-tag{color:var(--warn);}
.msg-label{display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--dim2);}
.role-tag{color:var(--dim);} .user .role-tag{color:var(--acc2);}
.msg-ts{color:var(--dim2);}
.provider-tag{color:var(--dim2);text-transform:none;letter-spacing:0;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:50%;}
.msg-body{font-size:var(--fs);line-height:1.65;}
.user .msg-body{color:var(--dim);white-space:pre-wrap;word-break:break-word;border-left:2px solid var(--line2);padding-left:12px;}
.msg-actions{display:flex;gap:4px;margin-top:8px;opacity:0;}
.msg-wrap:hover .msg-actions{opacity:1;}
.msg-actions button{background:none;border:0;color:var(--dim2);font:inherit;font-size:10px;letter-spacing:.12em;text-transform:uppercase;cursor:pointer;padding:2px 6px;}
.msg-actions button:hover{color:var(--bg);background:var(--acc);}
.edit-area{width:100%;background:var(--s1);color:var(--text);border:1px solid var(--acc2);font:inherit;font-size:var(--fs);padding:8px;resize:none;outline:0;line-height:1.5;}
.edit-btns{display:flex;gap:6px;margin-top:6px;}
.edit-btn{background:none;border:1px solid var(--line2);color:var(--dim);font:inherit;font-size:10px;letter-spacing:.12em;text-transform:uppercase;padding:3px 8px;cursor:pointer;}
.edit-btn:hover{background:var(--acc);border-color:var(--acc);color:var(--bg);}
.edit-btn.confirm{border-color:var(--acc2);color:var(--acc2);}
.telemetry{display:inline-flex;gap:10px;font-size:10px;color:var(--dim2);margin-top:8px;flex-wrap:wrap;opacity:0;letter-spacing:.06em;}
.msg-wrap:hover .telemetry{opacity:1;} .telemetry span b{color:var(--dim);font-weight:500;}
.app-card{margin:10px 0;border:1px solid var(--line2);background:var(--bg);}
.app-card-bar{display:flex;align-items:center;gap:8px;padding:5px 10px;border-bottom:1px solid var(--line2);font-size:10px;letter-spacing:.12em;}
.app-card-title{flex:1;color:var(--acc2);text-transform:uppercase;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.app-card-open{background:none;border:0;color:var(--dim);font:inherit;font-size:10px;letter-spacing:.12em;text-transform:uppercase;cursor:pointer;text-decoration:none;}
.app-card-open:hover{color:var(--acc2);}
.app-card-frame{width:100%;height:300px;border:0;background:#fff;display:block;}
.manifest{margin:10px 0;border:1px solid var(--line);font-size:11px;}
.manifest-h{display:flex;gap:8px;align-items:center;padding:5px 10px;border-bottom:1px solid var(--line);font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--text);}
.manifest-h span{flex:1;}
.manifest-f{display:flex;gap:10px;align-items:center;padding:3px 10px;border-bottom:1px solid var(--line);color:var(--dim);}
.manifest-f:last-child{border-bottom:0;}
.manifest-f .st{font-size:9px;letter-spacing:.14em;text-transform:uppercase;min-width:64px;color:var(--dim2);}
.manifest-f .st.run{color:var(--warn);} .manifest-f .st.ok{color:var(--acc2);} .manifest-f .st.err{color:var(--err);}
.manifest-f code{color:var(--text);} .manifest-f i{flex:1;color:var(--dim2);font-style:normal;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
#typing{display:none;padding:12px 0;}
.typing-inner{display:flex;align-items:center;gap:10px;font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:var(--dim);}
.typing-dots{display:flex;gap:3px;}
.dot{width:4px;height:4px;background:var(--acc2);animation:blink 1s steps(2) infinite;}
.dot:nth-child(2){animation-delay:.25s} .dot:nth-child(3){animation-delay:.5s}
#scroll-pill{position:absolute;bottom:12px;left:50%;transform:translateX(-50%);background:var(--bg);border:1px solid var(--line2);color:var(--dim);font-size:10px;letter-spacing:.12em;text-transform:uppercase;padding:4px 10px;cursor:pointer;opacity:0;pointer-events:none;}
#scroll-pill.visible{opacity:1;pointer-events:auto;}
#scroll-pill:hover{background:var(--acc);color:var(--bg);border-color:var(--acc);}
.err-inline{color:var(--err);}

/* ── composer ─────────────────────────────────────────────────────────────── */
#bar{border-top:1px solid var(--line);background:var(--bg);padding:8px 16px 10px;flex-shrink:0;position:relative;}
.chips{display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px;}
.chip{font-size:10px;letter-spacing:.08em;border:1px solid var(--line2);color:var(--dim);padding:2px 8px;cursor:pointer;display:inline-flex;gap:5px;align-items:center;text-transform:uppercase;}
.chip:hover,.chip.on{background:var(--acc);border-color:var(--acc);color:var(--bg);}
.chip .x{color:var(--dim2);} .chip .x:hover{color:var(--err);}
.bar-inner{display:flex;align-items:flex-end;gap:8px;border:1px solid var(--line2);background:var(--bg);padding:6px 6px 6px 10px;}
.bar-inner:focus-within{border-color:var(--acc2);}
#inp{flex:1;background:none;border:0;color:var(--text);font:inherit;font-size:var(--fs);line-height:1.5;resize:none;outline:0;max-height:180px;padding:4px 0;}
#inp::placeholder{color:var(--dim2);}
#char-count{font-size:10px;color:var(--dim2);} #char-count.warn{color:var(--warn);} #char-count.danger{color:var(--err);}
#send{background:var(--acc);border:0;color:var(--bg);width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;flex-shrink:0;}
#send svg{width:13px;height:13px;} #send.stop{background:var(--err);color:#fff;}
.bar-meta{display:flex;gap:12px;align-items:center;margin-top:6px;font-size:10px;color:var(--dim2);letter-spacing:.08em;text-transform:uppercase;}
.bar-meta .sp{flex:1;}
.bar-meta kbd{border:1px solid var(--line);padding:0 4px;color:var(--dim2);font:inherit;font-size:9px;}
#bar.started .bar-hints{display:none;}
#slash{position:absolute;left:16px;right:16px;bottom:100%;margin:0 auto;max-width:var(--content-w);background:var(--bg);border:1px solid var(--line2);display:none;z-index:5;}
#slash.on{display:block;}
.slash-i{display:flex;gap:10px;padding:5px 10px;font-size:11px;cursor:pointer;}
.slash-i b{color:var(--acc2);font-weight:500;min-width:96px;} .slash-i span{color:var(--dim);}
.slash-i.sel,.slash-i:hover{background:var(--acc);color:var(--bg);} .slash-i.sel b,.slash-i:hover b,.slash-i.sel span,.slash-i:hover span{color:var(--bg);}
#progress{font-size:10px;color:var(--dim);letter-spacing:.1em;text-transform:uppercase;margin-left:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:60vw;}
#progress .tk{color:var(--acc2);}
.bar-modes{display:flex;gap:4px;margin-left:auto;}
.mode{background:none;border:1px solid var(--line);color:var(--dim2);font:inherit;font-size:9px;letter-spacing:.14em;text-transform:uppercase;padding:2px 7px;cursor:pointer;}
.mode:hover{color:var(--text);border-color:var(--line2);}
.mode.on{background:var(--acc);border-color:var(--acc);color:var(--bg);}
.msg-wrap.streaming .msg-body::after{content:"\\2588";color:var(--acc2);animation:blink 1s steps(2) infinite;}
#live-draft{margin:6px 0 0;border:1px solid var(--line);background:var(--bg);max-height:180px;overflow:auto;}
#live-draft .ld-h{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--dim);padding:4px 8px;border-bottom:1px solid var(--line);}
#live-draft pre{margin:0;padding:6px 8px;font-size:11px;white-space:pre-wrap;word-break:break-word;color:var(--text);}

/* ── runs ─────────────────────────────────────────────────────────────────── */
#runs{flex:1;overflow:auto;padding:12px 16px;}
.run{border:1px solid var(--line);margin:0 auto 8px;max-width:var(--content-w);}
.run-h{display:grid;grid-template-columns:72px 1fr auto;gap:10px;padding:6px 10px;cursor:pointer;font-size:11px;align-items:center;}
.run-h:hover{background:var(--s1);}
.run-h .t{color:var(--dim2);font-size:10px;}
.run-h .q{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text);}
.run-h .m{display:flex;gap:10px;font-size:10px;color:var(--dim2);white-space:nowrap;text-transform:uppercase;letter-spacing:.06em;}
.run-h .m b{color:var(--dim);font-weight:500;}
.run-b{display:none;border-top:1px solid var(--line);padding:8px 10px;} .run.open .run-b{display:block;}
.run-kv{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:4px 12px;font-size:10px;color:var(--dim2);margin-bottom:8px;text-transform:uppercase;letter-spacing:.06em;}
.run-kv b{color:var(--dim);font-weight:500;}
.run-reply{font-size:11px;color:var(--dim);white-space:pre-wrap;max-height:200px;overflow:auto;border-top:1px solid var(--line);padding-top:6px;margin-top:6px;}
#runs-empty{color:var(--dim2);text-align:center;padding:48px;font-size:10px;letter-spacing:.2em;text-transform:uppercase;}

/* ── palette ──────────────────────────────────────────────────────────────── */
#pal{position:fixed;inset:0;background:rgba(0,0,0,.6);display:none;z-index:60;align-items:flex-start;justify-content:center;padding-top:14vh;}
#pal.on{display:flex;}
#pal-box{width:min(560px,94vw);background:var(--bg);border:1px solid var(--acc2);}
#pal-in{width:100%;background:var(--bg);border:0;border-bottom:1px solid var(--line);color:var(--text);font:inherit;font-size:13px;padding:10px 12px;outline:0;}
#pal-list{max-height:52vh;overflow:auto;}
.pal-i{display:flex;gap:10px;align-items:center;padding:6px 12px;cursor:pointer;font-size:11px;}
.pal-i.sel,.pal-i:hover{background:var(--acc);color:var(--bg);}
.pal-i .k{font-size:9px;letter-spacing:.16em;text-transform:uppercase;color:var(--dim2);min-width:64px;}
.pal-i.sel .k,.pal-i:hover .k,.pal-i.sel .h,.pal-i:hover .h{color:var(--bg);}
.pal-i .l{flex:1;color:var(--text);} .pal-i.sel .l,.pal-i:hover .l{color:var(--bg);}
.pal-i .h{color:var(--dim2);font-size:10px;}

@media (max-width:900px){
  #sidebar{position:fixed;left:0;top:0;height:100dvh;z-index:20;}
  .modes button{padding:4px 8px;}
  .pill.opt{display:none;}
}

/* ── paper: a second set of inks, not an inversion ────────────────────────── */
body[data-theme="paper"]{
  --bg:#fff;--s0:#fafafa;--s1:#f2f2f2;--s2:#ebebeb;--s3:#e0e0e0;
  --line:#d4d4d4;--line2:#a8a8a8;
  --text:#000;--dim:#4a4a4a;--dim2:#8a8a8a;
  --acc:#000;--acc2:#0a7d4b;--err:#c4221a;--warn:#8a5a00;
}
body[data-theme="paper"] .ib:hover,body[data-theme="paper"] #new-btn:hover,body[data-theme="paper"] .act-btn:hover,
body[data-theme="paper"] .hint:hover,body[data-theme="paper"] .chip:hover,body[data-theme="paper"] .chip.on,
body[data-theme="paper"] .modes button.on,body[data-theme="paper"] .mode.on,body[data-theme="paper"] #send,
body[data-theme="paper"] .msg-actions button:hover,body[data-theme="paper"] .edit-btn:hover,
body[data-theme="paper"] .slash-i.sel,body[data-theme="paper"] .slash-i:hover,
body[data-theme="paper"] .pal-i.sel,body[data-theme="paper"] .pal-i:hover,
body[data-theme="paper"] #scroll-pill:hover{color:#fff;}
body[data-theme="paper"] #send{background:#000;}
body[data-theme="paper"] ::selection{background:#000;color:#fff;}
body[data-theme="black"]{--bg:#000;--s0:#050505;--s1:#0d0d0d;--s2:#141414;--s3:#1c1c1c;--line:#242424;--line2:#363636;}
`;
