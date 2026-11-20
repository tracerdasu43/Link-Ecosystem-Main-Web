// Minimal W3C WebDriver client (no npm deps) to smoke-test index.html in Firefox.
// Usage: node scripts/render-test.js
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const PORT = 4455;
const BASE = 'http://127.0.0.1:' + PORT;
const OUT = path.join(ROOT, '.link', 'shots');
const WEB_PORT = 4466;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wd(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (json.value && json.value.error) {
    throw new Error(json.value.error + ': ' + json.value.message);
  }
  return json.value;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/* Tiny static server so fetch() resolves data/apps.json like it will on Pages. */
function startServer() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    let filePath = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.readFile(filePath, (err, buf) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
      res.end(buf);
    });
  });
  return new Promise((resolve) => server.listen(WEB_PORT, '127.0.0.1', () => resolve(server)));
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const web = await startServer();
  console.log('static server on http://127.0.0.1:' + WEB_PORT);

  const server = spawn('/snap/bin/geckodriver', ['--port', String(PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', () => {});

  // wait for geckodriver
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(BASE + '/status');
      break;
    } catch (_) {
      await sleep(250);
    }
  }

  const caps = await wd('POST', '/session', {
    capabilities: {
      alwaysMatch: {
        browserName: 'firefox',
        'moz:firefoxOptions': {
          args: ['-headless', '-width=1440', '-height=1000'],
          prefs: { 'dom.disable_beforeunload': true },
        },
      },
    },
  });
  const sid = caps.sessionId;
  const S = '/session/' + sid;
  console.log('session', sid);

  const logs = [];
  const errors = [];

  async function exec(script, args) {
    return wd('POST', S + '/execute/sync', { script, args: args || [] });
  }

  async function nav(url) {
    await wd('POST', S + '/url', { url });
    await sleep(1400);
  }

  async function setSize(w, h) {
    await wd('POST', S + '/window/rect', { width: w, height: h });
    await sleep(500);
  }

  async function shot(name) {
    const data = await wd('GET', S + '/screenshot');
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(data, 'base64'));
    console.log('  shot', name + '.png');
  }

  // Checks: returns problems found on the current page
  async function audit(label) {
    const r = await exec(`
      const out = { label: arguments[0], route: location.hash, problems: [], info: {} };
      out.info.title = document.title;

      // horizontal overflow
      const de = document.documentElement;
      if (de.scrollWidth > de.clientWidth + 1) {
        out.problems.push('horizontal overflow: scrollWidth ' + de.scrollWidth + ' > clientWidth ' + de.clientWidth);
      }
      // elements overflowing the viewport horizontally
      const vw = de.clientWidth;
      document.querySelectorAll('body *').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && (r.right > vw + 2 || r.left < -2)) {
          const cs = getComputedStyle(el);
          if (cs.position === 'fixed' || el.closest('.no-scrollbar') || el.closest('[data-allow-overflow]')) return;
          // skip known intentional horizontal strips / offscreen menus
          if (el.closest('.shots-strip') || el.closest('.lightbox') || el.closest('.mobile-menu')) return;
          out.problems.push('overflowing element: ' + el.tagName.toLowerCase() + '.' + (el.className || '').toString().split(' ')[0] + ' right=' + Math.round(r.right));
        }
      });
      // visible apps rendered
      out.info.cards = document.querySelectorAll('.app-card').length;
      out.info.h1 = (document.querySelector('main h1') || {}).textContent || '(none)';
      // empty main?
      const main = document.querySelector('main');
      out.info.mainTextLen = main ? main.innerText.trim().length : 0;
      if (main && main.innerText.trim().length < 20) out.problems.push('main content looks empty');
      // images without alt
      document.querySelectorAll('img:not([alt])').forEach(() => out.problems.push('img without alt attribute'));
      // broken images
      document.querySelectorAll('img').forEach((im) => {
        if (im.complete && im.naturalWidth === 0 && im.offsetParent !== null) {
          out.problems.push('broken image: ' + im.src.slice(0, 80));
        }
      });
      // External links must stay in this tab; download links request an in-place download.
      document.querySelectorAll('a[href^="http"]').forEach((a) => {
        if (a.hasAttribute('target')) out.problems.push('external link has target: ' + a.href.slice(0, 60));
      });
      document.querySelectorAll('.download-list a, .app-card a.btn-primary[href^="http"], .detail-actions a[href^="http"]').forEach((a) => {
        if (!a.hasAttribute('download')) out.problems.push('download link missing download hint: ' + a.href.slice(0, 60));
      });
      // tap targets smaller than 36px (icons in dense UI allowed a little slack)
      document.querySelectorAll('a, button').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;
        if (el.closest('.site-footer') || el.closest('.lightbox') || el.closest('.chip')) return;
        if (r.height < 30) out.problems.push('small tap target (' + Math.round(r.height) + 'px): ' + (el.getAttribute('aria-label') || el.textContent.trim().slice(0, 30) || el.tagName));
      });
      // dedupe
      out.problems = [...new Set(out.problems)];
      return out;
    `, [label]);
    return r;
  }

  const viewports = [
    { w: 360, h: 780, name: '360' },
    { w: 414, h: 820, name: '414' },
    { w: 768, h: 900, name: '768' },
    { w: 1024, h: 900, name: '1024' },
    { w: 1440, h: 950, name: '1440' },
  ];

  const routes = [
    { hash: '#/', label: 'home' },
    { hash: '#/apps', label: 'apps' },
    { hash: '#/app/link-stream', label: 'detail' },
    { hash: '#/about', label: 'about' },
    { hash: '#/contact', label: 'contact' },
    { hash: '#/nope-not-a-route', label: '404' },
  ];

  const pageUrl = 'http://127.0.0.1:' + WEB_PORT + '/index.html';

  for (const vp of viewports) {
    await setSize(vp.w, vp.h);
    for (const rt of routes) {
      await nav(pageUrl + rt.hash);
      const a = await audit(rt.label + '@' + vp.name);
      logs.push(a);
      if (a.problems.length) {
        errors.push(a.label + ' => ' + a.problems.join(' | '));
      }
    }
    // screenshot key pages at each width
    await nav(pageUrl + '#/');
    await shot('home-' + vp.name);
    await nav(pageUrl + '#/apps');
    await shot('apps-' + vp.name);
    if (vp.name === '360' || vp.name === '1440') {
      await nav(pageUrl + '#/app/link-stream');
      await shot('detail-' + vp.name);
      await nav(pageUrl + '#/contact');
      await shot('contact-' + vp.name);
      await nav(pageUrl + '#/about');
      await shot('about-' + vp.name);
    }
  }

  // console errors: read via injected hook, need a fresh nav after installing hook
  await nav(pageUrl + '#/');
  await exec(`
    window.__errs = [];
    window.addEventListener('error', (e) => window.__errs.push('error: ' + e.message));
    window.addEventListener('unhandledrejection', (e) => window.__errs.push('rejection: ' + e.reason));
  `);
  for (const rt of routes) {
    await nav(pageUrl + rt.hash);
  }
  const errs = await exec('return window.__errs || []');
  if (errs && errs.length) errors.push('runtime errors: ' + errs.join(' | '));

  console.log('\n--- page info ---');
  logs.filter((l) => l.label.endsWith('@360') || l.label.endsWith('@1440')).forEach((l) => {
    console.log(l.label, '| title:', l.info.title, '| cards:', l.info.cards, '| h1:', JSON.stringify(l.info.h1).slice(0, 60));
  });

  console.log('\n--- problems ---');
  if (!errors.length) console.log('none');
  else errors.forEach((e) => console.log('*', e));

  await wd('DELETE', S);
  server.kill();
  web.close();
  process.exit(errors.length ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
