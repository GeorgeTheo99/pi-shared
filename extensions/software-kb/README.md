# Software KB

Lexical search over a software-engineering reference catalog, plus page-level reads
from an optional private corpus of book PDFs.

## Tools

- `kb_search` — searches source cards/catalog entries and any indexed book pages.
  `mode` is `auto`, `keyword`, or `exact`; `limit` defaults to 5 (max 20);
  `content_only` excludes catalog/editorial cards; `source_id` filters one source.
- `kb_read` — reads one indexed page by `source_id` and physical PDF `page`
  (`max_chars` default 6000, max 12000). Page numbers are physical PDF pages, not
  printed page labels.
- `kb_sources` — lists sources, access policies, and actual local indexing status,
  optionally filtered by `access` or `tag`.

Commands `/kb-search` and `/kb-sources` ask the agent to run the matching tools.

## Storage

The tools read exactly one complete layout, chosen in this order:

1. `PI_SOFTWARE_KB_ROOT` (must be an absolute path)
2. `~/.pi/knowledge/software-engineering`, if it exists
3. the catalog shipped in this package (`knowledge/software-engineering`)

Only the catalog and editorial cards ship with pi-shared. Book PDFs, extracted text
and the page index stay machine-local. Build or refresh a private index with
`ingest.py` (Python + Poppler; optional macOS OCR via `ocr.swift`); see
[KB storage and ingestion](../../knowledge/software-engineering/README.md).

## Limits

Search is lexical, not semantic. Indexed page counts never prove that a book is
complete or a particular edition.
