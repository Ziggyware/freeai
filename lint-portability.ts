import { lintArtifact, lintPortability } from "./artifacts.ts";
const files = [
 { path: "index.html", content: `<!doctype html><html><head><base href="/"><link href="/style.css"><script type="module" src="./main.js"></script></head><body></body></html>` },
 { path: "main.js", content: `import {DATA} from './data.js';\nfetch('./levels.json').then(r=>r.json());\nparent.postMessage({a:1},'*');\nconst u = location.origin + '/api';\nlocalStorage.setItem('k','v');\nnavigator.serviceWorker.register('sw.js');\nconst img='/artifact/12/x.png';\nexport function boot(){ return DATA.length }` },
 { path: "data.js", content: `export const DATA=[1,2,3];` },
 { path: "ok.js", content: `// comment /artifact/1\nfunction save(k,v){ try{ localStorage.setItem(k,v) }catch(e){ mem[k]=v } }\nconst mem={};\nif (window.parent !== window) { parent.postMessage('x','*'); }\nexport { save };` },
];
const p = lintPortability(files); console.log(p.join("\n")); console.log("count", p.length, "ok.js hits", p.filter(x=>x.startsWith("ok.js")).length);
console.log("full", lintArtifact(files).length);
