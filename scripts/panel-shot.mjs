/**
 * Screenshot the side panel, in every state, at real panel width.
 *
 * A design change is only as good as the pixels it produces, and the panel is the
 * one surface nothing in the suite looks at — `test-all.sh` proves the detector is
 * right and says nothing about whether the thing a human sees is legible. This
 * closes that: it renders the real index.html against the real built panel.js and
 * writes PNGs that can be opened and judged.
 *
 * The panel is served over http rather than loaded as an extension, and the few
 * chrome.* APIs it touches are stubbed before the module runs. That keeps the
 * harness deterministic — no profile, no service worker, no model, no network —
 * and it is the stylesheet and layout being tested here, not the browser plumbing.
 *
 *   node scripts/panel-shot.mjs [--width 400] [--out /tmp/panel]
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i === -1 ? d : args[i + 1]; };
const WIDTH = Number(arg('--width', 400));
const OUT = arg('--out', '/tmp/panel-shots');
const PORT = 8987;
const CDP_PORT = 9334;

mkdirSync(OUT, { recursive: true });

/* ── find Chrome the same way the spikes do ─────────────────────────────── */
function findChrome() {
  const candidates = [
    `${process.env.HOME}/.cache/sih-browsers/chrome/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
    `${process.env.HOME}/.cache/sih-browsers/chrome/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  // fall back to whatever find-browser.sh resolves
  try {
    return execFileSync('bash', ['-c',
      `. ${ROOT}/scripts/find-browser.sh && find_chrome`], { encoding: 'utf8' }).trim();
  } catch { return null; }
}

/* ── serve extension/ ───────────────────────────────────────────────────── */
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
  '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml',
};
const server = http.createServer(async (req, res) => {
  const path = normalize(join(`${ROOT}/extension`, decodeURIComponent(req.url.split('?')[0])));
  if (!path.startsWith(`${ROOT}/extension`)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end('not found'); }
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

/* ── launch ─────────────────────────────────────────────────────────────── */
const CHROME = findChrome();
if (!CHROME) { console.error('no Chrome — run scripts/get-chrome-for-testing.sh'); process.exit(1); }

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${CDP_PORT}`,
  '--user-data-dir=/tmp/panel-shot-profile', '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--force-device-scale-factor=2', 'about:blank',
], { stdio: 'ignore' });

/* ── CDP ────────────────────────────────────────────────────────────────── */
async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('CDP never came up');
}
const ws = new WebSocket(await connect());
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

/**
 * Stub the extension APIs BEFORE the panel module runs.
 *
 * Each state below decides what chrome.* returns, so one harness can render the
 * offline case, the scan result and a finished run without a server or a model.
 */
function stub({ tabUrl, health, scan, run, buildInfo, threads, healthAfter, flipAfterMs }) {
  /**
   * The audit reports on the values THIS run actually withheld.
   *
   * It was a hardcoded 3 for every state, so the needs-user-input reference — a run on a
   * page where nothing was withheld — rendered "3 of your values were checked" directly
   * above "0 values withheld". These PNGs go to the designers as the record of what each
   * state looks like, and a reference that contradicts itself is one that gets copied.
   */
  const checkedValues = (run?.records ?? []).reduce(
    (a, r) => a + (r.withheld ?? []).reduce((x, w) => x + w.count, 0), 0);
  // getURL must exist: loadBuildInfo() calls it, and without it the whole
  // build-detection path throws and silently falls back to the repo default — so the
  // harness would render advice that no real install would ever show.
  return `
  globalThis.chrome = {
    /* A real enough storage: the thread bar reads the threads key out of it, so a stub
       that always answers {} can only ever render one of the three states. remove()
       exists because deleteAll calls it — a stub missing a method throws inside the
       panel and takes the surrounding render down with it, which is how the status
       readout was lost to a missing getManifest.
       NO BACKTICKS IN HERE: this whole block is inside a template literal, and the
       first one ended the string and broke the harness. */
    storage: { local: {
      get: async (k) => (k === 'threads' ? { threads: ${JSON.stringify(threads ?? {})} } : {}),
      set: async () => {},
      remove: async () => {},
    } },
    tabs: { query: async () => [{ id: 1, url: ${JSON.stringify(tabUrl)} }],
            // The panel asks the CONTENT script to audit the transcript and to
            // rehydrate an answer, because only it holds the vault.
            sendMessage: async (_id, m) => m.type === 'audit-transcript'
              ? { checkedValues: ${checkedValues}, bytesScanned: 94208,
                  leaks: [], clean: true }
              : m.type === 'resolve-text'
                ? { text: String(m.text ?? '').replace('<PII_PHONE_1>', '99•••••41') }
                : {},
            onActivated: { addListener(){} }, onUpdated: { addListener(){} } },
    runtime: { onMessage: { addListener(){} },
      getURL: (p) => 'stub://' + p,
      // Read from the real manifest so the stub cannot drift from the build.
      getManifest: () => ({ version: ${JSON.stringify(MANIFEST_VERSION)} }),
      sendMessage: async (m) => m.type === 'scan-page' ? ${JSON.stringify(scan)}
                             : m.type === 'run-agent'  ? ${JSON.stringify(run)} : {} },
  };
  /* Catch EXECUTION, not just presence. An injected <img onerror> fires the moment it
     is parsed into the document, even if the node is replaced a second later — so a
     handler that only inspected the final DOM could miss a payload that had already
     run. The hostile fixtures all call alert(). */
  globalThis.__XSS_FIRED = false;
  globalThis.alert = () => { globalThis.__XSS_FIRED = true; };

  const realFetch = globalThis.fetch;
  const json = (o) => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });
  globalThis.fetch = async (u, o) => {
    const s = String(u);
    if (s.includes('build-info.json')) return json(${JSON.stringify(buildInfo ?? { variant: 'repo' })});
    /* THE MODEL PULL, STUBBED — because it was reaching the REAL server.
       Only /health and build-info.json were intercepted, so clicking Install sent a
       real POST /pull to whatever ollama happened to be doing on this machine. The
       screenshot named "11-model-downloading" therefore showed a DIFFERENT SCREEN
       depending on whether the developer had the model: with it present the pull
       returned at once and the shot was the "download finished, but the server still
       does not see the model" FAILURE state. A reference handed to designers has to
       show the state it is named after, on any machine.
       The stream deliberately never closes: mid-download IS the state.
       NO BACKTICKS — this whole block lives inside a template literal. */
    if (s.includes('/pull')) {
      const enc = new TextEncoder();
      const lines = [
        JSON.stringify({ status: 'pulling manifest' }),
        JSON.stringify({ digest: 'sha256:a1', total: 4100000000, completed: 900000000 }),
        JSON.stringify({ digest: 'sha256:b2', total: 1900000000, completed: 300000000 }),
        JSON.stringify({ digest: 'sha256:a1', total: 4100000000, completed: 2400000000 }),
      ];
      return new Response(new ReadableStream({
        async start(c) {
          for (const l of lines) {
            c.enqueue(enc.encode(l + '\\n'));
            await new Promise((r) => setTimeout(r, 120));
          }
        },
      }), { headers: { 'content-type': 'application/x-ndjson' } });
    }
    if (s.includes('/health')) {
      /* A server that COMES UP while the panel is open. The panel used to probe only
         on open and on Test, so the one path its own advice sends you down — go to a
         terminal, start it, come back — was the path it could not see the end of.
         Timed from the FIRST probe, which is the panel opening. */
      const flip = ${JSON.stringify(flipAfterMs ?? null)};
      globalThis.__probeStart ??= Date.now();
      const h = (flip !== null && Date.now() - globalThis.__probeStart >= flip)
        ? ${JSON.stringify(healthAfter ?? null)}
        : ${JSON.stringify(health)};
      if (h === null) throw new TypeError('Failed to fetch');   // truly unreachable
      return json(h);
    }
    return realFetch(u, o);
  };
  `;
}

/** What build.mjs stamps on this machine, near enough for a screenshot. */
const BUILD_REPO = {
  variant: 'repo',
  root: '/Users/you/sih-browser-agent',
  setupNeeded: false,
  startCommands: [
    'ollama serve',
    '"/Users/you/sih-browser-agent/server/.venv/bin/uvicorn" main:app --port 8975'
      + ' --app-dir "/Users/you/sih-browser-agent/server"',
  ],
};
const BUILD_ZIP = { variant: 'scan-only' };

/**
 * A GoDaddy parked domain: the whole body is inside a frame, so the top frame yields
 * one element. The panel must NOT call this clean.
 */
const SCAN_BLIND = {
  title: 'financegpt.io', url: 'https://financegpt.io/lander',
  nodeCount: 1, bytes: 338, withheld: [], previews: [],
  unreadable: [{ x: 0, y: 0, w: 1200, h: 900 }], blindRatio: 0.94, truncated: false,
};

const MANIFEST_VERSION = JSON.parse(
  readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8')).version;
const HEALTH_OK = { ok: true, model: 'qwen2.5vl:7b' };
const HEALTH_DOWN = { ok: false, error: 'not ready' };
/** null = the fetch itself rejects, which is what "unreachable" actually looks like. */
const HEALTH_UNREACHABLE = null;
/**
 * Healthy server running an OLDER build than the extension.
 *
 * The two halves update separately: Chrome reloads the extension in seconds, while the
 * server is a process somebody started days ago and which goes on serving old code with
 * nothing on screen to say so. Every mismatch this project has been bitten by has been
 * silent, so this state exists to prove the panel is loud about this one.
 */
const HEALTH_STALE = { ok: true, model: 'qwen2.5vl:7b', version: '0.1.9' };
/** Server up, model absent — a different screen and a different command. */
const HEALTH_NO_MODEL = { ok: false, model: 'qwen2.5vl:7b', available: ['llama3.1:8b'] };

const SCAN = {
  title: 'Income Tax e-Filing', url: 'https://eportal.incometax.gov.in', nodeCount: 101,
  bytes: 13079,
  withheld: [{ kind: 'PAN', count: 1 }, { kind: 'NAME', count: 2 }, { kind: 'PHONE', count: 1 }],
  previews: [
    { token: '<PII_PAN_1>', kind: 'PAN', masked: 'ABC••••••F' },
    { token: '<PII_NAME_1>', kind: 'NAME', masked: 'Ha••• Ba•••i' },
    { token: '<PII_NAME_2>', kind: 'NAME', masked: 'Pu•• Sa•••r' },
    { token: '<PII_PHONE_1>', kind: 'PHONE', masked: '99••••••41' },
  ],
  unreadable: [], truncated: false,
};

/**
 * A PAGE THAT ATTACKS THE PANEL.
 *
 * Almost every string the panel renders is page-controlled: the document title, field
 * labels, element ids, the model's own reasoning about them, and the refusal text quoting
 * them back. The panel builds its DOM with innerHTML. So a hostile page gets to write
 * markup into the EXTENSION's privileged UI unless every one of those goes through esc().
 *
 * `bench/injection-test.ts` already covers a hostile page trying to steer the MODEL. This
 * covers the other half, never previously tested: a hostile page trying to steer the
 * PANEL. Reading the source and finding esc() on every interpolation is not the same as
 * proving it, and the next person to add a field will not read the source.
 *
 * The strings are chosen to break out of each context innerHTML offers — element content,
 * a double-quoted attribute, and a single-quoted one, which matters because esc() does
 * NOT escape an apostrophe and is only safe while every attribute in the panel is
 * double-quoted.
 */
const XSS = '<img src=x onerror=alert(1)>';
const XSS_ATTR = '" onmouseover="alert(2)" x="';
const XSS_SQ = "' onfocus='alert(3)' y='";
const HOSTILE_SCAN = {
  title: `Bank ${XSS}`, url: `https://evil.test/${XSS_ATTR}`, nodeCount: 3, bytes: 128,
  withheld: [{ kind: 'PAN', count: 1 }],
  previews: [
    { token: `<PII_PAN_1>${XSS}`, kind: 'PAN', masked: `AB••••${XSS_SQ}` },
  ],
  unreadable: [], truncated: false,
};
const HOSTILE_RUN = {
  stopReason: 'goal-complete',
  tabId: 1,
  origin: 'https://evil.test',
  previews: HOSTILE_SCAN.previews,
  records: [{
    turn: 1, origin: `evil.test${XSS}`, nodeCount: 3, transmittedBytes: 128,
    withheld: [{ kind: 'PAN', count: 1 }],
    facesBlurred: 0, piiMasked: 0,
    timings: { extractMs: 1, sanitizeMs: 1, visionMs: 0, networkMs: 10, totalMs: 12 },
    actions: [{
      allowed: false,
      reason: `target is hostile ${XSS}`,
      action: { kind: 'click', target: XSS_ATTR, value: XSS, reasoning: XSS_SQ },
    }],
    visionError: `withheld ${XSS}`,
    transmitted: { goal: XSS, root: {
      id: 'el_0', role: 'form', visible: true, enabled: true, children: [
        { id: `el_1${XSS_ATTR}`, role: 'textbox', label: `Your name ${XSS}`, value: '',
          visible: true, enabled: true },
        { id: 'el_2', role: 'radio', label: `Yes ${XSS_SQ}`, group: `g${XSS_ATTR}`,
          checked: false, contextLabel: `Pick one ${XSS}`, visible: true, enabled: true },
      ] } },
    received: { actions: [] },
  }],
};

