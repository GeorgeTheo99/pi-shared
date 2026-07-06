---
name: powerpoint
description: Use this skill whenever a .pptx or .potx file is involved as input or output: creating slide decks, pitch decks, or presentations; reading, parsing, or extracting text; editing/updating existing presentations; combining/splitting decks; working with templates, layouts, speaker notes, or comments. Also use when the user mentions deck, slides, presentation, PowerPoint, PPTX/POTX, or deck-generation code.
---

This skill guides high-quality PowerPoint generation, inspection, editing, and repair.

## Required reference

Before writing or revising PptxGenJS deck-generation code, read:

- `reference/pptxgenjs.md`

Use it as the source of truth for PptxGenJS layout dimensions, text formatting, bullets, shapes, images, icons, native charts, speaker notes, recompression, and common corruption/visual pitfalls.

## Workflow

1. Clarify the deck goal, audience, constraints, brand/template requirements, and desired visual tone when those materially affect the result.
2. For existing `.pptx`/`.potx` files, inspect both content and visuals before editing. Preserve template structure, masters, notes, comments, and user content unless explicitly asked to remove them.
3. Prefer real editable PowerPoint objects: native text, shapes, connectors, tables, charts, and speaker notes.
4. Avoid image-rendered charts unless the requested visualization has no native PowerPoint representation.
5. Generate or edit the `.pptx`, then use `pptx_preview` to inspect rendered slides visually.
6. Fix user-visible layout, clipping, spacing, contrast, placeholder, file-size, or corruption issues and preview again when needed.

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
- Check overlaps, collisions, low contrast, uneven spacing, insufficient margins, misaligned columns/cards, and stale template decorations.
- Use fresh eyes for nontrivial decks: ask a reviewer/subagent to inspect rendered slide images when possible.
- Stop after one fix-and-verify cycle unless a new user-visible defect remains; do not chase sub-pixel perfection.
