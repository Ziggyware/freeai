import { qualityReport } from "./artifacts.ts";
const basic = [{ path: "index.html", content: "<!doctype html><html><body><canvas id=c></canvas><script src=app.js></script></body></html>" }, { path: "app.js", content: "const c=document.getElementById('c').getContext('2d');\nfunction draw(){c.fillRect(0,0,10,10);requestAnimationFrame(draw)}\ndraw();\nalert('hi')\n" }];
const q = qualityReport(basic); console.log(q.length, "findings"); console.log(q.map(x => x.slice(0, 60)).join("\n"));
const good = Array.from({ length: 9 }, (_, i) => ({ path: i ? `m${i}.js` : "index.html", content: (i ? "export const x=1;\n" : "<svg><path d=''/></svg><div aria-label='x' class='empty'>nothing here yet</div><button>help</button><style>:root{--c:#fff}@media(prefers-color-scheme:dark){}@media(max-width:600px){}.t{transition:all .2s}</style>") + "// filler\n".repeat(110) }));
good.push({ path: "README.md", content: "- f\n".repeat(12) });
good.push({ path: "core.js", content: "devicePixelRatio; new ResizeObserver(()=>{}); document.addEventListener('visibilitychange',()=>{}); requestAnimationFrame(()=>{}); addEventListener('keydown',()=>{}); addEventListener('pointerdown',()=>{}); try{localStorage.getItem('a')}catch(e){} const schemaVersion=2; function undo(){} toast(); fetch('x').catch(()=>{})" });
console.log("good:", qualityReport(good));
