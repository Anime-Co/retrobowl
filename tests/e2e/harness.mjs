// Shared Playwright harness for automated browser checks (no test framework needed).
// Usage: import { withBrowser } from './harness.mjs';
//   await withBrowser({ mobile: true }, async ({ page, url, shot, errors }) => { ... });
// Starts a static server on a free port, opens the game, collects console errors.

import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '..', '..'));
const OUT = join(ROOT, 'test-results');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    const globalRoot = execSync('npm root -g').toString().trim();
    const require = createRequire(join(globalRoot, 'noop.js'));
    return require('playwright');
  }
}

export function startServer() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        const file = normalize(join(ROOT, path === '/' ? 'index.html' : path));
        if (!file.startsWith(ROOT)) throw new Error('outside root');
        const body = await readFile(file);
        res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end('not found');
      }
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/` }));
  });
}

/**
 * @param {{mobile?: boolean, landscape?: boolean, viewport?: {width:number,height:number}, blockFonts?: boolean}} opts
 * @param {(ctx: {page:any, url:string, shot:(name:string)=>Promise<string>, errors:string[], browser:any}) => Promise<void>} fn
 */
export async function withBrowser(opts, fn) {
  const { chromium } = await loadPlaywright();
  const { server, url } = await startServer();
  const browser = await chromium.launch();
  const errors = [];
  try {
    const mobile = !!opts.mobile;
    let viewport = opts.viewport || (mobile ? { width: 390, height: 844 } : { width: 1280, height: 720 });
    if (mobile && opts.landscape) viewport = { width: viewport.height, height: viewport.width };
    const context = await browser.newContext({ viewport, deviceScaleFactor: mobile ? 3 : 1, isMobile: mobile, hasTouch: mobile });
    const page = await context.newPage();
    // Fonts come from Google Fonts; tests run offline-safe by default.
    if (opts.blockFonts !== false) {
      await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
    }
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    await mkdir(OUT, { recursive: true });
    const shot = async (name) => {
      const p = join(OUT, `${name}.png`);
      await page.screenshot({ path: p });
      return p;
    };
    await page.goto(url);
    await page.waitForFunction(() => !!window.__app, null, { timeout: 10000 });
    await fn({ page, url, shot, errors, browser });
  } finally {
    await browser.close();
    server.close();
  }
}

/** Simulate a touch/mouse drag on the page from (x1,y1) to (x2,y2) in CSS px over `ms`. */
export async function drag(page, x1, y1, x2, y2, ms = 300, steps = 12) {
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps);
    await page.waitForTimeout(ms / steps);
  }
  await page.mouse.up();
}
