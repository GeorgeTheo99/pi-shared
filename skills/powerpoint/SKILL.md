---
name: powerpoint
description: >-
  Use this skill whenever a .pptx or .potx file is involved as input or output: creating PowerPoint decks or presentations; reading, parsing, or extracting text; editing/updating existing PowerPoint files; combining/splitting decks; working with PowerPoint templates, layouts, speaker notes, or comments; or writing PptxGenJS deck-generation code. Do not use it for Google Slides URLs or Google Slides API/CLI operations.
---

This skill guides high-quality PowerPoint generation, inspection, editing, and repair.

## Required reference

Before writing or revising PptxGenJS deck-generation code, read:

- `reference/pptxgenjs.md`

Use it as the source of truth for PptxGenJS layout dimensions, text formatting, bullets, shapes, images, icons, native charts, speaker notes, recompression, and common corruption/visual pitfalls.

## Bundled helpers

Use the vendored helpers when their extra machinery improves a deck; do not copy or invoke every helper by default:

- `helpers/layout.js`: dependency-free geometry helpers for overlap and out-of-bounds diagnostics, element comparison, alignment, and distribution.
- `helpers/text.js`: `autoFontSize`, `calcTextBox`, and `calcTextBoxHeightSimple` for measured text fitting. Copy it into the deck workspace, install `skia-canvas`, `linebreak`, and `fontkit` there (`npm install skia-canvas linebreak fontkit`), and ensure Fontconfig's `fc-match` is on `PATH`. Do not import it until those dependencies are available because they load eagerly.
- `scripts/detect_font.py`: reports fonts missing from the system or substituted by LibreOffice. It uses Python's standard library plus the installed `soffice`/LibreOffice and Fontconfig's `fc-list` commands.

Import the dependency-free CommonJS layout helper directly from this skill directory or copy it into the task workspace. Copy the text helper into the workspace with its dependencies as described above. For generated or substantially edited PptxGenJS slides, run `warnIfSlideHasOverlaps(slide, pptx)` and `warnIfSlideElementsOutOfBounds(slide, pptx)` after adding slide elements. Fix unintended warnings; document intentional overlaps near the relevant code. Text measurements remain estimates, so always confirm them with `pptx_preview`.

The upstream origin and Apache-2.0 license for vendored files are recorded under `third_party/openai-slides/`.

## Workflow

1. Clarify the deck goal, audience, constraints, brand/template requirements, and desired visual tone when those materially affect the result.
2. For existing `.pptx`/`.potx` files, inspect both content and visuals before editing. Preserve template structure, masters, notes, comments, and user content unless explicitly asked to remove them.
3. Prefer real editable PowerPoint objects: native text, shapes, connectors, tables, charts, and speaker notes.
4. Avoid image-rendered charts unless the requested visualization has no native PowerPoint representation.
5. Generate or substantially edit the `.pptx`; run the geometry helpers for those PptxGenJS slides, and run `scripts/detect_font.py` when custom or QA-unreliable fonts are present.
6. Use `pptx_preview` to inspect the rendered slides visually. This is mandatory even if helper checks pass.
7. Fix user-visible layout, clipping, spacing, contrast, placeholder, file-size, font-substitution, or corruption issues and preview again when needed.

## Design guidance

- Build presentation-ready slides, not walls of text. Every slide should have a visual element: chart, image, icon, diagram, shape system, process flow, or stat callout.
- Pick a content-informed palette. One color should dominate; use 1-2 supporting tones and one sharp accent. Do not default to generic blue or warm cream/beige backgrounds unless the content/brand calls for them.
- Commit to one motif across the deck, but do **not** use color bars, accent stripes, title underlines, or single-side card borders as the motif.
- Vary layouts: two-column, half-bleed image, 2x2/2x3 grids, comparison columns, timelines, process flows, and large stat callouts.
- Use concise titles, strong hierarchy, generous spacing, consistent alignment, and left-aligned body text.
- Keep decks editable: text should remain text; simple charts should remain PowerPoint-native charts.

## Typography

Visual QA often renders through LibreOffice, so font metrics can differ from PowerPoint. Prefer safe fonts when fit matters:

- Safe: Arial, Calibri, Cambria, Times New Roman, Courier New, Bookman Old Style, Century Schoolbook.
- Good pairing: Cambria/Bookman/Century Schoolbook headers with Calibri/Arial body.
- Avoid defaulting to Aptos; it is unreliable in this QA environment and older Office installs.
- Treat Georgia, Trebuchet MS, Impact, Arial Black, Garamond, Consolas, Palatino Linotype, and Calibri Light as QA-unreliable unless the user specifically asks for them; add extra slack if used.

Suggested sizes: slide titles 36-44pt, section headers 20-24pt, body text 14-16pt, captions 10-12pt.

## QA checklist

- Check content order, missing content, typos, and leftover placeholders.
- Check text bounds first: no clipped, overflowing, or cramped text.
- Check overlaps, collisions, low contrast, uneven spacing, insufficient margins, misaligned columns/cards, and stale template decorations. Helper warnings are diagnostics, not a substitute for rendered-image review.
- For font diagnostics, run `python3 scripts/detect_font.py deck.pptx --json` from this skill directory. Treat missing or substituted fonts as defects unless the fallback is explicitly acceptable.
- Use fresh eyes for nontrivial decks: ask a reviewer/subagent to inspect rendered slide images when possible.
- Stop after one fix-and-verify cycle unless a new user-visible defect remains; do not chase sub-pixel perfection.