/**
 * The state he was actually looking at: the real income-tax login page, where the
 * User ID field accepts a PAN or an Aadhaar and the value settles neither. Kept as a
 * fixture so the SENSITIVE label and the unreadable-regions warning both stay on
 * screen for review rather than being rediscovered from a screenshot.
 */
const SCAN_ITD = {
  title: 'Income Tax e-Filing', url: 'https://eportal.incometax.gov.in/iec/foservices/#/login',
  nodeCount: 118, bytes: 13079,
  withheld: [{ kind: 'SENSITIVE', count: 1 }],
  previews: [{ token: '<PII_SENSITIVE_1>', kind: 'SENSITIVE', masked: 'IM••••••••T' }],
  unreadable: new Array(14).fill({}), truncated: false,
};

const RUN = {
  stopReason: 'goal-complete',
  /**
   * ⚠ `tabId` IS LOAD-BEARING, NOT DECORATION.
   *
   * The proof card — the audit that searches the exact transmitted bytes for every
   * value the vault held back — only renders when the response carries a tab id,
   * because auditing against another tab's vault searches for nothing and finds
   * nothing, which reads as a clean bill of health and is not one. No fixture here
   * had one, so the single artefact this product is built to produce has never
   * appeared in a reference screenshot of any state.
   */
  tabId: 1,
  origin: 'https://eportal.incometax.gov.in',
  previews: SCAN.previews,
  records: [{
    turn: 1, origin: 'eportal.incometax.gov.in', nodeCount: 101, transmittedBytes: 47104,
    withheld: [{ kind: 'PAN', count: 1 }, { kind: 'NAME', count: 2 }],
    facesBlurred: 1, piiMasked: 3,
    timings: { extractMs: 12, sanitizeMs: 4, visionMs: 65, networkMs: 3820, totalMs: 3901 },
    actions: [{ allowed: true, executed: true,
      action: { kind: 'type', target: '#pan', value: '<PII_PAN_1>',
                reasoning: 'The PAN field is empty and the form cannot be submitted without it.' } },
      { allowed: false, reason: 'target is outside the form being completed',
        action: { kind: 'click', target: 'a.external',
                  reasoning: 'Following the help link.' } }],
    /**
     * ⛔ THIS WAS `nodes: [...]`, AND IT HAD BEEN CRASHING THE STATE.
     *
     * When the panel started computing the outstanding fields from the payload, the
     * needs-input fixture below was given a real `root` and THIS one was not. So
     * `missingFields()` walked an undefined root, threw, and the catch-all painted
     * "error: Cannot read properties of undefined" over the whole results view —
     * which means the reference screenshot of a COMPLETED RUN, the one handed to the
     * designers as what a finished run looks like, was a stack trace and three
     * stuck skeletons. The harness reported 0 failures throughout: it asserted
     * fonts and accessible names, and nothing ever asked whether a state rendered.
     *
     * Every field is FILLED here, because the stop reason is goal-complete — a
     * finished run with outstanding fields would be a fixture contradicting itself.
     */
    transmitted: { goal: 'Fill in the form and submit it', root: {
      id: 'el_0', role: 'form', visible: true, enabled: true, children: [
        { id: 'el_1', role: 'textbox', label: 'PAN', value: '<PII_PAN_1>',
          visible: true, enabled: true },
        { id: 'el_2', role: 'textbox', label: 'Full name', value: '<PII_NAME_1>',
          visible: true, enabled: true },
        { id: 'el_4', role: 'textbox', label: 'Assessment year', value: '2026-27',
          visible: true, enabled: true },
      ] } },
    received: { actions: [{ kind: 'type', target: '#pan', value: '<PII_PAN_1>',
                            reasoning: 'The PAN field is empty.' }] },
  }],
};

