// Layout column, themes, density, settings drawer, thinking/tool/error blocks.
export const settingsStyle: string = `
:root{--content-w:760px;--fs:13px}
body[data-theme="black"]{--bg:#000;--s0:#050505;--s1:#0a0a0a;--s2:#111;--s3:#181818;--line:#1f1f1f;--line2:#2a2a2a}
body[data-theme="paper"]{--bg:#f4f4f1;--s0:#ececea;--s1:#e4e4e1;--s2:#dcdcd8;--s3:#d2d2ce;--line:#c9c9c4;--line2:#b8b8b3;--text:#15171c;--dim:#4d5260;--dim2:#7a7f8c;--acc2:#3b7d00}
body[data-theme="paper"] .user .msg-body{color:#15171c}
body[data-theme="paper"] .hljs-title,body[data-theme="paper"] .hljs-title.function_,body[data-theme="paper"] .hljs-title.class_,body[data-theme="paper"] .hljs-section,body[data-theme="paper"] .hljs-name{color:#15171c}
body[data-theme="paper"] .hljs-variable,body[data-theme="paper"] .hljs-template-variable,body[data-theme="paper"] .hljs-params,body[data-theme="paper"] .hljs-property{color:#3a3f4c}
body[data-theme="paper"] .hljs-attribute,body[data-theme="paper"] .hljs-selector-id,body[data-theme="paper"] .hljs-selector-class{color:#1f4f9a}
body[data-theme="paper"] .hljs-number,body[data-theme="paper"] .hljs-symbol,body[data-theme="paper"] .hljs-meta{color:#9a5a00}
body[data-font="sans"] .msg-body,body[data-font="sans"] #inp,body[data-font="sans"] .md p,body[data-font="sans"] .md li{font-family:var(--sans)}
.msg-body,#inp{font-size:var(--fs)}
body[data-density="compact"] .msg-wrap{padding:5px 0} body[data-density="compact"] .md p{margin-bottom:.4em}
body.no-ts .msg-ts{display:none} body.no-tel .telemetry{display:none} body.no-tools .tool-chain{display:none}
body.code-wrap .cb pre code{white-space:pre-wrap;word-break:break-word}

/* reading column: messages, composer and typing row share one centered width */
#chat>.msg-wrap,#typing,#empty,.bar-inner,.bar-meta{max-width:var(--content-w);margin-left:auto;margin-right:auto;width:100%}

/* thinking block */
.think{margin:4px 0 8px;border:1px solid var(--line);background:var(--s0)}
.think summary{cursor:pointer;list-style:none;padding:4px 8px;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--dim);display:flex;gap:8px;align-items:center}
.think summary::before{content:"▸";color:var(--acc)} .think[open] summary::before{content:"▾"}
.think .think-body{padding:6px 10px 8px;font-size:calc(var(--fs) - 1px);line-height:1.55;color:var(--dim);white-space:pre-wrap;word-break:break-word;border-top:1px solid var(--line);max-height:320px;overflow:auto}
body[data-thinking="hidden"] .think{display:none}
#live-think{font-size:11px;color:var(--dim2);white-space:pre-wrap;max-height:64px;overflow:hidden;margin-top:4px;line-height:1.4}

.trunc{font-size:10px;color:var(--warn);letter-spacing:.08em;text-transform:uppercase;display:flex;align-items:center;gap:6px;margin-top:4px}
/* error card */
.err-card{border:1px solid var(--err);background:rgba(255,107,107,.06);padding:8px 10px}
.err-card .err-h{color:var(--err);font-size:11px;letter-spacing:.08em;text-transform:uppercase;margin-bottom:4px}
.err-card .err-m{font-size:12px;white-space:pre-wrap;word-break:break-word}
.err-card details{margin-top:6px} .err-card summary{cursor:pointer;font-size:10px;color:var(--dim);letter-spacing:.08em;text-transform:uppercase}
.err-card pre{margin:6px 0 0;font-size:11px;white-space:pre-wrap;word-break:break-word;color:var(--dim);max-height:260px;overflow:auto}
.err-card .err-actions{margin-top:6px;display:flex;gap:6px}

/* settings drawer */
#settings{position:fixed;top:0;right:0;height:100dvh;width:min(380px,100vw);background:var(--s0);border-left:1px solid var(--line);z-index:40;display:flex;flex-direction:column}
#settings.closed{transform:translateX(100%)}
#st-scrim{position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:39;display:none} #st-scrim.on{display:block}
#st-hdr{display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid var(--line);font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:var(--acc)}
#st-body{overflow:auto;padding:6px 12px 24px}
#st-body section{padding:10px 0;border-bottom:1px solid var(--line)}
#st-body h4{font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim2);margin:0 0 8px;font-weight:500}
#st-body label{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:12px;color:var(--text);padding:4px 0}
#st-body label>input[type=checkbox]{order:-1;margin:0 8px 0 0;accent-color:var(--acc)} #st-body label:has(input[type=checkbox]){justify-content:flex-start}
#st-body select,#st-body input[type=text],#st-body textarea{background:var(--s1);color:var(--text);border:1px solid var(--line2);font:inherit;font-size:12px;padding:4px 6px;min-width:150px}
#st-body textarea{width:100%;resize:vertical;line-height:1.5}
#st-body input[type=range]{flex:1;accent-color:var(--acc)} #st-body output{min-width:36px;text-align:right;color:var(--dim);font-size:11px}
#st-body input[type=color]{width:36px;height:22px;border:1px solid var(--line2);background:none;padding:0}
#st-tools label{padding:2px 0}
.pr-hint{font-size:10px;color:var(--dim2);letter-spacing:.04em;margin:2px 0 4px;flex:1}
#pr-text{font-family:var(--mono);font-size:11px;line-height:1.45;min-height:160px} #pr-text.custom{border-color:var(--acc)}
.sk{border:1px solid var(--line);margin:4px 0;padding:0 8px 4px} .sk summary{cursor:pointer;list-style:none;display:flex;gap:8px;padding:5px 0;font-size:11px} .sk .sk-name{color:var(--text);flex:1} .sk .sk-mode{color:var(--dim2);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:55%} .sk textarea{font-family:var(--mono);font-size:11px;margin:4px 0} .sk label{padding:2px 0} .sk label>input[type=text]{flex:1;min-width:0}
.st-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
table.rt{width:100%;border-collapse:collapse;font-size:10px;margin-top:6px} table.rt th{text-align:left;color:var(--dim2);font-weight:500;letter-spacing:.1em;text-transform:uppercase;font-size:9px;padding:2px 4px;border-bottom:1px solid var(--line)} table.rt td{padding:2px 4px;border-bottom:1px solid var(--line);color:var(--dim)} table.rt td.cool{color:var(--warn)} table.rt td.dead{color:var(--err);font-weight:600} .st-btn{background:none;border:1px solid var(--line2);color:var(--dim);font:inherit;font-size:10px;letter-spacing:.1em;text-transform:uppercase;padding:4px 8px;cursor:pointer} .st-btn:hover{border-color:var(--acc);color:var(--acc)}
`;
