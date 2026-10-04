// Styles for Markdown bodies, code blocks (hljs token map on the house palette),
// tables, math, the progress line, model chips and the stop control.
export const mdStyle: string = `
.msg-body.md{white-space:normal;}
.md p{margin:0 0 .7em;} .md p:last-child{margin-bottom:0;}
.md h1,.md h2,.md h3,.md h4{font-family:var(--mono);letter-spacing:.04em;margin:.9em 0 .4em;color:var(--text);line-height:1.3;}
.md h1{font-size:16px;} .md h2{font-size:14px;} .md h3{font-size:13px;color:var(--acc);} .md h4{font-size:12px;color:var(--dim);}
.md ul,.md ol{margin:0 0 .7em 1.3em;} .md li{margin:.15em 0;} .md li>ul,.md li>ol{margin-bottom:0;}
.md blockquote{border-left:2px solid var(--line2);padding:.1em 0 .1em .8em;margin:0 0 .7em;color:var(--dim);}
.md hr{border:0;border-top:1px solid var(--line);margin:.9em 0;}
.md a{color:var(--acc);text-decoration:none;border-bottom:1px solid rgba(79,140,255,.35);} .md a:hover{border-bottom-color:var(--acc);}
.md code{font-family:var(--mono);font-size:12px;background:var(--s2);border:1px solid var(--line);padding:0 4px;border-radius:var(--r);color:var(--acc2);}
.md .ck{display:inline-block;width:10px;height:10px;border:1px solid var(--line2);margin:0 6px -1px 0;} .md .ck.on{background:var(--acc2);border-color:var(--acc2);}
.md .tbl{overflow-x:auto;margin:0 0 .7em;border:1px solid var(--line);}
.md table{border-collapse:collapse;font-size:12px;min-width:100%;} .md th,.md td{padding:5px 9px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top;}
.md th{background:var(--s1);color:var(--dim);font-weight:500;letter-spacing:.06em;text-transform:uppercase;font-size:10px;} .md tr:last-child td{border-bottom:0;}
.md .mx-d{display:block;text-align:center;margin:.5em 0;} .md .mx:not(.done){color:var(--dim);}
.md .katex{font-size:1.05em;}

.cb{margin:.6em 0;border:1px solid var(--line);background:var(--s0);}
.cb-h{display:flex;align-items:center;gap:10px;padding:4px 8px;border-bottom:1px solid var(--line);background:var(--s1);font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);}
.cb-lang{color:var(--acc);} .cb-n{color:var(--dim2);margin-right:auto;}
.cb-copy{background:none;border:1px solid var(--line2);color:var(--dim);font:inherit;letter-spacing:.08em;text-transform:uppercase;padding:1px 6px;cursor:pointer;} .cb-copy:hover{border-color:var(--acc);color:var(--acc);}
.cb pre{margin:0;padding:9px 10px;overflow-x:auto;font-size:12px;line-height:1.55;tab-size:2;}
.cb pre code{background:none;border:0;padding:0;color:var(--text);font-size:inherit;white-space:pre;}
.hljs{background:transparent;color:var(--text);}
.hljs-comment,.hljs-quote{color:var(--dim2);font-style:italic;}
.hljs-keyword,.hljs-selector-tag,.hljs-literal,.hljs-built_in,.hljs-type{color:var(--acc);}
.hljs-string,.hljs-regexp,.hljs-addition,.hljs-attr,.hljs-template-tag{color:var(--acc2);}
.hljs-number,.hljs-symbol,.hljs-bullet,.hljs-meta,.hljs-link{color:var(--warn);}
.hljs-title,.hljs-title.function_,.hljs-title.class_,.hljs-section,.hljs-name{color:#e4e8f4;font-weight:500;}
.hljs-variable,.hljs-template-variable,.hljs-params,.hljs-property{color:#c4cbe0;}
.hljs-attribute,.hljs-selector-id,.hljs-selector-class,.hljs-selector-attr,.hljs-selector-pseudo{color:#9fd0ff;}
.hljs-deletion{color:var(--err);} .hljs-emphasis{font-style:italic;} .hljs-strong{font-weight:600;}

#progress{font-size:10px;color:var(--dim);letter-spacing:.08em;text-transform:uppercase;margin-left:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:60vw;}
#progress .tk{color:var(--acc);}
.bar-modes{display:flex;gap:4px;margin-left:auto;}
.mode{background:none;border:1px solid var(--line);color:var(--dim2);font:inherit;font-size:9px;letter-spacing:.1em;text-transform:uppercase;padding:2px 7px;cursor:pointer;}
.mode:hover{border-color:var(--acc);color:var(--acc);} .mode.on{border-color:var(--acc);color:var(--acc);background:var(--s1);}
#send.stop{background:var(--err);border-color:var(--err);}
.msg-wrap.streaming .msg-body::after{content:"▌";color:var(--acc);animation:blink 1s steps(2) infinite;} @keyframes blink{to{opacity:0;}}
.telemetry{font-size:9px;color:var(--dim2);letter-spacing:.06em;margin-left:auto;}
`;
