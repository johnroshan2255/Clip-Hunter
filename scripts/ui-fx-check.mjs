// UI check for the fun-effects screens: clip card, effects editor, montage dialog, settings.
// Usage: node scripts/ui-fx-check.mjs <baseUrl> <projectId> <clipId> <outDir>
import puppeteer from 'puppeteer-core';

const [base = 'http://127.0.0.1:4317', projectId, clipId, out = '.'] = process.argv.slice(2);
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const clickByText = async (root, selector, text) => {
  for (const b of await root.$$(selector)) if ((await b.evaluate((x) => x.textContent)).includes(text)) return b.click();
  throw new Error(`No ${selector} with text ${text}`);
};

await page.setViewport({ width: 1400, height: 1000 });
await page.goto(`${base}/#/project/${projectId}`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.tabs button');
await page.click('.tabs button:nth-child(2)');
await page.waitForSelector('.clip-card');
let target = null;
for (const c of await page.$$('.clip-card')) if ((await c.$eval('.clip-head b', (b) => b.textContent)) === clipId) target = c;
console.log('fx chips:', await target.$$eval('.tag.fx', (e) => e.map((x) => x.textContent)));
console.log('buttons:', await target.$$eval('.row-actions .btn', (e) => e.map((x) => x.textContent.trim())));
await target.evaluate((el) => el.scrollIntoView());
await target.screenshot({ path: `${out}/ui-clip-card.png` });

await clickByText(target, '.row-actions .btn', 'Effects');
await page.waitForSelector('.fx-editor');
await page.waitForFunction(() => document.querySelectorAll('.fx-item').length > 0, { timeout: 10000 });
console.log('editor items:', await page.$$eval('.fx-item b', (e) => e.map((x) => x.textContent)), 'hooks:', await page.$$eval('.fx-field input', (e) => e.map((x) => x.value)));
await clickByText(page, '.fx-add .btn', 'Glitch');
console.log('after add:', await page.$$eval('.fx-item', (e) => e.length), 'timeline marks:', await page.$$eval('.fx-mark', (e) => e.length));
await page.screenshot({ path: `${out}/ui-fx-editor.png` });
await page.keyboard.press('Escape');

await clickByText(page, '.toolbar .btn', 'montage');
await page.waitForSelector('.montage-list');
console.log('montage clips listed:', await page.$$eval('.montage-list label', (e) => e.length));
await page.screenshot({ path: `${out}/ui-montage.png` });
await page.keyboard.press('Escape');

await page.click('.tabs button:nth-child(4)');
await page.waitForSelector('.facecam-box');
await page.setViewport({ width: 1400, height: 2700 });
console.log('sounds:', await page.$$eval('.sound-chip span', (e) => e.map((x) => x.textContent).join(' ')));
await page.screenshot({ path: `${out}/ui-settings.png`, fullPage: true });
console.log('errors:', errors);
await browser.close();