/**
 * THE AGENT NEEDS ONE VALUE THAT IS NOT ON THE PAGE.
 *
 * Manas's mca.gov.in report: the PAN box is empty, so nothing was withheld, and the model
 * asked for `<PII_PAN_1>` anyway. The client refuses it — the value does not exist — and
 * now stops to ask rather than spending turns being refused.
 *
 * This state exists because the last two things added to this panel rendered NOTHING the
 * first time and the lamp stuck on "checking": correct code, invisible on screen. There is
 * no substitute for looking at the pixels.
 */
/** A conversation already on the books for a site, for the resume state. */
const THREADS = {
  th_1: {
    id: 'th_1', origin: 'https://www.mca.gov.in', goal: 'Complete the registration form',
    title: 'Complete the registration form',
    createdAt: Date.now() - 86400000, updatedAt: Date.now() - 86400000,
    status: 'open',
    turns: [{ at: Date.now() - 86400000, summary: 'Entered the first name', withheld: [] },
            { at: Date.now() - 86400000, summary: 'PAN field filled', withheld: [] }],
    pending: { question: 'What is your Income Tax PAN?', fieldLabel: 'Income Tax PAN' },
  },
};

const RUN_NEEDS_INPUT = {
  stopReason: 'needs-user-input',
  question: 'What is your Income Tax PAN?',
  questionTarget: 'el_49',
  // Nothing was withheld on this page, so this is the state that renders the
  // "nothing of yours was on this page" wording rather than the green one.
  tabId: 1,
  origin: 'https://www.mca.gov.in',
  previews: [],
  records: [{
    turn: 1, origin: 'www.mca.gov.in', nodeCount: 88, transmittedBytes: 21440,
    withheld: [], facesBlurred: 0, piiMasked: 0,
    timings: { extractMs: 14, sanitizeMs: 3, visionMs: 0, networkMs: 4010, totalMs: 4062 },
    actions: [{ allowed: false,
      reason: 'no value like <PII_PAN_1> was withheld on this page, so you do not have it'
        + ' — either ask for it with {"kind":"ask_user","text":"What is your Income Tax'
        + ' PAN?","reasoning":"not on page"} or leave the field empty and continue',
      action: { kind: 'type', target: 'el_49', value: '<PII_PAN_1>',
                reasoning: 'PAN field filled' } }],
    // A real payload shape, because the panel now computes the missing fields FROM it.
    // A stub of `nodes: [...]` renders an empty form and proves nothing.
    transmitted: { goal: 'Fill in the form and submit it', root: {
      id: 'el_0', role: 'form', visible: true, enabled: true, children: [
        { id: 'el_1', role: 'textbox', label: 'Customer name', value: 'Harsh Bajpai',
          visible: true, enabled: true },
        { id: 'el_3', role: 'textbox', label: 'E-mail address', value: '<PII_EMAIL_1>',
          visible: true, enabled: true },
        { id: 'el_5', role: 'radio', label: 'Small', group: 'size', checked: false,
          contextLabel: 'Pizza Size', visible: true, enabled: true },
        { id: 'el_6', role: 'radio', label: 'Medium', group: 'size', checked: false,
          contextLabel: 'Pizza Size', visible: true, enabled: true },
        { id: 'el_7', role: 'radio', label: 'Large', group: 'size', checked: false,
          contextLabel: 'Pizza Size', visible: true, enabled: true },
        { id: 'el_10', role: 'checkbox', label: 'Bacon', group: 'topping', checked: false,
          contextLabel: 'Pizza Toppings', visible: true, enabled: true },
        { id: 'el_11', role: 'checkbox', label: 'Extra Cheese', group: 'topping',
          checked: false, contextLabel: 'Pizza Toppings', visible: true, enabled: true },
        // A CLOCK, not a text box. This is the field he could not answer: whatever he
        // typed into a plain input was rejected by the control and it stayed empty.
        { id: 'el_15', role: 'textbox', label: 'Preferred delivery time', value: '',
          inputType: 'time', required: true, visible: true, enabled: true },
        { id: 'el_16', role: 'textbox', label: 'Delivery instructions', value: '',
          visible: true, enabled: true },
      ] } },
    received: { actions: [{ kind: 'type', target: 'el_49', value: '<PII_PAN_1>',
                            reasoning: 'PAN field filled' }] },
  }],
};

