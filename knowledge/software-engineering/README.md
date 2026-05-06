# Software Engineering Classics Knowledge Base

A curated local corpus/source catalog for pi to query via the `kb_search` and `kb_sources` tools from `extensions/software-kb`.

## Search protocol

- Runtime default: local lexical search over Markdown corpus + source metadata.
- Use `kb_search` for RAG-style retrieval: it returns cited snippets with source id, title, URL/path, access status, and license notes.
- Use `/kb-search <query>` to ask pi to run a cited KB search.
- Use `kb_sources` or `/kb-sources` to inspect the source catalog.
- Prefer exact local `rg`/grep for literal phrase hunting in future full-text files.
- Add vector embeddings later only if keyword search misses conceptual matches after the corpus is populated.

## Corpus layout

```text
knowledge/software-engineering/
  sources.json          # curated SearXNG-discovered source catalog
  corpus/*.md           # local searchable text/source cards
extensions/software-kb/ # pi tools: kb_search, kb_sources
```

## Current state

The checked-in corpus is intentionally conservative:

- It includes source cards, metadata, tags, access policies, and canonical URLs.
- It does **not** commit copyrighted book text.
- Public-web/open-license sources are marked as candidates for local full-text ingestion.
- Metadata-only books are searchable as pointers, not as full-text content.

## Future state

When lawful text is available, add extracted Markdown under `corpus/` with frontmatter:

```md
---
source_id: pragmatic-programmer
kind: user-supplied-private-index
---

# Chapter or section title

Text...
```

Future ingestion targets:

- Public/open or public-web candidates:
  - `sicp`
  - `software-engineering-at-google`
  - `sre-book`
  - `aosa`
  - `twelve-factor-app`
  - `worse-is-better`
  - `out-of-the-tar-pit` after redistribution/license verification
- Copyrighted metadata-only until user supplies a lawful private copy:
  - `mythical-man-month`
  - `pragmatic-programmer`
  - `code-complete`
  - `design-patterns-gof`
  - `refactoring`
  - `clean-code`
  - `working-effectively-with-legacy-code`
  - `domain-driven-design`
  - `poeaa`
  - `peopleware`
  - `continuous-delivery`
  - `release-it`
  - `ddia`
  - `accelerate`
  - `philosophy-of-software-design`
  - `tdd-by-example`

Do not ingest or redistribute pirated PDFs. For copyrighted books, keep only metadata unless the user provides a lawful copy for private indexing.

## Curation source

The initial list was defined from SearXNG discovery queries around influential and respected software engineering texts, then hand-curated into `sources.json` with access and license notes.
