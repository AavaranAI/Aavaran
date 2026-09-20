#!/usr/bin/env bash
#
# Gate on UNDEFINED IDENTIFIERS.
#
# esbuild strips TypeScript types without checking them, so nothing in this project
# ever compiled the code. That is how `orchestrator.ts` shipped a call to
# `ensureOffscreen()` it never imported: every turn needing a screenshot threw
# "ensureOffscreen is not defined", the panel reported "Screenshot withheld", and the
# agent — now blind — looped on "wait, form loading" until it hit the turn limit. On a
# live page, in front of him.
#
# ⭐ WIDENED AGAIN 20 Sep — TO EVERYTHING. The backlog is ZERO.
#
# This file's own rule for adding a code was: it must describe something that
# misbehaves at runtime, and it must currently have zero instances, because a gate
# that starts red is a gate somebody disables. All 13 backlog errors were fixed, so
# every code now satisfies that rule and the gate is simply `any error fails`.
#
# What the backlog was hiding, found by clearing it:
#   - `strictNullChecks` was OFF, and with it off `if (!asked.ok)` does NOT narrow a
#     discriminated union (proven on a six-line repro). Every ok/failure branch in the
#     codebase was unchecked, including the orchestrator's model-failure path, which
#     read `.reason` and `.detail` off a union tsc could not confirm had either.
#     Turning it on REMOVED six errors and added none of consequence.
#   - `as never as Record<string, never>` on the vision reply — a double cast through
#     `never`, the strongest way to tell the compiler to stop looking. The crop-labelling
#     loop could not be checked at all.
#   - Two `const results = []` arrays inferring `never[]`, which nothing can be pushed
#     into, compiling only because strictNullChecks was off and they fell back to any[].
#   - Untyped `chrome.runtime` message fields flowing into `fetch()` and into canvas
#     arithmetic, where anything non-numeric produced NaN -> a 0-width canvas -> a BLANK
#     screenshot, described by the vision stage without error.
#
# WIDENED 19 Sep to a SET of codes, all of which are "wrong at runtime" rather than
# "untidy". The new one earned its place the same day the gate proved too narrow:
#
#   TS1117  duplicate property in an object literal
#
# The panel sent `{ target: 'content', type: 'fill-user-value', target, value }`. The
# shorthand silently overwrote the routing field with an element id, the content script's
# `msg.target !== 'content'` guard dropped the message, and the button that hands the
# agent a value it asked for could never have worked. tsc knew. Nothing asked tsc.
#
# The rule for adding a code here: it must describe something that MISBEHAVES at runtime,
# and it must currently have zero instances in the backlog — a gate that starts red is a
# gate somebody disables. Checked before adding: the backlog is TS2339, TS2322, TS2591,
# TS2345, TS2488, TS2367 and TS2362, none of which are gated.
#
# This gates on that set, and deliberately no wider. The codebase has
# other type errors that are real but not defects — `unknown` not narrowed, a missing
# @types/node for one Node-only branch — and failing the suite on those today would
# mean either a large risky refactor or a disabled check. A narrow gate that always
# runs beats a broad one that gets switched off.
#
# ⚠ `--all` still prints the full tsc output; it should now be empty.
set -uo pipefail
cd "$(dirname "$0")/.."

OUT=$(npx tsc --noEmit 2>&1 || true)

if [ "${1:-}" = "--all" ]; then
  echo "$OUT"
  echo "---"
  echo "$(printf '%s\n' "$OUT" | grep -c 'error TS') type error(s) total (backlog, not gated)"
  exit 0
fi

BROKEN=$(printf '%s\n' "$OUT" | grep -E 'error TS' || true)
if [ -n "$BROKEN" ]; then
  echo "$BROKEN"
  echo
  echo "✘ the type backlog is zero and must stay zero."
  echo "   Every one of these compiled fine yesterday and still would — esbuild strips"
  echo "   types without checking them. tsc is the only thing that reads them."
  echo
  echo "   If an error is genuinely not worth fixing, say so IN THE CODE with a narrow"
  echo "   guard or an explicit type, not by widening this gate back out."
  exit 1
fi

echo "tsc clean — 0 type errors"