const STATES = [
  // Captured mid-sweep on purpose: the launch screen is the one moment that a
  // still cannot otherwise show, and it is the first thing anyone sees.
  { name: '0-launch-screen', tabUrl: 'https://eportal.incometax.gov.in/iec/foservices/',
    health: HEALTH_OK, scan: SCAN, run: RUN, after: null, splash: true },
  { name: '1-idle-server-ready', tabUrl: 'https://eportal.incometax.gov.in/iec/foservices/',
    health: HEALTH_OK, scan: SCAN, run: RUN, after: null },
  { name: '13-server-version-stale', tabUrl: 'https://eportal.incometax.gov.in/iec/foservices/',
    health: HEALTH_STALE, scan: SCAN, run: RUN, after: null },
  { name: '2-server-offline', tabUrl: 'chrome://extensions/',
    health: HEALTH_DOWN, scan: SCAN, run: RUN, after: null },
  { name: '3-scan-result', tabUrl: 'https://eportal.incometax.gov.in/iec/foservices/',
    health: HEALTH_OK, scan: SCAN, run: RUN, after: `document.getElementById('scan').click()` },
  { name: '4-run-complete', tabUrl: 'https://eportal.incometax.gov.in/iec/foservices/',
    health: HEALTH_OK, scan: SCAN, run: RUN,
    after: `document.getElementById('goal').value='Fill in the form and submit it';
            document.getElementById('run').click()` },
  // The three thread states. They are the answer to "I changed site mid-conversation",
  // which used to be a flat refusal on every page including ordinary ones.
  { name: '15-thread-resume', tabUrl: 'https://www.mca.gov.in/content/mca/global/en/home.html',
    health: HEALTH_OK, scan: SCAN, run: RUN, after: null, threads: THREADS },
  { name: '16-thread-new', tabUrl: 'https://eportal.incometax.gov.in/iec/foservices/',
    health: HEALTH_OK, scan: SCAN, run: RUN, after: null, threads: {} },
  { name: '14-needs-user-input', tabUrl: 'https://eportal.incometax.gov.in/iec/foservices/',
    health: HEALTH_OK, scan: SCAN, run: RUN_NEEDS_INPUT,
    after: `document.getElementById('goal').value='Complete the registration form';
            document.getElementById('run').click()` },
  { name: '6-scan-ambiguous-field', tabUrl: 'https://eportal.incometax.gov.in/iec/foservices/#/login',
    health: HEALTH_DOWN, scan: SCAN_ITD, run: RUN,
    after: `document.getElementById('scan').click()` },
  // The two states he hit: the server is down and you are told how to start it, and
  // the zip, where it cannot be started at all and must not be implied otherwise.
  { name: '7-server-unreachable-repo', tabUrl: 'https://eportal.incometax.gov.in/iec/foservices/',
    health: HEALTH_UNREACHABLE, scan: SCAN, run: RUN, buildInfo: BUILD_REPO, after: null },
  // His case: the scan-only zip installed in Chrome while a server runs from a clone.
  // Run must be usable — the package cannot START a server, which is not the same as
  // the agent being impossible.
  { name: '12-scan-only-but-server-up', tabUrl: 'https://demoqa.com/automation-practice-form',
    health: HEALTH_OK, scan: SCAN, run: RUN, buildInfo: BUILD_ZIP, after: null },
  { name: '8-scan-only-package', tabUrl: 'https://eportal.incometax.gov.in/iec/foservices/',
    health: HEALTH_UNREACHABLE, scan: SCAN, run: RUN, buildInfo: BUILD_ZIP, after: null },
  { name: '9-model-not-installed', tabUrl: 'https://eportal.incometax.gov.in/iec/foservices/',
    health: HEALTH_NO_MODEL, scan: SCAN, run: RUN, buildInfo: BUILD_REPO, after: null },
  // Clicks Install and lets the real server stream a real pull, so the screenshot shows
  // progress the panel actually parsed rather than a mock of it.
  { name: '11-model-downloading', tabUrl: 'https://eportal.incometax.gov.in/iec/foservices/',
    health: HEALTH_NO_MODEL, scan: SCAN, run: RUN, buildInfo: BUILD_REPO,
    after: `document.getElementById('pullmodel').click()` },
  { name: '10-page-unreadable', tabUrl: 'https://financegpt.io/lander',
    health: HEALTH_OK, scan: SCAN_BLIND, run: RUN,
    after: `document.getElementById('scan').click()` },
  /**
   * THE SERVER COMES UP WHILE YOU ARE LOOKING AT THE INSTRUCTIONS TO START IT.
   *
   * His report: "if someone's server has been started, why are they still seeing those
   * 2 commands". Two faults, and only one of them was the missing poll —
   * `checkServer`'s success branch never hid the advice box at all, so even pressing
   * Test left "The reasoning server is not running" on screen under a green lamp
   * reading "ready". The panel asserted both halves of a contradiction at once.
   *
   * Health flips to OK 2s after the first probe, and nothing here touches the panel:
   * no click, no Test, no reload. If the box is gone at the end, it healed itself.
   */
  { name: '17-server-came-up', tabUrl: 'https://eportal.incometax.gov.in/iec/foservices/',
    health: HEALTH_UNREACHABLE, healthAfter: HEALTH_OK, flipAfterMs: 2000,
    buildInfo: BUILD_REPO, scan: SCAN, run: RUN, after: null, settleMs: 5000,
    assert: `(() => {
      const box = document.getElementById('serveradvice');
      if (!box.hidden) return 'the start-the-server advice is STILL showing: '
        + JSON.stringify(box.textContent.trim().slice(0, 80));
      if (!document.getElementById('lamp').classList.contains('ok'))
        return 'the lamp never went green: ' + document.getElementById('lamptext').textContent;
      if (document.getElementById('run').classList.contains('demoted'))
        return 'Run is still demoted on a server that is up';
      return '';
    })()` },

  /**
   * A HOSTILE PAGE AIMED AT THE PANEL, NOT AT THE MODEL.
   *
   * Scans first, then runs, so both render paths build DOM from the hostile strings —
   * the scan card, the evidence table, the turn record, the refusal text, the proof card
   * and the computed missing-fields form.
   */
  { name: '18-hostile-page', tabUrl: 'https://evil.test/login',
    health: HEALTH_OK, scan: HOSTILE_SCAN, run: HOSTILE_RUN, fixed: 900,
    after: `document.getElementById('scan').click();
            setTimeout(() => { document.getElementById('goal').value = 'Fill in the form';
                               document.getElementById('run').click(); }, 700)`,
    assert: `(() => {
      if (globalThis.__XSS_FIRED) return 'AN INJECTED HANDLER EXECUTED inside the panel';
      // The panel authors no inline handlers at all, so any on* attribute is theirs.
      for (const el of document.querySelectorAll('*')) {
        for (const a of el.attributes) {
          if (/^on/i.test(a.name)) return 'inline handler ' + a.name + ' on ' + el.tagName;
        }
      }
      if (document.querySelector('img')) return 'an <img> was injected — the panel ships none';
      // index.html carries exactly one <script>: the panel module.
      const scripts = document.querySelectorAll('script');
      if (scripts.length !== 1) return 'script count is ' + scripts.length + ', expected 1';
      /* And the payload must actually be ON SCREEN as text. Without this the check
         passes just as well when the panel silently dropped the hostile fields, which
         would make it a test of nothing. */
      const body = document.body.textContent;
      if (!body.includes('onerror=alert(1)'))
        return 'the hostile string never rendered, so this state proved nothing';
      return '';
    })()` },

  /**
   * Settings is its own screen now, so this state has to be shot like the splash:
   * the sheet is position:fixed and contributes NOTHING to `.app`'s height, so
   * measuring the content would size the shot to the page hiding behind it.
   *
   * ⚠ It CLICKS the gear rather than setting `.open`. Setting the property still
   * works on a <details> whose summary is broken or unreachable, which would have
   * produced a perfectly plausible screenshot of a control nobody can press. And
   * `assert` is here because the failure mode of this state is not an error — it
   * is the main screen, rendered correctly, filed under the settings name.
   */
  { name: '5-settings-open', tabUrl: 'https://eportal.incometax.gov.in/iec/foservices/',
    health: HEALTH_OK, scan: SCAN, run: RUN, fixed: 820,
    after: `document.querySelector('#settings > summary').click()`,
    assert: `(() => {
      const sheet = document.querySelector('#settings .sheet');
      if (!sheet) return 'no .sheet in the DOM';
      /* ⚠ checkVisibility, NOT a bounding box. A CLOSED <details> still gives a
         position:fixed child a full-size rect, so a box measurement here would
         report a covering sheet on a settings screen that never opened. */
      if (!sheet.checkVisibility({ checkVisibilityCSS: true, contentVisibilityAuto: true }))
        return 'the sheet did not open';
      const r = sheet.getBoundingClientRect();
      if (r.width < 300 || r.height < 400) return 'the sheet is not covering: ' + JSON.stringify(r);
      /**
       * ⛔ THIS CHECK USED TO COMPARE ask.top WITH r.top, AND IT TESTED NOTHING.
       * (No backticks in this block — it lives inside a template literal, which is
       *  a trap this file has already been bitten by once, in the chrome stub.)
       *
       * The claim was "the sheet covers the panel rather than pushing it down". But
       * an IN-FLOW sheet sits BELOW .ask, so its top would be the larger number and
       * the comparison would pass — the exact failure it was written to catch would
       * have sailed through, while a 1px change to the top bar's height made it fire.
       * A check that fires on a type-scale tweak and stays silent on the regression
       * it names is worse than no check.
       *
       * What actually distinguishes covering from displacing: the sheet is taken out
       * of flow, and the thing painted over the panel's content IS the sheet.
       */
      if (getComputedStyle(sheet).position !== 'fixed')
        return 'the sheet is in flow, so it displaces the panel instead of covering it';
      const onTop = document.elementFromPoint(Math.round(r.width / 2), Math.round(r.top + 200));
      if (!onTop || !onTop.closest('.sheet'))
        return 'the panel shows through where the sheet should be: '
          + (onTop ? onTop.className || onTop.tagName : 'nothing');
      return '';
    })()` },
];

