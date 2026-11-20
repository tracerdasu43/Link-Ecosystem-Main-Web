// Checks that every DOM id referenced by the inline script exists in the markup.
const fs = require('fs');

const html = fs.readFileSync('index.html', 'utf8');
const js = html.match(/<script>([\s\S]*?)<\/script>/)[1];

const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const refs = new Set();
for (const m of js.matchAll(/getElementById\("([^"]+)"\)/g)) refs.add(m[1]);
for (const m of js.matchAll(/\$\("([^"\s]+)"\)/g)) refs.add(m[1]);
for (const m of js.matchAll(/querySelector(?:All)?\("#([a-zA-Z0-9_-]+)/g)) refs.add(m[1]);

const missing = [...refs].filter((r) => !ids.has(r));
console.log('DOM ids:', ids.size, '| JS id refs:', refs.size);
console.log(missing.length ? 'MISSING: ' + missing.join(', ') : 'All JS id refs resolve OK');

const routesJs = [...new Set([...js.matchAll(/"#\/([a-z-]*)/g)].map((m) => m[1] || '/'))];
const routesHtml = [...new Set([...html.matchAll(/href="#\/([a-z-]*)/g)].map((m) => m[1] || '/'))];
const unknownHtml = routesHtml.filter((r) => !routesJs.includes(r));
console.log('routes in JS  :', routesJs.join(', '));
console.log('routes in HTML:', routesHtml.join(', '));
console.log(unknownHtml.length ? 'HTML ROUTES NOT HANDLED: ' + unknownHtml.join(', ') : 'All HTML links resolve to a handled route OK');
