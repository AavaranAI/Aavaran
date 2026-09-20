/**
 * Screenshot the side panel AS A REAL EXTENSION PAGE, with nothing stubbed.
 *
 * `panel-shot.mjs` serves the panel over http and fakes `chrome.*` and `fetch`. That is
 * the right trade for rendering seventeen states deterministically, and it leaves one
 * whole class of failure invisible, because three things are different in the real thing:
 *
 *   1. the origin is `chrome-extension://`, not `http://127.0.0.1`, so the fonts and any
 *      other `url()` resolve under a different origin and under MV3's CSP;
 *   2. `chrome.*` is the real API, answering about real tabs, real storage and a real
 *      service worker — the `getManifest` shape bug lived exactly here;
 *   3. the reasoning server is the real one, so the health path runs for real.
 *
 * This opens the panel's own URL in a tab of a profile with the extension loaded. It is
 * not a replacement for the state harness — it can only show whatever state the machine
 * happens to be in — it is the check that the panel is not broken in ways the stub cannot
 * express.
 *
 *   node scripts/panel-shot-live.mjs [--out /tmp/panel-live.png]
 */
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i === -1 ? d : args[i + 1]; };
const OUT = arg('--out', '/tmp/panel-live');
const CDP_PORT = 9336;
const WIDTH = 400;

mkdirSync(OUT, { recursive: true });

function findChrome() {
  const candidates = [
    `${process.env.HOME}/.cache/sih-browsers/chrome/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
    `${process.env.HOME}/.cache/sih-browsers/chrome/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
    `${process.env.HOME}/.cache/sih-browsers/chrome/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  try {
    return execFileSync('bash', ['-c', `. ${ROOT}/scripts/find-browser.sh && find_chrome`],
      { encoding: 'utf8' }).trim();
  } catch { return null; }
}

const CHROME = findChrome();
if (!CHROME) { console.error('no Chrome — run scripts/get-chrome-for-testing.sh'); process.exit(1); }

/* A FRESH PROFILE EVERY RUN. Chrome caches the extension's service worker in the
   profile, so a reused one silently runs yesterday's code against today's build —
   the same trap Spike E documents. */
const PROFILE = '/tmp/panel-live-profile';
execFileSync('rm', ['-rf', PROFILE]);

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${PROFILE}`,
  `--load-extension=${ROOT}/extension`,
  '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
  '--force-device-scale-factor=2',
  // Headless cannot host an extension's service worker in a way the panel can talk to,
  // so this runs headed and off-screen rather than pretending otherwise.
  '--window-size=1200,1000', '--window-position=-2400,0',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdp(path) {
  const r = await fetch(`http://127.0.0.1:${CDP_PORT}${path}`);
  return r.json();
}

/**
 * OUR extension's id, derived rather than discovered.
 *
 * ⛔ The first version took the first `chrome-extension://` target it saw, and Chrome
 * ships component extensions of its own — so it picked one of those, navigated to a
 * page that does not exist inside it, and reported that the panel "did not render"
 * with three missing fonts. Every one of those failures was real about the page it
 * looked at and meaningless about ours.
 *
 * Chrome derives an UNPACKED extension's id from the absolute path: sha256 of the
 * path, first 16 bytes, each nibble mapped onto a..p. That is deterministic, so it
 * can be computed instead of guessed at.
 */
const EXT_DIR = `${ROOT}/extension`;
const EXT_ID = [...createHash('sha256').update(EXT_DIR).digest('hex').slice(0, 32)]
  .map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');

let targets = [];
for (let i = 0; i < 80; i++) {
  try { targets = await cdp('/json/list'); } catch { /* not up */ }
  if (targets.some((t) => t.url.includes(EXT_ID))) break;
  await sleep(250);
}
if (!targets.some((t) => t.url.includes(EXT_ID))) {
  console.error(`the extension at ${EXT_DIR} never registered a target (id ${EXT_ID}).`);
  console.error('targets seen:');
  for (const t of targets) console.error(`  ${t.type}  ${t.url.slice(0, 90)}`);
  chrome.kill(); process.exit(1);
}
console.log(`extension id: ${EXT_ID}  (derived from ${EXT_DIR})`);

const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  const p = pending.get(m.id);
  if (p) { pending.delete(m.id); p(m); }
});
const send = (method, params = {}) => new Promise((resolve) => {
  const msgId = ++id; pending.set(msgId, resolve);
  ws.send(JSON.stringify({ id: msgId, method, params }));
});

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: WIDTH, height: 900, deviceScaleFactor: 2, mobile: false });
await send('Page.navigate', { url: `chrome-extension://${EXT_ID}/src/panel/index.html` });
await sleep(3500);   // splash out at 1.39s, then the real health probe

/**
 * The assertions that only the real thing can answer.
 *
 * Fonts first, and by loaded-status rather than `document.fonts.check()`, which returns
 * true via a fallback and has lied about this exact panel before.
 */
const verdict = await send('Runtime.evaluate', {
  expression: `JSON.stringify((() => {
    const fails = [];
    const loaded = [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family);
    for (const f of ['Archivo Black', 'Geist', 'Geist Mono']) {
      if (!loaded.includes(f)) fails.push('font not loaded under chrome-extension://: ' + f);
    }
    // the panel actually rendered, rather than dying during import
    if (!document.querySelector('.topbar')) fails.push('no top bar — the panel did not render');
    if (!document.querySelector('#settings .sheet')) fails.push('the settings sheet is missing');
    // a module that throws leaves the splash covering everything
    const splash = document.getElementById('splash');
    if (splash && splash.checkVisibility && splash.checkVisibility({ checkVisibilityCSS: true }))
      fails.push('the launch screen never handed over');
    // and the catch-all must not have painted an exception
    if (document.querySelector('#phase .deny'))
      fails.push('error on screen: ' + document.getElementById('phase').textContent.trim());
    return { fails, lamp: document.getElementById('lamptext')?.textContent,
             target: document.getElementById('target')?.textContent?.trim(),
             fonts: loaded };
  })())`, returnByValue: true });

const report = JSON.parse(verdict.result.result.value);
console.log(`lamp: ${report.lamp}`);
console.log(`target: ${report.target}`);
console.log(`fonts: ${[...new Set(report.fonts)].join(', ')}`);

const measured = await send('Runtime.evaluate', {
  expression: 'Math.ceil(document.querySelector(".app").getBoundingClientRect().bottom)',
  returnByValue: true });
const height = Math.min((measured.result?.result?.value ?? 900) + 8, 4000);
await send('Emulation.setDeviceMetricsOverride', {
  width: WIDTH, height, deviceScaleFactor: 2, mobile: false });
await sleep(250);
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
writeFileSync(`${OUT}/live-main.png`, Buffer.from(shot.result.data, 'base64'));
console.log(`live-main.png  ${WIDTH}x${height}`);

// and the settings screen, opened the way a person opens it
await send('Runtime.evaluate', {
  expression: `document.querySelector('#settings > summary').click()` });
await sleep(700);
await send('Emulation.setDeviceMetricsOverride', {
  width: WIDTH, height: 820, deviceScaleFactor: 2, mobile: false });
await sleep(200);
const shot2 = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(`${OUT}/live-settings.png`, Buffer.from(shot2.result.data, 'base64'));
console.log(`live-settings.png  ${WIDTH}x820`);

for (const f of report.fails) console.error(`  ✘ ${f}`);
console.log(report.fails.length ? `${report.fails.length} failure(s)` : 'live panel: clean');

ws.close();
chrome.kill();
process.exit(report.fails.length ? 1 : 0);
