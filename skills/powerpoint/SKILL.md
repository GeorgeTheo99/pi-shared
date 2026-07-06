---
name: powerpoint
description: Create, edit, debug, or polish PowerPoint decks (.pptx), especially with PptxGenJS. Use when the user asks for a slide deck, presentation, PowerPoint automation, deck-generation code, PPTX charts/diagrams, or help fixing PowerPoint output.
---

This skill guides high-quality PowerPoint generation and repair.

## Required reference

Before writing or revising PptxGenJS deck-generation code, read:

- `reference/pptxgenjs.md`

Use it as the source of truth for PptxGenJS layout dimensions, text formatting, bullets, shapes, images, icons, charts, speaker notes, and common corruption/visual pitfalls.

## Workflow

1. Clarify the deck goal, audience, constraints, and desired visual tone when those materially affect the result.
2. Prefer real editable PowerPoint objects: native text, shapes, connectors, tables, charts, and speaker notes.
3. Avoid image-rendered charts unless the requested visualization has no native PowerPoint representation.
4. Generate the `.pptx`, then use `pptx_preview` to inspect rendered slides visually.
5. Fix layout, clipping, spacing, contrast, file-size, or corruption issues and preview again when needed.

## Quality bar

- Build presentation-ready slides, not walls of text.
- Use concise titles, strong hierarchy, generous spacing, and consistent alignment.
- Avoid generic AI filler such as decorative edge accent bars, random gradients, and oversized emoji/icon clutter.
- Keep decks editable: text should remain text; simple charts should remain PowerPoint-native charts.
