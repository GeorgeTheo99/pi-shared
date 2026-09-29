# PPTX Preview

Renders PowerPoint `.pptx` files to PNG images so the agent can inspect slides with
the `read` tool.

## Tools

- `pptx_preview` — converts a `.pptx` (path absolute or relative to the session
  cwd) to PNGs. Optional `slideNumber` (1-indexed) renders one slide; optional
  `dpi` defaults to 150. Returns the image paths.
- `pptx_preview_cleanup` — deletes preview directories older than `olderThanHours`
  (default 24).

Failures (missing file, non-`.pptx` input, missing converters, conversion errors)
are thrown as tool errors.

## Requirements

- LibreOffice (`soffice`/`libreoffice`): `brew install --cask libreoffice`
- Poppler (`pdftoppm`): `brew install poppler`

## Storage and limits

Previews are written under `~/.pi/pptx-preview/`. Conversion goes `.pptx` → PDF
(LibreOffice) → PNG (Poppler), so rendering can differ from Microsoft PowerPoint.
For creating and editing decks, use the [powerpoint skill](../../skills/powerpoint/SKILL.md).
