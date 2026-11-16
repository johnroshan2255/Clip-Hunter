// UI smoke test: loads the dashboard + project pages in the installed Chrome,
// checks key elements render and saves screenshots. Usage: node scripts/ui-smoke.mjs <baseUrl> <projectId> <outDir>
import puppeteer from 'puppeteer-core';
const [base = 'http://127.0.0.1:4317', projectId, out = '.'] = process.argv.slice(2);
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await page.setViewport({ width: 1400, height: 1000 });
await page.goto(`${base}/#/`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.project-card, .empty', { timeout: 10000 });
await page.screenshot({ path: `${out}/ui-dashboard.png` });
const cards = await page.$$eval('.project-card', (els) => els.length);
console.log('dashboard project cards:', cards);
if (projectId) {
  await page.setViewport({ width: 1400, height: 1500 });
  await page.goto(`${base}/#/project/${projectId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('tr.moment', { timeout: 10000 });
  console.log('moment rows:', await page.$$eval('tr.moment', (e) => e.length));
  await page.screenshot({ path: `${out}/ui-moments.png` });
  await page.click('.tabs button:nth-child(2)');
  await page.waitForSelector('.clip-card', { timeout: 10000 });
  console.log('clip cards:', await page.$$eval('.clip-card', (e) => e.length), 'videos:', await page.$$eval('.clip-card video', (e) => e.length));
  await page.screenshot({ path: `${out}/ui-clips.png` });
  await page.click('.tabs button:nth-child(1)');
  await page.waitForSelector('.thumb-btn');
  await page.click('.thumb-btn');
  await page.waitForSelector('.preview-video');
  const ok = await page.waitForFunction(() => { const v = document.querySelector('.preview-video'); return v && v.readyState >= 2; }, { timeout: 20000 }).then(() => true, () => false);
  console.log('preview video playable:', ok);
}
console.log('page errors:', errors.length ? errors : 'none');
await browser.close();
