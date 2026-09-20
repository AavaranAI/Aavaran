/**
 * NO CSS RULE FOR A THING THAT DOES NOT EXIST.
 *
 * The panel's stylesheet is 700 lines inside `index.html` and every redesign pass has
 * moved markup around underneath it. Nothing removes the rule when the element goes, so
 * the file accumulates selectors that can never match — and a dead selector is worse
 * than clutter here, because the next person reads it as evidence that the element it
 * names is still somewhere in the panel, and designs around a thing that is not there.
 *
 * Three were found the first time this ran:
 *   .mono      a font utility no element ever carried, plus a `#serverstatus .mono`
 *              rule for a model name that is rendered as plain text
 *   .pad       a horizontal-inset utility, unused
 *   .srow-val  added the same afternoon, for a settings row value, and never used
 *
 * ⚠ STATIC, ON PURPOSE. The obvious alternative is to look at the rendered DOM across
 * every state in `panel-shot.mjs`, and that is wrong in a way worth writing down: a
 * class like `.proof.bad` is perfectly reachable — it is the card shown when the audit
 * finds a LEAK — and no fixture renders it, so a live check would call it dead and be
 * confidently wrong about the most important state in the product. Searching the SOURCE
 * asks the question this test actually means: does anything ever produce this class?
 *
 *   node --experimental-strip-types extension/src/panel/dead-css.test.ts
 */
import { readFileSync } from 'node:fs';

const here = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

const html = here('./index.html');
const style = html.slice(html.indexOf('<style>') + 7, html.indexOf('</style>'));
const markup = html.slice(html.indexOf('</style>'));

/**
 * Everywhere a class name can come from: the static markup, the panel's own render
 * functions, and the thread bar, which builds its rows as strings too.
 */
const sources = [markup, here('./index.ts'), here('./threads.ts')].join('\n');

/**
 * Comments are stripped before selectors are read.
 *
 * This file documents its own rules in prose that mentions class names, and a comment
 * saying "`.note` used to be three sentences" would otherwise register as a live
 * selector and hide a genuinely dead one.
 */
const css = style.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * Class names as they appear in SELECTORS only.
 *
 * Anything after a `{` is a declaration block, where `.5em` and `url(...)` and font
 * stacks all contain dots and would otherwise be read as classes.
 */
const selectorText = css
  .split('}')
  .map((chunk) => chunk.split('{')[0] ?? '')
  .join('\n');

const declared = new Set(
  [...selectorText.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)].map((m) => m[1]!),
);

/**
 * Reachable, and deliberately not rendered by any fixture.
 *
 * Empty today. An entry here is a claim that a state exists which no screenshot covers,
 * so it should be short and each line should say why — the honest place for that
 * argument is here rather than in a silently-passing test.
 */
const ALLOW = new Set<string>([]);

let fail = 0;
const dead: string[] = [];
for (const name of [...declared].sort()) {
  if (ALLOW.has(name)) continue;
  // Word-boundary search: `class="a b"`, `classList.add('b')`, `<div class="${x} b">`.
  if (!new RegExp(`\\b${name.replace(/[-]/g, '\\-')}\\b`).test(sources)) {
    dead.push(name);
    fail++;
  }
}

if (dead.length) {
  console.log(`FAIL  ${dead.length} CSS selector(s) nothing can ever match`);
  for (const d of dead) console.log(`        .${d}`);
  console.log('      Delete the rule, or add it to ALLOW with the reason it is unrendered.');
} else {
  console.log(`ok    every one of ${declared.size} class selectors is produced somewhere`);
}

process.exit(fail ? 1 : 0);
