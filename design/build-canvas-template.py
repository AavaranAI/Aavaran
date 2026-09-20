#!/usr/bin/env python3
"""
The blank Canva canvas for the side panel redesign.

Deliberately empty. Jinshri and Vansh are changing the colour scheme, the mood
and everything else, so this file carries no palette, no type scale and no
opinion — only the one thing they cannot get wrong by eye, which is the size.

A page is the panel at 2x: 800 x 1800 px = the real 400 x 900 CSS px. Working at
2x means their numbers halve cleanly into CSS, so the build reads measurements
off the design instead of guessing them.

    python3 design/build-canvas-template.py
"""
from pathlib import Path

from pptx import Presentation
from pptx.util import Emu, Pt
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN
from pptx.enum.shapes import MSO_SHAPE
from pptx.oxml.ns import qn

OUT = Path(__file__).resolve().parent
PX = 9525                      # one px at 96dpi, in EMU
W, H = 800, 1800               # the panel at 2x
INSET = 36                     # the inset the panel uses today — a hint, not a rule
TOPBAR = 96

PAPER = RGBColor(0xFF, 0xFF, 0xFF)
GUIDE = RGBColor(0xD9, 0xD9, 0xD9)
LABEL = RGBColor(0xA6, 0xA6, 0xA6)
TEXT = RGBColor(0x1A, 0x1A, 0x1A)
MUTED = RGBColor(0x6E, 0x6E, 0x6E)
UI = "Helvetica Neue"
MONO = "Menlo"

# ⛔ THE SCREEN LIST IS NOT WRITTEN HERE ANY MORE. IT IS READ FROM THE CODE.
#
# This list said 13 screens while the panel had reached 18, so the designers were
# handed a canvas with five screens missing — including `14-needs-user-input`, a
# whole interaction they would have had no way to know existed. Nobody edited this
# file when a state was added, because nothing made them: two lists of the same
# thing, maintained by hand, drift the first time anyone is in a hurry.
#
# `scripts/panel-shot.mjs` is the one place that must know every state, because it
# renders them. So it is the source, and this is derived.
#
# Descriptions stay here — they are editorial, not structural — and a state with no
# description is a HARD ERROR rather than a blank cell. That is what makes adding a
# state impossible to do silently: the template build stops until someone says what
# the new screen is for.
#
# Kept to one short line each: the second column is 328 px wide at 19 px, which
# wraps at about 34 characters, and a wrap here ran into the row beneath it.
import re
import sys

BLURBS = {
    "0-launch-screen": "before the panel appears",
    "1-idle-server-ready": "the first screen anyone sees",
    "2-server-offline": "agent can't run; scan still can",
    "3-scan-result": "the screen that proves it",
    "4-run-complete": "result, then the full record",
    "5-settings-open": "server address and controls",
    "6-scan-ambiguous-field": "hidden, kind not named",
    "7-server-unreachable-repo": "how to start the server",
    "8-scan-only-package": "what the emailed zip shows",
    "9-model-not-installed": "offers a 6 GB download",
    "10-page-unreadable": "we refuse to call it clean",
    "11-model-downloading": "a progress bar",
    "12-scan-only-but-server-up": "scan-only, server answered",
    "13-server-version-stale": "server older than the extension",
    "14-needs-user-input": "it asks you for one value",
    "15-thread-resume": "you have been on this site before",
    "16-thread-new": "a fresh site, no history",
    "17-server-came-up": "it noticed the server start",
}

# States that exist to PROVE something, not to be designed. They still have to be named
# here, so that leaving one out is a decision somebody made rather than one nobody
# noticed — which is the whole failure this file was rewritten to stop.
TEST_ONLY = {
    # A hostile page aimed at the panel: every page-controlled string replaced with
    # markup that tries to execute. There is nothing here to design; the screenshot is
    # evidence that esc() held.
    "18-hostile-page",
}

_shot = (OUT.parent / "scripts" / "panel-shot.mjs").read_text()
_block = _shot[_shot.index("const STATES = ["):]
_names = re.findall(r"\{\s*name:\s*'([^']+)'", _block)
if not _names:
    sys.exit("could not read the state list out of scripts/panel-shot.mjs")

_names = [n for n in _names if n not in TEST_ONLY]
_missing = [n for n in _names if n not in BLURBS]
if _missing:
    sys.exit(
        "these panel states have no description in design/build-canvas-template.py:\n  "
        + "\n  ".join(_missing)
        + "\n\nAdd one line each. The designers get a page per screen, and a screen\n"
        "nobody described is a screen nobody designs."
    )

# Sorted by the numeric prefix so the canvas reads 0,1,2… rather than in the order
# the harness happens to render them (which is grouped by which stub it needs).
STATES = [(n, BLURBS[n]) for n in sorted(_names, key=lambda s: int(s.split("-")[0]))]

prs = Presentation()
prs.slide_width, prs.slide_height = Emu(W * PX), Emu(H * PX)
BLANK = prs.slide_layouts[6]


def page():
    s = prs.slides.add_slide(BLANK)
    r = s.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, Emu(W * PX), Emu(H * PX))
    r.fill.solid(); r.fill.fore_color.rgb = PAPER
    r.line.fill.background(); r.shadow.inherit = False
    return s


def text(s, x, y, w, h, runs, size=26, color=TEXT, bold=False, font=UI,
         align=PP_ALIGN.LEFT, spacing=1.45):
    tb = s.shapes.add_textbox(Emu(x * PX), Emu(y * PX), Emu(w * PX), Emu(h * PX))
    tf = tb.text_frame
    tf.word_wrap = True
    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    for i, para in enumerate(runs if isinstance(runs, list) else [runs]):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment, p.line_spacing = align, spacing
        for txt, o in (para if isinstance(para, list) else [(para, {})]):
            r = p.add_run(); r.text = txt
            f = r.font
            f.name = o.get("font", font)
            f.size = Pt(o.get("size", size) * 0.75)
            f.bold = o.get("bold", bold)
            f.color.rgb = o.get("color", color)
    return tb


