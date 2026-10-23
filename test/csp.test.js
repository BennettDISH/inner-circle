// The Content-Security-Policy. The session token sits in localStorage, so the page may run only
// its own scripts and the bug-tracker widget's, never inline script. Every outside source the
// page loads (index.html's scripts, stylesheets the SCSS imports) must be allowed too, or that
// part of the page quietly stops working.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApp } from './helpers.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// The pages come from a throwaway dist/ holding index.html, so the test doesn't depend on a
// build having run (a missing dist/ makes every page a 404 with Express's own policy).
let app;
let dist;
before(async () => {
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'inner-circle-dist-'));
  fs.copyFileSync(path.join(root, 'index.html'), path.join(dist, 'index.html'));
  app = await startApp({ distDir: dist });
});
after(async () => {
  await app?.stop();
  if (dist) fs.rmSync(dist, { recursive: true, force: true });
});

async function policyOf(url) {
  const header = (await fetch(app.base + url)).headers.get('content-security-policy');
  assert.ok(header, `no Content-Security-Policy on ${url}`);
  return Object.fromEntries(
    header.split(';').map((d) => d.trim().split(/\s+/)).filter(([name]) => name).map(([name, ...values]) => [name, values]),
  );
}

const origin = (url) => new URL(url).origin;
const allows = (csp, directive, url) => (csp[directive] ?? csp['default-src']).includes(origin(url));

describe('content security policy', () => {
  let csp;
  before(async () => { csp = await policyOf('/'); });

  it('runs no inline or eval script and no plugins', () => {
    assert.ok(csp['script-src'].includes("'self'"));
    for (const unsafe of ["'unsafe-inline'", "'unsafe-eval'"]) assert.ok(!csp['script-src'].includes(unsafe), unsafe);
    assert.deepEqual(csp['script-src-attr'], ["'none'"]);
    assert.deepEqual(csp['object-src'], ["'none'"]);
    assert.deepEqual(csp['default-src'], ["'self'"]);
  });

  it('allows every outside script index.html loads, and the server it reports to', () => {
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const scripts = [...html.matchAll(/<script\b[^>]*\ssrc="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
    assert.ok(scripts.length > 0, 'expected the bug-tracker widget');
    for (const src of scripts) {
      assert.ok(allows(csp, 'script-src', src), `script-src misses ${src}`);
      assert.ok(allows(csp, 'connect-src', src), `connect-src misses ${src}`);
    }
  });

  it('lets the widget style itself and show a screenshot preview', () => {
    assert.ok(csp['style-src'].includes("'unsafe-inline'"));
    for (const scheme of ['data:', 'blob:']) assert.ok(csp['img-src'].includes(scheme), scheme);
  });

  it('allows the stylesheets the SCSS imports, and Google Fonts files', () => {
    const scss = fs.readdirSync(path.join(root, 'src'), { recursive: true })
      .filter((f) => f.endsWith('.scss'))
      .map((f) => fs.readFileSync(path.join(root, 'src', f), 'utf8'))
      .join('\n');
    const imports = [...scss.matchAll(/@import\s+url\(['"]?(https?:\/\/[^'")]+)/g)].map((m) => m[1]);
    assert.ok(imports.length > 0, 'expected the Google Fonts import');
    for (const url of imports) assert.ok(allows(csp, 'style-src', url), `style-src misses ${url}`);
    if (imports.some((url) => origin(url) === 'https://fonts.googleapis.com')) {
      assert.ok(csp['font-src'].includes('https://fonts.gstatic.com'));
    }
  });

  it('is the same on the API and every page', async () => {
    for (const url of ['/health', '/api/auth/config', '/login', '/circles/1']) {
      assert.deepEqual(await policyOf(url), csp, url);
    }
  });
});
