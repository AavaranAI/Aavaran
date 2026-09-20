/**
 * THE INVARIANTS THAT MAKE `esc()` ENOUGH.
 *
 * The panel builds its DOM with `innerHTML` out of strings a hostile page controls: the
 * document title, field labels, element ids, the model's reasoning about them, and the
 * refusal text quoting them back. `18-hostile-page` in `scripts/panel-shot.mjs` proves
 * that holds today, by rendering a real attack and asserting nothing executed.
 *
 * This is the other half, and it is the half a runtime test cannot give you: the
 * STRUCTURAL properties that make the escaping sufficient in the first place. A runtime
 * test proves the code as written is safe. These prove the next edit cannot quietly make
 * it unsafe in a way the fixture happens not to cover.
 *
 *   node --experimental-strip-types extension/src/panel/markup-invariants.test.ts
 */
import { readFileSync } from 'node:fs';

const here = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const ts = here('./index.ts');
const threads = here('./threads.ts');
const html = here('./index.html');

let fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n        ${detail}`}`);
};

/**
 * 1. `esc()` covers every character that can break out of the contexts we use.
 *
 * Read off the source rather than imported, because importing `index.ts` runs the whole
 * panel — `createIcons`, event listeners, a health probe — and needs a `chrome` global
 * and a DOM. The definition is one line; asserting on it is not a compromise.
 */
const escDef = ts.slice(ts.indexOf('const esc ='), ts.indexOf('const esc =') + 200);
for (const ch of ['&', '<', '>', '"']) {
  check(`esc() escapes ${ch}`, escDef.includes(`'${ch}'`),
    `esc() no longer handles ${ch}; its definition is:\n        ${escDef.split('\n')[0]}`);
}

/**
 * 2. NO SINGLE-QUOTED HTML ATTRIBUTE CARRYING AN INTERPOLATION.
 *
 * This is the invariant that makes the above sufficient, and it is invisible: `esc()`
 * deliberately does NOT escape an apostrophe, so `<div class='${x}'>` is injectable
 * while `<div class="${x}">` is not. Every attribute in the panel is double-quoted
 * today — this is what stops the next one being written the other way.
 *
 * Matches `attr='` followed by an interpolation before the closing quote.
 */
const singleQuoted = [...`${ts}\n${threads}\n${html}`.matchAll(/[a-zA-Z-]+='[^'\n]*\$\{/g)]
  .map((m) => m[0]);
check('no single-quoted attribute contains an interpolation',
  singleQuoted.length === 0,
  `esc() does not escape an apostrophe, so these are injectable:\n        `
  + singleQuoted.join('\n        '));

/**
 * 3. No sink that EXECUTES what it is handed.
 *
 * ⚠ `insertAdjacentHTML` was in this list on the first run and the test failed — on
 * code that is correct. That was the rule being wrong, not the panel: it parses markup
 * exactly as `innerHTML` does, neither of them runs an inserted <script>, and the panel
 * uses `innerHTML` thirty-three times as its ordinary idiom. A rule that bans one and
 * blesses the other is not a security property, it is a preference, and a test full of
 * preferences is one people learn to edit rather than obey.
 *
 * What actually differs is whether the sink can execute a STRING. These can.
 */
for (const sink of ['document.write', 'eval(', 'new Function(', '.srcdoc', 'javascript:']) {
  check(`the panel never uses ${sink}`, !ts.includes(sink) && !threads.includes(sink),
    `${sink} can execute a string, which no amount of escaping elsewhere protects`);
}

/**
 * 4. Inline event handlers are never authored.
 *
 * `18-hostile-page` asserts that NO element in the rendered panel carries an `on*`
 * attribute, which is only a usable signal while the panel authors none of its own. If
 * someone adds `onclick="..."` legitimately, that assertion stops being able to tell a
 * real injection from our own markup — so the two checks hold each other up.
 */
const inlineHandler = /\son[a-z]+\s*=\s*["']/i;
check('no inline on* handler is authored anywhere',
  !inlineHandler.test(html.slice(html.indexOf('</style>'))) && !inlineHandler.test(ts),
  'the hostile-page assertion relies on every on* attribute being an attack');

process.exit(fail ? 1 : 0);