def dashed(s, x, y, w, h):
    sh = s.shapes.add_shape(MSO_SHAPE.RECTANGLE, Emu(x * PX), Emu(y * PX),
                            Emu(w * PX), Emu(h * PX))
    sh.fill.solid(); sh.fill.fore_color.rgb = GUIDE
    sh.line.fill.background(); sh.shadow.inherit = False
    # a hairline reads as a rule; a dash pattern reads as a guide to be deleted
    ln = sh.line._get_or_add_ln()
    d = ln.makeelement(qn('a:prstDash'), {'val': 'dash'})
    ln.append(d)
    return sh


# ── page 1 — the only instructions there are ────────────────────────────────
s = page()
text(s, INSET, 120, W - 2 * INSET, 60, "Aavaran — side panel", size=46, bold=True)
text(s, INSET, 180, W - 2 * INSET, 60,
     "Blank canvas. Design whatever you like on it.", size=28, color=MUTED)

y = 300
for label, value, note in [
    ("Page size", "800 × 1800 px", "already set on every page here"),
    ("Why that size", "the panel at 2×", "it is really 400 × 900, so halve everything"),
    ("One rule", "use even numbers", "odd numbers land on half a pixel in the browser"),
]:
    text(s, INSET, y, 220, 40, label, size=24, color=MUTED)
    text(s, INSET + 230, y, W - INSET - 230 - INSET, 40, value, size=28, bold=True)
    text(s, INSET + 230, y + 38, W - INSET - 230 - INSET, 40, note, size=22, color=MUTED)
    y += 110

y += 10
text(s, INSET, y, W - 2 * INSET, 150,
     "The grey dashed lines are guides, not constraints. They show where the "
     "current design puts its margins. Move them, ignore them or delete them — "
     "colour, type, spacing and mood are all yours.", size=25, color=MUTED)
y += 172
text(s, INSET, y, W - 2 * INSET, 90,
     "One screen per page. If a screen is longer than the page, carry on to a new "
     "page and put -cont after the name.", size=25, color=MUTED)
y += 110

text(s, INSET, y, W - 2 * INSET, 40, f"The {len(STATES)} screens, each on its own page", size=28, bold=True)
y += 60

# ⚠ THE PITCH IS COMPUTED, NOT TYPED. At 44 px a row, thirteen screens fitted and
# eighteen did not: the list ran straight through the fixed footer at H-80 and
# pushed the "sending it back" paragraph clean off the page. The index page is
# generated from a list that grows, so its layout has to be a function of how long
# that list is — a constant that happened to fit once is a layout waiting to break.
FOOT_TOP = H - 80
TAIL = 40 + 120 + 24          # the closing paragraph, plus air above the footer
pitch = min(44, max(30, int((FOOT_TOP - TAIL - y) / max(len(STATES), 1))))
name_pt = 22 if pitch >= 40 else 20
what_pt = 19 if pitch >= 40 else 17

for name, what in STATES:
    text(s, INSET, y, 380, 34, name, size=name_pt, font=MONO, color=TEXT)
    text(s, INSET + 396, y + 2, W - INSET - 396 - INSET, 34, what, size=what_pt, color=MUTED)
    y += pitch

y += 40
text(s, INSET, y, W - 2 * INSET, 120,
     "Sending it back: PNG of each page at 1:1, no scaling, filename = page name. "
     "Keep the page names as they are — that is how each design gets matched to "
     "the screen it belongs to.", size=24, color=MUTED)

# The guard. A page that silently overflows is the failure this whole block exists
# to stop, and the only way to know is to check the number before writing the file.
if y + 120 > FOOT_TOP:
    sys.exit(
        f"the index page overflows: {len(STATES)} screens need {y + 120}px but the "
        f"footer sits at {FOOT_TOP}px.\nSplit the list over two pages — do not just "
        "shrink the type again."
    )

text(s, INSET, FOOT_TOP, W - 2 * INSET, 40,
     "If the import misbehaves, Canva → Custom size → 800 × 1800 px does the same job.",
     size=21, color=LABEL)

# ── one blank page per screen ───────────────────────────────────────────────
for name, what in STATES:
    s = page()
    dashed(s, INSET, 0, 1, H)
    dashed(s, W - INSET, 0, 1, H)
    dashed(s, 0, TOPBAR, W, 1)
    text(s, INSET + 10, 16, 400, 30, f"{INSET} px", size=18, font=MONO, color=LABEL)
    text(s, INSET + 10, TOPBAR + 10, 400, 30, f"top bar ends at {TOPBAR}",
         size=18, font=MONO, color=LABEL)
    text(s, INSET, H - 96, W - 2 * INSET, 34, name, size=22, font=MONO, color=LABEL)
    text(s, INSET, H - 62, W - 2 * INSET, 34, what, size=20, color=LABEL)
    text(s, W - INSET - 200, H - 96, 200, 34, "800 × 1800", size=18, font=MONO,
         color=LABEL, align=PP_ALIGN.RIGHT)

# ── two spares ──────────────────────────────────────────────────────────────
for i in (1, 2):
    s = page()
    dashed(s, INSET, 0, 1, H)
    dashed(s, W - INSET, 0, 1, H)
    text(s, INSET, H - 96, W - 2 * INSET, 34, f"spare-{i}", size=22, font=MONO, color=LABEL)

path = OUT / "Aavaran-Canva-Template.pptx"
prs.save(str(path))
print(f"wrote {path}  ({len(STATES) + 3} pages, {W}x{H} px)")