let priorStub = null;
for (const s of STATES) {
  await send('Page.navigate', { url: 'about:blank' });
  await new Promise((r) => setTimeout(r, 150));
  // These REGISTRATIONS ACCUMULATE. Without removing the previous one, every
  // state after the first ran with the first state's stub still installed — the
  // offline shot rendered a healthy server and looked entirely plausible.
  if (priorStub) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: priorStub });
  const added = await send('Page.addScriptToEvaluateOnNewDocument', { source: stub(s) });
  priorStub = added.result?.identifier ?? null;
  await send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: 1500, deviceScaleFactor: 2, mobile: false });
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/src/panel/index.html` });

  // The launch screen is dismissed by CSS at 1.05s + 0.34s fade. The old 1400ms
  // wait landed exactly on that boundary, so a shot could catch the splash
  // half-faded over the panel and look like a rendering fault.
  if (s.splash) {
    await new Promise((r) => setTimeout(r, 520));  // mid-sweep, bar partly across
  } else {
    await new Promise((r) => setTimeout(r, 2100)); // splash fully gone, fonts settled
  }
  if (s.after) {
    await send('Runtime.evaluate', { expression: s.after, awaitPromise: false });
    await new Promise((r) => setTimeout(r, 1600)); // let count-up + stagger finish
  }
  // For states that are about the panel noticing something ON ITS OWN, with nobody
  // pressing anything. The wait IS the test.
  if (s.settleMs) await new Promise((r) => setTimeout(r, s.settleMs));

  /**
   * NO STATE MAY RENDER AN ERROR.
   *
   * The whole results render sits inside one try/catch that paints the exception
   * into #phase, so a throw anywhere in it produces a panel that looks deliberate:
   * a tidy card, correct fonts, real layout, and a stack trace where the run should
   * be. That is how run-complete shipped broken through every previous pass of this
   * harness — the failure had a nice screenshot. Nothing here stubs `error`, so any
   * error in #phase is a genuine fault in the panel or a fixture that has gone stale.
   */
  const errored = await send('Runtime.evaluate', {
    expression: `document.querySelector('#phase .deny') ? document.getElementById('phase').textContent.trim() : ''`,
    returnByValue: true });
  const errText = errored.result?.result?.value;
  if (errText) throw new Error(`${s.name} rendered an error: ${errText}`);

  /**
   * RULE 1 IS NOW CHECKED, NOT JUST WRITTEN DOWN.
   *
   * The top of index.html bans tiny wide-tracked uppercase micro-labels — "the single
   * loudest tell that an interface was generated rather than designed". The ask card
   * then shipped `4 VALUES NEEDED` at 9.5px/.14em, directly above the form a judge is
   * asked to fill in, and it survived four design passes. It arrived after the ban was
   * written, and NOTHING CHECKS A RULE THAT LIVES IN A COMMENT.
   *
   * The wordmark is exempt: it is a logotype, and uppercase is the whole of it.
   */
  const shouting = await send('Runtime.evaluate', {
    expression: `JSON.stringify([...document.querySelectorAll('*')]
      .filter(el => el.closest('.mark') === null && el.textContent.trim())
      .filter(el => {
        const c = getComputedStyle(el);
        if (c.textTransform !== 'uppercase') return false;
        const px = parseFloat(c.fontSize);
        const track = c.letterSpacing === 'normal' ? 0 : parseFloat(c.letterSpacing);
        return px < 12 && track > px * 0.05;
      })
      .map(el => (el.tagName + '.' + el.className).slice(0, 40) + ' "'
        + el.textContent.trim().slice(0, 28) + '"'))`,
    returnByValue: true });
  const loud = JSON.parse(shouting.result?.result?.value ?? '[]');
  if (loud.length) {
    throw new Error(`${s.name}: uppercase micro-label (rule 1) — ${loud.join(' | ')}`);
  }

  // A state whose failure looks like a different valid state cannot be caught by
  // reading the PNG — it has to be asserted on the live DOM before the shot.
  if (s.assert) {
    const verdict = await send('Runtime.evaluate', { expression: s.assert, returnByValue: true });
    const why = verdict.result?.result?.value;
    if (why !== '') throw new Error(`${s.name}: ${why ?? JSON.stringify(verdict)}`);
  }

  // Size the shot to the content so nothing is cropped and nothing is padded.
  // CDP nests twice: { id, result: { result: { value } } }. Reading one level of
  // it gave NaN, and setDeviceMetricsOverride accepted the NaN silently — the
  // screenshots came out at the previous height and looked plausible.
  // The splash is position:fixed, so it fills the VIEWPORT, not the content box.
  // Sizing that shot to content height would centre the wordmark in whatever the
  // panel happens to be tall — shoot it at a realistic side-panel height instead.
  // position:fixed states — the splash and the settings sheet. Both fill the
  // VIEWPORT and contribute nothing to the content box, so they are shot at a
  // realistic side-panel height instead of at the height of what they cover.
  const fixedHeight = s.splash ? 820 : s.fixed;
  if (fixedHeight) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: WIDTH, height: fixedHeight, deviceScaleFactor: 2, mobile: false });
    await new Promise((r) => setTimeout(r, 200));
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(`${OUT}/${s.name}.png`, Buffer.from(shot.result.data, 'base64'));
    console.log(`${s.name}.png  ${WIDTH}x${fixedHeight}${s.splash ? '  (mid-sweep)' : ''}`);
    continue;
  }

  const evaluated = await send('Runtime.evaluate', {
    // scrollHeight floors at the viewport, so every state measured 1508 and the
    // shots were mostly empty background. The panel's own box is the real height.
    expression: 'Math.ceil(document.querySelector(".app").getBoundingClientRect().bottom)',
    returnByValue: true });
  const measured = evaluated.result?.result?.value;
  if (!Number.isFinite(measured)) throw new Error(`could not measure height: ${JSON.stringify(evaluated)}`);
  const height = Math.min(measured + 8, 4000);
  await send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height, deviceScaleFactor: 2, mobile: false });
  await new Promise((r) => setTimeout(r, 250));

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(`${OUT}/${s.name}.png`, Buffer.from(shot.result.data, 'base64'));
  console.log(`${s.name}.png  ${WIDTH}x${height}`);
}

/**
 * Accessibility invariants, asserted on the LIVE DOM.
 *
 * These are the fixes from the Web Interface Guidelines review, and every one of
 * them is invisible: an unlabelled input, a silent live region and an icon that
 * announces itself all look perfect in a screenshot. A check is the only thing
 * that can notice them coming back.
 */
const a11y = await send('Runtime.evaluate', {
  expression: `JSON.stringify((() => {
    const fails = [];
    // every control has an accessible name
    for (const el of document.querySelectorAll('input, button')) {
      const labelled = el.labels?.length
        || el.getAttribute('aria-label')
        || el.textContent.trim().length;
      if (!labelled) fails.push('unnamed control: ' + (el.id || el.className));
    }
    // clicking the label must focus the field
    const lab = document.querySelector('label[for="goal"]');
    if (!lab) fails.push('#goal has no <label for>');
    // icons must not be announced
    // NOTE: lucide sets aria-hidden itself, so this can only ever catch a
    // HAND-WRITTEN inline <svg> — which is exactly what it caught in sabotage.
    // Identify it by its parent chain; an <svg> has no useful id of its own.
    for (const svg of document.querySelectorAll('svg')) {
      if (svg.getAttribute('aria-hidden') !== 'true') {
        const where = svg.closest('[id]')?.id
          || svg.parentElement?.className
          || svg.parentElement?.tagName
          || 'unknown';
        fails.push('icon not aria-hidden, inside: ' + where);
      }
    }
    // async surfaces must announce
    for (const id of ['phase', 'lamp', 'target', 'serverstatus']) {
      const el = document.getElementById(id);
      if (!el) { fails.push('missing #' + id); continue; }
      if (el.getAttribute('aria-live') !== 'polite') fails.push('#' + id + ' not aria-live');
    }
    // the lamp's label element must exist, or setLamp writes into the dot
    if (!document.getElementById('lamptext')) fails.push('#lamptext missing');
    // a focusable summary needs a focus style
    const sum = document.querySelector('#settings summary');
    if (sum && !getComputedStyle(sum).outlineStyle) fails.push('summary has no outline rule');
    return { fails, controls: document.querySelectorAll('input, button').length,
             icons: document.querySelectorAll('svg[aria-hidden="true"]').length };
  })())`, returnByValue: true });
const report = JSON.parse(a11y.result.result.value);
console.log(`a11y: ${report.controls} controls, ${report.icons} icons hidden, `
  + `${report.fails.length} failure(s)`);
for (const f of report.fails) console.error(`  ✘ ${f}`);
if (report.fails.length) process.exitCode = 1;

/**
 * THE SETTINGS SCREEN ACTUALLY OPENS AND ACTUALLY CLOSES.
 *
 * Driven, not read. Twice now this panel has shipped a control that rendered
 * perfectly and could never work — the fill button whose message overwrote its own
 * routing field, and a question the worker never forwarded. Both were invisible to
 * this harness precisely because it looks at paint and not at behaviour.
 *
 * Three exits are checked because they fail independently: the gear is CSS and must
 * work with no script at all, while Done and Escape are script and would go quietly
 * dead if a handler stopped binding.
 */
const exits = await send('Runtime.evaluate', {
  awaitPromise: true,
  /* ⚠ ASYNC, because <details> fires `toggle` on a task of its own. Setting
     `open = false` and reading `.inert` on the very next line reported that the panel
     "stayed inert after the sheet closed" — the handler simply had not run yet. The
     check was measuring its own timing, not the panel's behaviour. */
  expression: `(async () => {
    const tick = () => new Promise((r) => setTimeout(r, 30));
    const fails = [];
    const d = document.getElementById('settings');
    const gear = document.querySelector('#settings > summary');
    /* ⚠ START FROM A KNOWN STATE. The last state rendered leaves the sheet OPEN,
       so the first click here closed it and the check reported that the gear
       could not open anything. A toggle test that does not establish its own
       starting position is measuring whatever the previous test left behind. */
    d.open = false;
    /* ⚠ NOT getClientRects(). A closed <details> in Chrome hides its content with
       content-visibility, which still leaves a layout box on a position:fixed
       child — so that probe answered "visible" in every state and the OPEN check
       passed for the wrong reason. checkVisibility() is the one that accounts
       for it. The state is reported alongside so a failure says which half broke. */
    const shown = () => !!document.querySelector('#settings .sheet')
      ?.checkVisibility({ checkVisibilityCSS: true, contentVisibilityAuto: true });
    const state = () => \`(open=\${d.open}, painted=\${shown()})\`;

    gear.click();
    if (!shown()) fails.push('the gear does not open the sheet ' + state());

    document.getElementById('closesettings').click();
    if (shown()) fails.push('Done does not close the sheet ' + state());

    gear.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    if (shown()) fails.push('Escape does not close the sheet ' + state());

    gear.click();
    gear.click();
    if (shown()) fails.push('the gear does not close the sheet it opened ' + state());

    /* A fixed overlay hides things from the EYE and from nothing else. With the sheet
       open, Tab still reached Run and Scan underneath it, so focus could land on a
       control the user cannot see and the next Enter would start an agent run from what
       looks like a settings screen. */
    gear.click();
    await tick();
    const run = document.getElementById('run');
    run.focus();
    if (document.activeElement === run)
      fails.push('Run is still focusable behind the open settings sheet');
    const ask = document.querySelector('.ask');
    if (ask && !ask.closest('[inert]') && !ask.inert)
      fails.push('the panel behind the sheet was never made inert');
    d.open = false;
    await tick();
    if (document.querySelector('.ask').inert)
      fails.push('the panel stayed inert after the sheet closed');

    return JSON.stringify(fails);
  })()`, returnByValue: true });
