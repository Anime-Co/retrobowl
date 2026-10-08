// Smoke test: boots the game on desktop and mobile (portrait + landscape), checks the title screen
// renders and there are no console errors. Screenshots land in test-results/.
import { withBrowser } from './harness.mjs';

const configs = [
  { name: 'desktop', opts: {} },
  { name: 'mobile-portrait', opts: { mobile: true } },
  { name: 'mobile-landscape', opts: { mobile: true, landscape: true } },
];

let failed = 0;
for (const c of configs) {
  await withBrowser(c.opts, async ({ page, shot, errors }) => {
    await page.waitForTimeout(600);
    const screen = await page.evaluate(() => window.__app.currentName);
    await shot(`smoke-${c.name}`);
    const ok = screen === 'title' && errors.length === 0;
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${c.name} screen=${screen} errors=${JSON.stringify(errors)}`);
  });
}
process.exit(failed ? 1 : 0);