const exitFails = JSON.parse(exits.result.result.value);
console.log(`settings: ${exitFails.length ? exitFails.length + ' failure(s)' : 'opens and closes (gear, Done, Escape)'}`);
for (const f of exitFails) console.error(`  ✘ ${f}`);
if (exitFails.length) process.exitCode = 1;

/* A font that failed to load leaves the panel on a fallback and the whole
   redesign looks half-applied — so assert it, rather than eyeballing it. */
/**
 * ⚠ `document.fonts.check()` is NOT the test it looks like — it returns true when a
 * FALLBACK can render the text, so it reported success for "Inter" and "JetBrains
 * Mono" long after both had been removed from the panel. The only honest signal is
 * which faces actually reached status 'loaded'.
 */
const EXPECT_FONTS = ['Archivo Black', 'Geist', 'Geist Mono'];
const fonts = await send('Runtime.evaluate', {
  expression: `JSON.stringify([...document.fonts]
    .filter(f => f.status === 'loaded').map(f => f.family))`, returnByValue: true });
const loaded = JSON.parse(fonts.result.result.value);
const missingFonts = EXPECT_FONTS.filter((f) => !loaded.includes(f));
console.log(`fonts loaded: ${loaded.join(', ') || '(none)'}`);
if (missingFonts.length) {
  console.error(`  ✘ not loaded, panel is on a fallback: ${missingFonts.join(', ')}`);
  process.exitCode = 1;
}

ws.close(); chrome.kill(); server.close();
process.exit(0);
